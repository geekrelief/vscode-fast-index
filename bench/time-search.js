'use strict';
/**
 * Times the real search path from the sidebar: indexer.search() followed by the
 * snippet pass (read each candidate, line starts, regex scan) until 50 results.
 *
 *   node bench/time-search.js --segment=<v5.bin> --root="d:\Epic Games\UE_5.8" --q=public
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const Module = require('module');

const argv = process.argv.slice(2);
const opt = (n, d) => {
    const hit = argv.find((a) => a.startsWith(`--${n}=`));
    return hit ? hit.slice(n.length + 3) : d;
};
const SEGMENT = opt('segment', path.join(os.tmpdir(), 'fastindex-bench', 'ue58.v5.bin'));
const ROOT = opt('root', 'd:\\Epic Games\\UE_5.8');
const QUERIES = opt('q', 'public,publ,text,GetActorLocation,###').split(',');

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

const normalizePath = (p) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

/** Mirrors getSnippets: per-file read, line starts, regex scan, stop at 50 rows. */
function snippets(files, query, maxResults = 50, perFile = 3) {
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(escaped, 'gi');
    const rows = [];
    let bytes = 0;
    let read = 0;
    for (const file of files) {
        if (rows.length >= maxResults) break;
        let content;
        try {
            content = fs.readFileSync(file, 'utf8');
        } catch {
            continue;
        }
        read++;
        bytes += content.length;
        const lineStarts = [0];
        for (let at = content.indexOf('\n'); at >= 0; at = content.indexOf('\n', at + 1)) lineStarts.push(at + 1);
        regex.lastIndex = 0;
        let match;
        let taken = 0;
        while (taken < perFile && (match = regex.exec(content)) !== null) {
            if (match[0].length === 0) { regex.lastIndex++; continue; }
            rows.push(match.index);
            taken++;
        }
    }
    return { rows: rows.length, filesRead: read, mb: bytes / 1048576 };
}

(async () => {
    const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'fastindex-time-'));
    const dir = path.join(storage, 'fast-index');
    fs.mkdirSync(dir, { recursive: true });
    const hash = crypto.createHash('sha1').update(normalizePath(ROOT)).digest('hex').slice(0, 20);
    fs.copyFileSync(SEGMENT, path.join(dir, `root-${hash}.v5.bin`));

    const indexer = new ProjectIndexer({ fsPath: storage }, { fsPath: storage });
    indexer.setRoots([ROOT]);
    const t0 = Date.now();
    const loaded = await indexer.loadFromDisk();
    console.log(`load ${loaded.status} in ${Date.now() - t0} ms · ${indexer.indexedFileCount.toLocaleString()} files · ${indexer.trigramCount.toLocaleString()} terms\n`);

    for (const query of QUERIES) {
        indexer.search(query); // warm
        const times = [];
        let files = [];
        for (let i = 0; i < 3; i++) {
            const t = process.hrtime.bigint();
            files = indexer.search(query);
            times.push(Number(process.hrtime.bigint() - t) / 1e6);
        }
        times.sort((a, b) => a - b);
        const t1 = process.hrtime.bigint();
        const s = snippets(files, query);
        const snippetMs = Number(process.hrtime.bigint() - t1) / 1e6;
        console.log(
            `${JSON.stringify(query).padEnd(22)} search ${times[1].toFixed(1).padStart(7)} ms ` +
                `(${files.length.toLocaleString().padStart(7)} candidates)  ` +
                `snippets ${snippetMs.toFixed(0).padStart(6)} ms ` +
                `(${s.filesRead} files, ${s.mb.toFixed(1)} MB, ${s.rows} rows)`
        );
    }
    await indexer.dispose();
})().catch((err) => { console.error(err); process.exit(1); });
