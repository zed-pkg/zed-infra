/**
 * Anonymous, public-only native registry adapters.
 *
 * A package name is never treated as an authorization signal. Public status
 * is established only when the canonical public endpoint answers without an
 * Authorization header and returns a valid public metadata document. The
 * first deployment intentionally supports only npm and crates.io: these are
 * the two ecosystems in the product requirement and both have fixed,
 * auditable metadata and artifact hosts. Add another ecosystem only with the
 * same URL, redirect, body-size, and negative-path tests.
 */

import { USER_AGENT } from "./github-fallback.js";

const NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;
export const MAX_NATIVE_METADATA_BYTES = 1024 * 1024;

export const PUBLIC_NATIVE_HOSTS = Object.freeze({
  npm: Object.freeze({
    id: "npm",
    aliases: Object.freeze(["npm", "npmjs", "npmjs.com"]),
    metadata: "https://registry.npmjs.org",
    artifactHosts: Object.freeze(["registry.npmjs.org"]),
  }),
  "crates-io": Object.freeze({
    id: "crates-io",
    aliases: Object.freeze(["crates-io", "crates.io", "cargo"]),
    metadata: "https://crates.io/api/v1",
    artifactHosts: Object.freeze(["crates.io", "static.crates.io"]),
  }),
});

const ALIAS_TO_HOST = new Map();
for (const host of Object.values(PUBLIC_NATIVE_HOSTS)) {
  for (const alias of host.aliases) ALIAS_TO_HOST.set(alias, host);
}

export function normalizeOrgToken(org) {
  if (typeof org !== "string") return "";
  return org.trim().toLowerCase().replace(/[_ ]/g, "-");
}

export function publicNativeHostFromOrg(org) {
  return ALIAS_TO_HOST.get(normalizeOrgToken(org)) || null;
}

export function isSafePackageName(name) {
  return (
    typeof name === "string" &&
    NAME.test(name) &&
    !name.includes("..") &&
    !name.includes("/") &&
    !name.includes("\\")
  );
}

/**
 * This predicate only establishes that a coordinate is safe to ask about.
 * The anonymous upstream response establishes that it is actually public.
 */
export function isHighLikelihoodPublic(host, name) {
  return Boolean(host && isSafePackageName(name));
}

export function nativeHeaders(accept = "application/json") {
  return { Accept: accept, "User-Agent": USER_AGENT };
}

export function nativePackageMetadataUrl(host, name) {
  if (!isHighLikelihoodPublic(host, name)) return null;
  switch (host.id) {
    case "npm":
      return `${host.metadata}/${encodeURIComponent(name)}`;
    case "crates-io":
      return `${host.metadata}/crates/${encodeURIComponent(name)}`;
    default:
      return null;
  }
}

export function nativeVersionMetadataUrl(host, name, version) {
  if (!isHighLikelihoodPublic(host, name) || !VERSION.test(version || "")) return null;
  switch (host.id) {
    case "npm":
      return `${host.metadata}/${encodeURIComponent(name)}/${encodeURIComponent(version)}`;
    case "crates-io":
      return `${host.metadata}/crates/${encodeURIComponent(name)}/${encodeURIComponent(version)}`;
    default:
      return null;
  }
}

export function nativeTarballUrls(host, name, version, filename) {
  if (!isHighLikelihoodPublic(host, name) || !VERSION.test(version || "")) return [];
  switch (host.id) {
    case "npm": {
      const expected = `${name}-${version}.tgz`;
      if (filename && filename !== expected) return [];
      return [`https://registry.npmjs.org/${encodeURIComponent(name)}/-/${encodeURIComponent(expected)}`];
    }
    case "crates-io": {
      const expected = `${name}-${version}.crate`;
      if (filename && filename !== expected) return [];
      return [
        `https://static.crates.io/crates/${encodeURIComponent(name)}/${encodeURIComponent(expected)}`,
      ];
    }
    default:
      return [];
  }
}

export function isAllowedNativeDownloadUrl(host, rawUrl, name, version) {
  if (!host || !isSafePackageName(name) || !VERSION.test(version || "")) return false;
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
  if (!host.artifactHosts.includes(url.hostname)) return false;

  const encodedName = encodeURIComponent(name);
  const encodedVersion = encodeURIComponent(version);
  if (host.id === "npm") {
    return (
      url.hostname === "registry.npmjs.org" &&
      url.pathname === `/${encodedName}/-/${encodedName}-${encodedVersion}.tgz`
    );
  }
  if (host.id === "crates-io") {
    return (
      (url.hostname === "crates.io" &&
        url.pathname === `/api/v1/crates/${encodedName}/${encodedVersion}/download`) ||
      (url.hostname === "static.crates.io" &&
        url.pathname === `/crates/${encodedName}/${encodedName}-${encodedVersion}.crate`)
    );
  }
  return false;
}

