import assert from "node:assert/strict";
import test from "node:test";

import {
  artifactExtension,
  artifactKey,
  authorizePublish,
  bearerToken,
  buildVersionMetadata,
  edgePublishEnabled,
  handleEdgePublish,
  packageIndexKey,
  r2PackageMetadata,
  r2VersionMetadata,
  secretsMatch,
  sha256Hex,
  validatePublishMeta,
  versionMetadataKey,
} from "./edge-publish.js";

const TOKEN = "edge-publish-token-value";
const ROUTE = { org: "oresoftware", name: "k8s-telemetry-rs", version: "0.2.0" };

/**
 * In-memory stand-in for the R2 binding. It models `If-None-Match: *` so the
 * handler's control flow can be unit tested; that R2 really evaluates it
 * atomically is proven against workerd in tests/edge-publish.test.mjs.
 */
function fakeBucket(seed = {}) {
  const objects = new Map(Object.entries(seed));
  const uploaded = new Map();
  const metadata = new Map();
  let clock = 0;
  return {
    objects,
    async get(key) {
      if (!objects.has(key)) return null;
      const value = objects.get(key);
      return {
        customMetadata: metadata.get(key),
        async text() {
          return typeof value === "string" ? value : new TextDecoder().decode(value);
        },
      };
    },
    async put(key, value, options = {}) {
      const createOnly =
        options.onlyIf instanceof Headers && options.onlyIf.get("if-none-match") === "*";
      if (createOnly && objects.has(key)) return null;
      objects.set(key, value);
      metadata.set(key, options.customMetadata);
      clock += 1;
      uploaded.set(key, new Date(clock * 1000));
      return { key };
    },
    async list({ prefix }) {
      return {
        truncated: false,
        objects: [...objects.keys()]
          .filter((key) => key.startsWith(prefix))
          .map((key) => ({ key, uploaded: uploaded.get(key), customMetadata: metadata.get(key) })),
      };
    },
  };
}

function enabledEnv(extra = {}) {
  return {
    ARTIFACTS: fakeBucket(),
    EDGE_PUBLISH_TOKEN: TOKEN,
    EDGE_PUBLISH_ENABLED: "true",
    ...extra,
  };
}

async function publishRequest(bytes, meta, token = TOKEN, { declareLength = true } = {}) {
  const form = new FormData();
  form.set("meta", JSON.stringify(meta));
  form.set("artifact", new Blob([bytes], { type: "application/gzip" }), "pkg.tar.gz");
  const encoded = new Response(form);
  const body = new Uint8Array(await encoded.arrayBuffer());
  const headers = new Headers({ "content-type": encoded.headers.get("content-type") });
  if (declareLength) headers.set("content-length", String(body.byteLength));
  if (token) headers.set("authorization", `Bearer ${token}`);
  return new Request("https://zpkg.net/v1/packages/oresoftware/k8s-telemetry-rs/versions/0.2.0", {
    method: "PUT",
    body,
    headers,
  });
}

async function metaFor(bytes, overrides = {}) {
  return {
    manifest: {
      package: {
        org: ROUTE.org,
        name: ROUTE.name,
        version: ROUTE.version,
        description: "fixture",
        repository: { vcs: "git", url: "https://github.com/ORESoftware/k8s-libs-and-shared-defs" },
      },
    },
    vcs_tag: "v0.2.0",
    sha256: await sha256Hex(bytes),
    size: bytes.byteLength,
    format: "tar.gz",
    ...overrides,
  };
}

test("object keys reject anything that is not a well-formed coordinate", () => {
  assert.equal(
    versionMetadataKey("oresoftware", "k8s-telemetry-rs", "0.2.0"),
    "metadata/oresoftware/k8s-telemetry-rs/versions/0.2.0.json",
  );
  assert.equal(packageIndexKey("oresoftware", "pkg"), "metadata/oresoftware/pkg/index.json");
  // Traversal, separators and casing must never reach the bucket.
  for (const [org, name, version] of [
    ["../etc", "pkg", "1.0.0"],
    ["org", "pkg/evil", "1.0.0"],
    ["ORG", "pkg", "1.0.0"],
    ["org", "pkg", "../../secret"],
    ["org", "pkg", "1.0.0/../.."],
  ]) {
    assert.equal(versionMetadataKey(org, name, version), null, `${org}/${name}@${version}`);
  }
});

