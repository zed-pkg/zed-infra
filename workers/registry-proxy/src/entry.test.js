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
    if (url === "https://api.github.com/repos/zed-pkg-test/github-api-fallback-canary") {
      return new Response(
        JSON.stringify({
          name: "github-api-fallback-canary",
          owner: { login: "zed-pkg-test" },
          private: false,
          visibility: "public",
          default_branch: "main",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (
      url ===
      "https://api.github.com/repos/zed-pkg-test/github-api-fallback-canary/releases/tags/v0.0.2"
    ) {
      return new Response(
        JSON.stringify({
          draft: false,
          target_commitish: "main",
          published_at: "2026-09-01T21:16:46Z",
          assets: [
            {
              name: asset,
              digest: `sha256:${digest}`,
              size: 1578807,
              browser_download_url: downloadUrl,
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
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
      "https://api.github.com/repos/zed-pkg-test/github-api-fallback-canary",
      "https://api.github.com/repos/zed-pkg-test/github-api-fallback-canary/releases/tags/v0.0.2",
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
