import http from "node:http";
import {
  PayloadTooLargeError,
  newRequestId,
  pipeWebBody,
  readRequestBody,
  sendJson,
} from "./http-utils.mjs";
import { createRateLimiter } from "./rate-limiter.mjs";
import {
  bearerToken,
  filterDownstreamResponseHeaders,
  tokenMatches,
  validateTarget,
} from "./security.mjs";

const IDEMPOTENT_METHODS = new Set(["GET", "HEAD"]);

export function createGatewayServer({
  config,
  logger,
  pool,
  fetchImpl = fetch,
  rateLimiter,
}) {
  const limiter =
    rateLimiter ??
    createRateLimiter({ limit: config.rateLimitPerMinute, windowMs: 60_000 });

  const server = http.createServer((req, res) => {
    handle(req, res).catch((error) => {
      logger?.error("gateway_request_error", { name: error?.name ?? "Error" });
      if (!res.headersSent && !res.destroyed) {
        sendJson(res, 500, { error: "Internal server error" });
      } else if (!res.destroyed) {
        res.destroy();
      }
    });
  });

  server.on("clientError", (_error, socket) => {
    if (socket.writable) {
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    }
  });

  async function handle(req, res) {
    const requestId = newRequestId();
    const startedAt = Date.now();
    const method = (req.method || "GET").toUpperCase();
    res.setHeader("x-request-id", requestId);

    if ((req.url || "/").split("?")[0] === "/health") {
      if (method !== "GET") {
        res.setHeader("allow", "GET");
        sendJson(res, 405, { error: "Method not allowed" });
        return;
      }
      const relays = pool.getRelays();
      const lastRefreshAt = pool.getLastRefreshAt();
      sendJson(res, 200, {
        ok: true,
        role: "gateway",
        relayCount: relays.length,
        waitingForRelays: relays.length === 0,
        lastRefreshAt: lastRefreshAt === 0 ? null : new Date(lastRefreshAt).toISOString(),
      });
      return;
    }

    function log(status, extra = {}) {
      logger?.info("gateway_request", {
        requestId,
        method,
        status,
        durationMs: Date.now() - startedAt,
        ...extra,
      });
    }

    if (!config.allowedMethods.has(method)) {
      res.setHeader("allow", [...config.allowedMethods].join(", "));
      sendJson(res, 405, { error: "Method not allowed" });
      log(405);
      return;
    }

    const rate = limiter.allow("gateway");
    if (!rate.allowed) {
      sendJson(res, 429, { error: "Too many requests" }, {
        "retry-after": String(rate.retryAfterSeconds ?? 1),
      });
      log(429);
      return;
    }

    const clientToken = bearerToken(req.headers.authorization);
    if (!tokenMatches(clientToken, config.clientSharedToken)) {
      sendJson(res, 401, { error: "Unauthorized" });
      log(401);
      return;
    }

    let target;
    try {
      target = validateTarget(
        {
          targetUrl: req.headers["x-relay-target"],
          relayPath: req.headers["x-relay-path"],
        },
        {
          allowedHosts: config.allowedHosts,
          allowLocalTestTargets: config.allowLocalTestTargets,
          maxPathLength: config.maxPathLength,
        },
      );
    } catch {
      sendJson(res, 400, { error: "Invalid target or path" });
      log(400);
      return;
    }

    const bodyAllowed = method !== "GET" && method !== "HEAD";
    let body;
    if (bodyAllowed) {
      try {
        body = await readRequestBody(req, config.requestBodyLimitBytes);
      } catch (error) {
        if (error instanceof PayloadTooLargeError) {
          sendJson(res, 413, { error: "Request body is too large" }, { connection: "close" });
          log(413);
          return;
        }
        throw error;
      }
    }

    const maxAttempts = Math.max(pool.getRelays().length, 1);

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const relay = pool.pick();
      if (!relay) break;

      const controller = new AbortController();
      let timedOut = false;
      let clientClosed = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, config.upstreamTimeoutMs);
      timeout.unref?.();

      const onClose = () => {
        if (!res.writableEnded) {
          clientClosed = true;
          controller.abort();
        }
      };
      res.once("close", onClose);

      const relayHeaders = {
        "x-relay-token": config.relaySharedToken,
        "x-relay-target": target.origin,
        "x-relay-path": target.path,
        "x-request-id": requestId,
        accept: "application/json",
        "user-agent": "relay-pool-gateway",
      };
      if (typeof req.headers["content-type"] === "string") {
        relayHeaders["content-type"] = req.headers["content-type"];
      }
      if (typeof req.headers.accept === "string") {
        relayHeaders.accept = req.headers.accept;
      }

      let upstream;
      try {
        upstream = await fetchImpl(new URL("/relay", relay.url), {
          method,
          headers: relayHeaders,
          body: bodyAllowed ? body : undefined,
          signal: controller.signal,
          redirect: "manual",
        });
      } catch {
        clearTimeout(timeout);
        res.off("close", onClose);

        if (clientClosed) {
          logger?.warn("gateway_client_disconnected", {
            relayId: relay.id,
            attempt: attempt + 1,
          });
          return;
        }

        pool.markUnhealthy(relay.id);

        const status = timedOut ? 504 : 502;
        const canRetry =
          !timedOut &&
          IDEMPOTENT_METHODS.has(method) &&
          attempt + 1 < maxAttempts &&
          !res.headersSent &&
          !res.destroyed;

        if (canRetry) {
          logger?.warn("relay_connection_failed_retrying", {
            relayId: relay.id,
            attempt: attempt + 1,
          });
          continue;
        }

        if (!res.destroyed) {
          sendJson(res, status, {
            error: timedOut ? "Relay timeout" : "Relay request failed",
            requestId,
          });
        }
        log(status, { relayId: relay.id, targetHost: target.url.hostname, attempts: attempt + 1 });
        return;
      }

      try {
        const headers = filterDownstreamResponseHeaders(upstream.headers);
        headers["x-request-id"] = requestId;
        headers["x-relay-selected"] = relay.id;
        res.writeHead(upstream.status, headers);

        if (
          method === "HEAD" ||
          !upstream.body ||
          upstream.status === 204 ||
          upstream.status === 304
        ) {
          res.end();
        } else {
          await pipeWebBody(upstream.body, res);
        }

        log(upstream.status, {
          relayId: relay.id,
          targetHost: target.url.hostname,
          attempts: attempt + 1,
        });
      } catch {
        if (!res.destroyed) res.destroy();
        log(upstream.status, {
          relayId: relay.id,
          targetHost: target.url.hostname,
          attempts: attempt + 1,
          streamError: true,
        });
      } finally {
        clearTimeout(timeout);
        res.off("close", onClose);
      }
      return;
    }

    sendJson(res, 503, { error: "No healthy relays", requestId }, { "retry-after": "5" });
    log(503);
  }

  return server;
}
