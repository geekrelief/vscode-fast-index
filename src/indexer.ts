import * as vscode from 'vscode';
import { Worker } from 'worker_threads';
import * as path from 'path';
import * as fs from 'fs';
import * as zlib from 'zlib';
import * as crypto from 'crypto';
import { computeTrigrams, queryTrigrams } from './trigrams';
import { log } from './log';
import { BATCH_WINDOW } from './protocol';
import { isBinaryContent } from './binary';
import {
    IgnoreFileStats,
    IgnoreRule,
    IgnoreRules,
    mergeExcludeGlobs,
    parseIgnoreRules,
    resolveIgnoreFile,
    splitIgnoreFiles
} from './ignore';

/**
 * How a build ended. Only 'built' means the index on disk was replaced; 'canceled'
 * and 'failed' leave the previous index in place.
 */
export type BuildOutcome = 'built' | 'canceled' | 'failed' | 'busy';

export interface CacheLoadResult {
    status: 'loaded' | 'partial' | 'missing';
    fileCount: number;
    bytes: number;
    /** Workspace folders with no usable cache yet. */
    missingRoots: string[];
    /** Workspace folders whose cache was unreadable and must be replaced. */
    corruptRoots: string[];
    error?: string;
}

export interface CacheEntry {
    /** Absolute path of the segment file. */
    file: string;
    /** Segment file name, e.g. root-7a6042463bb5fd61a1cc.v4.bin */
    name: string;
    /** Workspace folder this segment indexes. */
    root: string;
    /** Build time stored in the segment header (ms since epoch). */
    builtAt: number;
    /** Size on disk in bytes. */
    size: number;
    /** True when the folder is part of the workspace currently open. */
    inUse: boolean;
    /** False when the cached folder no longer exists (or is unavailable). */
    exists: boolean;
}

/**
 * Segment cache, one file per workspace folder, shared by every workspace that
 * contains that folder (stored in globalStorage, not workspaceStorage):
 *
 *   magic     4 bytes  "VFI4"
 *   version   u32
 *   fileCount u32
 *   trigrams  u32
 *   rootLen   u32
 *   root      rootLen utf8 bytes
 *   builtAt   f64 (ms since epoch)
 *   files     fileCount x (u32 pathLen, path utf8, f64 mtime, u32 size)
 *   trigrams  trigrams x 3 ascii bytes, zero-padded to a 4-byte boundary
 *   index     trigrams x (u32 offset, u32 byteLength, u32 count)  [offset into the blob]
 *   blob      trigrams x (count uvarints, delta-encoded file ids)
 *
 * The index table is what makes startup cheap: the postings are never touched at
 * load time, only the small tables are read. Posting lists are decoded on demand
 * for the handful of trigrams a query actually needs.
 */
const SEGMENT_MAGIC = 'VFI5';
const SEGMENT_VERSION = 5;
/** VFI4 and older stored word-split trigrams, which cannot answer whole-text queries. */
const STALE_SEGMENT_MAGICS = ['VFI4', 'VFI3'];
const LEGACY_JSON_FILE = 'fast-index-cache.json';
const EMPTY_POSTINGS = new Uint32Array(0);
/** Terms per segment addressable by the packed (segment, local) id above. */
const TERMS_PER_SEGMENT = 0x100000;
const DECODE_CACHE_LIMIT = 2048;

function normalizePath(p: string): string {
    const unified = p.replace(/\\/g, '/').replace(/\/+$/, '');
    return process.platform === 'win32' ? unified.toLowerCase() : unified;
}

function samePath(a: string, b: string): boolean {
    return normalizePath(a) === normalizePath(b);
}

function folderExists(folder: string): boolean {
    try {
        return fs.statSync(folder).isDirectory();
    } catch {
        return false;
    }
}

function baseName(filePath: string): string {
    const slash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
    return slash >= 0 ? filePath.slice(slash + 1) : filePath;
}

/**
 * Orders candidate files by how well their name matches the query so filename
 * matches surface above content-only matches:
 *   0 = file stem equals the query      (GasCharacter.cpp for "GasCharacter")
 *   1 = full file name equals the query (GasCharacter.h  for "GasCharacter.h")
 *   2 = file stem starts with the query (GasCharacterSet.h)
 *   3 = file name contains the query    (MyGasCharacter.cpp)
 *   4 = no name match, content candidate only
 * Path-ish queries ("GameFramework/Character.h") match against the whole path.
 */
