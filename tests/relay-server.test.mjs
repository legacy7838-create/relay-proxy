import assert from "node:assert/strict";
import test from "node:test";
import { createRelayServer } from "../src/relay-server.mjs";
import {
  RELAY_TOKEN,
  fakeUpstreamResponse,
  httpJson,
  startTestServer,
  stopTestServer,
  testConfig,
  testLogger,
} from "./helpers.mjs";

async function withRelay(options, run) {
  const { logger, lines } = testLogger();
  const config = testConfig(options);
  const upstreamCalls = [];
  const fetchImpl =
    options.fetchImpl ??
    (async (url, init) => {
      upstreamCalls.push({ url: new URL(url), init });
      return fakeUpstreamResponse({
        body: "upstream-ok",
        headers: { "content-type": "text/plain", "set-cookie": "a=b" },
      });
    });

  const server = createRelayServer({ config, logger, fetchImpl });
  const port = await startTestServer(server);
  try {
    await run({ port, config, upstreamCalls, logger, lines });
  } finally {
    await stopTestServer(server);
  }
}

test("relay health endpoint is public and minimal", async () => {
  await withRelay({}, async ({ port }) => {
    const { response, json } = await httpJson(`http://127.0.0.1:${port}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(json, { ok: true, role: "relay", id: "relay-1" });
  });
});

test("relay rejects missing and incorrect relay tokens", async () => {
  await withRelay({}, async ({ port, upstreamCalls }) => {
    const missing = await httpJson(`http://127.0.0.1:${port}/relay`, {
      headers: { "x-relay-target": "https://upstream.test", "x-relay-path": "/" },
    });
    assert.equal(missing.response.status, 401);

    const wrong = await httpJson(`http://127.0.0.1:${port}/relay`, {
      headers: {
        "x-relay-token": "wrong",
        "x-relay-target": "https://upstream.test",
        "x-relay-path": "/",
      },
    });
    assert.equal(wrong.response.status, 401);
    assert.equal(upstreamCalls.length, 0);
  });
});

test("relay forwards an allowlisted request and filters sensitive headers", async () => {
  await withRelay({}, async ({ port, upstreamCalls }) => {
    const { response, text } = await httpJson(`http://127.0.0.1:${port}/relay`, {
      method: "POST",
      headers: {
        "x-relay-token": RELAY_TOKEN,
        "x-relay-target": "https://upstream.test",
        "x-relay-path": "/v1/status?include=all",
        authorization: "Bearer client-secret",
        cookie: "session=abc",
        "content-type": "application/json",
        "x-forwarded-for": "203.0.113.9",
      },
      body: JSON.stringify({ hello: "world" }),
    });

    assert.equal(response.status, 200);
    assert.equal(text, "upstream-ok");
    assert.equal(response.headers.get("x-relay-id"), "relay-1");
    assert.equal(response.headers.get("set-cookie"), null);
    assert.equal(response.headers.get("content-length"), null);

    assert.equal(upstreamCalls.length, 1);
    const [{ url, init }] = upstreamCalls;
    assert.equal(url.href, "https://upstream.test/v1/status?include=all");
    assert.equal(Buffer.from(init.body).toString(), JSON.stringify({ hello: "world" }));
    assert.equal(init.redirect, "manual");
    assert.equal(init.headers.authorization, undefined);
    assert.equal(init.headers.cookie, undefined);
    assert.equal(init.headers.host, undefined);
    assert.equal(init.headers["x-relay-token"], undefined);
    assert.equal(init.headers["x-relay-target"], undefined);
    assert.equal(init.headers["x-relay-path"], undefined);
    assert.equal(init.headers["x-forwarded-for"], undefined);
    assert.equal(init.headers["content-type"], "application/json");
  });
});

test("relay rejects unsafe targets and paths without forwarding", async () => {
  const cases = [
    { target: "http://upstream.test", path: "/" },
    { target: "https://upstream.test:8443", path: "/" },
    { target: "https://user:pass@upstream.test", path: "/" },
    { target: "https://evil.test", path: "/" },
    { target: "https://upstream.test/path", path: "/" },
    { target: undefined, path: "/" },
    { target: "https://upstream.test", path: "//evil.test" },
    { target: "https://upstream.test", path: "http://evil.test" },
    { target: "https://upstream.test", path: "/\\evil" },
    { target: "https://upstream.test", path: "/a#fragment" },
    { target: "https://upstream.test", path: "" },
  ];

  await withRelay({}, async ({ port, upstreamCalls }) => {
    for (const entry of cases) {
      const headers = { "x-relay-token": RELAY_TOKEN };
      if (entry.target !== undefined) headers["x-relay-target"] = entry.target;
      headers["x-relay-path"] = entry.path;

      const { response } = await httpJson(`http://127.0.0.1:${port}/relay`, { headers });
      assert.equal(response.status, 400, JSON.stringify(entry));
    }
    assert.equal(upstreamCalls.length, 0);
  });
});

