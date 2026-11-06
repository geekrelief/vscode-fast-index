import * as vscode from 'vscode';
import { readThemeTokenColors } from './theme';
import type { ResultsDocument } from './ResultsDocumentProvider';

/**
 * Token categories the highlighter understands. The names line up with the
 * categories `readThemeTokenColors` extracts from the active colour theme, so a
 * result line is painted with the same colours it has in the editor.
 */
export type TokenKind = 'preproc' | 'call' | 'type' | 'comment' | 'string' | 'number' | 'keyword';

export interface Token {
    start: number;
    end: number;
    kind: TokenKind;
}

export type Language = 'cpp' | 'csharp' | 'python' | 'javascript' | 'generic';

const KEYWORDS: Record<Language, string[]> = {
    cpp: [
        'alignas', 'alignof', 'auto', 'bool', 'break', 'case', 'catch', 'char', 'char8_t', 'char16_t', 'char32_t',
        'class', 'concept', 'const', 'consteval', 'constexpr', 'constinit', 'const_cast', 'continue', 'co_await',
        'co_return', 'co_yield', 'decltype', 'default', 'delete', 'do', 'double', 'dynamic_cast', 'else', 'enum',
        'explicit', 'export', 'extern', 'false', 'final', 'float', 'for', 'friend', 'goto', 'if', 'inline', 'int',
        'long', 'mutable', 'namespace', 'new', 'noexcept', 'nullptr', 'operator', 'override', 'private', 'protected',
        'public', 'register', 'reinterpret_cast', 'requires', 'return', 'short', 'signed', 'sizeof', 'static',
        'static_assert', 'static_cast', 'struct', 'switch', 'template', 'this', 'thread_local', 'throw', 'true',
        'try', 'typedef', 'typeid', 'typename', 'union', 'unsigned', 'using', 'virtual', 'void', 'volatile',
        'wchar_t', 'while'
    ],
    csharp: [
        'abstract', 'as', 'async', 'await', 'base', 'bool', 'break', 'byte', 'case', 'catch', 'char', 'checked',
        'class', 'const', 'continue', 'decimal', 'default', 'delegate', 'do', 'double', 'else', 'enum', 'event',
        'explicit', 'extern', 'false', 'finally', 'fixed', 'float', 'for', 'foreach', 'get', 'goto', 'if',
        'implicit', 'in', 'int', 'interface', 'internal', 'is', 'lock', 'long', 'nameof', 'namespace', 'new', 'null',
        'object', 'operator', 'out', 'override', 'params', 'partial', 'private', 'protected', 'public', 'readonly',
        'record', 'ref', 'return', 'sbyte', 'sealed', 'set', 'short', 'sizeof', 'stackalloc', 'static', 'string',
        'struct', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'uint', 'ulong', 'unchecked', 'unsafe',
        'ushort', 'using', 'value', 'var', 'virtual', 'void', 'volatile', 'when', 'where', 'while', 'yield'
    ],
    python: [
        'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del', 'elif', 'else',
        'except', 'False', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'None',
        'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'True', 'try', 'while', 'with', 'yield', 'self', 'match'
    ],
    javascript: [
        'as', 'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'declare',
        'default', 'delete', 'do', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'for', 'from',
        'function', 'get', 'if', 'implements', 'import', 'in', 'instanceof', 'interface', 'keyof', 'let', 'namespace',
        'new', 'null', 'of', 'package', 'private', 'protected', 'public', 'readonly', 'return', 'set', 'static',
        'super', 'switch', 'this', 'throw', 'true', 'try', 'type', 'typeof', 'undefined', 'var', 'void', 'while',
        'with', 'yield'
    ],
    generic: [
        'and', 'as', 'begin', 'break', 'case', 'class', 'const', 'continue', 'def', 'do', 'else', 'elseif', 'end',
        'enum', 'false', 'for', 'foreach', 'function', 'if', 'import', 'in', 'let', 'new', 'not', 'null', 'or',
        'return', 'static', 'struct', 'switch', 'then', 'true', 'try', 'var', 'while'
    ]
};

