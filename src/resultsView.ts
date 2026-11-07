import * as fs from 'fs';
import * as vscode from 'vscode';
import { log } from './log';
import {
    ResultRow,
    ResultsDocumentProvider,
    ResultsSnapshot,
    buildResultsText,
    FILE_LINE,
    RESULT_LINE,
    labelForFile,
    orderRowsDepthFirst
} from './ResultsDocumentProvider';

/** The language VS Code's own `search-result` extension owns. */
const SEARCH_RESULT_LANGUAGE = 'search-result';

/**
 * The results tab: a read-only `search-result` document that the panel rewrites
 * in place. VS Code's built-in search-result extension supplies the tokenizer,
 * the definition links and the Follow-link targets; this class only builds the
 * text and turns a click into a peek in this editor.
 */
export class ResultsView implements vscode.Disposable {
    private readonly provider = new ResultsDocumentProvider();
    private readonly disposables: vscode.Disposable[] = [];
    private building = false;
    private rebuildQueued = false;
    private opening = false;
    private syncQueued = false;
    /** `${file}:${line}` -> document line of the matching hit, filled by render(). */
    private matchLines = new Map<string, number>();
    private lastPeek?: { line: number; version: number; at: number };

    public constructor(
        private readonly getSnapshot: () => ResultsSnapshot | undefined,
        private readonly getViewMode: () => 'tree' | 'flat'
    ) {}

    public register(): vscode.Disposable[] {
        this.disposables.push(
            this.provider,
            vscode.workspace.registerTextDocumentContentProvider(ResultsDocumentProvider.scheme, this.provider),
            vscode.commands.registerCommand('vscode-fast-index.openResultsInEditor', () => this.open()),
            vscode.window.onDidChangeTextEditorSelection(event => this.onSelection(event))
        );
        return this.disposables;
    }

    /**
     * True when the results tab is actually open. `workspace.textDocuments` is not
     * enough: a closed virtual document can stay loaded, which would make sync()
     * refresh an invisible document instead of reopening the tab.
     */
    private isOpen(): boolean {
        const target = ResultsDocumentProvider.uri.toString();
        return vscode.window.tabGroups.all.some(group =>
            group.tabs.some(tab => {
                const input = tab.input;
                return input instanceof vscode.TabInputText && input.uri.toString() === target;
            })
        );
    }

    /** Opens the results tab, or brings the existing one forward. */
    public async open(options?: { preserveFocus?: boolean }): Promise<void> {
        if (this.opening) return;
        const snapshot = this.getSnapshot();
        if (!snapshot || snapshot.rows.length === 0) {
            vscode.window.showInformationMessage('Fast Index: run a search first.');
            return;
        }

        this.opening = true;
        try {
            this.provider.setText(await this.render(snapshot));

            const document = await vscode.workspace.openTextDocument(ResultsDocumentProvider.uri);
            await this.ensureLanguage(document);
            await this.showInDock(document, options?.preserveFocus === true);
        } finally {
            this.opening = false;
        }
    }

    /**
     * Puts the tab where `fastIndex.resultsDock` says. `below` splits the active group
     * downwards first, so the document the search came from stays visible above the results
     * instead of being hidden behind them in the same group.
     */
    private async showInDock(document: vscode.TextDocument, preserveFocus: boolean): Promise<void> {
        const dock = vscode.workspace.getConfiguration('fastIndex').get<string>('resultsDock', 'current');

        if (dock === 'right') {
            await vscode.window.showTextDocument(document, {
                viewColumn: vscode.ViewColumn.Beside,
                preview: false,
                preserveFocus,
            });
            return;
        }

        if (dock === 'below') {
            try {
                // Splits the current editor into a new group below and focuses it; the
                // original stays in place. Showing the results there replaces the copy.
                await vscode.commands.executeCommand('workbench.action.splitEditorDown');
            } catch {
                /* no editor to split from: fall back to the active group */
            }
        }

        await vscode.window.showTextDocument(document, { preview: false, preserveFocus });
    }

    /**
     * Called whenever the panel produces new results or changes its layout.
     * `autoOpen` mirrors the `fastIndex.autoOpenResults` setting: a search makes the tab
     * visible — it opens it when closed, and brings an existing tab in front when the user
     * has switched to another document — without stealing keyboard focus from wherever the
     * search came from.
     */
    public async sync(autoOpen: boolean): Promise<void> {
        if (this.opening) {
            // A newer search landed while the tab was being built: refresh once it exists.
            this.syncQueued = true;
            return;
        }
        if (this.isOpen()) {
            await this.refresh();
            if (autoOpen && !this.isActiveTab()) await this.surface();
            return;
        }
        if (!autoOpen) return;

        const snapshot = this.getSnapshot();
        if (!snapshot || snapshot.rows.length === 0) return;

        await this.open({ preserveFocus: true });
        if (this.syncQueued) {
            this.syncQueued = false;
            await this.sync(false);
        }
    }

    /** True when the results tab is the visible tab of the active group. */
    private isActiveTab(): boolean {
        const target = ResultsDocumentProvider.uri.toString();
        const input = vscode.window.tabGroups.activeTabGroup?.activeTab?.input;
        return input instanceof vscode.TabInputText && input.uri.toString() === target;
    }

    /** Brings an already-open results tab to the front without moving keyboard focus. */
    private async surface(): Promise<void> {
        try {
            const document = await vscode.workspace.openTextDocument(ResultsDocumentProvider.uri);
            await vscode.window.showTextDocument(document, { preview: false, preserveFocus: true });
        } catch {
            /* the tab went away between the check and the call */
        }
    }

