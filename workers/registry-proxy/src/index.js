import {
  classifyRegistryRequest,
  GITHUB_WEB,
  githubApiReleaseUrl,
  githubApiRepoUrl,
  githubApiTagsUrl,
  githubHeaders,
  githubIdentity,
  githubRawManifestUrl,
  digestFromReleaseAssetName,
  githubReleaseAssetNames,
  githubReleaseDownloadUrl,
  githubReleaseSidecarNames,
  gitTagsForVersion,
  HOP_BY_HOP,
  jsonResponse,
  originIsUnavailable,
  parseRegistryPath,
  REGISTRY_ACTION,
  USER_AGENT,
  versionFromGitTag,
} from "../../shared/github-fallback.js";
import {
  edgePublishEnabled,
  handleEdgePublish,
  r2PackageMetadata,
  r2VersionMetadata,
} from "../../shared/edge-publish.js";
import {
  downloadFromNativeVersion,
  isAllowedNativeDownloadUrl,
  isPrivateOrUnpublished,
  nativeHeaders,
  nativePackageMetadataUrl,
  nativeVersionMetadataUrl,
  publicNativeHostFromOrg,
  readBoundedJson,
  statusMeansPrivateOrMissing,
  toPackageMetadata,
  toVersionMetadata,
} from "../../shared/native-public.js";

const MAX_GITHUB_JSON_BYTES = 1024 * 1024;
const MAX_GITHUB_FEED_BYTES = 1024 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_NATIVE_DIGEST_BYTES = 32 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;
const PUBLIC_VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,127}$/;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const decision = classifyRegistryRequest(request.method, url.pathname);

    // The state-machine decision precedes every network call. An unknown path
    // can therefore never become a confused-deputy request to api.zpkg.net.
    if (decision.action === REGISTRY_ACTION.DENY_ROUTE) {
      return problem(404, "not_registry_route", "use api.zpkg.net for non-registry APIs");
    }
    if (decision.action === REGISTRY_ACTION.DENY_METHOD) {
      return problem(405, "method_not_allowed", "method is not valid for this registry route", {
        allow: decision.allow.join(", "),
      });
    }
    if (decision.action === REGISTRY_ACTION.PREFLIGHT) {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(decision.allow),
      });
    }

    // Publishing is the one write this edge can complete by itself: the
    // bucket is the same one the CDN serves, and the uploaded bytes carry
    // their own proof in their digest. It stays closed unless an operator
    // enabled it, so the default remains "writes need the origin". Every
    // other write still does.
    //
    // A request body can be read once. Forwarding a publish to the origin
    // first would consume it, leaving nothing for the edge to store when the
    // origin turns out to be down — and would stream a whole artifact at a
    // dead host before finding that out. So a publish asks the origin whether
    // it is up with a bodiless probe, and only then decides who gets the body.
    const writeRoute =
      decision.action === REGISTRY_ACTION.ORIGIN_WRITE && request.method === "PUT"
        ? parseRegistryPath(url.pathname)
        : null;
    if (writeRoute?.kind === "get_version" && edgePublishEnabled(env)) {
      const probe = await tryOrigin(
        new Request(new URL("/healthz", request.url), { method: "GET" }),
        env,
      );
      if (!probe || originIsUnavailable(probe.status)) {
        const result = await handleEdgePublish(request, env, writeRoute);
        // The response body stays exactly the published contract; the mirror
        // outcome rides in a header so an operator can see it without the
        // client having to understand a new field.
        const annotations = { source: "edge-r2", headers: {} };
        if (result.ghcr) {
          annotations.headers["x-zpkg-ghcr"] = result.ghcr.ok ? "mirrored" : result.ghcr.reason;
        }
        return jsonResponse(result.body, result.status, annotations);
      }
    }

    const origin = await tryOrigin(request, env);
    const originAvailable = origin && !originIsUnavailable(origin.status);

    if (decision.action === REGISTRY_ACTION.ORIGIN_WRITE) {
      if (originAvailable) return withEdge(origin, "origin", request.method);
      return problem(
        503,
        "registry_origin_unavailable",
        "registry writes require the zed-api-server origin",
        { "retry-after": "30" },
      );
    }

    if (decision.action === REGISTRY_ACTION.HEALTH) {
      if (originAvailable && origin.status === 200) {
        return withEdge(origin, "origin", request.method);
      }
      return responseForMethod(
        request.method,
        jsonResponse(
          {
            ok: true,
            db: false,
            degraded: true,
            source: "edge-fallback",
            fallbacks: ["github-public", "npm-public", "crates-io-public"],
          },
          200,
          { source: "edge-fallback" },
        ),
      );
    }

    if (originAvailable && origin.status !== 404) {
      return withEdge(origin, "origin", request.method);
    }

    if (decision.action === REGISTRY_ACTION.ORIGIN_READ) {
      if (originAvailable) return withEdge(origin, "origin", request.method);

      // Content-addressed bytes need no origin to be trustworthy: the caller
      // asked for a specific digest, and only that object can answer.
      const readRoute = parseRegistryPath(url.pathname);
      if (readRoute?.kind === "get_artifact") {
        const artifact = await cdnArtifact(env, readRoute.sha256, request);
        if (artifact) return artifact;
      }

      return problem(503, "registry_origin_unavailable", "registry read origin is unavailable", {
        "retry-after": "30",
      });
    }

    const route = parseRegistryPath(url.pathname);
    if (!route || (route.kind !== "get_package" && route.kind !== "get_version")) {
      return problem(500, "invalid_edge_state", "registry edge reached an invalid state");
    }

    try {
      const published = await r2PublishedFallback(route, env);
      if (published) return responseForMethod(request.method, published);
    } catch {
      // A bucket problem must not deny the remaining public sources.
    }

    try {
      const native = await nativePublicFallback(route, env);
      if (native) return responseForMethod(request.method, native);
    } catch {
      // A failed secondary source does not authorize another path or reveal
      // upstream internals. Continue to the independently public GitHub path.
    }

    try {
      const github = await githubPublicFallback(route, env);
      if (github) return responseForMethod(request.method, github);
    } catch {
      // Fall through to the origin result / typed miss.
    }

    if (originAvailable) return withEdge(origin, "origin", request.method);
    return problem(
      503,
      "registry_origin_unavailable",
      "origin is unavailable and no independently public fallback was found",
      { "retry-after": "30" },
    );
  },
};

