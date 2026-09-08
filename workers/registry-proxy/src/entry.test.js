import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import worker from "./entry.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function request(path, init = {}) {
  return new Request(`https://registry.zpkg.net${path}`, init);
}

test("every registry response identifies the Cloudflare edge boundary", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    throw new Error("denied routes must not perform I/O");
  };

  const response = await worker.fetch(request("/v1/account/me"), {
    ORIGIN_URL: "https://api.zpkg.net",
  });

  assert.equal(response.status, 404);
  assert.equal(response.headers.get("x-zed-edge"), "registry");
  assert.equal(calls, 0);
});

test("a public GitHub release serves package metadata when the Rust origin is down", async () => {
  const digest = "b05c249a8a9cd0a383d042580b6dbaa4e828dd5ec201936d865055f26a023f43";
  const asset = "zpkg-zed-pkg-test-github-api-fallback-canary-0.0.2.tar.gz";
  const downloadUrl =
    `https://github.com/zed-pkg-test/github-api-fallback-canary/releases/download/v0.0.2/${asset}`;
  const seen = [];

  globalThis.fetch = async (input, init = {}) => {
    const forwarded = input instanceof Request ? input : new Request(input, init);
    const url = forwarded.url;
    seen.push({ url, authorization: forwarded.headers.get("authorization") });

    if (url.startsWith("https://api.zpkg.net/")) {
      throw new TypeError("simulated Rust origin outage");
    }
    if (
      url ===
      "https://cdn.zpkg.net/github/zed-pkg-test/github-api-fallback-canary/v0.0.2/zpkg-zed-pkg-test-github-api-fallback-canary-0.0.2.json"
    ) {
      return new Response(null, { status: 503 });
    }
    if (
      url ===
      "https://github.com/zed-pkg-test/github-api-fallback-canary/releases/download/v0.0.2/zpkg-zed-pkg-test-github-api-fallback-canary-0.0.2.json"
    ) {
      return new Response(null, {
        status: 302,
        headers: {
          location:
            "https://release-assets.githubusercontent.com/public-sidecar.json?signed=1",
        },
      });
    }
    if (url === "https://release-assets.githubusercontent.com/public-sidecar.json?signed=1") {
      const response = new Response(
        JSON.stringify({
          org: "zed-pkg-test",
          name: "github-api-fallback-canary",
          version: "0.0.2",
          sha256: digest,
          size: 1578807,
          format: "tar.gz",
          vcs_tag: "v0.0.2",
          vcs_commit: "main",
          download_url: downloadUrl,
          published_at: "2026-09-01T21:16:46Z",
          yanked: false,
        }),
        { status: 200, headers: { "content-type": "application/octet-stream" } },
      );
      return response;
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  const response = await worker.fetch(
    request(
      "/v1/packages/zed-pkg-test/github-api-fallback-canary/versions/0.0.2",
    ),
    {
      ORIGIN_URL: "https://api.zpkg.net",
      ORIGIN_TIMEOUT_MS: "100",
      FALLBACK_TIMEOUT_MS: "1000",
    },
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-zed-edge"), "registry");
  assert.equal(response.headers.get("x-zed-source"), "github-public");
  assert.ok(seen.every((call) => call.authorization === null));
  assert.deepEqual(
    seen.map((call) => call.url),
    [
      "https://api.zpkg.net/v1/packages/zed-pkg-test/github-api-fallback-canary/versions/0.0.2",
      "https://cdn.zpkg.net/github/zed-pkg-test/github-api-fallback-canary/v0.0.2/zpkg-zed-pkg-test-github-api-fallback-canary-0.0.2.json",
      "https://github.com/zed-pkg-test/github-api-fallback-canary/releases/download/v0.0.2/zpkg-zed-pkg-test-github-api-fallback-canary-0.0.2.json",
      "https://release-assets.githubusercontent.com/public-sidecar.json?signed=1",
    ],
  );

  const metadata = await response.json();
  assert.equal(metadata.org, "zed-pkg-test");
  assert.equal(metadata.name, "github-api-fallback-canary");
  assert.equal(metadata.version, "0.0.2");
  assert.equal(metadata.sha256, digest);
  assert.equal(metadata.size, 1578807);
  assert.equal(metadata.download_url, downloadUrl);
});

test("the production CDN service binding supplies validated GitHub sidecars", async () => {
  const digest = "b05c249a8a9cd0a383d042580b6dbaa4e828dd5ec201936d865055f26a023f43";
  const downloadUrl =
    "https://github.com/zed-pkg-test/github-api-fallback-canary/releases/download/v0.0.2/zpkg-zed-pkg-test-github-api-fallback-canary-0.0.2.tar.gz";
  const serviceCalls = [];

  globalThis.fetch = async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    assert.match(url, /^https:\/\/api\.zpkg\.net\//);
    throw new TypeError("simulated Rust origin outage");
  };

  const response = await worker.fetch(
    request("/v1/packages/zed-pkg-test/github-api-fallback-canary/versions/0.0.2"),
    {
      ORIGIN_URL: "https://api.zpkg.net",
      CDN: {
        async fetch(input) {
          serviceCalls.push(String(input));
          return new Response(
            JSON.stringify({
              org: "zed-pkg-test",
              name: "github-api-fallback-canary",
              version: "0.0.2",
              sha256: digest,
              size: 1578807,
              format: "tar.gz",
              download_url: downloadUrl,
              yanked: false,
            }),
            { headers: { "content-type": "application/octet-stream" } },
          );
        },
      },
    },
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-zed-source"), "github-public");
  assert.deepEqual(serviceCalls, [
    "https://cdn.zpkg.net/github/zed-pkg-test/github-api-fallback-canary/v0.0.2/zpkg-zed-pkg-test-github-api-fallback-canary-0.0.2.json",
  ]);
  assert.equal((await response.json()).sha256, digest);
});

test("a public sidecar cannot point at another repository's release", async () => {
  const digest = "b05c249a8a9cd0a383d042580b6dbaa4e828dd5ec201936d865055f26a023f43";
  globalThis.fetch = async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith("https://api.zpkg.net/")) return new Response(null, { status: 503 });
    if (url.includes("/releases/download/") && url.endsWith(".json")) {
      const response = new Response(
        JSON.stringify({
          org: "acme",
          name: "public-lib",
          version: "1.0.0",
          sha256: digest,
          size: 10,
          download_url:
            "https://github.com/another/repository/releases/download/v1.0.0/zpkg-acme-public-lib-1.0.0.tar.gz",
        }),
        { headers: { "content-type": "application/json" } },
      );
      Object.defineProperty(response, "url", {
        value: "https://release-assets.githubusercontent.com/untrusted-sidecar.json",
      });
      return response;
    }
    if (url === "https://api.github.com/repos/acme/public-lib") {
      return new Response(null, { status: 403 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  const response = await worker.fetch(
    request("/v1/packages/acme/public-lib/versions/1.0.0"),
    { ORIGIN_URL: "https://api.zpkg.net" },
  );
  assert.equal(response.status, 503);
});

test("health stays available in explicit degraded mode when the Rust origin is down", async () => {
  globalThis.fetch = async () => {
    throw new TypeError("simulated Rust origin outage");
  };

  const response = await worker.fetch(request("/healthz"), {
    ORIGIN_URL: "https://api.zpkg.net",
    ORIGIN_TIMEOUT_MS: "100",
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-zed-edge"), "registry");
  assert.equal(response.headers.get("x-zed-source"), "edge-fallback");
  assert.deepEqual(await response.json(), {
    ok: true,
    db: false,
    degraded: true,
    source: "edge-fallback",
    fallbacks: ["github-public", "npm-public", "crates-io-public"],
  });
});