    /**
     * Scrolls the results tab to a specific hit and selects that line. Called when
     * the pointer rests on a result in the sidebar; the selection is a plain text
     * selection (so it looks native and can be copied), it stays until another
     * result is hovered, and it cannot refill the search box: selections from this
     * document are ignored by Auto Search.
     */
    public reveal(file: string, line: number): void {
        const target = this.matchLines.get(file + ':' + line);
        if (target === undefined) return;

        const editor = vscode.window.visibleTextEditors.find(
            candidate => candidate.document.uri.toString() === ResultsDocumentProvider.uri.toString()
        );
        if (!editor) return;
        if (target < 0 || target >= editor.document.lineCount) return;

        const range = editor.document.lineAt(target).range;
        editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
        editor.selection = new vscode.Selection(range.start, range.end);
    }

    /** Drops the hover selection when the document is rewritten, so it cannot go stale. */
    private resetSelection(): void {
        for (const editor of vscode.window.visibleTextEditors) {
            if (editor.document.uri.scheme !== ResultsDocumentProvider.scheme) continue;
            const start = new vscode.Position(0, 0);
            editor.selection = new vscode.Selection(start, start);
        }
    }

    /** Called whenever the panel produces new results or changes its layout. */
    public async refresh(): Promise<void> {
        if (!this.isOpen()) return;
        if (this.building) {
            this.rebuildQueued = true;
            return;
        }

        const snapshot = this.getSnapshot();
        if (!snapshot) return;

        this.building = true;
        try {
            this.provider.setText(await this.render(snapshot));
            // New content means any hover selection now points at a different line.
            this.resetSelection();
        } catch {
            /* a failed rebuild leaves the previous content in place */
        } finally {
            this.building = false;
            if (this.rebuildQueued) {
                this.rebuildQueued = false;
                void this.refresh();
            }
        }
    }

    private async ensureLanguage(document: vscode.TextDocument): Promise<void> {
        if (document.languageId === SEARCH_RESULT_LANGUAGE) return;
        try {
            await vscode.languages.setTextDocumentLanguage(document, SEARCH_RESULT_LANGUAGE);
        } catch {
            /* keep whatever language the host picked */
        }
    }

    private async render(snapshot: ResultsSnapshot): Promise<string> {
        const startedAt = Date.now();
        let filesRead = 0;
        const configured = vscode.workspace.getConfiguration('fastIndex').get<number>('resultContextLines');
        const radius = Math.max(0, Math.min(50, Math.round(typeof configured === 'number' ? configured : 2)));

        const rows = this.groupRows(snapshot.rows as ResultRow[]);
        const cache = new Map<string, string[]>();
        const readSource = async (file: string): Promise<string[]> => {
            const cached = cache.get(file);
            if (cached) return cached;

            let lines: string[] = [];
            try {
                // Prefer a live buffer (unsaved edits must show up), but never call
                // openTextDocument just to read a few context lines: that loads the file
                // into the document model and hands it to every language server for the
                // workspace, which costs far more than reading it from disk.
                const open = vscode.workspace.textDocuments.find(document => document.uri.fsPath === file);
                const text = open ? open.getText() : await fs.promises.readFile(file, 'utf8');
                lines = text.split('\n');
                filesRead++;
            } catch {
                lines = [];
            }
            cache.set(file, lines);
            return lines;
        };

        const built = await buildResultsText(snapshot, rows, radius, readSource);
        this.matchLines = built.matchLines;
        log(`results render ${rows.length} rows from ${filesRead} files in ${Date.now() - startedAt} ms`);
        return built.text;
    }

    /** One contiguous block per file; tree mode also sorts the blocks like the sidebar. */
    private groupRows(rows: ResultRow[]): ResultRow[] {
        if (this.getViewMode() === 'tree') return orderRowsDepthFirst(rows);

        const groups = new Map<string, ResultRow[]>();
        for (const row of rows) {
            const key = labelForFile(row.file);
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key)!.push(row);
        }

        const ordered: ResultRow[] = [];
        for (const group of groups.values()) ordered.push(...group);
        return ordered;
    }

    /**
     * A single click on a file or result line peeks into this editor, which is
     * exactly what the search editor does (`singleClickBehavior: peekDefinition`).
     * The peek itself is a real editor, so it gets the real language support.
     */
    private onSelection(event: vscode.TextEditorSelectionChangeEvent): void {
        const { textEditor, selections, kind } = event;
        if (textEditor.document.uri.scheme !== ResultsDocumentProvider.scheme) return;
        if (kind !== vscode.TextEditorSelectionChangeKind.Mouse) return;
        if (selections.length !== 1 || !selections[0].isEmpty) return;

        const line = selections[0].active.line;
        if (line >= textEditor.document.lineCount) return;
        const text = textEditor.document.lineAt(line).text;
        if (!FILE_LINE.test(text) && !RESULT_LINE.test(text)) return;

        // A double click delivers two selection changes; peek once.
        const now = Date.now();
        if (this.lastPeek && this.lastPeek.line === line &&
            this.lastPeek.version === textEditor.document.version && now - this.lastPeek.at < 400) return;
        this.lastPeek = { line, version: textEditor.document.version, at: now };

        void vscode.commands.executeCommand('editor.action.peekDefinition');
    }

    public dispose(): void {
        this.disposables.forEach(disposable => disposable.dispose());
        this.disposables.length = 0;
    }
}


