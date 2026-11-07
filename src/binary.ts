/**
 * A NUL byte in the first few KB is the same heuristic VS Code itself uses to
 * decide that a file is binary. Indexed binaries are pure noise: their trigrams
 * cost memory, their "lines" are gibberish, and they match queries for strings
 * that happen to sit in a compiled symbol table (a `.dll` mentioning a tool name).
 */
const SNIFF_BYTES = 8192;

export function isBinaryContent(content: string | Uint8Array): boolean {
    const limit = Math.min(content.length, SNIFF_BYTES);
    for (let i = 0; i < limit; i++) {
        const byte = typeof content === 'string' ? content.charCodeAt(i) : content[i];
        if (byte === 0) return true;
    }
    return false;
}

/**
 * Result lines must occupy exactly one line in the results document: a stray
 * carriage return (old-Mac endings, or binary debris) would split the rendered
 * line in two and shift every later `file:line` index by one.
 */
export function toSingleLine(text: string, maxLength = Number.POSITIVE_INFINITY): string {
    const flat = String(text ?? '')
        .replace(/[\r\n\u000B\u000C\u0085\u2028\u2029]+/g, ' ')
        // Other C0 controls (and DEL) render as boxes in the editor.
        .replace(/[\u0000-\u0008\u000E-\u001F\u007F]/g, '');
    return flat.length > maxLength ? flat.slice(0, Math.max(0, maxLength - 1)) + '\u2026' : flat;
}
