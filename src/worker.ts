import { parentPort } from 'worker_threads';
import * as fs from 'fs';
import { computeTrigrams } from './trigrams';
import { BATCH_WINDOW } from './protocol';
import { isBinaryContent } from './binary';

interface BatchMessage {
    type: 'processBatch';
    paths: string[];
    mtimes: Float64Array;
    sizes: Uint32Array;
    force: boolean;
    maxFileSizeKB: number;
}

interface SingleMessage {
    type: 'processSingle';
    filePath: string;
    maxFileSizeKB: number;
}

interface AckMessage {
    type: 'ack';
}

/** Resolves the batch loop once the indexer reports it has applied the last window. */
let resumeBatch: (() => void) | undefined;

parentPort?.on('message', (message: BatchMessage | SingleMessage | AckMessage) => {
    if (message.type === 'ack') {
        const resume = resumeBatch;
        resumeBatch = undefined;
        resume?.();
        return;
    }

    if (message.type === 'processBatch') {
        void processBatch(message);
        return;
    }

    if (message.type === 'processSingle' && message.filePath) {
        const maxSizeBytes = (message.maxFileSizeKB || 512) * 1024;
        try {
            const stats = fs.statSync(message.filePath);
            if (stats.size > maxSizeBytes) return;

            const raw = fs.readFileSync(message.filePath);
            if (isBinaryContent(raw)) {
                parentPort?.postMessage({ type: 'binaryFile', filePath: message.filePath });
                return;
            }

            const content = raw.toString('utf8');
            const trigrams = computeTrigrams(content);
            parentPort?.postMessage({
                type: 'singleDone',
                filePath: message.filePath,
                trigrams,
                mtime: stats.mtimeMs,
                size: stats.size,
            });
        } catch (e) {
            /* file vanished between the watcher event and the read */
        }
    }
});

async function processBatch(message: BatchMessage): Promise<void> {
    const maxSizeBytes = (message.maxFileSizeKB || 512) * 1024;
    const { paths, mtimes, sizes, force } = message;
    let skipped = 0;
    let window = 0;

    for (let i = 0; i < paths.length; i++) {
        const filePath = paths[i];
        let sent = false;
        try {
            const stats = fs.statSync(filePath);
            if (stats.size > maxSizeBytes) continue;

            // Unchanged since the index was written: no read, no trigram pass.
            if (!force && stats.mtimeMs === mtimes[i] && stats.size === sizes[i]) {
                skipped++;
                continue;
            }

            const raw = fs.readFileSync(filePath);
            if (isBinaryContent(raw)) {
                // Not a text file: tell the indexer so an older entry can be dropped.
                parentPort?.postMessage({ type: 'binaryFile', filePath });
                continue;
            }

            const content = raw.toString('utf8');
            const trigrams = computeTrigrams(content);
            parentPort?.postMessage({
                type: 'fileDone',
                filePath,
                trigrams,
                mtime: stats.mtimeMs,
                size: stats.size,
            });
            sent = true;
        } catch (e) {
            /* unreadable file: leave its previous entry alone */
        }

        // Count only results actually delivered: the indexer acknowledges one per
        // delivered file, so a skipped or unreadable file must not consume a slot.
        if (sent && ++window >= BATCH_WINDOW) {
            window = 0;
            // Wait for the indexer to apply these before producing more.
            await new Promise<void>((resolve) => { resumeBatch = resolve; });
        }
    }

    parentPort?.postMessage({ type: 'batchDone', skipped });
}
