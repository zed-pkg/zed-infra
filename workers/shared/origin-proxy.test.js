import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { createOriginProxy } from "./origin-proxy.js";
import { requestMode, responseDecision } from "./origin-transition.js";
import { modes, statuses, observeOrigin } from "../tests/origin-observation.mjs";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const worker = createOriginProxy({ label: "user.zpkg.net" });
const appWorker = createOriginProxy({
  label: "app.zpkg.net",
  unavailableOnNotFoundPaths: ["/", "/login", "/signup"],
  retryAfterSeconds: 7200,
});

test("origin proxy preserves public URL, Host, method, and body", async () => {
  const seen = [];
  globalThis.fetch = async (input) => {
    const forwarded = input instanceof Request ? input : new Request(input);
    seen.push({
      url: forwarded.url,
      host: forwarded.headers.get("host"),
      method: forwarded.method,
      body: await forwarded.text(),
    });
    return new Response("ok", { status: 201 });
  };

  const response = await worker.fetch(
    new Request("https://user.zpkg.net/account/save?next=home", {
      method: "POST",
      headers: { host: "user.zpkg.net", "content-type": "application/json" },
      body: "{}",
    }),
    { ORIGIN_TIMEOUT_MS: "1000" },
  );
  assert.equal(response.status, 201);
  assert.deepEqual(seen, [
    {
      url: "https://user.zpkg.net/account/save?next=home",
      host: "user.zpkg.net",
      method: "POST",
      body: "{}",
    },
  ]);
});

test("same-zone resolve override is optional and explicit", async () => {
  let options;
  globalThis.fetch = async (_input, init) => {
    options = init;
    return new Response("ok");
  };
  const response = await worker.fetch(new Request("https://user.zpkg.net/"), {
    ORIGIN_RESOLVE_OVERRIDE: "origin-hetzner.zpkg.net",
  });
  assert.equal(response.status, 200);
  assert.deepEqual(options.cf, { resolveOverride: "origin-hetzner.zpkg.net" });
});

test("origin transport failures and Cloudflare origin codes become typed 503s", async () => {
  for (const result of [new Error("network down"), new Response(null, { status: 522 })]) {
    globalThis.fetch = async () => {
      if (result instanceof Error) throw result;
      return result;
    };
    const response = await worker.fetch(new Request("https://user.zpkg.net/"), {});
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("x-zed-edge"), "user.zpkg.net");
    assert.equal(response.headers.get("retry-after"), "30");
  }
});

test("app entry routes get a two-hour edge HTML 503 when the origin route is absent", async () => {
  globalThis.fetch = async () => new Response(null, { status: 404 });

  for (const path of ["/", "/login", "/signup?plan=free"]) {
    const response = await appWorker.fetch(
      new Request(`https://app.zpkg.net${path}`, {
        headers: { accept: "text/html,application/xhtml+xml" },
      }),
      {},
    );
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8");
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("retry-after"), "7200");
    assert.equal(response.headers.get("x-zed-edge"), "app.zpkg.net");
    assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow");
    assert.match(response.headers.get("content-security-policy"), /default-src 'none'/);
    assert.match(await response.text(), /come back in about two hours/i);
  }
});

test("app root fallback keeps a typed JSON response for non-browser clients", async () => {
  globalThis.fetch = async () => new Response(null, { status: 404 });
  const response = await appWorker.fetch(new Request("https://app.zpkg.net/"), {});
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(response.headers.get("retry-after"), "7200");
  assert.match((await response.json()).message, /come back in about two hours/i);
});

test("app proxy preserves unrelated origin 404s", async () => {
  globalThis.fetch = async () => new Response("not found", { status: 404 });
  const response = await appWorker.fetch(new Request("https://app.zpkg.net/not-a-route"), {});
  assert.equal(response.status, 404);
  assert.equal(response.headers.get("x-zed-edge"), "app.zpkg.net");
  assert.equal(await response.text(), "not found");
});

test("invalid edge-owned fallback paths are rejected at worker construction", () => {
  assert.throws(
    () =>
      createOriginProxy({
        label: "app.zpkg.net",
        unavailableOnNotFoundPaths: ["https://example.com/login"],
      }),
    /absolute URL paths/,
  );
});

test("invalid retry windows are rejected at worker construction", () => {
  for (const retryAfterSeconds of [0, 1.5, 86401, "7200"]) {
    assert.throws(
      () => createOriginProxy({ label: "app.zpkg.net", retryAfterSeconds }),
      /retryAfterSeconds must be an integer/,
    );
  }
});

