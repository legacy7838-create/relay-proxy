import assert from "node:assert/strict";
import test from "node:test";
import { startGatewayRuntime } from "../src/gateway-runtime.mjs";
import { startRelayRuntime } from "../src/relay-runtime.mjs";
import { testConfig, testLogger } from "./helpers.mjs";

function makeRegistry(entries = []) {
  return {
    entries,
    registrations: [],
    removals: [],
    failRegister: false,
    async listEntries() {
      return this.entries;
    },
    async register(entry) {
      if (this.failRegister) throw new Error("registry unavailable");
      this.registrations.push(entry);
      return 1;
    },
    async remove(kind, id) {
      this.removals.push({ kind, id });
      return true;
    },
  };
}

function makeTunnelFactory(store) {
  return async ({ port, onUnexpectedExit }) => {
    store.url = `http://127.0.0.1:${port}`;
    store.onUnexpectedExit = onUnexpectedExit;
    return {
      get url() {
        return store.url;
      },
      async stop() {
        store.stopped = true;
      },
    };
  };
}

test("relay runtime registers on start and unregisters before exiting", async () => {
  const { logger } = testLogger();
  const registry = makeRegistry();
  const store = { stopped: false };
  const config = testConfig({
    allowLocalTestTargets: true,
    registryRegisterAttempts: 1,
    heartbeatIntervalMs: 60_000,
  });

  const runtime = await startRelayRuntime({
    config,
    logger,
    registry,
    fetchImpl: async () => {
      throw new Error("upstream not used");
    },
    tunnelFactory: makeTunnelFactory(store),
  });

  assert.equal(runtime.relayId, "relay-1");
  assert.equal(registry.registrations.length, 1);
  assert.equal(registry.registrations[0].kind, "relay");
  assert.equal(registry.registrations[0].id, "relay-1");
  assert.match(registry.registrations[0].url, /^http:\/\/127\.0\.0\.1:/);

  const code = await runtime.shutdown("test_complete", 0);
  assert.equal(code, 0);
  assert.equal(store.stopped, true);
  assert.deepEqual(registry.removals, [{ kind: "relay", id: "relay-1" }]);
  assert.equal(runtime.server.listening, false);
  assert.equal(await runtime.done, 0);
});

test("relay runtime shuts down with failure when the tunnel exits unexpectedly", async () => {
  const { logger } = testLogger();
  const registry = makeRegistry();
  const store = { stopped: false };
  const config = testConfig({
    allowLocalTestTargets: true,
    registryRegisterAttempts: 1,
    heartbeatIntervalMs: 60_000,
  });

  const runtime = await startRelayRuntime({
    config,
    logger,
    registry,
    tunnelFactory: makeTunnelFactory(store),
  });

  store.onUnexpectedExit();
  const code = await runtime.done;

  assert.equal(code, 1);
  assert.equal(store.stopped, true);
  assert.deepEqual(registry.removals, [{ kind: "relay", id: "relay-1" }]);
  assert.equal(runtime.server.listening, false);
});

test("relay runtime fails and cleans up when it cannot register", async () => {
  const { logger } = testLogger();
  const registry = makeRegistry();
  registry.failRegister = true;
  const store = { stopped: false };
  const config = testConfig({
    allowLocalTestTargets: true,
    registryRegisterAttempts: 2,
    registryRegisterRetryMs: 1,
  });

  await assert.rejects(
    startRelayRuntime({
      config,
      logger,
      registry,
      tunnelFactory: makeTunnelFactory(store),
    }),
    /Unable to register in the shared registry/,
  );

  assert.equal(store.stopped, true);
  assert.deepEqual(registry.removals, []);
});

test("gateway runtime registers its URL and removes it on shutdown", async () => {
  const { logger } = testLogger();
  const registry = makeRegistry();
  const store = { stopped: false };
  const config = testConfig({
    service: "gateway",
    allowLocalTestTargets: true,
    registryRegisterAttempts: 1,
    heartbeatIntervalMs: 60_000,
    registryRefreshIntervalMs: 60_000,
  });

  const runtime = await startGatewayRuntime({
    config,
    logger,
    registry,
    fetchImpl: async () => {
      throw new Error("no relays expected");
    },
    tunnelFactory: makeTunnelFactory(store),
    verifyPublicHealth: async () => undefined,
  });

  assert.equal(registry.registrations.length, 1);
  assert.equal(registry.registrations[0].kind, "gateway");
  assert.equal(registry.registrations[0].id, "gateway");

  const code = await runtime.shutdown("test_complete", 0);
  assert.equal(code, 0);
  assert.equal(store.stopped, true);
  assert.deepEqual(registry.removals, [{ kind: "gateway", id: "gateway" }]);
  assert.equal(runtime.server.listening, false);
  assert.equal(await runtime.done, 0);
});
