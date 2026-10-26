# relay-proxy

Temporary, restartable relay pool built from **one public GitHub repository**, **four
GitHub-hosted runners** running relay instances, and a **fifth runner** running a
round-robin gateway. Each runner exposes its local HTTP server through a Cloudflare
Quick Tunnel (`*.trycloudflare.com`). Clients talk to the single gateway URL; the
gateway forwards authorized requests to the next healthy relay.

This repository implements the design brief in
[`github-actions-cloudflare-relay-pool-architecture.md`](./github-actions-cloudflare-relay-pool-architecture.md),
with a GitHub-issue-backed registry instead of an external registry service.

> **This is a temporary demo/low-volume architecture, not production hosting.**
> GitHub runners are ephemeral, jobs have hard time limits, Quick Tunnel URLs are
> temporary and have no SLA, and four runners do not guarantee four different public
> egress IPs. Use it only for destinations you own or are explicitly authorized to
> access. The relay enforces an exact hostname allowlist and authentication; do not
> turn it into an open proxy or use it to bypass rate limits, bans, or access controls.
>
> The repository is public. Workflow definitions, logs, the registry issue, and
> temporary tunnel URLs are public. Tokens are never written to source, logs, comments,
> or summaries. Still, only use upstream services you are allowed to access.

## Topology

```text
Client
  |
  | HTTPS + Bearer CLIENT_SHARED_TOKEN
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
     Allowlisted upstream service
```

Each relay and the gateway each get their own Quick Tunnel. A fifth GitHub Actions job
runs the gateway round-robin logic. The gateway only uses relay URLs that it reads from
the authenticated shared registry, and it validates that they are HTTPS
`*.trycloudflare.com` origins before forwarding.

## Registry design

The original brief leaves the registry choice to the implementer. This implementation
uses a dedicated **GitHub issue** in the same repository as the registry:

- `scripts/prepare-registry.mjs` creates/reuses an issue titled
  `relay-pool registry (automated)`, clears stale registrations, and exports its
  number to the other jobs.
- Relays and the gateway write their tunnel origin, TTL, and heartbeat as issue
  comments through the GitHub REST API (`api.github.com`, TLS + `GITHUB_TOKEN`).
- The gateway reads the comments periodically, filters expired entries, validates the
  URL, probes each relay's `/health`, and round-robins over healthy relays.
- **Only comments authored by the repository's GitHub Actions bot
  (`github-actions[bot]`) are trusted.** Anyone can comment on a public issue, so this
  actor check is essential: without it, a stranger could register a fake relay URL and
  receive the gateway's relay token.
- The issue contains only tunnel URLs and timestamps. It never contains tokens. URLs
  being public is acceptable here; authentication is still enforced.

Entries have a short TTL (default 120 seconds, refreshed every 30 seconds). If a job is
killed abruptly, its comment expires and the gateway stops selecting it. Every new run
clears stale entries before starting.

## Repository layout

```text
.
├── package.json                  # ESM, no runtime dependencies
├── src/
│   ├── config.mjs                # env validation and defaults
│   ├── security.mjs              # tokens, allowlist, URL/header policy
│   ├── relay-server.mjs          # relay HTTP server
│   ├── gateway-server.mjs        # authenticated round-robin proxy
│   ├── relay-pool.mjs            # registry filtering, health probes, selection
│   ├── tunnel.mjs                # cloudflared lifecycle and URL extraction
│   ├── registry.mjs              # GitHub-issue-backed registry
│   ├── registration.mjs          # registration retry helper
│   ├── relay-runtime.mjs         # relay supervision and graceful shutdown
│   ├── gateway-runtime.mjs       # gateway supervision and URL publication
│   ├── http-utils.mjs, logger.mjs, rate-limiter.mjs
├── scripts/
│   ├── prepare-registry.mjs
│   ├── run-relay.mjs
│   └── run-gateway.mjs
├── tests/                        # node:test unit, integration, and E2E tests
└── .github/workflows/
    ├── relay-pool.yml            # manual pool workflow
    └── ci.yml                    # tests on push/PR
```

## Setup