export function fileNameRank(filePath: string, query: string): number {
    const lowerQuery = query.toLowerCase();

    if (lowerQuery.includes('/') || lowerQuery.includes('\\')) {
        const normalizedQuery = lowerQuery.replace(/\\/g, '/').replace(/^\/+/, '');
        const normalizedPath = filePath.replace(/\\/g, '/').toLowerCase();
        if (normalizedPath === normalizedQuery || normalizedPath.endsWith('/' + normalizedQuery)) return 0;
        if (normalizedPath.endsWith(normalizedQuery)) return 2;
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

/** True when the query appears in the file name (used to label results). */
export function isFileNameMatch(filePath: string, query: string): boolean {
    return fileNameRank(filePath, query) <= 3;
}

/** Search-time scoping: extensions ("cpp"), name patterns ("*.h") and folders ("Source/Game"). */
export interface SearchScope {
    include?: string[];
    exclude?: string[];
}

type PathFilter = (filePath: string) => boolean;

/**
 * Compiles filter tokens into one predicate over a lowercased, slash-separated path.
 *   cpp, .h, *.py   -> extension match on the file name
 *   Foo.h           -> file name suffix match
 *   Source/Game     -> any path containing that fragment
 */
export function buildPathFilter(scope?: SearchScope): PathFilter | undefined {
    if (!scope) return undefined;

    const include = compilePatterns(scope.include ?? []);
    const exclude = compilePatterns(scope.exclude ?? []);
    if (!include && !exclude) return undefined;

    return (filePath: string) => {
        const lower = filePath.toLowerCase().replace(/\\/g, '/');
        if (include && !include(lower)) return false;
        if (exclude && exclude(lower)) return false;
        return true;
    };
}

function compilePatterns(patterns: string[]): PathFilter | undefined {
    /** ".h" / "*.ini": exact suffix on the file name. */
    const suffixes: string[] = [];
    /** "Source/Game": any fragment of the path. */
    const fragments: string[] = [];
    /** "cpp", "Char", "Game": partial match on the extension or anywhere in the path. */
    const partials: string[] = [];

    for (const raw of patterns) {
        let token = raw.trim().toLowerCase().replace(/\\/g, '/');
        if (!token) continue;

        if (token.startsWith('*.')) {
            suffixes.push(token.slice(1));
            continue;
        }
        if (token.startsWith('.')) {
            suffixes.push(token);
            continue;
        }

        token = token.replace(/^\*\*\//, '').replace(/\/\*\*$/, '').replace(/\/\*$/, '').replace(/\/+$/, '');
        if (!token) continue;

        if (token.includes('/')) fragments.push(token);
        else partials.push(token);
    }

    if (suffixes.length === 0 && fragments.length === 0 && partials.length === 0) return undefined;

    return (lowerPath: string) => {
        for (let i = 0; i < fragments.length; i++) {
            if (lowerPath.includes(fragments[i])) return true;
        }
        if (suffixes.length === 0 && partials.length === 0) return false;

        const slash = lowerPath.lastIndexOf('/');
        const base = slash >= 0 ? lowerPath.slice(slash + 1) : lowerPath;
        for (let i = 0; i < suffixes.length; i++) {
            if (base.endsWith(suffixes[i])) return true;
        }
        if (partials.length === 0) return false;

        const dot = base.lastIndexOf('.');
        const extension = dot >= 0 ? base.slice(dot + 1) : '';
        for (let i = 0; i < partials.length; i++) {
            const token = partials[i];
            // Partial extension: "cpp" matches .cpp, "cp" matches .cpp, "h" matches .h/.hpp.
            if (extension === token || extension.startsWith(token) || extension.endsWith(token)) return true;
            // Partial name or folder: "Char" matches Character.h, "Game" matches GameFramework.
            // Short tokens stay extension-only, otherwise "h" would match every path.
            if (token.length >= 4 && lowerPath.includes(token)) return true;
        }
        return false;
    };
}

/** Stable sort into five buckets: exact name, prefix, substring, content-only. */
function rankByFileName(files: string[], lowerQuery: string): string[] {
    if (files.length < 2) return files;

    const buckets: string[][] = [[], [], [], [], []];
    for (let i = 0; i < files.length; i++) {
        buckets[fileNameRank(files[i], lowerQuery)].push(files[i]);
    }
    const out: string[] = [];
    for (const bucket of buckets) {
        for (let i = 0; i < bucket.length; i++) out.push(bucket[i]);
    }
    return out;
}

function intersectSorted(a: Uint32Array, b: Uint32Array): Uint32Array {
    const out = new Uint32Array(Math.min(a.length, b.length));
    let i = 0;
    let j = 0;
    let n = 0;
    while (i < a.length && j < b.length) {
        const left = a[i];
        const right = b[j];
        if (left === right) {
            out[n++] = left;
            i++;
            j++;
        } else if (left < right) {
            i++;
        } else {
            j++;
        }
    }
    return out.subarray(0, n);
}

function unionSorted(a: Uint32Array, b: Uint32Array): Uint32Array {
    if (b.length === 0) return a;
    if (a.length === 0) return b;

    const out = new Uint32Array(a.length + b.length);
    let i = 0;
    let j = 0;
    let n = 0;
    while (i < a.length && j < b.length) {
        const left = a[i];
        const right = b[j];
        if (left === right) {
            out[n++] = left;
            i++;
            j++;
        } else if (left < right) {
            out[n++] = left;
            i++;
        } else {
            out[n++] = right;
            j++;
        }
    }
    while (i < a.length) out[n++] = a[i++];
    while (j < b.length) out[n++] = b[j++];
    return out.subarray(0, n);
}

function insertSorted(list: number[], value: number): void {
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (list[mid] < value) lo = mid + 1;
        else hi = mid;
    }
    if (list[lo] === value) return;
    list.splice(lo, 0, value);
}

function contains(sorted: Uint32Array, value: number): boolean {
    let lo = 0;
    let hi = sorted.length - 1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const v = sorted[mid];
        if (v === value) return true;
        if (v < value) lo = mid + 1;
        else hi = mid - 1;
    }
    return false;
}

/** One folder's immutable postings blob. */
interface Segment {
    buffer: Buffer;
    fileBase: number;
    blobStart: number;
    offsets: Uint32Array;
    lengths: Uint32Array;
    counts: Uint32Array;
}

interface RootInfo {
    path: string;
    cacheFile: string;
    /** Segments in the old word-split format: deleted, never read. */
    staleFiles: string[];
}

interface BuildPlan {
    rootIndex: number;
    paths: string[];
    mtimes: Float64Array;
    sizes: Uint32Array;
}

export class ProjectIndexer {
    private files: string[] = [];
    private baseNames: string[] = [];
    private fileMtimes: number[] = [];
    private fileSizes: number[] = [];
    private fileIdOf = new Map<string, number>();
    private rootOfFile: number[] = [];

    private trigrams: string[] = [];
    private trigramIdOf = new Map<string, number>();
    /** global trigram id -> packed (segmentIndex * TERMS_PER_SEGMENT + local term id) */
    private sources: (number[] | undefined)[] = [];
    private segments: Segment[] = [];

    /** global trigram id -> extra file ids added since the segment was written */
    private overlay = new Map<number, number[]>();
    /** file id -> its current trigram ids, so stale postings can be ignored exactly */
    private dirty = new Map<number, Set<number>>();
    /** global trigram id -> merged postings (bounded FIFO cache) */
    private decoded = new Map<number, Uint32Array>();

    private roots: RootInfo[] = [];
    private segmentDir: string | undefined;
    private legacyCachePath: string | undefined;
    private isIndexing = false;
    public onProgress?: (message: string, busy?: boolean) => void;
    private journalPending = new Map<number, string[]>();
    private journalTimers = new Map<number, ReturnType<typeof setTimeout>>();
    private worker: Worker;
    /** Results applied since the worker was last acknowledged. */
    private ackWindow = 0;
    /** Set while a build is being canceled, so the partial result is discarded. */
    private abortRequested = false;
    /** Files a previous build indexed that turned out to be binary, since the last save. */
    private binaryRemovals = 0;

    constructor(workspaceStorage: vscode.Uri | undefined, globalStorage: vscode.Uri | undefined) {
        const storage = globalStorage ?? workspaceStorage;
        if (storage) {
            const dir = path.join(storage.fsPath, 'fast-index');
            fs.mkdirSync(dir, { recursive: true });
            this.segmentDir = dir;
        }
        if (workspaceStorage) {
            this.legacyCachePath = path.join(workspaceStorage.fsPath, 'fast-index-cache.bin');
            const leftover = path.join(workspaceStorage.fsPath, LEGACY_JSON_FILE);
            if (fs.existsSync(leftover)) {
                try {
                    fs.unlinkSync(leftover);
                } catch {
                    /* best effort */
                }
            }
        }

        this.worker = new Worker(path.join(__dirname, 'worker.js'));
        this.worker.on('message', (msg) => {
            if (msg.type === 'binaryFile') {
                // The worker will not index a binary: drop whatever an older build kept.
                this.dropBinaryFile(msg.filePath);
                return;
            }
            if (msg.type === 'fileDone' || msg.type === 'singleDone') {
                const mtime = typeof msg.mtime === 'number' ? msg.mtime : 0;
                const size = typeof msg.size === 'number' ? msg.size : 0;
                this.addFile(msg.filePath, msg.trigrams, mtime, size);
                if (!this.isIndexing) {
                    const rootIndex = this.rootIndexFor(msg.filePath);
                    if (rootIndex >= 0) {
                        this.queueJournal(rootIndex, JSON.stringify({ p: msg.filePath, t: msg.trigrams, m: mtime, s: size }) + '\n');
                    }
                }
                // Applied: let the worker produce the next window.
                if (msg.type === 'fileDone' && ++this.ackWindow >= BATCH_WINDOW) {
                    this.ackWindow = 0;
                    this.worker.postMessage({ type: 'ack' });
                }
            }
        });
    }

    public setRoots(rootPaths: string[]): void {
        const seen = new Set<string>();
        this.roots = [];
        for (const rootPath of rootPaths) {
            const key = normalizePath(rootPath);
            if (seen.has(key)) continue;
            seen.add(key);
            const hash = crypto.createHash('sha1').update(key).digest('hex').slice(0, 20);
            const dir = this.segmentDir;
            this.roots.push({
                path: rootPath,
                cacheFile: dir ? path.join(dir, `root-${hash}.v5.bin`) : '',
                staleFiles: dir
                    ? ['.v4.bin', '.v3.bin'].map(suffix => path.join(dir, `root-${hash}${suffix}`))
                    : [],
            });
        }
    }

    public get cacheDirPath(): string | undefined {
        return this.segmentDir;
    }

    public get indexedFileCount(): number {
        return this.fileIdOf.size;
    }

    /** Workspace folders this index covers, in load order. */
    public get rootPaths(): string[] {
        return this.roots.map(root => root.path);
    }

    /** Which workspace folder a file belongs to. */
    public rootPathFor(filePath: string): string | undefined {
        const rootIndex = this.rootIndexFor(filePath);
        return rootIndex >= 0 ? this.roots[rootIndex].path : undefined;
    }

    public get trigramCount(): number {
        return this.trigrams.length;
    }

    private rootIndexFor(filePath: string): number {
        const normalized = normalizePath(filePath);
        let best = -1;
        let bestLength = -1;
        for (let i = 0; i < this.roots.length; i++) {
            const root = normalizePath(this.roots[i].path);
            if (normalized === root || normalized.startsWith(`${root}/`)) {
                if (root.length > bestLength) {
                    best = i;
                    bestLength = root.length;
                }
            }
        }
        return best;
    }

    private trigramIdFor(trigram: string): number {
        let id = this.trigramIdOf.get(trigram);
        if (id === undefined) {
            id = this.trigrams.length;
            this.trigrams.push(trigram);
            this.trigramIdOf.set(trigram, id);
            this.sources.push(undefined);
        }
        return id;
    }

    private pushFile(file: string, rootIndex: number, mtime: number, size: number): number {
        const fileId = this.files.length;
        this.files.push(file);
        this.baseNames.push(baseName(file).toLowerCase());
        this.fileMtimes.push(mtime);
        this.fileSizes.push(size);
        this.fileIdOf.set(file, fileId);
        this.rootOfFile.push(rootIndex);
        return fileId;
    }

    private blankFile(fileId: number): void {
        const file = this.files[fileId];
        if (!file) return;
        this.fileIdOf.delete(file);
        this.files[fileId] = '';
        this.baseNames[fileId] = '';
        this.dirty.delete(fileId);
    }

    private addFile(filePath: string, trigrams: string[], mtime: number, size: number): void {
        let fileId = this.fileIdOf.get(filePath);
        const isNewFile = fileId === undefined;
        if (fileId === undefined) {
            const rootIndex = this.rootIndexFor(filePath);
            if (rootIndex < 0) return; // outside every workspace folder
            fileId = this.pushFile(filePath, rootIndex, mtime, size);
        } else {
            this.fileMtimes[fileId] = mtime;
            this.fileSizes[fileId] = size;
        }

        const current = isNewFile ? undefined : new Set<number>();
        for (const trigram of trigrams) {
            const trigramId = this.trigramIdFor(trigram);
            current?.add(trigramId);
            // A new file's id is larger than every id already in the index, so no posting
            // list can hold it. Skipping the check keeps a fresh build linear instead of
            // decoding (and re-decoding) a list per term, which is what made it quadratic.
            if (!isNewFile && contains(this.postingsFor(trigramId), fileId)) continue;

            let extra = this.overlay.get(trigramId);
            if (!extra) {
                extra = [];
                this.overlay.set(trigramId, extra);
            }
            insertSorted(extra, fileId);
            this.decoded.delete(trigramId);
        }
        // Only a re-indexed file can leave stale postings behind; a new id has none, so
        // tracking its term set would just cost ~40 KB per file for no benefit.
        if (current) this.dirty.set(fileId, current);
    }

    // ---- postings access ---------------------------------------------------------

    private postingsFor(trigramId: number): Uint32Array {
        const cached = this.decoded.get(trigramId);
        if (cached) return cached;

        let merged = this.decodeBase(trigramId);
        const extra = this.overlay.get(trigramId);
        if (extra && extra.length > 0) {
            merged = unionSorted(merged, Uint32Array.from(extra));
        }

        if (this.decoded.size >= DECODE_CACHE_LIMIT) {
            const oldest = this.decoded.keys().next();
            if (!oldest.done) this.decoded.delete(oldest.value);
        }
        this.decoded.set(trigramId, merged);
        return merged;
    }

    private decodeBase(trigramId: number): Uint32Array {
        const entries = this.sources[trigramId];
        if (!entries || entries.length === 0) return EMPTY_POSTINGS;

        let acc = this.decodeEntry(entries[0]);
        for (let i = 1; i < entries.length; i++) {
            acc = unionSorted(acc, this.decodeEntry(entries[i]));
        }
        return acc;
    }

    private decodeEntry(packed: number): Uint32Array {
        const segmentIndex = (packed / TERMS_PER_SEGMENT) | 0;
        const segment = this.segments[segmentIndex];
        const local = packed - segmentIndex * TERMS_PER_SEGMENT;
        const count = segment.counts[local];
        const out = new Uint32Array(count);
        const buffer = segment.buffer;
        const base = segment.fileBase;
        let offset = segment.blobStart + segment.offsets[local];
        let fileId = 0;

        for (let i = 0; i < count; i++) {
            let byte = buffer[offset++];
            let delta = byte & 0x7f;
            let shift = 7;
            while ((byte & 0x80) !== 0) {
                byte = buffer[offset++];
                delta |= (byte & 0x7f) << shift;
                shift += 7;
            }
            fileId += delta;
            out[i] = base + fileId;
        }
        return out;
    }

    // ---- loading -----------------------------------------------------------------

    public async loadFromDisk(): Promise<CacheLoadResult> {
        const started = Date.now();
        this.onProgress?.('Loading index…');

        const missingRoots: string[] = [];
        const corruptRoots: string[] = [];
        let bytes = 0;
        let loaded = 0;

        for (let i = 0; i < this.roots.length; i++) {
            const root = this.roots[i];
            if (!root.cacheFile) {
                missingRoots.push(root.path);
                continue;
            }
            this.onProgress?.(`Loading ${path.basename(root.path)} (${i + 1}/${this.roots.length})…`);
            const result = await this.loadSegment(root, i);
            bytes += result.bytes;
            if (result.status === 'loaded') {
                await this.applyJournal(i);
                loaded++;
            } else if (result.status === 'corrupt') {
                corruptRoots.push(root.path);
            } else {
                missingRoots.push(root.path);
            }
        }

        const status = missingRoots.length === 0 && corruptRoots.length === 0
            ? 'loaded'
            : (loaded > 0 ? 'partial' : 'missing');

        if (loaded > 0) {
            const summary = `${this.fileIdOf.size.toLocaleString()} files · ${this.trigrams.length.toLocaleString()} terms`;
            this.onProgress?.(`Ready · ${summary}`, false);
            log(`loaded ${summary} · ${(bytes / 1048576).toFixed(1)} MB in ${Date.now() - started} ms`);
        }

        return { status, fileCount: this.fileIdOf.size, bytes, missingRoots, corruptRoots };
    }

    private reset(): void {
        this.files = [];
        this.baseNames = [];
        this.fileMtimes = [];
        this.fileSizes = [];
        this.fileIdOf = new Map();
        this.rootOfFile = [];
        this.trigrams = [];
        this.trigramIdOf = new Map();
        this.sources = [];
        this.segments = [];
        this.overlay = new Map();
        this.dirty = new Map();
        this.decoded = new Map();
    }

    private async loadSegment(root: RootInfo, rootIndex: number): Promise<{ status: string; bytes: number }> {
        const source = root.cacheFile;
        if (!source || !fs.existsSync(source)) {
            // A segment in the old word-split format cannot answer whole-text queries.
            await this.dropStaleSegments(root);
            return { status: 'missing', bytes: 0 };
        }

        let raw: Buffer;
        try {
            raw = await fs.promises.readFile(source);
        } catch (err: any) {
            return { status: err?.code === 'ENOENT' ? 'missing' : 'corrupt', bytes: 0 };
        }

        try {
            const buffer = await new Promise<Buffer>((resolve, reject) => {
                zlib.gunzip(raw, (err, out) => (err ? reject(err) : resolve(out)));
            });

            const magic = buffer.toString('ascii', 0, 4);
            if (buffer.length < 28 || magic !== SEGMENT_MAGIC) {
                if (STALE_SEGMENT_MAGICS.includes(magic)) {
                    await fs.promises.unlink(source).catch(() => undefined);
                    return { status: 'missing', bytes: 0 };
                }
                return { status: 'corrupt', bytes: raw.length };
            }
            if (buffer.readUInt32LE(4) !== SEGMENT_VERSION) {
                return { status: 'corrupt', bytes: raw.length };
            }

            const fileCount = buffer.readUInt32LE(8);
            const trigramCount = buffer.readUInt32LE(12);
            const rootLen = buffer.readUInt32LE(16);
            let offset = 20;
            const cachedRoot = buffer.toString('utf8', offset, offset + rootLen);
            offset += rootLen + 8;
            if (!samePath(cachedRoot, root.path)) {
                return { status: 'corrupt', bytes: raw.length };
            }

            const fileBase = this.files.length;
            for (let i = 0; i < fileCount; i++) {
                const len = buffer.readUInt32LE(offset);
                offset += 4;
                const file = buffer.toString('utf8', offset, offset + len);
                offset += len;
                const mtime = buffer.readDoubleLE(offset);
                offset += 8;
                const size = buffer.readUInt32LE(offset);
                offset += 4;
                this.pushFile(file, rootIndex, mtime, size);
            }

            const trigramBase = offset;
            offset += trigramCount * 3;
            // The writer pads the trigram table to a 4-byte multiple, not the absolute stream.
            offset += (4 - ((trigramCount * 3) % 4)) % 4;

            const segmentIndex = this.segments.length;
            const offsets = new Uint32Array(trigramCount);
            const lengths = new Uint32Array(trigramCount);
            const counts = new Uint32Array(trigramCount);
            for (let t = 0; t < trigramCount; t++) {
                offsets[t] = buffer.readUInt32LE(offset);
                lengths[t] = buffer.readUInt32LE(offset + 4);
                counts[t] = buffer.readUInt32LE(offset + 8);
                offset += 12;

                const base = trigramBase + t * 3;
                const trigramId = this.trigramIdFor(buffer.toString('ascii', base, base + 3));
                let list = this.sources[trigramId];
                if (!list) {
                    list = [];
                    this.sources[trigramId] = list;
                }
                list.push(segmentIndex * TERMS_PER_SEGMENT + t);
                // A later segment extends this trigram's postings: drop any cached decode.
                // (Journal replay runs between segment loads, so the cache can be warm already.)
                this.decoded.delete(trigramId);
            }

            this.segments.push({ buffer, fileBase, blobStart: offset, offsets, lengths, counts });
            return { status: 'loaded', bytes: raw.length };
        } catch {
            return { status: 'corrupt', bytes: raw.length };
        }
    }

    /** Removes segments this build cannot read, plus their journals. */
    private async dropStaleSegments(root: RootInfo): Promise<void> {
        for (const file of root.staleFiles) {
            try {
                await fs.promises.unlink(file);
            } catch {
                /* nothing to drop */
            }
            try {
                await fs.promises.unlink(`${file}.journal`);
            } catch {
                /* nothing to drop */
            }
        }
    }

    // ---- saving ------------------------------------------------------------------

    public async saveToDisk(rootIndexes?: number[]): Promise<number> {
        if (!this.segmentDir) {
            throw new Error('Extension has no storage location.');
        }
        const targets = rootIndexes ?? this.roots.map((_, i) => i);
        let total = 0;
        for (const rootIndex of targets) {
            total += await this.saveSegment(rootIndex);
            await this.dropJournal(rootIndex);
        }
        return total;
    }

    private async saveSegment(rootIndex: number): Promise<number> {
        const root = this.roots[rootIndex];
        if (!root || !root.cacheFile) return 0;

        const localId = new Int32Array(this.files.length).fill(-1);
        const paths: string[] = [];
        const mtimes: number[] = [];
        const sizes: number[] = [];
        for (let i = 0; i < this.files.length; i++) {
            if (this.rootOfFile[i] !== rootIndex || this.files[i] === '') continue;
            localId[i] = paths.length;
            paths.push(this.files[i]);
            mtimes.push(this.fileMtimes[i] || 0);
            sizes.push(this.fileSizes[i] || 0);
        }

        const trigramIndexes: number[] = [];
        const lists: Uint32Array[] = [];
        for (let trigramId = 0; trigramId < this.trigrams.length; trigramId++) {
            const merged = this.postingsFor(trigramId);
            if (merged.length === 0) continue;

            let local: number[] | undefined;
            for (let i = 0; i < merged.length; i++) {
                const globalId = merged[i];
                const fileDirty = this.dirty.get(globalId);
                if (fileDirty && !fileDirty.has(trigramId)) continue; // stale posting
                const localIndex = localId[globalId];
                if (localIndex < 0) continue;
                if (!local) local = [];
                local.push(localIndex);
            }
            if (!local || local.length === 0) continue;
            local.sort((a, b) => a - b);
            trigramIndexes.push(trigramId);
            lists.push(Uint32Array.from(local));
        }

        const bytes = await writeSegmentFile(
            root.cacheFile,
            root.path,
            paths,
            Float64Array.from(mtimes),
            Uint32Array.from(sizes),
            trigramIndexes.map((id) => this.trigrams[id]),
            (i) => lists[i]
        );
        return bytes;
    }

    // ---- incremental journal -----------------------------------------------------

    private journalPathFor(rootIndex: number): string | undefined {
        const root = this.roots[rootIndex];
        return root && root.cacheFile ? `${root.cacheFile}.journal` : undefined;
    }

    private queueJournal(rootIndex: number, line: string): void {
        const pending = this.journalPending.get(rootIndex) ?? [];
        pending.push(line);
        this.journalPending.set(rootIndex, pending);

        if (!this.journalTimers.has(rootIndex)) {
            const timer = setTimeout(() => { void this.flushJournal(rootIndex); }, 250);
            timer.unref?.();
            this.journalTimers.set(rootIndex, timer);
        }
    }

    private async flushJournal(rootIndex: number): Promise<void> {
        const timer = this.journalTimers.get(rootIndex);
        if (timer) clearTimeout(timer);
        this.journalTimers.delete(rootIndex);

        const pending = this.journalPending.get(rootIndex) ?? [];
        this.journalPending.delete(rootIndex);
        if (pending.length === 0) return;

        const file = this.journalPathFor(rootIndex);
        if (!file) return;
        try {
            await fs.promises.appendFile(file, pending.join(''), 'utf8');
        } catch {
            /* a lost journal entry costs a stale entry, never correctness */
        }
    }

    private async applyJournal(rootIndex: number): Promise<void> {
        const file = this.journalPathFor(rootIndex);
        if (!file) return;
        let text: string;
        try {
            text = await fs.promises.readFile(file, 'utf8');
        } catch {
            return;
        }
        for (const line of text.split('\n')) {
            if (line.length === 0) continue;
            try {
                const entry = JSON.parse(line);
                if (typeof entry.p !== 'string') continue;
                if (entry.d) {
                    this.removeFileFromIndex(entry.p);
                } else if (Array.isArray(entry.t)) {
                    this.addFile(entry.p, entry.t, typeof entry.m === 'number' ? entry.m : 0, typeof entry.s === 'number' ? entry.s : 0);
                }
            } catch {
                /* skip a torn line */
            }
        }
    }

    private async dropJournal(rootIndex: number): Promise<void> {
        this.journalPending.delete(rootIndex);
        const timer = this.journalTimers.get(rootIndex);
        if (timer) {
            clearTimeout(timer);
            this.journalTimers.delete(rootIndex);
        }
        const file = this.journalPathFor(rootIndex);
        if (!file) return;
        try {
            await fs.promises.unlink(file);
        } catch {
            /* nothing to drop */
        }
    }

    private async reloadAll(): Promise<void> {
        this.reset();
        for (let i = 0; i < this.roots.length; i++) {
            if (!this.roots[i].cacheFile) continue;
            const result = await this.loadSegment(this.roots[i], i);
            if (result.status === 'loaded') {
                await this.applyJournal(i);
            }
        }
    }

    // ---- ignore files -------------------------------------------------------------

    /** Rules read from `fastIndex.ignoreFiles`; empty until refreshed. */
    private ignoreRules = new IgnoreRules();
    private ignoreFileStats: IgnoreFileStats[] = [];

    public get ignoreRuleCount(): number {
        return this.ignoreRules.size;
    }

    /** What each configured ignore file contributed, for the settings panel. */
    public get ignoreFiles(): IgnoreFileStats[] {
        return this.ignoreFileStats;
    }

    /** The folder-relative path of a file, or undefined when it is outside the index. */
    private relativeToRoot(filePath: string): string | undefined {
        const rootIndex = this.rootIndexFor(filePath);
        if (rootIndex < 0) return undefined;
        const root = this.roots[rootIndex].path.replace(/\\/g, '/').replace(/\/+$/, '');
        const file = filePath.replace(/\\/g, '/');
        if (file.length <= root.length + 1) return undefined;
        return file.slice(root.length + 1);
    }

    /**
     * Re-reads the configured ignore files. Relative entries are resolved against
     * every workspace folder; absolute entries are read once. A missing file is
     * reported instead of thrown, so a workspace without a `.gitignore` is fine.
     */
    public async refreshIgnoreRules(): Promise<IgnoreRules> {
        const configured = splitIgnoreFiles(vscode.workspace.getConfiguration('fastIndex').get<string>('ignoreFiles'));
        const rules: IgnoreRule[] = [];
        const stats: IgnoreFileStats[] = [];

        for (const entry of configured) {
            const candidates = path.isAbsolute(entry)
                ? [entry]
                : this.roots.map(root => resolveIgnoreFile(root.path, entry));
            let found = false;
            for (const file of candidates) {
                let text: string;
                try {
                    text = await fs.promises.readFile(file, 'utf8');
                } catch (err: any) {
                    if (err?.code !== 'ENOENT') {
                        stats.push({ file, exists: false, rules: 0, negations: 0, error: err?.message ?? String(err) });
                    }
                    continue;
                }
                found = true;
                const parsed = parseIgnoreRules(text);
                rules.push(...parsed);
                stats.push({
                    file,
                    exists: true,
                    rules: parsed.length,
                    negations: parsed.filter(rule => rule.negated).length
                });
            }
            if (!found) {
                // Still record the resolved paths, so creating the file later is noticed.
                const missing = path.isAbsolute(entry) ? [entry] : this.roots.map(root => resolveIgnoreFile(root.path, entry));
                for (const file of missing) stats.push({ file, exists: false, rules: 0, negations: 0 });
            }
        }

        this.ignoreRules = new IgnoreRules(rules);
        this.ignoreFileStats = stats;
        if (configured.length > 0) {
            const read = stats.filter(stat => stat.exists).length;
            log(`ignore files: ${read}/${configured.length} read, ${rules.length} rules`);
        }
        return this.ignoreRules;
    }

    /** Glob equivalents, so findFiles prunes ignored folders before walking them. */
    public ignoreGlobs(): string[] {
        return this.ignoreRules.toGlobs();
    }

    /** True when an ignore file covers this path (the watcher path uses it). */
    public isIgnored(filePath: string): boolean {
        if (this.ignoreRules.isEmpty) return false;
        const relative = this.relativeToRoot(filePath);
        return relative !== undefined && this.ignoreRules.matches(relative);
    }

    /** True when this path is one of the configured ignore files (editing it changes the rules). */
    public isIgnoreFile(filePath: string): boolean {
        const normalized = normalizePath(filePath);
        return this.ignoreFileStats.some(stat => normalizePath(stat.file) === normalized);
    }

    /**
     * Drops files that are already indexed but are now ignored. The removal is
     * journaled, so reloading the segment does not bring them back.
     */
    public removeIgnoredFiles(): number {
        if (this.ignoreRules.isEmpty) return 0;
        let removed = 0;
        for (let fileId = 0; fileId < this.files.length; fileId++) {
            const file = this.files[fileId];
            if (!file) continue;
            const relative = this.relativeToRoot(file);
            if (relative === undefined || !this.ignoreRules.matches(relative)) continue;
            const rootIndex = this.rootIndexFor(file);
            this.blankFile(fileId);
            removed++;
            if (rootIndex >= 0 && !this.isIndexing) {
                this.queueJournal(rootIndex, JSON.stringify({ p: file, d: 1 }) + '\n');
            }
        }
        if (removed > 0) log(`ignore files: dropped ${removed} already-indexed files`);
        return removed;
    }

    // ---- building ----------------------------------------------------------------

    public get isBuilding(): boolean {
        return this.isIndexing;
    }

    /**
     * Asks the running build to stop. The worker is told directly, so it stops at the
     * next batch boundary instead of finishing the file list; whatever was built so
     * far is discarded and the saved index is reloaded unchanged.
     */
    public cancelBuild(): void {
        if (!this.isIndexing) return;
        this.abortRequested = true;
        // Resumes a worker that is waiting for an ack, so it can see the abort.
        this.worker.postMessage({ type: 'abort' });
        this.worker.postMessage({ type: 'ack' });
    }

    public async buildIndex(onlyRoots?: string[], force = false): Promise<BuildOutcome> {
        if (this.isIndexing) return 'busy';
        this.isIndexing = true;
        this.abortRequested = false;
        this.onProgress?.(onlyRoots && onlyRoots.length ? 'Reindexing folder…' : 'Indexing folders…', true);

        try {
            const config = vscode.workspace.getConfiguration('fastIndex');
            const configuredExclude = config.get<string>('excludePatterns') || '{**/node_modules/**,**/.git/**,**/.*/**}';
            const maxFileSizeKB = config.get<number>('maxFileSizeKB') || 512;
            const includeExtensionsRaw = config.get<string>('includeExtensions') || '';

            // Read the ignore files first: their globs prune the walk, and their
            // rules filter what the walk still returns.
            await this.refreshIgnoreRules();
            const excludePattern = mergeExcludeGlobs(configuredExclude, this.ignoreGlobs());

            let includePattern = '**/*';
            if (includeExtensionsRaw.trim()) {
                const extensions = includeExtensionsRaw.split(',').map(e => e.trim()).filter(e => e);
                if (extensions.length === 1) {
                    includePattern = `**/*.${extensions[0]}`;
                } else if (extensions.length > 1) {
                    includePattern = `**/*.{${extensions.join(',')}}`;
                }
            }

            const selected = onlyRoots && onlyRoots.length
                ? this.roots.map((r, i) => i).filter(i => onlyRoots.some(p => samePath(p, this.roots[i].path)))
                : this.roots.map((_, i) => i);

            if (selected.length === 0) {
                vscode.window.showWarningMessage('Fast Index: this window has no workspace folder to index.');
                return 'failed';
            }

            const plans: BuildPlan[] = [];
            // A forced rebuild starts from scratch, so every file lands in the overlay.
            if (force) {
                this.reset();
            }
            for (const rootIndex of selected) {
                const folder = vscode.workspace.workspaceFolders?.find(f => samePath(f.uri.fsPath, this.roots[rootIndex].path));
                const base = folder ?? vscode.Uri.file(this.roots[rootIndex].path);
                const found = await vscode.workspace.findFiles(new vscode.RelativePattern(base, includePattern), excludePattern);
                // The globs above are only a hint: the rules decide, so patterns a glob
                // cannot express (negations, character classes) still apply.
                const paths = found.map(f => f.fsPath).filter(p => !this.isIgnored(p));
                const mtimes = new Float64Array(paths.length);
                const sizes = new Uint32Array(paths.length);
                for (let i = 0; i < paths.length; i++) {
                    const fileId = this.fileIdOf.get(paths[i]);
                    if (fileId !== undefined) {
                        mtimes[i] = this.fileMtimes[fileId] || -1;
                        sizes[i] = this.fileSizes[fileId] || 0;
                    } else {
                        mtimes[i] = -1;
                    }
                }
                plans.push({ rootIndex, paths, mtimes, sizes });
            }

            const total = plans.reduce((sum, plan) => sum + plan.paths.length, 0);
            if (total === 0) {
                vscode.window.showWarningMessage('Fast Index: no files matched the current include/exclude settings.');
                return 'failed';
            }

            return await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: force ? 'Rebuilding index…' : 'Indexing project…',
                // The notification's own cancel button, plus the settings panel's.
                cancellable: true
            }, async (progress, token) => {
                let processed = 0;
                let changed = 0;
                let skipped = 0;
                let removed = 0;
                const cancellation = token?.onCancellationRequested(() => this.cancelBuild());

                try {
                    for (const plan of plans) {
                        if (plan.paths.length === 0) continue;
                        if (this.abortRequested) break;

                        const result = await this.runBatch(
                            plan,
                            maxFileSizeKB,
                            force,
                            (count) => {
                                processed += count;
                                progress.report({
                                    increment: (100 * count) / total,
                                    message: `Processed ${processed.toLocaleString()} of ${total.toLocaleString()}` +
                                        ` · ${this.trigrams.length.toLocaleString()} terms`
                                });
                            }
                        );
                        if (result.aborted) break;
                        changed += result.changed;
                        skipped += result.skipped;

                        // Files that disappeared since the last build lose their postings.
                        const present = new Set(plan.paths);
                        for (let fileId = 0; fileId < this.files.length; fileId++) {
                            if (this.rootOfFile[fileId] !== plan.rootIndex) continue;
                            const file = this.files[fileId];
                            if (file !== '' && !present.has(file)) {
                                this.blankFile(fileId);
                                removed++;
                            }
                        }
                    }

                    if (this.abortRequested) {
                        // Discard the partial build: the segments on disk were never touched,
                        // so reloading them leaves the previous index exactly as it was.
                        await this.reloadAll();
                        const summary = `${this.fileIdOf.size.toLocaleString()} files · ${this.trigrams.length.toLocaleString()} terms`;
                        this.onProgress?.(`Ready · ${summary}`, false);
                        log(`indexing canceled after ${processed.toLocaleString()} files; previous index reloaded`);
                        vscode.window.showInformationMessage(
                            `Fast Index: indexing canceled. The previous index is unchanged (${summary}).`
                        );
                        return 'canceled';
                    }

                    const needsSave = force || changed > 0 || removed > 0 || this.binaryRemovals > 0 || this.overlay.size > 0;
                    let savedBytes = 0;
                    if (needsSave) {
                        this.onProgress?.(`Saving ${selected.length} folder${selected.length === 1 ? '' : 's'}…`);
                        progress.report({ message: 'Saving index…' });
                        savedBytes = await this.saveToDisk(selected);
                        this.binaryRemovals = 0;
                        // Reload so the in-memory index matches the file exactly.
                        await this.reloadAll();
                    }

                    const summary = `${this.fileIdOf.size.toLocaleString()} files · ${this.trigrams.length.toLocaleString()} terms`;
                    this.onProgress?.(`Ready · ${summary}`, false);
                    const note = skipped > 0 ? `, ${skipped.toLocaleString()} unchanged` : '';
                    log(`indexed ${summary}${savedBytes > 0 ? ` · ${(savedBytes / 1048576).toFixed(1)} MB on disk` : ''}` +
                        (changed > 0 ? ` · ${changed.toLocaleString()} updated` : '') + note);
                    if (!needsSave) {
                        vscode.window.showInformationMessage(`Fast Index: already up to date (${this.fileIdOf.size.toLocaleString()} files, ${this.trigrams.length.toLocaleString()} terms${note}).`);
                    } else {
                        vscode.window.showInformationMessage(
                            `Fast Index ready: ${this.fileIdOf.size.toLocaleString()} files, ${this.trigrams.length.toLocaleString()} terms` +
                            (changed > 0 ? `, ${changed.toLocaleString()} updated` : '') + note + '.'
                        );
                    }
                    return 'built';
                } catch (err: any) {
                    vscode.window.showWarningMessage(`Fast Index: indexing failed: ${err?.message ?? err}`);
                    this.onProgress?.('Indexing failed', false);
                    return 'failed';
                } finally {
                    cancellation?.dispose();
                }
            });
        } finally {
            this.isIndexing = false;
            this.abortRequested = false;
        }
    }

    private runBatch(
        plan: BuildPlan,
        maxFileSizeKB: number,
        force: boolean,
        onDone: (count: number) => void
    ): Promise<{ changed: number; skipped: number; aborted: boolean }> {
        return new Promise((resolve, reject) => {
            let changed = 0;
            let skipped = 0;

            const onMessage = (msg: any) => {
                if (msg.type === 'fileDone') {
                    changed++;
                    onDone(1);
                } else if (msg.type === 'binaryFile') {
                    // Skipped, but processed: keep the progress bar honest.
                    onDone(1);
                } else if (msg.type === 'batchDone') {
                    skipped = typeof msg.skipped === 'number' ? msg.skipped : 0;
                    onDone(skipped);
                    cleanup();
                    resolve({ changed, skipped, aborted: msg.aborted === true });
                }
            };
            const onError = (err: Error) => {
                cleanup();
                reject(err);
            };
            const cleanup = () => {
                this.worker.off('message', onMessage);
                this.worker.off('error', onError);
            };
            this.worker.on('message', onMessage);
            this.worker.on('error', onError);
            // The worker counts its own window from zero for every batch.
            this.ackWindow = 0;
            this.worker.postMessage({
                type: 'processBatch',
                paths: plan.paths,
                mtimes: plan.mtimes,
                sizes: plan.sizes,
                force,
                maxFileSizeKB,
            });
        });
    }

    // ---- edits -------------------------------------------------------------------

    private removeFileFromIndex(filePath: string) {
        const fileId = this.fileIdOf.get(filePath);
        if (fileId === undefined) return;
        this.blankFile(fileId);
    }

    /** Drops a file that turned out to be binary, and journals the removal. */
    private dropBinaryFile(filePath: string): void {
        if (!this.fileIdOf.has(filePath)) return;
        const rootIndex = this.rootIndexFor(filePath);
        this.removeFileFromIndex(filePath);
        this.binaryRemovals++;
        if (rootIndex >= 0 && !this.isIndexing) {
            this.queueJournal(rootIndex, JSON.stringify({ p: filePath, d: 1 }) + '\n');
        }
    }

    private shouldIndex(filePath: string): boolean {
        const normalized = normalizePath(filePath);
        const segments = normalized.split('/');
        // Hidden folders (".git", ".vs", ".github", …) are skipped; dotfiles themselves are kept.
        for (let i = 0; i < segments.length - 1; i++) {
            if (segments[i].startsWith('.')) return false;
        }
        if (ARTIFACT_SEGMENTS.some(segment => normalized.includes(segment))) return false;
        // Ignore files win over everything else: a file listed there never enters the
        // index, whether it was found by a build or created while the window was open.
        if (this.isIgnored(filePath)) return false;

        const config = vscode.workspace.getConfiguration('fastIndex');
        const includeRaw = config.get<string>('includeExtensions') || '';
        if (includeRaw.trim()) {
            const extensions = includeRaw.split(',').map(e => e.trim().toLowerCase()).filter(e => e);
            const ext = path.extname(filePath).slice(1).toLowerCase();
            if (!extensions.includes(ext)) return false;
        }
        return true;
    }

    /** Re-indexes one file from an in-memory buffer (used after a replacement). */
    public indexDocument(filePath: string, text: string, isDirty: boolean): void {
        // The last gate before a file enters the index: a binary never does, whichever
        // path got here (build worker, watcher, or an in-memory replacement).
        if (isBinaryContent(text)) {
            this.dropBinaryFile(filePath);
            return;
        }
        const trigrams = computeTrigrams(text);
        let mtime = 0;
        let size = 0;
        if (!isDirty) {
            try {
                const stat = fs.statSync(filePath);
                mtime = stat.mtimeMs;
                size = stat.size;
            } catch {
                /* file vanished */
            }
        }
        this.addFile(filePath, trigrams, mtime, size);

        // A dirty buffer is only indexed for this session: the journal has to describe
        // what is on disk, so it is written only once the document has been saved.
        if (!isDirty) {
            const rootIndex = this.rootIndexFor(filePath);
            if (rootIndex >= 0 && !this.isIndexing) {
                this.queueJournal(rootIndex, JSON.stringify({ p: filePath, t: trigrams, m: mtime, s: size }) + '\n');
            }
        }
    }

    public updateFile(filePath: string) {
        if (!this.shouldIndex(filePath)) return;
        const config = vscode.workspace.getConfiguration('fastIndex');
        const maxFileSizeKB = config.get<number>('maxFileSizeKB') || 512;
        this.worker.postMessage({ type: 'processSingle', filePath, maxFileSizeKB });
    }

    public deleteFile(filePath: string) {
        const rootIndex = this.rootIndexFor(filePath);
        this.removeFileFromIndex(filePath);
        if (rootIndex >= 0 && !this.isIndexing) {
            this.queueJournal(rootIndex, JSON.stringify({ p: filePath, d: 1 }) + '\n');
        }
    }

    // ---- search ------------------------------------------------------------------

    public search(query: string, isRegex = false, scope?: SearchScope): string[] {
        const allow = buildPathFilter(scope);
        if (isRegex) {
            return this.allIndexedFiles(allow);
        }
        if (query.length < 3) return [];
        const lowerQuery = query.toLowerCase();

        const queryTrigramIds: number[] = [];
        // Same windows the index stored for a file, so a phrase prunes as a phrase.
        const trigrams = queryTrigrams(lowerQuery);
        const expectedTrigrams = trigrams.length;
        for (const trigram of trigrams) {
            const id = this.trigramIdOf.get(trigram);
            if (id !== undefined) queryTrigramIds.push(id);
        }

        // Queries too short (or too non-ASCII) to have a single window cannot be pruned.
        if (expectedTrigrams === 0) {
            return rankByFileName(this.allIndexedFiles(allow), lowerQuery);
        }
        // Not one of the query's trigrams exists anywhere in the index.
        if (queryTrigramIds.length === 0) {
            return [];
        }

        // If any trigram of the query is missing from the index, no file's content can
        // contain the whole query — only a file-name hit can match.
        const contentIds = queryTrigramIds.length === expectedTrigrams
            ? this.filterDirty(this.intersectPostings(queryTrigramIds), queryTrigramIds)
            : EMPTY_POSTINGS;

        // File-name hits are candidates even when their content never mentions the query.
        const nameMatches = this.fileNameMatchIds(lowerQuery);
        const merged = nameMatches.length === 0 ? contentIds : unionSorted(contentIds, nameMatches);
        if (merged.length === 0) return [];

        return rankByFileName(this.toPaths(merged, allow), lowerQuery);
    }

    private intersectPostings(queryTrigramIds: number[]): Uint32Array {
        let result = this.postingsFor(queryTrigramIds[0]);
        if (result.length === 0) return EMPTY_POSTINGS;
        for (let i = 1; i < queryTrigramIds.length; i++) {
            result = intersectSorted(result, this.postingsFor(queryTrigramIds[i]));
            if (result.length === 0) break;
        }
        return result;
    }

    private filterDirty(ids: Uint32Array, queryTrigramIds: number[]): Uint32Array {
        if (this.dirty.size === 0) return ids;
        return ids.filter((fileId) => {
            const current = this.dirty.get(fileId);
            if (!current) return true;
            for (let i = 0; i < queryTrigramIds.length; i++) {
                if (!current.has(queryTrigramIds[i])) return false;
            }
            return true;
        });
    }

    private toPaths(ids: Uint32Array, allow?: PathFilter): string[] {
        const out: string[] = [];
        for (let i = 0; i < ids.length; i++) {
            const file = this.files[ids[i]];
            if (file && (!allow || allow(file))) out.push(file);
        }
        return out;
    }

    private fileNameMatchIds(lowerQuery: string): Uint32Array {
        const ids: number[] = [];
        if (lowerQuery.includes('/') || lowerQuery.includes('\\')) {
            const query = lowerQuery.replace(/\\/g, '/').replace(/^\/+/, '');
            const lastSegment = query.split('/').pop() ?? '';
            for (let i = 0; i < this.baseNames.length; i++) {
                const name = this.baseNames[i];
                if (name === '' || !name.includes(lastSegment)) continue;
                const full = this.files[i].replace(/\\/g, '/').toLowerCase();
                if (full === query || full.endsWith('/' + query)) ids.push(i);
            }
        } else {
            for (let i = 0; i < this.baseNames.length; i++) {
                const name = this.baseNames[i];
                if (name !== '' && name.includes(lowerQuery)) ids.push(i);
            }
        }
        return Uint32Array.from(ids);
    }

    private allIndexedFiles(allow?: PathFilter): string[] {
        const out: string[] = [];
        for (let i = 0; i < this.files.length; i++) {
            const file = this.files[i];
            if (file !== '' && (!allow || allow(file))) out.push(file);
        }
        return out;
    }

    // ---- cache management --------------------------------------------------------

    public async listCaches(): Promise<CacheEntry[]> {
        if (!this.segmentDir) return [];
        let names: string[];
        try {
            names = (await fs.promises.readdir(this.segmentDir)).filter(name => name.startsWith('root-') && /\.v[345]\.bin$/.test(name));
        } catch {
            return [];
        }

        const entries: CacheEntry[] = [];
        for (const name of names) {
            const file = path.join(this.segmentDir, name);
            try {
                const stat = await fs.promises.stat(file);
                const header = await readSegmentHeader(file);
                const root = header?.root ?? '(unknown folder)';
                entries.push({
                    file,
                    name,
                    root,
                    builtAt: header?.builtAt ?? stat.mtimeMs,
                    size: stat.size,
                    inUse: header ? this.roots.some(r => samePath(r.path, header.root)) : false,
                    exists: header ? folderExists(header.root) : false,
                });
            } catch {
                /* skip unreadable entries */
            }
        }
        return entries.sort((a, b) => a.root.localeCompare(b.root));
    }

    public async deleteCaches(files: string[]): Promise<{ deleted: string[]; roots: string[]; bytes: number }> {
        if (!this.segmentDir) return { deleted: [], roots: [], bytes: 0 };
        const base = path.resolve(this.segmentDir) + path.sep;
        const deleted: string[] = [];
        const roots: string[] = [];
        let bytes = 0;

        for (const file of files) {
            const resolved = path.resolve(file);
            if (!resolved.startsWith(base)) continue;
            try {
                const header = await readSegmentHeader(resolved);
                const stat = await fs.promises.stat(resolved);
                await fs.promises.unlink(resolved);
                await fs.promises.unlink(`${resolved}.journal`).catch(() => undefined);
                bytes += stat.size;
                deleted.push(resolved);
                if (header) roots.push(header.root);
            } catch {
                /* already gone */
            }
        }
        return { deleted, roots, bytes };
    }

    public async dispose(): Promise<void> {
        for (const rootIndex of [...this.journalPending.keys()]) {
            await this.flushJournal(rootIndex);
        }
        this.worker.terminate();
    }
}

