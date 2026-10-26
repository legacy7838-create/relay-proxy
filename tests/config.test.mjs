import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.mjs";

const BASE_ENV = {
  PORT: "3000",
  LIFETIME_MINUTES: "330",
  ALLOWED_HOSTS: "API.example.com, service.example.org",
  RELAY_ID: "relay-2",
  RELAY_SHARED_TOKEN: "relay-secret-value",
  CLIENT_SHARED_TOKEN: "client-secret-value",
  GITHUB_REPOSITORY: "owner/repo",
  REGISTRY_ISSUE_NUMBER: "42",
  GITHUB_TOKEN: "github-token-value",
  GITHUB_API_URL: "https://api.github.com",
};

test("loadConfig builds relay configuration with safe defaults", () => {
  const config = loadConfig(BASE_ENV, "relay");
  assert.equal(config.service, "relay");
  assert.equal(config.port, 3000);
  assert.equal(config.relayId, "relay-2");
  assert.equal(config.relaySharedToken, "relay-secret-value");
  assert.deepEqual([...config.allowedHosts].sort(), [
    "api.example.com",
    "service.example.org",
  ]);
  assert.deepEqual([...config.allowedMethods].sort(), ["GET", "HEAD", "POST"]);
  assert.equal(config.githubRepository, "owner/repo");
  assert.equal(config.registryIssueNumber, 42);
  assert.equal(config.allowLocalTestTargets, false);
});

test("loadConfig requires the client token for the gateway", () => {
  const env = { ...BASE_ENV };
  delete env.CLIENT_SHARED_TOKEN;
  assert.throws(() => loadConfig(env, "gateway"), /CLIENT_SHARED_TOKEN is required/);
  assert.doesNotThrow(() => loadConfig(env, "relay"));
});

test("loadConfig rejects missing or invalid required values without echoing secrets", () => {
  const noHosts = { ...BASE_ENV };
  delete noHosts.ALLOWED_HOSTS;
  assert.throws(() => loadConfig(noHosts, "relay"), /ALLOWED_HOSTS is required/);

  assert.throws(
    () => loadConfig({ ...BASE_ENV, RELAY_ID: "relay-9" }, "relay"),
    /RELAY_ID/,
  );

  const noRelayToken = { ...BASE_ENV };
  delete noRelayToken.RELAY_SHARED_TOKEN;
  let message = "";
  try {
    loadConfig(noRelayToken, "relay");
  } catch (error) {
    message = error.message;
  }
  assert.match(message, /RELAY_SHARED_TOKEN is required/);
  assert.doesNotMatch(message, /client-secret-value|relay-secret-value/);

  assert.throws(
    () => loadConfig({ ...BASE_ENV, GITHUB_API_URL: "http://api.github.com" }, "relay"),
    /GITHUB_API_URL/,
  );
  assert.throws(
    () => loadConfig({ ...BASE_ENV, LIFETIME_MINUTES: "341" }, "relay"),
    /LIFETIME_MINUTES/,
  );
  assert.throws(
    () => loadConfig({ ...BASE_ENV, REGISTRY_ISSUE_NUMBER: "" }, "relay"),
    /REGISTRY_ISSUE_NUMBER is required/,
  );
});

test("loadConfig enforces registry TTL margin over heartbeat interval", () => {
  assert.throws(
    () =>
      loadConfig(
        {
          ...BASE_ENV,
          HEARTBEAT_INTERVAL_MS: "60000",
          REGISTRY_TTL_MS: "90000",
        },
        "relay",
      ),
    /REGISTRY_TTL_MS/,
  );
});
