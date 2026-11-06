import * as vscode from 'vscode';
import * as path from 'path';

/** A search hit, as the panel already builds it. */
export interface ResultRow {
    file: string;
    fileName: string;
    line: number;
    text: string;
}

export interface ResultsSnapshot {
    query: string;
    isRegex: boolean;
    isMatchCase: boolean;
    filter: string;
    include: string[];
    exclude: string[];
    rows: ResultRow[];
}

/** File line: the workspace-relative (or absolute) path, alone on a line, ending in a colon. */
export const FILE_LINE = /^(\S.*):$/;
/** Result line: `  12: code` for a match, `  12  code` for context. */
export const RESULT_LINE = /^(\s+)(\d+)(: |  )(\s*)(.*)$/;

/**
 * Serves the search results as a virtual document in the format VS Code's own
 * `search-result` extension understands. Reusing that format — and its language
 * — is what gives the tab real syntax highlighting (each `file.ext:` block
 * embeds that language's grammar), Follow-link targets and peek-on-click,
 * without this extension shipping a lexer of its own.
 */
export class ResultsDocumentProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
    public static readonly scheme = 'fast-index-results';
    public static readonly uri: vscode.Uri = vscode.Uri.parse(
        `${ResultsDocumentProvider.scheme}:/Fast%20Index%20Results.code-search`
    );

    private text = '';
    private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
    public readonly onDidChange = this.emitter.event;

    public setText(text: string): void {
        this.text = text;
        this.emitter.fire(ResultsDocumentProvider.uri);
    }

    public provideTextDocumentContent(uri: vscode.Uri): string {
        return uri.toString() === ResultsDocumentProvider.uri.toString() ? this.text : '';
    }

    public dispose(): void {
        this.text = '';
        this.emitter.dispose();
    }
}

/** Native search editor serialisation: backslashes and newlines are escaped in the query. */
const escapeQuery = (value: string): string => value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');

/**
 * The label a result block starts with. Mirrors the label the search editor
 * writes: workspace-relative for files inside a folder (`Folder • path` in a
 * multi-root workspace), absolute for everything else. The `search-result`
 * extension resolves it back to a Uri with the same rules.
 */
export function labelForFile(file: string): string {
    const uri = vscode.Uri.file(file);
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    const single = (vscode.workspace.workspaceFolders ?? []).length <= 1;
    if (!folder) return file.split(path.sep).join('/');

    const relative = path.relative(folder.uri.fsPath, file).split(path.sep).join('/');
    return single ? relative : folder.name + ' \u2022 ' + relative;
}

const pad = (value: number, width: number): string => String(value).padStart(width, ' ');

/**
 * Renders the results the way the search editor does: a directive header, a
 * result count, then one block per file with `N: ` on matches and `N  ` on
 * context lines.
 */
export async function buildResultsText(
    snapshot: ResultsSnapshot,
    rows: ResultRow[],
    radius: number,
    readSource: (file: string) => Promise<string[]>
): Promise<string> {
    const files = new Set(rows.map(row => row.fileName));
    const flags = [
        snapshot.isMatchCase ? 'CaseSensitive' : '',
        snapshot.isRegex ? 'RegExp' : ''
    ].filter(Boolean).join(' ');
    const including = snapshot.include.join(', ');
    const excluding = snapshot.exclude.join(', ');

    const header: string[] = ['# Query: ' + escapeQuery(snapshot.query)];
    if (flags) header.push('# Flags: ' + flags);
    if (including) header.push('# Including: ' + including);
    if (excluding) header.push('# Excluding: ' + excluding);
    if (radius > 0) header.push('# ContextLines: ' + radius);
    header.push('');

    const summary = rows.length === 0
        ? 'No Results'
        : rows.length + ' result' + (rows.length === 1 ? '' : 's') + ' - ' + files.size + ' file' + (files.size === 1 ? '' : 's');

    const body: string[] = [];
    let currentFile = '';

    for (const row of rows) {
        if (row.fileName !== currentFile) {
            if (currentFile !== '') body.push('');
            currentFile = row.fileName;
            body.push(labelForFile(row.file) + ':');
        }

        const source = await readSource(row.file);
        if (source.length === 0) {
            // The file went away between the search and the render: keep the hit itself.
            body.push('  ' + pad(row.line + 1, 4) + ': ' + String(row.text ?? ''));
            continue;
        }

        const start = Math.max(0, row.line - radius);
        const end = Math.min(source.length, row.line + radius + 1);
        const width = Math.max(1, String(end).length);
        for (let index = start; index < end; index++) {
            const separator = index === row.line ? ': ' : '  ';
            body.push('  ' + pad(index + 1, width) + separator + source[index]);
        }
    }

    return [header.join('\n'), summary, '', body.join('\n')].join('\n');
}

interface TreeNode {
    dirs: Map<string, TreeNode>;
    files: Map<string, ResultRow[]>;
}

function emptyNode(): TreeNode {
    return { dirs: new Map(), files: new Map() };
}

/** Same ordering the sidebar tree uses: directories first, each level sorted, then files. */
export function orderRowsDepthFirst(rows: ResultRow[]): ResultRow[] {
    const root = emptyNode();

    for (const row of rows) {
        const parts = String(row.fileName || row.file).split(/[\\/]/).filter(Boolean);
        const fileName = parts.pop() ?? '';
        let node = root;
        for (const part of parts) {
            if (!node.dirs.has(part)) node.dirs.set(part, emptyNode());
            node = node.dirs.get(part)!;
        }
        if (!node.files.has(fileName)) node.files.set(fileName, []);
        node.files.get(fileName)!.push(row);
    }

    const ordered: ResultRow[] = [];
    const walk = (node: TreeNode): void => {
        for (const name of Array.from(node.dirs.keys()).sort((a, b) => a.localeCompare(b))) {
            walk(node.dirs.get(name)!);
        }
        for (const name of Array.from(node.files.keys()).sort((a, b) => a.localeCompare(b))) {
            const group = node.files.get(name)!.slice().sort((a, b) => a.line - b.line);
            ordered.push(...group);
        }
    };
    walk(root);

    return ordered;
}
