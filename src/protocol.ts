/**
 * Indexing protocol constants, shared by the indexer and its worker thread.
 *
 * The worker sends file results in windows of BATCH_WINDOW and then waits for an
 * "ack" message. Without that, it races ahead of the main thread (which has to
 * turn every result into postings) and the unread messages pile up in the queue
 * — for a 137k-file tree that is hundreds of megabytes of strings, and the pause
 * while that queue is collected looks like a hang.
 *
 * Both sides must use the same value: the worker waits after sending this many
 * results, and the indexer acknowledges every this many results it has applied.
 */
export const BATCH_WINDOW = 128;
