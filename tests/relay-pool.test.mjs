import assert from "node:assert/strict";
import test from "node:test";
import { createRelayPool } from "../src/relay-pool.mjs";
import { jsonResponse, relayEntry, testConfig, testLogger } from "./helpers.mjs";

function registryWith(entries) {
  return {
    entries,
    async listEntries() {
      return this.entries;
    },
  };
}

function probeFetch(overrides = {}) {
  return async (url) => {
    const hostname = new URL(url).hostname;
    return overrides[hostname] ?? jsonResponse({ ok: true });
  };
}

test("relay pool refreshes only active, healthy, valid registrations", async () => {
  const { logger, lines } = testLogger();
  const now = Date.now();
  const registry = registryWith([
    relayEntry("relay-1"),
    relayEntry("relay-2"),
    relayEntry("relay-3", { url: "https://evil.example.com" }),
    relayEntry("relay-4", {
      expiresAt: new Date(now - 1_000).toISOString(),
      lastHeartbeatAt: new Date(now - 60_000).toISOString(),
    }),
    {
      kind: "gateway",
      id: "gateway",
      url: "https://gateway.trycloudflare.com",
      expiresAt: new Date(now + 60_000).toISOString(),
      lastHeartbeatAt: new Date(now).toISOString(),
    },
  ]);

  const pool = createRelayPool({
    registry,
    config: testConfig(),
    logger,
    fetchImpl: probeFetch(),
  });
  await pool.refresh();

  assert.deepEqual(
    pool.getRelays().map((entry) => entry.id),
    ["relay-1", "relay-2"],
  );
  const joined = lines.join("\n");
  assert.match(joined, /relay_url_rejected/);
});

test("relay pool round-robins in relay-1 through relay-4 order and wraps", async () => {
  const registry = registryWith([
    relayEntry("relay-1"),
    relayEntry("relay-2"),
    relayEntry("relay-3"),
    relayEntry("relay-4"),
  ]);
  const pool = createRelayPool({
    registry,
    config: testConfig(),
    logger: testLogger().logger,
    fetchImpl: probeFetch(),
  });
  await pool.refresh();

  const picks = [];
  for (let index = 0; index < 5; index += 1) picks.push(pool.pick().id);
  assert.deepEqual(picks, ["relay-1", "relay-2", "relay-3", "relay-4", "relay-1"]);
});

test("relay pool skips unhealthy relays and validates URLs", async () => {
  const registry = registryWith([
    relayEntry("relay-1"),
    relayEntry("relay-2"),
    relayEntry("relay-3"),
  ]);
  const pool = createRelayPool({
    registry,
    config: testConfig(),
    logger: testLogger().logger,
    fetchImpl: probeFetch({
      "relay-2.trycloudflare.com": jsonResponse({ ok: false }, 503),
    }),
  });
  await pool.refresh();

  assert.deepEqual(
    pool.getRelays().map((entry) => entry.id),
    ["relay-1", "relay-3"],
  );
  assert.equal(pool.pick().id, "relay-1");
  assert.equal(pool.pick().id, "relay-3");
});

test("relay pool returns no relay for an empty registry", async () => {
  const pool = createRelayPool({
    registry: registryWith([]),
    config: testConfig(),
    logger: testLogger().logger,
    fetchImpl: probeFetch(),
  });
  await pool.refresh();
  assert.equal(pool.pick(), null);
});

test("relay pool keeps last known relays until TTL expiry when the registry fails", async () => {
  let now = Date.now();
  const registry = {
    fail: false,
    entries: [
      relayEntry("relay-1", {
        expiresAt: new Date(now + 1_000).toISOString(),
        lastHeartbeatAt: new Date(now).toISOString(),
      }),
    ],
    async listEntries() {
      if (this.fail) throw new Error("registry down");
      return this.entries;
    },
  };
  const pool = createRelayPool({
    registry,
    config: testConfig(),
    logger: testLogger().logger,
    now: () => now,
    fetchImpl: probeFetch(),
  });
  await pool.refresh();
  assert.equal(pool.getRelays().length, 1);

  registry.fail = true;
  now += 2_000;
  await pool.refresh();
  assert.equal(pool.getRelays().length, 0);
  assert.equal(pool.getLastRefreshError(), "Error");
});

test("relay pool markUnhealthy removes a relay immediately", async () => {
  const registry = registryWith([relayEntry("relay-1"), relayEntry("relay-2")]);
  const pool = createRelayPool({
    registry,
    config: testConfig(),
    logger: testLogger().logger,
    fetchImpl: probeFetch(),
  });
  await pool.refresh();
  pool.markUnhealthy("relay-1");
  assert.deepEqual(
    pool.getRelays().map((entry) => entry.id),
    ["relay-2"],
  );
});