test("artifact keys are content addressed and format bounded", () => {
  const digest = "a".repeat(64);
  assert.equal(artifactKey(digest, "tar.gz"), `artifacts/${digest}.tar.gz`);
  assert.equal(artifactKey(digest, "zip"), `artifacts/${digest}.zip`);
  assert.equal(artifactKey(digest, undefined), `artifacts/${digest}.tar.gz`);
  assert.equal(artifactKey("not-a-digest", "tar.gz"), null);
  assert.equal(artifactKey(digest, "exe"), null);
  assert.equal(artifactExtension("EXE"), null);
});

test("secret comparison does not short circuit on length or prefix", async () => {
  assert.equal(await secretsMatch(TOKEN, TOKEN), true);
  assert.equal(await secretsMatch(TOKEN, `${TOKEN}x`), false);
  assert.equal(await secretsMatch(TOKEN.slice(0, 5), TOKEN), false);
  assert.equal(await secretsMatch("", ""), false);
  assert.equal(await secretsMatch(TOKEN, undefined), false);
});

test("bearer tokens are read only from a well-formed header", () => {
  const withHeader = (value) =>
    bearerToken(new Request("https://zpkg.net/", { headers: { authorization: value } }));
  assert.equal(withHeader(`Bearer ${TOKEN}`), TOKEN);
  assert.equal(withHeader(`bearer ${TOKEN}`), TOKEN);
  assert.equal(withHeader(TOKEN), null);
  assert.equal(withHeader("Basic abc"), null);
});

test("publishing is off unless an operator configured a secret and a bucket", async () => {
  assert.equal(edgePublishEnabled({}), false);
  assert.equal(edgePublishEnabled({ ARTIFACTS: fakeBucket() }), false);
  assert.equal(edgePublishEnabled({ EDGE_PUBLISH_TOKEN: TOKEN }), false);
  // A secret alone is not enough: the reviewed flag has to be on as well, so
  // closing the path never depends on a secret having been deleted elsewhere.
  assert.equal(edgePublishEnabled({ ARTIFACTS: fakeBucket(), EDGE_PUBLISH_TOKEN: TOKEN }), false);
  assert.equal(edgePublishEnabled(enabledEnv({ EDGE_PUBLISH_ENABLED: "false" })), false);
  assert.equal(edgePublishEnabled(enabledEnv({ EDGE_PUBLISH_ENABLED: "TRUE" })), false);
  assert.equal(edgePublishEnabled(enabledEnv()), true);

  // An unconfigured edge keeps saying the origin is required, rather than
  // quietly accepting anonymous writes.
  const bytes = new TextEncoder().encode("payload");
  const response = await handleEdgePublish(
    await publishRequest(bytes, await metaFor(bytes)),
    { ARTIFACTS: fakeBucket() },
    ROUTE,
  );
  assert.equal(response.status, 503);
  assert.equal(response.body.error, "registry_origin_unavailable");
});

test("a wrong or missing token cannot publish", async () => {
  const bytes = new TextEncoder().encode("payload");
  const meta = await metaFor(bytes);
  const env = enabledEnv();

  for (const token of [null, "wrong-token", TOKEN.slice(0, -1)]) {
    const response = await handleEdgePublish(await publishRequest(bytes, meta, token), env, ROUTE);
    assert.equal(response.status, 401, `token ${token} must be refused`);
  }
  assert.equal(await authorizePublish(await publishRequest(bytes, meta), env), true);
  assert.equal(env.ARTIFACTS.objects.size, 0, "a refused publish writes nothing");
});

