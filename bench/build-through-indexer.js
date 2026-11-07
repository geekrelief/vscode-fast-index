'use strict';
/**
 * Runs the real ProjectIndexer end to end: buildIndex() over an existing file
 * list, the worker with its ack windows, addFile, saveToDisk, reloadAll.
 * `vscode` is stubbed only for workspace discovery and UI.
 *
 *   node --max-old-space-size=6144 bench/build-through-indexer.js --root="d:\Epic Games\UE_5.8"
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
const ROOT = opt('root', 'd:\\Epic Games\\UE_5.8');
const LIST_FROM = opt('listFrom', path.join(os.tmpdir(), 'fastindex-bench', 'baseline-ue58.v4.bin'));

const { loadSegment } = require('./segment-tools');
const listed = loadSegment(LIST_FROM).paths;

const config = {
    excludePatterns: '{**/node_modules/**,**/.git/**}',
    maxFileSizeKB: 512,
    includeExtensions: '',
};
const folders = [{ uri: { fsPath: ROOT, scheme: 'file' } }];

const fake = {
    workspace: {
        getConfiguration: () => ({ get: (k) => config[k] }),
        workspaceFolders: folders,
        findFiles: async () => listed.map((p) => ({ fsPath: p })),
        createFileSystemWatcher: () => ({ onDidCreate() {}, onDidChange() {}, onDidDelete() {} }),
        textDocuments: [],
        asRelativePath: (p) => p,
        openTextDocument: async () => ({ getText: () => '', isDirty: false }),
    },
    window: {
        showInformationMessage: async (message) => { console.log(`[info] ${message}`); return undefined; },
        showWarningMessage: (message) => { console.log(`[warn] ${message}`); },
        withProgress: async (_options, task) => task({ report() {} }),
    },
    ProgressLocation: { Notification: 15 },
    RelativePattern: class { constructor(base, pattern) { this.base = base; this.pattern = pattern; } },
    Uri: { file: (p) => ({ fsPath: p, scheme: 'file', toString: () => p }) },
};
const load = Module._load;
Module._load = function (request) {
    if (request === 'vscode') return fake;
    return load.apply(this, arguments);
};

const { ProjectIndexer } = require('../out/indexer.js');

(async () => {
    const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'fastindex-full-'));
    const indexer = new ProjectIndexer({ fsPath: storage }, { fsPath: storage });
    indexer.setRoots([ROOT]);
    indexer.onProgress = (message) => {
        if (!message.startsWith('Processed')) console.log(`[status] ${message}`);
    };

    const started = Date.now();
    const ok = await indexer.buildIndex(undefined, true);
    const seconds = (Date.now() - started) / 1000;
    console.log(`buildIndex -> ${ok} in ${seconds.toFixed(1)}s`);
    console.log(`files ${indexer.indexedFileCount.toLocaleString()} · terms ${indexer.trigramCount.toLocaleString()}`);

    const dir = path.join(storage, 'fast-index');
    const produced = fs.readdirSync(dir).filter((n) => n.endsWith('.v5.bin'));
    for (const name of produced) {
        const size = fs.statSync(path.join(dir, name)).size;
        const segment = loadSegment(path.join(dir, name));
        let postings = 0;
        for (let i = 0; i < segment.counts.length; i++) postings += segment.counts[i];
        console.log(`${name}: ${(size / 1048576).toFixed(1)} MB gzip, ${segment.paths.length.toLocaleString()} files, ` +
            `${segment.terms.length.toLocaleString()} terms, ${postings.toLocaleString()} postings`);
    }

    // Query the freshly built index through the real search().
    for (const q of ['namespace UE', 'for (int', '###', 'GetActorLocation']) {
        const files = indexer.search(q);
        console.log(`search ${JSON.stringify(q)} -> ${files.length.toLocaleString()} files`);
    }

    await indexer.dispose();
    process.exit(0);
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
