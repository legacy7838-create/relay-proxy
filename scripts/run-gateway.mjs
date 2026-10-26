#!/usr/bin/env node
import { loadConfig } from "../src/config.mjs";
import { createLogger } from "../src/logger.mjs";
import { GithubIssueRegistry } from "../src/registry.mjs";
import { startGatewayRuntime } from "../src/gateway-runtime.mjs";

async function main() {
  const config = loadConfig(process.env, "gateway");
  const logger = createLogger({ service: "gateway" });
  const registry = new GithubIssueRegistry({
    repo: config.githubRepository,
    issueNumber: config.registryIssueNumber,
    token: config.githubToken,
    apiUrl: config.githubApiUrl,
    actorLogin: config.registryActorLogin,
    logger,
  });

  const runtime = await startGatewayRuntime({ config, logger, registry });

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
      message: error?.message ?? "Gateway failed",
    })}\n`,
  );
  process.exitCode = 1;
});
