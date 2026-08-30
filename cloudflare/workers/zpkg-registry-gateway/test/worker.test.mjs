// The allowlist is the entire security property of this Worker, so it is the
// thing that gets tested. No network: `fetch` is stubbed, and every case
// asserts on what the Worker decided before (or instead of) calling it.
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/worker.js";

const ENV = { ORIGIN_URL: "https://api.zpkg.net", CDN_URL: "https://cdn.zpkg.net" };
const SHA = "a".repeat(64);

function stubFetch(impl) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return () => { globalThis.fetch = original; };
}

async function call(path, { method = "GET", origin } = {}) {
  const restore = stubFetch(origin ?? (async () => new Response("upstream", { status: 200 })));
  try {
    return await worker.fetch(new Request(`https://registry.zpkg.net${path}`, { method }), ENV);
  } finally {
    restore();
  }
}

test("serves the registry surface", async () => {
  for (const p of [
    "/healthz",
    "/.well-known/zpkg-mirrors.json",
    "/v1/packages",
    "/v1/packages/acme/http-kit/versions/1.0.0",
    "/v1/packages/acme/http-kit/signed-index",
    "/v1/search",
    "/v1/search/semantic",
    "/v1/orgs/acme/keys",
    "/v1/mirrors",
    `/v1/artifacts/${SHA}`,
    "/v1/files/acme/http-kit/1.0.0/README.md",
    "/v1/storage/status",
    "/v1/resolutions/abc123/dependency-graph",
  ]) {
    const res = await call(p);
    assert.equal(res.status, 200, `${p} should reach the origin`);
  }
});

test("withholds the account plane, including its /v1 mount", async () => {
  // account_router.rs nests the same routes at BOTH /api/v1 and /v1, which is
  // why an allowlist of "/v1" alone would have been wrong.
  for (const p of [
    "/v1/account/me",
    "/v1/auth/config",
    "/v1/auth/exchange",
    "/v1/me",
    "/v1/session/bootstrap",
    "/api/v1/account/me",
    "/api/docs",
    "/openapi.json",
  ]) {
    const res = await call(p);
    assert.equal(res.status, 404, `${p} must not exist on registry.zpkg.net`);
  }
});

test("unknown routes 404 without reaching the origin", async () => {
  let reached = false;
  const res = await call("/v1/internal/debug", { origin: async () => { reached = true; return new Response("", { status: 200 }); } });
  assert.equal(res.status, 404);
  assert.equal(reached, false);
});

test("publish keeps its method and bearer token", async () => {
  let seen;
  const restore = stubFetch(async (req) => { seen = req; return new Response("", { status: 201 }); });
  try {
    const res = await worker.fetch(
      new Request("https://registry.zpkg.net/v1/packages/acme/http-kit/versions/1.0.0", {
        method: "POST",
        headers: { authorization: "Bearer zpkg_test", "content-type": "application/octet-stream" },
        body: "artifact-bytes",
      }),
      ENV,
    );
    assert.equal(res.status, 201);
    assert.equal(seen.method, "POST");
    assert.equal(seen.headers.get("authorization"), "Bearer zpkg_test");
    assert.equal(new URL(seen.url).host, "api.zpkg.net");
  } finally { restore(); }
});

test("an artifact 302 is rewritten to the CDN, off the presigned clock", async () => {
  const res = await call(`/v1/artifacts/${SHA}`, {
    origin: async () => new Response(null, { status: 302, headers: { location: "https://acct.r2.cloudflarestorage.com/signed?X-Amz-Expires=600" } }),
  });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), `https://cdn.zpkg.net/artifacts/${SHA}.tar.gz`);
});

test("an unreachable origin points at the mirror set instead of a bare 502", async () => {
  const res = await call("/v1/packages", { origin: async () => { throw new Error("ECONNREFUSED"); } });
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.equal(body.error, "origin_unreachable");
  assert.match(body.mirrors, /zpkg-mirrors\.json$/);
});