const KEYWORD_SETS = new Map<Language, Set<string>>(
    (Object.keys(KEYWORDS) as Language[]).map(language => [language, new Set(KEYWORDS[language])])
);

const CPP_EXTENSIONS = new Set([
    'c', 'cc', 'cp', 'cpp', 'cxx', 'c++', 'h', 'hh', 'hpp', 'hxx', 'h++', 'inl', 'ipp', 'tpp', 'm', 'mm', 'cu', 'cuh'
]);

/** Picks the tokenizer for a file, from its extension. */
export function languageFor(file: string): Language {
    const match = /\.([^./\\]+)$/.exec(String(file || ''));
    const ext = match ? match[1].toLowerCase() : '';
    if (CPP_EXTENSIONS.has(ext)) return 'cpp';
    if (ext === 'cs' || ext === 'csx') return 'csharp';
    if (ext === 'py' || ext === 'pyi' || ext === 'pyw') return 'python';
    if (ext === 'js' || ext === 'jsx' || ext === 'mjs' || ext === 'cjs' ||
        ext === 'ts' || ext === 'tsx' || ext === 'mts' || ext === 'cts') return 'javascript';
    return 'generic';
}

const isIdentStart = (ch: string): boolean => /[A-Za-z_$]/.test(ch);
const isIdentPart = (ch: string): boolean => /[A-Za-z0-9_$]/.test(ch);

/**
 * A deliberately small single-line lexer: enough to colour keywords, literals,
 * comments, calls and type names the way the editor does, without pulling in a
 * full TextMate grammar for every language a user might have in the index.
 */
