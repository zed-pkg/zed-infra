// Tests for the zpkg-cdn Worker, run with `node --test`.
//
// No wrangler and no network: the Worker's `fetch` is an ordinary function of
// (Request, env), so a fake R2 binding is enough to exercise every branch that
// matters. The properties under test are the ones that would be security bugs
// if they regressed — key-space confinement above all, because a mirror that
// can be talked into reading an arbitrary key is an inventory of the supply
// chain.

import assert from "node:assert/strict";
import { test } from "node:test";

import worker, { decodeKey } from "../src/worker.js";

const SHA = "a".repeat(64);

function bucket(objects = {}) {
  return {
    reads: [],
    async get(key) {
      this.reads.push(key);
      const body = objects[key];
      if (body === undefined) return null;
      return {
        body,
        size: body.length,
        httpEtag: `"${key}"`,
        writeHttpMetadata() {},
      };
    },
  };
}

function call(path, { method = "GET", env = {}, objects = {} } = {}) {
  const store = bucket(objects);
  const request = new Request(`https://cdn.zpkg.net${path}`, { method });
  return worker
    .fetch(request, { ARTIFACTS: store, ...env })
    .then((response) => ({ response, store }));
}

test("serves an artifact addressed by its digest", async () => {
  const { response } = await call(`/artifacts/${SHA}.tar.gz`, {
    objects: { [`artifacts/${SHA}.tar.gz`]: "payload" },
  });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "payload");
  assert.equal(response.headers.get("content-type"), "application/gzip");
  assert.match(response.headers.get("cache-control"), /immutable/);
  assert.equal(response.headers.get("x-zpkg-mirror"), "zpkg-cdn");
});

test("an absent artifact is a 404, not a 500", async () => {
  const { response } = await call(`/artifacts/${SHA}.zip`);
  assert.equal(response.status, 404);
});

test("keys outside the public shape never reach the bucket", async () => {
  // The bucket holds more than the public artifact space, so the shape check
  // has to happen *before* the read, not after.
  for (const path of [
    "/secrets/db-password",
    "/artifacts/../secrets",
    "/artifacts/not-a-digest.tar.gz",
    `/artifacts/${SHA}.exe`,
    `/artifacts/${"A".repeat(64)}.tar.gz`, // uppercase is not our digest form
    "/metadata/acme/http-kit/versions/../../../etc/passwd",
    "/metadata/acme/http-kit/index.json.bak",
  ]) {
    const { response, store } = await call(path);
    assert.ok(
      response.status === 404 || response.status === 400,
      `${path} should be refused, got ${response.status}`,
    );
    assert.deepEqual(store.reads, [], `${path} must not reach the bucket`);
  }
});

test("percent-encoded traversal is refused rather than decoded twice", async () => {
  for (const path of [
    "/artifacts/%2e%2e/secrets",
    "/artifacts/%252e%252e/secrets",
    "/%2fetc/passwd",
  ]) {
    const { response, store } = await call(path);
    assert.ok(response.status === 400 || response.status === 404, path);
    assert.deepEqual(store.reads, [], path);
  }
});

test("decodeKey refuses a second encoding layer", () => {
  assert.equal(decodeKey("/artifacts/%252e%252e"), null);
  assert.equal(decodeKey("/a//b"), null);
  assert.equal(decodeKey("/a\\b"), null);
  assert.equal(decodeKey("/" + "x".repeat(600)), null);
  assert.equal(decodeKey(`/artifacts/${SHA}.tar.gz`), `artifacts/${SHA}.tar.gz`);
});

test("signed metadata is served with a short cache, not an immutable one", async () => {
  const key = "metadata/acme/http-kit/versions/1.2.0.json";
  const { response } = await call(`/${key}`, { objects: { [key]: "{}" } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/json");
  const cache = response.headers.get("cache-control");
  assert.doesNotMatch(cache, /immutable/);
  assert.match(cache, /max-age=60/);
});

test("a package index is reachable", async () => {
  const key = "metadata/acme/http-kit/index.json";
  const { response, store } = await call(`/${key}`, { objects: { [key]: "{}" } });
  assert.equal(response.status, 200);
  assert.deepEqual(store.reads, [key]);
});

test("writes are refused with 405 and an Allow header", async () => {
  for (const method of ["PUT", "POST", "DELETE", "PATCH"]) {
    const { response, store } = await call(`/artifacts/${SHA}.tar.gz`, { method });
    assert.equal(response.status, 405, method);
    assert.equal(response.headers.get("allow"), "GET, HEAD, OPTIONS");
    assert.deepEqual(store.reads, []);
  }
});

test("the bootstrap document answers without touching the bucket", async () => {
  // It has to answer even when R2 is the broken thing: a client asking for it
  // is already having a bad day.
  const mirrors = [
    { kind: "object-store", url: "https://cdn.zpkg.net", id: "zpkg-cdn" },
  ];
  const { response, store } = await call("/.well-known/zpkg-mirrors.json", {
    env: { MIRRORS: JSON.stringify(mirrors), REGISTRY_URL: "https://registry.zpkg.net" },
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.schema, "zpkg.mirror-bootstrap/v1");
  assert.equal(body.registry_url, "https://registry.zpkg.net");
  assert.deepEqual(body.mirrors, mirrors);
  assert.match(body.generated_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.deepEqual(store.reads, []);
});

test("a malformed MIRRORS binding degrades instead of failing the route", async () => {
  const { response } = await call("/.well-known/zpkg-mirrors.json", {
    env: { MIRRORS: "{not json" },
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.mirrors, []);
  assert.equal(body.registry_url, "https://registry.zpkg.net");
});

test("every response carries the anti-sniffing headers", async () => {
  const { response } = await call(`/artifacts/${SHA}.tar.gz`, {
    objects: { [`artifacts/${SHA}.tar.gz`]: "payload" },
  });
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.match(response.headers.get("content-security-policy"), /sandbox/);
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
});

test("CORS preflight is answered", async () => {
  const { response } = await call(`/artifacts/${SHA}.tar.gz`, { method: "OPTIONS" });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
});

test("healthz does not read the bucket", async () => {
  const { response, store } = await call("/healthz");
  assert.equal(response.status, 200);
  assert.deepEqual(store.reads, []);
});
