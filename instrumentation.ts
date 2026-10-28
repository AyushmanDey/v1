export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { getSettings } = await import("./lib/server/settings");
  const { warmUpModels } = await import("./lib/server/ai/warmup");
  // Not awaited: the server starts serving immediately while the models load in the background.
  void warmUpModels(getSettings()).catch(() => undefined);
}
