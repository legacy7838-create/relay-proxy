import { delay } from "./http-utils.mjs";

export async function registerWithRetry({
  registry,
  makeEntry,
  attempts,
  retryMs,
  logger,
  isStopping = () => false,
}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (isStopping()) {
      throw new Error("Shutdown started before registration completed");
    }
    try {
      await registry.register(makeEntry());
      return { attempt };
    } catch (error) {
      lastError = error;
      logger?.warn("registry_register_failed", {
        attempt,
        errorName: error?.name ?? "Error",
      });
      if (attempt < attempts) await delay(retryMs);
    }
  }
  throw new Error("Unable to register in the shared registry", { cause: lastError });
}