/**
 * Answer from what this edge itself published.
 *
 * Authoritative for zed-native coordinates: these documents were written by a
 * publish that verified the digest, so they are consulted before third-party
 * registries and before guessing at GitHub.
 */
async function r2PublishedFallback(route, env) {
  if (!env.ARTIFACTS) return null;
  if (route.kind === "get_version") {
    const metadata = await r2VersionMetadata(env, route);
    if (metadata) return jsonResponse(metadata, 200, { source: "edge-r2" });
    return null;
  }
  if (route.kind === "get_package") {
    const listing = await r2PackageMetadata(env, route);
    if (listing) return jsonResponse(listing, 200, { source: "edge-r2" });
  }
  return null;
}

/**
 * Content-addressed bytes, served by the CDN Worker over the service binding.
 *
 * The CDN already implements ranges, conditional requests, ETags and the
 * security headers for exactly these objects, and that implementation is the
 * audited one. Reading the bucket a second way here would be a second place
 * for `206`/`304` behaviour to be subtly wrong.
 */
async function cdnArtifact(env, sha256, request) {
  if (!env.CDN) return null;
  const base = (env.CDN_PUBLIC_URL || "https://cdn.zpkg.net").replace(/\/+$/, "");
  // Both formats share one digest namespace, so the object is whichever exists.
  for (const extension of ["tar.gz", "zip"]) {
    const forwarded = new Request(`${base}/artifacts/${sha256}.${extension}`, {
      method: request.method,
      headers: conditionalHeaders(request.headers),
    });
    let response;
    try {
      response = await env.CDN.fetch(forwarded);
    } catch {
      return null;
    }
    // 206 and 304 are answers, not misses.
    if (response.status !== 404) return response;
  }
  return null;
}

