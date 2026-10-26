# GitHub Actions + Cloudflare Quick Tunnel Relay Pool

## Implementation brief for an AI coding agent

**Goal:** Build a temporary, restartable relay pool using one public
GitHub repository, four independent GitHub-hosted runners running relay
instances, and a fifth runner running a central round-robin gateway.
Each runner may expose its local HTTP server through a Cloudflare Quick
Tunnel (`*.trycloudflare.com`). The gateway exposes one client-facing
URL and forwards each authorized request to the next healthy relay.

> **Important operational and security constraints**
>
> -   This is a temporary demo/low-volume architecture, not production
>     hosting. GitHub-hosted runners are ephemeral, jobs have execution
>     limits, and Quick Tunnel URLs are temporary.
> -   Use this only for destinations you own or are explicitly
>     authorized to access. The relay must enforce an explicit hostname
>     allowlist and authentication; do not implement an
>     unrestricted/open proxy or use rotation to bypass a service's rate
>     limits, bans, or access controls.
> -   A public repository makes workflow definitions and ordinary logs
>     public. Never print credentials, authorization headers, request
>     bodies, or secrets. Do not put a long-lived personal access token
>     in source code.
> -   A fifth GitHub Actions runner is not automatically a permanent
>     endpoint. It needs its own Quick Tunnel, and it will stop when its
>     job ends.
> -   Four different runners do **not** guarantee four different public
>     egress IPs. GitHub-hosted runner IPs are dynamic/shared
>     infrastructure.
> -   Cloudflare Quick Tunnels are intended for testing and have no
>     uptime/SLA guarantee. The public URL may change after every
>     restart.

------------------------------------------------------------------------

## 1. Desired topology

``` text
Client
  |
  | HTTPS request to the single gateway URL
  v
Gateway Quick Tunnel (runner 5)
  |
  v
Round-robin gateway
  |         |         |         |
  v         v         v         v
Relay 1   Relay 2   Relay 3   Relay 4
Runner 1  Runner 2  Runner 3  Runner 4
  |         |         |         |
  +---------+---------+---------+
              |
              v
     Approved upstream service
```

Each relay has a separate runner and a separate Quick Tunnel. The
gateway keeps a list of the currently registered relay URLs and chooses
the next healthy relay for each request. The gateway itself has a fifth
Quick Tunnel URL that is given to the client.

## 2. Suggested repository layout

``` text
.
├── package.json
├── src/
│   ├── relay-server.mjs       # HTTP relay on runners 1–4
│   ├── gateway-server.mjs     # Round-robin gateway on runner 5
│   ├── tunnel.mjs             # Starts cloudflared and extracts URL
│   ├── registry.mjs           # Reads/writes relay registrations
│   ├── security.mjs           # Auth, allowlist, header filtering
│   └── config.mjs
├── scripts/
│   ├── run-relay.sh
│   └── run-gateway.sh
└── .github/
    └── workflows/
        └── relay-pool.yml
```

Use Node.js 20+ and ESM. Keep application code separate from workflow
orchestration so it can be tested locally.

## 3. Configuration contract

Required environment variables (supply secrets through GitHub Actions
Secrets, never hard-code them):

``` text
PORT=3000
RELAY_ID=relay-1                 # relay-1 through relay-4
RELAY_SHARED_TOKEN=<secret>
CLIENT_SHARED_TOKEN=<different-secret>
ALLOWED_HOSTS=api.example.com,service.example.org
REGISTRY_URL=<approved shared registry endpoint>
REGISTRY_TOKEN=<registry credential>
```

The allowlist should contain only upstream hostnames that you control or
are authorized to use. Validate the parsed URL's hostname against an
exact allowlist; do not use loose substring matching such as
`hostname.includes("example.com")`.

The registry must support: - `PUT /relays/:id` --- register
`{ url, expiresAt }` with authenticated write access. - `GET /relays`
--- return active registrations only. - `DELETE /relays/:id` --- remove
a registration when a relay shuts down. - Expiry/TTL so dead relay
entries disappear. - TLS in transit and authentication for writes.

