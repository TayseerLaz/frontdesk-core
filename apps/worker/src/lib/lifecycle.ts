// Worker-process lifecycle flag. Set true by the SIGTERM handler in
// src/index.ts; polled by long-running per-job loops (currently the
// crawl BFS in src/jobs/crawl.ts) so they can throw a typed retryable
// error on a clean shutdown instead of being SIGKILLed mid-page.
//
// Lives in its own module so importing it does not create a cycle
// between `src/index.ts` (boots workers) and `src/jobs/crawl.ts`
// (defines the crawl worker, exported back to index).
let _shuttingDown = false;

export function markShuttingDown(): void {
  _shuttingDown = true;
}

export function isWorkerShuttingDown(): boolean {
  return _shuttingDown;
}
