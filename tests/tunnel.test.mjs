import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { extractTunnelUrl, startTunnel } from "../src/tunnel.mjs";

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.exitCode = null;
    this.signalCode = null;
    this.killed = [];
  }

  kill(signal) {
    this.killed.push(signal);
    if (this.exitCode !== null || this.signalCode !== null) return true;
    this.exitCode = 0;
    this.signalCode = signal;
    queueMicrotask(() => this.emit("exit", 0, signal));
    return true;
  }

  exit(code = 1, signal = null) {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
  }
}

test("extractTunnelUrl only accepts strict Quick Tunnel origins", () => {
  assert.equal(
    extractTunnelUrl("2026-10-26T12:00:00Z INF |  https://happy-cat.trycloudflare.com  |"),
    "https://happy-cat.trycloudflare.com",
  );
  assert.equal(
    extractTunnelUrl("https://happy-cat.trycloudflare.com.evil.test"),
    null,
  );
  assert.equal(extractTunnelUrl("http://happy-cat.trycloudflare.com"), null);
  assert.equal(extractTunnelUrl("no tunnel here"), null);
  assert.equal(extractTunnelUrl("https://evil.test"), null);
});

test("startTunnel returns the published URL and stops the child", async () => {
  const child = new FakeChild();
  const tunnelPromise = startTunnel({
    port: 3000,
    timeoutMs: 500,
    spawnImpl: () => child,
  });

  child.stderr.write("INF |  https://happy-cat.trycloudflare.com  |\n");
  const tunnel = await tunnelPromise;
  assert.equal(tunnel.url, "https://happy-cat.trycloudflare.com");

  await tunnel.stop();
  assert.deepEqual(child.killed, ["SIGTERM"]);
});

test("startTunnel reports an unexpected cloudflared exit", async () => {
  const child = new FakeChild();
  let unexpected = null;
  const tunnelPromise = startTunnel({
    port: 3000,
    timeoutMs: 500,
    spawnImpl: () => child,
    onUnexpectedExit: (error) => {
      unexpected = error;
    },
  });

  child.stdout.write("https://happy-cat.trycloudflare.com\n");
  const tunnel = await tunnelPromise;
  child.exit(1, null);

  assert.ok(unexpected);
  assert.match(unexpected.message, /code=1/);
  await tunnel.stop();
});

test("startTunnel times out and terminates the child", async () => {
  const child = new FakeChild();
  await assert.rejects(
    startTunnel({ port: 3000, timeoutMs: 20, spawnImpl: () => child }),
    /Timed out/,
  );
  assert.ok(child.killed.includes("SIGTERM"));
});

test("startTunnel rejects when cloudflared cannot be spawned", async () => {
  await assert.rejects(
    startTunnel({
      port: 3000,
      timeoutMs: 500,
      spawnImpl: () => {
        throw new Error("spawn failed");
      },
    }),
    /Failed to start cloudflared/,
  );
  await assert.rejects(
    startTunnel({ port: 0, spawnImpl: () => new FakeChild() }),
    /valid local port/,
  );
});
