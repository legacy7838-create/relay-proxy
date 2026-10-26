#!/usr/bin/env node
import { loadConfig } from "../src/config.mjs";
import { createLogger } from "../src/logger.mjs";
import { GithubIssueRegistry } from "../src/registry.mjs";
import { startRelayRuntime } from "../src/relay-runtime.mjs";

async function main() {
  const config = loadConfig(process.env, "relay");
  const logger = createLogger({ service: "relay", relayId: config.relayId });
  const registry = new GithubIssueRegistry({
    repo: config.githubRepository,
    issueNumber: config.registryIssueNumber,
    token: config.githubToken,
    apiUrl: config.githubApiUrl,
    actorLogin: config.registryActorLogin,
    logger,
  });

  const runtime = await startRelayRuntime({ config, logger, registry });

  const stop = (reason) => {
    void runtime.shutdown(reason, 0);
  };
  process.once("SIGTERM", () => stop("sigterm"));
  process.once("SIGINT", () => stop("sigint"));

  const code = await runtime.done;
  process.exitCode = code;
}

main().catch((error) => {
  process.stderr.write(
    `${JSON.stringify({
      level: "error",
      event: "fatal",
      message: error?.message ?? "Relay failed",
    })}\n`,
  );
  process.exitCode = 1;
});