/** Only the headers that select or validate a representation are forwarded. */
function conditionalHeaders(headers) {
  const forwarded = new Headers();
  for (const name of ["range", "if-none-match", "if-match", "if-modified-since", "if-range"]) {
    const value = headers.get(name);
    if (value) forwarded.set(name, value);
  }
  return forwarded;
}

async function tryOrigin(request, env) {
  if (!env.ORIGIN_URL) return null;
  const incoming = new URL(request.url);
  const origin = new URL(env.ORIGIN_URL);
  const target = new URL(incoming.pathname + incoming.search, origin);
  const forwarded = new Request(target.toString(), request);
  const headers = new Headers(forwarded.headers);
  for (const name of HOP_BY_HOP) headers.delete(name);
  headers.set("Host", origin.host);
  try {
    return await fetch(
      new Request(forwarded, {
        headers,
        redirect: "manual",
      }),
      { signal: AbortSignal.timeout(timeout(env, "ORIGIN_TIMEOUT_MS", 4000)) },
    );
  } catch {
    return null;
  }
}

async function nativePublicFallback(route, env) {
  const host = publicNativeHostFromOrg(route.org);
  if (!host) return null;
  const metadataUrl =
    route.kind === "get_package"
      ? nativePackageMetadataUrl(host, route.name)
      : nativeVersionMetadataUrl(host, route.name, route.version);
  if (!metadataUrl) return null;

  const response = await fetch(metadataUrl, {
    headers: nativeHeaders(),
    redirect: "error",
    signal: AbortSignal.timeout(timeout(env, "FALLBACK_TIMEOUT_MS", 4000)),
  });
  if (statusMeansPrivateOrMissing(response.status) || !response.ok) return null;
  const body = await readBoundedJson(response);
  if (!body || isPrivateOrUnpublished(host, body)) return null;

  if (route.kind === "get_package") {
    return jsonResponse(toPackageMetadata(host, route.org, route.name, body), 200, {
      source: `native-${host.id}`,
    });
  }
  const candidate = downloadFromNativeVersion(host, route.name, route.version, body);
  if (!candidate) return null;
  const download = await completeNativeDownload(
    host,
    route.name,
    route.version,
    candidate,
    env,
  );
  if (!download) return null;
  return jsonResponse(
    toVersionMetadata(host, route.org, route.name, route.version, body, download),
    200,
    { source: `native-${host.id}` },
  );
}

async function completeNativeDownload(host, name, version, candidate, env) {
  if (SHA256.test(candidate.sha256 || "") && Number.isSafeInteger(candidate.size) && candidate.size > 0) {
    return candidate;
  }

  let current = candidate.url;
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    if (!isAllowedNativeDownloadUrl(host, current, name, version)) return null;
    let response;
    try {
      response = await fetch(current, {
        headers: nativeHeaders("application/octet-stream"),
        redirect: "manual",
        signal: AbortSignal.timeout(timeout(env, "FALLBACK_TIMEOUT_MS", 4000)),
      });
    } catch {
      return null;
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location || redirects === 3) return null;
      current = new URL(location, current).toString();
      continue;
    }
    if (!response.ok) return null;
    const declared = Number(response.headers.get("content-length") || 0);
    if (
      !Number.isSafeInteger(declared) ||
      declared <= 0 ||
      declared > MAX_NATIVE_DIGEST_BYTES
    ) {
      return null;
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength !== declared) return null;
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const sha256 = [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    return { ...candidate, url: current, sha256, size: bytes.byteLength };
  }
  return null;
}