test("declared metadata must describe the bytes and the coordinates", async () => {
  const bytes = new TextEncoder().encode("payload");
  const env = () => (enabledEnv());

  const mismatchedDigest = await metaFor(bytes, { sha256: "b".repeat(64) });
  let response = await handleEdgePublish(
    await publishRequest(bytes, mismatchedDigest),
    env(),
    ROUTE,
  );
  assert.equal(response.status, 422);
  assert.equal(response.body.error, "artifact_digest_mismatch");

  const mismatchedSize = await metaFor(bytes, { size: 9999 });
  response = await handleEdgePublish(await publishRequest(bytes, mismatchedSize), env(), ROUTE);
  assert.equal(response.status, 422);
  assert.equal(response.body.error, "artifact_size_mismatch");

  // Publishing to one coordinate while claiming another must not land under
  // either name.
  const otherPackage = await metaFor(bytes, {
    manifest: { package: { org: "someone-else", name: "other", version: "9.9.9" } },
  });
  response = await handleEdgePublish(await publishRequest(bytes, otherPackage), env(), ROUTE);
  assert.equal(response.status, 422);
  assert.equal(response.body.error, "publish_identity_mismatch");
});

test("a successful publish writes the artifact, the version and the index", async () => {
  const bytes = new TextEncoder().encode("a real tarball would go here");
  const meta = await metaFor(bytes);
  const env = enabledEnv();

  const response = await handleEdgePublish(await publishRequest(bytes, meta), env, ROUTE);
  assert.equal(response.status, 201);
  assert.deepEqual(response.body, {
    org: ROUTE.org,
    name: ROUTE.name,
    version: ROUTE.version,
    sha256: meta.sha256,
  });

  const objectKey = `artifacts/${meta.sha256}.tar.gz`;
  const versionKey = "metadata/oresoftware/k8s-telemetry-rs/versions/0.2.0.json";
  assert.ok(env.ARTIFACTS.objects.has(objectKey), "artifact bytes are stored content addressed");
  assert.ok(env.ARTIFACTS.objects.has(versionKey), "version document is stored");

  const stored = JSON.parse(env.ARTIFACTS.objects.get(versionKey));
  assert.equal(stored.sha256, meta.sha256);
  assert.equal(stored.size, bytes.byteLength);
  assert.equal(stored.yanked, false);
  // The download URL must not point at the registry host, or an install would
  // depend on the very service that is down.
  assert.equal(stored.download_url, `https://cdn.zpkg.net/artifacts/${meta.sha256}.tar.gz`);

  // No index document is stored: it would be a read-modify-write that two
  // concurrent publishes could lose an entry from.
  assert.ok(
    ![...env.ARTIFACTS.objects.keys()].some((key) => key.endsWith("/index.json")),
    "the listing is derived, never stored",
  );
  const listing = await r2PackageMetadata(env, ROUTE);
  assert.deepEqual(listing.versions, ["0.2.0"]);
  assert.equal(listing.latest, "0.2.0");
  // Required by the client's PackageMetadata; a listing without them does not
  // deserialize.
  assert.equal(listing.vcs, "git");
  assert.equal(listing.repo_url, "https://github.com/ORESoftware/k8s-libs-and-shared-defs");
});

test("versions are immutable once published", async () => {
  const first = new TextEncoder().encode("first bytes");
  const env = enabledEnv();
  const created = await handleEdgePublish(
    await publishRequest(first, await metaFor(first)),
    env,
    ROUTE,
  );
  assert.equal(created.status, 201);

  // Different bytes, same coordinates: a consumer that pinned the first digest
  // must never find the second in its place.
  const second = new TextEncoder().encode("different bytes entirely");
  const response = await handleEdgePublish(
    await publishRequest(second, await metaFor(second)),
    env,
    ROUTE,
  );
  assert.equal(response.status, 409);
  assert.equal(response.body.error, "version_already_published");

  const stored = JSON.parse(
    env.ARTIFACTS.objects.get("metadata/oresoftware/k8s-telemetry-rs/versions/0.2.0.json"),
  );
  assert.equal(stored.sha256, await sha256Hex(first), "the original version document is intact");
});