1. Set the two required secrets (generate independent random values):

   ```bash
   gh secret set RELAY_SHARED_TOKEN --repo <owner>/relay-proxy --body "$(openssl rand -hex 32)"
   gh secret set CLIENT_SHARED_TOKEN --repo <owner>/relay-proxy --body "$(openssl rand -hex 32)"
   ```

2. Set the exact upstream hostname allowlist as a repository variable. Do not include
   schemes, ports, paths, or wildcards:

   ```bash
   gh variable set ALLOWED_HOSTS --repo <owner>/relay-proxy \
     --body "api.example.com,service.example.org"
   ```

   Only hosts you control or are authorized to use belong here. The implementation
   validates the parsed URL hostname against this exact set; it does not use substring
   matching.

3. No external registry URL or token is needed. The workflow's `prepare` job creates
   the registry issue using the automatic `GITHUB_TOKEN`. The workflow permissions are
   limited to `contents: read` and `issues: write`.

4. Run the workflow:

   ```bash
   gh workflow run relay-pool.yml --repo <owner>/relay-proxy -f lifetime_minutes=330
   ```

   Or use **Actions → Temporary Relay Pool → Run workflow**. The default lifetime is
   330 minutes; the maximum accepted value is 340 minutes, inside the 350-minute job
   timeout. All five pool jobs start concurrently. The gateway waits for relays
   through the registry and returns `503` until at least one relay is healthy.

5. Find the gateway URL:

   - The gateway job prints a `Relay pool gateway URL` annotation.
   - It writes the URL to the job summary.
   - It registers the URL as the `gateway` comment on the registry issue. The prepare
     job links that issue in its summary.
   - The URL changes after every run; do not bookmark it.

6. Call the gateway:

   ```bash
   curl -sS "https://<gateway>.trycloudflare.com/relay" \
     -H "Authorization: Bearer $CLIENT_SHARED_TOKEN" \
     -H "x-relay-target: https://api.example.com" \
     -H "x-relay-path: /v1/status"
   ```

   - `Authorization` must be `Bearer <CLIENT_SHARED_TOKEN>`.
   - `x-relay-target` must be an allowlisted **HTTPS origin** (no path, query, port, or
     credentials).
   - `x-relay-path` must start with `/` (path plus optional query). It may not start
     with `//` and may not contain backslashes or control characters.
   - Allowed methods default to `GET, HEAD, POST`; request bodies are capped at 1 MiB.
   - The gateway never accepts relay URLs from the client. `x-relay-*` headers from
     clients are ignored or consumed, never used as a destination.

## Configuration

Set through the workflow; values not listed as secrets are safe to expose.

| Variable | Default | Notes |
| --- | --- | --- |
| `PORT` | `3000` | Local server port on each runner |
| `RELAY_ID` | — | `relay-1` … `relay-4`, set by the matrix |
| `RELAY_SHARED_TOKEN` | — | Secret; gateway-to-relay authentication |
| `CLIENT_SHARED_TOKEN` | — | Secret; client-to-gateway authentication |
| `ALLOWED_HOSTS` | — | Repository variable; exact comma-separated hostnames |
| `ALLOWED_METHODS` | `GET,HEAD,POST` | Optional method allowlist |
| `LIFETIME_MINUTES` | `330` | Max 340, job timeout 350 |
| `HEARTBEAT_INTERVAL_MS` | `30000` | Registry refresh/heartbeat cadence |
| `REGISTRY_TTL_MS` | `120000` | Must be at least 2× heartbeat |
| `REGISTRY_REFRESH_INTERVAL_MS` | `30000` | Gateway registry polling |
| `UPSTREAM_TIMEOUT_MS` | `30000` | Per-attempt upstream/relay deadline |
| `PROBE_TIMEOUT_MS` | `4000` | Gateway health probe timeout |
| `REQUEST_BODY_LIMIT_BYTES` | `1048576` | 1 MiB request body cap |
| `RATE_LIMIT_PER_MINUTE` | `120` | Per-process fixed window; `0` disables |
| `TUNNEL_START_TIMEOUT_MS` | `90000` | Fail cleanly if no tunnel URL appears |
| `GITHUB_REPOSITORY`/`GITHUB_TOKEN`/`REGISTRY_ISSUE_NUMBER` | Actions-provided | Registry API access |
| `ALLOW_LOCAL_TEST_TARGETS` | unset | **Test-only.** Allows HTTP on `127.0.0.1`/`localhost` for the E2E test. Never enable in the workflow. |

