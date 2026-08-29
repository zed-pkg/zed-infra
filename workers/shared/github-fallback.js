/**
 * Shared URL and path helpers for zpkg.net edge workers.
 *
 * These reconstruct the same GitHub / CDN locators as
 * `zed-interfaces/src/rust/source.rs` so a Worker can answer registry and
 * CDN GETs from GitHub when the k8s origin (or R2) is down. Keep this file
 * free of Cloudflare bindings so `node --test` can import it.
 */

export const GITHUB_WEB = "https://github.com";
export const GITHUB_API = "https://api.github.com";
export const GHCR = "https://ghcr.io";
export const USER_AGENT = "zed-pkg-edge/1.0 (+https://github.com/zed-pkg/zed-infra)";

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SHA256 = /^[a-f0-9]{64}$/;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]*$/;
const FILENAME = /^[A-Za-z0-9._+-]+$/;
const GIT_REF = /^[A-Za-z0-9._+-]+$/;

export function isSlug(value) {
  return typeof value === "string" && SLUG.test(value) && value.length <= 128;
}

export function isSha256(value) {
  return typeof value === "string" && SHA256.test(value);
}

function isSafeSegment(value, pattern) {
  return (
    typeof value === "string" &&
    pattern.test(value) &&
    !value.includes("..") &&
    value.length <= 128
  );
}

export function gitTagsForVersion(version) {
  const trimmed = version.trim();
  if (!trimmed) return [];
  const tags = [];
  if (!trimmed.startsWith("v")) tags.push(`v${trimmed}`);
  tags.push(trimmed);
  return tags;
}

export function versionFromGitTag(tag) {
  const name = tag.trim();
  if (!name) return null;
  const version = name.startsWith("v") ? name.slice(1) : name;
  return version || null;
}

export function githubReleaseAssetNames(org, name, version, ext = "tar.gz") {
  const names = [`zpkg-${org}-${name}-${version}.${ext}`];
  const short = `zpkg-${name}-${version}.${ext}`;
  if (!names.includes(short)) names.push(short);
  return names;
}

export function githubReleaseSidecarNames(org, name, version) {
  const names = [`zpkg-${org}-${name}-${version}.json`];
  const short = `zpkg-${name}-${version}.json`;
  if (!names.includes(short)) names.push(short);
  return names;
}

export function githubIdentity(org, name) {
  return { owner: org, repo: name };
}

export function githubReleaseDownloadUrl(identity, tag, asset) {
  return `${GITHUB_WEB}/${identity.owner}/${identity.repo}/releases/download/${tag}/${asset}`;
}

export function githubApiRepoUrl(identity) {
  return `${GITHUB_API}/repos/${identity.owner}/${identity.repo}`;
}

export function githubApiTagsUrl(identity) {
  return `${githubApiRepoUrl(identity)}/tags?per_page=100`;
}

export function githubApiReleaseUrl(identity, tag) {
  return `${githubApiRepoUrl(identity)}/releases/tags/${tag}`;
}

export function githubRawManifestUrl(identity, gitRef) {
  return `https://raw.githubusercontent.com/${identity.owner}/${identity.repo}/${gitRef}/.zpkg.toml`;
}

export function ghcrRepository(identity) {
  return `${identity.owner.toLowerCase()}/${identity.repo.toLowerCase()}`;
}

export function ghcrManifestUrl(identity, tag) {
  return `${GHCR}/v2/${ghcrRepository(identity)}/manifests/${tag}`;
}

export function originIsUnavailable(status) {
  return (
    status === 0 ||
    status === 502 ||
    status === 503 ||
    status === 504 ||
    status === 521 ||
    status === 522 ||
    status === 523 ||
    status === 524
  );
}

/**
 * Parse a registry.zpkg.net pathname into a typed route.
 * @returns {object|null}
 */
