import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from "miniflare";

const root = fileURLToPath(new URL("../", import.meta.url));
const TOKEN = "runtime-edge-publish-token";

// Actual HTTP client -> workerd -> the real registry Worker -> workerd's R2.
// The origin is a real TCP server that answers 503, which is the production
// condition this path exists for. Nothing here is a stub of the storage
// semantics under test: a fake bucket cannot prove an atomicity claim.
async function startRegistry(t, bindings = {}) {
  const origin = createServer((_request, response) => {
    response.writeHead(503);
    response.end("origin unavailable");
  });
  await new Promise((resolve) => origin.listen(0, "127.0.0.1", resolve));
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      workers: [
        {
          name: "zpkg-registry-proxy",
          modules: [
            "registry-proxy/src/index.js",
            "shared/github-fallback.js",
            "shared/native-public.js",
            "shared/edge-publish.js",
            "shared/ghcr.js",
            "shared/public-visibility.js",
          ].map((path) => ({ type: "ESModule", path: `${root}${path}` })),
          modulesRoot: root,
          compatibilityDate: "2026-08-28",
          compatibilityFlags: ["nodejs_compat"],
          r2Buckets: ["ARTIFACTS"],
          serviceBindings: { CDN: "zpkg-cdn" },
          bindings: {
            ORIGIN_URL: `http://127.0.0.1:${origin.address().port}`,
            ORIGIN_TIMEOUT_MS: "2000",
            FALLBACK_TIMEOUT_MS: "200",
            EDGE_PUBLISH_ENABLED: "true",
            EDGE_PUBLISH_TOKEN: TOKEN,
            ...bindings,
          },
        },
        {
          name: "zpkg-cdn",
          modules: [
            "cdn-proxy/src/index.js",
            "shared/github-fallback.js",
            "shared/native-public.js",
            "shared/public-visibility.js",
          ].map((path) => ({ type: "ESModule", path: `${root}${path}` })),
          modulesRoot: root,
          compatibilityDate: "2026-08-28",
          compatibilityFlags: ["nodejs_compat"],
          r2Buckets: ["ARTIFACTS"],
          bindings: { FALLBACK_TIMEOUT_MS: "200", MIRRORS: "[]" },
        },
      ],
      host: "127.0.0.1",
      cf: false,
      log: new Log(LogLevel.ERROR),
    }),
  );
  t.after(async () => {
    await mf.dispose();
    await new Promise((resolve) => origin.close(resolve));
  });
  return { base: await mf.ready, mf };
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function publish(base, { name = "pkg", version, bytes, token = TOKEN, omitLength = false, visibility }) {
  const form = new FormData();
  form.set(
    "meta",
    JSON.stringify({
      manifest: {
        package: {
          org: "oresoftware",
          name,
          version,
          description: "runtime fixture",
          repository: { vcs: "git", url: `https://github.com/ORESoftware/${name}` },
        },
      },
      vcs_tag: `v${version}`,
      sha256: sha256(bytes),
      size: bytes.byteLength,
      format: "tar.gz",
      ...(visibility === undefined ? {} : { visibility }),
    }),
  );
  form.set("artifact", new Blob([bytes], { type: "application/gzip" }), "pkg.tar.gz");
  // Serialize once so the request carries an honest Content-Length, which is
  // what a real client sends and what the edge requires.
  const encoded = new Response(form);
  const body = Buffer.from(await encoded.arrayBuffer());
  const headers = { "content-type": encoded.headers.get("content-type") };
  if (token) headers.authorization = `Bearer ${token}`;
  const init = { method: "PUT", headers };
  if (omitLength) {
    init.body = new ReadableStream({
      start(controller) {
        controller.enqueue(body);
        controller.close();
      },
    });
    init.duplex = "half";
  } else {
    init.body = body;
  }
  return fetch(new URL(`/v1/packages/oresoftware/${name}/versions/${version}`, base), init);
}

test("concurrent publishes of one version have exactly one winner", { timeout: 60_000 }, async (t) => {
  const { base } = await startRegistry(t);
  // Every racer carries different bytes, so a lost update would be visible as
  // a version document naming the wrong digest.
  const racers = Array.from({ length: 12 }, (_, index) => Buffer.from(`racer-${index}-payload`));
  const responses = await Promise.all(
    racers.map((bytes) => publish(base, { version: "1.0.0", bytes })),
  );
  const statuses = responses.map((response) => response.status).sort();
  const detail = await responses[0].clone().text();
  assert.equal(
    statuses.filter((status) => status === 201).length,
    1,
    `statuses: ${statuses}; first body: ${detail}`,
  );
  assert.equal(statuses.filter((status) => status === 409).length, racers.length - 1);

  const winner = await responses.find((response) => response.status === 201).json();
  const stored = await (await fetch(new URL("/v1/packages/oresoftware/pkg/versions/1.0.0", base))).json();
  assert.equal(stored.sha256, winner.sha256, "the version names the winner's bytes, not a later writer's");
  assert.ok(racers.some((bytes) => sha256(bytes) === stored.sha256));

  // And it stays that way.
  const late = await publish(base, { version: "1.0.0", bytes: Buffer.from("much later, different bytes") });
  assert.equal(late.status, 409);
  const after = await (await fetch(new URL("/v1/packages/oresoftware/pkg/versions/1.0.0", base))).json();
  assert.equal(after.sha256, winner.sha256);
});

