import { createHash, timingSafeEqual } from "node:crypto";

export class ValidationError extends Error {
  constructor(message, code = "invalid_request") {
    super(message);
    this.name = "ValidationError";
    this.code = code;
  }
}

const HOSTNAME_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
const TRYCLOUDFLARE_HOSTNAME_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.trycloudflare\.com$/;
const CONTROL_OR_BACKSLASH = /[\u0000-\u001f\u007f\\]/;

export function tokenMatches(provided, expected) {
  if (typeof provided !== "string" || typeof expected !== "string") return false;
  if (provided.length === 0 || expected.length === 0) return false;
  const providedDigest = createHash("sha256").update(provided).digest();
  const expectedDigest = createHash("sha256").update(expected).digest();
  return timingSafeEqual(providedDigest, expectedDigest);
}

export function bearerToken(headerValue) {
  if (typeof headerValue !== "string") return null;
  const match = /^Bearer\s+(\S+)$/i.exec(headerValue.trim());
  return match ? match[1] : null;
}

export function parseAllowlist(raw) {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new Error("ALLOWED_HOSTS must be a comma-separated list of hostnames");
  }
  const hosts = new Set();
  for (const item of raw.split(",")) {
    const host = item.trim().toLowerCase();
    if (host === "") continue;
    if (host.length > 253 || !HOSTNAME_PATTERN.test(host)) {
      throw new Error(`ALLOWED_HOSTS contains an invalid hostname: ${host}`);
    }
    hosts.add(host);
  }
  if (hosts.size === 0) {
    throw new Error("ALLOWED_HOSTS must contain at least one hostname");
  }
  return hosts;
}

export function validateRelayId(id) {
  if (typeof id !== "string" || !/^relay-[1-4]$/.test(id)) {
    throw new Error("RELAY_ID must be one of relay-1, relay-2, relay-3, relay-4");
  }
  return id;
}

export function isLocalHostname(hostname) {
  return hostname === "127.0.0.1" || hostname === "localhost";
}

function normalizeRelayPath(rawPath, target, maxPathLength) {
  if (typeof rawPath !== "string" || rawPath.length === 0) {
    throw new ValidationError("Invalid relay path");
  }
  if (rawPath.length > maxPathLength) {
    throw new ValidationError("Relay path is too long");
  }
  if (!rawPath.startsWith("/") || rawPath.startsWith("//")) {
    throw new ValidationError("Invalid relay path");
  }
  if (CONTROL_OR_BACKSLASH.test(rawPath)) {
    throw new ValidationError("Invalid relay path");
  }

  let resolved;
  try {
    resolved = new URL(rawPath, target);
  } catch {
    throw new ValidationError("Invalid relay path");
  }
  if (resolved.origin !== target.origin) {
    throw new ValidationError("Invalid relay path");
  }
  if (resolved.username || resolved.password || resolved.hash) {
    throw new ValidationError("Invalid relay path");
  }

  const pathAndQuery = `${resolved.pathname}${resolved.search}`;
  if (pathAndQuery.length > maxPathLength) {
    throw new ValidationError("Relay path is too long");
  }
  return pathAndQuery;
}

export function validateTarget(
  { targetUrl, relayPath },
  { allowedHosts, allowLocalTestTargets = false, maxPathLength = 2048 } = {},
) {
  if (typeof targetUrl !== "string" || targetUrl.length === 0 || targetUrl.length > 2048) {
    throw new ValidationError("Invalid target URL");
  }

  let target;
  try {
    target = new URL(targetUrl);
  } catch {
    throw new ValidationError("Invalid target URL");
  }

  if (target.username || target.password) {
    throw new ValidationError("URL credentials are forbidden");
  }

  const local = isLocalHostname(target.hostname);
  const protocolAllowed =
    target.protocol === "https:" ||
    (allowLocalTestTargets && local && target.protocol === "http:");
  if (!protocolAllowed) {
    throw new ValidationError("Only HTTPS targets are allowed");
  }

  if (!allowedHosts || !allowedHosts.has(target.hostname.toLowerCase())) {
    throw new ValidationError("Target hostname is not allowlisted");
  }

  if (target.port !== "" && !(allowLocalTestTargets && local)) {
    throw new ValidationError("Target ports are not allowed");
  }

  if (
    (target.pathname !== "/" && target.pathname !== "") ||
    target.search !== "" ||
    target.hash !== ""
  ) {
    throw new ValidationError("Target must be an origin without a path or query");
  }

  const path = normalizeRelayPath(relayPath === undefined ? "/" : relayPath, target, maxPathLength);
  return { url: target, origin: target.origin, path };
}

