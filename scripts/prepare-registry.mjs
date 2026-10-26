#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { createLogger } from "../src/logger.mjs";
import { prepareRegistry } from "../src/registry.mjs";

async function main() {
  const token = process.env.GITHUB_TOKEN?.trim();
  const repo = process.env.GITHUB_REPOSITORY?.trim();
  if (!token) throw new Error("GITHUB_TOKEN is required");
  if (!repo || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new Error("GITHUB_REPOSITORY must be in owner/repo form");
  }

  const logger = createLogger({ service: "prepare-registry" });
  const result = await prepareRegistry({
    repo,
    token,
    apiUrl: process.env.GITHUB_API_URL,
    actorLogin: process.env.REGISTRY_ACTOR_LOGIN || "github-actions[bot]",
    logger,
  });

  const outputPath = process.env.GITHUB_OUTPUT;
  if (outputPath) {
    appendFileSync(outputPath, `issue_number=${result.issueNumber}\n`);
  }

  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    appendFileSync(
      summaryPath,
      [
        "### Relay pool registry",
        "",
        `Registry issue: ${result.issueUrl}`,
        "",
        `Cleared stale registrations: ${result.cleared}`,
        "",
        "The registry issue is public and contains only temporary tunnel URLs, never tokens.",
        "",
      ].join("\n"),
    );
  }

  process.stdout.write(
    `${JSON.stringify({
      level: "info",
      event: "registry_prepared",
      issueNumber: result.issueNumber,
      cleared: result.cleared,
    })}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(
    `${JSON.stringify({
      level: "error",
      event: "fatal",
      message: error?.message ?? "Registry preparation failed",
    })}\n`,
  );
  process.exitCode = 1;
});
