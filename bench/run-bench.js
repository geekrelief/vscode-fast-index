'use strict';
/**
 * Measures trigram and sparse n-gram indexing on a real source tree.
 *
 * For every scheme it reports what the index would cost (terms, postings,
 * bytes) and, per query, how many files survive pruning, how many bytes have
 * to be read to fill the result list, and how many postings are decoded.
 *
 *   node bench/run-bench.js --corpus="D:\...\Engine\Source" --limit=5000
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const G = require('./ngrams');
const QUERIES = require('./queries');

// ------------------------------------------------------------------ options
const argv = process.argv.slice(2);
function opt(name, dflt) {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : dflt;
}
const CORPUS = opt('corpus', 'D:\\Epic Games\\UE_5.7\\Engine\\Source');
const LIMIT = Number(opt('limit', '0')) || 0;
const OUT = opt('out', '');
const MAX_FILE_BYTES = 512 * 1024;
const MAX_NGRAM = 16;
const SHORT_NGRAM = 8;
const MAX_RESULTS = 50;
const PER_FILE_LIMIT = 3;

const SKIP_EXT = new Set([
    '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.bmp', '.tga', '.exr', '.wav', '.mp3',
    '.uasset', '.umap', '.dll', '.lib', '.exe', '.pdb', '.obj', '.zip', '.7z', '.gz', '.bin',
    '.ttf', '.otf', '.fbx', '.abc', '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
]);
const SKIP_DIR = new Set([
    'node_modules', '.git', '.svn', '.vs', '.vscode', 'binaries', 'intermediate',
    'deriveddatacache', 'saved', 'content', '.cache', 'out', 'dist',
]);

// ------------------------------------------------------------------- corpus
function walk(dir, out) {
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return;
    }
    for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
            if (!SKIP_DIR.has(e.name.toLowerCase())) walk(p, out);
        } else if (e.isFile()) {
            const ext = path.extname(e.name).toLowerCase();
            if (SKIP_EXT.has(ext)) continue;
            let st;
            try {
                st = fs.statSync(p);
            } catch {
                continue;
            }
            if (st.size === 0 || st.size > MAX_FILE_BYTES) continue;
            out.push({ path: p, size: st.size });
        }
    }
}

// ------------------------------------------- filename ranking (from indexer.ts)
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
    const base = baseName(filePath).toLowerCase();
    const dot = base.lastIndexOf('.');
    const stem = dot > 0 ? base.slice(0, dot) : base;
    if (stem === lowerQuery) return 0;
    if (base === lowerQuery) return 1;
    if (stem.startsWith(lowerQuery)) return 2;
    if (base.includes(lowerQuery)) return 3;
    return 4;
}

// ------------------------------------------------------------------ schemes
const SCHEMES = [
    {
        key: 'triWords',
        label: 'trigram, word-split (shipping)',
        extract: G.trigramsWords,
        query: G.trigramQueryWords,
    },
    {
        key: 'triRaw',
        label: 'trigram, whole text',
        extract: G.trigramsRaw,
        query: G.trigramQueryRaw,
    },
    {
        key: 'sparse8',
        label: `sparse n-grams, n=3..${SHORT_NGRAM}`,
        extract: (t, add) => G.sparseIndex(t, SHORT_NGRAM, add),
        query: (q) => G.sparseQuery(q, SHORT_NGRAM),
    },
    {
        key: 'sparse16',
        label: `sparse n-grams, n=3..${MAX_NGRAM}`,
        extract: (t, add) => G.sparseIndex(t, MAX_NGRAM, add),
        query: (q) => G.sparseQuery(q, MAX_NGRAM),
    },
].filter((s) => !opt('schemes', '') || opt('schemes', '').split(',').includes(s.key));

// ------------------------------------------------------------------- helpers
function varintBytes(v) {
    return v < 0x80 ? 1 : v < 0x4000 ? 2 : v < 0x200000 ? 3 : v < 0x10000000 ? 4 : 5;
}

const FILES = [];
walk(CORPUS, FILES);
FILES.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
const files = LIMIT ? FILES.slice(0, LIMIT) : FILES;
const corpusBytes = files.reduce((s, f) => s + f.size, 0);
console.log(`corpus: ${CORPUS}`);
console.log(`files:  ${files.length.toLocaleString()}  (${(corpusBytes / 1048576).toFixed(1)} MB)\n`);

// query term lists, once
const qLower = QUERIES.map((q) => q.q.toLowerCase());
const qTerms = {};
for (const s of SCHEMES) qTerms[s.key] = qLower.map((q) => (q.length >= 3 ? s.query(q) : []));

// per-scheme accumulators
const stats = {};
for (const s of SCHEMES) {
    stats[s.key] = {
        terms: new Map(), // term id -> df * 2^20 + lastFileId
        postings: 0,
        blobBytes: 0,
        maxDf: 0,
        dfHistogram: new Uint32Array(9), // df >= 2^i
    };
}
const candidates = {}; // scheme -> query index -> { ids: [], matches: [] }
for (const s of SCHEMES) candidates[s.key] = QUERIES.map(() => ({ ids: [], matches: [] }));

// name matches are scheme independent
const nameMatches = QUERIES.map(() => []);
for (let i = 0; i < files.length; i++) {
    const base = baseName(files[i].path).toLowerCase();
    for (let qi = 0; qi < qLower.length; qi++) {
        if (base.includes(qLower[qi])) nameMatches[qi].push(i);
    }
}

// ---------------------------------------------------------------------- pass
const started = Date.now();
let processed = 0;
for (let fi = 0; fi < files.length; fi++) {
    const file = files[fi];
    let text;
    try {
        text = fs.readFileSync(file.path, 'utf8');
    } catch {
        continue;
    }
    const lower = text.toLowerCase();

    for (const s of SCHEMES) {
        const set = new Set();
        s.extract(lower, (t) => set.add(t));
        const st = stats[s.key];

        for (const id of set) {
            st.postings++;
            const packed = st.terms.get(id);
            if (packed === undefined) {
                st.terms.set(id, 0x100000 + fi);
                st.blobBytes += varintBytes(fi);
            } else {
                const last = packed & 0xfffff;
                const df = (packed / 0x100000) | 0;
                st.blobBytes += varintBytes(fi - last);
                st.terms.set(id, (df + 1) * 0x100000 + fi);
            }
        }

        for (let qi = 0; qi < QUERIES.length; qi++) {
            // search() returns nothing below 3 characters, for every scheme
            if (qLower[qi].length < 3) continue;
            const terms = qTerms[s.key][qi];
            if (terms.length === 0) {
                // no terms: every file is a candidate (shipping code returns all)
                candidates[s.key][qi].ids.push(fi);
                candidates[s.key][qi].matches.push(countMatches(lower, qLower[qi]));
                continue;
            }
            let ok = true;
            for (let t = 0; t < terms.length; t++) {
                if (!set.has(terms[t])) {
                    ok = false;
                    break;
                }
            }
            if (ok) {
                candidates[s.key][qi].ids.push(fi);
                candidates[s.key][qi].matches.push(countMatches(lower, qLower[qi]));
            }
        }
    }

    processed++;
    if (processed % 5000 === 0) {
        const mb = (process.memoryUsage().heapUsed / 1048576).toFixed(0);
        process.stdout.write(`  ${processed.toLocaleString()} files, heap ${mb} MB\n`);
    }
}

function countMatches(lower, needle) {
    let n = 0;
    let at = lower.indexOf(needle);
    while (at >= 0) {
        n++;
        if (n >= PER_FILE_LIMIT) break;
        at = lower.indexOf(needle, at + 1);
    }
    return n;
}

const passSeconds = (Date.now() - started) / 1000;
console.log(`\nindex pass: ${passSeconds.toFixed(1)}s\n`);

// ------------------------------------------------------------------- results
function summarise(schemeKey) {
    const st = stats[schemeKey];
    const terms = st.terms.size;
    const indexTable = terms * 12; // offset, length, count per term
    const termTable = schemeKey.startsWith('tri') ? terms * 3 : terms * 4; // 3 ASCII bytes vs hashed id
    const perQuery = QUERIES.map((q, qi) => {
        const cand = candidates[schemeKey][qi];
        const nameIdx = nameMatches[qi];
        const seen = new Set(cand.ids);
        let results = 0;
        let readBytes = 0;
        let readFiles = 0;
        let matched = 0;

        // the shipping code orders candidates by filename rank, then reads until full
        const order = [];
        for (let k = 0; k < cand.ids.length; k++) {
            const id = cand.ids[k];
            order.push([fileNameRank(files[id].path, qLower[qi]), id, cand.matches[k]]);
        }
        for (const id of nameIdx) if (!seen.has(id)) order.push([fileNameRank(files[id].path, qLower[qi]), id, 0]);
        order.sort((a, b) => a[0] - b[0] || a[1] - b[1]);

        for (const [, id, m] of order) {
            if (results >= MAX_RESULTS) break;
            readBytes += files[id].size;
            readFiles++;
            if (m > 0) matched++;
            results += Math.min(m, PER_FILE_LIMIT);
            if (m === 0 && fileNameRank(files[id].path, qLower[qi]) <= 2 && !q.q.includes('*')) results++;
        }

        const termList = qTerms[schemeKey][qi];
        let postings = 0;
        let missing = 0;
        for (const t of termList) {
            const packed = st.terms.get(t);
            if (packed === undefined) missing++;
            else postings += (packed / 0x100000) | 0;
        }

        return {
            query: q.q,
            cat: q.cat,
            candidates: seen.size,
            matchedFiles: matched,
            readFiles,
            readMB: readBytes / 1048576,
            allCandidatesMB: order.reduce((s, [, id]) => s + files[id].size, 0) / 1048576,
            terms: termList.length,
            postings,
            missing,
            complete: results >= MAX_RESULTS,
        };
    });

    return { terms, postings: st.postings, indexTable, termTable, blob: st.blobBytes, perQuery };
}

const results = {};
for (const s of SCHEMES) results[s.key] = summarise(s.key);

// --------------------------------------------------------------- blob gzip ratio
// Materialise the postings blob for a subset of terms and gzip it, to turn the
// exact uncompressed byte count into an on-disk estimate.
const gzipFactor = {};
const gzipTableFactor = {};
{
    const subset = Math.min(600, files.length);
    const postings = {};
    for (const s of SCHEMES) postings[s.key] = new Map();
    for (let fi = 0; fi < subset; fi++) {
        let text;
        try {
            text = fs.readFileSync(files[fi].path, 'utf8').toLowerCase();
        } catch {
            continue;
        }
        for (const s of SCHEMES) {
            const set = new Set();
            s.extract(text, (t) => set.add(t));
            const map = postings[s.key];
            for (const id of set) {
                let list = map.get(id);
                if (!list) map.set(id, (list = []));
                list.push(fi);
            }
        }
    }
    for (const s of SCHEMES) {
        const chunks = [];
        const offsets = [];
        const lengths = [];
        const counts = [];
        let offset = 0;
        for (const list of postings[s.key].values()) {
            let prev = 0;
            const bytes = [];
            for (const id of list) {
                const d = id - prev;
                prev = id;
                let v = d;
                while (v >= 0x80) {
                    bytes.push((v & 0x7f) | 0x80);
                    v >>>= 7;
                }
                bytes.push(v);
            }
            chunks.push(Buffer.from(bytes));
            offsets.push(offset);
            lengths.push(bytes.length);
            counts.push(list.length);
            offset += bytes.length;
        }
        const raw = Buffer.concat(chunks);
        const gz = zlib.gzipSync(raw, { level: 6 });
        gzipFactor[s.key] = raw.length ? gz.length / raw.length : 0;

        // the per-term index table, as writeSegmentFile lays it out
        const table = Buffer.alloc(counts.length * 12);
        for (let i = 0; i < counts.length; i++) {
            table.writeUInt32LE(offsets[i], i * 12);
            table.writeUInt32LE(lengths[i], i * 12 + 4);
            table.writeUInt32LE(counts[i], i * 12 + 8);
        }
        const tableGz = zlib.gzipSync(table, { level: 6 });
        gzipTableFactor[s.key] = table.length ? tableGz.length / table.length : 0;

        console.log(
            `gzip sample ${s.key.padEnd(9)}: blob ${(raw.length / 1048576).toFixed(1)} MB -> ${(gz.length / 1048576).toFixed(
                1
            )} MB (${(gzipFactor[s.key] * 100).toFixed(0)}%),  table ${(table.length / 1048576).toFixed(1)} MB -> ${(
                tableGz.length / 1048576
            ).toFixed(1)} MB (${(gzipTableFactor[s.key] * 100).toFixed(0)}%)`
        );
    }
}

// ------------------------------------------------------------------- printing
const mb = (b) => (b / 1048576).toFixed(1);
console.log('\n=== index size ===');
console.log(
    ['scheme', 'terms', 'postings', 'blob MB', 'gzip MB', 'tables MB', 'total MB', 'MB per src MB']
        .map((h, i) => h.padEnd(i === 0 ? 34 : 13))
        .join('')
);
for (const s of SCHEMES) {
    const r = results[s.key];
    const gz = r.blob * gzipFactor[s.key];
    const tables = (r.indexTable + r.termTable) * gzipTableFactor[s.key];
    console.log(
        [
            s.label.padEnd(34),
            r.terms.toLocaleString().padEnd(13),
            r.postings.toLocaleString().padEnd(13),
            mb(r.blob).padEnd(13),
            mb(gz).padEnd(13),
            mb(tables).padEnd(13),
            mb(gz + tables).padEnd(13),
            ((parseFloat(mb(gz + tables)) / (corpusBytes / 1048576)).toFixed(2)).padEnd(13),
        ].join('')
    );
}

console.log('\n=== per query: candidates / MB read to fill the list / postings decoded ===');
const cats = [...new Set(QUERIES.map((q) => q.cat))];
for (const cat of cats) {
    console.log(`\n[${cat}]`);
    console.log(
        'query'.padEnd(30) + SCHEMES.map((s) => s.key.padStart(26)).join('')
    );
    console.log(
        ''.padEnd(30) + SCHEMES.map((s) => 'cand / MB / postings'.padStart(26)).join('')
    );
    for (let qi = 0; qi < QUERIES.length; qi++) {
        if (QUERIES[qi].cat !== cat) continue;
        const cells = SCHEMES.map((s) => {
            const q = results[s.key].perQuery[qi];
            const flags = q.missing ? '!' : q.complete ? ' ' : '+'; // ! = term absent, + = list never filled
            return `${q.candidates}${flags}/${q.readMB.toFixed(1)}/${q.postings}`.padStart(26);
        });
        console.log(QUERIES[qi].q.padEnd(30) + cells.join(''));
    }
}

console.log('\n=== totals by category (MB read to answer the query) ===');
for (const cat of cats) {
    const row = SCHEMES.map((s) => {
        const sum = results[s.key].perQuery.filter((q) => q.cat === cat).reduce((a, q) => a + q.readMB, 0);
        return sum.toFixed(1).padStart(12);
    });
    console.log(cat.padEnd(14) + row.join(''));
}

if (OUT) {
    fs.writeFileSync(
        OUT,
        JSON.stringify({ corpus: CORPUS, files: files.length, corpusBytes, passSeconds, gzipFactor, results }, null, 2)
    );
    console.log(`\nwrote ${OUT}`);
}
