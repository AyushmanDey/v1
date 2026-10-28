/**
 * Process queued NEXIS course documents.
 *
 *   npm run worker            # poll forever
 *   npm run worker -- --once  # claim at most one job and exit
 */
import { loadEnvConfig } from "@next/env";
import { getSettings } from "../lib/server/settings";
import { runForever, runOnce } from "../lib/server/workers/ingestion";

loadEnvConfig(process.cwd(), process.env.NODE_ENV !== "production");

async function main(): Promise<void> {
  const settings = getSettings();
  if (process.argv.includes("--once")) {
    const result = await runOnce(settings);
    console.info(`document_ingestion_worker_once result=${result}`);
    if (result === "failed") process.exitCode = 1;
    return;
  }
  const controller = new AbortController();
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => controller.abort());
  console.info("document_ingestion_worker_started");
  await runForever(settings, { signal: controller.signal });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
