# Whole-text trigrams: implementation and measurement

Branch `whole-text-trigrams` · 2026-11-06 · measured on the real index of `d:\Epic Games\UE_5.8`
(137,016 files, 1.27 GB of indexed text)

## What changed

`computeTrigrams` used to split the text on `\W+` and take trigrams inside each word. A search
is a literal substring, so the filter was looser than the search: `for (int` pruned as
"files containing `for` AND `int`", and a query with no 3-letter word (`###`, `::`, `->`,
`if (`) produced no terms at all and scanned every file.

Now a term is **every 3-character window of the text**, lowercased, punctuation and spaces
included, and `search()` derives its terms with the same function (`queryTrigrams`), so a
phrase prunes as a phrase. Windows containing a non-ASCII character are skipped on both sides:
the segment stores each term as three ASCII bytes, and writing a wider character would mangle
it into a term the query could never look up. The segment format is unchanged apart from its
version (`VFI5`, file name `root-<hash>.v5.bin`); old word-split segments are deleted and
rebuilt, because their terms cannot answer whole-text queries.

Two latent bugs surfaced while doing this and are fixed here:

- **A segment could hold at most 65,536 terms.** `sources` packed `segmentIndex * 65536 + local`
  and `decodeEntry` masked with `& 0xffff`. The old index sat at 50,207 terms — just under the
  cliff. Whole-text reaches 873,275, at which point postings silently came back wrong (and
  `search()` threw). Packing is now 20 bits (`TERMS_PER_SEGMENT = 0x100000`); it is in-memory
  only, so the on-disk format did not have to change again.
- **The VFI3→VFI4 migration wrote zeroed mtimes and sizes**, so the stored UE_5.8 segment has no
  usable change-detection data — every build re-reads every file. That migration path is gone;
  segments in the old formats are dropped and rebuilt with real values.

## Validation

- Rebuilding the tree with the **old** extractor through the same harness reproduces the stored
  segment almost exactly: 50,207 terms, 65,432,364 postings vs 65,431,806 stored (0.0009%, from
  the 8 files that changed since the index was built) and 82.9 MB raw both times. The harness
  and the extractor are faithful.
- **Coverage**: 398 needles cut from real files, and 2,000 more in the unit test — every window
  the query looks up is a window the index stored for that file. 0 pruned.
- The segment loads through the real `ProjectIndexer` (stubbed `vscode`, real class) and
  `search()` returns the same candidate sets the harness computes.

## Cost of the index

| | word-split (today) | whole text | ratio |
|---|---|---|---|
| terms | 50,207 | 873,275 | 17.4× |
| postings | 65,431,806 | 155,145,499 | 2.37× |
| segment on disk (gzip) | 32.4 MB | **91.1 MB** | 2.8× |
| inflated segment | 82.9 MB | 190.4 MB | 2.3× |
| resident memory after load | 125 MB | **318 MB** | 2.5× |
| load time (real class) | 481 ms | **1415 ms** | 2.9× |
| build time (same harness, 1 thread) | 112 s | 189 s | 1.7× |

The build slowdown is mostly the 2.37× more postings to insert, not the extraction itself:
extraction alone measures 38 → 40 MB/s. Load is slower because 873k term strings are
materialised into a `Map` (the old index needed 50k).

## Benefit at query time — real index, real files

Bytes read by the snippet reader to fill the 50-result list, and time inside `search()`:

| query | candidates before → after | MB read before → after | search() before → after |
|---|---|---|---|
| `###` | 137,008 → **374** | 157.2 → **0.9** | 29.4 → **3.2 ms** |
| `if (` | all → 49,150 | 13.4 → **0.4** | — |
| `namespace UE` | 69,551 → 26,378 | 14.8 → **0.7** | 24.0 → 14.3 ms |
| `for (int` | 82,043 → 21,148 | 30.8 → **3.5** | 24.3 → 10.9 ms |
| `TEXT(` | 64,391 → 35,826 | 11.2 → **0.8** | 24.6 → 16.2 ms |
| `) const` | 103,479 → 62,902 | 17.1 → **3.2** | — |
| `UE_LOG(LogTemp` | 610 → 101 | 16.4 → **4.0** | — |
| `return nullptr;` | 29,834 → 12,903 | 5.3 → **0.9** | — |
| `GameMode.cpp` | 2,381 → 283 | 145.1 → **37.1** | 4.9 → 4.2 ms |
| `static_cast<` | 14,498 → 14,070 | 3.7 → **0.6** | — |
| `const FVector&` | 14,353 → 4,341 | 0.6 → **0.2** | — |
| `TArray<` | 42,842 → 36,065 | 7.4 → **0.1** | — |
| `Actor.h` | 38,865 → 13,361 | 0.4 → 0.4 | 17.2 → 9.5 ms |
| `GetActorLocation` | 1,599 → 1,599 | 4.5 → 4.5 | 5.8 → 5.6 ms |
| `draw`, `mesh`, `actor`, `cast`, `text`, `world`, `void` | unchanged | unchanged | 6.9 → 7.1 ms |

