import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from "miniflare";
import WebSocket, { WebSocketServer } from "ws";

const root = fileURLToPath(new URL("../", import.meta.url));
const syntheticHeaders = { origin: "https://app.zpkg.net", cookie: "synthetic=session" };

// Actual TCP client -> workerd -> actual TCP origin. No deployed bindings,
// credentials, remote hosts, database, or browser are involved.
for (const kind of ["app", "user", "web"]) {
  test(`${kind} Worker preserves real WebSocket framing and origin decisions`, { timeout: 20_000 }, async (t) => {
    const sockets = new Set();
    const observed = [];
    const server = createServer((_request, response) => {
      response.writeHead(426);
      response.end("upgrade required");
    });
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    const wss = new WebSocketServer({ noServer: true, maxPayload: 65_536 });
    let mf;
    t.after(async () => {
      for (const client of wss.clients) client.terminate();
      for (const socket of sockets) socket.destroy();
      await mf?.dispose();
      await new Promise((resolve) => wss.close(resolve));
      await new Promise((resolve) => server.close(resolve));
    });
    server.on("upgrade", (request, socket, head) => {
      observed.push({ path: request.url, headers: request.headers });
      if (request.url === "/stall") return;
      if (request.url === "/disconnect") { socket.destroy(); return; }
      const status = request.headers.cookie !== "synthetic=session" ? 401
        : request.headers.origin !== "https://app.zpkg.net" ? 403
        : request.url === "/redirect" ? 307 : null;
      if (status !== null) {
        socket.end(`HTTP/1.1 ${status} Denied\r\nLocation: /must-not-follow\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
        return;
      }
      wss.handleUpgrade(request, socket, head, (ws) => {
        ws.on("message", (data, binary) => ws.send(data, { binary }));
        ws.on("error", () => {});
      });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const upstream = `http://127.0.0.1:${server.address().port}`;
    // Wrangler 4.127.1 pins Miniflare 5's alpha configuration boundary. Use
    // its exported converter for the documented scriptPath-style options.
    mf = new Miniflare(convertV4MiniflareOptions({
      workers: [{
        name: `zpkg-${kind}-proxy`,
        modules: [
          `${kind}-proxy/src/index.js`,
          "shared/origin-proxy.js",
          "shared/origin-transition.js",
          "shared/github-fallback.js",
        ].map((path) => ({ type: "ESModule", path: `${root}${path}` })),
        modulesRoot: root,
        compatibilityDate: "2026-08-28",
        compatibilityFlags: ["nodejs_compat"],
        bindings: { ORIGIN_TIMEOUT_MS: "500" },
      }],
      upstream,
      host: "127.0.0.1",
      cf: false,
      log: new Log(LogLevel.ERROR),
    }));
    const address = await mf.ready;
    const client = new WebSocket(new URL("/connect", address), ["zed.v1"], {
      headers: syntheticHeaders, handshakeTimeout: 5_000,
    });
    t.after(() => client.terminate());
    await once(client, "open");
    assert.equal(client.protocol, "zed.v1");
    assert.equal(observed[0].headers.origin, syntheticHeaders.origin);
    assert.equal(observed[0].headers.cookie, syntheticHeaders.cookie);
    assert.equal(observed[0].headers["sec-websocket-protocol"], "zed.v1");
    assert.equal(observed[0].headers.upgrade.toLowerCase(), "websocket");

    // Deliberately exceed the setup deadline, then exchange real text/binary
    // frames. This catches a leaked AbortSignal.timeout after HTTP 101.
    await new Promise((resolve) => setTimeout(resolve, 650));
    const textReply = once(client, "message");
    client.send("zed:hello");
    const [textBytes, isBinary] = await textReply;
    assert.equal(textBytes.toString(), "zed:hello");
    assert.equal(isBinary, false);
    const binaryReply = once(client, "message");
    client.send(Buffer.from([0, 255, 1, 128]));
    const [binaryBytes, binary] = await binaryReply;
    assert.equal(binary, true);
    assert.deepEqual(binaryBytes, Buffer.from([0, 255, 1, 128]));
    const closed = once(client, "close");
    client.close(1000, "done");
    const [closeCode, closeReason] = await closed;
    assert.equal(closeCode, 1000);
    assert.equal(closeReason.toString(), "done");

    for (const [path, headers, expected] of [
      ["/connect", { origin: syntheticHeaders.origin }, 401],
      ["/connect", { ...syntheticHeaders, origin: "https://other.invalid" }, 403],
      ["/redirect", syntheticHeaders, 307],
      ["/disconnect", syntheticHeaders, 503],
      ["/stall", syntheticHeaders, 503],
    ]) {
      const start = Date.now();
      const response = await mf.dispatchFetch(`https://${kind}.zpkg.net${path}`, {
        headers: { ...headers, upgrade: "websocket" }, redirect: "manual",
      });
      assert.equal(response.status, expected, path);
      assert.equal(response.webSocket, null);
      if (expected === 503) assert.equal(response.headers.get("cache-control"), "no-store");
      if (path === "/stall") {
        assert(Date.now() - start >= 400, "exercise the actual setup deadline");
        assert(Date.now() - start < 3_000, "setup must remain bounded");
      }
      await response.body?.cancel();
    }
    assert.equal(observed.some(({ path }) => path === "/must-not-follow"), false);
  });
}
