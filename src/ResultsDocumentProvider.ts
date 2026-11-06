import * as vscode from 'vscode';

export interface ResultRow {
    file: string;
    fileName: string;
    line: number;
    text: string;
}

/**
 * Serves the search results as a virtual document so they can be opened in a
 * real editor tab (full theme, syntax highlighting, folding, find, etc.).
 */
export class ResultsDocumentProvider implements vscode.TextDocumentContentProvider {
    public static readonly scheme = 'fast-index-results';

    private readonly blocks = new Map<string, { text: string; rows: ResultRow[] }>();
    private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
    public readonly onDidChange = this.emitter.event;

    public static buildUri(key: string): vscode.Uri {
        return vscode.Uri.parse(`${ResultsDocumentProvider.scheme}:/results-${key}.txt`);
    }

    public set(uri: vscode.Uri, text: string, rows: ResultRow[]): void {
        this.blocks.set(uri.toString(), { text, rows });
        this.emitter.fire(uri);
    }

    public rows(uri: vscode.Uri): ResultRow[] {
        return this.blocks.get(uri.toString())?.rows ?? [];
    }

    public provideTextDocumentContent(uri: vscode.Uri): string {
        return this.blocks.get(uri.toString())?.text ?? '';
    }
}

/**
 * Links each " 12> code" match line back to the file and line it came from.
 */
export class ResultsLinkProvider implements vscode.DocumentLinkProvider {
    public constructor(private readonly rowsFor: (uri: vscode.Uri) => ResultRow[]) {}

    public provideDocumentLinks(document: vscode.TextDocument): vscode.DocumentLink[] {
        const rows = this.rowsFor(document.uri);
        const links: vscode.DocumentLink[] = [];
        let index = 0;

        for (let line = 0; line < document.lineCount && index < rows.length; line++) {
            const text = document.lineAt(line).text;
            if (!/^\s*\d+> /.test(text)) continue;

            const row = rows[index++];
            const target = vscode.Uri.parse(
                'command:vscode-fast-index.openAt?' + encodeURIComponent(JSON.stringify([row.file, row.line]))
            );
            links.push(new vscode.DocumentLink(new vscode.Range(line, 0, line, Math.max(0, text.length)), target));
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
