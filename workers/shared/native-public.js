/**
 * Anonymous, public-only native registry adapters.
 *
 * A package name is never treated as an authorization signal. Public status
 * is established only when the canonical public endpoint answers without an
 * Authorization header and returns a valid public metadata document.
 *
 * This module normalizes the registry families whose public protocol can be
 * represented by Zed's package/version DTOs without losing platform or
 * coordinate information. The provider catalog also describes the remaining
 * ecosystems; those use the protocol-preserving gateway instead of pretending
 * every native registry is one JSON endpoint plus one tarball.
 */

import { USER_AGENT } from "./github-fallback.js";
import {
  NATIVE_PROVIDER_CATALOG,
  nativeProviderFromToken,
} from "./native-provider-catalog.js";

const NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;
export const MAX_NATIVE_METADATA_BYTES = 1024 * 1024;

const EDGE_NORMALIZED_PROVIDER_IDS = new Set([
  "npm",
  "crates-io",
  "pypi",
  "nuget",
  "rubygems",
  "hex",
  "hackage",
]);

export const PUBLIC_NATIVE_HOSTS = Object.freeze(
  Object.fromEntries(
    Object.entries(NATIVE_PROVIDER_CATALOG).filter(([id]) =>
      EDGE_NORMALIZED_PROVIDER_IDS.has(id),
    ),
  ),
);

export function normalizeOrgToken(org) {
  if (typeof org !== "string") {
    return "";
  }
  return org.trim().toLowerCase().replace(/[_ ]/g, "-");
}

export function publicNativeHostFromOrg(org) {
  const provider = nativeProviderFromToken(normalizeOrgToken(org));
  if (!provider || !EDGE_NORMALIZED_PROVIDER_IDS.has(provider.id)) {
    return null;
  }
  return provider;
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
  if (!isHighLikelihoodPublic(host, name)) {
    return null;
  }
  const encoded = encodeURIComponent(name);
  const lower = name.toLowerCase();
  switch (host.id) {
    case "npm":
      return `${host.metadata}/${encoded}`;
    case "crates-io":
      return `${host.metadata}/crates/${encoded}`;
    case "pypi":
      return `${host.metadata}/${encoded}/json`;
    case "nuget":
      return `${host.metadata}/${encodeURIComponent(lower)}/index.json`;
    case "rubygems":
      return `https://rubygems.org/api/v1/versions/${encoded}.json`;
    case "hex":
      return `${host.metadata}/packages/${encoded}`;
    case "hackage":
      return `${host.metadata}/${encoded}.json`;
    default:
      return null;
  }
}

export function nativeVersionMetadataUrl(host, name, version) {
  if (!isHighLikelihoodPublic(host, name) || !VERSION.test(version || "")) {
    return null;
  }
  const encoded = encodeURIComponent(name);
  const encodedVersion = encodeURIComponent(version);
  const lower = name.toLowerCase();
  switch (host.id) {
    case "npm":
      return `${host.metadata}/${encoded}/${encodedVersion}`;
    case "crates-io":
      return `${host.metadata}/crates/${encoded}/${encodedVersion}`;
    case "pypi":
      return `${host.metadata}/${encoded}/${encodedVersion}/json`;
    case "nuget":
      return `${host.metadata}/${encodeURIComponent(lower)}/index.json`;
    case "rubygems":
      return `https://rubygems.org/api/v2/rubygems/${encoded}/versions/${encodedVersion}.json`;
    case "hex":
      return `${host.metadata}/packages/${encoded}`;
    case "hackage":
      return `${host.metadata}/${encoded}.json`;
    default:
      return null;
  }
}

