'use strict';
/**
 * Gram extractors used by the benchmark.
 *
 *   trigramsExact   the shipping implementation (src/trigrams.ts), string keys
 *   trigramsWords   same selection, hashed term ids (fair baseline for hashing)
 *   trigramsRaw     every 3-char window of the whole text, hashed
 *   sparse(maxLen)  ports of danlark1/sparse_ngrams: index side (all grams) and
 *                   query side (covering chain), hashed term ids
 *
 * Term ids are 32-bit. Collisions can only add candidates (every candidate is
 * verified against the real text), never drop one.
 */

// ---------------------------------------------------------------- pair hashing
// faithful to HashBigram() in sparse_ngrams.cc, with unsigned bytes:
//   a = b0 * 0xc6a4a7935bd1e995 + b1 * 0x228876a7198b743   (uint64)
//   return (uint32)(a + (~a >> 47))
const K1LO = 0x5bd1e995;
const K1HI = 0xc6a4a793;
const K2LO = 0x7198b743;
const K2HI = 0x0228876a;
const M32 = 4294967296;

const P1LO = new Uint32Array(256);
const P1HI = new Uint32Array(256);
const P2LO = new Uint32Array(256);
const P2HI = new Uint32Array(256);
for (let b = 0; b < 256; b++) {
    const p = b * K1LO; // < 2^53, exact
    P1LO[b] = p % M32;
    P1HI[b] = (b * K1HI + Math.floor(p / M32)) % M32;
    const q = b * K2LO;
    P2LO[b] = q % M32;
    P2HI[b] = (b * K2HI + Math.floor(q / M32)) % M32;
}

function hashPair(a, b) {
    const s = P1LO[a] + P2LO[b];
    const lo = s % M32;
    const hi = (P1HI[a] + P2HI[b] + (s >= M32 ? 1 : 0)) % M32;
    const uhi = (~hi) >>> 0;
    return (lo + (uhi >>> 15)) >>> 0;
}

// ------------------------------------------------------------ term hashing
// polynomial rolling hash over the gram's characters; composable from a prefix
// array in O(1) per gram, so extraction stays linear.
const BASE = 16777619;
const POW = new Uint32Array(64);
POW[0] = 1;
for (let i = 1; i < POW.length; i++) POW[i] = Math.imul(POW[i - 1], BASE) >>> 0;

function prefixHashes(s) {
    const n = s.length;
    const P = new Uint32Array(n + 1);
    let h = 0;
    for (let i = 0; i < n; i++) {
        h = (Math.imul(h, BASE) + s.charCodeAt(i)) >>> 0;
        P[i + 1] = h;
    }
    return P;
}

function gramHash(P, i, j) {
    return (P[j] - Math.imul(P[i], POW[j - i])) >>> 0;
}

// ------------------------------------------------------ current implementation
/** Literal copy of src/trigrams.ts: word-split, lowercase, per-word windows. */
function trigramsExact(text) {
    const trigrams = new Set();
    const words = text.split(/\W+/).filter((word) => word.length >= 3);
    for (const word of words) {
        const lowerWord = word.toLowerCase();
        for (let i = 0; i <= lowerWord.length - 3; i++) {
            trigrams.add(lowerWord.substring(i, i + 3));
        }
    }
    return Array.from(trigrams);
}

/** 3-char term id used by both trigram variants; query side must use it too. */
function triHash(c0, c1, c2) {
    let h = Math.imul(c0, 2654435761) >>> 0;
    h = Math.imul(h ^ c1, 2654435761) >>> 0;
    return Math.imul(h ^ c2, 2654435761) >>> 0;
}

/** Same selection as trigramsExact, but 32-bit hashed ids instead of strings. */
function trigramsWords(text, add) {
    const words = text.split(/\W+/);
    for (let w = 0; w < words.length; w++) {
        const word = words[w];
        if (word.length < 3) continue;
        const lower = word.toLowerCase();
        for (let i = 0; i + 3 <= lower.length; i++) {
            add(triHash(lower.charCodeAt(i), lower.charCodeAt(i + 1), lower.charCodeAt(i + 2)));
        }
    }
}

/** Every 3-char window of the lowercased text, punctuation and spaces included. */
function trigramsRaw(text, add) {
    for (let i = 0; i + 3 <= text.length; i++) {
        add(triHash(text.charCodeAt(i), text.charCodeAt(i + 1), text.charCodeAt(i + 2)));
    }
}

