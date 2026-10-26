const LEVELS = new Set(["info", "warn", "error"]);

export function createLogger({ service, relayId, sink } = {}) {
  const write = sink ?? ((line) => process.stdout.write(`${line}\n`));

  function emit(level, event, fields = {}) {
    if (!LEVELS.has(level)) return;
    const record = {
      ts: new Date().toISOString(),
      level,
      service: service ?? "relay-pool",
    };
    if (relayId) record.relayId = relayId;
    record.event = event;

    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) continue;
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        record[key] = value;
      }
    }

    try {
      write(JSON.stringify(record));
    } catch {
      // Logging must never take the service down.
    }
  }

  return {
    info: (event, fields) => emit("info", event, fields),
    warn: (event, fields) => emit("warn", event, fields),
    error: (event, fields) => emit("error", event, fields),
  };
}
