import * as vscode from 'vscode';
import {
    ResultRow,
    ResultsDocument,
    ResultsDocumentProvider,
    ResultsLinkProvider,
    ResultsSnapshot,
    buildResultsDocument,
    orderRowsDepthFirst
} from './ResultsDocumentProvider';
import { ResultsDecorator } from './syntax';

const PEEK_COMMAND = ResultsLinkProvider.peekCommand;

/**
 * The results tab: a read-only editor that mirrors whatever the sidebar is
 * currently showing. The sidebar owns the query and the filters, so the tab is
 * refreshed in place instead of being rebuilt from a stale snapshot.
 */
export class ResultsView implements vscode.Disposable {
    private readonly provider = new ResultsDocumentProvider();
    private readonly decorator = new ResultsDecorator();
    private readonly disposables: vscode.Disposable[] = [];
    private building = false;
    private rebuildQueued = false;
    private decorateTimer?: ReturnType<typeof setTimeout>;
    private lastPeek?: { key: string; at: number };

    public constructor(
        private readonly getSnapshot: () => ResultsSnapshot | undefined,
        private readonly getViewMode: () => 'tree' | 'flat'
    ) {}

    public register(): vscode.Disposable[] {
        this.disposables.push(
            this.provider,
            vscode.workspace.registerTextDocumentContentProvider(ResultsDocumentProvider.scheme, this.provider),
            vscode.languages.registerDocumentLinkProvider(
                { scheme: ResultsDocumentProvider.scheme },
                new ResultsLinkProvider(() => this.provider.current())
            ),
            vscode.commands.registerCommand(PEEK_COMMAND, (file: string, line: number) => this.peek(file, line)),
            vscode.commands.registerCommand('vscode-fast-index.openResultsInEditor', () => this.open()),
            vscode.window.onDidChangeTextEditorSelection(event => this.onSelection(event)),
            vscode.window.onDidChangeActiveTextEditor(editor => this.decorateEditor(editor)),
            vscode.workspace.onDidChangeTextDocument(event => {
                if (event.document.uri.scheme === ResultsDocumentProvider.scheme) this.scheduleDecorate();
            }),
            vscode.workspace.onDidChangeConfiguration(event => {
                if (!event.affectsConfiguration('workbench.colorTheme')) return;
                this.decorator.applyTheme();
                this.scheduleDecorate(50);
            }),
            { dispose: () => this.decorator.dispose() }
        );
        return this.disposables;
    }

    /** True once the results tab has been opened at least once this session. */
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

        const model = await this.build(snapshot);
        this.provider.setResults(model);

        const document = await vscode.workspace.openTextDocument(ResultsDocumentProvider.uri);
        const editor = await vscode.window.showTextDocument(document, { preview: false });
        this.decorator.decorate(editor, model);
        this.revealFirstMatch(editor, model);
    }

    /**
     * Called whenever the sidebar produces new results. Only an open tab is
     * rebuilt; an unopened one is built on demand by `open`.
     */
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
            const model = await this.build(snapshot);
            this.provider.setResults(model);
            this.scheduleDecorate(0);
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

    private async build(snapshot: ResultsSnapshot): Promise<ResultsDocument> {
        const configured = vscode.workspace.getConfiguration('fastIndex').get<number>('previewContextLines');
        const radius = Math.max(0, Math.min(50, Math.round(typeof configured === 'number' ? configured : 2)));

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

        return buildResultsDocument(
            snapshot,
            snapshot.rows as ResultRow[],
            radius,
            this.getViewMode() === 'tree',
            orderRowsDepthFirst,
            readSource
        );
    }

    private scheduleDecorate(delay = 0): void {
        if (this.decorateTimer) clearTimeout(this.decorateTimer);
        this.decorateTimer = setTimeout(() => {
            this.decorateTimer = undefined;
            for (const editor of vscode.window.visibleTextEditors) this.decorateEditor(editor);
        }, delay);
    }

    private decorateEditor(editor: vscode.TextEditor | undefined): void {
        if (!editor) return;
        if (editor.document.uri.scheme !== ResultsDocumentProvider.scheme) return;
        const model = this.provider.current();
        if (!model) return;
        this.decorator.decorate(editor, model);
    }

    /** Puts the caret on the first hit so the tab opens ready to work. */
    private revealFirstMatch(editor: vscode.TextEditor, model: ResultsDocument): void {
        const index = model.lines.findIndex(info => info && info.match);
        if (index < 0) return;
        const info = model.lines[index]!;
        const position = new vscode.Position(index, info.offset);
        editor.selection = new vscode.Selection(position, position);
        editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    }

    /**
     * A plain click on a hit opens a peek at the source line, the way the native
     * search editor does; Ctrl+Click on the same line follows the document link.
     */
    private onSelection(event: vscode.TextEditorSelectionChangeEvent): void {
        if (event.textEditor.document.uri.scheme !== ResultsDocumentProvider.scheme) return;
        if (event.kind !== vscode.TextEditorSelectionChangeKind.Mouse) return;
        if (event.selections.length !== 1 || !event.selections[0].isEmpty) return;

        const line = event.selections[0].active.line;
        const info = this.provider.lineAt(event.textEditor.document.uri, line);
        if (!info || !info.match) return;

        const key = info.file + ':' + info.line;
        const now = Date.now();
        if (this.lastPeek && this.lastPeek.key === key && now - this.lastPeek.at < 400) return;
        this.lastPeek = { key, at: now };

        void this.peek(info.file, info.line);
    }

    private async peek(file: string, line: number): Promise<void> {
        if (!file) return;
        let uri: vscode.Uri;
        try {
            uri = vscode.Uri.file(file);
        } catch {
            return;
        }

        const position = new vscode.Position(Math.max(0, Number(line) || 0), 0);
        const location = new vscode.Location(uri, position);

        // Peek first; fall back to a normal open when the host has no peek widget.
        for (const command of ['editor.action.peekLocations', 'editor.action.showReferences']) {
            try {
                await vscode.commands.executeCommand(command, uri, position, [location], 'peek');
                return;
            } catch {
                /* try the next strategy */
            }
        }

        try {
            const document = await vscode.workspace.openTextDocument(uri);
            const editor = await vscode.window.showTextDocument(document, { preview: true });
            editor.selection = new vscode.Selection(position, position);
            editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
        } catch {
            vscode.window.showInformationMessage('Fast Index: could not open ' + file);
        }
    }

    public dispose(): void {
        if (this.decorateTimer) clearTimeout(this.decorateTimer);
        this.disposables.forEach(disposable => disposable.dispose());
        this.disposables.length = 0;
    }
}
