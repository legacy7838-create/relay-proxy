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
  filterDownstreamResponseHeaders,
  filterUpstreamRequestHeaders,
  tokenMatches,
  validateTarget,
} from "./security.mjs";

export function createRelayServer({ config, logger, fetchImpl = fetch, rateLimiter }) {
  const limiter =
    rateLimiter ??
    createRateLimiter({ limit: config.rateLimitPerMinute, windowMs: 60_000 });

  const server = http.createServer((req, res) => {
    handle(req, res).catch((error) => {
      logger?.error("relay_request_error", { name: error?.name ?? "Error" });
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
    res.setHeader("x-relay-id", config.relayId);

    if ((req.url || "/").split("?")[0] === "/health") {
      if (method !== "GET") {
        res.setHeader("allow", "GET");
        sendJson(res, 405, { error: "Method not allowed" });
        return;
      }
      sendJson(res, 200, { ok: true, role: "relay", id: config.relayId });
      return;
    }

    function log(status, extra = {}) {
      logger?.info("relay_request", {
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

    const rate = limiter.allow("relay");
    if (!rate.allowed) {
      sendJson(res, 429, { error: "Too many requests" }, {
        "retry-after": String(rate.retryAfterSeconds ?? 1),
      });
      log(429);
      return;
    }

    if (!tokenMatches(req.headers["x-relay-token"], config.relaySharedToken)) {
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

    const controller = new AbortController();
    let timedOut = false;
    let responsesCommitted = false;
    let finalStatus = 502;

    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, config.upstreamTimeoutMs);
    timeout.unref?.();

    const onClose = () => {
      if (!res.writableEnded) controller.abort();
    };
    res.once("close", onClose);

    try {
      const upstream = await fetchImpl(target.url, {
        method,
        headers: filterUpstreamRequestHeaders(req.headers),
        body: bodyAllowed ? body : undefined,
        signal: controller.signal,
        redirect: "manual",
      });

      responsesCommitted = true;
      finalStatus = upstream.status;

      const headers = filterDownstreamResponseHeaders(upstream.headers);
      headers["x-request-id"] = requestId;
      headers["x-relay-id"] = config.relayId;
      res.writeHead(upstream.status, headers);

      if (method === "HEAD" || !upstream.body || upstream.status === 204 || upstream.status === 304) {
        res.end();
      } else {
        await pipeWebBody(upstream.body, res);
      }

      log(upstream.status, { targetHost: target.url.hostname });
    } catch (error) {
      if (!responsesCommitted) {
        finalStatus = timedOut ? 504 : 502;
        if (!res.destroyed) {
          sendJson(res, finalStatus, {
            error: timedOut ? "Upstream timeout" : "Upstream request failed",
            requestId,
          });
        }
        log(finalStatus, { targetHost: target.url.hostname });
      } else {
        if (!res.destroyed) res.destroy();
        log(finalStatus, { targetHost: target.url.hostname, streamError: true });
      }
    } finally {
      clearTimeout(timeout);
      res.off("close", onClose);
    }
  }

  return server;
}