/** Build artifact folders that are never worth indexing, and churn on every build. */
const ARTIFACT_SEGMENTS = [
    '/node_modules/',
    '/.git/',
    '/binaries/',
    '/intermediate/',
    '/deriveddatacache/',
    '/saved/',
    '/content/',
    '/.vs/',
];

/** Reads only the segment header; the first 16 KB inflate to more than the header needs. */
async function readSegmentHeader(file: string): Promise<{ root: string; builtAt: number } | null> {
    let handle: fs.promises.FileHandle | undefined;
    try {
        handle = await fs.promises.open(file, 'r');
        const buf = Buffer.alloc(16384);
        const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
        if (bytesRead === 0) return null;

        let inflated: Buffer;
        try {
            inflated = zlib.gunzipSync(buf.subarray(0, bytesRead), { finishFlush: zlib.constants.Z_SYNC_FLUSH });
        } catch {
            return null;
        }

        if (inflated.length < 28) return null;
        const magic = inflated.toString('ascii', 0, 4);
        if (magic !== SEGMENT_MAGIC && !STALE_SEGMENT_MAGICS.includes(magic)) return null;
        const rootLen = inflated.readUInt32LE(16);
        if (inflated.length < 20 + rootLen + 8) return null;
        return {
            root: inflated.toString('utf8', 20, 20 + rootLen),
            builtAt: inflated.readDoubleLE(20 + rootLen),
        };
    } catch {
        return null;
    } finally {
        if (handle) {
            await handle.close().catch(() => undefined);
        }
    }
}

