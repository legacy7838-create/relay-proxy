import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { createGatewayServer } from "../src/gateway-server.mjs";
import { createRelayPool } from "../src/relay-pool.mjs";
import { createRelayServer } from "../src/relay-server.mjs";
import {
  CLIENT_TOKEN,
  RELAY_TOKEN,
  httpJson,
  startTestServer,
  stopTestServer,
  testConfig,
  testLogger,
} from "./helpers.mjs";

test("end-to-end: gateway authenticates, targets an allowlisted mock upstream, and round-robins", async (t) => {
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          method: req.method,
          path: req.url,
          body: raw === "" ? null : JSON.parse(raw),
        }),
      );
    });
  });
  const upstreamPort = await startTestServer(upstream);

  const relayConfigs = ["relay-1", "relay-2"].map((relayId) =>
    testConfig({
      relayId,
      allowLocalTestTargets: true,
      allowedHosts: new Set(["127.0.0.1"]),
      upstreamTimeoutMs: 3_000,
    }),
  );
  const relayServers = relayConfigs.map((config) =>
    createRelayServer({ config, logger: testLogger().logger }),
  );
  const relayPorts = [];
  for (const server of relayServers) relayPorts.push(await startTestServer(server));

  let gatewayServer = null;

  t.after(async () => {
    if (gatewayServer) await stopTestServer(gatewayServer);
    for (const server of relayServers) await stopTestServer(server);
    await stopTestServer(upstream);
  });

  const now = Date.now();
  const entries = relayPorts.map((port, index) => ({
    kind: "relay",
    id: `relay-${index + 1}`,
    url: `http://127.0.0.1:${port}`,
    expiresAt: new Date(now + 60_000).toISOString(),
    lastHeartbeatAt: new Date(now).toISOString(),
    commentId: index + 1,
  }));
  const registry = {
    async listEntries() {
      return entries;
    },
  };

  const gatewayConfig = testConfig({
    service: "gateway",
    allowLocalTestTargets: true,
    allowedHosts: new Set(["127.0.0.1"]),
    probeTimeoutMs: 1_000,
    upstreamTimeoutMs: 3_000,
  });
  const pool = createRelayPool({
    registry,
    config: gatewayConfig,
    logger: testLogger().logger,
  });
  await pool.refresh();
  assert.equal(pool.getRelays().length, 2);

  gatewayServer = createGatewayServer({
    config: gatewayConfig,
    logger: testLogger().logger,
    pool,
  });
  const gatewayPort = await startTestServer(gatewayServer);
  const gatewayUrl = `http://127.0.0.1:${gatewayPort}/relay`;
  const target = `http://127.0.0.1:${upstreamPort}`;

  const unauthorized = await httpJson(gatewayUrl, {
    headers: {
      authorization: "Bearer wrong-token",
      "x-relay-target": target,
      "x-relay-path": "/hello",
    },
  });
  assert.equal(unauthorized.response.status, 401);

  const blockedTarget = await httpJson(gatewayUrl, {
    headers: {
      authorization: `Bearer ${CLIENT_TOKEN}`,
      "x-relay-target": "https://evil.test",
      "x-relay-path": "/hello",
    },
  });
  assert.equal(blockedTarget.response.status, 400);

  const first = await httpJson(gatewayUrl, {
    headers: {
      authorization: `Bearer ${CLIENT_TOKEN}`,
      "x-relay-target": target,
      "x-relay-path": "/hello?x=1",
    },
  });
  assert.equal(first.response.status, 200);
  assert.equal(first.response.headers.get("x-relay-selected"), "relay-1");
  assert.deepEqual(first.json, { method: "GET", path: "/hello?x=1", body: null });

  const second = await httpJson(gatewayUrl, {
    headers: {
      authorization: `Bearer ${CLIENT_TOKEN}`,
      "x-relay-target": target,
      "x-relay-path": "/hello?x=2",
    },
  });
  assert.equal(second.response.status, 200);
  assert.equal(second.response.headers.get("x-relay-selected"), "relay-2");
  assert.deepEqual(second.json, { method: "GET", path: "/hello?x=2", body: null });

  const post = await httpJson(gatewayUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${CLIENT_TOKEN}`,
      "x-relay-target": target,
      "x-relay-path": "/echo",
      "content-type": "application/json",
    },
    body: JSON.stringify({ hello: "e2e" }),
  });
  assert.equal(post.response.status, 200);
  assert.equal(post.response.headers.get("x-relay-selected"), "relay-1");
  assert.deepEqual(post.json, {
    method: "POST",
    path: "/echo",
    body: { hello: "e2e" },
  });

  const direct = await httpJson(`http://127.0.0.1:${relayPorts[0]}/relay`, {
    headers: {
      "x-relay-target": target,
      "x-relay-path": "/hello",
    },
  });
  assert.equal(direct.response.status, 401);

  const directWithToken = await httpJson(`http://127.0.0.1:${relayPorts[0]}/relay`, {
    headers: {
      "x-relay-token": RELAY_TOKEN,
      "x-relay-target": target,
      "x-relay-path": "/direct",
    },
  });
  assert.equal(directWithToken.response.status, 200);
  assert.deepEqual(directWithToken.json, { method: "GET", path: "/direct", body: null });
});
