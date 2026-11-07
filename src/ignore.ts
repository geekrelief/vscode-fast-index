/**
 * Reads `.gitignore`-style files so an existing ignore list can drive indexing
 * instead of being retyped as globs in `fastIndex.excludePatterns`.
 *
 * The supported syntax is the documented gitignore subset that matters in
 * practice: blank lines and `#` comments, `!` negation, a trailing `/` for
 * directories only, a leading `/` (or any inner `/`) for patterns anchored at
 * the workspace folder, and `*` / `?` / `**` / `[...]` wildcards. Matching uses
 * gitignore's last-match-wins order, so `!` works exactly as it does for git.
 *
 * Two consumers share one rule set:
 *   - `matches(relativePath)`: the authoritative filter (build-time and watcher).
 *   - `toGlobs()`:            a coarse glob list for `findFiles`, which prunes
 *                             ignored folders before they are ever walked.
 */
import * as path from 'path';

export interface IgnoreRule {
    /** The line as written, for diagnostics. */
    source: string;
    /** Matches the folder-relative, slash-separated path (and anything under it). */
    regex: RegExp;
    negated: boolean;
}

export interface IgnoreFileStats {
    /** Absolute path of the file that was read. */
    file: string;
    /** False when the file is missing or unreadable. */
    exists: boolean;
    /** Rules that filter (negations included). */
    rules: number;
    /** `!` rules, which re-include instead of ignoring. */
    negations: number;
    error?: string;
}

/** Windows and macOS treat paths case-insensitively, so patterns must too. */
const IGNORE_CASE = process.platform === 'win32' || process.platform === 'darwin';

const escapeRegex = (value: string): string => value.replace(/[.+^${}()|[\]\\]/g, '\\$&');

/**
 * Turns one gitignore pattern into a regex over a folder-relative path.
 * The trailing `(?:/.*)?` lets a rule that names a directory also cover
 * everything inside it, which is what gitignore does for both `dir` and `dir/`.
 */
function toRegex(pattern: string, anchored: boolean): RegExp {
    let body = '';
    let i = 0;
    while (i < pattern.length) {
        const char = pattern[i];
        if (char === '*') {
            if (pattern[i + 1] === '*') {
                // "**/" also matches zero segments, so "**/foo" finds a root-level foo.
                if (pattern[i + 2] === '/') {
                    body += '(?:.*/)?';
                    i += 3;
                    continue;
                }
                body += '.*';
                i += 2;
                continue;
            }
            body += '[^/]*';
            i++;
            continue;
        }
        if (char === '?') {
            body += '[^/]';
            i++;
            continue;
        }
        if (char === '[') {
            const close = pattern.indexOf(']', i + 1);
            if (close > i) {
                let cls = pattern.slice(i + 1, close);
                // gitignore uses '!' to negate a class; JavaScript uses '^'.
                if (cls.startsWith('!')) cls = '^' + cls.slice(1);
                body += '[' + cls.replace(/\\/g, '\\\\') + ']';
                i = close + 1;
                continue;
            }
        }
        if (char === '\\' && i + 1 < pattern.length) {
            body += escapeRegex(pattern[i + 1]);
            i += 2;
            continue;
        }
        body += escapeRegex(char);
        i++;
    }

    if (!anchored) body = '(?:.*/)?' + body;
    return new RegExp('^' + body + '(?:/.*)?$', IGNORE_CASE ? 'i' : '');
}

/**
 * Parses the text of one ignore file. Order is preserved because negations are
 * resolved from the last matching rule backwards.
 */