async function githubPublicFallback(route, env) {
  const identity = githubIdentity(route.org, route.name);
  // A successful anonymous read of the deterministic GitHub Release sidecar
  // is its own public-access proof and avoids coupling version installs to
  // GitHub REST's shared unauthenticated rate limit. The sidecar is accepted
  // only after its identity, digest, size, and download URL are confined.
  if (route.kind === "get_version") {
    const sidecar = await versionFromGithubSidecar(identity, route.version, env);
    if (sidecar) return sidecar;
  }

  if (route.kind === "get_package") {
    const feed = await packageFromGithubReleaseFeed(identity, env);
    if (feed) return feed;
  }

  const repo = await publicGithubRepo(identity, env);
  if (!repo) return null;
  if (route.kind === "get_package") return packageFromGithub(identity, repo, env);
  if (route.kind === "get_version") {
    return versionFromGithub(identity, route.version, env);
  }
  return null;
}

async function packageFromGithubReleaseFeed(identity, env) {
  const candidates = [
    {
      fetcher: env?.CDN?.fetch ? env.CDN : { fetch },
      url: `https://cdn.zpkg.net/github/${identity.owner}/${identity.repo}/releases.atom`,
    },
    {
      fetcher: { fetch },
      url: `${GITHUB_WEB}/${identity.owner}/${identity.repo}/releases.atom`,
    },
  ];
  let text = null;
  for (const candidate of candidates) {
    try {
      const response = await candidate.fetcher.fetch(candidate.url, {
        headers: { Accept: "application/atom+xml", "User-Agent": USER_AGENT },
        redirect: "error",
        signal: AbortSignal.timeout(timeout(env, "FALLBACK_TIMEOUT_MS", 4000)),
      });
      if (!response.ok) continue;
      const contentType = response.headers.get("content-type") || "";
      if (!/^application\/atom\+xml(?:\s*;|$)/i.test(contentType)) continue;
      const candidateText = await readBoundedText(response, MAX_GITHUB_FEED_BYTES);
      if (candidateText !== null && feedIdentifiesRepository(candidateText, identity)) {
        text = candidateText;
        break;
      }
    } catch {
      // Continue to the independent direct public GitHub path.
    }
  }
  if (text === null) return null;

  const versions = versionsFromReleaseFeed(text, identity);
  if (versions.length === 0) return null;

  let description = null;
  try {
    const responseManifest = await fetch(githubRawManifestUrl(identity, `v${versions[0]}`), {
      headers: { Accept: "text/plain", "User-Agent": USER_AGENT },
      redirect: "error",
      signal: AbortSignal.timeout(timeout(env, "FALLBACK_TIMEOUT_MS", 4000)),
    });
    if (responseManifest.ok) {
      const manifest = await readBoundedText(responseManifest, MAX_MANIFEST_BYTES);
      description = manifest?.match(/^description\s*=\s*"([^"]+)"/m)?.[1] || null;
    }
  } catch {
    // The public release list is sufficient package proof. Description is
    // optional, so a transient raw-content failure must not break resolution.
  }

  return jsonResponse(
    {
      org: identity.owner,
      name: identity.repo,
      description,
      vcs: "git",
      repo_url: `${GITHUB_WEB}/${identity.owner}/${identity.repo}`,
      latest: versions[0],
      tags: [],
      versions,
    },
    200,
    { source: "github-public" },
  );
}

function feedIdentifiesRepository(text, identity) {
  const expected = `${GITHUB_WEB}/${identity.owner}/${identity.repo}/releases`;
  return text.includes(`<id>tag:github.com,2008:${expected}</id>`);
}