test("concurrent publishes of different versions are all listed", { timeout: 60_000 }, async (t) => {
  const { base } = await startRegistry(t);
  const versions = Array.from({ length: 10 }, (_, index) => `2.${index}.0`);
  const responses = await Promise.all(
    versions.map((version) => publish(base, { name: "listed", version, bytes: Buffer.from(`bytes-${version}`) })),
  );
  assert.deepEqual(responses.map((response) => response.status), versions.map(() => 201));

  // A stored index would be a read-modify-write and could lose entries here.
  const listing = await (await fetch(new URL("/v1/packages/oresoftware/listed", base))).json();
  assert.deepEqual([...listing.versions].sort(), [...versions].sort());
  // The fields the client's PackageMetadata requires.
  assert.equal(listing.org, "oresoftware");
  assert.equal(listing.name, "listed");
  assert.equal(listing.vcs, "git");
  assert.equal(listing.repo_url, "https://github.com/ORESoftware/listed");
  assert.ok(versions.includes(listing.latest));
});

test("the write path is closed unless both switches are on", { timeout: 60_000 }, async (t) => {
  const bytes = Buffer.from("payload");

  const flagOff = await startRegistry(t, { EDGE_PUBLISH_ENABLED: "false" });
  let response = await publish(flagOff.base, { version: "1.0.0", bytes });
  assert.equal(response.status, 503, "a valid token does not open a path the flag closed");
  assert.equal((await response.json()).error, "registry_origin_unavailable");

  const noSecret = await startRegistry(t, { EDGE_PUBLISH_TOKEN: "" });
  response = await publish(noSecret.base, { version: "1.0.0", bytes, token: "" });
  assert.equal(response.status, 503, "an absent secret must never match an absent bearer");

  const enabled = await startRegistry(t);
  response = await publish(enabled.base, { version: "1.0.0", bytes, token: "wrong" });
  assert.equal(response.status, 401);
  response = await publish(enabled.base, { version: "1.0.0", bytes, token: null });
  assert.equal(response.status, 401);
  // Other writes still need the origin, token or not.
  response = await fetch(new URL("/v1/packages/oresoftware/pkg/versions/1.0.0/yank", enabled.base), {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ yanked: true }),
  });
  assert.equal(response.status, 503);
});

test("a body that does not declare its length is refused before it is read", { timeout: 60_000 }, async (t) => {
  const { base } = await startRegistry(t);
  const response = await publish(base, { version: "1.0.0", bytes: Buffer.from("payload"), omitLength: true });
  assert.equal(response.status, 411);
  const missing = await fetch(new URL("/v1/packages/oresoftware/pkg/versions/1.0.0", base));
  assert.notEqual(missing.status, 200, "nothing was stored");
});

test("a published artifact is served with real range and validator semantics", { timeout: 60_000 }, async (t) => {
  const { base } = await startRegistry(t);
  const bytes = Buffer.from("0123456789abcdefghijklmnopqrstuvwxyz");
  assert.equal((await publish(base, { name: "ranged", version: "1.0.0", bytes })).status, 201);
  const artifact = new URL(`/v1/artifacts/${sha256(bytes)}`, base);

  const full = await fetch(artifact);
  assert.equal(full.status, 200);
  assert.deepEqual(Buffer.from(await full.arrayBuffer()), bytes);
  const etag = full.headers.get("etag");
  assert.ok(etag, "a validator is returned");

  // Status and Content-Range, not only the bytes: a 200 carrying the right
  // slice would still break a resuming client.
  const partial = await fetch(artifact, { headers: { range: "bytes=10-19" } });
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get("content-range"), `bytes 10-19/${bytes.byteLength}`);
  assert.equal(await partial.text(), "abcdefghij");

  const notModified = await fetch(artifact, { headers: { "if-none-match": etag } });
  assert.equal(notModified.status, 304);
  assert.equal((await notModified.arrayBuffer()).byteLength, 0);

  const head = await fetch(artifact, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-length"), String(bytes.byteLength));

  const unknown = await fetch(new URL(`/v1/artifacts/${"0".repeat(64)}`, base));
  assert.equal(unknown.status, 503, "an unpublished digest is not invented");
});

test("private edge publication writes no R2 objects in workerd", { timeout: 60_000 }, async (t) => {
  const { base, mf } = await startRegistry(t);
  const response = await publish(base, {
    version: "1.0.0", bytes: Buffer.from("private runtime payload"), visibility: "private",
  });
  assert.equal(response.status, 422);
  assert.equal((await response.json()).error, "edge_publication_requires_public_visibility");
  const bucket = await mf.getR2Bucket("ARTIFACTS", "zpkg-registry-proxy");
  assert.deepEqual((await bucket.list()).objects, []);
});

test("workerd public CDN refuses private R2 objects including conditional and range requests", { timeout: 60_000 }, async (t) => {
  const { mf } = await startRegistry(t);
  const bucket = await mf.getR2Bucket("ARTIFACTS", "zpkg-cdn");
  const cdn = await mf.getWorker("zpkg-cdn");
  const key = `artifacts/${sha256(Buffer.from("private"))}.tar.gz`;
  const stored = await bucket.put(key, "private", {
    customMetadata: { visibility: "private" },
    httpMetadata: { cacheControl: "public, max-age=31536000, immutable" },
  });
  for (const init of [
    {},
    { method: "HEAD" },
    { headers: { range: "bytes=0-2" } },
    { headers: { "if-none-match": stored.httpEtag } },
  ]) {
    const response = await cdn.fetch(`https://cdn.zpkg.net/${key}`, init);
    assert.equal(response.status, 404);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("etag"), null);
    assert.equal(response.headers.get("content-range"), null);
    assert.doesNotMatch(await response.text(), /private/);
  }
});
