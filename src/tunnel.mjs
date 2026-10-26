import { spawn } from "node:child_process";
import { validateTunnelUrl } from "./security.mjs";

const URL_PATTERN =
  /https:\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.trycloudflare\.com(?![a-z0-9.-])/gi;

export function extractTunnelUrl(text) {
  if (typeof text !== "string") return null;
  for (const match of text.matchAll(URL_PATTERN)) {
    try {
      return validateTunnelUrl(match[0]).origin;
    } catch {
      // Keep scanning; only a valid Quick Tunnel origin is accepted.
    }
  }
  return null;
}

export function startTunnel({
  port,
  binary = "cloudflared",
  timeoutMs = 90_000,
  stopTimeoutMs = 5_000,
  spawnImpl = spawn,
  onUnexpectedExit,
}) {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    return Promise.reject(new Error("A valid local port is required"));
  }

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(
        binary,
        ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${port}`],
        {
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
            HOME: process.env.HOME ?? "/tmp",
            TMPDIR: process.env.TMPDIR ?? "/tmp",
          },
        },
      );
    } catch {
      reject(new Error("Failed to start cloudflared"));
      return;
    }

    let url = null;
    let startupSettled = false;
    let startupFailed = false;
    let stopping = false;
    let output = "";
    let stopPromise = null;

    const controller = {
      get url() {
        return url;
      },
      stop,
    };

    function stop() {
      if (stopPromise) return stopPromise;
      stopping = true;
      stopPromise = new Promise((resolveStop) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resolveStop();
          return;
        }
        const forceTimer = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            // The process may have exited already.
          }
          resolveStop();
        }, stopTimeoutMs);
        forceTimer.unref?.();

        child.once("exit", () => {
          clearTimeout(forceTimer);
          resolveStop();
        });
        try {
          child.kill("SIGTERM");
        } catch {
          clearTimeout(forceTimer);
          resolveStop();
        }
      });
      return stopPromise;
    }

    const startupTimer = setTimeout(() => {
      if (startupSettled) return;
      startupSettled = true;
      startupFailed = true;
      try {
        child.kill("SIGTERM");
      } catch {
        // Best effort.
      }
      reject(new Error("Timed out waiting for a Cloudflare Quick Tunnel URL"));
    }, timeoutMs);

    function handleOutput(chunk) {
      if (startupSettled) return;
      output += chunk.toString("utf8");
      if (output.length > 65_536) output = output.slice(-32_768);
      const found = extractTunnelUrl(output);
      if (found) {
        startupSettled = true;
        url = found;
        clearTimeout(startupTimer);
        resolve(controller);
      }
    }

    child.stdout?.on("data", handleOutput);
    child.stderr?.on("data", handleOutput);

    child.once("error", () => {
      clearTimeout(startupTimer);
      if (!startupSettled) {
        startupSettled = true;
        startupFailed = true;
        reject(new Error("cloudflared could not be started"));
        return;
      }
      if (startupFailed || stopping) return;
      onUnexpectedExit?.(new Error("cloudflared process error"));
    });

    child.once("exit", (code, signal) => {
      clearTimeout(startupTimer);
      if (!startupSettled) {
        startupSettled = true;
        startupFailed = true;
        reject(
          new Error(
            `cloudflared exited before publishing a URL (code=${code ?? "null"}, signal=${signal ?? "none"})`,
          ),
        );
        return;
      }
      if (startupFailed || stopping) return;
      onUnexpectedExit?.(
        new Error(`cloudflared exited (code=${code ?? "null"}, signal=${signal ?? "none"})`),
      );
    });
  });
}
