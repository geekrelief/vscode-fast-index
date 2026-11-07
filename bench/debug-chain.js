'use strict';
// Checks the query chain against the published worked example and prints chains
// for a few real needles, using the span-reporting index walk.
const G = require('./ngrams');

function gramsWithSpans(s, maxLen) {
    const out = [];
    G.indexGramsSpans(s, maxLen, (start, end) => out.push([start, end, s.slice(start, end)]));
    return out;
}

function chain(s, maxLen) {
    const out = [];
    const n = s.length;
    if (n < 3) return out;
    const maxEnd = new Uint16Array(n);
    G.indexGramsSpans(s, maxLen, (start, end) => {
        if (end > maxEnd[start]) maxEnd[start] = end;
    });
    let p = 0;
    while (p + 3 <= n) {
        const end = maxEnd[p] || p + 3;
        out.push(s.slice(p, end));
        p = end;
    }
    return out;
}

console.log('--- published example: "for(int i=42" (blog: for(i, (int i=4, =42) ---');
console.log('index grams:', gramsWithSpans('for(int i=42', 16).map((g) => g[2]).join(' '));
console.log('chain:', chain('for(int i=42', 16));

console.log('\n--- real needles ---');
for (const q of [
    'getactorlocation',
    'busecontrollerrotationyaw',
    'tweakobjectptr',
    'getworld()->gettimer',
    'for (int',
    'uproperty(editanywhere',
    '#include "coreminimal.h"',
]) {
    const c = chain(q, 16);
    console.log(`${q}  (${q.length} chars)  -> ${c.length} grams: ${c.map((g) => JSON.stringify(g)).join(' ')}`);
}
