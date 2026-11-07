/**
 * Trigram extraction shared by the indexer and its worker thread (no vscode import here).
 *
 * A term is every 3-character window of the text, lowercased — punctuation and
 * whitespace included, so "for (int" is pruned as the phrase it is instead of as
 * "a file containing for and int".
 *
 * Windows holding a non-ASCII character are skipped. The segment stores each term
 * as three ASCII bytes, and writing a wider character there would silently mangle
 * it into a term the query can never look up. Both sides skip the same windows, so
 * a query that occurs in a file still yields only windows that file also yields.
 */

const ASCII_MAX = 127;

function asciiWindow(text: string, i: number): boolean {
    return text.charCodeAt(i) <= ASCII_MAX
        && text.charCodeAt(i + 1) <= ASCII_MAX
        && text.charCodeAt(i + 2) <= ASCII_MAX;
}

/** Distinct trigrams of a document, as stored in the index. */
export function computeTrigrams(text: string): string[] {
    const lower = text.toLowerCase();
    const trigrams = new Set<string>();
    for (let i = 0; i + 3 <= lower.length; i++) {
        if (asciiWindow(lower, i)) trigrams.add(lower.substring(i, i + 3));
    }
    return Array.from(trigrams);
}

/**
 * Trigram windows of a query, in order and with duplicates kept, selected exactly
 * like computeTrigrams. Duplicates are intentional: the caller uses the count to
 * tell "every trigram of the query exists somewhere" from "some are absent".
 */
export function queryTrigrams(query: string): string[] {
    const lower = query.toLowerCase();
    const windows: string[] = [];
    for (let i = 0; i + 3 <= lower.length; i++) {
        if (asciiWindow(lower, i)) windows.push(lower.substring(i, i + 3));
    }
    return windows;
}
