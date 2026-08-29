import {
  GITHUB_WEB,
  githubApiReleaseUrl,
  githubApiTagsUrl,
  githubHeaders,
  githubIdentity,
  githubRawManifestUrl,
  githubReleaseAssetNames,
  githubReleaseDownloadUrl,
  githubReleaseSidecarNames,
  gitTagsForVersion,
  jsonResponse,
  originIsUnavailable,
  isRegistryOnlyPath,
  parseRegistryPath,
  USER_AGENT,
  versionFromGitTag,
} from "../../shared/github-fallback.js";
import {
  downloadFromNativeVersion,
  isPrivateOrUnpublished,
  nativeHeaders,
  nativePackageMetadataUrl,
  nativeVersionMetadataUrl,
  publicNativeHostFromOrg,
  statusMeansPrivateOrMissing,
  toPackageMetadata,
  toVersionMetadata,
} from "../../shared/native-public.js";

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const route = parseRegistryPath(url.pathname);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    // registry.zpkg.net is a hostname for the API's /v1 registry slice only.
    // Auth, admin, and other api.zpkg.net routes stay off this host.
    if (!isRegistryOnlyPath(url.pathname)) {
      return jsonResponse(
        {
          ok: false,
          error: "not_registry_path",
          message:
            "registry.zpkg.net serves /healthz and /v1/* on zed-api-server.rs. Use api.zpkg.net for the rest of the API.",
        },
        404,
      );
    }

    if (WRITE_METHODS.has(request.method)) {
      const origin = await tryOrigin(request, env);
      if (origin && !originIsUnavailable(origin.status)) return withEdge(origin, "origin");
      return jsonResponse(
        {
          ok: false,
          error: "registry_origin_down",
          message:
            "Writes need the zed-api-server origin. Edge fallback is read-only (GitHub Releases, GHCR, public native registries).",
        },
        503,
        { headers: { "retry-after": "30" } },
      );
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return jsonResponse({ ok: false, error: "method_not_allowed" }, 405);
    }

    const origin = await tryOrigin(request, env);
    if (origin && !originIsUnavailable(origin.status) && origin.status !== 404) {
      return withEdge(origin, "origin");
    }

    if (!route) {
      if (origin) return withEdge(origin, "origin");
      return jsonResponse({ ok: false, error: "not_found" }, 404);
    }

    if (route.kind === "healthz") {
      if (origin && origin.status === 200) return withEdge(origin, "origin");
      return jsonResponse(
        {
          ok: true,
          db: false,
          degraded: true,
          source: "edge-fallback",
          fallbacks: ["github", "npm", "crates-io", "pypi", "rubygems", "hex", "pub-dev", "nuget"],
        },
        200,
      );
    }

    try {
      const native = await nativePublicFallback(route);
      if (native) return native;
    } catch (error) {
      return jsonResponse(
        { ok: false, error: "native_fallback_failed", message: String(error) },
        502,
      );
    }

    try {
      const github = await githubFallback(route, env);
      if (github) return github;
    } catch (error) {
      return jsonResponse(
        { ok: false, error: "github_fallback_failed", message: String(error) },
        502,
      );
    }

    if (origin) return withEdge(origin, "origin");
    return jsonResponse({ ok: false, error: "not_found", source: "miss" }, 404);
  },
};

async function tryOrigin(request, env) {
  if (!env.ORIGIN_URL) return null;
  const incoming = new URL(request.url);
  const target = new URL(incoming.pathname + incoming.search, env.ORIGIN_URL);
  try {
    return await fetch(
      new Request(target.toString(), {
        method: request.method,
        headers: request.headers,
        redirect: "manual",
      }),
      { signal: AbortSignal.timeout(Number(env.ORIGIN_TIMEOUT_MS || 4000)) },
    );
  } catch {
    return null;
  }
}

