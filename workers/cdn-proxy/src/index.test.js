import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import worker, { _internals } from "./index.js";

const SHA = "a".repeat(64);
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function bucket(objects = {}, error = null) {
  return {
    reads: [],
    async get(key) {
      this.reads.push(key);
      if (error) throw error;
      const body = objects[key];
      if (body === undefined) return null;
      return {
        body,
        size: new TextEncoder().encode(body).length,
        httpEtag: `"${key}"`,
        writeHttpMetadata() {},
      };
    },
  };
}

async function call(
  path,
  { method = "GET", headers = {}, objects = {}, env = {}, store } = {},
) {
  const artifacts = store || bucket(objects);
  const response = await worker.fetch(
    new Request(`https://cdn.zpkg.net${path}`, { method, headers }),
    {
      ARTIFACTS: artifacts,
      ...env,
    },
  );
  return { response, store: artifacts };
}

test("serves a digest-addressed R2 artifact with immutable security headers", async () => {
  const key = `artifacts/${SHA}.tar.gz`;
  const { response, store } = await call(`/${key}`, { objects: { [key]: "payload" } });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "payload");
  assert.deepEqual(store.reads, [key]);
  assert.equal(response.headers.get("content-type"), "application/gzip");
  assert.match(response.headers.get("cache-control"), /immutable/);
  assert.equal(response.headers.get("x-zed-source"), "r2");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
});

test("R2 full-object metadata is not mistaken for a client range request", async () => {
  const key = `artifacts/${SHA}.tar.gz`;
  const store = {
    async get(_key, options = {}) {
      const partial = options.range?.has("range") === true;
      return {
        body: partial ? "pay" : "payload",
        size: 7,
        range: { offset: 0, length: partial ? 3 : 7 },
        writeHttpMetadata() {},
      };
    },
  };

  const full = await call(`/${key}`, { store });
  assert.equal(full.response.status, 200);
  assert.equal(full.response.headers.get("content-range"), null);
  assert.equal(full.response.headers.get("content-length"), "7");

  const partial = await call(`/${key}`, {
    store,
    headers: { Range: "bytes=0-2" },
  });
  assert.equal(partial.response.status, 206);
  assert.equal(partial.response.headers.get("content-range"), "bytes 0-2/7");
  assert.equal(partial.response.headers.get("content-length"), "3");
});

test("signed metadata uses a bounded cache and is reachable", async () => {
  const key = "metadata/acme/http-kit/versions/1.2.0.json";
  const { response, store } = await call(`/${key}`, { objects: { [key]: "{}" } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/json");
  assert.match(response.headers.get("cache-control"), /max-age=60/);
  assert.doesNotMatch(response.headers.get("cache-control"), /immutable/);
  assert.deepEqual(store.reads, [key]);
});

test("coordinate paths never read R2, even when a matching key exists", async () => {
  const key = "packages/acme/private-lib/1.0.0/private-lib-1.0.0.tar.gz";
  const store = bucket({ [key]: "private-bytes" });
  globalThis.fetch = async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    assert.equal(url, "https://api.github.com/repos/acme/private-lib");
    return new Response(
      JSON.stringify({
        name: "private-lib",
        owner: { login: "acme" },
        private: true,
        visibility: "private",
      }),
      { headers: { "content-type": "application/json" } },
    );
  };
  const { response } = await call(`/${key}`, { store });
  assert.equal(response.status, 404);
  assert.deepEqual(store.reads, []);
});

test("npm artifact fallback is anonymous, bounded, and uses the exact canonical URL", async () => {
  const seen = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = input instanceof Request ? input.url : String(input);
    const headers = new Headers(input instanceof Request ? input.headers : init.headers);
    seen.push({ url, authorization: headers.get("authorization") });
    return new Response("public-bytes", {
      status: 200,
      headers: { "content-type": "application/gzip", "content-length": "12" },
    });
  };
  const { response, store } = await call(
    "/packages/npm/lodash/4.17.21/lodash-4.17.21.tgz",
  );
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "public-bytes");
  assert.equal(response.headers.get("x-zed-source"), "native-npm");
  assert.deepEqual(store.reads, []);
  assert.deepEqual(seen, [
    {
      url: "https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz",
      authorization: null,
    },
  ]);
});

test("native redirects are checked before the next request", async () => {
  const seen = [];
  globalThis.fetch = async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    seen.push(url);
    return new Response(null, { status: 302, headers: { location: "https://evil.test/payload" } });
  };
  const { response } = await call("/packages/npm/lodash/4.17.21/lodash-4.17.21.tgz");
  assert.equal(response.status, 404);
  assert.deepEqual(seen, ["https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz"]);
});

test("unbounded or oversized upstream artifacts are refused", () => {
  assert.equal(
    _internals.sanitizePublicArtifact(
      new Response("bytes", { headers: { "content-type": "application/gzip" } }),
      "GET",
      "test",
    ),
    null,
  );
  assert.equal(
    _internals.sanitizePublicArtifact(
      new Response("bytes", {
        headers: { "content-type": "application/gzip", "content-length": "999999999" },
      }),
      "GET",
      "test",
    ),
    null,
  );
});

test("invalid key shapes and encoded traversal never reach R2", async () => {
  for (const path of [
    "/secrets/db-password",
    "/artifacts/../secrets",
    "/artifacts/%2e%2e/secrets",
    `/artifacts/${"A".repeat(64)}.tar.gz`,
    `/artifacts/${SHA}.exe`,
    "/metadata/acme/http-kit/versions/../../../etc/passwd",
  ]) {
    const { response, store } = await call(path);
    assert.equal(response.status, 404, path);
    assert.deepEqual(store.reads, [], path);
  }
});

test("writes are rejected before bucket or upstream I/O", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    throw new Error("must not fetch");
  };
  const { response, store } = await call(`/artifacts/${SHA}.tar.gz`, { method: "PUT" });
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "GET, HEAD, OPTIONS");
  assert.deepEqual(store.reads, []);
  assert.equal(calls, 0);
});

test("health and bootstrap do not depend on R2", async () => {
  const broken = bucket({}, new Error("R2 down"));
  const health = await call("/healthz", { store: broken });
  assert.equal(health.response.status, 200);
  assert.deepEqual(broken.reads, []);

  const bootstrap = await call("/.well-known/zpkg-mirrors.json", {
    store: broken,
    env: {
      REGISTRY_URL: "https://registry.zpkg.net",
      MIRRORS: JSON.stringify([{ id: "zpkg-cdn", url: "https://cdn.zpkg.net" }]),
    },
  });
  assert.equal(bootstrap.response.status, 200);
  const body = await bootstrap.response.json();
  assert.equal(body.schema, "zpkg.mirror-bootstrap/v1");
  assert.equal(body.registry_url, "https://registry.zpkg.net");
  assert.deepEqual(broken.reads, []);
});