export function isPrivateOrUnpublished(host, body) {
  if (!body || typeof body !== "object" || body.private === true || body.unpublished) return true;
  if (typeof body.error === "string" && /not found|unpublished|private/i.test(body.error)) {
    return true;
  }
  if (host?.id === "npm") {
    return Boolean(body._unpublished || (!body.versions && !body.version && !body.dist));
  }
  if (host?.id === "crates-io") {
    return !body.crate && !body.version && !body.versions;
  }
  return true;
}

export async function readBoundedJson(response, maxBytes = MAX_NATIVE_METADATA_BYTES) {
  const contentType = response.headers.get("content-type") || "";
  if (!/^application\/(?:[a-z0-9.+-]*\+)?json(?:\s*;|$)/i.test(contentType)) return null;
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

export function versionsFromNativeBody(host, body) {
  if (!body || typeof body !== "object") return [];
  switch (host?.id) {
    case "npm":
      return Object.keys(body.versions || {}).sort(sortVersionsDesc);
    case "crates-io":
      return (body.versions || [])
        .filter((row) => !row.yanked)
        .map((row) => row.num || row.vers)
        .filter(Boolean)
        .sort(sortVersionsDesc);
    default:
      return [];
  }
}

export function downloadFromNativeVersion(host, name, version, body) {
  if (!body || typeof body !== "object") return null;
  if (host?.id === "npm") {
    const dist = body.dist || body.versions?.[version]?.dist;
    if (!dist?.tarball || !isAllowedNativeDownloadUrl(host, dist.tarball, name, version)) {
      return null;
    }
    return {
      url: dist.tarball,
      sha256: integrityToSha256(dist.integrity),
      size: Number.isSafeInteger(Number(dist.unpackedSize)) ? Number(dist.unpackedSize) : 0,
      format: "tar.gz",
    };
  }
  if (host?.id === "crates-io") {
    const row = body.version || body.crate;
    if (!row || (row.num || row.vers || version) !== version || row.yanked) return null;
    const url = row.dl_path
      ? new URL(row.dl_path, "https://crates.io").toString()
      : nativeTarballUrls(host, name, version)[0];
    if (!url || !isAllowedNativeDownloadUrl(host, url, name, version)) return null;
    return {
      url,
      sha256: SHA256.test(row.checksum || "") ? row.checksum : "",
      size: Number.isSafeInteger(row.crate_size) && row.crate_size > 0 ? row.crate_size : 0,
      format: "crate",
    };
  }
  return null;
}

export function toPackageMetadata(host, org, name, body) {
  const versions = versionsFromNativeBody(host, body);
  return {
    org,
    name,
    description: body.description || body.crate?.description || null,
    vcs: "git",
    repo_url: publicRepoUrl(host, name, body),
    latest: versions[0] || body.version || null,
    tags: [],
    versions,
    native_host: host.id,
  };
}

export function toVersionMetadata(host, org, name, version, body, download) {
  return {
    org,
    name,
    version,
    sha256: download.sha256 || "",
    size: download.size || 0,
    format: download.format,
    vcs_tag: version,
    vcs_commit: null,
    download_url: download.url,
    published_at: body.time?.[version] || body.version?.created_at || "1970-01-01T00:00:00Z",
    yanked: Boolean(body.yanked || body.version?.yanked),
    mirrors: [{ kind: `native-${host.id}`, url: download.url }],
    native_host: host.id,
  };
}

function publicRepoUrl(host, name, body) {
  const repo = body.repository?.url || body.repository || body.crate?.repository || null;
  if (typeof repo === "string" && /^https:\/\//.test(repo)) {
    return repo.replace(/^git\+/, "").replace(/\.git$/, "");
  }
  return host.id === "npm"
    ? `https://www.npmjs.com/package/${name}`
    : `https://crates.io/crates/${name}`;
}

function integrityToSha256(integrity) {
  if (typeof integrity !== "string") return "";
  const match = integrity.match(/^sha256-([A-Za-z0-9+/=]+)$/);
  if (!match) return "";
  try {
    const bytes = Uint8Array.from(atob(match[1]), (character) => character.charCodeAt(0));
    const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    return SHA256.test(hex) ? hex : "";
  } catch {
    return "";
  }
}

function sortVersionsDesc(a, b) {
  return a < b ? 1 : a > b ? -1 : 0;
}

export function statusMeansPrivateOrMissing(status) {
  return status === 401 || status === 403 || status === 404 || status === 451;
}
