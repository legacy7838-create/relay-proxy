import assert from "node:assert/strict";
import test from "node:test";
import { createGatewayServer } from "../src/gateway-server.mjs";
import { createRelayPool } from "../src/relay-pool.mjs";
import {
  CLIENT_TOKEN,
  RELAY_TOKEN,
  fakeUpstreamResponse,
  httpJson,
  jsonResponse,
  relayEntry,
  startTestServer,
  stopTestServer,
  testConfig,
  testLogger,
} from "./helpers.mjs";

async function withGateway(options, run) {
  const { entries = [relayEntry("relay-1")], configOverrides = {}, relayHandler, probeHandler } =
    options;
  const { logger, lines } = testLogger();
  const registry = {
    async listEntries() {
      return entries;
    },
  };
  const config = testConfig({
    service: "gateway",
    allowedHosts: new Set(["upstream.test"]),
    ...configOverrides,
  });
  const relayCalls = [];
  const probeCalls = [];

  const fetchImpl = async (url, init) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/health") {
      probeCalls.push(parsed.hostname);
      return probeHandler ? probeHandler(parsed, init) : jsonResponse({ ok: true });
    }
    relayCalls.push({ url: parsed, init });
    if (relayHandler) return relayHandler(parsed, init);
    return fakeUpstreamResponse({
      body: JSON.stringify({
        relay: parsed.hostname,
        path: init.headers["x-relay-path"],
        target: init.headers["x-relay-target"],
      }),
      headers: {
        "content-type": "application/json",
        "set-cookie": "session=upstream",
        "x-relay-id": parsed.hostname.split(".")[0],
      },
    });
  };

  const pool = createRelayPool({ registry, config, logger, fetchImpl });
  await pool.refresh();
  const server = createGatewayServer({ config, logger, pool, fetchImpl });
  const port = await startTestServer(server);

  try {
    await run({ port, pool, config, logger, lines, relayCalls, probeCalls, registry });
  } finally {
    await stopTestServer(server);
  }
}

function gatewayRequest(port, { headers = {}, method = "GET", body, authorization } = {}) {
  const requestHeaders = {
    "x-relay-target": "https://upstream.test",
    "x-relay-path": "/",
    ...headers,
  };
  if (authorization !== null) {
    requestHeaders.authorization = authorization ?? `Bearer ${CLIENT_TOKEN}`;
  }
  return httpJson(`http://127.0.0.1:${port}/relay`, { method, headers: requestHeaders, body });
}

test("gateway health reports relay count without authentication", async () => {
  await withGateway({ entries: [relayEntry("relay-1"), relayEntry("relay-2")] }, async ({ port }) => {
    const { response, json } = await httpJson(`http://127.0.0.1:${port}/health`);
    assert.equal(response.status, 200);
    assert.equal(json.ok, true);
    assert.equal(json.role, "gateway");
    assert.equal(json.relayCount, 2);
    assert.equal(json.waitingForRelays, false);
  });
});

test("gateway rejects missing and incorrect client tokens", async () => {
  await withGateway({}, async ({ port, relayCalls }) => {
    const missing = await gatewayRequest(port, { authorization: null });
    assert.equal(missing.response.status, 401);

    const wrong = await gatewayRequest(port, { authorization: "Bearer wrong-token" });
    assert.equal(wrong.response.status, 401);
    assert.equal(relayCalls.length, 0);
  });
});

test("gateway rejects a target outside the exact allowlist", async () => {
  await withGateway({}, async ({ port, relayCalls }) => {
    const { response } = await gatewayRequest(port, {
      headers: { "x-relay-target": "https://evil.test" },
    });
    assert.equal(response.status, 400);
    assert.equal(relayCalls.length, 0);
  });
});

test("gateway distributes requests round-robin across healthy relays", async () => {
  await withGateway(
    {
      entries: [
        relayEntry("relay-1"),
        relayEntry("relay-2"),
        relayEntry("relay-3"),
        relayEntry("relay-4"),
      ],
    },
    async ({ port, relayCalls }) => {
      const selected = [];
      for (let index = 0; index < 4; index += 1) {
        const { response, json } = await gatewayRequest(port, {
          headers: { "x-relay-path": "/v1/status?include=all" },
        });
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("set-cookie"), null);
        assert.equal(response.headers.get("x-relay-selected"), `relay-${index + 1}`);
        assert.equal(json.relay, `relay-${index + 1}.trycloudflare.com`);
        assert.equal(json.path, "/v1/status?include=all");
        assert.equal(json.target, "https://upstream.test");
        selected.push(response.headers.get("x-relay-selected"));
      }
      assert.deepEqual(selected, ["relay-1", "relay-2", "relay-3", "relay-4"]);

      for (const call of relayCalls) {
        assert.equal(call.init.headers["x-relay-token"], RELAY_TOKEN);
        assert.equal(call.init.headers.authorization, undefined);
        assert.equal(call.init.headers["x-relay-target"], "https://upstream.test");
        assert.equal(call.init.headers["x-relay-path"], "/v1/status?include=all");
      }
    },
  );
});

