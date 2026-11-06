import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

const BACKSLASH = String.fromCharCode(92);

/** Strips line and block comments plus trailing commas so theme files parse. */
export function stripJsonc(text: string): string {
    let out = '';
    let inString = false;
    let inLine = false;
    let inBlock = false;

    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        const next = text[i + 1];

        if (inString) {
            out += ch;
            if (ch === BACKSLASH) {
                out += text[++i] ?? '';
            } else if (ch === '"') {
                inString = false;
            }
            continue;
        }
        if (inLine) {
            if (ch === '\n') {
                inLine = false;
                out += ch;
            }
            continue;
        }
        if (inBlock) {
            if (ch === '*' && next === '/') {
                inBlock = false;
                i++;
            }
            continue;
        }
        if (ch === '"') {
            inString = true;
            out += ch;
            continue;
        }
        if (ch === '/' && next === '/') {
            inLine = true;
            i++;
            continue;
        }
        if (ch === '/' && next === '*') {
            inBlock = true;
            i++;
            continue;
        }
        out += ch;
    }

    return out.replace(/,(\s*[}\]])/g, '$1');
}

/**
 * Reads the active colour theme's token colours so previews can match the editor.
 * Returns a map of preview category -> hex colour; anything undefined keeps the default.
 */
export function readThemeTokenColors(): Record<string, string> | undefined {
    const wanted = vscode.workspace.getConfiguration('workbench').get<string>('colorTheme');
    if (!wanted) return undefined;

    let themePath: string | undefined;
    for (const extension of vscode.extensions.all) {
        const themes = extension.packageJSON?.contributes?.themes;
        if (!Array.isArray(themes)) continue;
        for (const theme of themes) {
            if (theme.id === wanted || theme.label === wanted) {
                themePath = path.join(extension.extensionPath, theme.path);
                break;
            }
        }
        if (themePath) break;
    }
    if (!themePath || !fs.existsSync(themePath)) return undefined;

    const rules: any[] = [];
    const load = (file: string, depth: number): void => {
        if (depth > 5) return;
        let json: any;
        try {
            json = JSON.parse(stripJsonc(fs.readFileSync(file, 'utf-8')));
        } catch {
            return;
        }
        if (typeof json.include === 'string') {
            load(path.resolve(path.dirname(file), json.include), depth + 1);
        }
        if (Array.isArray(json.tokenColors)) rules.push(...json.tokenColors);
    };
    load(themePath, 0);

    // Most specific first: a preprocessor directive is not a plain keyword, etc.
    const categories: { name: string; prefixes: string[] }[] = [
        { name: 'preproc', prefixes: ['keyword.control.directive', 'meta.preprocessor'] },
        { name: 'call', prefixes: ['entity.name.function', 'support.function', 'variable.function', 'meta.function-call'] },
        { name: 'type', prefixes: ['entity.name.type', 'support.type', 'entity.name.class', 'support.class', 'storage.type'] },
        { name: 'comment', prefixes: ['comment'] },
        { name: 'string', prefixes: ['string'] },
        { name: 'number', prefixes: ['constant.numeric'] },
        { name: 'keyword', prefixes: ['keyword'] }
    ];

    const categoryForScope = (scope: string): string | undefined => {
        for (const category of categories) {
            for (const prefix of category.prefixes) {
                if (scope === prefix || scope.startsWith(prefix + '.')) return category.name;
            }
        }
        return undefined;
    };

    const best: Record<string, { score: number; color: string }> = {};
    for (const rule of rules) {
        const settings = rule && rule.settings;
        if (!settings || typeof settings.foreground !== 'string') continue;
        const scopes: string[] = typeof rule.scope === 'string'
            ? rule.scope.split(',')
            : Array.isArray(rule.scope) ? rule.scope : [];

        for (const raw of scopes) {
            const scope = String(raw).trim();
            if (!scope || scope.startsWith('-')) continue;
            const name = categoryForScope(scope);
            if (!name) continue;
            const score = scope.split('.').length;
            if (!best[name] || score >= best[name].score) {
                best[name] = { score, color: settings.foreground };
            }
        }
    }

    const result: Record<string, string> = {};
    for (const name of Object.keys(best)) result[name] = best[name].color;
    return result;
}