Totals over the non-regex workload: **bytes read 0.28×**, median 0.81×, postings decoded
1.14×. The median improvement is smaller than the total because identifier and plain-word
queries are already tight — those are exactly the queries where nothing changes.

## So, is it worth it?

The trade is real and legible: **2.8× disk, +1 s startup, 1.7× build — for turning
"scan 157 MB of source" into "look at 374 files" on the queries that used to fall off a cliff.**

- Worth it if you search the kind of things this workload does: macros, calls with arguments,
  `#include "…"`, `for (int`, `)->`, anything with punctuation in it. Those go from
  hundreds of milliseconds (or seconds, when matches are rare) to tens.
- Not worth it if your searches are overwhelmingly plain identifiers: the filter was already
  tight there, and you pay the 2.8× index and the slower load for nothing.
- If the load time is the sticking point, the obvious next step is hashing terms to 32-bit ids
  (measured 1.6× faster extraction) — the 873k strings are what makes `loadFromDisk` 3× slower.

One thing that did **not** change: regex queries still cannot be pruned (`search()` returns
every indexed file for `isRegex`), and case-insensitive-only matching is unchanged.

## Build speed: a quadratic that the wider term set exposed

The first fresh rebuild after switching to whole-text trigrams stalled — the progress
counter froze around 6k of 137k files. It was not the notification:

- ddFile called contains(this.postingsFor(term), fileId) for **every term of every
  file**, and postingsFor rebuilds the merged posting list as a new Uint32Array, then
  the caller immediately evicted it from the decode cache. The total cost is Σ(df²): ~2.3s
  per 1,000 files at the start, 14.8s per 1,000 by file 14,000 — hours for the full tree.
- A new file's id is larger than every id already indexed, so that check is provably false
  for it. Skipping it when the file is new makes the build linear.
- The per-file dirty set (~40 KB each) is also only needed for *re-indexed* files; keeping
  it for every new file cost multiple GB. It is now created only when an existing file is
  updated.
- The worker sent all 137k results without waiting for the indexer to apply them, so the
  unread messages piled up while the main thread fell behind — the visible symptom of a
  minute-long freeze. It now sends in windows of 128 and waits for an ck
  (src/protocol.ts), which keeps the queue and the heap flat.

Measured after the fixes, one thread, whole tree:

| stage | before | after |
|---|---|---|
| ddFile per 1,000 files | 2.3 s → 14.8 s (growing) | ~0.6 s, flat |
| hot path, 137k files | hours | 165 s |
| worker pass (read + extract + messaging + acks) | — | 80 s, heap flat at 33 MB |
| full uildIndex() including save and reload | — | **122 s** |
| resulting segment | — | 91.8 MB, 873,275 terms, 155,145,499 postings |

The produced segment is byte-for-byte equivalent to the independently built one (same
873,275 terms and 155,145,499 postings), and search() on it returns the same candidate
counts measured earlier. Peak heap during the build is still ~2.3 GB, most of it the
155M posting ids held as JavaScript numbers in the overlay; a compact posting store is the
obvious next step if that matters.

## Seeing the term count

The number is reported in four places now: the indexing notification
(Processed 12,345 of 137,016 · 512,340 terms), the view-title status
(137,016 files · 873,275 terms), the completion toast, and the **Fast Index** output
channel (Fast Index: Show Search Log), which logs both loaded … at startup and
indexed … · 91.1 MB on disk after a build. Roughly 873k terms means the whole-text
build produced the cache; ~50k means a word-split one did.

## Reproduce

```powershell
# baseline is the extension's own segment; candidate is built from the same file list
node bench/build-index.js --baseline=<root>.v4.bin --out=$env:TEMP\ue58.v5.bin
node bench/compare-real-index.js --baseline=<root>.v4.bin --candidate=$env:TEMP\ue58.v5.bin
node bench/real-indexer.js --segment=$env:TEMP\ue58.v5.bin --root="d:\Epic Games\UE_5.8"
node bench/test-whole-text-trigrams.js
```

`bench/build-index.js --extractor=words` rebuilds with the previous selection, which is the
control that reproduced the stored index.



