'use strict';
/**
 * Tests the real extractor (compiled from src/trigrams.ts) rather than a copy.
 *
 * The property that matters: if a file contains the query as a substring, every
 * window the query looks up must be a window the index stored for that file.
 * Otherwise the filter silently drops matching files.
 */

const fs = require('fs');
const path = require('path');
const { computeTrigrams, queryTrigrams } = require('../out/trigrams');

let failures = 0;
function check(name, ok, detail) {
    if (!ok) {
        failures++;
        console.log(`FAIL ${name}${detail ? `: ${detail}` : ''}`);
    }
}

// --- selection ---------------------------------------------------------------
const t = computeTrigrams('for (int i = 0; i < N; ++i)');
for (const expected of ['for', 'or ', 'r (', ' (i', '(in', 'int']) {
    check(`whole-text window ${JSON.stringify(expected)}`, t.includes(expected), `missing from ${JSON.stringify(t.slice(0, 8))}...`);
}
check('no empty terms', t.every((x) => x.length === 3));
check('lowercased', computeTrigrams('FooBar').includes('foo') && computeTrigrams('FooBar').includes('oob'));
check('deduplicated', new Set(t).size === t.length);

// non-ASCII windows are skipped, consistently on both sides
const unicode = computeTrigrams('héllo wörld');
check('non-ASCII skipped in index', !unicode.some((x) => [...x].some((c) => c.charCodeAt(0) > 127)));
check('ASCII part still indexed', unicode.includes('llo'));
check('query skips same windows', !queryTrigrams('héllo').some((x) => [...x].some((c) => c.charCodeAt(0) > 127)));
check('query keeps ASCII windows of a mixed query', queryTrigrams('héllo').includes('llo'));

// duplicates are kept on the query side (the caller compares counts)
check('query keeps duplicates', queryTrigrams('aaaa').length === 2);

// --- coverage on real source -------------------------------------------------
const DIRS = [
    'D:\\Epic Games\\UE_5.8\\Engine\\Source\\Runtime\\Core\\Private',
    'D:\\Epic Games\\UE_5.8\\Engine\\Source\\Runtime\\Engine\\Private',
    'D:\\Epic Games\\UE_5.8\\Engine\\Source\\Developer\\UnrealBuildTool',
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

const files = [];
for (const d of DIRS) collect(d, files, 80);

let needles = 0;
for (const file of files) {
    let text;
    try {
        text = fs.readFileSync(file, 'utf8');
    } catch {
        continue;
    }
    const stored = new Set(computeTrigrams(text));
    const lower = text.toLowerCase();

    for (let trial = 0; trial < 25; trial++) {
        const len = 3 + Math.floor(Math.random() * 78);
        if (lower.length <= len) break;
        const start = Math.floor(Math.random() * (lower.length - len));
        const needle = lower.slice(start, start + len);
        needles++;

        for (const window of queryTrigrams(needle)) {
            if (!stored.has(window)) {
                check('coverage', false, `window ${JSON.stringify(window)} of ${JSON.stringify(needle)} missing from ${path.basename(file)}`);
                break;
            }
        }
    }
}

console.log(`needles checked: ${needles.toLocaleString()}`);
console.log(failures === 0 ? 'OK' : `${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
