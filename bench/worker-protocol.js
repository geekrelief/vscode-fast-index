'use strict';
/**
 * Exercises the real worker + ack protocol without vscode: sends a batch and
 * acknowledges exactly like ProjectIndexer does, so a window mismatch shows up
 * as a hang (with a timeout) instead of at a user's desk.
 *
 *   node bench/worker-protocol.js --files=3000
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Worker } = require('worker_threads');
const { loadSegment } = require('./segment-tools');
const { BATCH_WINDOW } = require('../out/protocol');

const argv = process.argv.slice(2);
const opt = (n, d) => {
    const hit = argv.find((a) => a.startsWith(`--${n}=`));
    return hit ? hit.slice(n.length + 3) : d;
};
const LIMIT = Number(opt('files', '3000'));
const BASELINE = opt('baseline', path.join(os.tmpdir(), 'fastindex-bench', 'baseline-ue58.v4.bin'));

const base = loadSegment(BASELINE);
const paths = LIMIT > 0 ? base.paths.slice(0, LIMIT) : base.paths;

const worker = new Worker(path.join(__dirname, '..', 'out', 'worker.js'));
let done = 0;
let skipped = 0;
let window = 0;
const started = Date.now();

const watchdog = setTimeout(() => {
    console.error(`HANG: no completion after ${((Date.now() - started) / 1000).toFixed(0)}s (applied ${done}, window ${window})`);
    process.exit(1);
}, 600000);

worker.on('message', (msg) => {
    if (msg.type === 'fileDone') {
        done++;
        // mirror ProjectIndexer: acknowledge every BATCH_WINDOW applied results
        if (++window >= BATCH_WINDOW) {
            window = 0;
            worker.postMessage({ type: 'ack' });
        }
    } else if (msg.type === 'batchDone') {
        skipped = msg.skipped || 0;
        clearTimeout(watchdog);
        const seconds = (Date.now() - started) / 1000;
        console.log(
            `${done.toLocaleString()} files applied, ${skipped} skipped, ${seconds.toFixed(1)}s ` +
                `(${(done / seconds).toFixed(0)} files/s), heap ${(process.memoryUsage().heapUsed / 1048576).toFixed(0)} MB`
        );
        worker.terminate().then(() => process.exit(0));
    }
});

worker.on('error', (err) => { console.error('worker error', err); process.exit(1); });

worker.postMessage({
    type: 'processBatch',
    paths,
    mtimes: new Float64Array(paths.length).fill(-1),
    sizes: new Uint32Array(paths.length),
    force: true,
    maxFileSizeKB: 512,
});
