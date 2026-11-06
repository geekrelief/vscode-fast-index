import * as vscode from 'vscode';
import { ProjectIndexer } from './indexer';
import { SidebarProvider } from './SidebarProvider';
import { ResultsView } from './resultsView';
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

    // The results tab mirrors the sidebar: it re-renders on every new search.
    const resultsView = new ResultsView(
        () => sidebarProvider.getResultsSnapshot() as any,
        () => sidebarProvider.getViewMode()
    );
    context.subscriptions.push({ dispose: () => resultsView.dispose() }, ...resultsView.register());
    sidebarProvider.onResults = (_snapshot, reason) => {
        // Only a real search may pop the tab open; re-ordering the panel must not.
        const autoOpen = reason === 'search'
            && vscode.workspace.getConfiguration('fastIndex').get<boolean>('autoOpenResults') === true;
        void resultsView.sync(autoOpen);
    };
    // Resting on a result scrolls the results tab to that hit (no preview pane).
    sidebarProvider.onHover = (file: string, line: number) => resultsView.reveal(file, line);

    context.subscriptions.push(
        vscode.commands.registerCommand('vscode-fast-index.lockResults', () => sidebarProvider.setLock(true)),
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
        sidebarProvider.setStatus(`Ready · ${cache.fileCount.toLocaleString()} files`, 'ready');
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