**Registry design decision:** GitHub Actions job outputs/artifacts are
not a reliable live service-discovery mechanism for five long-running
independent jobs. Pick one shared registry that is available while all
jobs run. For a small proof of concept, an authenticated, short-TTL
registry endpoint you control is simplest. Do not assume a GitHub
Actions artifact can be updated and consumed as a live database. If the
registry is implemented using GitHub repository variables, use a
narrowly scoped credential, separate variable names per relay, and
account for API limits and public visibility of variable values in a
public repository.

## 4. Relay HTTP server

The following is a **safe skeleton** for an HTTP relay. It deliberately
requires an allowlisted target and a shared secret. Adapt the
request/response policy to the upstream API you are authorized to
access. Avoid forwarding hop-by-hop headers, host headers, or
credentials to an unintended host.

`src/relay-server.mjs`:

``` js
import http from "node:http";
import { URL } from "node:url";

const PORT = Number(process.env.PORT || 3000);
const RELAY_TOKEN = process.env.RELAY_SHARED_TOKEN;
const allowedHosts = new Set(
  (process.env.ALLOWED_HOSTS || "")
    .split(",")
    .map(s => s.trim().toLowerCase())
    .filter(Boolean)
);

if (!RELAY_TOKEN) throw new Error("RELAY_SHARED_TOKEN is required");
if (allowedHosts.size === 0) throw new Error("ALLOWED_HOSTS must be configured");

const blockedRequestHeaders = new Set([
  "host", "connection", "proxy-connection", "keep-alive",
  "transfer-encoding", "upgrade", "te", "trailer",
  "x-relay-target", "x-relay-path", "x-relay-token"
]);

function authorized(req) {
  return req.headers["x-relay-token"] === RELAY_TOKEN;
}

function buildTarget(req) {
  // Prefer a fixed, configured upstream in production.
  // If a target header is required, strictly validate its parsed hostname.
  const rawTarget = req.headers["x-relay-target"];
  if (typeof rawTarget !== "string") throw new Error("Missing target");

  const target = new URL(rawTarget);
  if (target.protocol !== "https:") throw new Error("Only HTTPS targets are allowed");
  if (target.username || target.password) throw new Error("URL credentials are forbidden");
  if (!allowedHosts.has(target.hostname.toLowerCase())) {
    throw new Error("Target hostname is not allowlisted");
  }

  const path = typeof req.headers["x-relay-path"] === "string"
    ? req.headers["x-relay-path"]
    : "/";
  if (!path.startsWith("/") || path.startsWith("//")) {
    throw new Error("Invalid relay path");
  }

  target.pathname = path;
  target.search = "";
  return target;
}

function filteredHeaders(headers) {
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value == null || blockedRequestHeaders.has(name.toLowerCase())) continue;
    // Do not forward client authorization/cookies unless your use case explicitly
    // requires them and you have implemented an explicit, safe policy.
    if (["authorization", "cookie", "proxy-authorization"].includes(name.toLowerCase())) continue;
    out[name] = value;
  }
  return out;
}

const server = http.createServer(async (req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ ok: true }));
  }

  if (!authorized(req)) {
    res.writeHead(401, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: "Unauthorized" }));
  }

  let target;
  try {
    target = buildTarget(req);
  } catch (err) {
    res.writeHead(400, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: "Invalid target or path" }));
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  req.on("close", () => controller.abort());

  try {
    const method = req.method || "GET";
    const bodyAllowed = !["GET", "HEAD"].includes(method);
    const upstream = await fetch(target, {
      method,
      headers: filteredHeaders(req.headers),
      body: bodyAllowed ? req : undefined,
      signal: controller.signal,
      // Node's fetch may require duplex for streaming request bodies.
      ...(bodyAllowed ? { duplex: "half" } : {})
    });

    const responseHeaders = new Headers(upstream.headers);
    for (const h of [
      "connection", "keep-alive", "transfer-encoding",
      "upgrade", "proxy-authenticate", "proxy-authorization"
    ]) responseHeaders.delete(h);

    res.writeHead(upstream.status, Object.fromEntries(responseHeaders.entries()));
    if (!upstream.body || method === "HEAD") return res.end();

    // Stream the upstream body rather than buffering an unbounded response.
    const reader = upstream.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!res.write(Buffer.from(value))) {
          await new Promise(resolve => res.once("drain", resolve));
        }
      }
      res.end();
    } finally {
      reader.releaseLock();
    }
  } catch {
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Upstream request failed" }));
    } else {
      res.destroy();
    }
  } finally {
    clearTimeout(timeout);
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Relay listening on port ${PORT}`);
});
```

**Agent must review this skeleton before production use.** Add
request-size limits, rate limiting, method restrictions, safer
path/query handling, response-header policy, and tests. Avoid accepting
arbitrary destinations. The code above is an implementation starting
point, not a complete hardened proxy.

## 5. Quick Tunnel lifecycle helper

The helper should start
`cloudflared tunnel --url http://127.0.0.1:<PORT>`, parse the generated
`https://....trycloudflare.com` URL from standard output, and emit only
that URL to the registration mechanism. Keep the `cloudflared` process
alive for the job lifetime.

