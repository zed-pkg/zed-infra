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
 * The registry hostname is an explicit finite state machine, not a `/v1/*`
 * prefix proxy. zed-api-server.rs also has browser/account compatibility
 * routes below `/v1`; a prefix check would expose those routes accidentally.
 */
export const REGISTRY_ACTION = Object.freeze({
  PREFLIGHT: "preflight",
  HEALTH: "health",
  ORIGIN_READ: "origin_read",
  ORIGIN_WRITE: "origin_write",
  FALLBACK_READ: "fallback_read",
  DENY_METHOD: "deny_method",
  DENY_ROUTE: "deny_route",
});

const REGISTRY_ROUTE_SPECS = Object.freeze([
  { name: "healthz", pattern: /^\/healthz$/, methods: ["GET", "HEAD"] },
  { name: "list_packages", pattern: /^\/v1\/packages$/, methods: ["GET", "HEAD"] },
  {
    name: "get_package",
    pattern: /^\/v1\/packages\/([a-z0-9-]+)\/([a-z0-9-]+)$/,
    methods: ["GET", "HEAD"],
    fallback: true,
  },
  {
    name: "version",
    pattern:
      /^\/v1\/packages\/([a-z0-9-]+)\/([a-z0-9-]+)\/versions\/([0-9A-Za-z][0-9A-Za-z.+-]{0,127})$/,
    methods: ["GET", "HEAD", "PUT"],
    fallback: true,
  },
  {
    name: "yank",
    pattern:
      /^\/v1\/packages\/([a-z0-9-]+)\/([a-z0-9-]+)\/versions\/([0-9A-Za-z][0-9A-Za-z.+-]{0,127})\/yank$/,
    methods: ["POST"],
  },
  {
    name: "artifact",
    pattern: /^\/v1\/artifacts\/([a-f0-9]{64})$/,
    methods: ["GET", "HEAD"],
  },
  {
    name: "files",
    pattern:
      /^\/v1\/files\/([a-z0-9-]+)\/([a-z0-9-]+)\/([0-9A-Za-z][0-9A-Za-z.+-]{0,127})\/(.+)$/,
    methods: ["GET", "HEAD"],
  },
  { name: "search", pattern: /^\/v1\/search$/, methods: ["GET", "HEAD"] },
  { name: "semantic_search", pattern: /^\/v1\/search\/semantic$/, methods: ["POST"] },
  {
    name: "embedding",
    pattern: /^\/v1\/packages\/([a-z0-9-]+)\/([a-z0-9-]+)\/embedding$/,
    methods: ["PUT"],
  },
  { name: "claim_org", pattern: /^\/v1\/orgs$/, methods: ["POST"] },
  {
    name: "audit_verify",
    pattern: /^\/v1\/orgs\/([a-z0-9-]+)\/audit\/verify$/,
    methods: ["GET", "HEAD"],
  },
  {
    name: "audit",
    pattern: /^\/v1\/orgs\/([a-z0-9-]+)\/audit$/,
    methods: ["GET", "HEAD"],
  },
  {
    name: "declared_graph_export",
    pattern:
      /^\/v1\/packages\/([a-z0-9-]+)\/([a-z0-9-]+)\/versions\/([0-9A-Za-z][0-9A-Za-z.+-]{0,127})\/dependency-graph\/export\/([a-z0-9-]+)$/,
    methods: ["GET", "HEAD"],
  },
  {
    name: "declared_graph",
    pattern:
      /^\/v1\/packages\/([a-z0-9-]+)\/([a-z0-9-]+)\/versions\/([0-9A-Za-z][0-9A-Za-z.+-]{0,127})\/dependency-graph$/,
    methods: ["GET", "HEAD"],
  },
  {
    name: "resolution_graph",
    pattern: /^\/v1\/resolutions\/(sha256:[a-f0-9]{64})\/dependency-graph$/,
    methods: ["GET", "HEAD"],
  },
]);

function normalizePath(pathname) {
  if (typeof pathname !== "string" || pathname.length > 2048) return null;
  // Registry routes have canonical ASCII spellings. Refusing all percent
  // encoding prevents encoded separators and double-decoding ambiguity.
  if (pathname.includes("%")) return null;
  let path;
  try {
    path = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (
    path.includes("%") ||
    path.includes("..") ||
    path.includes("\\") ||
    path.includes("\0") ||
    path.includes("//")
  ) {
    return null;
  }
  return path.replace(/\/+$/, "") || "/";
}

function matchRegistryRoute(pathname) {
  const path = normalizePath(pathname);
  if (!path) return null;
  for (const spec of REGISTRY_ROUTE_SPECS) {
    const match = path.match(spec.pattern);
    if (!match) continue;
    return { path, spec, match };
  }
  return null;
}

/**
 * Total transition function for the public registry boundary.
 * Every input returns exactly one action and the function performs no I/O.
 */
export function classifyRegistryRequest(method, pathname) {
  const route = matchRegistryRoute(pathname);
  if (!route) {
    return { action: REGISTRY_ACTION.DENY_ROUTE, route: null, allow: [] };
  }

  const normalizedMethod = String(method || "").toUpperCase();
  if (normalizedMethod === "OPTIONS") {
    return {
      action: REGISTRY_ACTION.PREFLIGHT,
      route: route.spec.name,
      allow: [...route.spec.methods, "OPTIONS"],
    };
  }
  if (!route.spec.methods.includes(normalizedMethod)) {
    return {
      action: REGISTRY_ACTION.DENY_METHOD,
      route: route.spec.name,
      allow: [...route.spec.methods, "OPTIONS"],
    };
  }
  if (route.spec.name === "healthz") {
    return { action: REGISTRY_ACTION.HEALTH, route: "healthz", allow: route.spec.methods };
  }
  const isRead = normalizedMethod === "GET" || normalizedMethod === "HEAD";
  return {
    action:
      isRead && route.spec.fallback
        ? REGISTRY_ACTION.FALLBACK_READ
        : isRead
          ? REGISTRY_ACTION.ORIGIN_READ
          : REGISTRY_ACTION.ORIGIN_WRITE,
    route: route.spec.name,
    allow: route.spec.methods,
  };
}

/** Paths that may be served on registry.zpkg.net (API registry slice only). */
export function isRegistryOnlyPath(pathname) {
  return matchRegistryRoute(pathname) !== null;
}

export function parseRegistryPath(pathname) {
  const path = normalizePath(pathname);
  if (!path) return null;
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
  if (typeof pathname !== "string" || pathname.length > 2048) return null;
  if (pathname.includes("%")) return null;
  let path;
  try {
    path = decodeURIComponent(pathname.replace(/^\/+/, "").replace(/\/+$/, ""));
  } catch {
    return null;
  }
  if (!path || path.includes("%") || path.includes("..") || path.includes("\\")) return null;

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
      "cache-control": status >= 400 ? "no-store" : "public, max-age=60",
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

export function githubHeaders() {
  return {
    Accept: "application/vnd.github+json",
    "User-Agent": USER_AGENT,
    "X-GitHub-Api-Version": "2022-11-28",
  };
}
