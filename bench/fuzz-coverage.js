'use strict';
/**
 * Property test for the extractors, run on real source text.
 *
 * Coverage is the correctness property that matters: if a file contains the
 * query as a substring, every term the query looks up must be a term of that
 * file. Otherwise the index would silently drop matching files.
 */

const fs = require('fs');
const path = require('path');
const G = require('./ngrams');

const DIRS = [
    'D:\\Epic Games\\UE_5.7\\Engine\\Source\\Runtime\\Core\\Private',
    'D:\\Epic Games\\UE_5.7\\Engine\\Source\\Runtime\\Engine\\Private',
    'D:\\Epic Games\\UE_5.7\\Engine\\Source\\Runtime\\Core\\Public',
    'D:\\Epic Games\\UE_5.7\\Engine\\Source\\Developer\\UnrealBuildTool',
];

function collect(dir, out, limit) {
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
        if (e.isDirectory()) collect(p, out, limit);
        else if (/\.(h|cpp|cs|inl|usf)$/i.test(e.name)) out.push(p);
    }
}

function terms(text, add) {
    const s = text.toLowerCase();
    G.sparseIndex(s, 16, add);
    G.trigramsRaw(s, add);
    G.trigramsWords(s, add);
}

function termSet(text) {
    const set = new Set();
    terms(text, (t) => set.add(t));
    return set;
}

const files = [];
for (const d of DIRS) collect(d, files, 60);
console.log(`files sampled: ${files.length}`);

let checked = 0;
let missingChain = 0;
let missingTriRaw = 0;
let missingTriWords = 0;
const failures = [];

for (const file of files) {
    let text;
    try {
        text = fs.readFileSync(file, 'utf8');
    } catch {
        continue;
    }
    const lower = text.toLowerCase();
    const fileAll = termSet(lower);

    for (let trial = 0; trial < 40; trial++) {
        const len = 3 + Math.floor(Math.random() * 78);
        if (lower.length <= len) break;
        const start = Math.floor(Math.random() * (lower.length - len));
        const needle = lower.slice(start, start + len);
        if (needle.includes('\u0000')) continue;

        checked++;

        // 1. the query chain must consist of grams the index would emit for the needle
        const chain = G.sparseQuery(needle, 16);
        const needleAll = termSet(needle);
        let bad = chain.some((t) => !needleAll.has(t));
        if (bad) {
            missingChain++;
            if (failures.length < 10) failures.push({ kind: 'chain-not-in-needle', needle: JSON.stringify(needle) });
            continue;
        }

        // 2. and therefore grams of the file that contains it
        bad = chain.some((t) => !fileAll.has(t));
        if (bad) {
            missingChain++;
            if (failures.length < 10) failures.push({ kind: 'coverage', needle: JSON.stringify(needle) });
        }

        // 3. raw trigrams: every window of the needle is in the file
        for (const t of G.trigramQueryRaw(needle)) {
            if (!fileAll.has(t)) {
                missingTriRaw++;
                if (failures.length < 10) failures.push({ kind: 'tri-raw', needle: JSON.stringify(needle) });
                break;
            }
        }

        // 4. word-split trigrams: every intra-word window of the needle is in the file
        for (const t of G.trigramQueryWords(needle)) {
            if (!fileAll.has(t)) {
                missingTriWords++;
                if (failures.length < 10) failures.push({ kind: 'tri-words', needle: JSON.stringify(needle) });
                break;
            }
        }
    }
}

// pathological inputs: repeated pairs (equal hashes), long runs, length cap edges
const hard = [
    '----------------',
    '=============',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    '////////////',
    '#include <CoreMinimal.h>\r\n',
    'for (int32 i = 0; i < N; ++i)',
    'TArray<FVector> Verts;',
    'UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "AI")\r\n',
    'é日本語のコメントです',
    '          ',
];
for (const needle of hard) {
    checked++;
    const chain = G.sparseQuery(needle.toLowerCase(), 16);
    const own = termSet(needle.toLowerCase());
    const bad = chain.filter((t) => !own.has(t));
    if (bad.length) {
        missingChain++;
        if (failures.length < 20) failures.push({ kind: 'hard-chain', needle: JSON.stringify(needle), missing: bad.length });
    }
}

console.log(`needles checked: ${checked}`);
console.log(`coverage failures (sparse chain): ${missingChain}`);
console.log(`coverage failures (raw trigrams):  ${missingTriRaw}`);
console.log(`coverage failures (word trigrams): ${missingTriWords}`);
for (const f of failures) console.log('  ', JSON.stringify(f));
process.exit(missingChain + missingTriRaw + missingTriWords === 0 ? 0 : 1);
