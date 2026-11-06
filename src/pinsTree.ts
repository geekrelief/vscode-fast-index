import * as vscode from 'vscode';

export interface PinnedSearch {
    id: string;
    query: string;
    isMatchCase: boolean;
    isRegex: boolean;
    include: string;
    exclude: string;
    filter: string;
    collapsed: string[];
}

const details = (pin: PinnedSearch): string => {
    const parts: string[] = [];
    if (pin.include) parts.push('only: ' + pin.include);
    if (pin.exclude) parts.push('skip: ' + pin.exclude);
    if (pin.filter) parts.push('filter: ' + pin.filter);
    if (pin.isMatchCase) parts.push('Aa');
    if (pin.isRegex) parts.push('.*');
    return parts.join(' · ');
};

/**
 * Pinned searches as their own collapsible view, instead of a box docked inside
 * the panel where it could overlap the results.
 */
export class PinsTreeProvider implements vscode.TreeDataProvider<PinnedSearch>, vscode.Disposable {
    private pins: PinnedSearch[] = [];
    private readonly emitter = new vscode.EventEmitter<void>();
    public readonly onDidChangeTreeData = this.emitter.event;

    public setPins(pins: PinnedSearch[]): void {
        this.pins = pins.slice();
        this.emitter.fire();
    }

    public getChildren(): PinnedSearch[] {
        return this.pins;
    }

    public getTreeItem(pin: PinnedSearch): vscode.TreeItem {
        const item = new vscode.TreeItem(pin.query, vscode.TreeItemCollapsibleState.None);
        item.id = pin.id;
        item.contextValue = 'pin';
        const subtitle = details(pin);
        item.description = subtitle;
        item.tooltip = subtitle ? `${pin.query}\n${subtitle}` : pin.query;
        item.iconPath = new vscode.ThemeIcon('pin');
        item.command = {
            command: 'vscode-fast-index.applyPin',
            title: 'Restore Pinned Search',
            arguments: [pin]
        };
        return item;
    }

    public dispose(): void {
        this.emitter.dispose();
    }
}
