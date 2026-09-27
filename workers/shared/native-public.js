/**
 * Anonymous, public-only native registry adapters.
 *
 * The registry catalog is deliberately larger than the active adapter set.
 * A catalog entry defines names and host confinement; it does not authorize a
 * protocol. An ecosystem becomes active here only after its metadata shape,
 * artifact path, redirect behavior, body bounds, and negative paths have tests.
 *
 * Package coordinates are never authorization signals. Public status is
 * established only by an anonymous response from a canonical public endpoint.
 */

import { USER_AGENT } from "./github-fallback.js";
import {
  NATIVE_REGISTRIES,
  decodeAndValidateNativeCoordinate,
  isAllowedNativeHost,
  nativeRegistryFromOrg,
  normalizeEcosystem,
} from "./native-registry-catalog.js";

const NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
const SAFE_NATIVE_VERSION = /^[0-9A-Za-z][0-9A-Za-z.!_+~-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;
export const MAX_NATIVE_METADATA_BYTES = 1024 * 1024;

function activeRegistry(id, metadata, artifactHosts) {
  const catalog = NATIVE_REGISTRIES[id];
  if (!catalog) {
    throw new Error(`unknown native registry: ${id}`);
  }
  return Object.freeze({
    ...catalog,
    metadata,
    artifactHosts: Object.freeze(artifactHosts),
  });
}

/**
 * Only these ecosystems currently have audited edge protocol adapters.
 * The remaining catalog entries stay fail-closed until their protocol-specific
 * adapter is implemented and tested.
 */
export const PUBLIC_NATIVE_HOSTS = Object.freeze({
  npm: activeRegistry("npm", "https://registry.npmjs.org", ["registry.npmjs.org"]),
  "crates-io": activeRegistry("crates-io", "https://crates.io/api/v1", [
    "crates.io",
    "static.crates.io",
  ]),
  pypi: activeRegistry("pypi", "https://pypi.org/pypi", ["files.pythonhosted.org"]),
  nuget: activeRegistry("nuget", "https://api.nuget.org/v3-flatcontainer", [
    "api.nuget.org",
  ]),
});

export function publicNativeFallbackIds() {
  return Object.keys(PUBLIC_NATIVE_HOSTS);
}

export function normalizeOrgToken(org) {
  return normalizeEcosystem(org);
}

export function publicNativeHostFromOrg(org) {
  const catalog = nativeRegistryFromOrg(org);
  if (!catalog) {
    return null;
  }
  return PUBLIC_NATIVE_HOSTS[catalog.id] || null;
}

/** Legacy helper retained for simple-coordinate callers and tests. */
export function isSafePackageName(name) {
  return (
    typeof name === "string" &&
    NAME.test(name) &&
    !name.includes("..") &&
    !name.includes("/") &&
    !name.includes("\\")
  );
}

function nativeCoordinate(host, encodedOrLegacy) {
  if (!host) {
    return null;
  }
  return decodeAndValidateNativeCoordinate(host, encodedOrLegacy);
}

function isSafeNativeVersion(version) {
  return (
    typeof version === "string" &&
    SAFE_NATIVE_VERSION.test(version) &&
    !version.includes("..") &&
    !version.includes("/") &&
    !version.includes("\\")
  );
}

/**
 * This predicate only establishes that a coordinate is safe to ask about.
 * The anonymous upstream response establishes that it is actually public.
 */
export function isHighLikelihoodPublic(host, name) {
  return Boolean(host && nativeCoordinate(host, name));
}

export function nativeHeaders(accept = "application/json") {
  return { Accept: accept, "User-Agent": USER_AGENT };
}

export function nativePackageMetadataUrl(host, name) {
  const coordinate = nativeCoordinate(host, name);
  if (!coordinate) {
    return null;
  }
  switch (host.id) {
    case "npm":
      return `${host.metadata}/${encodeURIComponent(coordinate)}`;
    case "crates-io":
      return `${host.metadata}/crates/${encodeURIComponent(coordinate)}`;
    case "pypi":
      return `${host.metadata}/${encodeURIComponent(coordinate)}/json`;
    case "nuget":
      return `${host.metadata}/${encodeURIComponent(coordinate.toLowerCase())}/index.json`;
    default:
      return null;
  }
}

export function nativeVersionMetadataUrl(host, name, version) {
  const coordinate = nativeCoordinate(host, name);
  if (!coordinate || !isSafeNativeVersion(version)) {
    return null;
  }
  switch (host.id) {
    case "npm":
      return `${host.metadata}/${encodeURIComponent(coordinate)}/${encodeURIComponent(version)}`;
    case "crates-io":
      return `${host.metadata}/crates/${encodeURIComponent(coordinate)}/${encodeURIComponent(version)}`;
    case "pypi":
      return `${host.metadata}/${encodeURIComponent(coordinate)}/${encodeURIComponent(version)}/json`;
    case "nuget":
      // The flat-container index is the canonical anonymous proof that this
      // exact normalized version exists. The package bytes have a deterministic
      // URL derived from the same lowercased coordinate/version pair.
      return `${host.metadata}/${encodeURIComponent(coordinate.toLowerCase())}/index.json`;
    default:
      return null;
  }
}

export function nativeTarballUrls(host, name, version, filename) {
  const coordinate = nativeCoordinate(host, name);
  if (!coordinate || !isSafeNativeVersion(version)) {
    return [];
  }
  switch (host.id) {
    case "npm": {
      const baseName = coordinate.split("/").at(-1);
      const expected = `${baseName}-${version}.tgz`;
      if (filename && filename !== expected) {
        return [];
      }
      return [
        `https://registry.npmjs.org/${encodeURIComponent(coordinate)}/-/${encodeURIComponent(expected)}`,
      ];
    }
    case "crates-io": {
      const expected = `${coordinate}-${version}.crate`;
      if (filename && filename !== expected) {
        return [];
      }
      return [
        `https://static.crates.io/crates/${encodeURIComponent(coordinate)}/${encodeURIComponent(expected)}`,
      ];
    }
    case "nuget": {
      const id = coordinate.toLowerCase();
      const normalizedVersion = version.toLowerCase();
      const expected = `${id}.${normalizedVersion}.nupkg`;
      if (filename && filename.toLowerCase() !== expected) {
        return [];
      }
      return [
        `https://api.nuget.org/v3-flatcontainer/${encodeURIComponent(id)}/${encodeURIComponent(normalizedVersion)}/${encodeURIComponent(expected)}`,
      ];
    }
    default:
      return [];
  }
}

export function isAllowedNativeDownloadUrl(host, rawUrl, name, version) {
  const coordinate = nativeCoordinate(host, name);
  if (!host || !coordinate || !isSafeNativeVersion(version)) {
    return false;
  }
  if (!isAllowedNativeHost(host, rawUrl)) {
    return false;
  }

  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (!host.artifactHosts.includes(url.hostname.toLowerCase())) {
    return false;
  }
  if (url.search || url.hash) {
    return false;
  }

  if (host.id === "npm") {
    if (url.hostname !== "registry.npmjs.org") {
      return false;
    }
    const baseName = coordinate.split("/").at(-1);
    let decodedPath;
    try {
      decodedPath = decodeURIComponent(url.pathname);
    } catch {
      return false;
    }
    return decodedPath === `/${coordinate}/-/${baseName}-${version}.tgz`;
  }

  if (host.id === "crates-io") {
    const encodedName = encodeURIComponent(coordinate);
    const encodedVersion = encodeURIComponent(version);
    return (
      (url.hostname === "crates.io" &&
        url.pathname === `/api/v1/crates/${encodedName}/${encodedVersion}/download`) ||
      (url.hostname === "static.crates.io" &&
        url.pathname === `/crates/${encodedName}/${encodedName}-${encodedVersion}.crate`)
    );
  }

  if (host.id === "pypi") {
    if (url.hostname !== "files.pythonhosted.org" || !url.pathname.startsWith("/packages/")) {
      return false;
    }
    const filename = url.pathname.split("/").at(-1) || "";
    return filename.endsWith(".tar.gz") || filename.endsWith(".zip");
  }

  if (host.id === "nuget") {
    if (url.hostname !== "api.nuget.org") {
      return false;
    }
    const id = coordinate.toLowerCase();
    const normalizedVersion = version.toLowerCase();
    const expected = `/v3-flatcontainer/${encodeURIComponent(id)}/${encodeURIComponent(normalizedVersion)}/${encodeURIComponent(id)}.${encodeURIComponent(normalizedVersion)}.nupkg`;
    return url.pathname === expected;
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
  if (host?.id === "npm") {
    return Boolean(body._unpublished || (!body.versions && !body.version && !body.dist));
  }
  if (host?.id === "crates-io") {
    return !body.crate && !body.version && !body.versions;
  }
  if (host?.id === "pypi") {
    return !body.info || (!body.releases && !Array.isArray(body.urls));
  }
  if (host?.id === "nuget") {
    return !Array.isArray(body.versions) || body.versions.length === 0;
  }
  return true;
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
      return Object.entries(body.releases || {})
        .filter(([, files]) => Array.isArray(files) && files.some(isInstallablePypiFile))
        .map(([version]) => version)
        .filter(isSafeNativeVersion)
        .sort(sortVersionsDesc);
    case "nuget":
      return (body.versions || [])
        .filter(isSafeNativeVersion)
        .sort(sortVersionsDesc);
    default:
      return [];
  }
}

export function downloadFromNativeVersion(host, name, version, body) {
  const coordinate = nativeCoordinate(host, name);
  if (!coordinate || !body || typeof body !== "object" || !isSafeNativeVersion(version)) {
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
      // npm's `unpackedSize` is not the tarball Content-Length. Returning it
      // as the artifact size makes otherwise-correct digest verification fail.
      // Leave size unknown so the edge hashes/counts the downloaded bytes.
      size: 0,
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
      // `.crate` files are gzip-compressed tar archives. The Rust wire contract
      // has only `tar.gz` and `zip`; emitting `crate` cannot deserialize.
      format: "tar.gz",
    };
  }

  if (host?.id === "pypi") {
    const files = Array.isArray(body.urls) ? body.urls : body.releases?.[version];
    if (!Array.isArray(files)) {
      return null;
    }
    const file = files
      .filter(isInstallablePypiFile)
      .sort((a, b) => pypiFormatRank(a) - pypiFormatRank(b))[0];
    if (!file?.url || !isAllowedNativeDownloadUrl(host, file.url, name, version)) {
      return null;
    }
    const sha256 = file.digests?.sha256 || file.sha256_digest || "";
    if (!SHA256.test(sha256)) {
      return null;
    }
    const size = Number(file.size);
    return {
      url: file.url,
      sha256,
      size: Number.isSafeInteger(size) && size > 0 ? size : 0,
      format: file.filename?.endsWith(".zip") ? "zip" : "tar.gz",
      published_at: file.upload_time_iso_8601 || file.upload_time || null,
    };
  }

  if (host?.id === "nuget") {
    const normalizedVersion = version.toLowerCase();
    if (!(body.versions || []).some((candidate) => candidate.toLowerCase() === normalizedVersion)) {
      return null;
    }
    const url = nativeTarballUrls(host, name, version)[0];
    if (!url || !isAllowedNativeDownloadUrl(host, url, name, version)) {
      return null;
    }
    return {
      url,
      sha256: "",
      size: 0,
      format: "zip",
    };
  }

  return null;
}

