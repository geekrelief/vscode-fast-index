/**
 * Binary detection for the two places a file can enter the index (the build worker
 * and the in-memory replacement path). Indexed binaries are pure noise: their
 * trigrams cost memory, their "lines" are gibberish, and they match queries for
 * strings that happen to sit in a compiled symbol table (a `.dll` that mentions a
 * tool name).
 *
 * VS Code sniffs the first 8 KB to keep opening a file cheap, but the indexer has
 * already read the whole file, so this scans all of it: a binary with a long text
 * prologue would otherwise slip past the sniff. A NUL byte is a reliable marker —
 * C0 control characters alone are not, because source files legitimately contain
 * tabs and newlines, and only text formats such as UTF-16 use NUL bytes, which the
 * indexer could not read as UTF-8 anyway.
 */
export function isBinaryContent(content: string | Uint8Array): boolean {
    if (typeof content === 'string') {
        // A native single-code-unit scan over the whole buffer, not just a prefix.
        return content.indexOf('\u0000') !== -1;
    }
    for (let i = 0; i < content.length; i++) {
        if (content[i] === 0) return true;
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
