import * as vscode from 'vscode';
import { ProjectIndexer } from './indexer';
import { SidebarProvider } from './SidebarProvider';
import { ResultsView } from './resultsView';
import { ActivePathDecorationProvider, ResultRow, ResultsTreeProvider } from './resultsTree';
import { PinnedSearch, PinsTreeProvider } from './pinsTree';
import { setLogChannel, log } from './log';

/** Remembers that this workspace was indexed successfully, independent of the cache files. */
const INDEXED_FLAG = 'fastIndex.hasIndexed';
/** Folders whose cache the user deleted on purpose: never rebuild them unprompted. */
const SKIPPED_KEY = 'fastIndex.skippedRoots';

const normalize = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

export async function activate(context: vscode.ExtensionContext) {
    const indexer = new ProjectIndexer(context.storageUri, context.globalStorageUri);
    const folderPaths = (vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.fsPath);
    indexer.setRoots(folderPaths);

    const hasIndexedBefore = context.workspaceState.get<boolean>(INDEXED_FLAG, false);
    const skipped = new Set((context.globalState.get<string[]>(SKIPPED_KEY, [])).map(normalize));

    const runBuild = async (only?: string[], force = false): Promise<boolean> => {
        const saved = await indexer.buildIndex(only, force);
        if (saved) {
            await context.workspaceState.update(INDEXED_FLAG, true);
            if (skipped.size > 0) {
                skipped.clear();
                await context.globalState.update(SKIPPED_KEY, []);
            }
            // A full build is the only thing that clears every folder's staleness.
            if (!only) sidebarProvider.markIndexed();
        }
        return saved;
    };

    const rememberSkipped = async (roots: string[]): Promise<void> => {
        const merged = new Set((context.globalState.get<string[]>(SKIPPED_KEY, [])).map(normalize));
        for (const root of roots) {
            merged.add(normalize(root));
            skipped.add(normalize(root));
        }
        await context.globalState.update(SKIPPED_KEY, [...merged]);
    };

    const searchLog = vscode.window.createOutputChannel('Fast Index');
    setLogChannel(searchLog);
    context.subscriptions.push(searchLog);
    log('Fast Index activated');

    const sidebarProvider = new SidebarProvider(context.extensionUri, indexer, rememberSkipped, context.workspaceState);

    // Results are a real TreeView: VS Code owns expansion, keyboard navigation,
    // context menus and sticky scroll (workbench.tree.enableStickyScroll).
    const resultsTree = new ResultsTreeProvider();
    const resultsTreeView = vscode.window.createTreeView('fast-index.results', {
        treeDataProvider: resultsTree,
        showCollapseAll: true
    });

    // Pinned searches are their own collapsible section, so they cannot overlap the results.
    const pinsTree = new PinsTreeProvider();
    const pinsTreeView = vscode.window.createTreeView('fast-index.pins', {
        treeDataProvider: pinsTree
    });
    pinsTree.setPins(sidebarProvider.getPinned());
    sidebarProvider.onPins = (pins) => pinsTree.setPins(pins);
    context.subscriptions.push(
        pinsTreeView,
        { dispose: () => pinsTree.dispose() },
        vscode.commands.registerCommand('vscode-fast-index.applyPin', (pin: PinnedSearch) => {
            if (pin) sidebarProvider.applyPin(pin);
        }),
        vscode.commands.registerCommand('vscode-fast-index.removePin', async (pin: PinnedSearch) => {
            if (pin) await sidebarProvider.removePin(pin.id);
        })
    );

    // The results tab mirrors the sidebar: it re-renders on every new search.
    const resultsView = new ResultsView(
        () => sidebarProvider.getResultsSnapshot() as any,
        () => sidebarProvider.getViewMode()
    );
    context.subscriptions.push({ dispose: () => resultsView.dispose() }, ...resultsView.register());
    context.subscriptions.push(resultsTreeView, { dispose: () => resultsTree.dispose() });

    // Colors the hovered path through file decorations (the only tree API that
    // sets a row color), scoped to the fast-index: scheme used by the provider.
    const activePath = new ActivePathDecorationProvider();
    resultsTree.onActivePath = (uris) => activePath.setActive(uris);
    context.subscriptions.push(activePath, vscode.window.registerFileDecorationProvider(activePath));
    // Hover jump: VS Code resolves a match's tooltip only when the pointer rests on
    // the row, which is the one hover signal a TreeView offers. Its timing is
    // workbench.hover.delay; there is no per-widget override.
    resultsTree.onHoverMatch = (row) => {
        resultsView.reveal(row.file, row.line);
    };

    // Selecting a match in the tree scrolls the results tab to the same hit.
    context.subscriptions.push(resultsTreeView.onDidChangeSelection((event) => {
        const node = event.selection[0];
        if (node && node.kind === 'match') resultsView.reveal(node.row.file, node.row.line);
    }));
    sidebarProvider.onResults = (snapshot, reason) => {
        resultsTree.setResults((snapshot?.rows ?? []) as ResultRow[], sidebarProvider.showContextLineEnabled());
        // Only a real search may pop the tab open; re-ordering the panel must not.
        const autoOpen = reason === 'search'
            && vscode.workspace.getConfiguration('fastIndex').get<boolean>('autoOpenResults') === true;
        void resultsView.sync(autoOpen);
    };
    // Resting on a result scrolls the results tab to that hit (no preview pane).
    sidebarProvider.onHover = (file: string, line: number) => resultsView.reveal(file, line);

    // Replacement text for the tree's context menu is remembered between invocations.
    let lastReplacement = '';
    context.subscriptions.push(
        vscode.commands.registerCommand('vscode-fast-index.openMatch', async (node: any) => {
            const row = node?.row;
            if (!row) return;
            try {
                const document = await vscode.workspace.openTextDocument(vscode.Uri.file(row.file));
                const editor = await vscode.window.showTextDocument(document, { preview: true });
                const position = new vscode.Position(Math.max(0, Number(row.line) || 0), 0);
                editor.selection = new vscode.Selection(position, position);
                editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
            } catch {
                vscode.window.showInformationMessage('Fast Index: could not open ' + row.file);
            }
        }),
        vscode.commands.registerCommand('vscode-fast-index.replaceMatch', async (node: any) => {
            const row = node?.row;
            const snapshot = sidebarProvider.getResultsSnapshot();
            if (!row || !snapshot) return;

            const value = await vscode.window.showInputBox({
                title: 'Replace this match',
                prompt: `${vscode.workspace.asRelativePath(row.file)}:${row.line + 1}`,
                value: lastReplacement,
                placeHolder: 'Replacement text'
            });
            if (value === undefined) return;
            lastReplacement = value;
            await sidebarProvider.replaceMatchAt(row.file, row.line, value);
        }),
        vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration('fastIndex.showContextLine')) {
                resultsTree.setShowContextLine(sidebarProvider.showContextLineEnabled());
            }
            if (event.affectsConfiguration('fastIndex.hoverHighlightColor')) {
                activePath.refresh();
            }
        }),
        vscode.commands.registerCommand('vscode-fast-index.toggleReplace', () => sidebarProvider.toggleReplace()),
        vscode.commands.registerCommand('vscode-fast-index.lockResults', () => sidebarProvider.setLock(true)),
        // Editor title button: brings the view forward wherever its container lives —
        // the primary activity bar, or the secondary side bar after the user moved it.
        vscode.commands.registerCommand('vscode-fast-index.openPanel', async () => {
            const attempts = ['fast-index.sidebar.focus', 'workbench.view.extension.fast-index-explorer'];
            for (const command of attempts) {
                try {
                    await vscode.commands.executeCommand(command);
                    return;
                } catch {
                    /* try the next one: older hosts may not have every command */
                }
            }
            vscode.window.showInformationMessage(
                'Fast Index: open the view from the Activity Bar or the Secondary Side Bar.'
            );
        }),
        vscode.commands.registerCommand('vscode-fast-index.showLog', () => searchLog.show(true)),
        vscode.commands.registerCommand('vscode-fast-index.unlockResults', () => sidebarProvider.setLock(false)),
        vscode.commands.registerCommand('vscode-fast-index.toggleSettings', () => sidebarProvider.showSettings()),
        vscode.commands.registerCommand('vscode-fast-index.showMenu', async () => {
            const items: (vscode.QuickPickItem & { id: string })[] = [
                { id: 'pinned', label: '$(pin) Show or hide pinned searches' },
                { id: 'results', label: '$(book) Open the results editor' },
                { id: 'log', label: '$(output) Show the search log' }
            ];
            const picked = await vscode.window.showQuickPick(items, { title: 'Fast Index', placeHolder: 'Choose an action' });
            if (!picked) return;
            if (picked.id === 'pinned') sidebarProvider.togglePinnedSearches();
            if (picked.id === 'results') void vscode.commands.executeCommand('vscode-fast-index.openResultsInEditor');
            if (picked.id === 'log') searchLog.show(true);
        })
    );
    context.subscriptions.push({ dispose: () => sidebarProvider.dispose() });
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider("fast-index.sidebar", sidebarProvider, {
            webviewOptions: {
                retainContextWhenHidden: true
            }
        }),
        vscode.window.registerWebviewViewProvider('fast-index.settings', sidebarProvider, {
            webviewOptions: {
                retainContextWhenHidden: true
            }
        })
    );

    // Full rebuild: ignore stored mtimes and re-read every file.
    const indexCommand = vscode.commands.registerCommand('vscode-fast-index.buildIndex', () => runBuild(undefined, true));
    // Used by the settings panel to rebuild only the folders the user picked (mtime-skipping).
    const reindexCommand = vscode.commands.registerCommand('vscode-fast-index.reindexFolders', (roots?: string[]) => {
        if (!Array.isArray(roots) || roots.length === 0) return Promise.resolve(false);
        return runBuild(roots, false);
    });

    const watcher = vscode.workspace.createFileSystemWatcher('**/*');
    watcher.onDidCreate(uri => indexer.updateFile(uri.fsPath));
    watcher.onDidChange(uri => indexer.updateFile(uri.fsPath));
    watcher.onDidDelete(uri => indexer.deleteFile(uri.fsPath));

    context.subscriptions.push(indexCommand, reindexCommand, watcher, { dispose: () => indexer.dispose() });

    // The webview is registered above, so the panel renders immediately and reports progress
    // instead of staying blank while the index is read from disk.
    indexer.onProgress = (message, busy) => sidebarProvider.setStatus(message, busy ? 'busy' : 'ready');
    sidebarProvider.setStatus('Loading index…', 'busy');

    const cache = await indexer.loadFromDisk();
    const pendingRoots = [...cache.missingRoots, ...cache.corruptRoots]
        .filter(root => !skipped.has(normalize(root)));

    console.log(
        `Fast Index: storage ${indexer.cacheDirPath ?? '(none)'} | files ${cache.fileCount} | ` +
        `missing [${cache.missingRoots.join(', ')}] | corrupt [${cache.corruptRoots.join(', ')}] | ` +
        `pending [${pendingRoots.join(', ')}]`
    );

    if (pendingRoots.length === 0) {
        sidebarProvider.setStatus(
            `Ready · ${cache.fileCount.toLocaleString()} files · ${indexer.trigramCount.toLocaleString()} terms`,
            'ready'
        );
        if (!hasIndexedBefore && cache.status === 'loaded') {
            await context.workspaceState.update(INDEXED_FLAG, true);
        }
        return;
    }

    if (cache.status === 'missing') {
        sidebarProvider.setStatus('Not indexed yet', 'idle');
    }

    // Folders already indexed are reused from the shared cache; only the rest are built.
    if (hasIndexedBefore || cache.status === 'partial') {
        void runBuild(pendingRoots);
        return;
    }

    const names = pendingRoots.map(p => vscode.workspace.asRelativePath(p, false)).join(', ');
    const choice = await vscode.window.showInformationMessage(
        `Fast Index: this workspace has not been indexed yet (${names}). Build the index now?`,
        'Build Index', 'Later'
    );
    if (choice === 'Build Index') {
        await runBuild(pendingRoots);
    }
}

export function deactivate() {}