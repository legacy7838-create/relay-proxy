import {
  closeServer,
  listen,
  waitForLocalHealth,
} from "./http-utils.mjs";
import { registerWithRetry } from "./registration.mjs";
import { createRelayServer } from "./relay-server.mjs";
import { validateRelayUrl } from "./security.mjs";
import { startTunnel } from "./tunnel.mjs";

export function makeRelayEntry(config, url, nowMs = Date.now()) {
  const origin = validateRelayUrl(url, {
    allowLocalTestTargets: config.allowLocalTestTargets,
  }).origin;
  return {
    kind: "relay",
    id: config.relayId,
    url: origin,
    expiresAt: new Date(nowMs + config.registryTtlMs).toISOString(),
    lastHeartbeatAt: new Date(nowMs).toISOString(),
  };
}

export async function startRelayRuntime({
  config,
  logger,
  registry,
  fetchImpl = fetch,
  serverFactory = createRelayServer,
  tunnelFactory = startTunnel,
  clock = () => Date.now(),
}) {
  const server = serverFactory({ config, logger, fetchImpl });
  await listen(server, config.port);
  const port = server.address().port;

  let tunnel = null;
  let registered = false;
  let heartbeatFailures = 0;
  let heartbeatInFlight = null;
  let shutdownPromise = null;
  let lifetimeTimer = null;
  let heartbeatTimer = null;
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
      if (lifetimeTimer) clearTimeout(lifetimeTimer);
      heartbeatTimer = null;
      lifetimeTimer = null;

      logger?.info("shutdown_started", { reason, code });

      if (heartbeatInFlight) await heartbeatInFlight.catch(() => undefined);
      if (registered) {
        await safeCleanup("unregister", () => registry.remove("relay", config.relayId));
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
    logger?.error("relay_server_error", { name: error?.name ?? "Error" });
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

  const makeEntry = () => makeRelayEntry(config, tunnel.url, clock());

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

  logger?.info("relay_registered", { relayId: config.relayId });

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
    relayId: config.relayId,
    url: tunnel.url,
    server,
    tunnel,
    shutdown,
    done,
  };
}
