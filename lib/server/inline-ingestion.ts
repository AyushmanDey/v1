import type { Settings } from "./settings";
import { drainQueue, ingestionConfigured } from "./workers/ingestion";

let running: Promise<void> | null = null;
let rerunRequested = false;

/**
 * Drain the ingestion queue inside the Next.js server process. Concurrent calls coalesce so at
 * most one drain loop runs per process; the database's SKIP LOCKED claim keeps it safe alongside
 * a standalone `npm run worker` process.
 */
export function scheduleInlineIngestion(settings: Settings): Promise<void> | null {
  if (!settings.ingestionInline || !ingestionConfigured(settings)) return null;
  if (running) {
    rerunRequested = true;
    return running;
  }
  running = (async () => {
    try {
      do {
        rerunRequested = false;
        await drainQueue(settings);
      } while (rerunRequested);
    } catch (error) {
      console.error("inline_ingestion_failed", error instanceof Error ? error.message : error);
    } finally {
      running = null;
    }
  })();
  return running;
}
