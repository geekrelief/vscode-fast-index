import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ProjectIndexer, isFileNameMatch, fileNameRank, SearchScope } from './indexer';
import { log } from './log';

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

const PINNED_KEY = 'fastIndex.pinnedSearches';
/** Workspace state: the index-affecting settings the last successful build used. */
const INDEXED_CONFIG_KEY = 'fastIndex.indexedConfig';

export class SidebarProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;
    private prefillTimer?: ReturnType<typeof setTimeout>;
    private suppressPrefillUntil = 0;
    /** Where the user last put the caret, so opening the panel can tell that from an open at 0,0. */
    private lastUserCursor?: { uri: string; line: number; character: number };
    private lockNoticed = false;
    /** Settings a build already consumed; the index is stale relative to the current ones when they differ. */
    private promptedIndexSignature = '';
    private _statusText = 'Starting…';
    private _statusState: 'busy' | 'ready' | 'idle' = 'busy';

    public setStatus(text: string, state: 'busy' | 'ready' | 'idle' = 'busy'): void {
        this._statusText = text;
        this._statusState = state;
        this._view?.webview.postMessage({ type: 'status', value: { text, state } });
    }

    private static escapeHtml(value: string): string {
        return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    private pinned: PinnedSearch[] = [];
    private locked = false;
    private readonly disposables: vscode.Disposable[] = [];
    private viewMode: 'tree' | 'flat' = 'tree';
    private searchGeneration = 0;
    private lastSnapshot: { query: string; isRegex: boolean; isMatchCase: boolean; filter: string; include: string[]; exclude: string[]; rows: any[] } | undefined;

    /** Panel font size in px; every `em` size in the webview scales from it. */
    private panelFontSize(): number {
        const configured = vscode.workspace.getConfiguration('fastIndex').get<number>('panelFontSize');
        return typeof configured === 'number' && Number.isFinite(configured)
            ? Math.max(9, Math.min(24, Math.round(configured)))
            : 14;
    }

    public sendConfig(): void {
        const config = vscode.workspace.getConfiguration('fastIndex');
        void this._view?.webview.postMessage({
            type: 'configData',
            value: {
                includeExtensions: config.get<string>('includeExtensions') || '',
                excludePatterns: config.get<string>('excludePatterns') || '',
                maxFileSizeKB: config.get<number>('maxFileSizeKB') || 512,
                maxResults: config.get<number>('maxResults') || 50,
                maxRecentSearches: config.get<number>('maxRecentSearches') ?? 20,
                panelFontSize: this.panelFontSize(),
                hoverJumpDelay: config.get<number>('hoverJumpDelay') ?? 1500,
                resultContextLines: config.get<number>('resultContextLines') ?? 2,
                followEditor: config.get<boolean>('followEditor') ?? true,
                persistPinnedSearches: config.get<boolean>('persistPinnedSearches') !== false,
                autoOpenResults: config.get<boolean>('autoOpenResults') === true,
                autoSearchFromResults: config.get<boolean>('autoSearchFromResults') === true,
                showContextLine: config.get<boolean>('showContextLine') !== false,
                pendingFields: this.pendingIndexFields()
            }
        });
    }

    /** The settings a build actually consumed, so "stale" can be measured rather than guessed. */
    private currentIndexConfig(): { includeExtensions: string; excludePatterns: string; maxFileSizeKB: number } {
        const config = vscode.workspace.getConfiguration('fastIndex');
        return {
            includeExtensions: config.get<string>('includeExtensions') ?? '',
            excludePatterns: config.get<string>('excludePatterns') ?? '',
            maxFileSizeKB: config.get<number>('maxFileSizeKB') ?? 512
        };
    }

    private indexedConfig(): { includeExtensions: string; excludePatterns: string; maxFileSizeKB: number } | undefined {
        return this.memento?.get<{ includeExtensions: string; excludePatterns: string; maxFileSizeKB: number }>(INDEXED_CONFIG_KEY);
    }

    /** Human names of the index-affecting settings that no build has picked up yet. */
    private pendingIndexFields(): string[] {
        const indexed = this.indexedConfig();
        if (!indexed) return [];
        const current = this.currentIndexConfig();
        const fields: string[] = [];
        if (indexed.includeExtensions !== current.includeExtensions) fields.push('Include Extensions');
        if (indexed.excludePatterns !== current.excludePatterns) fields.push('Exclude Patterns');
        if (indexed.maxFileSizeKB !== current.maxFileSizeKB) fields.push('Max File Size');
        return fields;
    }

    /** Called after a build succeeds: the current settings are now what the index reflects. */
    public markIndexed(): void {
        const snapshot = this.currentIndexConfig();
        void this.memento?.update(INDEXED_CONFIG_KEY, snapshot);
        // A fresh build may be asked about the next pending change, even a repeat of this one.
        this.promptedIndexSignature = '';
        this.sendConfig();
    }

    /** Restores the index-affecting settings the current index was built with. */
    private async undoIndexSettings(): Promise<void> {
        const indexed = this.indexedConfig();
        if (!indexed) return;
        const config = vscode.workspace.getConfiguration('fastIndex');
        const target = vscode.ConfigurationTarget.Workspace;
        try {
            await config.update('includeExtensions', indexed.includeExtensions, target);
            await config.update('excludePatterns', indexed.excludePatterns, target);
            await config.update('maxFileSizeKB', indexed.maxFileSizeKB, target);
        } catch (error: any) {
            vscode.window.showErrorMessage(`Fast Index: could not restore settings (${error?.message ?? error})`);
        }
        // Re-applying the same values after a reject must be able to ask again.
        this.promptedIndexSignature = '';
        this.sendConfig();
    }

    /**
     * Asks what to do about index settings that no build has picked up, once per
     * distinct set of values, so dismissing it does not nag on every panel hide.
     */
    private async promptPendingIndex(): Promise<void> {
        const fields = this.pendingIndexFields();
        if (fields.length === 0) return;

        const signature = JSON.stringify(this.currentIndexConfig());
        if (this.promptedIndexSignature === signature) return;
        this.promptedIndexSignature = signature;

        const choice = await vscode.window.showWarningMessage(
            `Fast Index: ${fields.join(', ')} changed since this index was built, so results may be stale.`,
            { modal: true },
            'Reindex now',
            'Reject changes',
            'Keep for now'
        );
        if (choice === 'Reindex now') {
            void vscode.commands.executeCommand('vscode-fast-index.buildIndex');
        } else if (choice === 'Reject changes') {
            await this.undoIndexSettings();
        }
    }

    public getViewMode(): 'tree' | 'flat' {
        return this.viewMode;
    }

    public getResultsSnapshot() {
        return this.lastSnapshot;
    }

    public setLock(value: boolean): void {
        this.locked = Boolean(value);
        this.lockNoticed = false;
        void this.memento?.update('fastIndex.locked', this.locked);
        void vscode.commands.executeCommand('setContext', 'fastIndex.locked', this.locked);
        void this._view?.webview.postMessage({ type: 'locked', value: this.locked });
    }

    public showSettings(): void {
        try { this._view?.show?.(true); } catch { /* older hosts */ }
        void this._view?.webview.postMessage({ type: 'showSettings' });
    }

    public togglePinnedSearches(): void {
        try { this._view?.show?.(true); } catch { /* older hosts */ }
        void this._view?.webview.postMessage({ type: 'togglePinned' });
    }

    /** Set by the extension so resting on a result can scroll the results tab. */
    public onHover?: (file: string, line: number) => void;

    /** Set by the extension so the results tab can re-render with the panel. */
    public onResults?: (snapshot: { query: string; isRegex: boolean; isMatchCase: boolean; filter: string; include: string[]; exclude: string[]; rows: any[] }, reason: 'search' | 'layout') => void;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly indexer: ProjectIndexer,
        private readonly onCachesDeleted?: (roots: string[]) => void,
        private readonly memento?: vscode.Memento
    ) {
        this.locked = memento?.get<boolean>('fastIndex.locked', false) === true;

        const saves = vscode.workspace.getConfiguration('fastIndex').get<boolean>('persistPinnedSearches') !== false;
        if (saves && memento) {
            const stored = memento.get<PinnedSearch[]>(PINNED_KEY, []);
            if (Array.isArray(stored)) {
                this.pinned = stored.filter(entry => entry && typeof entry.query === 'string').slice(0, 100);
            }
        }

        // Baseline for "is the index stale?": an install that predates this key is assumed
        // to match whatever its index was built with, rather than claiming staleness.
        if (memento && !memento.get<unknown>(INDEXED_CONFIG_KEY)) {
            void memento.update(INDEXED_CONFIG_KEY, this.currentIndexConfig());
        }

        // Registered for the provider's lifetime, not the webview's: the last deliberate
        // caret has to be known even when the panel has never been opened in this window.
        this.disposables.push(
            vscode.window.onDidChangeTextEditorSelection(event => this.onEditorSelection(event)),
            vscode.window.onDidChangeActiveTextEditor(editor => {
                // Switching editors is not a cursor move: only an explicit selection counts.
                if (editor && !editor.selection.isEmpty) this.schedulePrefill();
            })
        );
    }

    /** Tracks where the user last clicked, so opening the panel can tell that from a file open. */
    private onEditorSelection(event: vscode.TextEditorSelectionChangeEvent): void {
        if (event.textEditor !== vscode.window.activeTextEditor) return;
        // Opening a file parks the cursor at 0,0 and fires a "Command" selection
        // change; only real pointer/keyboard moves may seed the search box.
        if (event.kind === vscode.TextEditorSelectionChangeKind.Command) return;
        const active = event.selections[0]?.active;
        if (active) {
            this.lastUserCursor = {
                uri: event.textEditor.document.uri.toString(),
                line: active.line,
                character: active.character
            };
        }
        this.schedulePrefill();
    }

    /** Debounced follow: only runs while the panel is on screen. */
    private schedulePrefill(): void {
        if (this._view?.visible !== true) return;
        if (vscode.workspace.getConfiguration('fastIndex').get<boolean>('followEditor') === false) return;
        if (Date.now() < this.suppressPrefillUntil) return;
        if (this.prefillTimer) clearTimeout(this.prefillTimer);
        this.prefillTimer = setTimeout(() => this.prefillFromEditor(), 250);
    }

    public dispose(): void {
        if (this.prefillTimer) clearTimeout(this.prefillTimer);
        this.prefillTimer = undefined;
        this.disposables.forEach(disposable => disposable.dispose());
        this.disposables.length = 0;
    }

    private async persistPinned(): Promise<void> {
        const saves = vscode.workspace.getConfiguration('fastIndex').get<boolean>('persistPinnedSearches') !== false;
        if (!saves || !this.memento) return;
        await this.memento.update(PINNED_KEY, this.pinned);
    }

    public resolveWebviewView(webviewView: vscode.WebviewView) {
        this._view = webviewView;
        webviewView.webview.options = { enableScripts: true, localResourceRoots: [this._extensionUri] };
        webviewView.webview.html = this._getHtmlForWebview();

        // When the view is revealed, seed the search box from the editor and focus it.
        webviewView.onDidChangeVisibility(() => {
            if (!webviewView.visible) {
                // Leaving the panel with index settings a build has not picked up yet.
                void this.promptPendingIndex();
                return;
            }
            this.prefillOnOpen();
            this._view?.webview.postMessage({ type: 'focus' });
        });

        webviewView.onDidDispose(() => {
            if (this.prefillTimer) clearTimeout(this.prefillTimer);
            this.prefillTimer = undefined;
        });

        webviewView.webview.onDidReceiveMessage(async (data) => {
            switch (data.type) {
                case 'search': {
                    const { value, isMatchCase, isRegex, include, exclude, filter, reason } = data;
                    if (!value || (!isRegex && value.length < 3)) {
                        this._view?.webview.postMessage({ type: 'results', value: [] });
                        return;
                    }
                    const generation = ++this.searchGeneration;
                    const files = this.indexer.search(value, isRegex, { include, exclude });
                    const snippets = await this.getSnippets(files, value, isMatchCase, isRegex, filter, () => generation !== this.searchGeneration);
                    if (generation !== this.searchGeneration) {
                        log(`search "${value}" superseded by a newer search`);
                        return;
                    }
                    log(`search "${value}" reason=${reason || 'unknown'} case=${!!isMatchCase} regex=${!!isRegex} include=[${(include || []).join(',')}] exclude=[${(exclude || []).join(',')}] filter="${filter || ''}" -> ${files.length} files, ${snippets.length} rows`);
                    this.lastSnapshot = { query: value, isRegex: !!isRegex, isMatchCase: !!isMatchCase, filter: filter || '', include: include || [], exclude: exclude || [], rows: snippets };
                    this._view?.webview.postMessage({ type: 'results', value: snippets });
                    this.onResults?.(this.lastSnapshot, 'search');
                    break;
                }
                case 'replaceSingle': {
                    const { file, line, query, replaceText, isMatchCase, isRegex, include, exclude, filter } = data.value;
                    await this.replaceInFile(file, line, query, replaceText, isMatchCase, isRegex);
                    const files = this.indexer.search(query, isRegex, { include, exclude });
                    const snippets = await this.getSnippets(files, query, isMatchCase, isRegex, filter);
                    this._view?.webview.postMessage({ type: 'results', value: snippets });
                    this.lastSnapshot = { query, isRegex: !!isRegex, isMatchCase: !!isMatchCase, filter: filter || '', include: include || [], exclude: exclude || [], rows: snippets };
                    this.onResults?.(this.lastSnapshot, 'search');
                    break;
                }
                case 'replaceAll': {
                    const { results, query, replaceText, isMatchCase, isRegex, include, exclude, filter } = data.value;
                    await this.replaceAllInFiles(results, query, replaceText, isMatchCase, isRegex);
                    const files = this.indexer.search(query, isRegex, { include, exclude });
                    const snippets = await this.getSnippets(files, query, isMatchCase, isRegex, filter);
                    this._view?.webview.postMessage({ type: 'results', value: snippets });
                    this.lastSnapshot = { query, isRegex: !!isRegex, isMatchCase: !!isMatchCase, filter: filter || '', include: include || [], exclude: exclude || [], rows: snippets };
                    this.onResults?.(this.lastSnapshot, 'search');
                    break;
                }
                case 'ready': {
                    this.prefillOnOpen();
                    // Seed the webview with the stored settings: its hover delay and the
                    // settings form must not wait for the user to open the panel's settings.
                    this.sendConfig();
                    this._view?.webview.postMessage({ type: 'locked', value: this.locked });
                    this._view?.webview.postMessage({ type: 'focus' });
                    break;
                }
                case 'hover': {
                    // The pointer rested on a result: scroll the results tab to it.
                    this.onHover?.(String(data.file || ''), Number(data.line) || 0);
                    break;
                }
                case 'prefillIgnored': {
                    log(`prefill "${data.value}" ignored (${data.why})`);
                    break;
                }
                case 'pinRestore': {
                    // A restored pin is authoritative: ignore editor prefills for a moment.
                    this.suppressPrefillUntil = Date.now() + 2500;
                    log('pin restored: search box locked to the pinned query for 2.5s');
                    break;
                }
                case 'viewMode': {
                    this.viewMode = data.value === 'flat' ? 'flat' : 'tree';
                    // The results tab renders the same order the panel shows.
                    if (this.lastSnapshot) this.onResults?.(this.lastSnapshot, 'layout');
                    break;
                }
                case 'lock': {
                    this.locked = Boolean(data.value);
                    break;
                }
                case 'getPinned': {
                    this._view?.webview.postMessage({ type: 'pinnedList', value: this.pinned });
                    break;
                }
                case 'pinSearch': {
                    const input = data.value || {};
                    const query = String(input.query || '').trim();
                    if (!query) break;

                    const pin: PinnedSearch = {
                        id: Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7),
                        query,
                        isMatchCase: Boolean(input.isMatchCase),
                        isRegex: Boolean(input.isRegex),
                        include: String(input.include || ''),
                        exclude: String(input.exclude || ''),
                        filter: String(input.filter || ''),
                        collapsed: Array.isArray(input.collapsed) ? input.collapsed.slice(0, 500).map(String) : []
                    };

                    const signature = (entry: PinnedSearch) =>
                        JSON.stringify([entry.query, entry.isMatchCase, entry.isRegex, entry.include, entry.exclude, entry.filter]);
                    this.pinned = [pin, ...this.pinned.filter(entry => signature(entry) !== signature(pin))].slice(0, 100);
                    await this.persistPinned();
                    this._view?.webview.postMessage({ type: 'pinnedList', value: this.pinned });
                    // Pinning should surface the panel.
                    try { this._view?.show?.(true); } catch { /* host without show() */ }
                    vscode.window.showInformationMessage('Fast Index: pinned ' + query + '.');
                    break;
                }
                case 'deletePinned': {
                    const id = String(data.id || '');
                    this.pinned = this.pinned.filter(entry => entry.id !== id);
                    await this.persistPinned();
                    this._view?.webview.postMessage({ type: 'pinnedList', value: this.pinned });
                    break;
                }
                case 'getCaches': {
                    this._view?.webview.postMessage({ type: 'cacheList', value: await this.indexer.listCaches() });
                    break;
                }
                case 'deleteCaches': {
                    const requested: string[] = Array.isArray(data.files) ? data.files : [];
                    await this.confirmAndDeleteCaches(requested, false);
                    break;
                }
                case 'deleteStaleCaches': {
                    const entries = await this.indexer.listCaches();
                    await this.confirmAndDeleteCaches(entries.filter(entry => !entry.exists).map(entry => entry.file), true);
                    break;
                }
                case 'reindexCaches': {
                    const roots: string[] = Array.isArray(data.roots) ? data.roots : [];
                    if (roots.length === 0) break;

                    const detail = roots.map(root => `  • ${root}`).join('\n');
                    const confirm = await vscode.window.showWarningMessage(
                        `Reindex ${roots.length} folder${roots.length === 1 ? '' : 's'}?`,
                        {
                            modal: true,
                            detail: `${detail}\n\nOnly these folders are re-scanned; the other caches are left untouched.`
                        },
                        'Reindex'
                    );
                    if (confirm !== 'Reindex') {
                        this._view?.webview.postMessage({ type: 'cacheList', value: await this.indexer.listCaches() });
                        break;
                    }

                    await vscode.commands.executeCommand('vscode-fast-index.reindexFolders', roots);
                    this._view?.webview.postMessage({ type: 'cacheList', value: await this.indexer.listCaches() });
                    break;
                }
                case 'rebuildIndex': {
                    this.promptedIndexSignature = '';
                    vscode.commands.executeCommand('vscode-fast-index.buildIndex');
                    break;
                }
                case 'undoIndexSettings': {
                    await this.undoIndexSettings();
                    break;
                }
                case 'settingsClosed': {
                    void this.promptPendingIndex();
                    break;
                }
                case 'openFile': {
                    const { file, line } = data.value;
                    // Do not let the jump we cause re-seed the search box.
                    this.suppressPrefillUntil = Date.now() + 1500;
                    const document = await vscode.workspace.openTextDocument(file);
                    const editor = await vscode.window.showTextDocument(document);
                    const position = new vscode.Position(line, 0);
                    editor.selection = new vscode.Selection(position, position);
                    editor.revealRange(new vscode.Range(position, position));
                    break;
                }
                case 'getConfig': {
                    this.sendConfig();
                    break;
                }

                case 'saveConfig': {
                    const config = vscode.workspace.getConfiguration('fastIndex');
                    const target = vscode.ConfigurationTarget.Workspace;
                    const input = data.value || {};

                    const current = {
                        includeExtensions: config.get<string>('includeExtensions') ?? '',
                        excludePatterns: config.get<string>('excludePatterns') ?? '',
                        maxFileSizeKB: config.get<number>('maxFileSizeKB') ?? 512,
                        maxResults: config.get<number>('maxResults') ?? 50,
                        maxRecentSearches: config.get<number>('maxRecentSearches') ?? 20,
                        panelFontSize: this.panelFontSize(),
                        hoverJumpDelay: config.get<number>('hoverJumpDelay') ?? 1500,
                        resultContextLines: config.get<number>('resultContextLines') ?? 2,
                        followEditor: config.get<boolean>('followEditor') ?? true,
                        persistPinnedSearches: config.get<boolean>('persistPinnedSearches') !== false,
                        autoOpenResults: config.get<boolean>('autoOpenResults') === true,
                        autoSearchFromResults: config.get<boolean>('autoSearchFromResults') === true,
                        showContextLine: config.get<boolean>('showContextLine') !== false
                    };

                    const clampNumber = (value: unknown, fallback: number, min: number, max: number): number => {
                        if (value === '' || value === null || value === undefined) return fallback;
                        const parsed = Number(value);
                        if (!Number.isFinite(parsed)) return fallback;
                        return Math.max(min, Math.min(max, Math.round(parsed)));
                    };

                    const next = {
                        includeExtensions: typeof input.includeExtensions === 'string' ? input.includeExtensions : current.includeExtensions,
                        excludePatterns: typeof input.excludePatterns === 'string' ? input.excludePatterns : current.excludePatterns,
                        maxFileSizeKB: clampNumber(input.maxFileSizeKB, current.maxFileSizeKB, 1, 102400),
                        maxResults: clampNumber(input.maxResults, current.maxResults, 1, 100000),
                        maxRecentSearches: clampNumber(input.maxRecentSearches, current.maxRecentSearches, 0, 100),
                        panelFontSize: clampNumber(input.panelFontSize, current.panelFontSize, 9, 24),
                        hoverJumpDelay: clampNumber(input.hoverJumpDelay, current.hoverJumpDelay, 0, 10000),
                        resultContextLines: clampNumber(input.resultContextLines, current.resultContextLines, 0, 50),
                        followEditor: typeof input.followEditor === 'boolean' ? input.followEditor : current.followEditor,
                        persistPinnedSearches: typeof input.persistPinnedSearches === 'boolean' ? input.persistPinnedSearches : current.persistPinnedSearches,
                        autoOpenResults: typeof input.autoOpenResults === 'boolean' ? input.autoOpenResults : current.autoOpenResults,
                        autoSearchFromResults: typeof input.autoSearchFromResults === 'boolean' ? input.autoSearchFromResults : current.autoSearchFromResults,
                        showContextLine: typeof input.showContextLine === 'boolean' ? input.showContextLine : current.showContextLine
                    };

                    // Each key is written on its own so one failure cannot block the rest.
                    const failures: string[] = [];
                    for (const key of Object.keys(next) as (keyof typeof next)[]) {
                        if (next[key] === current[key]) continue;
                        try {
                            await config.update(key, next[key], target);
                        } catch (err: any) {
                            failures.push(`${key} (${err?.message ?? err})`);
                        }
                    }

                    if (failures.length > 0) {
                        vscode.window.showErrorMessage(`Fast Index: could not save ${failures.join(', ')}`);
                    }
                    // Settings are saved as the user edits; index-affecting keys only flag
                    // that the index is stale, they never rebuild behind the user's back.
                    // Reflect what is actually stored, and re-run the current search so a new
                    // result limit takes effect immediately.
                    this._view?.webview.postMessage({
                        type: 'configData',
                        value: { ...next, saved: true, pendingFields: this.pendingIndexFields() }
                    });
                    break;
                }
            }
        });
    }

    private async confirmAndDeleteCaches(requested: string[], staleOnly: boolean): Promise<void> {
        const entries = await this.indexer.listCaches();
        const chosen = entries.filter(entry => requested.includes(entry.file));
        if (chosen.length === 0) {
            this._view?.webview.postMessage({ type: 'cacheList', value: entries });
            return;
        }

        const totalBytes = chosen.reduce((sum, entry) => sum + entry.size, 0);
        const megabytes = (totalBytes / 1024 / 1024).toFixed(1);
        const detail = chosen
            .map(entry => `  • ${entry.root}  (${(entry.size / 1024 / 1024).toFixed(1)} MB)`)
            .join('\n');

        const title = staleOnly
            ? `Delete ${chosen.length} index cache${chosen.length === 1 ? '' : 's'} for folders that no longer exist (${megabytes} MB)?`
            : `Delete ${chosen.length} index cache${chosen.length === 1 ? '' : 's'} (${megabytes} MB)?`;
        const note = staleOnly
            ? 'These folders are gone or offline, so only their index files are removed. This cannot be undone.'
            : 'This cannot be undone. A deleted folder is only re-indexed when you run "Fast Index: Build Project Index".';

        const confirm = await vscode.window.showWarningMessage(
            title,
            { modal: true, detail: `${detail}\n\n${note}` },
            'Delete'
        );
        if (confirm !== 'Delete') {
            this._view?.webview.postMessage({ type: 'cacheList', value: entries });
            return;
        }

        const result = await this.indexer.deleteCaches(chosen.map(entry => entry.file));
        if (result.deleted.length > 0) {
            vscode.window.showInformationMessage(
                `Fast Index: deleted ${result.deleted.length} cache${result.deleted.length === 1 ? '' : 's'}, ${(result.bytes / 1024 / 1024).toFixed(1)} MB freed.`
            );
            // Only folders that still exist are remembered as "deleted on purpose".
            const liveRoots = result.roots.filter(root => {
                try {
                    return fs.statSync(root).isDirectory();
                } catch {
                    return false;
                }
            });
            this.onCachesDeleted?.(liveRoots);
        }
        this._view?.webview.postMessage({ type: 'cacheList', value: await this.indexer.listCaches() });
    }

    /** Seeds the search box with the editor selection, or the word under the cursor. */
    /**
     * On open/ready only an explicit selection seeds the box: a bare cursor would pull
     * whatever word it happens to sit on (often the last thing searched) into it.
     */
    private prefillOnOpen(): void {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            log('open: no editor, not prefilling');
            return;
        }
        // A selection is always deliberate; a bare caret only counts when the user put it
        // there (rather than a file opening and parking it at 0,0).
        if (editor.selection.isEmpty && !this.isDeliberateCursor(editor)) {
            log('open: cursor was not placed by the user, not prefilling');
            return;
        }
        this.prefillFromEditor(editor.selection.isEmpty ? 'open-cursor' : 'open-selection');
    }

    /** Explains, once per lock, why clicking around stops filling the box. */
    private noteLockedPrefill(): void {
        if (this.lockNoticed) return;
        this.lockNoticed = true;
        log('prefill paused: results are locked — click the lock button in the title bar to unlock');
    }

    /** True when the caret sits exactly where the user last put it, not where an open put it. */
    private isDeliberateCursor(editor: vscode.TextEditor): boolean {
        const mark = this.lastUserCursor;
        if (!mark) return false;
        const active = editor.selection.active;
        return mark.uri === editor.document.uri.toString()
            && mark.line === active.line
            && mark.character === active.character;
    }

    private prefillFromEditor(source: string = 'cursor'): void {
        if (this.locked) {
            this.noteLockedPrefill();
            return;
        }
        if (vscode.workspace.getConfiguration('fastIndex').get<boolean>('followEditor') === false) return;
        if (Date.now() < this.suppressPrefillUntil) return;

        const editor = vscode.window.activeTextEditor;
        if (!editor) return;
        // Never seed the query from our own generated views (output, settings, …). The
        // results editor counts too, unless the user opted into Auto Search from it.
        const scheme = editor.document.uri.scheme;
        if (scheme === 'output' || scheme === 'vscode-settings') return;
        if (scheme === 'fast-index-results'
            && vscode.workspace.getConfiguration('fastIndex').get<boolean>('autoSearchFromResults') !== true) return;
        if (editor.document.uri.fsPath === '') return;

        const document = editor.document;
        const selection = editor.selection;
        let text = '';

        if (!selection.isEmpty) {
            text = document.getText(selection);
        } else {
            // Only a cursor that is actually on a word seeds the search box; a cursor in
            // whitespace between words must not grab the neighbour.
            const range = document.getWordRangeAtPosition(selection.active);
            if (!range) {
                log('prefill skipped: cursor is not on a word');
                return;
            }
            text = document.getText(range);
        }

        // A search term is a single line; take the first non-empty one and cap it.
        const firstLine = text.split(/\r?\n/).map(line => line.trim()).find(line => line.length > 0) ?? '';
        if (!firstLine) return;
        const value = firstLine.length > 120 ? firstLine.slice(0, 120) : firstLine;

        log('prefill "' + value + '" (' + source + ')');
        this._view?.webview.postMessage({ type: 'prefill', value });
    }

    private async replaceInFile(file: string, line: number, query: string, replaceText: string, isMatchCase: boolean, isRegex: boolean) {
        const edit = new vscode.WorkspaceEdit();
        await this.applyReplacement(file, line, query, replaceText, edit, isMatchCase, isRegex);
        const applied = await vscode.workspace.applyEdit(edit);
        if (applied) await this.refreshIndexFor(file);
    }

    /** Applies a replacement and updates the index from the resulting buffer. */
    private async refreshIndexFor(file: string): Promise<void> {
        try {
            const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
            this.indexer.indexDocument(file, document.getText(), document.isDirty);
        } catch {
            /* document unavailable; the file watcher will catch up on save */
        }
    }

    private async replaceAllInFiles(results: any[], query: string, replaceText: string, isMatchCase: boolean, isRegex: boolean) {
        const edit = new vscode.WorkspaceEdit();
        const processed = new Set<string>();
        const touched = new Set<string>();
        for (const res of results) {
            const key = `${res.file}:${res.line}`;
            if (!processed.has(key)) {
                processed.add(key);
                touched.add(res.file);
                await this.applyReplacement(res.file, res.line, query, replaceText, edit, isMatchCase, isRegex);
            }
        }
        const applied = await vscode.workspace.applyEdit(edit);
        if (applied) {
            for (const file of touched) await this.refreshIndexFor(file);
        }
    }

    private async applyReplacement(file: string, line: number, query: string, replaceText: string, edit: vscode.WorkspaceEdit, isMatchCase: boolean, isRegex: boolean) {
        try {
            const uri = vscode.Uri.file(file);
            const document = await vscode.workspace.openTextDocument(uri);
            const content = document.getText();
            
            let flags = 'g';
            if (!isMatchCase) flags += 'i';
            
            let regex: RegExp;
            if (isRegex) {
                regex = new RegExp(query, flags);
            } else {
                const escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                regex = new RegExp(escapedQuery, flags);
            }
            
            let match;
            while ((match = regex.exec(content)) !== null) {
                if (match[0].length === 0) {
                    regex.lastIndex++;
                    continue;
                }
                const matchStartPos = document.positionAt(match.index);
                if (matchStartPos.line === line) {
                    const matchEndPos = document.positionAt(match.index + match[0].length);
                    const range = new vscode.Range(matchStartPos, matchEndPos);
                    
                    let finalReplaceText = replaceText;
                    if (isRegex) {
                        const singleRegex = new RegExp(regex.source, isMatchCase ? '' : 'i');
                        finalReplaceText = match[0].replace(singleRegex, replaceText);
                    }

                    edit.replace(uri, range, finalReplaceText);
                }
            }
        } catch (e) {
            console.error("Replacement error:", e);
        }
    }

    private async getSnippets(files: string[], query: string, isMatchCase: boolean, isRegex: boolean, filter?: string, isStale?: () => boolean) {
        const snippets: any[] = [];
        
        let flags = 'g';
        if (!isMatchCase) flags += 'i';
        
        let searchRegex: RegExp;
        try {
            if (isRegex) {
                searchRegex = new RegExp(query, flags);
            } else {
                const escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                searchRegex = new RegExp(escapedQuery, flags);
            }
        } catch (e) {
            return []; // Invalid regex pattern
        }
        
        const config = vscode.workspace.getConfiguration('fastIndex');
        const maxResults = config.get<number>('maxResults') || 50;

        // Keep one huge file from monopolising the list, and give every workspace
        // folder a fair share of the results (a project folder next to the engine
        // would otherwise never surface).
        const perFileSetting = config.get<number>('maxResultsPerFile');
        const perFileLimit = typeof perFileSetting === 'number' && perFileSetting > 0
            ? Math.floor(perFileSetting)
            : Number.MAX_SAFE_INTEGER;

        const filterText = typeof filter === 'string' ? filter.trim().toLowerCase() : '';
        const roots = this.indexer.rootPaths;
        const quota = roots.length > 1 ? Math.max(1, Math.ceil(maxResults / roots.length)) : maxResults;
        const perRoot = new Map<string, number>();
        const overflow: string[] = [];
        const concurrency = 20;

        const readMatches = async (file: string): Promise<any[]> => {
            const fileResults: any[] = [];
            const nameMatch = !isRegex && isFileNameMatch(file, query);
            const relativeName = vscode.workspace.asRelativePath(file);
            const relativeLower = relativeName.toLowerCase();
            let readOk = false;
            try {
                // Prefer the live buffer: a replaced (but unsaved) document must match.
                const openDocument = vscode.workspace.textDocuments.find(document => document.uri.fsPath === file);
                const content = openDocument ? openDocument.getText() : await fs.promises.readFile(file, 'utf-8');
                readOk = true;
                searchRegex.lastIndex = 0;
                let match;

                // Line starts once per file, then a binary search per match: the old
                // code re-scanned the file prefix for every hit (quadratic on big files).
                const lineStarts: number[] = [0];
                for (let at = content.indexOf('\n'); at >= 0; at = content.indexOf('\n', at + 1)) {
                    lineStarts.push(at + 1);
                }
                const lineOf = (index: number): number => {
                    let lo = 0;
                    let hi = lineStarts.length - 1;
                    while (lo < hi) {
                        const mid = (lo + hi + 1) >> 1;
                        if (lineStarts[mid] <= index) lo = mid;
                        else hi = mid - 1;
                    }
                    return lo;
                };
                const lineText = (line: number): string =>
                    content.slice(lineStarts[line], line + 1 < lineStarts.length ? lineStarts[line + 1] : content.length).trim();

                while (fileResults.length < perFileLimit && (match = searchRegex.exec(content)) !== null) {
                    if (match[0].length === 0) {
                        searchRegex.lastIndex++;
                        continue;
                    }
                    const line = lineOf(match.index);
                    const text = lineText(line);
                    // The filter is a boolean modifier of the search itself.
                    if (filterText && !(text.toLowerCase().indexOf(filterText) >= 0 || relativeLower.indexOf(filterText) >= 0)) continue;
                    fileResults.push({
                        file: file,
                        fileName: relativeName,
                        line: line,
                        text: text,
                        nameMatch
                    });
                }
            } catch (e) { }
            // A file named after the query is a hit even if no line mentions it.
            if (readOk && fileResults.length === 0 && !isRegex && fileNameRank(file, query) <= 2
                && (!filterText || relativeLower.indexOf(filterText) >= 0)) {
                fileResults.push({
                    file,
                    fileName: relativeName,
                    line: 0,
                    text: '',
                    nameMatch: true,
                    fileNameOnly: true
                });
            }
            return fileResults;
        };

        // First pass honours the per-root quota; the second fills the remainder from
        // files whose folder had already used up its share.
        for (let pass = 0; pass < 2 && snippets.length < maxResults; pass++) {
            const list = pass === 0 ? files : overflow;
            for (let i = 0; i < list.length && snippets.length < maxResults; i += concurrency) {
                if (isStale?.()) return [];   // a newer search took over: stop reading files
                const batch = list.slice(i, i + concurrency);
                const reads = await Promise.all(batch.map(readMatches));
                if (isStale?.()) return [];
                for (let k = 0; k < batch.length && snippets.length < maxResults; k++) {
                    const file = batch[k];
                    const rows = reads[k];
                    if (rows.length === 0) continue;

                    const root = this.indexer.rootPathFor(file) ?? '';
                    const used = perRoot.get(root) ?? 0;
                    if (pass === 0 && used >= quota) {
                        overflow.push(file);
                        continue;
                    }

                    const room = pass === 0 ? quota - used : maxResults - snippets.length;
                    const take = rows.slice(0, Math.max(0, Math.min(rows.length, room)));
                    if (take.length === 0) continue;
                    perRoot.set(root, used + take.length);
                    snippets.push(...take);
                }
            }
            if (overflow.length === 0) break;
        }

        return snippets.slice(0, maxResults);
    }

    private _getHtmlForWebview() {
        const config = vscode.workspace.getConfiguration('fastIndex');
        const debounceDelay = config.get<number>('debounceDelay') || 250;
        const maxRecentSearches = Math.max(0, Math.min(100, Math.floor(config.get<number>('maxRecentSearches') ?? 20)));

        return `
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <style>
                    html, body { height: 100%; }
                    body { font-family: var(--vscode-font-family); font-size: ${this.panelFontSize()}px; padding: 0; box-sizing: border-box; display: flex; flex-direction: column; overflow: hidden; }
                    .content { flex: 1 1 auto; display: flex; flex-direction: column; min-height: 0; padding: 8px 10px 10px 10px; box-sizing: border-box; }
                    #results { flex: 1 1 auto; overflow-y: auto; min-height: 40px; }
                    .status-row { display: flex; align-items: center; gap: 6px; font-size: 0.8em; margin-bottom: 8px; opacity: 0.9; }
                    .status-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--vscode-descriptionForeground); flex: 0 0 auto; }
                    .status-dot.busy { background: var(--vscode-charts-yellow, #cca700); animation: statusPulse 1.1s ease-in-out infinite; }
                    .status-dot.ready { background: var(--vscode-charts-green, #89d185); }
                    .status-dot.idle { background: var(--vscode-charts-orange, #d18616); }
                    @keyframes statusPulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
                    .search-panel { display: flex; flex-direction: column; gap: 5px; margin-bottom: 10px; }
                    .input-group { display: flex; align-items: center; background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); }
                    .input-group:focus-within { border-color: var(--vscode-focusBorder); }
                    .input-group input { flex-grow: 1; padding: 6px; background: transparent; color: var(--vscode-input-foreground); border: none; outline: none; box-sizing: border-box; }
                    
                    .setting-check label { display: flex; align-items: center; gap: 6px; font-weight: normal; cursor: pointer; }
                    .pinned-resizer { flex: 0 0 auto; height: 5px; margin-top: 2px; cursor: ns-resize; display: none; border-radius: 2px; }
                    .pinned-resizer:hover, .pinned-resizer.active { background: var(--vscode-sash-hoverBorder, var(--vscode-focusBorder)); }
                    .pinned-section { display: none; flex-direction: column; flex: 0 0 auto; height: 170px; min-height: 56px; max-height: 70vh; padding-top: 4px; border-top: 1px solid var(--vscode-widget-border); overflow: hidden; }
                    .pinned-list { flex: 1 1 auto; overflow-y: auto; min-height: 0; }
                    .pinned-head { font-size: 0.72em; text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.7; margin-bottom: 3px; }
                    .pinned-item { display: flex; align-items: flex-start; gap: 6px; padding: 2px 6px; font-size: 0.85em; cursor: pointer; border-radius: 3px; }
                    .pinned-item:hover { background: var(--vscode-list-hoverBackground); }
                    .pinned-body { flex: 1; min-width: 0; display: flex; flex-direction: column; }
                    .pinned-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
                    .pinned-meta { font-size: 0.9em; opacity: 0.6; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
                    .pinned-delete { display: none; position: static; cursor: pointer; opacity: 0.65; font-size: 0.85em; line-height: 1; }
                    .pinned-item:hover .pinned-delete { display: block; }
                    .pinned-delete:hover { opacity: 1; }
                    .clearable { position: relative; display: flex; align-items: center; flex: 1 1 auto; min-width: 0; }
                    .clearable input { width: 100%; padding-right: 24px; box-sizing: border-box; }
                    .clearable .clear-btn { display: none; position: absolute; right: 6px; cursor: pointer; opacity: 0.65; font-size: 0.85em; line-height: 1; user-select: none; }
                    .clearable:hover .clear-btn { display: block; }
                    .clearable input:placeholder-shown + .clear-btn { display: none; }
                    .clearable .clear-btn:hover { opacity: 1; }
                    .filter-group { width: 100%; }
                    .history-list { display: none; flex-direction: column; border: 1px solid var(--vscode-widget-border); border-radius: 3px; max-height: 190px; overflow-y: auto; background: var(--vscode-dropdown-background, var(--vscode-editorWidget-background)); }
                    .history-item { flex: 0 0 auto; padding: 3px 8px; font-size: 0.85em; line-height: 1.5; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
                    .history-item:hover, .history-item.active { background: var(--vscode-list-hoverBackground); }
                    .scope-group { display: flex; flex-direction: column; gap: 3px; }
                    .scope-input { width: 100%; padding: 3px 6px; font-size: 0.8em; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); box-sizing: border-box; }
                    .scope-input:focus { border-color: var(--vscode-focusBorder); outline: none; }
                    .scope-input::placeholder { opacity: 0.6; }
                    .toggle-btn { background: transparent; color: var(--vscode-icon-foreground); border: 1px solid transparent; padding: 2px 6px; margin-right: 2px; cursor: pointer; border-radius: 3px; font-size: 1.0em; display: flex; align-items: center; justify-content: center; user-select: none; font-weight: bold; }
                    .toggle-btn:hover { background: var(--vscode-toolbar-hoverBackground); }
                    .toggle-btn.active { background: var(--vscode-inputOption-activeBackground); color: var(--vscode-inputOption-activeForeground); border-color: var(--vscode-inputOption-activeBorder); }

                    .actions { display: flex; gap: 5px; margin-bottom: 10px; }
                    .actions button { flex: 1; }
                    button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 6px 10px; cursor: pointer; display: flex; align-items: center; justify-content: center; font-size: 0.9em; }
                    button:hover { background: var(--vscode-button-hoverBackground); }
                    button:disabled { opacity: 0.5; cursor: not-allowed; }
                    
                    .settings-panel { display: none; flex-direction: column; gap: 8px; margin-bottom: 15px; padding: 10px; background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-widget-border); border-radius: 4px; }
                    .settings-group { display: flex; flex-direction: column; gap: 8px; padding: 8px 10px 10px; border: 1px solid var(--vscode-widget-border); border-radius: 6px; }
                    .settings-group-title { margin: 0; font-size: 0.8em; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; opacity: 0.75; }
                    .settings-group-note { margin: 0; font-size: 0.78em; opacity: 0.65; }
                    .setting-item { display: flex; flex-direction: column; gap: 3px; }
                    .setting-item label { font-size: 0.85em; font-weight: bold; opacity: 0.9; }
                    .setting-item input { padding: 5px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); }
                    .setting-item input:focus { border-color: var(--vscode-focusBorder); }
                    
                    .cache-section { display: flex; flex-direction: column; gap: 6px; }
                    .cache-head { display: flex; align-items: center; justify-content: space-between; gap: 6px; font-size: 0.8em; }
                    .cache-head label { display: flex; align-items: center; gap: 4px; cursor: pointer; font-weight: bold; opacity: 0.9; }
                    .cache-summary { opacity: 0.75; font-variant-numeric: tabular-nums; }
                    .cache-list { display: flex; flex-direction: column; gap: 1px; max-height: 190px; overflow-y: auto; border: 1px solid var(--vscode-widget-border); border-radius: 3px; padding: 2px; }
                    .cache-row { display: flex; align-items: center; gap: 6px; padding: 3px 4px; font-size: 0.8em; cursor: pointer; }
                    .cache-row:hover { background: var(--vscode-list-hoverBackground); }
                    .cache-row input { margin: 0; }
                    .cache-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
                    .cache-meta { opacity: 0.7; white-space: nowrap; font-variant-numeric: tabular-nums; }
                    .cache-badge { font-size: 0.8em; padding: 0 4px; border-radius: 2px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
                    .cache-empty { opacity: 0.6; font-size: 0.85em; padding: 4px; }
                    .cache-actions { display: flex; gap: 5px; flex-wrap: wrap; }
                    .cache-actions button { flex: 1 1 30%; }
                    .cache-badge.missing { background: var(--vscode-inputValidation-warningBackground); color: var(--vscode-foreground); }
                    button.danger { background: var(--vscode-inputValidation-errorBackground); color: var(--vscode-foreground); }
                    button.danger:disabled { opacity: 0.5; }
                    .result-item { display: flex; flex-direction: column; padding: 6px; margin-bottom: 4px; cursor: pointer; border-left: 2px solid transparent; }
                    .result-item:hover { background: var(--vscode-list-hoverBackground); border-left: 2px solid var(--vscode-activityBarBadge-background); }
                    
                    .result-header { display: flex; justify-content: space-between; align-items: center; }
                    .file-name { font-weight: bold; font-size: 0.9em; color: var(--vscode-textLink-foreground); }
                    .name-badge { font-size: 0.75em; padding: 0 4px; margin: 0 6px auto 4px; border-radius: 2px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
                    .results-toolbar { display: flex; align-items: center; gap: 4px; margin-bottom: 6px; }
                    .tool-btn { padding: 2px 8px; font-size: 0.8em; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); flex: 0 0 auto; }
                    .tool-btn:hover { background: var(--vscode-button-secondaryHoverBackground); }
                    .lock-badge { font-size: 0.8em; padding: 1px 8px; border-radius: 8px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); white-space: nowrap; }
                    .setting-hint { font-size: 0.85em; opacity: 0.85; margin-top: 4px; }
                    .reindex-banner { display: flex; align-items: center; gap: 8px; margin-top: 6px; padding: 6px 8px; border-radius: 4px; background: var(--vscode-inputValidation-warningBackground, rgba(255, 204, 0, 0.15)); border: 1px solid var(--vscode-inputValidation-warningBorder, rgba(255, 204, 0, 0.5)); font-size: 0.85em; }
                    .reindex-text { flex: 1; }
                    .link-btn { background: transparent; border: none; padding: 0; cursor: pointer; color: var(--vscode-textLink-foreground); font-size: 1em; text-decoration: underline; }
                    .link-btn:hover { color: var(--vscode-textLink-activeForeground); }
                    .results-count { margin-left: auto; font-size: 0.8em; opacity: 0.7; }
                    .subsearch input { width: 100%; padding: 4px 6px; margin-bottom: 6px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); box-sizing: border-box; font-size: 0.85em; }
                    .subsearch input:focus { border-color: var(--vscode-focusBorder); outline: none; }
                    .tree-menu { position: fixed; z-index: 1000; min-width: 150px; padding: 3px 0; background: var(--vscode-menu-background, var(--vscode-editorWidget-background)); border: 1px solid var(--vscode-menu-border, var(--vscode-widget-border)); box-shadow: 0 2px 8px var(--vscode-widget-shadow, rgba(0,0,0,0.36)); border-radius: 4px; }
                    .tree-menu-item { padding: 4px 12px; font-size: 0.85em; cursor: pointer; white-space: nowrap; }
                    .tree-menu-item:hover { background: var(--vscode-menu-selectionBackground, var(--vscode-list-hoverBackground)); color: var(--vscode-menu-selectionForeground, inherit); }
                    .tree-dir, .tree-file { display: flex; align-items: center; gap: 4px; padding: 2px 4px; font-size: 0.85em; cursor: pointer; user-select: none; }
                    .tree-file .dir-name { font-weight: bold; color: var(--vscode-textLink-foreground); }
                    .tree-file .chevron { opacity: 0.55; }
                    .tree-dir:hover { background: var(--vscode-list-hoverBackground); }
                    .tree-dir .chevron { width: 10px; opacity: 0.7; flex: 0 0 auto; }
                    .tree-dir .dir-name { font-weight: bold; }
                    .tree-dir .dir-count { opacity: 0.6; font-size: 0.9em; margin-left: 2px; }
                    .filename-only { opacity: 0.75; font-style: italic; }
                    
                    .replace-btn { display: none; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); padding: 2px 8px; font-size: 0.8em; border-radius: 2px; }
                    .replace-btn:hover { background: var(--vscode-button-secondaryHoverBackground); }
                    .result-item:hover .replace-btn { display: block; }

                    .snippet { font-family: monospace; font-size: 0.85em; opacity: 0.8; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 2px; }
                    .highlight { background-color: var(--vscode-editor-findMatchHighlightBackground); color: var(--vscode-editor-foreground); border-radius: 2px; font-weight: bold; }
                </style>
            </head>
            <body>
                <div class="content">
                <div class="tree-menu" id="treeMenu" style="display: none;"></div>
                <div class="status-row" id="statusRow">
                    <span class="status-dot ${this._statusState}" id="statusDot"></span>
                    <span id="statusText">${SidebarProvider.escapeHtml(this._statusText)}</span>
                </div>

                <div class="search-panel" id="mainSearchPanel">
                    <div class="input-group">
                        <div class="clearable">
                            <input type="text" id="searchInput" placeholder="Search..." />
                            <span class="clear-btn" title="Clear">✕</span>
                        </div>
                        <div id="matchCaseBtn" class="toggle-btn" title="Match Case">Aa</div>
                        <div id="regexBtn" class="toggle-btn" title="Use Regular Expression">.*</div>
                        <div id="historyBtn" class="toggle-btn" title="Recent searches">▾</div>
                        <div id="pinBtn" class="toggle-btn" title="Pin this search">📌</div>
                    </div>
                    <div class="history-list" id="historyList"></div>
                    <div class="input-group filter-group">
                        <div class="clearable">
                            <input type="text" id="subSearchInput" placeholder="Filter these results…" />
                            <span class="clear-btn" title="Clear">✕</span>
                        </div>
                    </div>
                    <div class="input-group" id="replaceGroup" style="display: none;">
                        <div class="clearable">
                            <input type="text" id="replaceInput" placeholder="Replace with..." />
                            <span class="clear-btn" title="Clear">✕</span>
                        </div>
                    </div>
                    <div class="scope-group">
                        <div class="clearable">
                            <input type="text" id="scopeInclude" class="scope-input" title="Only search files matching these extensions, names or folders (partial matches; comma separated). Use .h for an exact extension." placeholder="Only in: cpp, h, Char, Source/Game" />
                            <span class="clear-btn" title="Clear">✕</span>
                        </div>
                        <div class="clearable">
                            <input type="text" id="scopeExclude" class="scope-input" title="Skip files matching these extensions, names or folders (partial matches; comma separated)." placeholder="Skip: Intermediate, Test, .ini" />
                            <span class="clear-btn" title="Clear">✕</span>
                        </div>
                    </div>
                </div>
                
                <div class="settings-panel" id="settingsPanel">
                    <section class="settings-group">
                        <h3 class="settings-group-title">Search Settings</h3>
                        <div class="setting-item">
                            <label>Panel Font Size (px)</label>
                            <input type="number" id="confPanelFont" min="9" max="24" step="1" />
                        </div>
                        <div class="setting-item">
                            <label>Max Search Results</label>
                            <input type="number" id="confMaxResults" />
                        </div>
                        <div class="setting-item">
                            <label>Recent Searches Remembered (0 = off)</label>
                            <input type="number" id="confMaxRecent" min="0" max="100" />
                        </div>
                        <div class="setting-item">
                            <label>Hover Jump Delay (ms, 0 = instant)</label>
                            <input type="number" id="confHoverDelay" min="0" step="50" />
                        </div>
                        <div class="setting-item">
                            <label>Results Context Lines (above and below)</label>
                            <input type="number" id="confContextLines" min="0" max="50" step="1" />
                        </div>
                        <div class="setting-item setting-check">
                            <label><input type="checkbox" id="confShowContextLine" /> Show the hit's context line under each result</label>
                        </div>
                        <div class="setting-item setting-check">
                            <label><input type="checkbox" id="confFollowEditor" /> Auto Search: Follows text editor cursor and selection</label>
                        </div>
                        <div class="setting-item setting-check">
                            <label><input type="checkbox" id="confAutoSearchResults" /> Auto Search from the results window (selecting a line there fills the search box)</label>
                        </div>
                        <div class="setting-item setting-check">
                            <label><input type="checkbox" id="confPersistPinned" /> Keep pinned searches between sessions</label>
                        </div>
                        <div class="setting-item setting-check">
                            <label><input type="checkbox" id="confAutoOpenResults" /> Open the results editor automatically when a search finds matches</label>
                        </div>
                    </section>

                    <section class="settings-group">
                        <h3 class="settings-group-title">Indexing</h3>
                        <p class="settings-group-note">These shape the index itself. Changing them makes the existing index stale until you reindex.</p>
                        <div class="setting-item">
                            <label>Include Extensions (e.g., ts,js,md)</label>
                            <input type="text" id="confIncludeExt" placeholder="Leave empty for all" />
                        </div>
                        <div class="setting-item">
                            <label>Exclude Patterns (Glob)</label>
                            <input type="text" id="confExcludePat" placeholder="{**/node_modules/**,...}" />
                        </div>
                        <div class="setting-item">
                            <label>Max File Size (KB)</label>
                            <input type="number" id="confMaxFileSize" />
                        </div>
                        <div class="reindex-banner" id="reindexHint" style="display: none;">
                            <span class="reindex-text" id="reindexText"></span>
                            <button id="undoIndexBtn" class="link-btn" title="Restore the include/exclude/size settings the current index was built with">Undo changes</button>
                        </div>
                        <button id="reindexBtn" title="Rebuild the index with the current settings.">🔁 Reindex</button>
                    </section>

                    <section class="settings-group">
                        <h3 class="settings-group-title">Cached indexes</h3>
                        <div class="cache-section">
                            <div class="cache-head">
                                <label title="Select every cached folder"><input type="checkbox" id="cacheSelectAll" /> Select all</label>
                                <span class="cache-summary" id="cacheSummary">Loading…</span>
                            </div>
                            <div class="cache-list" id="cacheList"></div>
                            <div class="cache-actions">
                                <button id="reindexCachesBtn" disabled>Reindex selected</button>
                                <button id="deleteCachesBtn" class="danger" disabled>Delete selected</button>
                                <button id="deleteStaleBtn" class="danger" disabled>Delete stale</button>
                            </div>
                        </div>
                    </section>
                </div>
                
                <div class="actions">
                    <button id="toggleReplaceBtn" title="Toggle Replace Mode">▼ Replace</button>
                </div>
                <div class="actions" id="replaceActions" style="display: none;">
                    <button id="replaceAllBtn">Replace All</button>
                </div>
                
                <div class="results-toolbar" id="resultsToolbar" style="display: none;">
                    <button id="viewToggleBtn" class="tool-btn" title="Switch between flat list and directory tree">🌳 Tree</button>
                    <button id="expandAllBtn" class="tool-btn" title="Expand every directory down to its files">⊞ Expand all</button>
                    <button id="collapseAllBtn" class="tool-btn" title="Collapse every directory">⊟ Collapse all</button>
                    <span class="lock-badge" id="lockBadge" style="display: none;" title="Results are locked, so the search box does not follow the editor. Click the lock button in the title bar to unlock.">🔒 Locked</span>
                    <span class="results-count" id="resultsCount"></span>
                </div>

                <div id="results"></div>
                <div class="pinned-resizer" id="pinnedResizer" style="display: none;"></div>
                <div class="pinned-section" id="pinnedSection" style="display: none;">
                    <div class="pinned-head">Pinned searches</div>
                    <div class="pinned-list" id="pinnedList"></div>
                </div>


                </div>
                <script>
                    const vscode = acquireVsCodeApi();
                    
                    // UI Elements
                    const searchInput = document.getElementById('searchInput');
                    const replaceInput = document.getElementById('replaceInput');
                    const resultsDiv = document.getElementById('results');
                    const toggleReplaceBtn = document.getElementById('toggleReplaceBtn');
                    const replaceGroup = document.getElementById('replaceGroup');
                    const replaceActions = document.getElementById('replaceActions');
                    const replaceAllBtn = document.getElementById('replaceAllBtn');
                    const settingsPanel = document.getElementById('settingsPanel');
                    const reindexBtn = document.getElementById('reindexBtn');
                    const reindexHint = document.getElementById('reindexHint');
                    const reindexText = document.getElementById('reindexText');
                    const undoIndexBtn = document.getElementById('undoIndexBtn');
                    const mainSearchPanel = document.getElementById('mainSearchPanel');
                    const matchCaseBtn = document.getElementById('matchCaseBtn');
                    const regexBtn = document.getElementById('regexBtn');

                    // Settings Elements
                    const confIncludeExt = document.getElementById('confIncludeExt');
                    const confExcludePat = document.getElementById('confExcludePat');
                    const confMaxFileSize = document.getElementById('confMaxFileSize');
                    const confMaxResults = document.getElementById('confMaxResults');
                    const confPanelFont = document.getElementById('confPanelFont');
                    const confShowContextLine = document.getElementById('confShowContextLine');
                    const historyList = document.getElementById('historyList');
                    const historyBtn = document.getElementById('historyBtn');
                    const treeMenu = document.getElementById('treeMenu');
                    const pinnedSection = document.getElementById('pinnedSection');
                    const pinnedList = document.getElementById('pinnedList');
                    const pinBtn = document.getElementById('pinBtn');
                    const pinnedResizer = document.getElementById('pinnedResizer');
                    const confMaxRecent = document.getElementById('confMaxRecent');
                    const confFollowEditor = document.getElementById('confFollowEditor');
                    const confAutoSearchResults = document.getElementById('confAutoSearchResults');
                    const confPersistPinned = document.getElementById('confPersistPinned');
                    const confHoverDelay = document.getElementById('confHoverDelay');
                    const confAutoOpenResults = document.getElementById('confAutoOpenResults');
                    const confContextLines = document.getElementById('confContextLines');
                    const scopeInclude = document.getElementById('scopeInclude');
                    const scopeExclude = document.getElementById('scopeExclude');
                    const cacheListEl = document.getElementById('cacheList');
                    const cacheSelectAll = document.getElementById('cacheSelectAll');
                    const cacheSummary = document.getElementById('cacheSummary');
                    const deleteCachesBtn = document.getElementById('deleteCachesBtn');
                    const deleteStaleBtn = document.getElementById('deleteStaleBtn');
                    const reindexCachesBtn = document.getElementById('reindexCachesBtn');
                    const resultsToolbar = document.getElementById('resultsToolbar');
                    const subSearchInput = document.getElementById('subSearchInput');
                    const viewToggleBtn = document.getElementById('viewToggleBtn');
                    const expandAllBtn = document.getElementById('expandAllBtn');
                    const collapseAllBtn = document.getElementById('collapseAllBtn');
                    const resultsCount = document.getElementById('resultsCount');
                    const lockBadge = document.getElementById('lockBadge');
                    const statusTextEl = document.getElementById('statusText');
                    const statusDotEl = document.getElementById('statusDot');

                    let viewMode = 'tree';
                    let collapsedDirs = new Set();
                    let subQuery = '';
                    let statusState = 'busy';
                    let maxRecent = ${maxRecentSearches};
                    let recentSearches = [];
                    let historyIndex = -1;
                    let userOwnsQuery = false;
                    let applyingPrefill = false;
                    let pinnedSearches = [];
                    let hoverDelay = 1500;
                    let showContextLine = true;
                    let locked = false;
                    let pinnedVisible = true;
                    let pinnedHeight = 170;
                    let pendingCollapsed = null;

                    let cacheEntries = [];
                    const selectedCaches = new Set();

                    function formatSize(bytes) {
                        if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
                        if (bytes >= 1024) return (bytes / 1024).toFixed(0) + ' KB';
                        return bytes + ' B';
                    }

                    function formatDate(ms) {
                        const date = new Date(ms);
                        if (isNaN(date.getTime())) return 'unknown';
                        return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) +
                            ' ' + date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
                    }

                    function updateCacheControls() {
                        const selected = cacheEntries.filter(entry => selectedCaches.has(entry.file));
                        const staleEntries = cacheEntries.filter(entry => !entry.exists);
                        const totalBytes = cacheEntries.reduce((sum, entry) => sum + entry.size, 0);
                        const selectedBytes = selected.reduce((sum, entry) => sum + entry.size, 0);
                        const staleNote = staleEntries.length ? ' · ' + staleEntries.length + ' missing' : '';

                        cacheSummary.textContent = (selected.length
                            ? selected.length + ' of ' + cacheEntries.length + ' · ' + formatSize(selectedBytes) + ' of ' + formatSize(totalBytes)
                            : cacheEntries.length + ' folder' + (cacheEntries.length === 1 ? '' : 's') + ' · ' + formatSize(totalBytes)) + staleNote;

                        deleteCachesBtn.disabled = selected.length === 0;
                        deleteCachesBtn.textContent = 'Delete selected';

                        reindexCachesBtn.disabled = selected.length === 0;
                        reindexCachesBtn.textContent = selected.length ? 'Reindex (' + selected.length + ')' : 'Reindex selected';

                        deleteStaleBtn.disabled = staleEntries.length === 0;
                        deleteStaleBtn.textContent = staleEntries.length ? 'Delete stale (' + staleEntries.length + ')' : 'Delete stale';

                        cacheSelectAll.checked = cacheEntries.length > 0 && selected.length === cacheEntries.length;
                        cacheSelectAll.indeterminate = selected.length > 0 && selected.length < cacheEntries.length;
                        cacheSelectAll.disabled = cacheEntries.length === 0;
                    }

                    function renderCaches() {
                        cacheListEl.innerHTML = '';
                        if (cacheEntries.length === 0) {
                            const empty = document.createElement('div');
                            empty.className = 'cache-empty';
                            empty.textContent = 'No cached folders yet.';
                            cacheListEl.appendChild(empty);
                            updateCacheControls();
                            return;
                        }

                        cacheEntries.forEach(entry => {
                            const row = document.createElement('label');
                            row.className = 'cache-row';

                            const check = document.createElement('input');
                            check.type = 'checkbox';
                            check.className = 'cache-check';
                            check.value = entry.file;
                            check.checked = selectedCaches.has(entry.file);
                            check.addEventListener('change', () => {
                                if (check.checked) selectedCaches.add(entry.file);
                                else selectedCaches.delete(entry.file);
                                updateCacheControls();
                            });

                            const name = document.createElement('span');
                            name.className = 'cache-name';
                            name.textContent = entry.root;
                            name.title = entry.root + '\\nFile: ' + entry.name +
                                (entry.inUse ? '\\n(used by this workspace)' : '');

                            const meta = document.createElement('span');
                            meta.className = 'cache-meta';
                            meta.textContent = formatDate(entry.builtAt) + ' · ' + formatSize(entry.size);

                            row.appendChild(check);
                            row.appendChild(name);
                            row.appendChild(meta);
                            if (!entry.exists) {
                                const missing = document.createElement('span');
                                missing.className = 'cache-badge missing';
                                missing.textContent = 'missing';
                                missing.title = 'This folder no longer exists (or is unavailable).';
                                row.appendChild(missing);
                            }
                            if (entry.inUse) {
                                const badge = document.createElement('span');
                                badge.className = 'cache-badge';
                                badge.textContent = 'in use';
                                row.appendChild(badge);
                            }
                            cacheListEl.appendChild(row);
                        });

                        updateCacheControls();
                    }

                    cacheSelectAll.addEventListener('change', () => {
                        selectedCaches.clear();
                        if (cacheSelectAll.checked) {
                            cacheEntries.forEach(entry => selectedCaches.add(entry.file));
                        }
                        renderCaches();
                    });

                    deleteCachesBtn.addEventListener('click', () => {
                        if (selectedCaches.size === 0) return;
                        deleteCachesBtn.disabled = true;
                        deleteCachesBtn.textContent = 'Deleting…';
                        vscode.postMessage({ type: 'deleteCaches', files: Array.from(selectedCaches) });
                    });

                    deleteStaleBtn.addEventListener('click', () => {
                        if (deleteStaleBtn.disabled) return;
                        deleteStaleBtn.disabled = true;
                        deleteStaleBtn.textContent = 'Deleting…';
                        vscode.postMessage({ type: 'deleteStaleCaches' });
                    });

                    reindexCachesBtn.addEventListener('click', () => {
                        const roots = cacheEntries.filter(entry => selectedCaches.has(entry.file)).map(entry => entry.root);
                        if (roots.length === 0) return;
                        reindexCachesBtn.disabled = true;
                        reindexCachesBtn.textContent = 'Reindexing…';
                        vscode.postMessage({ type: 'reindexCaches', roots });
                    });

                    let isReplaceMode = false;
                    let isSettingsMode = false;
                    let isMatchCase = false;
                    let isRegex = false;
                    let currentResults = [];

                    matchCaseBtn.addEventListener('click', () => {
                        isMatchCase = !isMatchCase;
                        matchCaseBtn.classList.toggle('active', isMatchCase);
                        triggerSearch();
                    });

                    regexBtn.addEventListener('click', () => {
                        isRegex = !isRegex;
                        regexBtn.classList.toggle('active', isRegex);
                        triggerSearch();
                    });

                    toggleReplaceBtn.addEventListener('click', () => {
                        isReplaceMode = !isReplaceMode;
                        replaceGroup.style.display = isReplaceMode ? 'flex' : 'none';
                        replaceActions.style.display = isReplaceMode ? 'flex' : 'none';
                        toggleReplaceBtn.innerText = isReplaceMode ? '▲ Replace' : '▼ Replace';
                    });

                    function toggleSettings() {
                        isSettingsMode = !isSettingsMode;
                        settingsPanel.style.display = isSettingsMode ? 'flex' : 'none';
                        mainSearchPanel.style.display = isSettingsMode ? 'none' : 'flex';
                        
                        if (isSettingsMode) {
                            vscode.postMessage({ type: 'getConfig' });
                            vscode.postMessage({ type: 'getCaches' });
                        } else {
                            // Leaving settings: the host asks about index parameters a build has not picked up.
                            vscode.postMessage({ type: 'settingsClosed' });
                        }
                    }

                    // Settings are written as you edit them: text fields debounce briefly,
                    // checkboxes apply at once. There is no Save button to forget.
                    function collectConfig() {
                        return {
                            includeExtensions: confIncludeExt.value,
                            excludePatterns: confExcludePat.value,
                            maxFileSizeKB: parseInt(confMaxFileSize.value, 10),
                            maxResults: parseInt(confMaxResults.value, 10),
                            panelFontSize: parseInt(confPanelFont.value, 10),
                            maxRecentSearches: parseInt(confMaxRecent.value, 10),
                            followEditor: confFollowEditor.checked,
                            persistPinnedSearches: confPersistPinned.checked,
                            hoverJumpDelay: confHoverDelay.value,
                            resultContextLines: confContextLines.value,
                            autoOpenResults: confAutoOpenResults?.checked === true,
                            autoSearchFromResults: confAutoSearchResults?.checked === true,
                            showContextLine: confShowContextLine?.checked !== false
                        };
                    }

                    let configSaveTimer = null;

                    function flushConfig() {
                        clearTimeout(configSaveTimer);
                        configSaveTimer = null;
                        vscode.postMessage({ type: 'saveConfig', value: collectConfig() });
                    }

                    function saveConfigSoon() {
                        clearTimeout(configSaveTimer);
                        configSaveTimer = setTimeout(flushConfig, 350);
                    }

                    [confIncludeExt, confExcludePat, confMaxFileSize, confMaxResults, confPanelFont, confMaxRecent, confHoverDelay, confContextLines]
                        .filter(Boolean)
                        .forEach(function (field) {
                            field.addEventListener('input', saveConfigSoon);
                            field.addEventListener('keydown', function (event) {
                                if (event.key === 'Enter') {
                                    event.preventDefault();
                                    flushConfig();
                                }
                            });
                        });

                    [confFollowEditor, confPersistPinned, confAutoOpenResults, confAutoSearchResults, confShowContextLine]
                        .filter(Boolean)
                        .forEach(function (field) {
                            field.addEventListener('change', flushConfig);
                        });

                    // Resize the panel as the number is typed, not just once it is saved.
                    if (confPanelFont) {
                        confPanelFont.addEventListener('input', function () {
                            const size = parseInt(confPanelFont.value, 10);
                            if (!Number.isFinite(size)) return;
                            document.body.style.fontSize = Math.max(9, Math.min(24, size)) + 'px';
                        });
                    }

                    reindexBtn.addEventListener('click', () => {
                        vscode.postMessage({ type: 'rebuildIndex' });
                        isSettingsMode = false;
                        settingsPanel.style.display = 'none';
                        mainSearchPanel.style.display = 'flex';
                    });

                    if (undoIndexBtn) {
                        undoIndexBtn.addEventListener('click', (event) => {
                            event.stopPropagation();
                            vscode.postMessage({ type: 'undoIndexSettings' });
                        });
                    }

                    replaceAllBtn.addEventListener('click', () => {
                        if (currentResults.length === 0) return;
                        const replaceText = replaceInput.value;
                        const query = searchInput.value;
                        if (!query || (!isRegex && query.length < 3)) return;
                        // Scope to what the current filter shows, never to hidden rows.
                        const visible = filteredResults();
                        if (visible.length === 0) return;
                        vscode.postMessage({ type: 'replaceAll', value: { results: visible, query, replaceText, isMatchCase, isRegex, filter: subQuery.trim(), ...currentScope() } });
                    });

                    function triggerSearch(reason) {
                        const query = searchInput.value;
                        vscode.postMessage({ type: 'search', value: query, isMatchCase, isRegex, filter: subQuery.trim(), reason: reason || 'typing', ...currentScope() }); 
                    }

                    let timeout;
                    searchInput.addEventListener('input', (e) => {
                        if (!applyingPrefill) userOwnsQuery = true;
                        vscode.setState(Object.assign({}, vscode.getState(), { query: searchInput.value }));
                        clearTimeout(timeout);
                        timeout = setTimeout(triggerSearch, ${debounceDelay});
                    });
                    window.addEventListener('blur', () => { userOwnsQuery = false; });
                    (function restoreScope() {
                        const saved = vscode.getState && vscode.getState();
                        if (saved && typeof saved.scopeInclude === 'string') scopeInclude.value = saved.scopeInclude;
                        if (saved && typeof saved.scopeExclude === 'string') scopeExclude.value = saved.scopeExclude;
                    })();

                    function scopeTokens(value) {
                        return value.split(',').map(s => s.trim()).filter(Boolean);
                    }

                    function currentScope() {
                        return { include: scopeTokens(scopeInclude.value), exclude: scopeTokens(scopeExclude.value) };
                    }

                    let scopeTimeout;
                    function onScopeChanged() {
                        clearTimeout(scopeTimeout);
                        scopeTimeout = setTimeout(() => {
                            vscode.setState(Object.assign({}, vscode.getState(), {
                                scopeInclude: scopeInclude.value,
                                scopeExclude: scopeExclude.value
                            }));
                            if (searchInput.value && (isRegex || searchInput.value.length >= 3)) triggerSearch();
                        }, 350);
                    }
                    scopeInclude.addEventListener('input', onScopeChanged);
                    scopeExclude.addEventListener('input', onScopeChanged);
                    (function restoreHistory() {
                        const saved = vscode.getState && vscode.getState();
                        if (saved && Array.isArray(saved.recentSearches)) {
                            recentSearches = saved.recentSearches.filter(function (q) { return typeof q === 'string'; });
                        }
                    })();

                    function persistHistory() {
                        vscode.setState(Object.assign({}, vscode.getState(), { recentSearches: recentSearches }));
                    }

                    function rememberSearch(value) {
                        const query = String(value || '').trim();
                        if (maxRecent <= 0 || query.length < 3) return;
                        recentSearches = [query].concat(recentSearches.filter(function (q) { return q !== query; })).slice(0, maxRecent);
                        persistHistory();
                    }

                    function hideHistory() {
                        historyList.style.display = 'none';
                        historyIndex = -1;
                    }

                    function moveHistory(delta) {
                        const rows = Array.prototype.slice.call(historyList.querySelectorAll('.history-item'));
                        if (rows.length === 0) return;
                        historyIndex = Math.max(0, Math.min(rows.length - 1, historyIndex + delta));
                        rows.forEach(function (row, i) { row.classList.toggle('active', i === historyIndex); });
                        if (rows[historyIndex].scrollIntoView) rows[historyIndex].scrollIntoView({ block: 'nearest' });
                    }

                    function showHistory(showAll) {
                        if (maxRecent <= 0 || recentSearches.length === 0) { hideHistory(); return; }
                        const needle = showAll ? '' : searchInput.value.trim().toLowerCase();
                        const items = recentSearches
                            .filter(function (q) { return !needle || q.toLowerCase().indexOf(needle) >= 0; })
                            .slice(0, showAll ? maxRecent : Math.min(maxRecent, 12));
                        historyList.innerHTML = '';
                        if (items.length === 0) { hideHistory(); return; }
                        items.forEach(function (item) {
                            const row = document.createElement('div');
                            row.className = 'history-item';
                            row.textContent = item;
                            row.addEventListener('mousedown', function (event) {
                                event.preventDefault();
                                searchInput.value = item;
                                hideHistory();
                                rememberSearch(item);
                                triggerSearch();
                            });
                            historyList.appendChild(row);
                        });
                        historyList.style.display = 'flex';
                        historyIndex = -1;
                    }

                    searchInput.addEventListener('keydown', function (event) {
                        if (event.key === 'ArrowDown') {
                            event.preventDefault();
                            if (historyList.style.display !== 'flex') showHistory();
                            moveHistory(1);
                        } else if (event.key === 'ArrowUp') {
                            event.preventDefault();
                            moveHistory(-1);
                        } else if (event.key === 'Enter') {
                            const rows = historyList.querySelectorAll('.history-item');
                            if (historyIndex >= 0 && rows[historyIndex]) searchInput.value = rows[historyIndex].textContent;
                            hideHistory();
                            rememberSearch(searchInput.value);
                            triggerSearch();
                        } else if (event.key === 'Escape') {
                            hideHistory();
                        }
                    });

                    historyBtn.addEventListener('mousedown', function (event) {
                        // Prevent the input from losing focus, then toggle the full list.
                        event.preventDefault();
                        if (historyList.style.display === 'flex') hideHistory();
                        else showHistory(true);
                    });


                    searchInput.addEventListener('blur', function () { setTimeout(hideHistory, 120); });

                    document.addEventListener('visibilitychange', function () {
                        if (document.visibilityState === 'hidden') rememberSearch(searchInput.value);
                        else searchInput.focus();
                    });

                    function escapeHtml(unsafe) {
                        return unsafe.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
                    }

                    function highlightText(text, query, isMatchCase, isRegex) {
                        if (!query) return escapeHtml(text);
                        let flags = 'g';
                        if (!isMatchCase) flags += 'i';
                        let regex;
                        try {
                            if (isRegex) {
                                regex = new RegExp('(' + query + ')', flags);
                            } else {
                                const safeQuery = query.replace(/[.*+?^$}{()|\\[\\]\\\\]/g, '\\\\$&');
                                regex = new RegExp('(' + safeQuery + ')', flags);
                            }
                        } catch (e) {
                            return escapeHtml(text);
                        }

                        const parts = text.split(regex);
                        let result = '';
                        for (let i = 0; i < parts.length; i++) {
                            if (i % 2 !== 0) {
                                result += '<span class="highlight">' + escapeHtml(parts[i]) + '</span>';
                            } else {
                                result += escapeHtml(parts[i]);
                            }
                        }
                        return result;
                    }

                    function currentQueryText() {
                        return searchInput.value;
                    }

                    function filteredResults() {
                        const needle = subQuery.trim().toLowerCase();
                        if (!needle) return currentResults;
                        return currentResults.filter(item =>
                            (item.fileName || '').toLowerCase().includes(needle) ||
                            (item.text || '').toLowerCase().includes(needle));
                    }

                    function makeResultRow(item, depth, label) {
                        const div = document.createElement('div');
                        div.className = 'result-item';
                        if (depth > 0) div.style.paddingLeft = (6 + depth * 12) + 'px';

                        const header = document.createElement('div');
                        header.className = 'result-header';

                        const nameSpan = document.createElement('span');
                        nameSpan.className = 'file-name';
                        nameSpan.textContent = label ? label + ':' + (item.line + 1) : String(item.line + 1);
                        nameSpan.title = item.fileName;
                        header.appendChild(nameSpan);

                        if (item.nameMatch) {
                            const nameBadge = document.createElement('span');
                            nameBadge.className = 'name-badge';
                            nameBadge.textContent = 'name';
                            nameBadge.title = 'The file name matches this search';
                            header.appendChild(nameBadge);
                        }

                        if (!item.fileNameOnly) {
                            const replaceBtn = document.createElement('button');
                            replaceBtn.className = 'replace-btn';
                            replaceBtn.textContent = 'Replace';
                            replaceBtn.onclick = (e) => {
                                e.stopPropagation();
                                vscode.postMessage({
                                    type: 'replaceSingle',
                                    value: { file: item.file, line: item.line, query: currentQueryText(), replaceText: replaceInput.value, isMatchCase, isRegex, filter: subQuery.trim(), ...currentScope() }
                                });
                            };
                            header.appendChild(replaceBtn);
                        }

                        const snippet = document.createElement('div');
                        snippet.className = 'snippet';
                        snippet.innerHTML = item.fileNameOnly
                            ? '<span class="filename-only">file name match</span>'
                            : highlightText(item.text, currentQueryText(), isMatchCase, isRegex);

                        div.appendChild(header);
                        // The hit's context line is optional: turning it off leaves a compact
                        // file-and-line list that survives narrow side bars.
                        if (showContextLine || item.fileNameOnly) div.appendChild(snippet);
                        div.onclick = () => {
                            rememberSearch(currentQueryText());
                            vscode.postMessage({ type: 'openFile', value: { file: item.file, line: item.line } });
                        };
                        div.addEventListener('mouseenter', () => scheduleHover(item, div));
                        div.addEventListener('mouseleave', () => { if (hoverRow === div) hoverRow = null; });
                        return div;
                    }

                    function emptyNode() {
                        return { dirs: new Map(), files: new Map() };
                    }

                    function buildTree(items) {
                        const root = emptyNode();
                        items.forEach(item => {
                            const parts = (item.fileName || item.file).split(/[\\/]/).filter(Boolean);
                            const fileName = parts.pop() || item.fileName;
                            let node = root;
                            parts.forEach(part => {
                                if (!node.dirs.has(part)) node.dirs.set(part, emptyNode());
                                node = node.dirs.get(part);
                            });
                            if (!node.files.has(fileName)) node.files.set(fileName, []);
                            node.files.get(fileName).push(item);
                        });
                        return root;
                    }

                    /** Matches inside one file are grouped under a file node, like directories. */
                    function countLeaves(node) {
                        let total = 0;
                        node.files.forEach(group => { total += group.length; });
                        node.dirs.forEach(child => { total += countLeaves(child); });
                        return total;
                    }

                    function collectTreeKeys(node, prefix, out) {
                        node.dirs.forEach((child, name) => {
                            const path = prefix ? prefix + '/' + name : name;
                            out.add(path);
                            collectTreeKeys(child, path, out);
                        });
                        node.files.forEach((group, name) => {
                            const path = prefix ? prefix + '/' + name : name;
                            out.add('file:' + path);
                        });
                    }

                    function findNode(node, path) {
                        if (!path) return node;
                        const parts = path.split('/');
                        for (const part of parts) {
                            if (!node || !node.dirs.has(part)) return null;
                            node = node.dirs.get(part);
                        }
                        return node;
                    }

                    function expandSubtree(path) {
                        collapsedDirs.delete(path);
                        const prefix = path + '/';
                        Array.from(collapsedDirs).forEach(key => {
                            const bare = key.indexOf('file:') === 0 ? key.slice(5) : key;
                            if (bare.indexOf(prefix) === 0) collapsedDirs.delete(key);
                        });
                    }

                    let menuPath = null;

                    /** Everything strictly below path: sub-directories and file groups. */
                    function keysUnder(path) {
                        const node = findNode(buildTree(filteredResults()), path);
                        const out = new Set();
                        if (!node) return out;
                        node.dirs.forEach((child, name) => {
                            const childPath = path ? path + '/' + name : name;
                            out.add(childPath);
                            collectTreeKeys(child, childPath, out);
                        });
                        node.files.forEach((group, name) => {
                            out.add('file:' + (path ? path + '/' + name : name));
                        });
                        return out;
                    }

                    function hideTreeMenu() {
                        treeMenu.style.display = 'none';
                        menuPath = null;
                    }

                    function showTreeMenu(path, x, y) {
                        menuPath = path;
                        treeMenu.innerHTML = '';
                        [['Collapse all below', 'collapse'], ['Expand all below', 'expand']].forEach((entry) => {
                            const item = document.createElement('div');
                            item.className = 'tree-menu-item';
                            item.textContent = entry[0];
                            item.addEventListener('mousedown', (event) => {
                                event.preventDefault();
                                event.stopPropagation();
                                if (entry[1] === 'collapse') {
                                    // Keep this node open; only its children fold.
                                    collapsedDirs.delete(path);
                                    keysUnder(path).forEach((child) => collapsedDirs.add(child));
                                } else {
                                    expandSubtree(path);
                                }
                                hideTreeMenu();
                                renderResults();
                            });
                            treeMenu.appendChild(item);
                        });
                        treeMenu.style.display = 'block';
                        treeMenu.style.left = Math.max(4, x) + 'px';
                        treeMenu.style.top = Math.max(4, y) + 'px';
                    }

                    document.addEventListener('mousedown', (event) => {
                        if (treeMenu.style.display === 'block' && !treeMenu.contains(event.target)) hideTreeMenu();
                    });
                    document.addEventListener('keydown', (event) => {
                        if (event.key === 'Escape') hideTreeMenu();
                    });

                    function renderTree(node, prefix, depth, container) {
                        Array.from(node.dirs.keys()).sort((a, b) => a.localeCompare(b)).forEach(name => {
                            const path = prefix ? prefix + '/' + name : name;
                            const child = node.dirs.get(name);
                            const isCollapsed = collapsedDirs.has(path);

                            const row = document.createElement('div');
                            row.className = 'tree-dir';
                            row.style.paddingLeft = (4 + depth * 12) + 'px';
                            row.innerHTML = '<span class="chevron">' + (isCollapsed ? '▸' : '▾') + '</span>' +
                                '<span class="dir-name">' + escapeHtml(name) + '</span>' +
                                '<span class="dir-count">' + countLeaves(child) + '</span>';
                            row.title = isCollapsed ? 'Expand ' + path : 'Collapse ' + path;
                            row.oncontextmenu = (event) => {
                                event.preventDefault();
                                event.stopPropagation();
                                showTreeMenu(path, event.clientX, event.clientY);
                            };
                            row.onclick = () => {
                                if (!collapsedDirs.has(path)) {
                                    collapsedDirs.add(path);
                                } else {
                                    // Expanding: walk down while a folder has exactly one child
                                    // (a single subfolder and no files), like the file explorer.
                                    collapsedDirs.delete(path);
                                    let node = child;
                                    let nodePath = path;
                                    while (node && node.dirs.size === 1 && node.files.size === 0) {
                                        const entry = node.dirs.entries().next().value;
                                        nodePath = nodePath + '/' + entry[0];
                                        collapsedDirs.delete(nodePath);
                                        node = entry[1];
                                    }
                                }
                                renderResults();
                            };
                            container.appendChild(row);

                            if (!isCollapsed) renderTree(child, path, depth + 1, container);
                        });

                        Array.from(node.files.keys()).sort((a, b) => a.localeCompare(b)).forEach(name => {
                            const group = node.files.get(name);
                            const filePath = prefix ? prefix + '/' + name : name;
                            const key = 'file:' + filePath;
                            const isCollapsed = collapsedDirs.has(key);

                            const row = document.createElement('div');
                            row.className = 'tree-file';
                            row.style.paddingLeft = (4 + depth * 12) + 'px';
                            row.innerHTML = '<span class="chevron">' + (isCollapsed ? '▸' : '▾') + '</span>' +
                                '<span class="dir-name">' + escapeHtml(name) + '</span>' +
                                '<span class="dir-count">' + group.length + '</span>';
                            row.title = filePath;
                            row.onclick = function () {
                                if (collapsedDirs.has(key)) collapsedDirs.delete(key);
                                else collapsedDirs.add(key);
                                renderResults();
                            };
                            container.appendChild(row);

                            if (!isCollapsed) {
                                group.forEach(item => container.appendChild(makeResultRow(item, depth + 1, '')));
                            }
                        });
                    }

                    function renderResults() {
                        const items = filteredResults();
                        const hasResults = currentResults.length > 0;
                        resultsToolbar.style.display = hasResults ? 'flex' : 'none';
                        expandAllBtn.style.display = viewMode === 'tree' ? '' : 'none';
                        collapseAllBtn.style.display = viewMode === 'tree' ? '' : 'none';
                        viewToggleBtn.textContent = viewMode === 'tree' ? '🌳 Tree' : '☰ List';

                        resultsCount.textContent = items.length === currentResults.length
                            ? currentResults.length + (currentResults.length === 1 ? ' result' : ' results')
                            : items.length + ' of ' + currentResults.length;

                        resultsDiv.innerHTML = '';
                        if (!hasResults) {
                            resultsDiv.innerHTML = statusState === 'busy' || statusState === 'idle'
                                ? '<p class="loading-hint" style="opacity: 0.6; font-size: 0.9em;">Index is still loading…</p>'
                                : '<p style="opacity: 0.6; font-size: 0.9em;">No results found.</p>';
                            return;
                        }
                        if (items.length === 0) {
                            resultsDiv.innerHTML = '<p style="opacity: 0.6; font-size: 0.9em;">No results match the filter.</p>';
                            return;
                        }

                        if (viewMode === 'tree') {
                            renderTree(buildTree(items), '', 0, resultsDiv);
                        } else {
                            items.forEach(item => resultsDiv.appendChild(makeResultRow(item, 0, item.fileName)));
                        }
                    }

                    viewToggleBtn.addEventListener('click', () => {
                        viewMode = viewMode === 'tree' ? 'flat' : 'tree';
                        vscode.postMessage({ type: 'viewMode', value: viewMode });
                        renderResults();
                    });

                    expandAllBtn.addEventListener('click', () => {
                        collapsedDirs = new Set();
                        renderResults();
                    });

                    collapseAllBtn.addEventListener('click', () => {
                        const paths = new Set();
                        collectTreeKeys(buildTree(filteredResults()), '', paths);
                        collapsedDirs = paths;
                        renderResults();
                    });

                    let subSearchTimeout;
                    subSearchInput.addEventListener('input', () => {
                        // Narrow the visible rows at once, then re-run the query so the
                        // host can keep scanning until enough filtered rows are found.
                        subQuery = subSearchInput.value;
                        renderResults();
                        clearTimeout(subSearchTimeout);
                        subSearchTimeout = setTimeout(() => {
                            if (searchInput.value && (isRegex || searchInput.value.length >= 3)) triggerSearch();
                        }, 350);
                    });


                    function applyPinnedLayout() {
                        const show = pinnedVisible && pinnedSearches.length > 0;
                        pinnedSection.style.display = show ? 'flex' : 'none';
                        pinnedSection.style.height = pinnedHeight + 'px';
                        pinnedResizer.style.display = show ? 'block' : 'none';
                    }

                    function rememberLayout() {
                        vscode.setState(Object.assign({}, vscode.getState(), {
                            pinnedVisible: pinnedVisible,
                            pinnedHeight: pinnedHeight
                        }));
                    }

                    (function restoreLayout() {
                        const saved = vscode.getState && vscode.getState();
                        if (!saved) return;
                        if (typeof saved.pinnedVisible === 'boolean') pinnedVisible = saved.pinnedVisible;
                        if (typeof saved.pinnedHeight === 'number') pinnedHeight = Math.max(56, Math.round(saved.pinnedHeight));
                        if (typeof saved.locked === 'boolean') locked = saved.locked;
                    })();
                    function setLocked(value) {
                        locked = Boolean(value);
                        vscode.setState(Object.assign({}, vscode.getState(), { locked: locked }));
                        if (lockBadge) lockBadge.style.display = locked ? '' : 'none';
                    }

                    setLocked(locked);

                    let resizingPinned = false;
                    pinnedResizer.addEventListener('mousedown', function (event) {
                        event.preventDefault();
                        resizingPinned = true;
                        pinnedResizer.classList.add('active');
                        document.body.style.userSelect = 'none';
                    });
                    window.addEventListener('mousemove', function (event) {
                        if (!resizingPinned) return;
                        const height = Math.max(56, Math.min(Math.round(window.innerHeight * 0.7), window.innerHeight - event.clientY - 10));
                        pinnedHeight = height;
                        pinnedSection.style.height = height + 'px';
                    });
                    window.addEventListener('mouseup', function () {
                        if (!resizingPinned) return;
                        resizingPinned = false;
                        pinnedResizer.classList.remove('active');
                        document.body.style.userSelect = '';
                        rememberLayout();
                    });

                    function pinDetails(pin) {
                        const parts = [];
                        if (pin.include) parts.push('only: ' + pin.include);
                        if (pin.exclude) parts.push('skip: ' + pin.exclude);
                        if (pin.filter) parts.push('filter: ' + pin.filter);
                        if (pin.isMatchCase) parts.push('Aa');
                        if (pin.isRegex) parts.push('.*');
                        return parts.join(' · ');
                    }

                    let hoverTimer = null;
                    let hoverRow = null;

                    function scheduleHover(item, element) {
                        clearTimeout(hoverTimer);
                        hoverRow = element;
                        hoverTimer = setTimeout(function () {
                            // Only act on a row the pointer is still resting on: sweeping
                            // across results must not yank the results tab around.
                            if (hoverRow !== element) return;
                            vscode.postMessage({ type: 'hover', file: item.file, line: item.line });
                        }, hoverDelay);
                    }

                    function describePin(pin) {
                        const details = pinDetails(pin);
                        return details ? pin.query + ' · ' + details : pin.query;
                    }

                    function renderPinned() {
                        applyPinnedLayout();
                        pinnedList.innerHTML = '';
                        pinnedSearches.forEach(function (pin) {
                            const row = document.createElement('div');
                            row.className = 'pinned-item';
                            row.title = describePin(pin);

                            const body = document.createElement('div');
                            body.className = 'pinned-body';

                            const name = document.createElement('span');
                            name.className = 'pinned-name';
                            name.textContent = pin.query;
                            body.appendChild(name);

                            const details = pinDetails(pin);
                            if (details) {
                                const meta = document.createElement('span');
                                meta.className = 'pinned-meta';
                                meta.textContent = details;
                                body.appendChild(meta);
                            }

                            const remove = document.createElement('span');
                            remove.className = 'pinned-delete';
                            remove.textContent = '✕';
                            remove.title = 'Remove this pinned search';
                            remove.addEventListener('mousedown', function (event) {
                                event.preventDefault();
                                event.stopPropagation();
                                vscode.postMessage({ type: 'deletePinned', id: pin.id });
                            });

                            row.appendChild(body);
                            row.appendChild(remove);
                            row.addEventListener('click', function () { restorePinned(pin); });
                            pinnedList.appendChild(row);
                        });
                    }

                    function restorePinned(pin) {
                        // The pin owns the box: a slow editor prefill must not replace it.
                        userOwnsQuery = true;
                        vscode.postMessage({ type: 'pinRestore' });
                        searchInput.value = pin.query || '';
                        isMatchCase = Boolean(pin.isMatchCase);
                        isRegex = Boolean(pin.isRegex);
                        matchCaseBtn.classList.toggle('active', isMatchCase);
                        regexBtn.classList.toggle('active', isRegex);
                        scopeInclude.value = pin.include || '';
                        scopeExclude.value = pin.exclude || '';
                        subSearchInput.value = pin.filter || '';
                        subQuery = pin.filter || '';
                        pendingCollapsed = Array.isArray(pin.collapsed) ? pin.collapsed : [];
                        triggerSearch('pin');
                    }

                    pinBtn.addEventListener('mousedown', function (event) {
                        event.preventDefault();
                        event.stopPropagation();
                        const query = searchInput.value.trim();
                        if (!query) return;
                        if (!pinnedVisible) {
                            pinnedVisible = true;
                            rememberLayout();
                            applyPinnedLayout();
                        }
                        vscode.postMessage({
                            type: 'pinSearch',
                            value: {
                                query: query,
                                isMatchCase: isMatchCase,
                                isRegex: isRegex,
                                include: scopeInclude.value,
                                exclude: scopeExclude.value,
                                filter: subQuery.trim(),
                                collapsed: Array.from(collapsedDirs)
                            }
                        });
                    });

                    Array.from(document.querySelectorAll('.clear-btn')).forEach((button) => {
                        button.addEventListener('mousedown', (event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            const field = button.parentElement.querySelector('input');
                            if (!field || field.value === '') return;
                            field.value = '';
                            field.dispatchEvent(new Event('input'));
                            field.focus();
                        });
                    });

                    searchInput.focus();
                    // A freshly opened panel starts clean: no leftover query, no open history.
                    searchInput.value = '';
                    hideHistory();

                    vscode.postMessage({ type: 'viewMode', value: viewMode });
                    vscode.postMessage({ type: 'getPinned' });
                    vscode.postMessage({ type: 'ready' });

                    window.addEventListener('message', event => {
                        const message = event.data;

                        if (message.type === 'configData') {
                            confIncludeExt.value = message.value.includeExtensions;
                            confExcludePat.value = message.value.excludePatterns;
                            confMaxFileSize.value = message.value.maxFileSizeKB;
                            confMaxResults.value = message.value.maxResults;
                            if (confPanelFont) confPanelFont.value = message.value.panelFontSize ?? 14;
                            if (typeof message.value.panelFontSize === 'number') {
                                document.body.style.fontSize = Math.max(9, Math.min(24, message.value.panelFontSize)) + 'px';
                            }
                            confFollowEditor.checked = message.value.followEditor !== false;
                            confPersistPinned.checked = message.value.persistPinnedSearches !== false;
                            confHoverDelay.value = message.value.hoverJumpDelay ?? 1500;
                            confContextLines.value = message.value.resultContextLines ?? 2;
                            if (confAutoOpenResults) confAutoOpenResults.checked = message.value.autoOpenResults === true;
                            if (confAutoSearchResults) confAutoSearchResults.checked = message.value.autoSearchFromResults === true;
                            if (confShowContextLine) confShowContextLine.checked = message.value.showContextLine !== false;
                            const showContext = message.value.showContextLine !== false;
                            if (showContext !== showContextLine) {
                                showContextLine = showContext;
                                renderResults();
                            }
                            hoverDelay = Number.isFinite(Number(message.value.hoverJumpDelay)) ? Math.max(0, Number(message.value.hoverJumpDelay)) : 1500;
                            if (typeof message.value.maxRecentSearches === 'number') {
                                confMaxRecent.value = message.value.maxRecentSearches;
                                maxRecent = Math.max(0, Math.min(100, Math.floor(message.value.maxRecentSearches)));
                                recentSearches = recentSearches.slice(0, maxRecent);
                                persistHistory();
                            }
                            if (reindexHint) {
                                const pendingFields = Array.isArray(message.value.pendingFields) ? message.value.pendingFields : [];
                                const stale = pendingFields.length > 0;
                                reindexHint.style.display = stale ? 'flex' : 'none';
                                if (reindexText) {
                                    reindexText.textContent = stale
                                        ? 'Index is stale — changed: ' + pendingFields.join(', ') + '. Reindex to commit them.'
                                        : '';
                                }
                            }
                            // A live-saved setting such as the result limit applies at once.
                            if (message.value.saved && searchInput.value && (isRegex || searchInput.value.length >= 3)) {
                                clearTimeout(timeout);
                                timeout = setTimeout(triggerSearch, 200);
                            }
                        }

                        if (message.type === 'locked') {
                            setLocked(message.value);
                        }

                        if (message.type === 'showSettings') {
                            toggleSettings();
                        }

                        if (message.type === 'togglePinned') {
                            pinnedVisible = !pinnedVisible;
                            rememberLayout();
                            applyPinnedLayout();
                        }

                        if (message.type === 'pinnedList') {
                            pinnedSearches = Array.isArray(message.value) ? message.value : [];
                            renderPinned();
                        }

                        if (message.type === 'cacheList') {
                            cacheEntries = Array.isArray(message.value) ? message.value : [];
                            selectedCaches.clear();
                            renderCaches();
                        }

                        if (message.type === 'focus') {
                            searchInput.focus();
                        }

                        if (message.type === 'prefill') {
                            if (locked) return;
                            const prefill = String(message.value || '');
                            // Never overwrite a query the user is editing right now.
                            // Ownership lasts only while the panel itself has focus: once the
                            // caret is in the editor, the editor drives the search again.
                            const focused = typeof document.hasFocus === 'function' ? document.hasFocus() : true;
                            const typing = userOwnsQuery && focused;
                            if (prefill && prefill !== searchInput.value && !typing) {
                                applyingPrefill = true;
                                searchInput.value = prefill;
                                searchInput.dispatchEvent(new Event('input'));
                                applyingPrefill = false;
                                userOwnsQuery = false;
                                if (document.hasFocus()) searchInput.focus();
                                // Editor selections and cursor words are searches too.
                                rememberSearch(prefill);
                            }
                        }

                        if (message.type === 'status') {
                            statusTextEl.textContent = message.value.text;
                            statusDotEl.className = 'status-dot ' + message.value.state;
                            statusState = message.value.state;
                            if (resultsDiv.querySelector('.loading-hint')) renderResults();
                        }

                        if (message.type === 'results') {
                            currentResults = message.value;
                            // A restored pin brings its own fold state back.
                            collapsedDirs = pendingCollapsed ? new Set(pendingCollapsed) : new Set();
                            pendingCollapsed = null;
                            // The filter is a search modifier: it survives new result sets.
                            renderResults();
                        }
                    });
                </script>
            </body>
            </html>
        `;
    }
}