export function toPackageMetadata(host, org, name, body) {
  const versions = versionsFromNativeBody(host, body);
  return {
    org,
    name,
    description: packageDescription(host, body),
    vcs: "git",
    repo_url: publicRepoUrl(host, name, body),
    latest: nativeLatestVersion(host, body, versions),
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
    published_at:
      download.published_at || body.time?.[version] || body.version?.created_at || "1970-01-01T00:00:00Z",
    yanked: Boolean(body.yanked || body.version?.yanked),
    // The Rust wire contract has no native-registry MirrorKind. The canonical
    // native URL is already `download_url`; advertising a made-up mirror kind
    // would make the otherwise-valid VersionMetadata fail deserialization.
    mirrors: [],
    native_host: host.id,
  };
}

function packageDescription(host, body) {
  if (host?.id === "pypi") {
    return body.info?.summary || body.info?.description || null;
  }
  return body.description || body.crate?.description || null;
}

function nativeLatestVersion(host, body, versions) {
  const candidates = [];
  if (host?.id === "npm") {
    candidates.push(body["dist-tags"]?.latest);
  }
  if (host?.id === "crates-io") {
    candidates.push(body.crate?.newest_version, body.crate?.max_version);
  }
  if (host?.id === "pypi") {
    candidates.push(body.info?.version);
  }
  for (const candidate of candidates) {
    if (typeof candidate === "string" && versions.includes(candidate)) {
      return candidate;
    }
  }
  return versions[0] || body.version || null;
}

