import * as vscode from 'vscode';

/** A search hit, as the panel already builds it. */
export interface ResultRow {
    file: string;
    fileName: string;
    line: number;
    text: string;
}

/** A document line that maps back to a line of source. */
export interface SourceLine {
    file: string;
    /** 0-based line number inside `file`. */
    line: number;
    /** True for the line that actually matched the query. */
    match: boolean;
    /** Column in the document line where the source text starts. */
    offset: number;
    /** The source line with no trailing newline. */
    text: string;
}

/** Everything needed to render and decorate one results document. */
export interface ResultsDocument {
    text: string;
    rows: ResultRow[];
    /** One entry per document line; undefined for header and blank lines. */
    lines: (SourceLine | undefined)[];
    query: string;
    isRegex: boolean;
    isMatchCase: boolean;
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

/**
 * Owns the virtual document that backs the results tab. The URI is stable, so
 * the tab survives re-searches and the panel can update it in place.
 */
export class ResultsDocumentProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
    public static readonly scheme = 'fast-index-results';
    public static readonly uri: vscode.Uri = vscode.Uri.parse(
        `${ResultsDocumentProvider.scheme}:/Fast%20Index%20Results.txt`
    );

    private model?: ResultsDocument;
    private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
    public readonly onDidChange = this.emitter.event;

    public setResults(model: ResultsDocument): void {
        this.model = model;
        this.emitter.fire(ResultsDocumentProvider.uri);
    }

    public current(): ResultsDocument | undefined {
        return this.model;
    }

    public lineAt(uri: vscode.Uri, line: number): SourceLine | undefined {
        if (uri.toString() !== ResultsDocumentProvider.uri.toString()) return undefined;
        return this.model?.lines[line];
    }

    public provideTextDocumentContent(uri: vscode.Uri): string {
        return uri.toString() === ResultsDocumentProvider.uri.toString() ? this.model?.text ?? '' : '';
    }

    public dispose(): void {
        this.model = undefined;
        this.emitter.dispose();
    }
}

const splitPath = (file: string): string[] => String(file || '').split(/[\\/]/).filter(Boolean);

/**
 * Groups rows by file and orders the groups. Tree mode matches the sidebar's
 * depth-first order; flat mode keeps the order the results arrived in.
 */
function groupRows(rows: ResultRow[], tree: boolean, depthFirst: (rows: ResultRow[]) => ResultRow[]): ResultRow[] {
    if (tree) return depthFirst(rows);

    const groups = new Map<string, ResultRow[]>();
    for (const row of rows) {
        const key = row.fileName || row.file;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(row);
    }

    const ordered: ResultRow[] = [];
    for (const group of groups.values()) ordered.push(...group);
    return ordered;
}

/**
 * Renders the results as search-editor-like text: a header, then one section
 * per file with the matching lines and their context.
 */
export async function buildResultsDocument(
    snapshot: ResultsSnapshot,
    rows: ResultRow[],
    radius: number,
    tree: boolean,
    depthFirst: (rows: ResultRow[]) => ResultRow[],
    readSource: (file: string) => Promise<string[]>
): Promise<ResultsDocument> {
    const ordered = groupRows(rows, tree, depthFirst);
    const files = new Set(ordered.map(row => row.fileName));
    const lines: string[] = [];
    const map: (SourceLine | undefined)[] = [];
    const addLine = (text: string, info?: SourceLine): void => {
        lines.push(text);
        map.push(info);
    };

    const flags = [snapshot.isMatchCase ? 'match case' : '', snapshot.isRegex ? 'regex' : ''].filter(Boolean).join(', ');
    const scopes = [
        snapshot.include.length ? 'only ' + snapshot.include.join(', ') : '',
        snapshot.exclude.length ? 'skip ' + snapshot.exclude.join(', ') : '',
        snapshot.filter ? 'filter ' + snapshot.filter : ''
    ].filter(Boolean).join('   ·   ');

    addLine('Search: ' + snapshot.query + (flags ? '   [' + flags + ']' : ''));
    if (scopes) addLine(scopes);
    addLine(
        ordered.length === 0
            ? 'No matches'
            : ordered.length + ' match' + (ordered.length === 1 ? '' : 'es') + ' in ' + files.size + ' file' + (files.size === 1 ? '' : 's')
    );
    addLine('');

    // The widest line number decides the gutter, so every section lines up.
    let widest = 1;
    for (const row of ordered) widest = Math.max(widest, String(row.line + 1).length);
    const width = Math.max(4, Math.min(6, widest));

    let currentFile = '';
    for (const row of ordered) {
        if (row.fileName !== currentFile) {
            if (currentFile !== '') addLine('');
            currentFile = row.fileName;
            addLine(currentFile);
        }

        const source = await readSource(row.file);
        if (source.length === 0) {
            const text = String(row.text ?? '');
            const prefix = '  ' + String(row.line + 1).padStart(width, ' ') + '> ';
            addLine(prefix + text, { file: row.file, line: row.line, match: true, offset: prefix.length, text });
            continue;
        }

        const start = Math.max(0, row.line - radius);
        const end = Math.min(source.length, row.line + radius + 1);
        for (let index = start; index < end; index++) {
            const text = source[index];
            const isMatch = index === row.line;
            const prefix = '  ' + String(index + 1).padStart(width, ' ') + (isMatch ? '> ' : ': ');
            addLine(prefix + text, { file: row.file, line: index, match: isMatch, offset: prefix.length, text });
        }
    }

    return {
        text: lines.join('\n') + '\n',
        rows: ordered,
        lines: map,
        query: snapshot.query,
        isRegex: snapshot.isRegex,
        isMatchCase: snapshot.isMatchCase
    };
}

/**
 * "Follow link" links on every matching line: hovering explains the gesture and
 * following it opens a peek at the hit instead of replacing the results tab.
 */
export class ResultsLinkProvider implements vscode.DocumentLinkProvider {
    public static readonly peekCommand = 'vscode-fast-index.peekAt';

    public constructor(private readonly modelFor: (uri: vscode.Uri) => ResultsDocument | undefined) {}

    public provideDocumentLinks(document: vscode.TextDocument): vscode.DocumentLink[] {
        const model = this.modelFor(document.uri);
        if (!model) return [];

        const links: vscode.DocumentLink[] = [];
        const limit = Math.min(document.lineCount, model.lines.length);
        for (let index = 0; index < limit; index++) {
            const info = model.lines[index];
            if (!info || !info.match) continue;
            if (index >= document.lineCount) break;

            const target = vscode.Uri.parse(
                'command:' + ResultsLinkProvider.peekCommand + '?' +
                encodeURIComponent(JSON.stringify([info.file, info.line]))
            );
            const line = document.lineAt(index);
            const link = new vscode.DocumentLink(new vscode.Range(line.range.start, line.range.end), target);
            link.tooltip = 'Follow link (Ctrl+Click)';
            links.push(link);
        }

        return links;
    }
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
        const parts = splitPath(row.fileName || row.file);
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
