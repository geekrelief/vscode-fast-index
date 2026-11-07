'use strict';
/**
 * Builds a real segment for an existing index's file list, using the production
 * extractor from src/trigrams.ts (compiled to out/trigrams.js).
 *
 * File order and the file table are taken from the baseline segment, so file ids
 * line up and the two indexes can be compared query by query.
 *
 *   node bench/build-index.js --baseline=...v4.bin --out=...v5.bin
 */

const fs = require('fs');
const { loadSegment, writeSegmentFile } = require('./segment-tools');
const { computeTrigrams } = require('../out/trigrams');

const argv = process.argv.slice(2);
const opt = (n, d) => {
    const hit = argv.find((a) => a.startsWith(`--${n}=`));
    return hit ? hit.slice(n.length + 3) : d;
};

const BASELINE = opt('baseline', '');
const OUT = opt('out', '');
const MAX_FILE_BYTES = Number(opt('maxkb', '512')) * 1024;
const EXTRACTOR = opt('extractor', 'whole-text');

/** The previous selection: words of 3+ letters, trigrams inside each word. */
function wordTrigrams(text) {
    const trigrams = new Set();
    const words = text.split(/\W+/).filter((word) => word.length >= 3);
    for (const word of words) {
        const lower = word.toLowerCase();
        for (let i = 0; i <= lower.length - 3; i++) trigrams.add(lower.substring(i, i + 3));
    }
    return Array.from(trigrams);
}

const extract = EXTRACTOR === 'words' ? wordTrigrams : computeTrigrams;
if (!BASELINE || !OUT) {
    console.error('usage: node bench/build-index.js --baseline=<v4.bin> --out=<v5.bin>');
    process.exit(2);
}

const base = loadSegment(BASELINE);
console.log(`baseline: ${base.root}`);
console.log(`  ${base.paths.length.toLocaleString()} files, ${base.terms.length.toLocaleString()} terms`);

// term -> array of file ids, in file order
const postings = new Map();
let read = 0;
let skipped = 0;
let bytes = 0;
const started = Date.now();

for (let fi = 0; fi < base.paths.length; fi++) {
    let text;
    try {
        const stat = fs.statSync(base.paths[fi]);
        if (stat.size > MAX_FILE_BYTES) {
            skipped++;
            continue;
        }
        text = fs.readFileSync(base.paths[fi], 'utf8');
    } catch {
        skipped++;
        continue;
    }
    bytes += text.length;
    for (const term of extract(text)) {
        let list = postings.get(term);
        if (!list) postings.set(term, (list = []));
        list.push(fi);
    }
    read++;
    if (read % 20000 === 0) {
        const mb = (process.memoryUsage().heapUsed / 1048576).toFixed(0);
        console.log(`  ${read.toLocaleString()} files, ${(bytes / 1048576).toFixed(0)} MB text, heap ${mb} MB`);
    }
}

const buildSeconds = (Date.now() - started) / 1000;
const terms = [...postings.keys()];
let postingCount = 0;
for (const list of postings.values()) postingCount += list.length;
console.log(
    `built in ${buildSeconds.toFixed(1)}s: ${read.toLocaleString()} files read (${skipped} skipped), ` +
        `${(bytes / 1048576).toFixed(0)} MB text, ${terms.length.toLocaleString()} terms, ${postingCount.toLocaleString()} postings`
);

const writeStarted = Date.now();
const written = writeSegmentFile(OUT, {
    magic: 'VFI5',
    version: 5,
    root: base.root,
    paths: base.paths,
    mtimes: base.mtimes,
    sizes: base.sizes,
    terms,
    getPostings: (i) => postings.get(terms[i]),
});
const writeSeconds = (Date.now() - writeStarted) / 1000;

console.log(
    `wrote ${OUT}\n  ${(written.gzBytes / 1048576).toFixed(1)} MB gzip, ${(written.rawBytes / 1048576).toFixed(1)} MB raw, ` +
        `${(written.blobBytes / 1048576).toFixed(1)} MB blob, ${writeSeconds.toFixed(1)}s`
);

fs.writeFileSync(
    OUT + '.stats.json',
    JSON.stringify(
        {
            root: base.root,
            files: base.paths.length,
            filesRead: read,
            skipped,
            textBytes: bytes,
            terms: terms.length,
            postings: postingCount,
            buildSeconds,
            writeSeconds,
            gzBytes: written.gzBytes,
            rawBytes: written.rawBytes,
            blobBytes: written.blobBytes,
        },
        null,
        2
    )
);

