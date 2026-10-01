import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { encodeNativeCoordinate } from "../../shared/native-registry-catalog.js";
import worker from "./index.js";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function request(path) {
  return new Request(`https://registry.zpkg.net${path}`);
}

function packagistBody(reference) {
  return {
    minified: "composer/2.0",
    packages: {
      "vendor/package": [
        {
          name: "vendor/package",
          version: "1.2.3",
          source: {
            type: "git",
            url: "https://github.com/upstream/project.git",
            reference,
          },
          dist: {
            type: "zip",
            url: `https://api.github.com/repos/upstream/project/zipball/${reference}`,
            reference,
            shasum: "",
          },
        },
      ],
    },
  };
}

test("registry proxy preserves Packagist repository/commit validation through hashing", async () => {
  const reference = "a".repeat(40);
  const coordinate = encodeNativeCoordinate("vendor/package");
  const artifact = new TextEncoder().encode("immutable-packagist-zip");
  const seen = [];

  globalThis.fetch = async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    seen.push(url);

    if (url.startsWith("https://api.zpkg.net/")) {
      return new Response(null, { status: 503 });
    }
    if (url === "https://repo.packagist.org/p2/vendor/package.json") {
      return new Response(JSON.stringify(packagistBody(reference)), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url === `https://codeload.github.com/upstream/project/zip/${reference}`) {
      return new Response(artifact, {
        status: 200,
        headers: {
          "content-type": "application/zip",
          "content-length": String(artifact.byteLength),
        },
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  const response = await worker.fetch(
    request(`/v1/packages/packagist/${coordinate}/versions/1.2.3`),
    { ORIGIN_URL: "https://api.zpkg.net" },
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-zed-source"), "native-packagist");
  const metadata = await response.json();
  assert.equal(metadata.format, "zip");
  assert.equal(metadata.size, artifact.byteLength);
  assert.match(metadata.sha256, /^[a-f0-9]{64}$/);
  assert.equal(
    metadata.download_url,
    `https://codeload.github.com/upstream/project/zip/${reference}`,
  );
  assert.deepEqual(seen, [
    `https://api.zpkg.net/v1/packages/packagist/${coordinate}/versions/1.2.3`,
    "https://repo.packagist.org/p2/vendor/package.json",
    `https://codeload.github.com/upstream/project/zip/${reference}`,
  ]);
});

test("registry proxy rejects a Packagist artifact redirect to a different commit", async () => {
  const reference = "a".repeat(40);
  const otherReference = "b".repeat(40);
  const coordinate = encodeNativeCoordinate("vendor/package");

  globalThis.fetch = async (input) => {
    const url = input instanceof Request ? input.url : String(input);

    if (url.startsWith("https://api.zpkg.net/")) {
      return new Response(null, { status: 503 });
    }
    if (url === "https://repo.packagist.org/p2/vendor/package.json") {
      return new Response(JSON.stringify(packagistBody(reference)), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url === `https://codeload.github.com/upstream/project/zip/${reference}`) {
      return new Response(null, {
        status: 302,
        headers: {
          location: `https://codeload.github.com/upstream/project/zip/${otherReference}`,
        },
      });
    }
    if (url.includes("github.com/packagist/")) {
      return new Response(null, { status: 404 });
    }
    return new Response(null, { status: 404 });
  };

  const response = await worker.fetch(
    request(`/v1/packages/packagist/${coordinate}/versions/1.2.3`),
    { ORIGIN_URL: "https://api.zpkg.net" },
  );

  assert.equal(response.status, 503);
});
