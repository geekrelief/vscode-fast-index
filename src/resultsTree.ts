import * as vscode from 'vscode';
import * as path from 'path';

export interface ResultRow {
    file: string;
    fileName: string;
    line: number;
    text: string;
}

export interface DirNode {
    kind: 'dir';
    id: string;
    name: string;
    path: string;
    count: number;
    children: TreeNode[];
}

export interface FileNode {
    kind: 'file';
    id: string;
    name: string;
    path: string;
    file: string;
    rows: ResultRow[];
}

export interface MatchNode {
    kind: 'match';
    id: string;
    row: ResultRow;
    fileName: string;
}

export type TreeNode = DirNode | FileNode | MatchNode;

interface DirBuilder {
    dirs: Map<string, DirBuilder>;
    files: Map<string, ResultRow[]>;
}

const emptyBuilder = (): DirBuilder => ({ dirs: new Map(), files: new Map() });

/** Theme color ids offered for the hover highlight. */
export const HIGHLIGHT_COLORS = [
    'charts.yellow',
    'list.highlightForeground',
    'charts.blue',
    'charts.green',
    'charts.orange',
    'charts.purple',
    'charts.red',
    'editorInfo.foreground'
];

/** Used when the setting is missing or names an unknown color. */
export const DEFAULT_HIGHLIGHT_COLOR = 'charts.yellow';

/**
 * Renders the current results as a real tree view, so VS Code owns expansion,
 * keyboard navigation, context menus and sticky scroll (workbench.tree.enableStickyScroll),
 * instead of the panel imitating them.
 */
export class ResultsTreeProvider implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable {
    private roots: TreeNode[] = [];
    private showContextLine = true;
    private readonly emitter = new vscode.EventEmitter<TreeNode | undefined>();
    public readonly onDidChangeTreeData = this.emitter.event;

    /** Fired when VS Code resolves a match's tooltip, i.e. when the pointer rests on it. */
    public onHoverMatch?: (row: ResultRow) => void;

    /** Fired with the URIs of the hovered path so the extension can color them. */
    public onActivePath?: (uris: string[]) => void;

    /** Throttles the refresh that makes a row resolvable again, so hovers cannot loop. */
    private lastHoverRefresh = 0;
    /** URIs of the currently highlighted path, so only changes are repainted. */
    private activeUris: string[] = [];
    /** Parent links, so a single row can be refreshed instead of the whole tree. */
    private readonly parentOf = new WeakMap<TreeNode, TreeNode>();
    /** Path index, to find the nodes of the active path without walking the tree. */
    private readonly nodeByPath = new Map<string, DirNode | FileNode>();

    /** Rebuilds the tree; called whenever the panel produces new results. */
    public setResults(rows: ResultRow[], showContextLine: boolean): void {
        this.showContextLine = showContextLine;
        this.activeUris = [];
        this.nodeByPath.clear();
        this.onActivePath?.([]);
        this.roots = this.build(rows);
        this.emitter.fire(undefined);
    }

    /** The file row and its ancestors, for the highlighted path. */
    private pathNodes(file?: string): (DirNode | FileNode)[] {
        if (!file) return [];
        const nodes: (DirNode | FileNode)[] = [];
        const fileNode = this.nodeByPath.get(file);
        if (fileNode) nodes.push(fileNode);
        const parts = file.split('/');
        for (let i = parts.length - 1; i > 0; i--) {
            const dir = this.nodeByPath.get(parts.slice(0, i).join('/'));
            if (dir) nodes.push(dir);
        }
        return nodes;
    }

    /**
     * Marks the hovered match row, its file and its ancestor directories as the
     * active path. Only the URIs change: the decoration provider repaints exactly
     * those rows, so no tree refresh happens and the rows cannot flash their
     * undecorated color on the way.
     */
    private markActive(element: MatchNode): void {
        const uris = [
            this.matchUri(element),
            ...this.pathNodes(String(element.row.fileName || '')).map((node) => this.uriFor(node.path).toString())
        ];
        if (uris.join('|') === this.activeUris.join('|')) return;
        this.activeUris = uris;
        this.onActivePath?.(uris);
    }

