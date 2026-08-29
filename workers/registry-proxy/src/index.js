import {
  classifyRegistryRequest,
  GITHUB_WEB,
  githubApiReleaseUrl,
  githubApiRepoUrl,
  githubApiTagsUrl,
  githubHeaders,
  githubIdentity,
  githubRawManifestUrl,
  githubReleaseAssetNames,
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
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_NATIVE_DIGEST_BYTES = 32 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;

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
      return problem(503, "registry_origin_unavailable", "registry read origin is unavailable", {
        "retry-after": "30",
      });
    }

    const route = parseRegistryPath(url.pathname);
    if (!route || (route.kind !== "get_package" && route.kind !== "get_version")) {
      return problem(500, "invalid_edge_state", "registry edge reached an invalid state");
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
  const repo = await publicGithubRepo(identity, env);
  if (!repo) return null;
  if (route.kind === "get_package") return packageFromGithub(identity, repo, env);
  if (route.kind === "get_version") {
    return versionFromGithub(identity, route.version, env);
  }
  return null;
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
    const artifact = assets.find((asset) => wanted.has(asset.name));
    const digest = String(artifact?.digest || "").replace(/^sha256:/, "");
    if (
      artifact &&
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
  if (!isAllowedPublishedDownload(metadata.download_url, metadata.sha256)) return null;
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

function isAllowedPublishedDownload(rawUrl, sha256) {
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
  return url.hostname === "github.com" && url.pathname.includes("/releases/download/");
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

function isGithubAssetResponse(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return (
      url.protocol === "https:" &&
      ["github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"].includes(
        url.hostname,
      )
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