export function nativeTarballUrls(host, name, version, filename) {
  if (!isHighLikelihoodPublic(host, name) || !VERSION.test(version || "")) {
    return [];
  }
  const encodedName = encodeURIComponent(name);
  const encodedVersion = encodeURIComponent(version);
  switch (host.id) {
    case "npm": {
      const expected = `${name}-${version}.tgz`;
      if (filename && filename !== expected) {
        return [];
      }
      return [`https://registry.npmjs.org/${encodedName}/-/${encodeURIComponent(expected)}`];
    }
    case "crates-io": {
      const expected = `${name}-${version}.crate`;
      if (filename && filename !== expected) {
        return [];
      }
      return [
        `https://static.crates.io/crates/${encodedName}/${encodeURIComponent(expected)}`,
      ];
    }
    case "nuget": {
      const lowerName = name.toLowerCase();
      const lowerVersion = version.toLowerCase();
      const expected = `${lowerName}.${lowerVersion}.nupkg`;
      if (filename && filename.toLowerCase() !== expected) {
        return [];
      }
      return [
        `https://api.nuget.org/v3-flatcontainer/${encodeURIComponent(lowerName)}/${encodeURIComponent(lowerVersion)}/${encodeURIComponent(expected)}`,
      ];
    }
    case "rubygems": {
      const expected = `${name}-${version}.gem`;
      if (filename && filename !== expected) {
        return [];
      }
      return [`https://rubygems.org/gems/${encodeURIComponent(expected)}`];
    }
    case "hex": {
      const expected = `${name}-${version}.tar`;
      if (filename && filename !== expected) {
        return [];
      }
      return [`https://repo.hex.pm/tarballs/${encodeURIComponent(expected)}`];
    }
    case "hackage": {
      const expected = `${name}-${version}.tar.gz`;
      if (filename && filename !== expected) {
        return [];
      }
      return [
        `https://hackage.haskell.org/package/${encodedName}-${encodedVersion}/${encodeURIComponent(expected)}`,
      ];
    }
    default:
      return [];
  }
}

export function isAllowedNativeDownloadUrl(host, rawUrl, name, version) {
  if (!host || !isSafePackageName(name) || !VERSION.test(version || "")) {
    return false;
  }
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) {
    return false;
  }
  if (!host.artifactHosts.includes(url.hostname)) {
    return false;
  }

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
  if (host.id === "pypi") {
    let decoded;
    try {
      decoded = decodeURIComponent(url.pathname);
    } catch {
      return false;
    }
    return (
      url.hostname === "files.pythonhosted.org" &&
      decoded.includes(version) &&
      (/\.tar\.gz$/i.test(decoded) || /\.whl$/i.test(decoded))
    );
  }
  if (host.id === "nuget") {
    const lowerName = name.toLowerCase();
    const lowerVersion = version.toLowerCase();
    return (
      url.hostname === "api.nuget.org" &&
      url.pathname.toLowerCase() ===
        `/v3-flatcontainer/${encodeURIComponent(lowerName)}/${encodeURIComponent(lowerVersion)}/${encodeURIComponent(`${lowerName}.${lowerVersion}.nupkg`)}`
    );
  }
  if (host.id === "rubygems") {
    return (
      url.hostname === "rubygems.org" &&
      url.pathname === `/gems/${encodeURIComponent(`${name}-${version}.gem`)}`
    );
  }
  if (host.id === "hex") {
    return (
      (url.hostname === "repo.hex.pm" || url.hostname === "hex.pm") &&
      url.pathname === `/tarballs/${encodeURIComponent(`${name}-${version}.tar`)}`
    );
  }
  if (host.id === "hackage") {
    return (
      url.hostname === "hackage.haskell.org" &&
      url.pathname ===
        `/package/${encodedName}-${encodedVersion}/${encodeURIComponent(`${name}-${version}.tar.gz`)}`
    );
  }
  return false;
}

export function isPrivateOrUnpublished(host, body) {
  if (!body || typeof body !== "object" || body.private === true || body.unpublished) {
    return true;
  }
  if (typeof body.error === "string" && /not found|unpublished|private/i.test(body.error)) {
    return true;
  }
  switch (host?.id) {
    case "npm":
      return Boolean(body._unpublished || (!body.versions && !body.version && !body.dist));
    case "crates-io":
      return !body.crate && !body.version && !body.versions;
    case "pypi":
      return !body.info && !body.releases && !body.urls;
    case "nuget":
      return !Array.isArray(body.versions);
    case "rubygems":
      return !(Array.isArray(body) || body.version || body.name);
    case "hex":
      return !body.name || !Array.isArray(body.releases);
    case "hackage":
      return Array.isArray(body) || Object.keys(body).length === 0;
    default:
      return true;
  }
}

