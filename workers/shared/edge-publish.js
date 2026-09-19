/**
 * Publishing to R2 from the edge, for the window where no zed-api-server
 * origin is running.
 *
 * The origin normally owns publishing: it authenticates the account, checks
 * that the account may publish to the org, and records the version in its
 * database. None of that exists here, so this path is deliberately narrower
 * than the origin's:
 *
 * - It is off unless `EDGE_PUBLISH_ENABLED` is exactly "true" *and* an operator
 *   set `EDGE_PUBLISH_TOKEN`. Two switches on purpose: the flag is reviewed
 *   configuration, so turning the path off is a one-line rollback that does
 *   not depend on a secret having been deleted somewhere else. A registry that
 *   accepts anonymous writes is a supply-chain attack waiting to happen, so
 *   either one missing keeps the old 503.
 * - The token is a single operator credential. It proves "may publish", not
 *   "owns this org" — the edge has no account database to answer ownership
 *   with, and pretending otherwise would be worse than saying so.
 * - Versions are immutable, and atomically so. The version document is
 *   written with `If-None-Match: *`, which R2 evaluates as a single
 *   create-if-absent operation: of any number of concurrent publishes of one
 *   coordinate exactly one establishes it and the rest get 409. A
 *   check-then-write would let two racers both observe absence and the last
 *   writer win, which is precisely the swap consumers pin `sha256` against.
 * - There is no stored package index. A listing kept as a document is a
 *   read-modify-write, and two concurrent publishes of *different* versions
 *   could each erase the other from it. The listing is derived from the
 *   version documents instead, so it cannot disagree with them.
 * - The uploaded bytes are hashed here and must match the digest the client
 *   declared, which is what the origin does and what `zed publish` documents.
 *
 * Everything written lands under the same R2 keys the CDN Worker already
 * serves, so a package published this way is readable by the existing public
 * path with no further deployment.
 */

import { ghcrRepositoryPath, pushArtifactToGhcr } from "./ghcr.js";

export const PUBLISH_META_FIELD = "meta";
export const PUBLISH_ARTIFACT_FIELD = "artifact";

/**
 * Deliberately far below the CDN's 110 MiB read ceiling. Multipart parsing
 * buffers the body and hashing needs the bytes, so an upload is resident more
 * than once inside a Worker's memory limit. Packages larger than this publish
 * through the origin, which streams.
 */
export const MAX_PUBLISH_ARTIFACT_BYTES = 32 * 1024 * 1024;
export const MAX_PUBLISH_META_BYTES = 1024 * 1024;

const ORG_NAME = /^[a-z0-9][a-z0-9-]*$/;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;

/** Artifact formats the CDN Worker knows how to serve. */
export const ARTIFACT_EXTENSIONS = Object.freeze({
  "tar.gz": "tar.gz",
  targz: "tar.gz",
  tgz: "tar.gz",
  gzip: "tar.gz",
  zip: "zip",
});

export function artifactExtension(format) {
  if (format === undefined || format === null || format === "") return "tar.gz";
  if (typeof format !== "string") return null;
  return ARTIFACT_EXTENSIONS[format.toLowerCase()] ?? null;
}

export function artifactKey(sha256, format) {
  const extension = artifactExtension(format);
  if (!SHA256.test(sha256) || !extension) return null;
  return `artifacts/${sha256}.${extension}`;
}

export function versionMetadataKey(org, name, version) {
  if (!ORG_NAME.test(org) || !ORG_NAME.test(name) || !VERSION.test(version)) return null;
  return `metadata/${org}/${name}/versions/${version}.json`;
}

export function packageIndexKey(org, name) {
  if (!ORG_NAME.test(org) || !ORG_NAME.test(name)) return null;
  return `metadata/${org}/${name}/index.json`;
}

export async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Compare two secrets without leaking their length or a prefix match.
 *
 * Both sides are hashed to a fixed 32 bytes first: a direct comparison of the
 * raw strings would return early on the first differing byte and would also
 * reveal the secret's length through timing.
 */
export async function secretsMatch(presented, expected) {
  if (typeof presented !== "string" || typeof expected !== "string") return false;
  if (presented.length === 0 || expected.length === 0) return false;
  const encoder = new TextEncoder();
  const [left, right] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(presented)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const a = new Uint8Array(left);
  const b = new Uint8Array(right);
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= a[index] ^ b[index];
  return difference === 0;
}