export function tokenizeLine(text: string, language: Language): Token[] {
    const tokens: Token[] = [];
    const keywords = KEYWORD_SETS.get(language) ?? KEYWORD_SETS.get('generic')!;
    const push = (start: number, end: number, kind: TokenKind): void => {
        if (end > start) tokens.push({ start, end, kind });
    };

    let i = 0;
    const length = text.length;

    // Preprocessor directives occupy the whole directive word (#include, #define, #if…).
    const directive = /^\s*#\s*[A-Za-z_]\w*/.exec(text);
    if (directive && language !== 'python') {
        const start = text.indexOf('#', directive.index);
        push(start, directive.index + directive[0].length, 'preproc');
        i = directive.index + directive[0].length;
    }

    while (i < length) {
        const ch = text[i];
        const next = text[i + 1];

        if (ch === '/' && next === '/') {
            push(i, length, 'comment');
            break;
        }
        if (ch === '/' && next === '*') {
            const close = text.indexOf('*/', i + 2);
            const end = close < 0 ? length : close + 2;
            push(i, end, 'comment');
            i = end;
            continue;
        }
        if (ch === '#' && (language === 'python' || language === 'generic')) {
            push(i, length, 'comment');
            break;
        }
        if (ch === '"' || ch === "'" || ch === '`') {
            let end = i + 1;
            while (end < length) {
                if (text[end] === '\\') {
                    end += 2;
                    continue;
                }
                if (text[end] === ch) {
                    end++;
                    break;
                }
                end++;
            }
            end = Math.min(end, length);
            push(i, end, 'string');
            i = end;
            continue;
        }
        if (ch >= '0' && ch <= '9') {
            let end = i + 1;
            while (end < length && /[0-9A-Za-z_.']/.test(text[end])) end++;
            push(i, end, 'number');
            i = end;
            continue;
        }
        if (isIdentStart(ch)) {
            let end = i + 1;
            while (end < length && isIdentPart(text[end])) end++;
            const word = text.slice(i, end);
            if (keywords.has(word)) {
                push(i, end, 'keyword');
            } else {
                let probe = end;
                while (probe < length && /\s/.test(text[probe])) probe++;
                if (text[probe] === '(') push(i, end, 'call');
                else if (/^[A-Z][A-Za-z0-9_]*$/.test(word)) push(i, end, 'type');
            }
            i = end;
            continue;
        }

        i++;
    }

    return tokens;
}

/** Escapes a plain-text query for use inside a RegExp. */
const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Paints the results document: token colours come from the active theme (the
 * same extraction the preview panel uses), and matches get the editor's own
 * find-match colours, so the tab follows the theme like any real editor.
 */
export class ResultsDecorator implements vscode.Disposable {
    private theme: Record<string, string> = {};
    private kinds = new Map<TokenKind, vscode.TextEditorDecorationType>();
    private matchText: vscode.TextEditorDecorationType;
    private matchLine: vscode.TextEditorDecorationType;

    public constructor() {
        this.matchText = this.createMatchText();
        this.matchLine = this.createMatchLine();
        this.applyTheme();
    }

    private createMatchText(): vscode.TextEditorDecorationType {
        return vscode.window.createTextEditorDecorationType({
            backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
            borderRadius: '2px'
        });
    }

    private createMatchLine(): vscode.TextEditorDecorationType {
        return vscode.window.createTextEditorDecorationType({
            isWholeLine: true,
            borderColor: new vscode.ThemeColor('editor.findMatchBorder'),
            borderWidth: '0 0 0 2px',
            borderStyle: 'solid'
        });
    }

    /** Re-reads the theme and rebuilds the token decoration types. */
    public applyTheme(): void {
        for (const type of this.kinds.values()) type.dispose();
        this.kinds.clear();

        this.theme = readThemeTokenColors() ?? {};
        for (const kind of Object.keys(this.theme) as TokenKind[]) {
            const color = this.theme[kind];
            if (!color) continue;
            try {
                this.kinds.set(kind, vscode.window.createTextEditorDecorationType({ color }));
            } catch {
                /* unsupported colour: leave that category at the default */
            }
        }

        this.matchText.dispose();
        this.matchLine.dispose();
        this.matchText = this.createMatchText();
        this.matchLine = this.createMatchLine();
    }

    /** Colours one results editor: tokens, match text and match-line accents. */
    public decorate(editor: vscode.TextEditor, model: ResultsDocument): void {
        const document = editor.document;
        if (document.uri.scheme !== 'fast-index-results') return;

        const buckets = new Map<TokenKind, vscode.Range[]>();
        for (const kind of this.kinds.keys()) buckets.set(kind, []);
        const matchRanges: vscode.Range[] = [];
        const lineRanges: vscode.Range[] = [];
        const query = this.buildQuery(model);

        const limit = Math.min(document.lineCount, model.lines.length);
        for (let index = 0; index < limit; index++) {
            const info = model.lines[index];
            if (!info) continue;

            if (info.match) {
                lineRanges.push(document.lineAt(index).range);
                if (query) {
                    query.lastIndex = 0;
                    let found: RegExpExecArray | null;
                    while ((found = query.exec(info.text)) !== null) {
                        if (found[0].length === 0) {
                            query.lastIndex++;
                            continue;
                        }
                        matchRanges.push(new vscode.Range(
                            index, info.offset + found.index,
                            index, info.offset + found.index + found[0].length
                        ));
                    }
                }
            }

            for (const token of tokenizeLine(info.text, languageFor(info.file))) {
                const ranges = buckets.get(token.kind);
                if (!ranges) continue;
                ranges.push(new vscode.Range(index, info.offset + token.start, index, info.offset + token.end));
            }
        }

        for (const [kind, type] of this.kinds) {
            editor.setDecorations(type, buckets.get(kind) ?? []);
        }
        editor.setDecorations(this.matchText, matchRanges);
        editor.setDecorations(this.matchLine, lineRanges);
    }

    private buildQuery(model: ResultsDocument): RegExp | undefined {
        const query = String(model.query || '');
        if (!query) return undefined;
        const flags = 'g' + (model.isMatchCase ? '' : 'i');
        try {
            return new RegExp(model.isRegex ? query : escapeRegExp(query), flags);
        } catch {
            return undefined;
        }
    }

    public dispose(): void {
        for (const type of this.kinds.values()) type.dispose();
        this.kinds.clear();
        this.matchText.dispose();
        this.matchLine.dispose();
    }
}