    /** A per-match URI, so the hovered line is decorated like its file and folders. */
    private matchPath(node: MatchNode): string {
        return 'match/' + String(node.row.file).replace(/\\/g, '/') + ':' + node.row.line;
    }

    private matchUri(node: MatchNode): string {
        return this.uriFor(this.matchPath(node)).toString();
    }

    public setShowContextLine(value: boolean): void {
        if (this.showContextLine === value) return;
        this.showContextLine = value;
        this.emitter.fire(undefined);
    }

    public getChildren(node?: TreeNode): TreeNode[] {
        if (!node) return this.roots;
        if (node.kind === 'dir') return node.children;
        if (node.kind === 'file') {
            return node.rows.map((row) => {
                const match = this.matchNode(row, node.path);
                this.parentOf.set(match, node);
                return match;
            });
        }
        return [];
    }

    /** Needed for element-scoped refreshes (and reveal): VS Code walks up to the parent. */
    public getParent(node: TreeNode): TreeNode | undefined {
        return this.parentOf.get(node);
    }

    public getTreeItem(node: TreeNode): vscode.TreeItem {
        if (node.kind === 'match') {
            const item = new vscode.TreeItem(`line ${node.row.line + 1}`, vscode.TreeItemCollapsibleState.None);
            item.id = node.id;
            item.contextValue = 'match';
            // Decorated like its file and folders, so the hovered line is colored too.
            item.resourceUri = vscode.Uri.from({ scheme: 'fast-index', path: '/' + this.matchPath(node) });
            item.description = this.showContextLine ? String(node.row.text || '').trim() : undefined;
            // Deliberately no tooltip: VS Code only asks resolveTreeItem for it when the
            // pointer rests on the row, which is exactly the hover signal we need.
            item.iconPath = new vscode.ThemeIcon('circle-small-filled');
            item.command = {
                command: 'vscode-fast-index.openMatch',
                title: 'Open Match',
                arguments: [node]
            };
            return item;
        }

        if (node.kind === 'file') {
            const item = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.Expanded);
            item.id = node.id;
            item.contextValue = 'file';
            item.description = String(node.rows.length);
            item.tooltip = node.path;
            // A private scheme keeps the hover decoration out of the Explorer, which
            // would otherwise tint the same file everywhere it is shown.
            item.resourceUri = this.uriFor(node.path);
            item.iconPath = new vscode.ThemeIcon('file');
            return item;
        }

