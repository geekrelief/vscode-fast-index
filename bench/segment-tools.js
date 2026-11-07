'use strict';
/**
 * Reads the extension's on-disk segments (VFI4 and the VFI5 variant this branch
 * writes) so a real index can be inspected and queried outside VS Code.
 *
 * Layout (VFI4, see src/indexer.ts):
 *   magic "VFI4" | version u32 | fileCount u32 | termCount u32 | rootLen u32
 *   root bytes | builtAt f64 | files (u32 len, utf8 path, f64 mtime, u32 size)*
 *   terms: termCount x 3 ASCII bytes, padded to a 4-byte boundary
 *   index: termCount x (u32 offset, u32 length, u32 count)
 *   blob:  delta-varint u32 file ids
 * The whole file is gzipped.
 */

const fs = require('fs');
const zlib = require('zlib');

function readAll(file) {
    const raw = fs.readFileSync(file);
    return zlib.gunzipSync(raw);
}

function parseSegment(buffer) {
    const magic = buffer.toString('ascii', 0, 4);
    if (magic !== 'VFI4' && magic !== 'VFI5') throw new Error(`unexpected magic ${JSON.stringify(magic)}`);
    const version = buffer.readUInt32LE(4);
    const fileCount = buffer.readUInt32LE(8);
    const termCount = buffer.readUInt32LE(12);
    const rootLen = buffer.readUInt32LE(16);
    let offset = 20;
    const root = buffer.toString('utf8', offset, offset + rootLen);
    offset += rootLen;
    const builtAt = buffer.readDoubleLE(offset);
    offset += 8;

    const paths = new Array(fileCount);
    const mtimes = new Float64Array(fileCount);
    const sizes = new Uint32Array(fileCount);
    for (let i = 0; i < fileCount; i++) {
        const len = buffer.readUInt32LE(offset);
        offset += 4;
        paths[i] = buffer.toString('utf8', offset, offset + len);
        offset += len;
        mtimes[i] = buffer.readDoubleLE(offset);
        offset += 8;
        sizes[i] = buffer.readUInt32LE(offset);
        offset += 4;
    }

    const termBase = offset;
    offset += termCount * 3;
    offset += (4 - ((termCount * 3) % 4)) % 4;

    const terms = new Array(termCount);
    const counts = new Uint32Array(termCount);
    const termOffsets = [];
    const entryStart = offset;
    for (let t = 0; t < termCount; t++) {
        terms[t] = buffer.toString('ascii', termBase + t * 3, termBase + t * 3 + 3);
        termOffsets.push(buffer.readUInt32LE(entryStart + t * 12));
        counts[t] = buffer.readUInt32LE(entryStart + t * 12 + 8);
    }
    const blobStart = entryStart + termCount * 12;

    return { magic, version, root, builtAt, paths, mtimes, sizes, terms, counts, termOffsets, blobStart, buffer };
}

/** Decodes one posting list into file ids. */
function postings(segment, termIndex) {
    const { buffer, blobStart, termOffsets, counts } = segment;
    const count = counts[termIndex];
    const out = new Uint32Array(count);
    let offset = blobStart + termOffsets[termIndex];
    let fileId = 0;
    for (let i = 0; i < count; i++) {
        let byte = buffer[offset++];
        let delta = byte & 0x7f;
        let shift = 7;
        while (byte & 0x80) {
            byte = buffer[offset++];
            delta |= (byte & 0x7f) << shift;
            shift += 7;
        }
        fileId += delta;
        out[i] = fileId;
    }
    return out;
}

function loadSegment(file) {
    const buffer = readAll(file);
    const segment = parseSegment(buffer);
    segment.file = file;
    segment.bytesOnDisk = fs.statSync(file).size;
    segment.bytesRaw = buffer.length;
    segment.termIndex = new Map();
    for (let t = 0; t < segment.terms.length; t++) segment.termIndex.set(segment.terms[t], t);
    return segment;
}

function writeVarint(buf, offset, value) {
    while (value >= 0x80) {
        buf[offset++] = (value & 0x7f) | 0x80;
        value >>>= 7;
    }
    buf[offset++] = value;
    return offset;
}

/**
 * Faithful copy of writeSegmentFile() from src/indexer.ts, so a segment built
 * here has exactly the layout the extension expects to load.
 */
function writeSegmentFile(outFile, { magic, version, root, paths, mtimes, sizes, terms, getPostings }) {
    const rootBuf = Buffer.from(root, 'utf8');

    const fileChunks = [];
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

    const termTable = Buffer.alloc(terms.length * 3);
    for (let i = 0; i < terms.length; i++) termTable.write(terms[i], i * 3, 'ascii');
    const termPadding = (4 - (termTable.length % 4)) % 4;

    const chunks = [];
    const offsets = new Uint32Array(terms.length);
    const lengths = new Uint32Array(terms.length);
    const counts = new Uint32Array(terms.length);
    let blobLength = 0;

    for (let i = 0; i < terms.length; i++) {
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
        chunks.push(chunk);
        blobLength += chunk.length;
    }

    const total = 20 + rootBuf.length + 8 + filesLength + termTable.length + termPadding + terms.length * 12 + blobLength;
    const out = Buffer.alloc(total);
    out.write(magic, 0, 'ascii');
    out.writeUInt32LE(version, 4);
    out.writeUInt32LE(paths.length, 8);
    out.writeUInt32LE(terms.length, 12);
    out.writeUInt32LE(rootBuf.length, 16);
    let offset = 20;
    rootBuf.copy(out, offset);
    offset += rootBuf.length;
    out.writeDoubleLE(Date.now(), offset);
    offset += 8;
    for (const chunk of fileChunks) {
        chunk.copy(out, offset);
        offset += chunk.length;
    }
    termTable.copy(out, offset);
    offset += termTable.length + termPadding;
    for (let i = 0; i < terms.length; i++) {
        out.writeUInt32LE(offsets[i], offset);
        out.writeUInt32LE(lengths[i], offset + 4);
        out.writeUInt32LE(counts[i], offset + 8);
        offset += 12;
    }
    for (const chunk of chunks) {
        chunk.copy(out, offset);
        offset += chunk.length;
    }

    const compressed = zlib.gzipSync(out, { level: 6 });
    fs.writeFileSync(outFile, compressed);
    return { rawBytes: out.length, gzBytes: compressed.length, blobBytes: blobLength };
}

module.exports = { loadSegment, parseSegment, postings, readAll, writeSegmentFile };
