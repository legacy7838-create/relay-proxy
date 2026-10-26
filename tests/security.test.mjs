import assert from "node:assert/strict";
import test from "node:test";
import {
  ValidationError,
  bearerToken,
  filterDownstreamResponseHeaders,
  filterUpstreamRequestHeaders,
  parseAllowlist,
  tokenMatches,
  validateRelayId,
  validateRelayUrl,
  validateTarget,
  validateTunnelUrl,
} from "../src/security.mjs";

const TARGET_OPTIONS = {
  allowedHosts: new Set(["api.example.com", "service.example.org"]),
  maxPathLength: 2048,
};

test("parseAllowlist normalizes and validates exact hostnames", () => {
  const hosts = parseAllowlist("API.Example.com, service.example.org ,,");
  assert.deepEqual([...hosts].sort(), ["api.example.com", "service.example.org"]);
  assert.throws(() => parseAllowlist(""), /ALLOWED_HOSTS/);
  assert.throws(() => parseAllowlist("https://api.example.com"), /invalid hostname/);
  assert.throws(() => parseAllowlist("bad host"), /invalid hostname/);
});

test("token comparison and bearer parsing", () => {
  assert.equal(tokenMatches("abc", "abc"), true);
  assert.equal(tokenMatches("abc", "abd"), false);
  assert.equal(tokenMatches("", ""), false);
  assert.equal(tokenMatches(undefined, "abc"), false);
  assert.equal(bearerToken("Bearer client-token"), "client-token");
  assert.equal(bearerToken("bearer client-token"), "client-token");
  assert.equal(bearerToken("Basic abc"), null);
  assert.equal(bearerToken("Bearer abc def"), null);
  assert.equal(bearerToken(["Bearer abc"]), null);
});

test("validateRelayId accepts only relay-1 through relay-4", () => {
  for (const id of ["relay-1", "relay-2", "relay-3", "relay-4"]) {
    assert.equal(validateRelayId(id), id);
  }
  for (const id of ["relay-0", "relay-5", "relay", "Relay-1", ""]) {
    assert.throws(() => validateRelayId(id), /RELAY_ID/);
  }
});

test("validateTarget accepts allowlisted HTTPS origins with a normalized path", () => {
  const result = validateTarget(
    {
      targetUrl: "https://api.example.com",
      relayPath: "/v1/status?include=all",
    },
    TARGET_OPTIONS,
  );
  assert.equal(result.origin, "https://api.example.com");
  assert.equal(result.path, "/v1/status?include=all");
});

test("validateTarget rejects insecure, credentialed, non-allowlisted, and non-origin targets", () => {
  const cases = [
    ["http://api.example.com", "/"],
    ["https://api.example.com:8443", "/"],
    ["https://user:pass@api.example.com", "/"],
    ["https://evil.example.com", "/"],
    ["https://api.example.com.evil.test", "/"],
    ["https://api.example.com/path", "/"],
    ["https://api.example.com?x=1", "/"],
    ["https://api.example.com#fragment", "/"],
    ["not a url", "/"],
    [undefined, "/"],
  ];

  for (const [targetUrl, relayPath] of cases) {
    assert.throws(
      () => validateTarget({ targetUrl, relayPath }, TARGET_OPTIONS),
      ValidationError,
      `${targetUrl} should be rejected`,
    );
  }
});

test("validateTarget rejects unsafe relay paths", () => {
  const paths = [
    "",
    "//evil.example.com",
    "http://evil.example.com",
    "/\\evil",
    "/a\tb",
    "/a#fragment",
    "no-leading-slash",
  ];
  for (const relayPath of paths) {
    assert.throws(
      () => validateTarget({ targetUrl: "https://api.example.com", relayPath }, TARGET_OPTIONS),
      ValidationError,
      `${JSON.stringify(relayPath)} should be rejected`,
    );
  }
});

test("validateTarget supports local test targets only when explicitly enabled", () => {
  const options = {
    allowedHosts: new Set(["127.0.0.1"]),
    allowLocalTestTargets: false,
  };
  assert.throws(
    () => validateTarget({ targetUrl: "http://127.0.0.1:8080", relayPath: "/" }, options),
    ValidationError,
  );

  const result = validateTarget(
    { targetUrl: "http://127.0.0.1:8080", relayPath: "/status" },
    { ...options, allowLocalTestTargets: true },
  );
  assert.equal(result.origin, "http://127.0.0.1:8080");
  assert.equal(result.path, "/status");
});

test("validateRelayUrl enforces HTTPS Quick Tunnel origins", () => {
  assert.equal(
    validateRelayUrl("https://happy-cat.trycloudflare.com").origin,
    "https://happy-cat.trycloudflare.com",
  );

  for (const url of [
    "http://happy-cat.trycloudflare.com",
    "https://happy-cat.trycloudflare.com/path",
    "https://happy-cat.trycloudflare.com:8443",
    "https://user:pass@happy-cat.trycloudflare.com",
    "https://happy-cat.trycloudflare.com.evil.test",
    "https://evil.test",
  ]) {
    assert.throws(() => validateRelayUrl(url), ValidationError, url);
  }
});

test("validateRelayUrl allows local origins only in test mode", () => {
  assert.throws(() => validateRelayUrl("http://127.0.0.1:3000"), ValidationError);
  assert.equal(
    validateRelayUrl("http://127.0.0.1:3000", { allowLocalTestTargets: true }).origin,
    "http://127.0.0.1:3000",
  );
});

test("validateTunnelUrl accepts only expected Quick Tunnel origins", () => {
  assert.equal(
    validateTunnelUrl("https://quick-tunnel.trycloudflare.com").origin,
    "https://quick-tunnel.trycloudflare.com",
  );
  assert.throws(
    () => validateTunnelUrl("https://quick-tunnel.trycloudflare.com/anything"),
    ValidationError,
  );
});

test("request header filtering removes hop-by-hop and sensitive headers", () => {
  const filtered = filterUpstreamRequestHeaders({
    host: "relay.local",
    connection: "keep-alive",
    "content-length": "3",
    authorization: "Bearer client",
    cookie: "session=1",
    "x-relay-token": "secret",
    "x-relay-target": "https://api.example.com",
    "x-relay-path": "/v1",
    "x-forwarded-for": "203.0.113.1",
    accept: "application/json",
    "content-type": "application/json",
  });

  assert.deepEqual(filtered, {
    accept: "application/json",
    "content-type": "application/json",
  });
});

test("response header filtering removes hop-by-hop and cookie headers", () => {
  const headers = new Map([
    ["content-type", "application/json"],
    ["set-cookie", "a=b"],
    ["connection", "keep-alive"],
    ["content-length", "2"],
    ["content-encoding", "gzip"],
    ["x-relay-id", "relay-1"],
  ]);
  const filtered = filterDownstreamResponseHeaders({ entries: () => headers.entries() });
  assert.deepEqual(filtered, {
    "content-type": "application/json",
    "x-relay-id": "relay-1",
  });
});