        // No folder icons: the tree is a result list, not a file browser.
        const item = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.Expanded);
        item.id = node.id;
        item.contextValue = 'dir';
        item.description = String(node.count);
        item.tooltip = node.path;
        item.resourceUri = this.uriFor(node.path);
        return item;
    }

    /** Scoped URI so file decorations apply to this view only. */
    private uriFor(path: string): vscode.Uri {
        return vscode.Uri.from({ scheme: 'fast-index', path: '/' + path });
    }

    /**
     * Called by VS Code when a row's tooltip is about to be shown, which happens
     * only when the pointer rests on it. This is the one hover signal a TreeView
     * offers, so it drives the results-editor jump.
     *
     * VS Code memoises the resolution per row, so the same row would only ever be
     * resolved once. A throttled refresh after the jump replaces the row, which
     * clears that cache and lets the next hover fire again. No tooltip is returned:
     * an empty popup over the results is pure noise.
     */
    public resolveTreeItem(item: vscode.TreeItem, element: TreeNode): vscode.ProviderResult<vscode.TreeItem> {
        if (element.kind !== 'match') return item;

        this.onHoverMatch?.(element.row);
        this.markActive(element);

        const now = Date.now();
        if (now - this.lastHoverRefresh > 1000) {
            this.lastHoverRefresh = now;
            // Refresh just this row (getParent supplies the link) so it can resolve again.
            setTimeout(() => this.emitter.fire(element), 300);
        }
        return item;
    }

    private build(rows: ResultRow[]): TreeNode[] {
        const root = emptyBuilder();
        for (const row of rows) {
            const parts = String(row.fileName || row.file).split(/[\\/]/).filter(Boolean);
            const name = parts.pop() ?? '';
            let node = root;
            for (const part of parts) {
                if (!node.dirs.has(part)) node.dirs.set(part, emptyBuilder());
                node = node.dirs.get(part)!;
            }
            if (!node.files.has(name)) node.files.set(name, []);
            node.files.get(name)!.push(row);
        }

        const toNodes = (builder: DirBuilder, prefix: string): TreeNode[] => {
            const children: TreeNode[] = [];
            for (const name of Array.from(builder.dirs.keys()).sort((a, b) => a.localeCompare(b))) {
                const dirPath = prefix ? prefix + '/' + name : name;
                const kids = toNodes(builder.dirs.get(name)!, dirPath);
                const dirNode: DirNode = {
                    kind: 'dir',
                    id: 'dir:' + dirPath,
                    name,
                    path: dirPath,
                    count: kids.reduce((sum, kid) => sum + (kid.kind === 'dir' ? kid.count : kid.kind === 'file' ? kid.rows.length : 1), 0),
                    children: kids
                };
                for (const kid of kids) this.parentOf.set(kid, dirNode);
                this.nodeByPath.set(dirPath, dirNode);
                children.push(dirNode);
            }
            for (const name of Array.from(builder.files.keys()).sort((a, b) => a.localeCompare(b))) {
                const filePath = prefix ? prefix + '/' + name : name;
                const fileRows = builder.files.get(name)!.slice().sort((a, b) => a.line - b.line);
                const fileNode: FileNode = {
                    kind: 'file',
                    id: 'file:' + filePath,
                    name,
                    path: filePath,
                    file: fileRows[0].file,
                    rows: fileRows
                };
                this.nodeByPath.set(filePath, fileNode);
                children.push(fileNode);
            }
            return children;
        };

        return toNodes(root, '');
    }

    private matchNode(row: ResultRow, fileName: string): MatchNode {
        return { kind: 'match', id: `match:${row.file}:${row.line}`, row, fileName };
    }

    public dispose(): void {
        this.emitter.dispose();
    }
}

/** Icon helper kept separate so the module stays testable without a VS Code host. */
export function baseName(file: string): string {
    return path.basename(file);
}

/**
 * Colors the rows of the hovered path. A file decoration is the only tree API
 * that gives a row a color (label highlights only embolden, which a bold theme
 * font hides), and decorations are keyed by URI - hence the private fast-index:
 * scheme, which keeps the tint out of the Explorer.
 */
export class ActivePathDecorationProvider implements vscode.FileDecorationProvider, vscode.Disposable {
    private active = new Set<string>();
    private readonly emitter = new vscode.EventEmitter<vscode.Uri[] | undefined>();
    public readonly onDidChangeFileDecorations = this.emitter.event;

    public setActive(uris: string[]): void {
        const next = new Set(uris);
        // Repaint only what changed: rows that keep their decoration never blink.
        const changed = [...this.active].filter((uri) => !next.has(uri))
            .concat(uris.filter((uri) => !this.active.has(uri)));
        this.active = next;
        if (changed.length) this.emitter.fire(changed.map((uri) => vscode.Uri.parse(uri)));
    }

    public provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
        if (!this.active.has(uri.toString())) return undefined;
        return { color: new vscode.ThemeColor(this.colorId()) };
    }

    /** Reflects fastIndex.hoverHighlightColor, falling back to the default. */
    private colorId(): string {
        const configured = vscode.workspace.getConfiguration('fastIndex').get<string>('hoverHighlightColor');
        return configured && HIGHLIGHT_COLORS.includes(configured) ? configured : DEFAULT_HIGHLIGHT_COLOR;
    }

    /** Re-reads the color (the setting changed). */
    public refresh(): void {
        this.emitter.fire(undefined);
    }

    public dispose(): void {
        this.emitter.dispose();
    }
}