export function parseRegistryPath(pathname) {
  const path = decodeURIComponent(pathname.replace(/\/+$/, "") || "/");
  if (path === "/healthz") return { kind: "healthz" };

  const artifact = path.match(/^\/v1\/artifacts\/([0-9a-f]{64})$/);
  if (artifact) return { kind: "get_artifact", sha256: artifact[1] };

  const version = path.match(
    /^\/v1\/packages\/([a-z0-9-]+)\/([a-z0-9-]+)\/versions\/([^/]+)$/,
  );
  if (
    version &&
    isSlug(version[1]) &&
    isSlug(version[2]) &&
    isSafeSegment(version[3], VERSION)
  ) {
    return {
      kind: "get_version",
      org: version[1],
      name: version[2],
      version: version[3],
    };
  }

  const pkg = path.match(/^\/v1\/packages\/([a-z0-9-]+)\/([a-z0-9-]+)$/);
  if (pkg && isSlug(pkg[1]) && isSlug(pkg[2])) {
    return { kind: "get_package", org: pkg[1], name: pkg[2] };
  }

  return null;
}

/**
 * Parse a cdn.zpkg.net object key (pathname without leading slash).
 * @returns {object|null}
 */
export function parseCdnPath(pathname) {
  const path = decodeURIComponent(pathname.replace(/^\/+/, "").replace(/\/+$/, ""));
  if (!path || path.includes("..") || path.includes("\\")) return null;

  const github = path.match(
    /^github\/([a-z0-9-]+)\/([a-z0-9-]+)\/([^/]+)\/([^/]+)$/,
  );
  if (
    github &&
    isSlug(github[1]) &&
    isSlug(github[2]) &&
    isSafeSegment(github[3], GIT_REF) &&
    isSafeSegment(github[4], FILENAME)
  ) {
    return {
      kind: "cdn_github_object",
      owner: github[1],
      repo: github[2],
      tag: github[3],
      filename: github[4],
      key: path,
    };
  }

  const pkg = path.match(
    /^packages\/([a-z0-9-]+)\/([a-z0-9-]+)\/([^/]+)\/([^/]+)$/,
  );
  if (
    pkg &&
    isSlug(pkg[1]) &&
    isSlug(pkg[2]) &&
    isSafeSegment(pkg[3], VERSION) &&
    isSafeSegment(pkg[4], FILENAME)
  ) {
    return {
      kind: "cdn_package_object",
      org: pkg[1],
      name: pkg[2],
      version: pkg[3],
      filename: pkg[4],
      key: path,
    };
  }

  const artifact = path.match(/^artifacts\/([0-9a-f]{64})\.([A-Za-z0-9.+-]+)$/);
  if (artifact && isSafeSegment(artifact[2], FILENAME)) {
    return {
      kind: "cdn_content_object",
      sha256: artifact[1],
      ext: artifact[2],
      key: path,
    };
  }

  return null;
}

export function githubFallbackUrlsForCdn(parsed) {
  if (!parsed) return [];
  if (parsed.kind === "cdn_github_object") {
    return [
      githubReleaseDownloadUrl(
        { owner: parsed.owner, repo: parsed.repo },
        parsed.tag,
        parsed.filename,
      ),
    ];
  }
  if (parsed.kind === "cdn_package_object") {
    const identity = githubIdentity(parsed.org, parsed.name);
    const tags = gitTagsForVersion(parsed.version);
    const urls = [];
    for (const tag of tags) {
      urls.push(
        githubReleaseDownloadUrl(identity, tag, parsed.filename),
      );
      for (const asset of githubReleaseAssetNames(
        parsed.org,
        parsed.name,
        parsed.version,
      )) {
        urls.push(githubReleaseDownloadUrl(identity, tag, asset));
      }
    }
    return [...new Set(urls)];
  }
  return [];
}

export function jsonResponse(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
      "cache-control": "public, max-age=60",
      "x-zed-source": extra.source || "github",
      ...extra.headers,
    },
  });
}

export const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export function githubHeaders(token) {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": USER_AGENT,
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}