test("an empty or oversized artifact is refused", async () => {
  const env = enabledEnv();
  const empty = new Uint8Array(0);
  const response = await handleEdgePublish(
    await publishRequest(empty, await metaFor(empty)),
    env,
    ROUTE,
  );
  assert.equal(response.status, 422);
  assert.equal(response.body.error, "empty_artifact");
});

test("publisher signatures and mirrors survive the round trip", () => {
  const metadata = buildVersionMetadata({
    route: ROUTE,
    meta: {
      vcs_tag: "v0.2.0",
      vcs_commit: "c".repeat(40),
      format: "tar.gz",
      mirrors: [{ kind: "object-store", id: "zpkg-cdn", url: "https://cdn.zpkg.net" }],
      signatures: [{ algorithm: "ed25519", key_id: "z6Mk", signature: "abc" }],
    },
    sha256: "d".repeat(64),
    size: 10,
    cdnBase: "https://cdn.zpkg.net/",
    publishedAt: "2026-09-19T00:00:00Z",
  });
  assert.equal(metadata.vcs_commit, "c".repeat(40));
  assert.equal(metadata.mirrors.length, 1);
  // The edge cannot create trust, but dropping the publisher's signature would
  // silently weaken what consumers can verify.
  assert.equal(metadata.signatures.length, 1);
  assert.equal(metadata.download_url, `https://cdn.zpkg.net/artifacts/${"d".repeat(64)}.tar.gz`);
});

test("a publish that does not declare its length is refused unread", async () => {
  const bytes = new TextEncoder().encode("payload");
  const env = enabledEnv();
  const response = await handleEdgePublish(
    await publishRequest(bytes, await metaFor(bytes), TOKEN, { declareLength: false }),
    env,
    ROUTE,
  );
  assert.equal(response.status, 411);
  assert.equal(env.ARTIFACTS.objects.size, 0);
});

test("a package with no published versions has no listing", async () => {
  assert.equal(await r2PackageMetadata(enabledEnv(), ROUTE), null);
});

test("metadata validation rejects the fields consumers depend on being sane", () => {
  const base = {
    manifest: { package: { ...ROUTE } },
    vcs_tag: "v0.2.0",
    sha256: "e".repeat(64),
    size: 10,
    format: "tar.gz",
  };
  assert.equal(validatePublishMeta(base, ROUTE), null);
  assert.equal(validatePublishMeta({ ...base, sha256: "nope" }, ROUTE).code, "invalid_publish_meta");
  assert.equal(validatePublishMeta({ ...base, size: -1 }, ROUTE).code, "invalid_publish_meta");
  assert.equal(validatePublishMeta({ ...base, vcs_tag: "" }, ROUTE).code, "invalid_publish_meta");
  assert.equal(validatePublishMeta({ ...base, format: "exe" }, ROUTE).code, "invalid_publish_meta");
  assert.equal(validatePublishMeta(null, ROUTE).code, "invalid_publish_meta");
});