/** Query terms for the two trigram schemes (word-split and whole-string). */
function trigramQueryWords(query) {
    const out = [];
    const words = query.split(/\W+/).filter((w) => w.length >= 3);
    for (const word of words) {
        for (let i = 0; i + 3 <= word.length; i++) {
            out.push(triHash(word.charCodeAt(i), word.charCodeAt(i + 1), word.charCodeAt(i + 2)));
        }
    }
    return out;
}

function trigramQueryRaw(query) {
    const out = [];
    for (let i = 0; i + 3 <= query.length; i++) {
        out.push(triHash(query.charCodeAt(i), query.charCodeAt(i + 1), query.charCodeAt(i + 2)));
    }
    return out;
}

// ------------------------------------------------------- sparse n-gram ports
/**
 * Index side: StepAll from sparse_ngrams.cc (capped BuildAllNgrams), reporting
 * each emitted gram's span so the query chain can be built from real grams.
 * Emits every gram of the text, trigrams included.
 *
 * The stack holds unsigned hashes: storing them in an Int32Array would turn
 * comparisons into signed ones and change which grams are emitted.
 */
function indexGrams(text, maxLen, add) {
    const n = text.length;
    if (n < 3) return;

    const P = prefixHashes(text);
    const stH = new Uint32Array(n);
    const stP = new Int32Array(n);
    let top = 0;

    for (let i = 0; i + 2 <= n; i++) {
        const h = hashPair(text.charCodeAt(i) & 0xff, text.charCodeAt(i + 1) & 0xff);
        const end = i + 2;
        const minPos = end - Math.min(end, maxLen);

        while (top > 0 && h > stH[top - 1]) {
            if (stP[top - 1] < minPos) {
                top = 0;
                break;
            }
            add(gramHash(P, stP[top - 1], end));
            while (top > 1 && stH[top - 1] === stH[top - 2]) top--;
            top--;
        }
        if (top > 0 && stP[top - 1] >= minPos) add(gramHash(P, stP[top - 1], end));
        stH[top] = h;
        stP[top] = i;
        top++;
    }
}

/** Index side, term ids only. */
function sparseIndex(text, maxLen, add) {
    indexGrams(text, maxLen, add);
}

/**
 * Query side: a chain of grams, each one an index gram of the needle, chosen
 * longest-first from the current position. Few terms (a 16-char needle needs
 * two or three) and every one of them is guaranteed present in any file that
 * contains the needle, so the intersection never drops a matching file.
 */
function sparseQuery(text, maxLen) {
    const out = [];
    const n = text.length;
    if (n < 3) return out;

    const P = prefixHashes(text);
    // furthest end of an index gram starting at each position
    const maxEnd = new Uint16Array(n);
    indexGramsSpans(text, maxLen, (start, end) => {
        if (end > maxEnd[start]) maxEnd[start] = end;
    });

    let p = 0;
    while (p + 3 <= n) {
        const end = maxEnd[p] || p + 3;
        out.push(gramHash(P, p, end));
        p = end;
    }
    return out;
}

/** Index walk reporting spans (start, end) instead of ids. */
function indexGramsSpans(text, maxLen, add) {
    const n = text.length;
    if (n < 3) return;
    const stH = new Uint32Array(n);
    const stP = new Int32Array(n);
    let top = 0;
    for (let i = 0; i + 2 <= n; i++) {
        const h = hashPair(text.charCodeAt(i) & 0xff, text.charCodeAt(i + 1) & 0xff);
        const end = i + 2;
        const minPos = end - Math.min(end, maxLen);
        while (top > 0 && h > stH[top - 1]) {
            if (stP[top - 1] < minPos) {
                top = 0;
                break;
            }
            add(stP[top - 1], end);
            while (top > 1 && stH[top - 1] === stH[top - 2]) top--;
            top--;
        }
        if (top > 0 && stP[top - 1] >= minPos) add(stP[top - 1], end);
        stH[top] = h;
        stP[top] = i;
        top++;
    }
}

/** Gram count only (index side), for sizing without a set. */
function sparseIndexCount(text, maxLen) {
    let n = 0;
    sparseIndex(text, maxLen, () => n++);
    return n;
}

module.exports = {
    hashPair,
    trigramsExact,
    trigramsWords,
    trigramsRaw,
    trigramQueryWords,
    trigramQueryRaw,
    sparseIndex,
    sparseQuery,
    indexGramsSpans,
    gramHash,
    prefixHashes,
};
