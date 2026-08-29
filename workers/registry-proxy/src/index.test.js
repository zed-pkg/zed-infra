import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import worker from "./index.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function request(path, init = {}) {
  return new Request(`https://registry.zpkg.net${path}`, init);
}

test("unknown and browser-account routes are denied without origin I/O", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    throw new Error("must not fetch");
  };
  for (const path of ["/v1/account/me", "/v1/me", "/api/v1/auth/config", "/admin"]) {
    const response = await worker.fetch(request(path), { ORIGIN_URL: "https://api.zpkg.net" });
    assert.equal(response.status, 404, path);
  }
  assert.equal(calls, 0);
});

test("invalid methods are denied without origin I/O", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    throw new Error("must not fetch");
  };
  const response = await worker.fetch(request("/v1/packages/npm/lodash", { method: "DELETE" }), {
    ORIGIN_URL: "https://api.zpkg.net",
  });
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "GET, HEAD, OPTIONS");
  assert.equal(calls, 0);
});

test("valid writes preserve the request body and target only api.zpkg.net", async () => {
  const seen = [];
  globalThis.fetch = async (input) => {
    const forwarded = input instanceof Request ? input : new Request(input);
    seen.push({
      url: forwarded.url,
      method: forwarded.method,
      body: await forwarded.text(),
    });
    return new Response(JSON.stringify({ ok: true }), {
      status: 201,
      headers: { "content-type": "application/json" },
    });
  };
  const response = await worker.fetch(
    request("/v1/packages/acme/http-kit/versions/1.0.0", {
      method: "PUT",
      headers: { "content-type": "application/octet-stream" },
      body: "artifact-bytes",
    }),
    { ORIGIN_URL: "https://api.zpkg.net" },
  );
  assert.equal(response.status, 201);
  assert.deepEqual(seen, [
    {
      url: "https://api.zpkg.net/v1/packages/acme/http-kit/versions/1.0.0",
      method: "PUT",
      body: "artifact-bytes",
    },
  ]);
});

test("npm fallback is anonymous and follows a failed origin only", async () => {
  const seen = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = input instanceof Request ? input.url : String(input);
    const headers = new Headers(input instanceof Request ? input.headers : init.headers);
    seen.push({ url, authorization: headers.get("authorization") });
    if (url.startsWith("https://api.zpkg.net/")) return new Response(null, { status: 503 });
    if (url === "https://registry.npmjs.org/lodash") {
      return new Response(
        JSON.stringify({
          name: "lodash",
          versions: { "4.17.21": {} },
          description: "utility library",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  const response = await worker.fetch(request("/v1/packages/npm/lodash"), {
    ORIGIN_URL: "https://api.zpkg.net",
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-zed-source"), "native-npm");
  assert.ok(seen.every((call) => call.authorization === null));
  assert.deepEqual(
    seen.map((call) => call.url),
    ["https://api.zpkg.net/v1/packages/npm/lodash", "https://registry.npmjs.org/lodash"],
  );
});

test("npm version fallback computes the transport sha256 and exact compressed size", async () => {
  const artifact = new TextEncoder().encode("canonical-npm-tarball");
  globalThis.fetch = async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith("https://api.zpkg.net/")) return new Response(null, { status: 503 });
    if (url === "https://registry.npmjs.org/lodash/4.17.21") {
      return new Response(
        JSON.stringify({
          name: "lodash",
          version: "4.17.21",
          dist: {
            tarball: "https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz",
            integrity: "sha512-not-used-as-a-sha256",
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    if (url === "https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz") {
      return new Response(artifact, {
        headers: {
          "content-type": "application/gzip",
          "content-length": String(artifact.byteLength),
        },
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  const response = await worker.fetch(request("/v1/packages/npm/lodash/versions/4.17.21"), {
    ORIGIN_URL: "https://api.zpkg.net",
  });
  assert.equal(response.status, 200);
  const metadata = await response.json();
  assert.equal(metadata.size, artifact.byteLength);
  assert.match(metadata.sha256, /^[a-f0-9]{64}$/);
  assert.equal(metadata.download_url, "https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz");
});

test("a private GitHub repository is never used as public fallback", async () => {
  const seen = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = input instanceof Request ? input.url : String(input);
    const headers = new Headers(input instanceof Request ? input.headers : init.headers);
    seen.push({ url, authorization: headers.get("authorization") });
    if (url.startsWith("https://api.zpkg.net/")) return new Response(null, { status: 503 });
    if (url === "https://api.github.com/repos/acme/private-lib") {
      return new Response(
        JSON.stringify({
          name: "private-lib",
          owner: { login: "acme" },
          private: true,
          visibility: "private",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  const response = await worker.fetch(request("/v1/packages/acme/private-lib"), {
    ORIGIN_URL: "https://api.zpkg.net",
  });
  assert.equal(response.status, 503);
  assert.ok(seen.every((call) => call.authorization === null));
  assert.equal(seen.length, 2);
});
