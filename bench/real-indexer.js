'use strict';
/**
 * Loads a segment through the real ProjectIndexer (the shipped class, not a copy)
 * so the query path, the VFI5 header and the term map are all exercised for real.
 * `vscode` is stubbed with just what setRoots/loadFromDisk/search touch.
 *
 *   node bench/real-indexer.js --segment=<v5.bin> --root=<folder>
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const Module = require('module');

const argv = process.argv.slice(2);
const opt = (n, d) => {
    const hit = argv.find((a) => a.startsWith(`--${n}=`));
    return hit ? hit.slice(n.length + 3) : d;
};
const SEGMENT = opt('segment', '');
const ROOT = opt('root', '');

// ---------------------------------------------------------------- vscode stub
const fake = {
    workspace: {
        getConfiguration: () => ({ get: () => undefined }),
        workspaceFolders: undefined,
        findFiles: async () => [],
        createFileSystemWatcher: () => ({ onDidCreate() {}, onDidChange() {}, onDidDelete() {} }),
        textDocuments: [],
        asRelativePath: (p) => p,
        openTextDocument: async () => ({ getText: () => '', isDirty: false }),
    },
    window: {
        showInformationMessage: async () => undefined,
        showWarningMessage: () => undefined,
        withProgress: async (_options, task) => task({ report() {} }),
    },
    ProgressLocation: { Notification: 15 },
    Uri: { file: (p) => ({ fsPath: p, scheme: 'file', toString: () => p }) },
};
const load = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === 'vscode') return fake;
    return load.apply(this, arguments);
};

const { ProjectIndexer } = require('../out/indexer.js');

const normalizePath = (p) => {
    const unified = p.replace(/\\/g, '/').replace(/\/+$/, '');
    return process.platform === 'win32' ? unified.toLowerCase() : unified;
};

(async () => {
    const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'fastindex-real-'));
    const dir = path.join(storage, 'fast-index');
    fs.mkdirSync(dir, { recursive: true });
    const hash = crypto.createHash('sha1').update(normalizePath(ROOT)).digest('hex').slice(0, 20);
    const suffix = (SEGMENT.match(/\.(v\d+)\.bin$/) || [, 'v5'])[1];
    const target = path.join(dir, `root-${hash}.${suffix}.bin`);
    fs.copyFileSync(SEGMENT, target);

    const indexer = new ProjectIndexer({ fsPath: storage }, { fsPath: storage });
    indexer.setRoots([ROOT]);

    const t0 = Date.now();
    const result = await indexer.loadFromDisk();
    const loadMs = Date.now() - t0;
    console.log(`load: status=${result.status} files=${result.fileCount.toLocaleString()} trigrams=${indexer.trigramCount.toLocaleString()} in ${loadMs} ms`);

    const queries = ['GetActorLocation', 'namespace UE', 'for (int', 'TEXT(', 'UPROPERTY(EditAnywhere', '###', 'Actor.h', 'GameMode.cpp', 'draw'];
    for (const query of queries) {
        // warm, then median of five
        indexer.search(query);
        const times = [];
        let found = 0;
        for (let i = 0; i < 5; i++) {
            const started = process.hrtime.bigint();
            found = indexer.search(query).length;
            times.push(Number(process.hrtime.bigint() - started) / 1e6);
        }
        times.sort((a, b) => a - b);
        console.log(`${JSON.stringify(query).padEnd(28)} files=${String(found).padStart(7)}  median ${times[2].toFixed(1)} ms`);
    }

    await indexer.dispose();
})().catch((err) => {
    console.error(err);
    process.exit(1);
});



