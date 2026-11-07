'use strict';
/**
 * Compares two real segments: a baseline (word-split trigrams) and a candidate
 * (whole-text trigrams), built from the same file list in the same order.
 *
 *   node bench/compare-real-index.js --baseline=<v4> --candidate=<v5>
 *
 * Reports, per query, surviving candidates / MB read to fill the 50-result list /
 * postings decoded, and checks end to end that a file containing a needle is
 * never pruned by the candidate index.
 */

const fs = require('fs');
const { loadSegment, postings } = require('./segment-tools');
const { queryTrigrams } = require('../out/trigrams');
const QUERIES = require('./queries');

const argv = process.argv.slice(2);
const opt = (n, d) => {
    const hit = argv.find((a) => a.startsWith(`--${n}=`));
    return hit ? hit.slice(n.length + 3) : d;
};
const BASELINE = opt('baseline', '');
const CANDIDATE = opt('candidate', '');
const MAX_RESULTS = 50;
const PER_FILE_LIMIT = 3;

const base = loadSegment(BASELINE);
const cand = loadSegment(CANDIDATE);
if (base.paths.length !== cand.paths.length) throw new Error('file tables differ');

const lc = (s) => s.toLowerCase();
const baseIndex = new Map(base.terms.map((t, i) => [t, i]));
const candIndex = new Map(cand.terms.map((t, i) => [t, i]));

function baseQueryTerms(q) {
    const out = [];
    for (const word of lc(q).split(/\W+/).filter((w) => w.length >= 3)) {
        for (let i = 0; i + 3 <= word.length; i++) out.push(word.substring(i, i + 3));
    }
    return out;
}

function intersect(listA, listB) {
    let i = 0;
    let j = 0;
    const out = [];
    while (i < listA.length && j < listB.length) {
        const a = listA[i];
        const b = listB[j];
        if (a === b) {
            out.push(a);
            i++;
            j++;
        } else if (a < b) i++;
        else j++;
    }
    return out;
}

/** Candidates survive when every query term has a posting list containing them. */
function candidatesFor(segment, index, terms) {
    const ids = terms.map((t) => index.get(t)).filter((i) => i !== undefined);
    if (terms.length === 0 || ids.length !== terms.length) return null; // no pruning possible
    if (ids.length === 0) return [];
    const lists = ids.map((i) => postings(segment, i)).sort((a, b) => a.length - b.length);
    let acc = lists[0];
    for (let k = 1; k < lists.length && acc.length; k++) acc = intersect(acc, lists[k]);
    return acc;
}

function baseName(p) {
    const slash = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
    return slash >= 0 ? p.slice(slash + 1) : p;
}

function fileNameRank(filePath, query) {
    const lowerQuery = query.toLowerCase();
    if (lowerQuery.includes('/') || lowerQuery.includes('\\')) {
        const q = lowerQuery.replace(/\\/g, '/').replace(/^\/+/, '');
        const p = filePath.replace(/\\/g, '/').toLowerCase();
        if (p === q || p.endsWith('/' + q)) return 0;
        if (p.endsWith(q)) return 2;
        return 4;
    }
    const b = baseName(filePath).toLowerCase();
    const dot = b.lastIndexOf('.');
    const stem = dot > 0 ? b.slice(0, dot) : b;
    if (stem === lowerQuery) return 0;
    if (b === lowerQuery) return 1;
    if (stem.startsWith(lowerQuery)) return 2;
    if (b.includes(lowerQuery)) return 3;
    return 4;
}

function countMatches(lower, needle, cap) {
    let n = 0;
    for (let at = lower.indexOf(needle); at >= 0 && n < cap; at = lower.indexOf(needle, at + 1)) n++;
    return n;
}

const names = base.paths.map((p) => baseName(p).toLowerCase());
// The VFI3 migration wrote zeroed mtime/size columns, so trust the filesystem.
const fileSizes = new Uint32Array(base.paths.length);
for (let i = 0; i < base.paths.length; i++) {
    try {
        fileSizes[i] = fs.statSync(base.paths[i]).size || base.sizes[i];
    } catch {
        fileSizes[i] = base.sizes[i];
    }
}
const lowerQueryCache = new Map();

function readMatches(file, needle, id, cache) {
    // one read per file per query, shared by both indexes; the text is not retained
    let count = cache.get(id);
    if (count === undefined) {
        let lower;
        try {
            lower = fs.readFileSync(file, 'utf8').toLowerCase();
        } catch {
            lower = '';
        }
        count = countMatches(lower, needle, PER_FILE_LIMIT);
        cache.set(id, count);
    }
    return count;
}

