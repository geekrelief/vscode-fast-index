import * as vscode from 'vscode';
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

    private isOpen(): boolean {
        const target = ResultsDocumentProvider.uri.toString();
        return vscode.workspace.textDocuments.some(document => document.uri.toString() === target);
    }

    /** Opens the results tab, or brings the existing one forward. */
    public async open(): Promise<void> {
        const snapshot = this.getSnapshot();
        if (!snapshot || snapshot.rows.length === 0) {
            vscode.window.showInformationMessage('Fast Index: run a search first.');
            return;
        }

        this.provider.setText(await this.render(snapshot));

        const document = await vscode.workspace.openTextDocument(ResultsDocumentProvider.uri);
        await this.ensureLanguage(document);
        await vscode.window.showTextDocument(document, { preview: false });
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
        const configured = vscode.workspace.getConfiguration('fastIndex').get<number>('previewContextLines');
        const radius = Math.max(0, Math.min(50, Math.round(typeof configured === 'number' ? configured : 2)));

        const rows = this.groupRows(snapshot.rows as ResultRow[]);
        const cache = new Map<string, string[]>();
        const readSource = async (file: string): Promise<string[]> => {
            const cached = cache.get(file);
            if (cached) return cached;

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

        return buildResultsText(snapshot, rows, radius, readSource);
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
     * exactly what the search editor does (`singleClickBehaviour: peekDefinition`).
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
