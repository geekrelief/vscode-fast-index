import * as vscode from 'vscode';
import * as fs from 'fs';
import { readThemeTokenColors } from './theme';

export interface PreviewPayload {
    file: string;
    fileName: string;
    line: number;
    start: number;
    lines: string[];
    query: string;
    isRegex: boolean;
    isMatchCase: boolean;
}

/**
 * Read-only preview docked in the bottom panel (next to the terminal), kept in sync
 * with whatever search result the sidebar is resting on.
 */
export class PreviewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'fast-index-preview';

    private view: vscode.WebviewView | undefined;
    private last: PreviewPayload | undefined;

    constructor(private readonly _extensionUri: vscode.Uri) {}

    public resolveWebviewView(view: vscode.WebviewView): void {
        this.view = view;
        view.webview.options = { enableScripts: true, localResourceRoots: [this._extensionUri] };
        view.webview.html = this.buildHtml();

        const subscription = view.webview.onDidReceiveMessage(message => {
            if (message?.type === 'ready') {
                this.publishTheme();
                this.publishEditorStyle();
                if (this.last) this.post(this.last);
                return;
            }
            if (message?.type === 'openFile' && message.value?.file) {
                void this.openFile(String(message.value.file), Number(message.value.line) || 0);
            }
        });

        const configWatcher = vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration('editor')) this.publishEditorStyle();
            if (event.affectsConfiguration('workbench.colorTheme')) this.publishTheme();
        });

        view.onDidDispose(() => {
            subscription.dispose();
            configWatcher.dispose();
            this.view = undefined;
        });
    }

    /** Called whenever the sidebar previews a result. */
    public async show(file: string, line: number, query = '', isRegex = false, isMatchCase = false): Promise<void> {
        if (!this.view) return; // panel not open: nothing to draw into
        const payload = await this.readContext(file, line);
        if (payload) {
            payload.query = query;
            payload.isRegex = isRegex;
            payload.isMatchCase = isMatchCase;
        }
        if (!payload) return;
        this.last = payload;
        this.post(payload);
    }

    private post(payload: PreviewPayload): void {
        void this.view?.webview.postMessage({ type: 'preview', value: payload });
    }

    public publishEditorStyle(): void {
        const editor = vscode.workspace.getConfiguration('editor');
        const lineHeight = editor.get<number>('lineHeight') ?? 0;
        void this.view?.webview.postMessage({ type: 'editorStyle', value: { lineHeight } });
    }

    public publishTheme(): void {
        const colors = readThemeTokenColors();
        if (colors && Object.keys(colors).length > 0) {
            void this.view?.webview.postMessage({ type: 'tokens', value: colors });
        }
    }

    private async readContext(file: string, line: number): Promise<PreviewPayload | undefined> {
        const configured = vscode.workspace.getConfiguration('fastIndex').get<number>('previewContextLines');
        const radius = Math.max(0, Math.min(50, Math.round(typeof configured === 'number' ? configured : 2)));
        try {
            const open = vscode.workspace.textDocuments.find(document => document.uri.fsPath === file);
            const document = open ?? await vscode.workspace.openTextDocument(vscode.Uri.file(file));
            const all = document.getText().split('\n');
            const start = Math.max(0, line - radius);
            const end = Math.min(all.length, line + radius + 1);
            return {
                file,
                fileName: vscode.workspace.asRelativePath(file),
                line,
                start,
                lines: all.slice(start, end),
                query: '',
                isRegex: false,
                isMatchCase: false
            };
        } catch {
            return undefined;
        }
    }

    private async openFile(file: string, line: number): Promise<void> {
        try {
            const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
            const editor = await vscode.window.showTextDocument(document, { preview: true });
            const position = new vscode.Position(Math.max(0, line), 0);
            editor.selection = new vscode.Selection(position, position);
            editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
        } catch {
            /* file may have moved */
        }
    }

    private buildHtml(): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
    html, body { height: 100%; margin: 0; }
    body {
        display: flex;
        flex-direction: column;
        box-sizing: border-box;
        background: var(--vscode-editor-background);
        color: var(--vscode-editor-foreground);
        font-family: var(--vscode-editor-font-family, monospace);
        font-size: var(--vscode-editor-font-size, 12px);
        font-weight: var(--vscode-editor-font-weight, normal);
        line-height: var(--editor-line-height, var(--vscode-editor-line-height, 1.5));
        tab-size: 4;
        overflow: hidden;
    }
    ::selection { background: var(--vscode-editor-selectionBackground); color: var(--vscode-editor-selectionForeground, inherit); }
    ::-webkit-scrollbar { width: 10px; height: 10px; }
    ::-webkit-scrollbar-thumb { background: var(--vscode-scrollbarSlider-background); }
    ::-webkit-scrollbar-thumb:hover { background: var(--vscode-scrollbarSlider-hoverBackground); }
    ::-webkit-scrollbar-thumb:active { background: var(--vscode-scrollbarSlider-activeBackground); }
    ::-webkit-scrollbar-track { background: transparent; }
    .head {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 3px 10px;
        background: var(--vscode-editorGroupHeader-tabsBackground, var(--vscode-editor-background));
        border-bottom: 1px solid var(--vscode-editorWidget-border, var(--vscode-widget-border));
        font-family: var(--vscode-font-family);
        font-size: 0.85em;
        flex: 0 0 auto;
    }
    .title { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .hint { opacity: 0.5; white-space: nowrap; }
    .body { flex: 1 1 auto; overflow: auto; padding: 2px 0 6px 0; min-height: 0; }
    .empty { opacity: 0.6; padding: 8px 12px; }
    .line { display: flex; white-space: pre; cursor: pointer; }
    .line:hover { background: var(--vscode-editor-lineHighlightBackground, var(--vscode-list-hoverBackground)); }
    .lineno {
        flex: 0 0 auto;
        padding: 0 12px 0 12px;
        text-align: right;
        color: var(--vscode-editorLineNumber-foreground, var(--vscode-editor-foreground));
        opacity: 0.9;
        user-select: none;
        border-right: 1px solid var(--vscode-editorWidget-border, transparent);
        margin-right: 12px;
        background: var(--vscode-editorGutter-background, transparent);
    }
    .line.match .lineno { color: var(--vscode-editorLineNumber-activeForeground, var(--vscode-editor-foreground)); }
    .hit {
        background: var(--vscode-editor-findMatchHighlightBackground, rgba(234,92,0,0.33));
        border-radius: 3px;
        box-shadow: inset 0 -2px 0 var(--vscode-editorCursor-foreground, #4fc1ff);
    }
    /* Some themes define a find highlight almost identical to the editor background;
       blend the cursor colour in so the term stays visible. */
    @supports (background: color-mix(in srgb, red 50%, transparent)) {
        .hit { background: color-mix(in srgb, var(--vscode-editorCursor-foreground, #4fc1ff) 30%, transparent); }
    }
    .line.match .lineno { font-weight: bold; }
    body { --tok-keyword: #569cd6; --tok-type: #4ec9b0; --tok-string: #ce9178; --tok-number: #b5cea8; --tok-comment: #6a9955; --tok-call: #dcdcaa; --tok-preproc: #c586c0; }
    body.vscode-light { --tok-keyword: #0000ff; --tok-type: #267f99; --tok-string: #a31515; --tok-number: #098658; --tok-comment: #008000; --tok-call: #795e26; --tok-preproc: #af00db; }
    .tok-keyword { color: var(--tok-keyword); }
    .tok-type { color: var(--tok-type); }
    .tok-string { color: var(--tok-string); }
    .tok-number { color: var(--tok-number); }
    .tok-comment { color: var(--tok-comment); font-style: italic; }
    .tok-call { color: var(--tok-call); }
    .tok-preproc { color: var(--tok-preproc); }
</style>
</head>
<body>
    <div class="head">
        <span class="title" id="title">Fast Index Preview</span>
        <span class="hint">read-only · click a line to open it</span>
    </div>
    <div class="body" id="body">
        <div class="empty">Rest the pointer on a search result to preview it here.</div>
    </div>
    <script>
        const vscode = acquireVsCodeApi();
        const titleEl = document.getElementById('title');
        const bodyEl = document.getElementById('body');

        const BACKSLASH = String.fromCharCode(92);
        const CPP_KEYWORDS = new Set(('alignas alignof auto bool break case catch char class const constexpr continue default delete do double else enum explicit export extern false float for friend goto if inline int long mutable namespace new noexcept nullptr operator override private protected public register return short signed sizeof static static_cast struct switch template this throw true try typedef typename union unsigned using virtual void volatile while const_cast dynamic_cast reinterpret_cast').split(' '));
        const PY_KEYWORDS = new Set(('and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield True False None').split(' '));

        function languageFor(fileName) {
            const lower = String(fileName || '').toLowerCase();
            if (lower.endsWith('.py')) return 'python';
            if (/\\.(c|cc|cpp|cxx|h|hh|hpp|hxx|inl|cs|m|mm)$/.test(lower)) return 'c';
            return 'plain';
        }

        function isIdentStart(ch) {
            return (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || ch === '_';
        }

        function isIdentPart(ch) {
            return isIdentStart(ch) || (ch >= '0' && ch <= '9');
        }

        function tokenizeLines(lines, language) {
            if (language === 'plain') return lines.map(function (line) { return [[line, '']]; });
            const keywords = language === 'python' ? PY_KEYWORDS : CPP_KEYWORDS;
            const result = [];
            let inBlock = false;

            lines.forEach(function (line) {
                const tokens = [];
                let i = 0;

                while (i < line.length) {
                    const ch = line[i];

                    if (inBlock) {
                        const close = line.indexOf('*/', i);
                        if (close < 0) {
                            tokens.push([line.slice(i), 'comment']);
                            i = line.length;
                        } else {
                            tokens.push([line.slice(i, close + 2), 'comment']);
                            i = close + 2;
                            inBlock = false;
                        }
                        continue;
                    }
                    if (ch === '/' && line[i + 1] === '/') {
                        tokens.push([line.slice(i), 'comment']);
                        break;
                    }
                    if (language === 'python' && ch === '#') {
                        tokens.push([line.slice(i), 'comment']);
                        break;
                    }
                    if (ch === '/' && line[i + 1] === '*') {
                        const close = line.indexOf('*/', i + 2);
                        if (close < 0) {
                            tokens.push([line.slice(i), 'comment']);
                            inBlock = true;
                            i = line.length;
                        } else {
                            tokens.push([line.slice(i, close + 2), 'comment']);
                            i = close + 2;
                        }
                        continue;
                    }
                    if (ch === '"' || ch === "'") {
                        let j = i + 1;
                        while (j < line.length) {
                            if (line[j] === BACKSLASH) { j += 2; continue; }
                            if (line[j] === ch) { j++; break; }
                            j++;
                        }
                        tokens.push([line.slice(i, j), 'string']);
                        i = j;
                        continue;
                    }
                    if (language === 'c' && ch === '#' && tokens.length === 0) {
                        let j = i + 1;
                        while (j < line.length && line[j] === ' ') j++;
                        while (j < line.length && isIdentPart(line[j])) j++;
                        tokens.push([line.slice(i, j), 'preproc']);
                        i = j;
                        continue;
                    }
                    if (ch >= '0' && ch <= '9') {
                        let j = i + 1;
                        while (j < line.length && (isIdentPart(line[j]) || line[j] === '.')) j++;
                        tokens.push([line.slice(i, j), 'number']);
                        i = j;
                        continue;
                    }
                    if (isIdentStart(ch)) {
                        let j = i + 1;
                        while (j < line.length && isIdentPart(line[j])) j++;
                        const word = line.slice(i, j);
                        let k = j;
                        while (k < line.length && line[k] === ' ') k++;
                        let cls = '';
                        if (keywords.has(word)) cls = 'keyword';
                        else if (word[0] >= 'A' && word[0] <= 'Z') cls = 'type';
                        else if (line[k] === '(') cls = 'call';
                        tokens.push([word, cls]);
                        i = j;
                        continue;
                    }

                    tokens.push([ch, '']);
                    i += 1;
                }

                result.push(tokens);
            });

            return result;
        }

        function matchRanges(text, query, isRegex, isMatchCase) {
            if (!query) return [];
            try {
                if (isRegex) {
                    const re = new RegExp(query, isMatchCase ? 'g' : 'gi');
                    const found = [];
                    let m;
                    while ((m = re.exec(text)) !== null) {
                        if (m[0].length === 0) { re.lastIndex++; continue; }
                        found.push([m.index, m.index + m[0].length]);
                    }
                    return found;
                }
            } catch { /* bad regex: fall back to a literal search */ }

            const haystack = isMatchCase ? text : text.toLowerCase();
            const needle = isMatchCase ? query : query.toLowerCase();
            if (!needle) return [];
            const found = [];
            let at = haystack.indexOf(needle);
            while (at >= 0) {
                found.push([at, at + needle.length]);
                at = haystack.indexOf(needle, at + needle.length);
            }
            return found;
        }

        /** Wraps every range in a <span class="hit">, splitting the existing spans. */
        function wrapMatches(container, ranges) {
            if (!ranges || ranges.length === 0) return;

            const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
            const nodes = [];
            let offset = 0;
            while (walker.nextNode()) {
                nodes.push({ node: walker.currentNode, start: offset });
                offset += walker.currentNode.data.length;
            }

            nodes.forEach(function (entry) {
                const node = entry.node;
                const start = entry.start;
                const end = start + node.data.length;
                const hits = ranges.filter(function (range) { return range[0] < end && range[1] > start; });
                if (hits.length === 0) return;

                const fragment = document.createDocumentFragment();
                let cursor = start;

                hits.forEach(function (range) {
                    const from = Math.max(range[0], start);
                    const to = Math.min(range[1], end);
                    if (from > cursor) fragment.appendChild(document.createTextNode(node.data.slice(cursor - start, from - start)));
                    const mark = document.createElement('span');
                    mark.className = 'hit';
                    mark.textContent = node.data.slice(from - start, to - start);
                    fragment.appendChild(mark);
                    cursor = to;
                });

                if (cursor < end) fragment.appendChild(document.createTextNode(node.data.slice(cursor - start)));
                node.parentNode.replaceChild(fragment, node);
            });
        }

        let current = null;

        function render(value) {
            current = value;
            titleEl.textContent = value.fileName + ' : ' + (value.line + 1);

            const normalized = value.lines.map(function (text) { return String(text).replace(/\\t/g, '    '); });
            const tokenized = tokenizeLines(normalized, languageFor(value.fileName));

            bodyEl.innerHTML = '';
            normalized.forEach(function (text, index) {
                const lineNumber = value.start + index;
                const row = document.createElement('div');
                row.className = 'line' + (lineNumber === value.line ? ' match' : '');

                const label = document.createElement('span');
                label.className = 'lineno';
                label.textContent = String(lineNumber + 1);

                const code = document.createElement('span');
                (tokenized[index] || []).forEach(function (pair) {
                    const span = document.createElement('span');
                    if (pair[1]) span.className = 'tok-' + pair[1];
                    span.textContent = pair[0];
                    code.appendChild(span);
                });

                if (lineNumber === value.line && value.query) {
                    wrapMatches(code, matchRanges(code.textContent, value.query, value.isRegex, value.isMatchCase));
                }

                row.appendChild(label);
                row.appendChild(code);
                row.onclick = function () {
                    // Open at the clicked line, like the editor would.
                    vscode.postMessage({ type: 'openFile', value: { file: value.file, line: lineNumber } });
                };
                bodyEl.appendChild(row);
            });

            const matched = bodyEl.querySelector('.line.match');
            if (matched && matched.scrollIntoView) matched.scrollIntoView({ block: 'center' });
        }

        window.addEventListener('message', function (event) {
            const message = event.data;
            if (message.type === 'preview') {
                render(message.value);
            } else if (message.type === 'editorStyle') {
                const lineHeight = Number(message.value && message.value.lineHeight);
                if (Number.isFinite(lineHeight) && lineHeight > 0) {
                    document.body.style.setProperty('--editor-line-height', lineHeight + 'px');
                }
            } else if (message.type === 'tokens') {
                const colors = message.value || {};
                Object.keys(colors).forEach(function (key) {
                    const color = colors[key];
                    if (typeof color !== 'string' || color.charAt(0) !== '#') return;
                    const argb = /^#([0-9a-f]{6})([0-9a-f]{2})$/i.exec(color);
                    if (argb && parseInt(argb[2], 16) < 16) return;
                    document.body.style.setProperty('--tok-' + key, color);
                });
            }
        });

        vscode.postMessage({ type: 'ready' });
    </script>
</body>
</html>`;
    }
}
