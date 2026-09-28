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

function responseWithUrl(body, init, url) {
  const response = new Response(body, init);
  Object.defineProperty(response, "url", { value: url });
  return response;
}

test("registry proxy lists Terraform module versions through the public module protocol", async () => {
  const coordinate = encodeNativeCoordinate("hashicorp/consul/aws");
  const versionsUrl = "https://registry.terraform.io/v1/modules/hashicorp/consul/aws/versions";

  globalThis.fetch = async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith("https://api.zpkg.net/")) {
      return new Response(null, { status: 503 });
    }
    if (url === versionsUrl) {
      return responseWithUrl(
        JSON.stringify({
          modules: [
            {
              versions: [
                { version: "0.2.0" },
                { version: "0.1.0" },
              ],
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
        versionsUrl,
      );
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  const response = await worker.fetch(
    request(`/v1/packages/terraform/${coordinate}`),
    { ORIGIN_URL: "https://api.zpkg.net" },
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-zed-source"), "native-terraform");
  const metadata = await response.json();
  assert.deepEqual(metadata.versions, ["0.2.0", "0.1.0"]);
  assert.equal(metadata.latest, "0.2.0");
  assert.equal(metadata.native_host, "terraform");
});

test("registry proxy resolves and hashes a confined Terraform module tarball", async () => {
  const coordinate = encodeNativeCoordinate("hashicorp/consul/aws");
  const downloadEndpoint =
    "https://registry.terraform.io/v1/modules/hashicorp/consul/aws/0.1.0/download";
  const artifactUrl =
    "https://codeload.github.com/hashicorp/terraform-aws-consul/tar.gz/v0.1.0";
  const artifact = new TextEncoder().encode("terraform-module-tar-gz");
  const seen = [];

  globalThis.fetch = async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    seen.push(url);
    if (url.startsWith("https://api.zpkg.net/")) {
      return new Response(null, { status: 503 });
    }
    if (url === downloadEndpoint) {
      return responseWithUrl(
        null,
        {
          status: 204,
          headers: {
            "x-terraform-get":
              "https://api.github.com/repos/hashicorp/terraform-aws-consul/tarball/v0.1.0//*?archive=tar.gz",
          },
        },
        downloadEndpoint,
      );
    }
    if (url === artifactUrl) {
      return responseWithUrl(
        artifact,
        {
          status: 200,
          headers: {
            "content-type": "application/gzip",
            "content-length": String(artifact.byteLength),
          },
        },
        artifactUrl,
      );
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  const response = await worker.fetch(
    request(`/v1/packages/terraform/${coordinate}/versions/0.1.0`),
    { ORIGIN_URL: "https://api.zpkg.net" },
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-zed-source"), "native-terraform");
  const metadata = await response.json();
  assert.equal(metadata.format, "tar.gz");
  assert.equal(metadata.size, artifact.byteLength);
  assert.match(metadata.sha256, /^[a-f0-9]{64}$/);
  assert.equal(metadata.download_url, artifactUrl);
  assert.deepEqual(seen, [
    `https://api.zpkg.net/v1/packages/terraform/${coordinate}/versions/0.1.0`,
    downloadEndpoint,
    artifactUrl,
  ]);
});

test("Terraform providers remain fail-closed and never reach the module API", async () => {
  const providerCoordinate = encodeNativeCoordinate("hashicorp/aws");
  const seen = [];

  globalThis.fetch = async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    seen.push(url);
    if (url.startsWith("https://api.zpkg.net/")) {
      return new Response(null, { status: 503 });
    }
    return new Response(null, { status: 404 });
  };

  const response = await worker.fetch(
    request(`/v1/packages/terraform/${providerCoordinate}/versions/6.0.0`),
    { ORIGIN_URL: "https://api.zpkg.net" },
  );

  assert.equal(response.status, 503);
  assert.equal(
    seen.some((url) => url.startsWith("https://registry.terraform.io/v1/modules/")),
    false,
  );
});

test("Terraform module fallback rejects arbitrary getter transports before artifact I/O", async () => {
  const coordinate = encodeNativeCoordinate("hashicorp/consul/aws");
  const downloadEndpoint =
    "https://registry.terraform.io/v1/modules/hashicorp/consul/aws/0.1.0/download";
  const seen = [];

  globalThis.fetch = async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    seen.push(url);
    if (url.startsWith("https://api.zpkg.net/")) {
      return new Response(null, { status: 503 });
    }
    if (url === downloadEndpoint) {
      return responseWithUrl(
        null,
        {
          status: 204,
          headers: {
            "x-terraform-get":
              "git::https://github.com/hashicorp/terraform-aws-consul.git?ref=v0.1.0",
          },
        },
        downloadEndpoint,
      );
    }
    return new Response(null, { status: 404 });
  };

  const response = await worker.fetch(
    request(`/v1/packages/terraform/${coordinate}/versions/0.1.0`),
    { ORIGIN_URL: "https://api.zpkg.net" },
  );

  assert.equal(response.status, 503);
  assert.deepEqual(seen.slice(0, 2), [
    `https://api.zpkg.net/v1/packages/terraform/${coordinate}/versions/0.1.0`,
    downloadEndpoint,
  ]);
  assert.equal(
    seen.some((url) => url.startsWith("https://codeload.github.com/")),
    false,
  );
});