function versionsFromReleaseFeed(text, identity) {
  const escapedOwner = escapeRegExp(identity.owner);
  const escapedRepo = escapeRegExp(identity.repo);
  const links = new RegExp(
    `href="https://github\\.com/${escapedOwner}/${escapedRepo}/releases/tag/([^"/]+)"`,
    "g",
  );
  const versions = new Set();
  for (const match of text.matchAll(links)) {
    let tag;
    try {
      tag = decodeURIComponent(match[1]);
    } catch {
      continue;
    }
    const version = versionFromGitTag(tag);
    if (PUBLIC_VERSION.test(version) && !version.includes("..")) versions.add(version);
  }
  return [...versions].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function versionFromGithubSidecar(identity, version, env) {
  for (const tag of gitTagsForVersion(version)) {
    for (const sidecar of githubReleaseSidecarNames(
      identity.owner,
      identity.repo,
      version,
    )) {
      const candidates = [
        { kind: "cdn", url: cdnReleaseSidecarUrl(identity, tag, sidecar) },
        { kind: "github", url: githubReleaseDownloadUrl(identity, tag, sidecar) },
      ];
      for (const candidate of candidates) {
        const response =
          candidate.kind === "cdn"
            ? await fetchCdnReleaseSidecar(candidate.url, env)
            : await fetchGithubReleaseSidecar(candidate.url, env);
        if (!response?.ok) continue;
        const metadata = await readBoundedSidecarJson(response, MAX_GITHUB_JSON_BYTES);
        const validated = validateSidecar(metadata, identity, version);
        if (validated) return jsonResponse(validated, 200, { source: "github-public" });
      }
    }
  }
  return null;
}

function cdnReleaseSidecarUrl(identity, tag, sidecar) {
  return `https://cdn.zpkg.net/github/${encodeURIComponent(identity.owner)}/${encodeURIComponent(identity.repo)}/${encodeURIComponent(tag)}/${encodeURIComponent(sidecar)}`;
}

async function fetchCdnReleaseSidecar(url, env) {
  try {
    const fetcher = env?.CDN?.fetch ? env.CDN : { fetch };
    return await fetcher.fetch(url, {
      headers: { Accept: "application/octet-stream", "User-Agent": USER_AGENT },
      redirect: "error",
      signal: AbortSignal.timeout(timeout(env, "FALLBACK_TIMEOUT_MS", 4000)),
    });
  } catch {
    return null;
  }
}

async function fetchGithubReleaseSidecar(url, env) {
  let current = url;
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    if (!isAllowedGithubReleaseRedirect(current)) return null;
    let response;
    try {
      response = await fetch(current, {
        headers: { Accept: "application/json", "User-Agent": USER_AGENT },
        redirect: "manual",
        signal: AbortSignal.timeout(timeout(env, "FALLBACK_TIMEOUT_MS", 4000)),
      });
    } catch {
      return null;
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location || redirects === 3) return null;
      current = new URL(location, current).toString();
      continue;
    }
    return response;
  }
  return null;
}

async function readBoundedSidecarJson(response, maxBytes) {
  // GitHub release assets are served as application/octet-stream even when
  // the named asset is JSON. The exact release URL and every redirect remain
  // allowlisted; accepting this one media type does not weaken schema checks.
  const contentType = response.headers.get("content-type") || "";
  if (
    !/^application\/(?:[a-z0-9.+-]*\+)?json(?:\s*;|$)/i.test(contentType) &&
    !/^application\/octet-stream(?:\s*;|$)/i.test(contentType)
  ) {
    return null;
  }
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > maxBytes) return null;
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maxBytes) return null;
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

async function publicGithubRepo(identity, env) {
  const response = await fetch(githubApiRepoUrl(identity), githubFetchOptions(env));
  if (!response.ok) return null;
  const repo = await readBoundedJson(response, MAX_GITHUB_JSON_BYTES);
  if (!repo || repo.private !== false || repo.visibility !== "public") return null;
  if (repo.owner?.login?.toLowerCase() !== identity.owner.toLowerCase()) return null;
  if (repo.name?.toLowerCase() !== identity.repo.toLowerCase()) return null;
  return repo;
}