Pseudo-implementation:

``` js
// src/tunnel.mjs — implementation outline
// 1. Spawn cloudflared with stdio piped.
// 2. Read stdout/stderr line-by-line.
// 3. Match only a URL ending in ".trycloudflare.com".
// 4. Resolve a promise when the URL is first seen.
// 5. Keep the child process alive; detect exit and report failure.
// 6. On SIGTERM/SIGINT, terminate cloudflared and unregister the relay.
// Never print tokens or request data.
```

Do not rely on an undocumented log line format without a timeout and
failure handling. If no URL appears within a reasonable startup window,
fail the job and emit a sanitized error.

## 6. Round-robin gateway behavior

`src/gateway-server.mjs` should:

1.  Expose `/health` and a single authenticated request endpoint.
2.  Fetch active relay registrations from the registry.
3.  Remove expired entries and optionally probe `/health` with a short
    timeout.
4.  Select the next relay using a shared in-memory index.
5.  Forward the request to that relay while adding the relay
    authentication header.
6.  Return the relay response status, permitted headers, and streamed
    body.
7.  Retry a different relay only when a connection fails **before a
    response is committed**. Do not blindly retry non-idempotent
    requests after a possible upstream execution.
8.  Return `503` if there are no healthy relays.
9.  Refresh the registry periodically, not on every request if that
    would overload it.

Round-robin selection outline:

``` js
let nextIndex = 0;

function chooseNextRelay(healthyRelays) {
  if (healthyRelays.length === 0) return null;
  const relay = healthyRelays[nextIndex % healthyRelays.length];
  nextIndex = (nextIndex + 1) % healthyRelays.length;
  return relay;
}
```

This index is local to one gateway process. That is sufficient for a
single gateway instance; it is not a distributed/global counter. A
gateway restart resets the index, which is acceptable for this temporary
setup.

The gateway must never accept an arbitrary relay URL from the client. It
must use only URLs from the authenticated registry and validate that
they are HTTPS URLs on the expected `trycloudflare.com` domain before
connecting.

## 7. Workflow orchestration

Create one workflow with four relay jobs and one gateway job, or use a
matrix for the four relay jobs. The four relay jobs and gateway job must
run concurrently. Do **not** make the gateway depend on the relay jobs
completing, because the relay jobs are long-running. Instead, each relay
registers its URL as soon as the tunnel starts; the gateway waits until
enough registrations exist or times out with a clear status.

Workflow requirements:

-   `workflow_dispatch` for manual starts.
-   `permissions: contents: read` unless another permission is genuinely
    needed.
-   Pin third-party Actions to reviewed full commit SHAs for production.
-   Install a supported Node.js version and `cloudflared`.
-   Start the local HTTP server, wait for `/health`, start the tunnel,
    register the URL, then keep the process alive.
-   Set a configurable lifetime of about five hours, leaving margin
    under the runner's maximum job duration.
-   On shutdown, unregister the relay and stop child processes.
-   Restarting jobs generates new URLs; update the registry with new URL
    and expiry.
-   The gateway publishes its URL through a safe mechanism. If the
    workflow logs are public, the URL itself is not a secret; tokens and
    credentials are.
-   Add concurrency controls to avoid accidentally launching many
    overlapping pools.

