import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { createOriginProxy } from "./origin-proxy.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const worker = createOriginProxy({ label: "user.zpkg.net" });
const appWorker = createOriginProxy({
  label: "app.zpkg.net",
  unavailableOnNotFoundPaths: ["/login", "/signup"],
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

test("app account entry routes get an edge HTML 503 when the origin route is absent", async () => {
  globalThis.fetch = async () => new Response(null, { status: 404 });

  for (const path of ["/login", "/signup?plan=free"]) {
    const response = await appWorker.fetch(
      new Request(`https://app.zpkg.net${path}`, {
        headers: { accept: "text/html,application/xhtml+xml" },
      }),
      {},
    );
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8");
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-zed-edge"), "app.zpkg.net");
    assert.match(response.headers.get("content-security-policy"), /default-src 'none'/);
    assert.match(await response.text(), /account portal is temporarily unavailable/i);
  }
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