function simulate(segment, index, query, termLists, matchCache) {
    const lq = lc(query);
    const cands = candidatesFor(segment, index, termLists);
    let postingsUsed = 0;
    for (const t of termLists) {
        const ti = index.get(t);
        if (ti !== undefined) postingsUsed += segment.counts[ti];
    }

    // No pruning: the shipping search() reads every file in filename-rank order.
    const all = cands === null;
    const order = [];
    if (all) {
        for (let id = 0; id < base.paths.length; id++) order.push([fileNameRank(base.paths[id], lq), id]);
    } else {
        const seen = new Set(cands);
        for (const id of cands) order.push([fileNameRank(base.paths[id], lq), id]);
        for (let i = 0; i < names.length; i++) {
            if (!seen.has(i) && names[i].includes(lq)) order.push([fileNameRank(base.paths[i], lq), i]);
        }
    }
    order.sort((a, b) => a[0] - b[0] || a[1] - b[1]);

    let results = 0;
    let bytes = 0;
    let files = 0;
    for (const [rank, id] of order) {
        if (results >= MAX_RESULTS) break;
        bytes += fileSizes[id];
        files++;
        const m = readMatches(base.paths[id], lq, id, matchCache);
        results += Math.min(m, PER_FILE_LIMIT);
        if (m === 0 && rank <= 2) results++;
    }
    return {
        all,
        candidates: all ? base.paths.length : cands.length,
        readMB: bytes / 1048576,
        readFiles: files,
        postings: postingsUsed,
        filled: results >= MAX_RESULTS,
    };
}

// ---------------------------------------------------------------- end-to-end check
// A file that contains a needle must never be pruned by the candidate index.
let verified = 0;
let violations = 0;
const sampleStep = Math.max(1, Math.floor(base.paths.length / 400));
for (let fi = 0; fi < base.paths.length && verified < 400; fi += sampleStep) {
    let text;
    try {
        const stat = fs.statSync(base.paths[fi]);
        if (stat.size > 512 * 1024) continue;
        text = fs.readFileSync(base.paths[fi], 'utf8');
    } catch {
        continue;
    }
    if (text.length < 40) continue;
    const start = Math.floor(Math.random() * (text.length - 20));
    const needle = text.slice(start, start + 12 + Math.floor(Math.random() * 20)).toLowerCase();
    const terms = queryTrigrams(needle);
    if (terms.length === 0) continue;
    const ids = terms.map((t) => candIndex.get(t));
    if (ids.some((i) => i === undefined)) {
        violations++;
        console.log(`  MISSING TERM for ${JSON.stringify(needle)} (${base.paths[fi]})`);
        continue;
    }
    const lists = ids.map((i) => postings(cand, i)).sort((a, b) => a.length - b.length);
    let acc = lists[0];
    for (let k = 1; k < lists.length && acc.length; k++) acc = intersect(acc, lists[k]);
    if (!acc.includes(fi)) {
        violations++;
        console.log(`  PRUNED a matching file for ${JSON.stringify(needle)} (${base.paths[fi]})`);
    }
    verified++;
}

console.log(`end-to-end: ${verified} needles from real files, ${violations} pruned`);

// ---------------------------------------------------------------------- queries
const rows = [];
for (const q of QUERIES) {
    const bTerms = baseQueryTerms(q.q);
    const cTerms = queryTrigrams(lc(q.q));
    const matchCache = new Map();
    const b = simulate(base, baseIndex, q.q, bTerms, matchCache);
    const c = simulate(cand, candIndex, q.q, cTerms, matchCache);
    rows.push({ query: q.q, cat: q.cat, base: b, cand: c });
}

const mb = (x) => x.toFixed(1);
console.log('\nquery                          word-split (today)          whole text (candidate)');
console.log('                               cand    MB   postings        cand    MB   postings');
for (const r of rows) {
    const b = r.base.all ? 'ALL' : String(r.base.candidates);
    const c = r.cand.all ? 'ALL' : String(r.cand.candidates);
    console.log(
        r.query.padEnd(30) +
            b.padStart(7) + mb(r.base.readMB).padStart(6) + String(r.base.postings).padStart(11) +
            c.padStart(12) + mb(r.cand.readMB).padStart(6) + String(r.cand.postings).padStart(11)
    );
}

const median = (a) => {
    const s = a.slice().sort((x, y) => x - y);
    return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const keep = rows.filter((r) => r.cat !== 'regex' && !r.base.all && !r.cand.all);
const readRatios = keep.filter((r) => r.base.readMB > 0).map((r) => r.cand.readMB / r.base.readMB);
const baseTotal = keep.reduce((a, r) => a + r.base.readMB, 0);
const candTotal = keep.reduce((a, r) => a + r.cand.readMB, 0);
console.log(
    `\nnon-regex queries: read total ${(candTotal / baseTotal).toFixed(2)}x, median ${median(readRatios).toFixed(2)}x` +
        ` | postings total ${(keep.reduce((a, r) => a + r.cand.postings, 0) / keep.reduce((a, r) => a + r.base.postings, 0)).toFixed(2)}x`
);

console.log(`\nindex: baseline ${(base.bytesOnDisk / 1048576).toFixed(1)} MB gzip / ${(base.bytesRaw / 1048576).toFixed(1)} MB raw` +
    ` (${base.terms.length.toLocaleString()} terms)`);
console.log(`       candidate ${(cand.bytesOnDisk / 1048576).toFixed(1)} MB gzip / ${(cand.bytesRaw / 1048576).toFixed(1)} MB raw` +
    ` (${cand.terms.length.toLocaleString()} terms)`);

const fsOut = opt('out', '');
if (fsOut) fs.writeFileSync(fsOut, JSON.stringify({ verified, violations, rows }, null, 2));


