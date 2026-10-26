import { createLogger } from "../src/logger.mjs";

export const RELAY_TOKEN = "relay-test-token";
export const CLIENT_TOKEN = "client-test-token";

export function testConfig(overrides = {}) {
  return {
    service: "relay",
    port: 0,
    relayId: "relay-1",
    relaySharedToken: RELAY_TOKEN,
    clientSharedToken: CLIENT_TOKEN,
    allowedHosts: new Set(["upstream.test"]),
    allowedMethods: new Set(["GET", "HEAD", "POST"]),
    maxPathLength: 2048,
    requestBodyLimitBytes: 4096,
    upstreamTimeoutMs: 1000,
    probeTimeoutMs: 500,
    rateLimitPerMinute: 0,
    allowLocalTestTargets: false,
    registryTtlMs: 120_000,
    heartbeatIntervalMs: 30_000,
    lifetimeMinutes: 330,
    registryRefreshIntervalMs: 30_000,
    tunnelStartTimeoutMs: 1000,
    registryRegisterAttempts: 3,
    registryRegisterRetryMs: 10,
    verifyAttempts: 2,
    verifyRetryMs: 10,
    cloudflaredBinary: "cloudflared",
    githubRepository: "owner/repo",
    registryIssueNumber: 1,
    githubApiUrl: "https://api.github.test",
    registryActorLogin: "github-actions[bot]",
    ...overrides,
  };
}

export function testLogger() {
  const lines = [];
  const logger = createLogger({ service: "test", sink: (line) => lines.push(line) });
  return { lines, logger };
}

export function startTestServer(server) {
  return new Promise((resolve, reject) => {
    function onError(error) {
      server.off("listening", onListening);
      reject(error);
    }
    function onListening() {
      server.off("error", onError);
      resolve(server.address().port);
    }
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });
}

export function stopTestServer(server) {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
}

export function jsonResponse(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export function fakeUpstreamResponse({ status = 200, headers = {}, body = "" } = {}) {
  const headerMap = new Map(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), String(value)]),
  );
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { entries: () => headerMap.entries() },
    body: body === "" ? null : new Blob([body]).stream(),
    async json() {
      return JSON.parse(body);
    },
  };
}

export function relayEntry(id, overrides = {}) {
  const now = Date.now();
  return {
    kind: "relay",
    id,
    url: `https://${id}.trycloudflare.com`,
    expiresAt: new Date(now + 60_000).toISOString(),
    lastHeartbeatAt: new Date(now).toISOString(),
    ...overrides,
  };
}

export async function httpJson(url, options = {}) {
  const response = await fetch(url, {
    redirect: "manual",
    ...options,
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // Non-JSON bodies are returned as text.
  }
  return { response, text, json };
}
