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

    /** Rebuilds the tree; called whenever the panel produces new results. */
    public setResults(rows: ResultRow[], showContextLine: boolean): void {
        this.showContextLine = showContextLine;
        this.roots = this.build(rows);
        this.emitter.fire(undefined);
    }

    public setShowContextLine(value: boolean): void {
        if (this.showContextLine === value) return;
        this.showContextLine = value;
        this.emitter.fire(undefined);
    }

    public getChildren(node?: TreeNode): TreeNode[] {
        if (!node) return this.roots;
        if (node.kind === 'dir') return node.children;
        if (node.kind === 'file') return node.rows.map((row) => this.matchNode(row, node.path));
        return [];
    }

    public getTreeItem(node: TreeNode): vscode.TreeItem {
        if (node.kind === 'match') {
            const item = new vscode.TreeItem(`line ${node.row.line + 1}`, vscode.TreeItemCollapsibleState.None);
            item.id = node.id;
            item.contextValue = 'match';
            item.description = this.showContextLine ? String(node.row.text || '').trim() : undefined;
            item.tooltip = `${node.fileName}:${node.row.line + 1}\n${node.row.text || ''}`;
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
            item.resourceUri = vscode.Uri.file(node.file);
            return item;
        }

        const item = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.Expanded);
        item.id = node.id;
        item.contextValue = 'dir';
        item.description = String(node.count);
        item.tooltip = node.path;
        item.iconPath = new vscode.ThemeIcon('folder');
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
                children.push({
                    kind: 'dir',
                    id: 'dir:' + dirPath,
                    name,
                    path: dirPath,
                    count: kids.reduce((sum, kid) => sum + (kid.kind === 'dir' ? kid.count : kid.kind === 'file' ? kid.rows.length : 1), 0),
                    children: kids
                });
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
