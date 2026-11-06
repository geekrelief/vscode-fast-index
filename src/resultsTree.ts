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

    /** Throttles the refresh that makes a row resolvable again, so hovers cannot loop. */
    private lastHoverRefresh = 0;
    /** Relative path of the file whose rows are current highlighted, if any. */
    private activeFile?: string;
    /** Parent links, so a single row can be refreshed instead of the whole tree. */
    private readonly parentOf = new WeakMap<TreeNode, TreeNode>();

    /** Rebuilds the tree; called whenever the panel produces new results. */
    public setResults(rows: ResultRow[], showContextLine: boolean): void {
        this.showContextLine = showContextLine;
        this.roots = this.build(rows);
        this.emitter.fire(undefined);
    }

    /**
     * Marks the file a hovered/selected match belongs to. Its row and every
     * ancestor directory are highlighted, the way the Explorer marks the active
     * file, and the highlight moves when another file is hovered.
     */
    public setActiveMatch(row?: ResultRow): void {
        const file = row ? String(row.fileName || '') : undefined;
        if (file === this.activeFile) return;
        this.activeFile = file;
        this.emitter.fire(undefined);
    }

    private isActive(node: DirNode | FileNode): boolean {
        if (!this.activeFile) return false;
        if (node.kind === 'file') return node.path === this.activeFile;
        return this.activeFile.startsWith(node.path + '/');
    }

    /** Highlights make the label bold in the list's highlight colour. */
    private labelFor(node: DirNode | FileNode): string | vscode.TreeItemLabel {
        if (!this.isActive(node)) return node.name;
        return { label: node.name, highlights: [[0, node.name.length]] };
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
            const item = new vscode.TreeItem(this.labelFor(node), vscode.TreeItemCollapsibleState.Expanded);
            item.id = node.id;
            item.contextValue = 'file';
            item.description = String(node.rows.length);
            item.tooltip = node.path;
            item.resourceUri = vscode.Uri.file(node.file);
            return item;
        }

        const item = new vscode.TreeItem(this.labelFor(node), vscode.TreeItemCollapsibleState.Expanded);
        item.id = node.id;
        item.contextValue = 'dir';
        item.description = String(node.count);
        item.tooltip = node.path;
        item.iconPath = new vscode.ThemeIcon('folder');
        return item;
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
                children.push(dirNode);
            }
            for (const name of Array.from(builder.files.keys()).sort((a, b) => a.localeCompare(b))) {
                const filePath = prefix ? prefix + '/' + name : name;
                const fileRows = builder.files.get(name)!.slice().sort((a, b) => a.line - b.line);
                children.push({
                    kind: 'file',
                    id: 'file:' + filePath,
                    name,
                    path: filePath,
                    file: fileRows[0].file,
                    rows: fileRows
                });
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
