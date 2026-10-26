import { appendFileSync } from "node:fs";
import {
  closeServer,
  delay,
  listen,
  waitForLocalHealth,
} from "./http-utils.mjs";
import { createGatewayServer } from "./gateway-server.mjs";
import { registerWithRetry } from "./registration.mjs";
import { createRelayPool } from "./relay-pool.mjs";
import { validateRelayUrl } from "./security.mjs";
import { startTunnel } from "./tunnel.mjs";

export function makeGatewayEntry(config, url, nowMs = Date.now()) {
  const origin = validateRelayUrl(url, {
    allowLocalTestTargets: config.allowLocalTestTargets,
  }).origin;
  return {
    kind: "gateway",
    id: "gateway",
    url: origin,
    expiresAt: new Date(nowMs + config.registryTtlMs).toISOString(),
    lastHeartbeatAt: new Date(nowMs).toISOString(),
  };
}

export async function verifyGatewayPublicUrl(
  url,
  { attempts = 5, retryMs = 2_000 } = {},
) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(new URL("/health", url), {
        redirect: "manual",
        signal: AbortSignal.timeout(5_000),
      });
      if (response.ok) {
        const payload = await response.json().catch(() => null);
        if (payload?.ok === true) return;
      }
    } catch {
      // Retry while the tunnel propagates.
    }
    if (attempt < attempts) await delay(retryMs);
  }
  throw new Error("Gateway public tunnel verification failed");
}

function publishGatewayUrl({ url, config, logger }) {
  logger?.info("gateway_url_ready", { url });
  try {
    process.stdout.write(`::notice title=Relay pool gateway URL::${url}\n`);
  } catch {
    // Annotations are best effort.
  }

  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;
  const issueUrl = `https://github.com/${config.githubRepository}/issues/${config.registryIssueNumber}`;
  try {
    appendFileSync(
      summaryPath,
      [
        "",
        "### Temporary relay pool gateway",
        "",
        `Gateway URL: ${url}`,
        "",
        `Registry issue: ${issueUrl}`,
        "",
        "Requests require the `CLIENT_SHARED_TOKEN` bearer token. The URL is public",
        "but changes after every restart. Relay URLs are only visible in the registry issue.",
        "",
      ].join("\n"),
    );
  } catch {
    // Summary publication is best effort.
  }
}

export async function startGatewayRuntime({
  config,
  logger,
  registry,
  fetchImpl = fetch,
  serverFactory = createGatewayServer,
  tunnelFactory = startTunnel,
  poolFactory = createRelayPool,
  verifyPublicHealth = verifyGatewayPublicUrl,
  clock = () => Date.now(),
}) {
  const pool = poolFactory({ registry, config, logger, fetchImpl });
  await pool.refresh();

  const server = serverFactory({ config, logger, pool, fetchImpl });
  await listen(server, config.port);
  const port = server.address().port;

  let tunnel = null;
  let registered = false;
  let heartbeatFailures = 0;
  let heartbeatInFlight = null;
  let shutdownPromise = null;
  let heartbeatTimer = null;
  let refreshTimer = null;
  let lifetimeTimer = null;
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });

  try {
    await waitForLocalHealth(port);
  } catch (error) {
    await closeServer(server);
    throw error;
  }

  async function safeCleanup(label, action) {
    try {
      await action();
      return true;
    } catch (error) {
      logger?.warn("cleanup_failed", { step: label, errorName: error?.name ?? "Error" });
      return false;
    }
  }

  function shutdown(reason, code = 0) {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (refreshTimer) clearTimeout(refreshTimer);
      if (lifetimeTimer) clearTimeout(lifetimeTimer);
      heartbeatTimer = null;
      refreshTimer = null;
      lifetimeTimer = null;

      logger?.info("shutdown_started", { reason, code });

      if (heartbeatInFlight) await heartbeatInFlight.catch(() => undefined);
      if (registered) {
        await safeCleanup("unregister", () => registry.remove("gateway", "gateway"));
      }
      if (tunnel) {
        await safeCleanup("stop_tunnel", () => tunnel.stop());
      }
      await closeServer(server);
      logger?.info("shutdown_complete", { reason, code });
      resolveDone(code);
      return code;
    })();
    return shutdownPromise;
  }

  server.on("error", (error) => {
    logger?.error("gateway_server_error", { name: error?.name ?? "Error" });
    void shutdown("server_error", 1);
  });

  try {
    tunnel = await tunnelFactory({
      port,
      binary: config.cloudflaredBinary,
      timeoutMs: config.tunnelStartTimeoutMs,
      onUnexpectedExit: () => {
        void shutdown("tunnel_exited", 1);
      },
    });
  } catch (error) {
    await closeServer(server);
    throw error;
  }

  const makeEntry = () => makeGatewayEntry(config, tunnel.url, clock());

  try {
    await verifyPublicHealth(tunnel.url, {
      attempts: config.verifyAttempts,
      retryMs: config.verifyRetryMs,
    });
  } catch (error) {
    await shutdown("verification_failed", 1);
    throw error;
  }

  try {
    await registerWithRetry({
      registry,
      makeEntry,
      attempts: config.registryRegisterAttempts,
      retryMs: config.registryRegisterRetryMs,
      logger,
      isStopping: () => shutdownPromise !== null,
    });
    registered = true;
  } catch (error) {
    await shutdown("registry_unavailable", 1);
    throw error;
  }

  publishGatewayUrl({ url: tunnel.url, config, logger });

  function scheduleRefresh() {
    if (shutdownPromise) return;
    const hasRelays = pool.getRelays().length > 0;
    const interval = hasRelays
      ? config.registryRefreshIntervalMs
      : Math.min(config.registryRefreshIntervalMs, 5_000);
    refreshTimer = setTimeout(async () => {
      refreshTimer = null;
      if (shutdownPromise) return;
      await pool.refresh();
      scheduleRefresh();
    }, interval);
    refreshTimer.unref?.();
  }
  scheduleRefresh();

  heartbeatTimer = setInterval(async () => {
    if (shutdownPromise || heartbeatInFlight) return;
    heartbeatInFlight = (async () => {
      try {
        await registry.register(makeEntry());
        heartbeatFailures = 0;
      } catch (error) {
        heartbeatFailures += 1;
        logger?.warn("registry_heartbeat_failed", {
          failures: heartbeatFailures,
          errorName: error?.name ?? "Error",
        });
        if (heartbeatFailures >= 3) {
          void shutdown("registry_unavailable", 1);
        }
      } finally {
        heartbeatInFlight = null;
      }
    })();
    await heartbeatInFlight;
  }, config.heartbeatIntervalMs);
  heartbeatTimer.unref?.();

  lifetimeTimer = setTimeout(() => {
    void shutdown("lifetime_reached", 0);
  }, config.lifetimeMinutes * 60_000);
  lifetimeTimer.unref?.();

  return {
    url: tunnel.url,
    pool,
    server,
    tunnel,
    shutdown,
    done,
  };
}