function writeVarint(buf: Buffer, offset: number, value: number): number {
    while (value >= 0x80) {
        buf[offset++] = (value & 0x7f) | 0x80;
        value >>>= 7;
    }
    buf[offset++] = value;
    return offset;
}

/** Writes one folder's segment, streaming the postings blob through gzip. */
async function writeSegmentFile(
    file: string,
    rootPath: string,
    paths: string[],
    mtimes: Float64Array,
    sizes: Uint32Array,
    trigrams: string[],
    getPostings: (index: number) => Uint32Array
): Promise<number> {
    const rootBuf = Buffer.from(rootPath, 'utf8');

    const fileChunks: Buffer[] = [];
    let filesLength = 0;
    for (let i = 0; i < paths.length; i++) {
        const encoded = Buffer.from(paths[i], 'utf8');
        const entry = Buffer.alloc(4 + encoded.length + 8 + 4);
        entry.writeUInt32LE(encoded.length, 0);
        encoded.copy(entry, 4);
        entry.writeDoubleLE(mtimes[i] || 0, 4 + encoded.length);
        entry.writeUInt32LE(sizes[i] || 0, 4 + encoded.length + 8);
        fileChunks.push(entry);
        filesLength += entry.length;
    }

    const trigramTable = Buffer.alloc(trigrams.length * 3);
    for (let i = 0; i < trigrams.length; i++) {
        trigramTable.write(trigrams[i], i * 3, 'ascii');
    }
    const trigramPadding = (4 - (trigramTable.length % 4)) % 4;

    const postingsChunks: Buffer[] = [];
    const offsets = new Uint32Array(trigrams.length);
    const lengths = new Uint32Array(trigrams.length);
    const counts = new Uint32Array(trigrams.length);
    let blobLength = 0;

    for (let i = 0; i < trigrams.length; i++) {
        const ids = getPostings(i);
        counts[i] = ids.length;
        offsets[i] = blobLength;

        const scratch = Buffer.alloc(ids.length * 5 + 5);
        let offset = 0;
        let previous = 0;
        for (let k = 0; k < ids.length; k++) {
            offset = writeVarint(scratch, offset, ids[k] - previous);
            previous = ids[k];
        }
        const chunk = scratch.subarray(0, offset);
        lengths[i] = chunk.length;
        postingsChunks.push(chunk);
        blobLength += chunk.length;
    }

    const headerLength = 20 + rootBuf.length + 8;
    const indexLength = trigrams.length * 12;
    const total = headerLength + filesLength + trigramTable.length + trigramPadding + indexLength + blobLength;

    const out = Buffer.alloc(total);
    let offset = 0;
    out.write(SEGMENT_MAGIC, 0, 'ascii');
    out.writeUInt32LE(SEGMENT_VERSION, 4);
    out.writeUInt32LE(paths.length, 8);
    out.writeUInt32LE(trigrams.length, 12);
    out.writeUInt32LE(rootBuf.length, 16);
    offset = 20;
    rootBuf.copy(out, offset);
    offset += rootBuf.length;
    out.writeDoubleLE(Date.now(), offset);
    offset += 8;

    for (const chunk of fileChunks) {
        chunk.copy(out, offset);
        offset += chunk.length;
    }
    trigramTable.copy(out, offset);
    offset += trigramTable.length + trigramPadding;

    for (let i = 0; i < trigrams.length; i++) {
        out.writeUInt32LE(offsets[i], offset);
        out.writeUInt32LE(lengths[i], offset + 4);
        out.writeUInt32LE(counts[i], offset + 8);
        offset += 12;
    }
    for (const chunk of postingsChunks) {
        chunk.copy(out, offset);
        offset += chunk.length;
    }

    const compressed = await new Promise<Buffer>((resolve, reject) => {
        zlib.gzip(out, { level: 6 }, (err, result) => (err ? reject(err) : resolve(result)));
    });

    const tmp = `${file}.tmp`;
    await fs.promises.writeFile(tmp, compressed);
    await fs.promises.rename(tmp, file);
    return compressed.length;
}