async function packageFromGithub(identity, repo, env) {
  const tagsResponse = await fetch(githubApiTagsUrl(identity), githubFetchOptions(env));
  if (!tagsResponse.ok) return null;
  const tags = await readBoundedJson(tagsResponse, MAX_GITHUB_JSON_BYTES);
  const versions = (Array.isArray(tags) ? tags : [])
    .map((tag) => versionFromGitTag(tag.name || ""))
    .filter(Boolean)
    .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));

  let description = repo.description || null;
  for (const gitRef of [repo.default_branch, versions[0] ? `v${versions[0]}` : null].filter(Boolean)) {
    const response = await fetch(githubRawManifestUrl(identity, gitRef), {
      headers: { Accept: "text/plain", "User-Agent": USER_AGENT },
      redirect: "error",
      signal: AbortSignal.timeout(timeout(env, "FALLBACK_TIMEOUT_MS", 4000)),
    });
    if (!response.ok) continue;
    const text = await readBoundedText(response, MAX_MANIFEST_BYTES);
    if (text === null) continue;
    const match = text.match(/^description\s*=\s*"([^"]+)"/m);
    if (match) description = match[1];
    break;
  }

  return jsonResponse(
    {
      org: identity.owner,
      name: identity.repo,
      description,
      vcs: "git",
      repo_url: `${GITHUB_WEB}/${identity.owner}/${identity.repo}`,
      latest: versions[0] || null,
      tags: [],
      versions,
    },
    200,
    { source: "github-public" },
  );
}

async function versionFromGithub(identity, version, env) {
  for (const tag of gitTagsForVersion(version)) {
    const releaseResponse = await fetch(githubApiReleaseUrl(identity, tag), githubFetchOptions(env));
    if (!releaseResponse.ok) continue;
    const release = await readBoundedJson(releaseResponse, MAX_GITHUB_JSON_BYTES);
    if (!release || release.draft === true) continue;
    const assets = Array.isArray(release.assets) ? release.assets : [];

    const sidecarNames = new Set(
      githubReleaseSidecarNames(identity.owner, identity.repo, version),
    );
    const sidecar = assets.find((asset) => sidecarNames.has(asset.name));
    if (sidecar && isExpectedGithubDownload(identity, tag, sidecar.name, sidecar.browser_download_url)) {
      const metadataResponse = await fetch(sidecar.browser_download_url, {
        headers: { Accept: "application/json", "User-Agent": USER_AGENT },
        redirect: "follow",
        signal: AbortSignal.timeout(timeout(env, "FALLBACK_TIMEOUT_MS", 4000)),
      });
      if (metadataResponse.ok && isGithubAssetResponse(metadataResponse.url)) {
        const metadata = await readBoundedJson(metadataResponse, MAX_GITHUB_JSON_BYTES);
        const validated = validateSidecar(metadata, identity, version);
        if (validated) return jsonResponse(validated, 200, { source: "github-public" });
      }
    }

    const wanted = new Set(githubReleaseAssetNames(identity.owner, identity.repo, version));
    const named = assets.find((asset) => wanted.has(asset.name));
    // `zed publish` names the packed artifact after its own digest, so a real
    // release usually carries `zpkg-<sha256>.tar.gz` and no conventionally
    // named asset at all. Accept that form: the digest is the content address
    // itself, and GitHub's reported digest must agree when it sends one.
    const addressed = named
      ? null
      : assets.find(
          (asset) =>
            digestFromReleaseAssetName(asset?.name, "tar.gz") ||
            digestFromReleaseAssetName(asset?.name, "zip"),
        );
    const artifact = named || addressed;
    const reported = String(artifact?.digest || "").replace(/^sha256:/, "");
    const addressedDigest = addressed
      ? digestFromReleaseAssetName(addressed.name, addressed.name.endsWith(".zip") ? "zip" : "tar.gz")
      : null;
    const digest = addressed ? addressedDigest : reported;
    const digestAgrees = !addressed || !reported || reported === addressedDigest;
    if (
      artifact &&
      digestAgrees &&
      SHA256.test(digest) &&
      isExpectedGithubDownload(identity, tag, artifact.name, artifact.browser_download_url)
    ) {
      return jsonResponse(
        {
          org: identity.owner,
          name: identity.repo,
          version,
          sha256: digest,
          size: Number.isSafeInteger(artifact.size) ? artifact.size : 0,
          format: artifact.name.endsWith(".zip") ? "zip" : "tar.gz",
          vcs_tag: tag,
          vcs_commit: release.target_commitish || null,
          download_url: artifact.browser_download_url,
          published_at: release.published_at || "1970-01-01T00:00:00Z",
          yanked: false,
          mirrors: [{ kind: "github-release", url: artifact.browser_download_url }],
        },
        200,
        { source: "github-public" },
      );
    }
  }
  return null;
}

