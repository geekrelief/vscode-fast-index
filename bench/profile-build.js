'use strict';
/**
 * Times the main-thread side of indexing: reading a file, extracting trigrams and
 * calling ProjectIndexer.addFile, which is what receives every worker message.
 * No worker, no vscode UI — just the hot path, so a stall shows up as a time curve.
 *
 *   node --max-old-space-size=8192 bench/profile-build.js --files=20000
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const argv = process.argv.slice(2);
const opt = (n, d) => {
    const hit = argv.find((a) => a.startsWith(`--${n}=`));
    return hit ? hit.slice(n.length + 3) : d;
};
const LIMIT = Number(opt('files', '20000'));
const BASELINE = opt('baseline', path.join(os.tmpdir(), 'fastindex-bench', 'baseline-ue58.v4.bin'));
const MAX_FILE_BYTES = 512 * 1024;

const fake = {
    workspace: {
        getConfiguration: () => ({ get: () => undefined }),
        workspaceFolders: undefined,
        findFiles: async () => [],
        createFileSystemWatcher: () => ({ onDidCreate() {}, onDidChange() {}, onDidDelete() {} }),
        textDocuments: [],
        asRelativePath: (p) => p,
    },
    window: { showInformationMessage: async () => undefined, showWarningMessage: () => undefined },
    ProgressLocation: { Notification: 15 },
    Uri: { file: (p) => ({ fsPath: p, toString: () => p }) },
};
const load = Module._load;
Module._load = function (request) {
    if (request === 'vscode') return fake;
    return load.apply(this, arguments);
};

const { ProjectIndexer } = require('../out/indexer.js');
const { loadSegment } = require('./segment-tools');
const { computeTrigrams } = require('../out/trigrams');

const base = loadSegment(BASELINE);
const root = base.root;
const paths = LIMIT > 0 ? base.paths.slice(0, LIMIT) : base.paths;

const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'fastindex-profile-'));
const indexer = new ProjectIndexer({ fsPath: storage }, { fsPath: storage });
indexer.setRoots([root]);
const addFile = indexer.addFile.bind(indexer);

console.log(`profiling ${paths.length.toLocaleString()} files from ${root}`);

let readMs = 0;
let extractMs = 0;
let addMs = 0;
const started = Date.now();
let processed = 0;
let bytes = 0;
let lastMark = Date.now();
let lastProcessed = 0;

for (const file of paths) {
    let text;
    const t0 = process.hrtime.bigint();
    try {
        const stat = fs.statSync(file);
        if (stat.size > MAX_FILE_BYTES) continue;
        text = fs.readFileSync(file, 'utf8');
    } catch {
        continue;
    }
    const t1 = process.hrtime.bigint();
    const trigrams = computeTrigrams(text);
    const t2 = process.hrtime.bigint();
    addFile(file, trigrams, 0, text.length);
    const t3 = process.hrtime.bigint();

    readMs += Number(t1 - t0) / 1e6;
    extractMs += Number(t2 - t1) / 1e6;
    addMs += Number(t3 - t2) / 1e6;
    bytes += text.length;
    processed++;

    if (processed % 1000 === 0) {
        const now = Date.now();
        const sliceMs = now - lastMark;
        const heap = (process.memoryUsage().heapUsed / 1048576).toFixed(0);
        console.log(
            `${processed.toLocaleString().padStart(7)} files  ` +
                `last 1k: ${sliceMs.toString().padStart(5)} ms  ` +
                `read ${(readMs / 1000).toFixed(1)}s  extract ${(extractMs / 1000).toFixed(1)}s  addFile ${(addMs / 1000).toFixed(1)}s  ` +
                `heap ${heap} MB`
        );
        lastMark = now;
        lastProcessed = processed;
    }
}

console.log(
    `\ntotal ${((Date.now() - started) / 1000).toFixed(1)}s for ${processed.toLocaleString()} files (${(bytes / 1048576).toFixed(0)} MB): ` +
        `read ${(readMs / 1000).toFixed(1)}s, extract ${(extractMs / 1000).toFixed(1)}s, addFile ${(addMs / 1000).toFixed(1)}s`
);
indexer.dispose().then(() => process.exit(0));