## Security controls

- **Two independent tokens** with constant-time digest comparison. The client token is
  only accepted by the gateway; relays only accept the relay token.
- **Exact allowlists** enforced independently by the gateway and each relay
  (defense in depth). Targets must be origin-only HTTPS URLs with no credentials or
  non-default ports.
- **Registry actor filtering**: only `github-actions[bot]` comments are read. This
  prevents public commenters from injecting a relay URL that would receive the relay
  token.
- **No client relay URLs**, no redirect following, and no client `Authorization`,
  `Cookie`, or proxy credentials are forwarded upstream.
- **Header policy**: hop-by-hop headers, `Host`, forwarded-IP headers, cookies, and
  `Set-Cookie` are stripped. Compression is requested as identity so streamed bodies
  are not double-decoded.
- **Bounded inputs**: request body cap, path length cap, method allowlist, per-process
  rate limit, and upstream timeouts.
- **Observability without secrets**: logs include relay ID, status, elapsed time,
  correlation ID, and target hostname only. They never include tokens, headers, paths,
  query strings, bodies, or tunnel URLs (the gateway URL is published deliberately).
- **Safe failure modes**: no registration means the job fails; no healthy relays means
  `503`; invalid target `400`; auth failure `401`; upstream timeout `504`; connection
  failure `502`; non-idempotent requests are never retried.
- **Graceful shutdown**: on lifetime expiry, `SIGINT`, or `SIGTERM`, the process
  unregisters, stops `cloudflared`, and closes the server. Orphaned registrations also
  expire via TTL.

### Important limitation: upstream credentials

The relay strips client `Authorization`/`Cookie` headers, and the gateway only
forwards `Content-Type` and `Accept`. This means **an upstream that requires its own
credentials is not supported out of the box** — intentionally, so this cannot be used
as a credential-forwarding open proxy. If your authorized upstream needs authentication,
add a fixed, server-side credential on the relays (for example, an environment secret
applied only to allowlisted hostnames) and document it. Do not forward arbitrary client
credentials.

## Testing

Tests use Node's built-in test runner and require no dependencies:

```bash
npm test
```

Coverage includes:

- allowlist, scheme, credential, port, path, and header validation
- token authentication and secret-free logs
- relay forwarding, body limits, timeout `504`, failure `502`, HEAD handling
- round-robin order across four relays, expired entries, unhealthy relay skipping,
  empty registry `503`
- no retry of failed non-idempotent requests; retry of failed idempotent requests
- registry parsing, actor filtering, TTL expiry, upsert/heartbeat/delete/clear
- tunnel URL extraction, startup timeout, stop and unexpected-exit handling
- lifecycle cleanup (unregister + tunnel stop) and gateway URL publication
- an end-to-end test with two real relay servers, a real gateway, and a local mock
  upstream

The `CI` workflow runs the suite on push and pull requests.

## Limits, costs, and restart behavior

- **Five GitHub-hosted runners** run concurrently per pool run: four relays plus one
  gateway. Each consumes Actions minutes for up to ~5.5 hours (default lifetime 330
  minutes; job timeout 350, below GitHub's 6-hour maximum).
- **Quick Tunnel URLs are ephemeral** and change on every restart. Cloudflare Quick
  Tunnels are intended for testing, may be rate-limited, and have no uptime guarantee.
- **Egress IPs are not guaranteed to differ** across runners; they are shared/dynamic
  GitHub infrastructure. This is not an IP-rotation guarantee.
- **The gateway can start before relays.** It serves `/health` and returns `503` for
  relay requests until at least one probe passes.
- **Restarts replace state.** Every new run clears old registry comments; orphaned
  entries also disappear after their TTL. Concurrency control cancels overlapping
  runs.
- **Cleanup**: cancel the workflow to trigger graceful shutdown. If a runner is killed
  hard, entries expire within two minutes, and the next run clears them.
- **No production use.** There is no HA, no persistent storage, no SLA, and no
  distributed gateway counter (the round-robin index is local to the one gateway
  process, which is sufficient for this design).

## License

No license is granted by default. Add one if you intend to allow reuse.