export async function readBoundedJson(response, maxBytes = MAX_NATIVE_METADATA_BYTES) {
  const contentType = response.headers.get("content-type") || "";
  if (!/^application\/(?:[a-z0-9.+-]*\+)?json(?:\s*;|$)/i.test(contentType)) {
    return null;
  }
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > maxBytes) {
    return null;
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maxBytes) {
    return null;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

export function versionsFromNativeBody(host, body) {
  if (!body || typeof body !== "object") {
    return [];
  }
  switch (host?.id) {
    case "npm":
      return Object.keys(body.versions || {}).sort(sortVersionsDesc);
    case "crates-io":
      return (body.versions || [])
        .filter((row) => !row.yanked)
        .map((row) => row.num || row.vers)
        .filter(Boolean)
        .sort(sortVersionsDesc);
    case "pypi":
      return Object.keys(body.releases || {}).sort(sortVersionsDesc);
    case "nuget":
      return (body.versions || []).filter(Boolean).sort(sortVersionsDesc);
    case "rubygems":
      return (Array.isArray(body) ? body : [body])
        .filter((row) => !row.yanked)
        .map((row) => row.number || row.version)
        .filter(Boolean)
        .sort(sortVersionsDesc);
    case "hex":
      return (body.releases || [])
        .map((row) => row.version)
        .filter(Boolean)
        .sort(sortVersionsDesc);
    case "hackage":
      return Object.keys(body).sort(sortVersionsDesc);
    default:
      return [];
  }
}

export function downloadFromNativeVersion(host, name, version, body) {
  if (!body || typeof body !== "object") {
    return null;
  }
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
    if (!row || (row.num || row.vers || version) !== version || row.yanked) {
      return null;
    }
    const url = row.dl_path
      ? new URL(row.dl_path, "https://crates.io").toString()
      : nativeTarballUrls(host, name, version)[0];
    if (!url || !isAllowedNativeDownloadUrl(host, url, name, version)) {
      return null;
    }
    return {
      url,
      sha256: SHA256.test(row.checksum || "") ? row.checksum : "",
      size: Number.isSafeInteger(row.crate_size) && row.crate_size > 0 ? row.crate_size : 0,
      // `.crate` is a gzip-compressed tar. `ArtifactFormat` deliberately
      // describes the container Zed decodes, not the ecosystem filename.
      format: "tar.gz",
    };
  }
  if (host?.id === "pypi") {
    const files = Array.isArray(body.urls) ? body.urls : body.releases?.[version] || [];
    const file =
      files.find((row) => row.packagetype === "sdist" && /\.tar\.gz$/i.test(row.filename || "")) ||
      files.find(
        (row) => row.packagetype === "bdist_wheel" && /(?:py2\.py3|py3)-none-any\.whl$/i.test(row.filename || ""),
      );
    if (!file?.url || !isAllowedNativeDownloadUrl(host, file.url, name, version)) {
      return null;
    }
    return {
      url: file.url,
      sha256: SHA256.test(file.digests?.sha256 || "") ? file.digests.sha256 : "",
      size: Number.isSafeInteger(file.size) && file.size > 0 ? file.size : 0,
      format: /\.whl$/i.test(file.filename || "") ? "zip" : "tar.gz",
    };
  }
  if (host?.id === "nuget") {
    const normalized = version.toLowerCase();
    if (!(body.versions || []).some((candidate) => candidate.toLowerCase() === normalized)) {
      return null;
    }
    const url = nativeTarballUrls(host, name, version)[0];
    return url && isAllowedNativeDownloadUrl(host, url, name, version)
      ? { url, sha256: "", size: 0, format: "zip" }
      : null;
  }
  if (host?.id === "rubygems") {
    if (body.version !== version || body.yanked === true) {
      return null;
    }
    const url = nativeTarballUrls(host, name, version)[0];
    return url && isAllowedNativeDownloadUrl(host, url, name, version)
      ? {
          url,
          sha256: SHA256.test(body.sha || "") ? body.sha : "",
          size: 0,
          format: "tar.gz",
        }
      : null;
  }
  if (host?.id === "hex") {
    const row = (body.releases || []).find((release) => release.version === version);
    if (!row) {
      return null;
    }
    const url = nativeTarballUrls(host, name, version)[0];
    const checksum = String(row.checksum || "").toLowerCase();
    return url && isAllowedNativeDownloadUrl(host, url, name, version)
      ? {
          url,
          sha256: SHA256.test(checksum) ? checksum : "",
          size: 0,
          format: "tar.gz",
        }
      : null;
  }
  if (host?.id === "hackage") {
    if (!Object.prototype.hasOwnProperty.call(body, version)) {
      return null;
    }
    const url = nativeTarballUrls(host, name, version)[0];
    return url && isAllowedNativeDownloadUrl(host, url, name, version)
      ? { url, sha256: "", size: 0, format: "tar.gz" }
      : null;
  }
  return null;
}

