import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export class PayloadTooLargeError extends Error {
  constructor() {
    super("Request body is too large");
    this.name = "PayloadTooLargeError";
  }
}

export function newRequestId() {
  return randomUUID();
}

export async function readRequestBody(req, limitBytes) {
  const declaredLength = Number(req.headers["content-length"]);
  if (Number.isFinite(declaredLength) && declaredLength > limitBytes) {
    throw new PayloadTooLargeError();
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) throw new PayloadTooLargeError();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function sendJson(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...extraHeaders,
  });
  res.end(body);
}

export async function pipeWebBody(body, res) {
  if (!body) {
    res.end();
    return;
  }
  await pipeline(Readable.fromWeb(body), res);
}

export function listen(server, port, host = "0.0.0.0") {
  return new Promise((resolve, reject) => {
    function onError(error) {
      server.off("listening", onListening);
      reject(error);
    }
    function onListening() {
      server.off("error", onError);
      resolve();
    }
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

export function closeServer(server) {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    const forceTimer = setTimeout(() => {
      server.closeAllConnections?.();
      resolve();
    }, 5_000);
    forceTimer.unref?.();

    server.close(() => {
      clearTimeout(forceTimer);
      resolve();
    });
  });
}

export function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

export async function waitForLocalHealth(port, { attempts = 20, retryMs = 250 } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        redirect: "manual",
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) {
        const payload = await response.json().catch(() => null);
        if (payload?.ok === true) return;
      }
    } catch {
      // Retry until the local server is ready.
    }
    if (attempt < attempts) await delay(retryMs);
  }
  throw new Error("Local health check failed");
}
