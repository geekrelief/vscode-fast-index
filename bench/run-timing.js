'use strict';
/**
 * Build-throughput comparison: how fast each extractor turns source text into
 * per-file term sets, which is what the indexer worker does for every file.
 *
 *   node bench/run-timing.js --corpus=... --files=1500
 */

const fs = require('fs');
const path = require('path');
const G = require('./ngrams');

const argv = process.argv.slice(2);
const opt = (n, d) => {
    const hit = argv.find((a) => a.startsWith(`--${n}=`));
    return hit ? hit.slice(n.length + 3) : d;
};
const CORPUS = opt('corpus', 'D:\\Epic Games\\UE_5.7\\Engine\\Source');
const SAMPLE = Number(opt('files', '1500'));
const SKIP_EXT = new Set(['.png', '.jpg', '.svg', '.uasset', '.umap', '.dll', '.lib', '.exe', '.bin']);
const SKIP_DIR = new Set(['binaries', 'intermediate', 'deriveddatacache', 'saved', '.git', 'content']);

function walk(dir, out, limit) {
    if (out.length >= limit) return;
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return;
    }
    for (const e of entries) {
        if (out.length >= limit) return;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
            if (!SKIP_DIR.has(e.name.toLowerCase())) walk(p, out, limit);
        } else if (e.isFile() && !SKIP_EXT.has(path.extname(e.name).toLowerCase())) {
            const st = fs.statSync(p);
            if (st.size > 0 && st.size <= 512 * 1024) out.push(p);
        }
    }
}

const paths = [];
walk(CORPUS, paths, SAMPLE);
const texts = [];
let bytes = 0;
for (const p of paths) {
    try {
        const t = fs.readFileSync(p, 'utf8').toLowerCase();
        texts.push(t);
        bytes += t.length;
    } catch {
        /* skip */
    }
}
const mb = bytes / 1048576;
console.log(`sample: ${texts.length} files, ${mb.toFixed(1)} MB of text\n`);

const SCHEMES = [
    { key: 'trigramsExact (shipping, strings)', fn: (t) => new Set(G.trigramsExact(t)) },
    { key: 'trigram words (hashed ids)', fn: (t) => collect(G.trigramsWords, t) },
    { key: 'trigram whole text', fn: (t) => collect(G.trigramsRaw, t) },
    { key: 'sparse n=3..8', fn: (t) => collect((x, add) => G.sparseIndex(x, 8, add), t) },
    { key: 'sparse n=3..16', fn: (t) => collect((x, add) => G.sparseIndex(x, 16, add), t) },
];

function collect(extract, text) {
    const set = new Set();
    extract(text, (t) => set.add(t));
    return set;
}

const rows = [];
for (const s of SCHEMES) {
    // warm up, then best of three
    for (let i = 0; i < Math.min(50, texts.length); i++) s.fn(texts[i]);
    let best = Infinity;
    let terms = 0;
    for (let rep = 0; rep < 3; rep++) {
        const started = process.hrtime.bigint();
        let n = 0;
        for (let i = 0; i < texts.length; i++) n += s.fn(texts[i]).size;
        const ms = Number(process.hrtime.bigint() - started) / 1e6;
        if (ms < best) {
            best = ms;
            terms = n;
        }
    }
    rows.push({ key: s.key, ms: best, mbps: mb / (best / 1000), termsPerKb: terms / (bytes / 1024) });
    console.log(
        `${s.key.padEnd(38)} ${best.toFixed(0).padStart(6)} ms   ${(mb / (best / 1000)).toFixed(1).padStart(6)} MB/s   ${(
            terms /
            (bytes / 1024)
        ).toFixed(1)} terms/KB`
    );
}

const base = rows[0].ms;
console.log(`\nrelative to the shipping extractor:`);
for (const r of rows) console.log(`  ${(r.ms / base).toFixed(2)}x  ${r.key}`);

// extrapolation to a UE-sized tree
const SRC_GB = Number(opt('gb', '2.5'));
console.log(`\nextrapolated single-threaded build for ${SRC_GB} GB of source:`);
for (const r of rows) {
    const seconds = (SRC_GB * 1024) / r.mbps;
    console.log(`  ${(seconds / 60).toFixed(1)} min  ${r.key}`);
}