A conceptual YAML structure (the AI agent should complete and test it
against the chosen registry implementation):

``` yaml
name: Temporary Relay Pool

on:
  workflow_dispatch:

permissions:
  contents: read

concurrency:
  group: temporary-relay-pool
  cancel-in-progress: true

jobs:
  relay:
    strategy:
      fail-fast: false
      matrix:
        relay_id: [relay-1, relay-2, relay-3, relay-4]
    runs-on: ubuntu-latest
    timeout-minutes: 350
    steps:
      - uses: actions/checkout@v4 # Pin to a reviewed full SHA in final implementation
      - uses: actions/setup-node@v4 # Pin to a reviewed full SHA in final implementation
        with:
          node-version: 22
      - name: Install cloudflared
        run: |
          # Install the official cloudflared package/binary for this runner OS.
          # Verify the downloaded binary/package using the official published method.
          cloudflared --version
      - name: Start relay, register tunnel, and keep alive
        env:
          RELAY_ID: ${{ matrix.relay_id }}
          RELAY_SHARED_TOKEN: ${{ secrets.RELAY_SHARED_TOKEN }}
          ALLOWED_HOSTS: ${{ vars.ALLOWED_HOSTS }}
          REGISTRY_URL: ${{ vars.REGISTRY_URL }}
          REGISTRY_TOKEN: ${{ secrets.REGISTRY_TOKEN }}
        run: node scripts/run-relay.mjs

  gateway:
    runs-on: ubuntu-latest
    timeout-minutes: 350
    steps:
      - uses: actions/checkout@v4 # Pin to a reviewed full SHA in final implementation
      - uses: actions/setup-node@v4 # Pin to a reviewed full SHA in final implementation
        with:
          node-version: 22
      - name: Install cloudflared
        run: |
          # Install and verify the official cloudflared binary/package.
          cloudflared --version
      - name: Start gateway, publish tunnel, and keep alive
        env:
          CLIENT_SHARED_TOKEN: ${{ secrets.CLIENT_SHARED_TOKEN }}
          RELAY_SHARED_TOKEN: ${{ secrets.RELAY_SHARED_TOKEN }}
          REGISTRY_URL: ${{ vars.REGISTRY_URL }}
          REGISTRY_TOKEN: ${{ secrets.REGISTRY_TOKEN }}
        run: node scripts/run-gateway.mjs
```

This is a workflow outline, not a drop-in file: `scripts/run-relay.mjs`,
`scripts/run-gateway.mjs`, the registry API, and the official
`cloudflared` installation step must be implemented and tested together.
Do not use `sleep 18000` as the only lifecycle manager; supervise child
processes and handle termination.

## 8. Registry and URL publication

Implement a shared registry with a strict schema:

``` json
{
  "id": "relay-1",
  "url": "https://example.trycloudflare.com",
  "expiresAt": "2026-10-26T12:00:00.000Z",
  "lastHeartbeatAt": "2026-10-26T11:55:00.000Z"
}
```

Requirements: - Registration and heartbeat endpoints require
`REGISTRY_TOKEN`. - Relay IDs are restricted to `relay-1` through
`relay-4`. - URLs must use HTTPS and end with `.trycloudflare.com`. -
Set expiry to a short interval and refresh with heartbeats. - Never
store relay tokens in registry records. - The gateway URL is published
separately as a status/diagnostic value. - On every new workflow run,
replace stale registrations instead of keeping old URLs. - Avoid
printing credentials or full environment variables.

The coding agent must choose and document the registry implementation
before finalizing the workflow. A GitHub artifact is a run artifact, not
a live key-value store. A public repository variable can expose the URL
to anyone who can read the repository, which may be acceptable for a
temporary URL but is not acceptable for secrets.

## 9. Client request contract

Example request (the exact endpoint and target contract must be
documented by the agent):

``` bash
curl -X GET \
  "https://<gateway-id>.trycloudflare.com/relay" \
  -H "Authorization: Bearer <CLIENT_SHARED_TOKEN>" \
  -H "x-relay-target: https://api.example.com" \
  -H "x-relay-path: /v1/status"
```