test("relay enforces method allowlist and body size limit", async () => {
  await withRelay({ requestBodyLimitBytes: 1024 }, async ({ port, upstreamCalls }) => {
    const notAllowed = await httpJson(`http://127.0.0.1:${port}/relay`, {
      method: "DELETE",
      headers: {
        "x-relay-token": RELAY_TOKEN,
        "x-relay-target": "https://upstream.test",
        "x-relay-path": "/",
      },
    });
    assert.equal(notAllowed.response.status, 405);

    const tooLarge = await httpJson(`http://127.0.0.1:${port}/relay`, {
      method: "POST",
      headers: {
        "x-relay-token": RELAY_TOKEN,
        "x-relay-target": "https://upstream.test",
        "x-relay-path": "/",
        "content-type": "text/plain",
      },
      body: "x".repeat(2048),
    });
    assert.equal(tooLarge.response.status, 413);
    assert.equal(upstreamCalls.length, 0);
  });
});

test("relay maps upstream timeouts to 504 and connection failures to 502", async () => {
  const timeoutFetch = (_url, init) =>
    new Promise((_resolve, reject) => {
      const error = new Error("aborted");
      error.name = "AbortError";
      init.signal.addEventListener("abort", () => reject(error), { once: true });
    });

  await withRelay({ upstreamTimeoutMs: 25, fetchImpl: timeoutFetch }, async ({ port }) => {
    const { response } = await httpJson(`http://127.0.0.1:${port}/relay`, {
      headers: {
        "x-relay-token": RELAY_TOKEN,
        "x-relay-target": "https://upstream.test",
        "x-relay-path": "/",
      },
    });
    assert.equal(response.status, 504);
  });

  const failingFetch = async () => {
    throw new TypeError("fetch failed");
  };
  await withRelay({ fetchImpl: failingFetch }, async ({ port }) => {
    const { response } = await httpJson(`http://127.0.0.1:${port}/relay`, {
      headers: {
        "x-relay-token": RELAY_TOKEN,
        "x-relay-target": "https://upstream.test",
        "x-relay-path": "/",
      },
    });
    assert.equal(response.status, 502);
  });
});

test("relay handles HEAD without streaming a body", async () => {
  await withRelay({}, async ({ port, upstreamCalls }) => {
    const { response, text } = await httpJson(`http://127.0.0.1:${port}/relay`, {
      method: "HEAD",
      headers: {
        "x-relay-token": RELAY_TOKEN,
        "x-relay-target": "https://upstream.test",
        "x-relay-path": "/status",
      },
    });
    assert.equal(response.status, 200);
    assert.equal(text, "");
    assert.equal(upstreamCalls[0].init.method, "HEAD");
  });
});

test("relay logs do not contain tokens, headers, payloads, or paths", async () => {
  await withRelay({}, async ({ port, lines }) => {
    const body = JSON.stringify({ private: "payload-value" });
    const { response } = await httpJson(`http://127.0.0.1:${port}/relay`, {
      method: "POST",
      headers: {
        "x-relay-token": RELAY_TOKEN,
        "x-relay-target": "https://upstream.test",
        "x-relay-path": "/secret-path?token=should-not-log",
        authorization: "Bearer client-test-token",
        "content-type": "application/json",
      },
      body,
    });
    assert.equal(response.status, 200);

    const joined = lines.join("\n");
    assert.ok(lines.length > 0);
    assert.doesNotMatch(joined, new RegExp(RELAY_TOKEN));
    assert.doesNotMatch(joined, /client-test-token/);
    assert.doesNotMatch(joined, /payload-value/);
    assert.doesNotMatch(joined, /secret-path/);
    assert.doesNotMatch(joined, /should-not-log/);
    assert.match(joined, /upstream\.test/);
  });
});
