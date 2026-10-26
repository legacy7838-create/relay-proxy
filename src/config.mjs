import { parseAllowlist, validateRelayId } from "./security.mjs";

const DEFAULT_METHODS = "GET,HEAD,POST";

function required(env, name) {
  const value = typeof env[name] === "string" ? env[name].trim() : "";
  if (value === "") throw new Error(`${name} is required`);
  return value;
}

function optional(env, name, fallback) {
  const value = typeof env[name] === "string" ? env[name].trim() : "";
  return value === "" ? fallback : value;
}

function readInt(env, name, fallback, { min, max }) {
  const raw = typeof env[name] === "string" ? env[name].trim() : "";
  if (raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function parseMethods(raw) {
  const methods = new Set(
    raw
      .split(",")
      .map((method) => method.trim().toUpperCase())
      .filter(Boolean),
  );
  if (methods.size === 0) throw new Error("ALLOWED_METHODS must contain at least one method");
  for (const method of methods) {
    if (!/^[A-Z]+$/.test(method)) throw new Error("ALLOWED_METHODS contains an invalid method");
  }
  return methods;
}

export function loadConfig(env = process.env, service) {
  if (service !== "relay" && service !== "gateway") {
    throw new Error("service must be relay or gateway");
  }

  const config = {
    service,
    port: readInt(env, "PORT", 3000, { min: 1, max: 65535 }),
    lifetimeMinutes: readInt(env, "LIFETIME_MINUTES", 330, { min: 1, max: 340 }),
    heartbeatIntervalMs: readInt(env, "HEARTBEAT_INTERVAL_MS", 30_000, {
      min: 5_000,
      max: 300_000,
    }),
    registryTtlMs: readInt(env, "REGISTRY_TTL_MS", 120_000, {
      min: 15_000,
      max: 3_600_000,
    }),
    tunnelStartTimeoutMs: readInt(env, "TUNNEL_START_TIMEOUT_MS", 90_000, {
      min: 10_000,
      max: 300_000,
    }),
    registryRefreshIntervalMs: readInt(env, "REGISTRY_REFRESH_INTERVAL_MS", 30_000, {
      min: 5_000,
      max: 300_000,
    }),
    upstreamTimeoutMs: readInt(env, "UPSTREAM_TIMEOUT_MS", 30_000, {
      min: 1_000,
      max: 120_000,
    }),
    probeTimeoutMs: readInt(env, "PROBE_TIMEOUT_MS", 4_000, {
      min: 500,
      max: 30_000,
    }),
    requestBodyLimitBytes: readInt(env, "REQUEST_BODY_LIMIT_BYTES", 1_048_576, {
      min: 1_024,
      max: 16_777_216,
    }),
    maxPathLength: readInt(env, "MAX_PATH_LENGTH", 2_048, {
      min: 256,
      max: 8_192,
    }),
    rateLimitPerMinute: readInt(env, "RATE_LIMIT_PER_MINUTE", 120, {
      min: 0,
      max: 100_000,
    }),
    registryRegisterAttempts: readInt(env, "REGISTRY_REGISTER_ATTEMPTS", 10, {
      min: 1,
      max: 60,
    }),
    registryRegisterRetryMs: readInt(env, "REGISTRY_REGISTER_RETRY_MS", 3_000, {
      min: 250,
      max: 30_000,
    }),
    verifyAttempts: readInt(env, "GATEWAY_VERIFY_ATTEMPTS", 5, {
      min: 1,
      max: 30,
    }),
    verifyRetryMs: readInt(env, "GATEWAY_VERIFY_RETRY_MS", 2_000, {
      min: 250,
      max: 30_000,
    }),
    allowLocalTestTargets: optional(env, "ALLOW_LOCAL_TEST_TARGETS", "") === "1",
    cloudflaredBinary: optional(env, "CLOUDFLARED_BIN", "cloudflared"),
  };

  if (config.registryTtlMs < config.heartbeatIntervalMs * 2) {
    throw new Error("REGISTRY_TTL_MS must be at least twice HEARTBEAT_INTERVAL_MS");
  }

  config.allowedHosts = parseAllowlist(required(env, "ALLOWED_HOSTS"));
  config.allowedMethods = parseMethods(optional(env, "ALLOWED_METHODS", DEFAULT_METHODS));

  if (service === "relay") {
    config.relayId = validateRelayId(required(env, "RELAY_ID"));
    config.relaySharedToken = required(env, "RELAY_SHARED_TOKEN");
  } else {
    config.clientSharedToken = required(env, "CLIENT_SHARED_TOKEN");
    config.relaySharedToken = required(env, "RELAY_SHARED_TOKEN");
  }

  config.githubRepository = required(env, "GITHUB_REPOSITORY");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(config.githubRepository)) {
    throw new Error("GITHUB_REPOSITORY must be in owner/repo form");
  }
  config.registryIssueNumber = readInt(env, "REGISTRY_ISSUE_NUMBER", null, {
    min: 1,
    max: Number.MAX_SAFE_INTEGER,
  });
  if (config.registryIssueNumber === null) {
    throw new Error("REGISTRY_ISSUE_NUMBER is required");
  }
  config.githubToken = required(env, "GITHUB_TOKEN");
  config.githubApiUrl = optional(env, "GITHUB_API_URL", "https://api.github.com").replace(
    /\/+$/,
    "",
  );
  let apiUrl;
  try {
    apiUrl = new URL(config.githubApiUrl);
  } catch {
    throw new Error("GITHUB_API_URL must be a valid HTTPS URL");
  }
  if (apiUrl.protocol !== "https:" || apiUrl.pathname !== "/" || apiUrl.search || apiUrl.hash) {
    throw new Error("GITHUB_API_URL must be an HTTPS origin");
  }
  config.registryActorLogin = optional(env, "REGISTRY_ACTOR_LOGIN", "github-actions[bot]");

  return config;
}