The gateway authenticates the client, chooses a relay, and forwards the
request. The relay independently authenticates the gateway and validates
the target against its allowlist. Use a separate client token and
relay-to-relay token. For sensitive APIs, prefer a fixed upstream
configured on the server rather than a client-controlled target header.

Never put the token in a URL query string. Do not share tokens in a
public issue, commit, screenshot, or workflow log.

## 10. Failure handling and observability

Implement these behaviors:

-   `/health` returns a minimal JSON status and never reveals secrets.
-   Tunnel startup timeout produces a clear, sanitized error.
-   Registry outage means the relay cannot register; do not silently run
    unregistered.
-   Expired/unhealthy relays are removed from the selection pool.
-   No healthy relay returns `503 Service Unavailable`.
-   Invalid target returns `400`; missing/invalid authentication returns
    `401` or `403`.
-   Upstream timeout returns `504`; connection failure returns `502`.
-   Log relay ID, status code, elapsed time, and a request correlation
    ID only. Do not log authorization headers, cookies, body contents,
    or secrets.
-   Graceful shutdown unregisters the relay and terminates
    `cloudflared`.
-   A watchdog should detect if the local relay process or tunnel child
    dies and fail/restart the job according to the documented policy.

## 11. Testing checklist

Before using the public workflow, ask the coding agent to implement
automated tests for:

1.  Valid target on allowlist succeeds.
2.  Non-allowlisted host is rejected.
3.  `http:` target, URL credentials, malformed URL, and
    protocol-relative path are rejected.
4.  Missing or incorrect token is rejected.
5.  Hop-by-hop and sensitive headers are not forwarded.
6.  Round-robin sequence is relay-1, relay-2, relay-3, relay-4, then
    relay-1.
7.  Expired registrations are ignored.
8.  An unhealthy relay is skipped.
9.  Empty registry returns `503`.
10. A failed relay connection does not cause unsafe retries of
    non-idempotent requests.
11. Shutdown unregisters the relay and terminates the tunnel process.
12. Logs contain no secrets.

Use a mock upstream you control during tests. Do not test against
third-party systems without permission.

## 12. Runtime and lifecycle expectations

-   Four relay jobs + one gateway job means five GitHub-hosted runner
    jobs, each consuming Actions minutes.
-   Set a lifetime slightly below five hours (for example, 350 minutes)
    to leave shutdown margin.
-   The gateway can start before all relays register; it should expose
    `/health` and report "waiting for relays" through a non-sensitive
    status endpoint, or return `503` for relay requests until at least
    one relay is healthy.
-   The workflow should either fail clearly if the gateway tunnel never
    starts or publish the gateway URL only after it has been extracted
    and verified.
-   After the workflow restarts, the gateway URL and relay URLs will
    likely change. A client needs a way to discover the latest gateway
    URL (for example, a deliberately chosen status page or the
    workflow's latest run summary). Do not assume the previous URL will
    continue working.
-   Public Quick Tunnel URLs are not authentication. Keep authentication
    enabled even if the URL is hard to guess.

## 13. Definition of done for the AI coding agent

The implementation is complete only when:

-   [ ] Four independent relay jobs start successfully.
-   [ ] Each relay registers its own Quick Tunnel URL and refreshes its
    TTL.
-   [ ] The fifth job starts a gateway and its own Quick Tunnel.
-   [ ] The gateway discovers active relays from the shared registry.
-   [ ] Requests distribute round-robin across currently healthy relays.
-   [ ] The gateway does not accept client-supplied relay URLs.
-   [ ] Relay targets are restricted by exact hostname allowlist.
-   [ ] Both client-to-gateway and gateway-to-relay authentication are
    enforced.
-   [ ] Logs and GitHub summaries contain URLs/status only, never tokens
    or payloads.
-   [ ] All five jobs terminate cleanly before the runner time limit.
-   [ ] A restart replaces stale registrations and publishes the new
    gateway URL.
-   [ ] Unit tests and a complete end-to-end test against an owned mock
    upstream pass.
-   [ ] README documents setup, secrets/variables, costs/limits, restart
    behavior, and cleanup.

**Implementation order:** first build and test the registry, relay,
gateway, and tunnel helper locally; next test with one relay; then test
four relays and one gateway; only then enable the public workflow.
