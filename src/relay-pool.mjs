import { validateRelayUrl } from "./security.mjs";

export function createRelayPool({ registry, config, logger, fetchImpl = fetch, now = () => Date.now() }) {
  let entries = [];
  let nextIndex = 0;
  let lastRefreshAt = 0;
  let lastRefreshError = null;

  async function probe(entry) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.probeTimeoutMs);
    timer.unref?.();
    try {
      const response = await fetchImpl(new URL("/health", entry.url), {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: { accept: "application/json", "user-agent": "relay-pool-gateway" },
      });
      if (!response.ok) return false;
      const payload = await response.json().catch(() => null);
      return payload?.ok === true;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  async function refresh() {
    try {
      const registrations = await registry.listEntries();
      const currentTime = now();
      const active = new Map();

      for (const entry of registrations) {
        if (entry.kind !== "relay") continue;
        if (!(Date.parse(entry.expiresAt) > currentTime)) continue;

        const existing = active.get(entry.id);
        if (
          existing &&
          Date.parse(existing.lastHeartbeatAt) >= Date.parse(entry.lastHeartbeatAt)
        ) {
          continue;
        }
        active.set(entry.id, entry);
      }

      const candidates = [...active.values()].sort((a, b) => a.id.localeCompare(b.id));
      const checked = [];

      await Promise.all(
        candidates.map(async (entry) => {
          let url;
          try {
            url = validateRelayUrl(entry.url, {
              allowLocalTestTargets: config.allowLocalTestTargets,
            });
          } catch {
            logger?.warn("relay_url_rejected", { relayId: entry.id });
            return;
          }

          if (!(await probe(entry))) {
            logger?.warn("relay_unhealthy", { relayId: entry.id });
            return;
          }

          checked.push({
            id: entry.id,
            url: url.origin,
            expiresAt: entry.expiresAt,
            lastHeartbeatAt: entry.lastHeartbeatAt,
          });
        }),
      );

      checked.sort((a, b) => a.id.localeCompare(b.id));
      entries = checked;
      if (nextIndex >= entries.length) nextIndex = 0;
      lastRefreshAt = now();
      lastRefreshError = null;
      logger?.info("registry_refreshed", { relayCount: entries.length });
    } catch (error) {
      lastRefreshError = error?.name ?? "Error";
      const currentTime = now();
      entries = entries.filter((entry) => Date.parse(entry.expiresAt) > currentTime);
      if (nextIndex >= entries.length) nextIndex = 0;
      logger?.warn("registry_refresh_failed", { errorName: lastRefreshError });
    }
  }

  function pick() {
    if (entries.length === 0) return null;
    const relay = entries[nextIndex % entries.length];
    nextIndex = (nextIndex + 1) % entries.length;
    return relay;
  }

  function markUnhealthy(id) {
    const before = entries.length;
    entries = entries.filter((entry) => entry.id !== id);
    if (entries.length !== before) {
      if (nextIndex >= entries.length) nextIndex = 0;
      logger?.warn("relay_removed_from_pool", { relayId: id });
    }
  }

  return {
    refresh,
    pick,
    markUnhealthy,
    getRelays: () => entries.slice(),
    getLastRefreshAt: () => lastRefreshAt,
    getLastRefreshError: () => lastRefreshError,
  };
}
