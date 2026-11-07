'use strict';
/**
 * Turns a run-bench JSON result into the tables used in the evaluation report,
 * including the extrapolation to a full Unreal Engine tree.
 *
 *   node bench/summarize.js bench/mid-ue57-all.json
 */

const fs = require('fs');
const file = process.argv[2] || 'bench/mid-ue57-all.json';
const data = JSON.parse(fs.readFileSync(file, 'utf8'));
const { results, gzipFactor, files, corpusBytes } = data;
const srcMB = corpusBytes / 1048576;
const ORDER = ['triWords', 'triRaw', 'sparse8', 'sparse16'].filter((k) => data.results[k]);
const NAMES = {
    triWords: 'trigram, word-split (shipping)',
    triRaw: 'trigram, whole text',
    sparse8: 'sparse n-grams, n=3..8',
    sparse16: 'sparse n-grams, n=3..16',
};
const TABLE_GZIP = { triWords: 0.31, triRaw: 0.28, sparse8: 0.22, sparse16: 0.2 };

const size = {};
for (const key of ORDER) {
    const r = results[key];
    const gzBlob = r.blob * gzipFactor[key];
    const gzTables = (r.indexTable + r.termTable) * (TABLE_GZIP[key] || 0.45);
    size[key] = { terms: r.terms, postings: r.postings, blob: r.blob, gzBlob, gzTables, total: gzBlob + gzTables };
}

const base = results.triWords.perQuery;
const keep = (q) => q.cat !== 'regex'; // regex cannot be pruned: identical for every scheme
const qs = base.filter(keep);
const cats = [...new Set(qs.map((q) => q.cat))];
const med = (a) => {
    const s = a.slice().sort((x, y) => x - y);
    return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const idx = base.map((q, i) => (keep(q) ? i : -1)).filter((i) => i >= 0);

console.log(`corpus: ${files.toLocaleString()} files, ${srcMB.toFixed(1)} MB of source\n`);

console.log('=== MB read to fill the 50-result list, by category ===');
console.log('category'.padEnd(12) + ORDER.map((k) => k.padStart(12)).join(''));
for (const cat of cats) {
    const row = ORDER.map((k) => {
        const sum = results[k].perQuery.filter((q) => q.cat === cat).reduce((a, q) => a + q.readMB, 0);
        return sum.toFixed(1).padStart(12);
    });
    console.log(cat.padEnd(12) + row.join(''));
}

console.log('\n=== per query: candidates / MB read / postings decoded ===');
console.log('query'.padEnd(26) + ORDER.map((k) => k.padStart(28)).join(''));
for (const i of idx) {
    const cells = ORDER.map((k) => {
        const q = results[k].perQuery[i];
        const flag = q.missing ? '!' : q.complete ? ' ' : '+';
        return `${q.candidates}${flag}/${q.readMB.toFixed(1)}/${q.postings}`.padStart(28);
    });
    console.log(base[i].query.padEnd(26) + cells.join(''));
}

console.log('\n=== summary over the non-regex queries ===');
const baseTotal = idx.reduce((a, i) => a + base[i].readMB, 0);
for (const k of ORDER) {
    const readTotal = idx.reduce((a, i) => a + results[k].perQuery[i].readMB, 0);
    const readRatios = [];
    const candRatios = [];
    const postRatios = [];
    for (const i of idx) {
        const q = results[k].perQuery[i];
        const b = base[i];
        if (q.readMB > 0 && b.readMB > 0) readRatios.push(q.readMB / b.readMB);
        if (q.candidates > 0 && b.candidates > 0) candRatios.push(q.candidates / b.candidates);
        if (q.postings > 0 && b.postings > 0) postRatios.push(q.postings / b.postings);
    }
    console.log(
        `${NAMES[k].padEnd(34)} read total ${(readTotal / baseTotal).toFixed(2)}x median ${med(readRatios).toFixed(2)}x` +
            ` | candidates median ${med(candRatios).toFixed(2)}x` +
            ` | postings median ${med(postRatios).toFixed(2)}x`
    );
}

console.log('\n=== index size and scale-out ===');
console.log(
    'scheme'.padEnd(34) +
        'terms'.padStart(12) +
        'postings'.padStart(13) +
        'MB'.padStart(8) +
        'per src MB'.padStart(12) +
        'UE 638 MB'.padStart(11) +
        'UE 2.5 GB'.padStart(11)
);
for (const k of ORDER) {
    const s = size[k];
    const perMB = s.total / 1048576 / srcMB;
    console.log(
        NAMES[k].padEnd(34) +
            s.terms.toLocaleString().padStart(12) +
            s.postings.toLocaleString().padStart(13) +
            (s.total / 1048576).toFixed(1).padStart(8) +
            perMB.toFixed(4).padStart(12) +
            (perMB * 638).toFixed(0).padStart(11) +
            (perMB * 2500).toFixed(0).padStart(11)
    );
}

