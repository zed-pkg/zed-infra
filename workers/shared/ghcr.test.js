import assert from "node:assert/strict";
import test from "node:test";

import { sha256Hex } from "./edge-publish.js";
import {
  artifactManifest,
  EMPTY_CONFIG,
  EMPTY_CONFIG_DIGEST,
  ghcrBlobUrl,
  ghcrManifestUrl,
  ghcrRepositoryPath,
  ghcrToken,
  pushArtifactToGhcr,
  readGhcrArtifact,
} from "./ghcr.js";

const DIGEST = "f".repeat(64);

/** Records every request so a test can assert what reached the network. */
function recordingFetch(handler) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init, calls.length);
  };
  impl.calls = calls;
  return impl;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("the empty config digest is the digest of the empty object", async () => {
  // Hardcoded in the manifest, so it has to actually be right.
  assert.equal(`sha256:${await sha256Hex(new TextEncoder().encode(EMPTY_CONFIG))}`, EMPTY_CONFIG_DIGEST);
});

test("repository paths are lowercased and bounded", () => {
  assert.equal(ghcrRepositoryPath("ORESoftware", "K8s-Telemetry-RS"), "oresoftware/k8s-telemetry-rs");
  assert.equal(ghcrRepositoryPath("org", "pkg"), "org/pkg");
  for (const [org, name] of [
    ["../etc", "pkg"],
    ["org", "pkg/evil"],
    ["-leading", "pkg"],
    ["org", ""],
  ]) {
    assert.equal(ghcrRepositoryPath(org, name), null, `${org}/${name}`);
  }
});

test("the manifest describes exactly one artifact layer", () => {
  const manifest = artifactManifest({ digest: DIGEST, size: 1234 });
  assert.equal(manifest.schemaVersion, 2);
  assert.equal(manifest.config.digest, EMPTY_CONFIG_DIGEST);
  assert.equal(manifest.layers.length, 1);
  assert.equal(manifest.layers[0].digest, `sha256:${DIGEST}`);
  assert.equal(manifest.layers[0].size, 1234);
  assert.equal(artifactManifest({ digest: "short", size: 1 }), null);
  assert.equal(artifactManifest({ digest: DIGEST, size: 0 }), null);
});

test("reads are anonymous, so a private package simply misses", async () => {
  const fetchImpl = recordingFetch((url) => {
    if (url.includes("/token")) return json({ token: "anon" });
    return new Response("denied", { status: 401 });
  });
  assert.equal(await readGhcrArtifact("org/pkg", "0.2.0", { fetchImpl }), null);
  // No credential may be attached on a read path: the public edge must not
  // make private repositories observable.
  for (const call of fetchImpl.calls) {
    const auth = new Headers(call.init.headers).get("authorization") || "";
    assert.ok(!auth.startsWith("Basic "), "read path must not send a credential");
  }
});

test("a published image resolves to its layer digest and a blob URL", async () => {
  const fetchImpl = recordingFetch((url) => {
    if (url.includes("/token")) return json({ token: "anon" });
    if (url === ghcrManifestUrl("org/pkg", "0.2.0")) {
      return json(artifactManifest({ digest: DIGEST, size: 4096 }));
    }
    return new Response("not found", { status: 404 });
  });
  const found = await readGhcrArtifact("org/pkg", "0.2.0", { fetchImpl });
  assert.deepEqual(found, {
    digest: DIGEST,
    size: 4096,
    downloadUrl: ghcrBlobUrl("org/pkg", `sha256:${DIGEST}`),
  });
});

test("a manifest that is not a single-layer artifact is ignored", async () => {
  const shapes = [{ layers: [] }, { layers: [{ digest: "nope", size: 1 }] }, { nothing: true }];
  for (const shape of shapes) {
    const fetchImpl = recordingFetch((url) =>
      url.includes("/token") ? json({ token: "anon" }) : json(shape),
    );
    assert.equal(await readGhcrArtifact("org/pkg", "0.2.0", { fetchImpl }), null);
  }
});

test("pushing uploads both blobs and then the manifest", async () => {
  const bytes = new TextEncoder().encode("artifact bytes");
  const fetchImpl = recordingFetch((url) => {
    if (url.includes("/token")) return json({ token: "registry-bearer" });
    if (url.includes("/blobs/uploads/")) return new Response(null, { status: 201 });
    if (url.includes("/manifests/")) return new Response(null, { status: 201 });
    return new Response("unexpected", { status: 500 });
  });
  const result = await pushArtifactToGhcr({
    repository: "org/pkg",
    reference: "0.2.0",
    bytes,
    digest: DIGEST,
    token: "github-pat",
    fetchImpl,
  });
  assert.deepEqual(result, { ok: true, reference: "0.2.0", digest: DIGEST });

  const urls = fetchImpl.calls.map((call) => call.url);
  assert.ok(urls[0].includes("scope=repository%3Aorg%2Fpkg%3Apush%2Cpull"), urls[0]);
  assert.ok(urls.some((url) => url.includes(encodeURIComponent(EMPTY_CONFIG_DIGEST))));
  assert.ok(urls.some((url) => url.includes(encodeURIComponent(`sha256:${DIGEST}`))));
  assert.equal(urls.at(-1), ghcrManifestUrl("org/pkg", "0.2.0"));

  // Only the token exchange carries the PAT; every registry call uses the
  // short-lived bearer it returned.
  for (const call of fetchImpl.calls.slice(1)) {
    assert.equal(new Headers(call.init.headers).get("authorization"), "Bearer registry-bearer");
  }
});

test("pushing without a token is refused before any request", async () => {
  const fetchImpl = recordingFetch(() => new Response(null, { status: 500 }));
  const result = await pushArtifactToGhcr({
    repository: "org/pkg",
    reference: "0.2.0",
    bytes: new Uint8Array([1]),
    digest: DIGEST,
    token: null,
    fetchImpl,
  });
  assert.deepEqual(result, { ok: false, reason: "no_token" });
  assert.equal(fetchImpl.calls.length, 0, "an unconfigured mirror makes no network calls");
});

test("each upload failure is reported distinctly rather than as success", async () => {
  const cases = [
    { fail: "token", reason: "token_refused" },
    { fail: "config", reason: "config_upload_failed" },
    { fail: "layer", reason: "layer_upload_failed" },
    { fail: "manifest", reason: "manifest_rejected" },
  ];
  for (const { fail, reason } of cases) {
    let blobUploads = 0;
    const fetchImpl = recordingFetch((url) => {
      if (url.includes("/token")) {
        return fail === "token" ? new Response(null, { status: 403 }) : json({ token: "bearer" });
      }
      if (url.includes("/blobs/uploads/")) {
        blobUploads += 1;
        const failing = fail === "config" ? 1 : fail === "layer" ? 2 : 0;
        return new Response(null, { status: blobUploads === failing ? 400 : 201 });
      }
      return new Response(null, { status: fail === "manifest" ? 400 : 201 });
    });
    const result = await pushArtifactToGhcr({
      repository: "org/pkg",
      reference: "0.2.0",
      bytes: new TextEncoder().encode("bytes"),
      digest: DIGEST,
      token: "github-pat",
      fetchImpl,
    });
    assert.deepEqual(result, { ok: false, reason }, fail);
  }
});

test("a refused token exchange yields no bearer", async () => {
  const fetchImpl = recordingFetch(() => new Response("no", { status: 401 }));
  assert.equal(await ghcrToken("org/pkg", "pull", { fetchImpl }), null);
});