export function validateRelayUrl(rawUrl, { allowLocalTestTargets = false } = {}) {
  if (typeof rawUrl !== "string" || rawUrl.length === 0 || rawUrl.length > 512) {
    throw new ValidationError("Invalid relay URL");
  }

  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ValidationError("Invalid relay URL");
  }

  if (url.username || url.password) {
    throw new ValidationError("Relay URL credentials are forbidden");
  }
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new ValidationError("Relay URL must be an origin");
  }

  const local = isLocalHostname(url.hostname);
  if (local) {
    if (!allowLocalTestTargets) {
      throw new ValidationError("Local relay URLs are only allowed in test mode");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new ValidationError("Invalid local relay URL");
    }
    return url;
  }

  if (url.protocol !== "https:") {
    throw new ValidationError("Relay URL must use HTTPS");
  }
  if (url.port !== "") {
    throw new ValidationError("Relay URL ports are not allowed");
  }
  if (!TRYCLOUDFLARE_HOSTNAME_PATTERN.test(url.hostname)) {
    throw new ValidationError("Relay URL must be a trycloudflare.com Quick Tunnel");
  }

  return url;
}

export function validateTunnelUrl(rawUrl) {
  if (typeof rawUrl !== "string" || rawUrl.length === 0) {
    throw new ValidationError("Invalid tunnel URL");
  }
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ValidationError("Invalid tunnel URL");
  }
  if (url.protocol !== "https:") {
    throw new ValidationError("Tunnel URL must use HTTPS");
  }
  if (url.username || url.password || url.port !== "") {
    throw new ValidationError("Invalid tunnel URL");
  }
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new ValidationError("Tunnel URL must be an origin");
  }
  if (!TRYCLOUDFLARE_HOSTNAME_PATTERN.test(url.hostname)) {
    throw new ValidationError("Tunnel URL must be a trycloudflare.com Quick Tunnel");
  }
  return url;
}

const BLOCKED_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "proxy-connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "te",
  "trailer",
  "proxy-authenticate",
  "proxy-authorization",
  "authorization",
  "cookie",
  "set-cookie",
  "x-relay-token",
  "x-relay-target",
  "x-relay-path",
  "x-client-token",
  "accept-encoding",
  "content-length",
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
]);

export function filterUpstreamRequestHeaders(headers) {
  const out = {};
  for (const [name, value] of Object.entries(headers || {})) {
    if (value === undefined) continue;
    const lower = name.toLowerCase();
    if (BLOCKED_REQUEST_HEADERS.has(lower)) continue;
    if (lower.startsWith("x-relay-")) continue;
    out[lower] = value;
  }
  return out;
}

const BLOCKED_RESPONSE_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "set-cookie",
  "content-length",
  "content-encoding",
]);

export function filterDownstreamResponseHeaders(headers) {
  const out = {};
  if (!headers) return out;
  const entries = typeof headers.entries === "function" ? headers.entries() : Object.entries(headers);
  for (const [name, value] of entries) {
    if (value === undefined) continue;
    const lower = name.toLowerCase();
    if (BLOCKED_RESPONSE_HEADERS.has(lower)) continue;
    out[lower] = value;
  }
  return out;
}