function publicRepoUrl(host, name, body) {
  const coordinate = nativeCoordinate(host, name) || name;
  const candidates = [
    body.repository?.url,
    body.repository,
    body.crate?.repository,
    body.info?.project_urls?.Source,
    body.info?.project_urls?.Repository,
    body.info?.project_urls?.Homepage,
    body.info?.home_page,
  ];
  for (const candidate of candidates) {
    const safe = safeHttpsUrl(candidate);
    if (safe) {
      return safe;
    }
  }
  if (host.id === "npm") {
    return `https://www.npmjs.com/package/${encodeURIComponent(coordinate)}`;
  }
  if (host.id === "crates-io") {
    return `https://crates.io/crates/${encodeURIComponent(coordinate)}`;
  }
  if (host.id === "pypi") {
    return `https://pypi.org/project/${encodeURIComponent(coordinate)}/`;
  }
  if (host.id === "nuget") {
    return `https://www.nuget.org/packages/${encodeURIComponent(coordinate)}`;
  }
  return null;
}

function safeHttpsUrl(value) {
  if (typeof value !== "string") {
    return null;
  }
  const candidate = value.replace(/^git\+/, "").replace(/\.git$/, "");
  let url;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) {
    return null;
  }
  return url.toString().replace(/\/$/, "");
}

function isInstallablePypiFile(file) {
  if (!file || typeof file !== "object" || file.yanked) {
    return false;
  }
  if (file.packagetype !== "sdist") {
    return false;
  }
  if (typeof file.filename !== "string") {
    return false;
  }
  return file.filename.endsWith(".tar.gz") || file.filename.endsWith(".zip");
}

function pypiFormatRank(file) {
  return file.filename?.endsWith(".tar.gz") ? 0 : 1;
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
  return String(b).localeCompare(String(a), undefined, { numeric: true, sensitivity: "base" });
}

export function statusMeansPrivateOrMissing(status) {
  return status === 401 || status === 403 || status === 404 || status === 451;
}