test("gateway ignores client-supplied relay URLs", async () => {
  await withGateway({}, async ({ port, relayCalls }) => {
    const { response } = await gatewayRequest(port, {
      headers: {
        "x-relay-url": "https://evil.test",
        "x-relay-target": "https://evil.test",
        "x-relay-target-override": "https://evil.test",
      },
    });
    assert.equal(response.status, 400);
    assert.equal(relayCalls.length, 0);

    const ok = await gatewayRequest(port, {
      headers: { "x-relay-url": "https://evil.test", "x-relay-selected": "relay-9" },
    });
    assert.equal(ok.response.status, 200);
    assert.equal(relayCalls.length, 1);
    assert.equal(relayCalls[0].url.hostname, "relay-1.trycloudflare.com");
  });
});

test("gateway returns 503 when no healthy relays are registered", async () => {
  await withGateway({ entries: [] }, async ({ port, relayCalls }) => {
    const { response, json } = await gatewayRequest(port);
    assert.equal(response.status, 503);
    assert.equal(json.error, "No healthy relays");
    assert.equal(response.headers.get("retry-after"), "5");
    assert.equal(relayCalls.length, 0);
  });
});

test("gateway does not retry a failed non-idempotent request", async () => {
  await withGateway(
    {
      entries: [relayEntry("relay-1"), relayEntry("relay-2")],
      relayHandler: async () => {
        throw new TypeError("connection reset");
      },
    },
    async ({ port, relayCalls }) => {
      const { response } = await gatewayRequest(port, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "create" }),
      });
      assert.equal(response.status, 502);
      assert.equal(relayCalls.length, 1);
    },
  );
});

test("gateway retries a failed idempotent request on another relay", async () => {
  await withGateway(
    {
      entries: [relayEntry("relay-1"), relayEntry("relay-2")],
      relayHandler: async (url) => {
        if (url.hostname === "relay-1.trycloudflare.com") {
          throw new TypeError("connection reset");
        }
        return fakeUpstreamResponse({
          body: "second-relay-ok",
          headers: { "content-type": "text/plain" },
        });
      },
    },
    async ({ port, relayCalls }) => {
      const { response, text } = await gatewayRequest(port);
      assert.equal(response.status, 200);
      assert.equal(text, "second-relay-ok");
      assert.equal(response.headers.get("x-relay-selected"), "relay-2");
      assert.equal(relayCalls.length, 2);
      assert.deepEqual(
        relayCalls.map((call) => call.url.hostname),
        ["relay-1.trycloudflare.com", "relay-2.trycloudflare.com"],
      );
    },
  );
});

test("gateway returns 504 when a relay does not respond in time", async () => {
  await withGateway(
    {
      entries: [relayEntry("relay-1")],
      configOverrides: { upstreamTimeoutMs: 25 },
      relayHandler: (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        }),
    },
    async ({ port, relayCalls }) => {
      const { response } = await gatewayRequest(port);
      assert.equal(response.status, 504);
      assert.equal(relayCalls.length, 1);
    },
  );
});

test("gateway enforces method allowlist and rate limiting", async () => {
  await withGateway({ configOverrides: { rateLimitPerMinute: 1 } }, async ({ port }) => {
    const notAllowed = await gatewayRequest(port, { method: "DELETE" });
    assert.equal(notAllowed.response.status, 405);

    const first = await gatewayRequest(port);
    assert.equal(first.response.status, 200);

    const second = await gatewayRequest(port);
    assert.equal(second.response.status, 429);
    assert.match(second.response.headers.get("retry-after"), /^\d+$/);
  });
});

test("gateway logs do not contain client tokens or relay tokens", async () => {
  await withGateway({}, async ({ port, lines }) => {
    await gatewayRequest(port);
    const joined = lines.join("\n");
    assert.ok(lines.length > 0);
    assert.doesNotMatch(joined, new RegExp(CLIENT_TOKEN));
    assert.doesNotMatch(joined, new RegExp(RELAY_TOKEN));
  });
});