export function bearerToken(request) {
  const header = request.headers.get("authorization") || "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

/** Whether edge publishing is configured at all. */
export function edgePublishEnabled(env) {
  return Boolean(
    env && env.ARTIFACTS && env.EDGE_PUBLISH_TOKEN && env.EDGE_PUBLISH_ENABLED === "true",
  );
}

export async function authorizePublish(request, env) {
  if (!edgePublishEnabled(env)) return false;
  const presented = bearerToken(request);
  if (!presented) return false;
  return secretsMatch(presented, env.EDGE_PUBLISH_TOKEN);
}

/**
 * Check the client's declared metadata against the URL it published to.
 *
 * Returns `null` when acceptable, or a `{ status, code, detail }` problem. The
 * URL is the authority: a body that disagrees with it is refused rather than
 * reconciled, so a publish can never land under coordinates the caller did not
 * name in the request line.
 */
export function validatePublishMeta(meta, route) {
  if (!meta || typeof meta !== "object") {
    return { status: 400, code: "invalid_publish_meta", detail: "meta part is not a JSON object" };
  }
  const pkg = meta.manifest && meta.manifest.package;
  if (!pkg || typeof pkg !== "object") {
    return { status: 400, code: "invalid_publish_meta", detail: "meta.manifest.package is missing" };
  }
  if (pkg.org !== route.org || pkg.name !== route.name || pkg.version !== route.version) {
    return {
      status: 422,
      code: "publish_identity_mismatch",
      detail: "meta.manifest.package does not match the published coordinates",
    };
  }
  if (typeof meta.sha256 !== "string" || !SHA256.test(meta.sha256)) {
    return { status: 422, code: "invalid_publish_meta", detail: "meta.sha256 is not a sha256" };
  }
  if (!Number.isInteger(meta.size) || meta.size < 0) {
    return { status: 422, code: "invalid_publish_meta", detail: "meta.size is not a byte count" };
  }
  if (typeof meta.vcs_tag !== "string" || meta.vcs_tag === "") {
    return { status: 422, code: "invalid_publish_meta", detail: "meta.vcs_tag is required" };
  }
  if (artifactExtension(meta.format) === null) {
    return { status: 422, code: "invalid_publish_meta", detail: "meta.format is not a known format" };
  }
  return null;
}

/**
 * The version document consumers read.
 *
 * `download_url` points at the public CDN rather than at this Worker: the CDN
 * already serves content-addressed objects straight from the same bucket, so
 * an install never needs the registry host to be up.
 */
export function buildVersionMetadata({ route, meta, sha256, size, cdnBase, publishedAt }) {
  const extension = artifactExtension(meta.format);
  const metadata = {
    org: route.org,
    name: route.name,
    version: route.version,
    sha256,
    size,
    format: meta.format ?? "tar.gz",
    vcs_tag: meta.vcs_tag,
    download_url: `${cdnBase.replace(/\/+$/, "")}/artifacts/${sha256}.${extension}`,
    published_at: publishedAt,
    yanked: false,
  };
  if (typeof meta.vcs_commit === "string" && meta.vcs_commit !== "") {
    metadata.vcs_commit = meta.vcs_commit;
  }
  // The facts a package listing needs, kept on the version that declared them
  // so the listing can be derived instead of separately maintained.
  const repository = meta.manifest?.package?.repository;
  if (repository && typeof repository.url === "string") {
    metadata.package = {
      repo_url: repository.url,
      vcs: typeof repository.vcs === "string" ? repository.vcs : "git",
    };
    if (typeof meta.manifest.package.description === "string") {
      metadata.package.description = meta.manifest.package.description;
    }
  }
  if (Array.isArray(meta.mirrors) && meta.mirrors.length > 0) metadata.mirrors = meta.mirrors;
  // Signatures are carried through untouched. The edge cannot add trust it
  // does not have, but it must not drop trust the publisher established.
  if (Array.isArray(meta.signatures) && meta.signatures.length > 0) {
    metadata.signatures = meta.signatures;
  }
  return metadata;
}

/**
 * Serve a published version document straight from the bucket.
 *
 * This is what makes a package installable while the origin is down: the
 * version document carries the digest and a CDN download URL, and both were
 * written by a publish that proved the digest.
 */
export async function r2VersionMetadata(env, route) {
  if (!env || !env.ARTIFACTS) return null;
  const key = versionMetadataKey(route.org, route.name, route.version);
  if (!key) return null;
  return readJsonObject(env, key);
}

/**
 * The package listing, derived from the version documents.
 *
 * Newest first by upload time. The package-level facts come from the newest
 * version, which is the most recent statement the publisher made about them.
 */
export async function r2PackageMetadata(env, route) {
  if (!env || !env.ARTIFACTS) return null;
  const indexKey = packageIndexKey(route.org, route.name);
  if (!indexKey) return null;
  const prefix = `metadata/${route.org}/${route.name}/versions/`;

  const objects = [];
  let cursor;
  do {
    let page;
    try {
      page = await env.ARTIFACTS.list({ prefix, cursor, limit: 1000 });
    } catch {
      return null;
    }
    objects.push(...page.objects);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  const published = objects
    .filter((object) => object.key.endsWith(".json"))
    .sort((a, b) => new Date(b.uploaded).getTime() - new Date(a.uploaded).getTime());
  if (published.length === 0) return null;

  const versions = published.map((object) => object.key.slice(prefix.length, -".json".length));
  const newest = await readJsonObject(env, published[0].key);
  const facts = newest && typeof newest.package === "object" ? newest.package : {};
  const metadata = {
    org: route.org,
    name: route.name,
    vcs: typeof facts.vcs === "string" ? facts.vcs : "git",
    repo_url: typeof facts.repo_url === "string" ? facts.repo_url : "",
    latest: versions[0],
    tags: [],
    versions,
  };
  if (typeof facts.description === "string") metadata.description = facts.description;
  return metadata;
}

async function readJsonObject(env, key) {
  let object;
  try {
    object = await env.ARTIFACTS.get(key);
  } catch {
    return null;
  }
  if (!object) return null;
  let text;
  try {
    text = await object.text();
  } catch {
    return null;
  }
  if (text.length > MAX_PUBLISH_META_BYTES) return null;
  try {
    return JSON.parse(text);
  } catch {
    // A malformed object is treated as absent: serving half a document would
    // be worse than reporting the version as missing.
    return null;
  }
}

/**
 * Accept one publish and write it to R2.
 *
 * Returns `{ status, body }` for the caller to serialize. Every refusal is a
 * typed problem, and nothing is written until the bytes have been hashed and
 * the version has been shown not to exist.
 */
export async function handleEdgePublish(request, env, route, now = () => new Date()) {
  if (!edgePublishEnabled(env)) {
    return {
      status: 503,
      body: {
        error: "registry_origin_unavailable",
        detail: "registry writes require the zed-api-server origin",
      },
    };
  }
  if (!(await authorizePublish(request, env))) {
    return {
      status: 401,
      body: { error: "unauthorized", detail: "edge publishing requires a valid bearer token" },
    };
  }

  // Parsing multipart buffers the whole body, so the bound has to be enforced
  // before that starts. A request that does not declare its length cannot be
  // bounded in advance and is refused rather than read.
  const rawLength = request.headers.get("content-length");
  const declaredLength = Number(rawLength);
  if (rawLength === null || !Number.isInteger(declaredLength) || declaredLength < 0) {
    return {
      status: 411,
      body: { error: "length_required", detail: "edge publishing requires Content-Length" },
    };
  }
  if (declaredLength > MAX_PUBLISH_ARTIFACT_BYTES + MAX_PUBLISH_META_BYTES) {
    return {
      status: 413,
      body: { error: "artifact_too_large", detail: "publish exceeds the edge size limit" },
    };
  }

  let form;
  try {
    form = await request.formData();
  } catch {
    return {
      status: 400,
      body: { error: "invalid_publish_body", detail: "body is not multipart/form-data" },
    };
  }

  const rawMeta = form.get(PUBLISH_META_FIELD);
  const artifact = form.get(PUBLISH_ARTIFACT_FIELD);
  if (typeof rawMeta !== "string" || !artifact || typeof artifact === "string") {
    return {
      status: 400,
      body: {
        error: "invalid_publish_body",
        detail: `expected a ${PUBLISH_META_FIELD} field and an ${PUBLISH_ARTIFACT_FIELD} file`,
      },
    };
  }
  if (rawMeta.length > MAX_PUBLISH_META_BYTES) {
    return { status: 413, body: { error: "invalid_publish_meta", detail: "meta part is too large" } };
  }

  let meta;
  try {
    meta = JSON.parse(rawMeta);
  } catch {
    return { status: 400, body: { error: "invalid_publish_meta", detail: "meta part is not JSON" } };
  }
  const invalid = validatePublishMeta(meta, route);
  if (invalid) {
    return { status: invalid.status, body: { error: invalid.code, detail: invalid.detail } };
  }

  const bytes = new Uint8Array(await artifact.arrayBuffer());
  if (bytes.byteLength === 0) {
    return { status: 422, body: { error: "empty_artifact", detail: "artifact part is empty" } };
  }
  if (bytes.byteLength > MAX_PUBLISH_ARTIFACT_BYTES) {
    return {
      status: 413,
      body: { error: "artifact_too_large", detail: "artifact exceeds the edge size limit" },
    };
  }

  // Recompute rather than trust: the declared digest is what consumers pin,
  // so it has to describe the bytes that were actually stored.
  const digest = await sha256Hex(bytes);
  if (digest !== meta.sha256) {
    return {
      status: 422,
      body: { error: "artifact_digest_mismatch", detail: "artifact does not match meta.sha256" },
    };
  }
  if (meta.size !== bytes.byteLength) {
    return {
      status: 422,
      body: { error: "artifact_size_mismatch", detail: "artifact does not match meta.size" },
    };
  }

  const versionKey = versionMetadataKey(route.org, route.name, route.version);
  const objectKey = artifactKey(digest, meta.format);
  if (!versionKey || !objectKey) {
    return { status: 400, body: { error: "invalid_publish_target", detail: "unroutable coordinates" } };
  }

  const publishedAt =
    typeof meta.published_at === "string" && meta.published_at !== ""
      ? meta.published_at
      : now().toISOString();
  const cdnBase = env.CDN_PUBLIC_URL || "https://cdn.zpkg.net";
  const versionMetadata = buildVersionMetadata({
    route,
    meta,
    sha256: digest,
    size: bytes.byteLength,
    cdnBase,
    publishedAt,
  });

  // The artifact is written first: a version document that points at absent
  // bytes would advertise an install that cannot complete. The key is the
  // digest, so a concurrent or repeated write stores identical bytes and an
  // abandoned one is unreferenced garbage, never a wrong answer.
  await env.ARTIFACTS.put(objectKey, bytes, {
    httpMetadata: {
      contentType: objectKey.endsWith(".zip") ? "application/zip" : "application/gzip",
      cacheControl: "public, max-age=31536000, immutable",
    },
  });

  // The claim. `If-None-Match: *` makes this one create-if-absent operation in
  // R2, so exactly one of any number of concurrent publishes establishes the
  // version. `put` answers null when the precondition fails.
  const claimed = await env.ARTIFACTS.put(versionKey, JSON.stringify(versionMetadata), {
    httpMetadata: { contentType: "application/json" },
    onlyIf: new Headers({ "If-None-Match": "*" }),
  });
  if (claimed === null) {
    return {
      status: 409,
      body: {
        error: "version_already_published",
        detail: "this version already exists and versions are immutable",
      },
    };
  }

  // GitHub Packages is a second home for the same bytes, so the package
  // survives losing the bucket. It runs only inside this already-authenticated
  // publish, and never fails one: R2 holds the authoritative copy, and a
  // mirror that is temporarily behind is not a reason to reject a version the
  // registry has already accepted.
  const ghcr = await mirrorToGhcr({ env, route, bytes, digest });

  return {
    status: 201,
    ghcr,
    body: {
      org: route.org,
      name: route.name,
      version: route.version,
      sha256: digest,
    },
  };
}

async function mirrorToGhcr({ env, route, bytes, digest }) {
  if (!env.GITHUB_PACKAGES_TOKEN) return { ok: false, reason: "not_configured" };
  const repository = ghcrRepositoryPath(route.org, route.name);
  if (!repository) return { ok: false, reason: "invalid_target" };
  try {
    return await pushArtifactToGhcr({
      repository,
      reference: route.version,
      bytes,
      digest,
      token: env.GITHUB_PACKAGES_TOKEN,
    });
  } catch {
    return { ok: false, reason: "mirror_failed" };
  }
}