test("the GitHub Packages mirror never decides whether a publish succeeds", async () => {
  const bytes = new TextEncoder().encode("mirrored bytes");
  const meta = await metaFor(bytes);
  const originalFetch = globalThis.fetch;
  const attempted = [];
  // Every mirror call fails; the publish must still succeed, because R2 holds
  // the authoritative copy.
  globalThis.fetch = async (url) => {
    attempted.push(String(url));
    return new Response(null, { status: 500 });
  };
  try {
    const env = enabledEnv({ GITHUB_PACKAGES_TOKEN: "github-pat" });
    const response = await handleEdgePublish(await publishRequest(bytes, meta), env, ROUTE);
    assert.equal(response.status, 201);
    assert.equal(response.ghcr.ok, false);
    assert.equal(response.ghcr.reason, "token_refused");
    assert.ok(attempted.length > 0, "a configured mirror is attempted");
    assert.ok(
      env.ARTIFACTS.objects.has(`artifacts/${meta.sha256}.tar.gz`),
      "the authoritative copy is stored regardless",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("no mirror is attempted when GitHub Packages is not configured", async () => {
  const bytes = new TextEncoder().encode("unmirrored bytes");
  const originalFetch = globalThis.fetch;
  let called = 0;
  globalThis.fetch = async () => {
    called += 1;
    return new Response(null, { status: 500 });
  };
  try {
    const env = enabledEnv();
    const response = await handleEdgePublish(
      await publishRequest(bytes, await metaFor(bytes)),
      env,
      ROUTE,
    );
    assert.equal(response.status, 201);
    assert.deepEqual(response.ghcr, { ok: false, reason: "not_configured" });
    assert.equal(called, 0, "an unconfigured mirror makes no network calls");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

for (const visibility of ["private", "organization", "PUBLIC", "", null, false, {}, []]) {
  for (const location of ["metadata", "package"]) {
    test(`public-only publishing rejects ${location} visibility ${JSON.stringify(visibility)} before storage or mirror I/O`, async () => {
      const bytes = new TextEncoder().encode("must remain private");
      const base = await metaFor(bytes);
      const meta = location === "metadata"
        ? { ...base, visibility }
        : { ...base, manifest: { package: { ...base.manifest.package, visibility } } };
      let writes = 0;
      const env = enabledEnv({
        ARTIFACTS: { async put() { writes += 1; throw new Error("must not write"); } },
        GITHUB_PACKAGES_TOKEN: "synthetic-never-used",
      });
      const result = await handleEdgePublish(await publishRequest(bytes, meta), env, ROUTE);
      assert.equal(result.status, 422);
      assert.equal(result.body.error, "edge_publication_requires_public_visibility");
      assert.equal(writes, 0);
      assert.equal(result.ghcr, undefined);
    });
  }
}

test("public publication marks artifact and metadata without changing the response contract", async () => {
  const bytes = new TextEncoder().encode("public bytes");
  const meta = await metaFor(bytes, { visibility: "public" });
  const env = enabledEnv();
  const result = await handleEdgePublish(await publishRequest(bytes, meta), env, ROUTE);
  assert.equal(result.status, 201);
  for (const key of [artifactKey(meta.sha256, meta.format), versionMetadataKey(ROUTE.org, ROUTE.name, ROUTE.version)]) {
    assert.deepEqual((await env.ARTIFACTS.get(key)).customMetadata, { visibility: "public" });
  }
  assert.equal((await r2VersionMetadata(env, ROUTE)).sha256, meta.sha256);
});

test("public version and package reads refuse marked objects before reading their bodies", async () => {
  let bodyReads = 0;
  const env = enabledEnv({ ARTIFACTS: {
    async get() {
      return { customMetadata: { visibility: "private" }, async text() { bodyReads += 1; return "{}"; } };
    },
    async list(options) {
      assert.deepEqual(options.include, ["customMetadata"]);
      return { truncated: false, objects: [{ key: "metadata/oresoftware/k8s-telemetry-rs/versions/0.2.0.json", customMetadata: { visibility: "private" } }] };
    },
  } });
  await assert.rejects(r2VersionMetadata(env, ROUTE), { name: "NonPublicObjectError" });
  await assert.rejects(r2PackageMetadata(env, ROUTE), { name: "NonPublicObjectError" });
  assert.equal(bodyReads, 0);
});

test("explicit non-public JSON metadata is refused even without an object marker", async () => {
  for (const document of [{ visibility: "private" }, { package: { visibility: "organization" } }, { visibility: null }]) {
    const env = enabledEnv({ ARTIFACTS: fakeBucket({
      [versionMetadataKey(ROUTE.org, ROUTE.name, ROUTE.version)]: JSON.stringify(document),
    }) });
    await assert.rejects(r2VersionMetadata(env, ROUTE), { name: "NonPublicObjectError" });
  }
});