function validateSidecar(metadata, identity, version) {
  if (!metadata || typeof metadata !== "object") return null;
  if (metadata.org !== identity.owner || metadata.name !== identity.repo) return null;
  if (metadata.version !== version || !SHA256.test(metadata.sha256 || "")) return null;
  if (!Number.isSafeInteger(metadata.size) || metadata.size < 0) return null;
  if (!isAllowedPublishedDownload(metadata.download_url, metadata.sha256, identity, version)) {
    return null;
  }
  return {
    org: metadata.org,
    name: metadata.name,
    version: metadata.version,
    sha256: metadata.sha256,
    size: metadata.size,
    format: metadata.format === "zip" ? "zip" : "tar.gz",
    vcs_tag: metadata.vcs_tag || `v${version}`,
    vcs_commit: metadata.vcs_commit || null,
    download_url: metadata.download_url,
    published_at: metadata.published_at || "1970-01-01T00:00:00Z",
    yanked: Boolean(metadata.yanked),
    mirrors: [
      {
        kind: metadata.download_url.startsWith("https://cdn.zpkg.net/")
          ? "object-store"
          : "github-release",
        url: metadata.download_url,
      },
    ],
  };
}

function isAllowedPublishedDownload(rawUrl, sha256, identity, version) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
  if (url.hostname === "cdn.zpkg.net") {
    return url.pathname === `/artifacts/${sha256}.tar.gz` || url.pathname === `/artifacts/${sha256}.zip`;
  }
  if (url.hostname !== "github.com") return false;
  const assets = [
    ...githubReleaseAssetNames(identity.owner, identity.repo, version, "tar.gz"),
    ...githubReleaseAssetNames(identity.owner, identity.repo, version, "zip"),
    // The digest-named form a sidecar may legitimately point at. The name is
    // the content address the caller already committed to verifying.
    `zpkg-${sha256}.tar.gz`,
    `zpkg-${sha256}.zip`,
  ];
  return gitTagsForVersion(version).some((tag) =>
    assets.some((asset) => isExpectedGithubDownload(identity, tag, asset, rawUrl)),
  );
}

function isExpectedGithubDownload(identity, tag, asset, rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  return (
    url.protocol === "https:" &&
    url.hostname === "github.com" &&
    url.pathname === `/${identity.owner}/${identity.repo}/releases/download/${tag}/${asset}`
  );
}

function isAllowedGithubReleaseRedirect(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      ["github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"].includes(
        url.hostname,
      ) &&
      (url.hostname !== "github.com" || url.pathname.includes("/releases/download/"))
    );
  } catch {
    return false;
  }
}

function githubFetchOptions(env) {
  return {
    headers: githubHeaders(),
    redirect: "error",
    signal: AbortSignal.timeout(timeout(env, "FALLBACK_TIMEOUT_MS", 4000)),
  };
}

async function readBoundedText(response, maxBytes) {
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > maxBytes) return null;
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maxBytes) return null;
  return new TextDecoder().decode(bytes);
}

function timeout(env, name, fallback) {
  const value = Number(env?.[name] || fallback);
  return Number.isFinite(value) && value >= 100 && value <= 30000 ? value : fallback;
}

function withEdge(response, source, method) {
  const headers = new Headers(response.headers);
  headers.set("x-zed-source", source);
  headers.set("x-zed-edge", "registry");
  return new Response(method === "HEAD" ? null : response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function responseForMethod(method, response) {
  if (method !== "HEAD") return response;
  return new Response(null, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function problem(status, code, message, extraHeaders = {}) {
  return jsonResponse({ ok: false, error: code, message }, status, {
    source: "edge",
    headers: { ...extraHeaders, ...corsHeaders([]) },
  });
}

function corsHeaders(allow) {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": allow.length ? allow.join(",") : "GET,HEAD,OPTIONS",
    "access-control-allow-headers": "authorization,content-type",
    "access-control-max-age": "600",
  };
}