export function parseIgnoreRules(text: string): IgnoreRule[] {
    const rules: IgnoreRule[] = [];
    for (const rawLine of text.split(/\r?\n/)) {
        let line = rawLine.trim();
        if (!line) continue;
        if (line.startsWith('#')) continue;
        // A trailing " #comment" is not a comment in gitignore: only whole lines are.

        let negated = false;
        if (line.startsWith('!')) {
            negated = true;
            line = line.slice(1).trim();
            if (!line) continue;
        } else if (line.startsWith('\\!') || line.startsWith('\\#')) {
            line = line.slice(1);
        }

        // A leading slash anchors the pattern to the folder; a trailing slash only
        // means "directory" (the regex already covers a directory's descendants).
        let anchored = false;
        if (line.startsWith('/')) {
            anchored = true;
            line = line.slice(1);
        }
        if (line.endsWith('/')) line = line.replace(/\/+$/, '');
        if (line.includes('/')) anchored = true;
        if (!line) continue;

        rules.push({ source: rawLine.trim(), regex: toRegex(line, anchored), negated });
    }
    return rules;
}

/** The rules of one or more ignore files, resolved in order (later files win). */
export class IgnoreRules {
    public readonly rules: IgnoreRule[];

    public constructor(rules: IgnoreRule[] = []) {
        this.rules = rules;
    }

    public get size(): number {
        return this.rules.length;
    }

    public get negations(): number {
        return this.rules.reduce((count, rule) => count + (rule.negated ? 1 : 0), 0);
    }

    public get isEmpty(): boolean {
        return this.rules.length === 0;
    }

    /** True when the folder-relative path is ignored. Last matching rule wins. */
    public matches(relativePath: string): boolean {
        if (this.rules.length === 0) return false;
        const candidate = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
        for (let i = this.rules.length - 1; i >= 0; i--) {
            const rule = this.rules[i];
            if (rule.regex.test(candidate)) return !rule.negated;
        }
        return false;
    }

    /**
     * Glob equivalents for `findFiles`, which can only exclude, never re-include.
     * Negated rules are deliberately left out: their effect is applied by
     * `matches`, and git itself does not re-include files inside an ignored folder.
     */
    public toGlobs(): string[] {
        const globs: string[] = [];
        const seen = new Set<string>();
        for (const rule of this.rules) {
            if (rule.negated) continue;
            let body = rule.source.replace(/\\/g, '/');
            if (body.startsWith('!')) continue;
            const anchoredBySlash = body.startsWith('/');
            if (anchoredBySlash) body = body.slice(1);
            const directory = body.endsWith('/');
            body = body.replace(/\/+$/, '').replace(/\/\*\*$/, '');
            if (!body) continue;
            // Braces and commas would break the single brace-glob findFiles takes.
            if (/[{}]/.test(body)) continue;

            const anchored = anchoredBySlash || body.includes('/');
            const glob = anchored ? body : '**/' + body;
            const candidates = directory ? [glob + '/**', glob] : [glob];
            for (const candidate of candidates) {
                if (seen.has(candidate)) continue;
                seen.add(candidate);
                globs.push(candidate);
            }
        }
        return globs;
    }
}

// Joins globs onto a VS Code exclude glob such as "{**/node_modules/**,**/*.dll}".
export function mergeExcludeGlobs(existing: string | undefined, globs: string[]): string {
    const base = (existing ?? '').trim();
    if (globs.length === 0) return base;

    const parts: string[] = [];
    if (base) {
        const inner = base.startsWith('{') && base.endsWith('}') ? base.slice(1, -1) : base;
        for (const part of inner.split(',')) {
            const trimmed = part.trim();
            if (trimmed) parts.push(trimmed);
        }
    }
    for (const glob of globs) {
        if (!parts.includes(glob)) parts.push(glob);
    }
    return '{' + parts.join(',') + '}';
}

/** Splits the `fastIndex.ignoreFiles` setting into folder-relative or absolute paths. */
export function splitIgnoreFiles(value: string | undefined): string[] {
    return String(value ?? '')
        .split(',')
        .map(entry => entry.trim())
        .filter(Boolean);
}

/** Resolves one configured entry against a workspace folder (absolute stays absolute). */
export function resolveIgnoreFile(folder: string, entry: string): string {
    const normalized = entry.replace(/\\/g, '/');
    return path.isAbsolute(normalized) ? normalized : path.join(folder, normalized);
}