async function nativePublicFallback(route) {
  if (route.kind !== "get_package" && route.kind !== "get_version") return null;
  const host = publicNativeHostFromOrg(route.org);
  if (!host) return null;

  if (route.kind === "get_package") {
    const url = nativePackageMetadataUrl(host, route.name);
    if (!url) return null;
    const res = await fetch(url, { headers: nativeHeaders() });
    if (statusMeansPrivateOrMissing(res.status) || !res.ok) return null;
    const body = await res.json();
    if (isPrivateOrUnpublished(host, body)) return null;
    return jsonResponse(toPackageMetadata(host, route.org, route.name, body), 200, {
      source: `native-${host.id}`,
    });
  }

  const url = nativeVersionMetadataUrl(host, route.name, route.version);
  if (!url) return null;
  const res = await fetch(url, { headers: nativeHeaders() });
  if (statusMeansPrivateOrMissing(res.status) || !res.ok) return null;
  const body = await res.json();
  if (isPrivateOrUnpublished(host, body)) return null;
  const download = downloadFromNativeVersion(host, route.name, route.version, body);
  if (!download?.url) return null;
  return jsonResponse(
    toVersionMetadata(host, route.org, route.name, route.version, body, download),
    200,
    { source: `native-${host.id}` },
  );
}

async function githubFallback(route, env) {
  const token = env.GITHUB_TOKEN;
  if (route.kind === "get_package") {
    return packageFromGithub(route.org, route.name, token);
  }
  if (route.kind === "get_version") {
    return versionFromGithub(route.org, route.name, route.version, token);
  }
  // sha256 lookup has no GitHub index without a sidecar; clients should
  // follow download_url / mirrors from get_version.
  return null;
}

async function packageFromGithub(org, name, token) {
  const identity = githubIdentity(org, name);
  const tagsRes = await fetch(githubApiTagsUrl(identity), {
    headers: githubHeaders(token),
  });
  if (!tagsRes.ok) return null;
  const tags = await tagsRes.json();
  const versions = (Array.isArray(tags) ? tags : [])
    .map((tag) => versionFromGitTag(tag.name || ""))
    .filter(Boolean);
  versions.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  let description = null;
  for (const gitRef of ["main", "master", versions[0] ? `v${versions[0]}` : "main"]) {
    const manifestRes = await fetch(githubRawManifestUrl(identity, gitRef), {
      headers: { "User-Agent": USER_AGENT },
    });
    if (!manifestRes.ok) continue;
    const text = await manifestRes.text();
    const match = text.match(/^description\s*=\s*"([^"]+)"/m);
    if (match) description = match[1];
    break;
  }
  return jsonResponse({
    org,
    name,
    description,
    vcs: "git",
    repo_url: `${GITHUB_WEB}/${org}/${name}`,
    latest: versions[0] || null,
    tags: [],
    versions,
  });
}

async function versionFromGithub(org, name, version, token) {
  const identity = githubIdentity(org, name);
  const tags = gitTagsForVersion(version);
  for (const tag of tags) {
    for (const sidecar of githubReleaseSidecarNames(org, name, version)) {
      const url = githubReleaseDownloadUrl(identity, tag, sidecar);
      const res = await fetch(url, {
        headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      });
      if (!res.ok) continue;
      const metadata = await res.json();
      metadata.org = metadata.org || org;
      metadata.name = metadata.name || name;
      metadata.version = metadata.version || version;
      return jsonResponse(metadata);
    }
    const releaseRes = await fetch(githubApiReleaseUrl(identity, tag), {
      headers: githubHeaders(token),
    });
    if (!releaseRes.ok) continue;
    const release = await releaseRes.json();
    const assets = Array.isArray(release.assets) ? release.assets : [];
    const wanted = new Set(githubReleaseAssetNames(org, name, version));
    const asset = assets.find((item) => wanted.has(item.name)) || assets[0];
    if (!asset) continue;
    const downloadUrl =
      asset.browser_download_url ||
      githubReleaseDownloadUrl(identity, tag, asset.name);
    return jsonResponse({
      org,
      name,
      version,
      sha256: "",
      size: asset.size || 0,
      format: "tar.gz",
      vcs_tag: tag,
      vcs_commit: release.target_commitish || null,
      download_url: downloadUrl,
      published_at: release.published_at || "1970-01-01T00:00:00Z",
      yanked: false,
      mirrors: [
        { kind: "github-release", url: downloadUrl },
      ],
    });
  }
  return null;
}

function withEdge(response, source) {
  const headers = new Headers(response.headers);
  headers.set("x-zed-source", source);
  headers.set("x-zed-edge", "registry");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,HEAD,OPTIONS",
    "access-control-max-age": "600",
  };
}