test("WebSocket upgrade preserves handshake, identity, and subprotocol headers", async () => {
  let forwarded;
  const upgraded = { status: 101, webSocket: {}, headers: new Headers() };
  globalThis.fetch = async (input) => {
    forwarded = input;
    return upgraded;
  };
  const response = await worker.fetch(
    new Request("https://user.zpkg.net/connect", {
      headers: {
        upgrade: "WebSocket",
        connection: "keep-alive, Upgrade",
        "keep-alive": "timeout=5",
        "proxy-authorization": "synthetic-proxy-only",
        origin: "https://app.zpkg.net",
        cookie: "synthetic=session",
        authorization: "Bearer synthetic-test-only",
        "sec-websocket-protocol": "zed.v1",
        "sec-websocket-version": "13",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
      },
    }),
    {},
  );
  assert.equal(response, upgraded, "the runtime socket response must not be reconstructed");
  assert.equal(forwarded.headers.get("upgrade"), "websocket");
  assert.equal(forwarded.headers.get("connection"), "Upgrade");
  for (const name of ["keep-alive", "proxy-authorization"]) {
    assert.equal(forwarded.headers.get(name), null);
  }
  assert.equal(forwarded.headers.get("origin"), "https://app.zpkg.net");
  assert.equal(forwarded.headers.get("cookie"), "synthetic=session");
  assert.equal(forwarded.headers.get("authorization"), "Bearer synthetic-test-only");
  assert.equal(forwarded.headers.get("sec-websocket-protocol"), "zed.v1");
  assert.equal(forwarded.headers.get("sec-websocket-version"), "13");
  assert.equal(forwarded.headers.get("sec-websocket-key"), "dGhlIHNhbXBsZSBub25jZQ==");
  assert.equal(forwarded.redirect, "manual");
});

test("WebSocket transport failures become typed unavailable responses", async () => {
  globalThis.fetch = async () => { throw new Error("synthetic origin failure"); };
  const response = await worker.fetch(
    new Request("https://user.zpkg.net/connect", { headers: { upgrade: "websocket" } }),
    {},
  );
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal((await response.json()).ok, false);
});

test("a completed WebSocket handshake disarms its deadline", async () => {
  let signal;
  globalThis.fetch = async (_input, options) => {
    signal = options.signal;
    return { status: 101, webSocket: {}, headers: new Headers() };
  };
  await worker.fetch(
    new Request("https://user.zpkg.net/connect", { headers: { upgrade: "websocket" } }),
    { ORIGIN_TIMEOUT_MS: "100" },
  );
  await new Promise((resolve) => setTimeout(resolve, 140));
  assert.equal(signal.aborted, false, "handshake deadline must not kill an established socket");
});

test("malformed upgrade requests are rejected before origin I/O", async () => {
  globalThis.fetch = async () => assert.fail("rejected request reached origin");
  for (const [method, upgrade] of [
    ["POST", "websocket"], ["HEAD", "websocket"], ["GET", "h2c"],
    ["GET", "websocket, h2c"], ["GET", ""],
  ]) {
    const response = await worker.fetch(new Request("https://user.zpkg.net/connect", {
      method, headers: { upgrade },
    }), {});
    assert.equal(response.status, 400);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
  assert.equal(requestMode("POST", null), "http");
  assert.equal(requestMode("GET", "WebSocket"), "websocket");
  assert.throws(() => responseDecision("reject", 200, false, false));
  assert.throws(() => responseDecision("unknown", 200, false, false));
});

test("all 276 finite origin scenarios refine the real Worker handler", async () => {
  let checked = 0;
  const unavailableStatuses = [0, 502, 503, 504, 521, 522, 523, 524];
  for (const mode of modes) for (const status of statuses) {
    for (const has_socket of [false, true]) for (const edge_owned of [false, true]) {
      const scenario = { mode, status, has_socket, edge_owned };
      const callsOrigin = mode !== "reject";
      const upgraded = callsOrigin && mode === "websocket" && status === 101 && has_socket;
      const unavailable = callsOrigin && (unavailableStatuses.includes(status)
        || (status === 101 && !upgraded) || (status === 404 && edge_owned));
      assert.deepEqual(await observeOrigin(scenario), {
        outcome: !callsOrigin ? "reject" : upgraded ? "upgrade" : unavailable ? "unavailable" : "http",
        status_returned: !callsOrigin ? 400 : unavailable ? 503 : status,
        origin_called: callsOrigin,
        upgrade_forwarded: callsOrigin && mode === "websocket",
        manual_redirect: callsOrigin,
        socket_passed: upgraded,
      }, JSON.stringify(scenario));
      checked++;
    }
  }
  assert.equal(checked, 276);
});
