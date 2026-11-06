/** Trigram extraction shared by the indexer and its worker thread (no vscode import here). */
export function computeTrigrams(text: string): string[] {
    const trigrams = new Set<string>();
    const words = text.split(/\W+/).filter(word => word.length >= 3);
    for (const word of words) {
        const lowerWord = word.toLowerCase();
        for (let i = 0; i <= lowerWord.length - 3; i++) {
            trigrams.add(lowerWord.substring(i, i + 3));
        }
    }
    return Array.from(trigrams);
}
