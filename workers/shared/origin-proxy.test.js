import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { createOriginProxy } from "./origin-proxy.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const worker = createOriginProxy({ label: "user.zpkg.net" });

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
