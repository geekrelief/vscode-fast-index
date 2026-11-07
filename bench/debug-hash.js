'use strict';
// Validates the fast 64-bit pair hash against a literal BigInt transcription of
// HashBigram() from sparse_ngrams.cc, and looks at how the hashes behave.
const G = require('./ngrams');

const K1 = 0xc6a4a7935bd1e995n;
const K2 = 0x0228876a7198b743n;
const MASK64 = (1n << 64n) - 1n;

function refHash(a, b) {
    // uint64_t a = b0*kMul1 + b1*kMul2;  return (uint32)(a + (~a >> 47));
    const a64 = (BigInt(a) * K1 + BigInt(b) * K2) & MASK64;
    const folded = (a64 + ((~a64 & MASK64) >> 47n)) & MASK64;
    return Number(folded & 0xffffffffn);
}

let bad = 0;
for (let i = 0; i < 20000; i++) {
    const a = i & 0xff;
    const b = (i * 7 + 13) & 0xff;
    if (G.hashPair(a, b) !== refHash(a, b)) {
        if (bad < 5) console.log('mismatch', a, b, G.hashPair(a, b), refHash(a, b));
        bad++;
    }
}
console.log(`hash mismatches: ${bad} / 20000`);

// Distribution of adjacent-pair hashes on real text: are they random-looking?
const text = 'getactorlocation for (int i = 0; i < Count; ++i) { DrawDebugLine(World, A, B); }';
let up = 0;
let down = 0;
let prev = null;
const seq = [];
for (let i = 0; i + 1 < text.length; i++) {
    const h = G.hashPair(text.charCodeAt(i) & 0xff, text.charCodeAt(i + 1) & 0xff);
    seq.push(h);
    if (prev !== null) (h > prev ? up++ : down++);
    prev = h;
}
console.log(`adjacent comparisons: up=${up} down=${down}`);
console.log('first 24 hashes:', seq.slice(0, 24).join(' '));

// same-pair values (equal-hash runs like "----")
const dashes = G.hashPair(45, 45);
console.log('hash("--") =', dashes, ' ref =', refHash(45, 45));

// How does the byte value influence the hash? Show hash(b, fixed) for b = 0..15
console.log('hash(b,65):', Array.from({ length: 16 }, (_, b) => G.hashPair(b, 65)).join(' '));
