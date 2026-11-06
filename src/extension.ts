import * as vscode from 'vscode';
import { ProjectIndexer } from './indexer';
import { SidebarProvider } from './SidebarProvider';
import { PreviewProvider } from './PreviewProvider';
import { ResultsDocumentProvider, ResultsLinkProvider, orderRowsDepthFirst } from './ResultsDocumentProvider';
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

    // Search results can be opened as a real editor tab (full theme + highlighting).
    const resultsProvider = new ResultsDocumentProvider();
    context.subscriptions.push(
        vscode.workspace.registerTextDocumentContentProvider(ResultsDocumentProvider.scheme, resultsProvider),
        vscode.languages.registerDocumentLinkProvider(
            { scheme: ResultsDocumentProvider.scheme },
            new ResultsLinkProvider(uri => resultsProvider.rows(uri))
        ),
        vscode.commands.registerCommand('vscode-fast-index.openAt', async (file: string, line: number) => {
            try {
                const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
                const editor = await vscode.window.showTextDocument(document, { preview: true });
                const position = new vscode.Position(Math.max(0, Number(line) || 0), 0);
                editor.selection = new vscode.Selection(position, position);
                editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
            } catch {
                vscode.window.showInformationMessage('Fast Index: could not open ' + file);
            }
        }),
        vscode.commands.registerCommand('vscode-fast-index.openResultsInEditor', async () => {
            const snapshot = sidebarProvider.getResultsSnapshot();
            if (!snapshot || snapshot.rows.length === 0) {
                vscode.window.showInformationMessage('Fast Index: run a search first.');
                return;
            }

            const configured = vscode.workspace.getConfiguration('fastIndex').get<number>('previewContextLines');
            const radius = Math.max(0, Math.min(50, Math.round(typeof configured === 'number' ? configured : 2)));

            // Tree mode lists depth first; the flat list keeps the search order.
            const rows = sidebarProvider.getViewMode() === 'tree'
                ? orderRowsDepthFirst(snapshot.rows as any[])
                : (snapshot.rows as any[]).slice();

            const header = [
                'Search: ' + snapshot.query,
                [
                    snapshot.include.length ? 'only: ' + snapshot.include.join(', ') : '',
                    snapshot.exclude.length ? 'skip: ' + snapshot.exclude.join(', ') : '',
                    snapshot.filter ? 'filter: ' + snapshot.filter : ''
                ].filter(Boolean).join('  ·  '),
                rows.length + ' matches in ' + new Set(rows.map((row: any) => row.fileName)).size + ' files ('
                    + radius + ' context line' + (radius === 1 ? '' : 's') + ' each side)',
                'Generated view - Ctrl+click a match (marked >) to open it there.'
            ].filter(Boolean).join('\n');

            const cache = new Map<string, string[]>();
            const readLines = async (file: string): Promise<string[]> => {
                if (cache.has(file)) return cache.get(file)!;
                let lines: string[] = [];
                try {
                    const open = vscode.workspace.textDocuments.find(document => document.uri.fsPath === file);
                    const document = open ?? await vscode.workspace.openTextDocument(vscode.Uri.file(file));
                    lines = document.getText().split('\n');
                } catch {
                    lines = [];
                }
                cache.set(file, lines);
                return lines;
            };

            const out: string[] = [header, ''];
            let currentFile = '';

            for (const row of rows) {
                if (row.fileName !== currentFile) {
                    currentFile = row.fileName;
                    if (out.length > 2) out.push('');
                    out.push(currentFile);
                }

                out.push('');
                const lines = await readLines(row.file);
                if (lines.length === 0) {
                    out.push('  ' + String(row.line + 1).padStart(4) + '> ' + String(row.text ?? ''));
                    continue;
                }

                const start = Math.max(0, row.line - radius);
                const end = Math.min(lines.length, row.line + radius + 1);
                for (let index = start; index < end; index++) {
                    const marker = index === row.line ? '>' : ':';
                    out.push('  ' + String(index + 1).padStart(4) + marker + ' ' + lines[index]);
                }
            }

            const uri = ResultsDocumentProvider.buildUri(Date.now().toString(36));
            resultsProvider.set(uri, out.join('\n') + '\n', rows);

            const document = await vscode.workspace.openTextDocument(uri);
            const first = rows[0].fileName || '';
            const language = /\.py$/i.test(first) ? 'python'
                : /\.(cs)$/i.test(first) ? 'csharp'
                : /\.(c|cc|cpp|cxx|h|hh|hpp|hxx|inl)$/i.test(first) ? 'cpp'
                : 'plaintext';
            try {
                await vscode.languages.setTextDocumentLanguage(document, language);
            } catch {
                /* keep plaintext */
            }
            await vscode.window.showTextDocument(document, { preview: true });
        })
    );
    // The preview also lives in a bottom panel, next to the terminal.
    const previewProvider = new PreviewProvider(context.extensionUri);
    sidebarProvider.onPreview = (file: string, line: number, query: string, isRegex: boolean, isMatchCase: boolean) => {
        void previewProvider.show(file, line, query, isRegex, isMatchCase);
    };

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(PreviewProvider.viewType, previewProvider, {
            webviewOptions: { retainContextWhenHidden: true }
        }),
        vscode.commands.registerCommand('vscode-fast-index.lockResults', () => sidebarProvider.setLock(true)),
        vscode.commands.registerCommand('vscode-fast-index.showLog', () => searchLog.show(true)),
        vscode.commands.registerCommand('vscode-fast-index.unlockResults', () => sidebarProvider.setLock(false)),
        vscode.commands.registerCommand('vscode-fast-index.toggleSettings', () => sidebarProvider.showSettings()),
        vscode.commands.registerCommand('vscode-fast-index.showMenu', async () => {
            const inline = vscode.workspace.getConfiguration('fastIndex').get<boolean>('inlinePreview') === true;
            const items: (vscode.QuickPickItem & { id: string })[] = [
                { id: 'pinned', label: '$(pin) Show or hide pinned searches' },
                { id: 'preview', label: '$(preview) Open the preview panel' },
                { id: 'inline', label: inline ? '$(eye-closed) Turn off the inline preview' : '$(eye) Turn on the inline preview' },
                { id: 'log', label: '$(output) Show the search log' }
            ];
            const picked = await vscode.window.showQuickPick(items, { title: 'Fast Index', placeHolder: 'Choose an action' });
            if (!picked) return;
            if (picked.id === 'pinned') sidebarProvider.togglePinnedSearches();
            if (picked.id === 'preview') void vscode.commands.executeCommand('vscode-fast-index.openPreview');
            if (picked.id === 'log') searchLog.show(true);
            if (picked.id === 'inline') {
                await vscode.workspace.getConfiguration('fastIndex').update('inlinePreview', !inline, vscode.ConfigurationTarget.Global);
                sidebarProvider.sendConfig();
            }
        }),
        vscode.commands.registerCommand('vscode-fast-index.openPreview', async () => {
            // Focus the view, else reveal its container, else tell the user where it is.
            const attempts = ['fast-index-preview.focus', 'workbench.view.extension.fast-index-preview-container'];
            for (const command of attempts) {
                try {
                    await vscode.commands.executeCommand(command);
                    return;
                } catch {
                    /* try the next one */
                }
            }
            vscode.window.showInformationMessage(
                'Fast Index: open the Panel (Ctrl+J) and pick "Fast Index Preview" from the panel view menu.'
            );
        })
    );
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