export function toPackageMetadata(host, org, name, body) {
  const versions = versionsFromNativeBody(host, body);
  return {
    org,
    name,
    description: publicDescription(host, body),
    vcs: "git",
    repo_url: publicRepoUrl(host, name, body),
    latest: versions[0] || body.version || body.info?.version || null,
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
    published_at: publicPublishedAt(host, version, body),
    yanked: Boolean(body.yanked || body.version?.yanked),
    // Native URLs are source provenance, not Zed mirrors. MirrorDescriptorV1
    // has a closed kind enum; inventing `native-*` kinds breaks Rust DTO
    // deserialization before install can start.
    mirrors: [],
    native_host: host.id,
  };
}

function publicDescription(host, body) {
  switch (host.id) {
    case "pypi":
      return body.info?.summary || null;
    case "rubygems":
      return (Array.isArray(body) ? body[0] : body)?.description || body.info || null;
    case "hex":
      return body.meta?.description || null;
    default:
      return body.description || body.crate?.description || null;
  }
}

function publicPublishedAt(host, version, body) {
  if (host.id === "npm") {
    return body.time?.[version] || "1970-01-01T00:00:00Z";
  }
  if (host.id === "crates-io") {
    return body.version?.created_at || "1970-01-01T00:00:00Z";
  }
  if (host.id === "pypi") {
    const file = (body.urls || [])[0];
    return file?.upload_time_iso_8601 || file?.upload_time || "1970-01-01T00:00:00Z";
  }
  if (host.id === "rubygems") {
    return body.version_created_at || body.created_at || "1970-01-01T00:00:00Z";
  }
  if (host.id === "hex") {
    return (body.releases || []).find((release) => release.version === version)?.inserted_at ||
      "1970-01-01T00:00:00Z";
  }
  return "1970-01-01T00:00:00Z";
}

function publicRepoUrl(host, name, body) {
  const candidates = [
    body.repository?.url,
    body.repository,
    body.crate?.repository,
    body.info?.project_urls?.Source,
    body.info?.project_urls?.Repository,
    body.metadata?.source_code_uri,
    body.meta?.links?.Github,
    body.meta?.links?.GitHub,
  ];
  for (const repo of candidates) {
    if (typeof repo === "string" && /^https:\/\//.test(repo)) {
      return repo.replace(/^git\+/, "").replace(/\.git$/, "");
    }
  }
  switch (host.id) {
    case "npm":
      return `https://www.npmjs.com/package/${name}`;
    case "crates-io":
      return `https://crates.io/crates/${name}`;
    case "pypi":
      return `https://pypi.org/project/${name}/`;
    case "nuget":
      return `https://www.nuget.org/packages/${name}`;
    case "rubygems":
      return `https://rubygems.org/gems/${name}`;
    case "hex":
      return `https://hex.pm/packages/${name}`;
    case "hackage":
      return `https://hackage.haskell.org/package/${name}`;
    default:
      return host.metadata;
  }
}

function integrityToSha256(integrity) {
  if (typeof integrity !== "string") {
    return "";
  }
  const match = integrity.match(/^sha256-([A-Za-z0-9+/=]+)$/);
  if (!match) {
    return "";
  }
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
