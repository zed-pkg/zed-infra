import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { afterEach, test } from "node:test";

import worker from "./index.js";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

test("api origin 52x becomes a typed cache-disabled 503", async () => {
  globalThis.fetch = async () =>
    new Response("cloudflare origin failure", {
      status: 502,
      headers: { "content-type": "text/html" },
    });

  const response = await worker.fetch(
    new Request("https://api.zpkg.net/healthz", {
      headers: { accept: "application/json" },
    }),
    { ORIGIN_TIMEOUT_MS: "100" },
  );

  assert.equal(response.status, 503);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(response.headers.get("x-zed-edge"), "api.zpkg.net");
  assert.deepEqual(await response.json(), {
    ok: false,
    host: "api.zpkg.net",
    origin_status: 502,
    message:
      "api.zpkg.net origin is down. Please try again shortly. GitHub Pages (zpkg.net) and GitHub Releases remain available.",
  });
});

test("api keeps the origin authoritative when it responds", async () => {
  globalThis.fetch = async (request) => {
    assert.equal(request.url, "https://api.zpkg.net/v1/account/me");
    assert.equal(request.headers.get("authorization"), "Bearer opaque");
    return new Response(JSON.stringify({ id: "user-1" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const response = await worker.fetch(
    new Request("https://api.zpkg.net/v1/account/me", {
      headers: { authorization: "Bearer opaque" },
    }),
    { ORIGIN_TIMEOUT_MS: "100" },
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-zed-edge"), "api.zpkg.net");
  assert.deepEqual(await response.json(), { id: "user-1" });
});

test("api Wrangler config is an origin-backed route with no workers.dev alias", async () => {
  const config = await readFile(
    new URL("../wrangler.toml", import.meta.url),
    "utf8",
  );
  assert.match(config, /workers_dev = false/);
  assert.match(config, /pattern = "api\.zpkg\.net\/\*"/);
  assert.match(config, /zone_name = "zpkg\.net"/);
  assert.doesNotMatch(config, /custom_domain = true/);
  assert.match(config, /redact_query_string = true/);
});
