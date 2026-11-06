import { parentPort } from 'worker_threads';
import * as fs from 'fs';
import { computeTrigrams } from './trigrams';

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



parentPort?.on('message', (message: BatchMessage | SingleMessage) => {
    const maxSizeBytes = (message.maxFileSizeKB || 512) * 1024;

    if (message.type === 'processBatch') {
        const { paths, mtimes, sizes, force } = message;
        let skipped = 0;

        for (let i = 0; i < paths.length; i++) {
            const filePath = paths[i];
            try {
                const stats = fs.statSync(filePath);
                if (stats.size > maxSizeBytes) continue;

                // Unchanged since the index was written: no read, no trigram pass.
                if (!force && stats.mtimeMs === mtimes[i] && stats.size === sizes[i]) {
                    skipped++;
                    continue;
                }

                const content = fs.readFileSync(filePath, 'utf-8');
                const trigrams = computeTrigrams(content);
                parentPort?.postMessage({
                    type: 'fileDone',
                    filePath,
                    trigrams,
                    mtime: stats.mtimeMs,
                    size: stats.size,
                });
            } catch (e) {
                /* unreadable file: leave its previous entry alone */
            }
        }
        parentPort?.postMessage({ type: 'batchDone', skipped });
        return;
    }

    if (message.type === 'processSingle' && message.filePath) {
        try {
            const stats = fs.statSync(message.filePath);
            if (stats.size > maxSizeBytes) return;

            const content = fs.readFileSync(message.filePath, 'utf-8');
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
