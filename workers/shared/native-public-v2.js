export * from "./native-public-core.js";

import * as core from "./native-public-core.js";
import {
  NATIVE_REGISTRIES,
  decodeAndValidateNativeCoordinate,
  nativeRegistryFromOrg,
} from "./native-registry-catalog.js";
import {
  CPAN_METADATA_BASE,
  CRAN_METADATA_BASE,
  cpanDownload,
  cpanMetadataUrl,
  cpanVersions,
  cranDownload,
  cranMetadataUrl,
  cranVersions,
  isCranDescriptionResponse,
  parseCranDescription,
  stagedPackageDescription,
  stagedRepoUrl,
} from "./native-cpan-cran.js";

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

const EXTRA_NATIVE_HOSTS = Object.freeze({
  cpan: activeRegistry("cpan", CPAN_METADATA_BASE, ["cpan.metacpan.org"]),
  cran: activeRegistry("cran", CRAN_METADATA_BASE, ["cran.r-project.org"]),
});

export const PUBLIC_NATIVE_HOSTS = Object.freeze({
  ...core.PUBLIC_NATIVE_HOSTS,
  ...EXTRA_NATIVE_HOSTS,
});

export function publicNativeFallbackIds() {
  return Object.keys(PUBLIC_NATIVE_HOSTS);
}

export function publicNativeHostFromOrg(org) {
  const catalog = nativeRegistryFromOrg(org);
  if (!catalog) {
    return null;
  }
  return PUBLIC_NATIVE_HOSTS[catalog.id] || null;
}

function extraCoordinate(host, name) {
  if (!host || !Object.prototype.hasOwnProperty.call(EXTRA_NATIVE_HOSTS, host.id)) {
    return null;
  }
  return decodeAndValidateNativeCoordinate(host, name);
}

function isSafeVersion(version) {
  return (
    typeof version === "string" &&
    /^[0-9A-Za-z][0-9A-Za-z.!_+~-]{0,127}$/.test(version) &&
    !version.includes("..") &&
    !version.includes("/") &&
    !version.includes("\\")
  );
}

export function isHighLikelihoodPublic(host, name) {
  if (host?.id === "cpan" || host?.id === "cran") {
    return Boolean(extraCoordinate(host, name));
  }
  return core.isHighLikelihoodPublic(host, name);
}

export function nativePackageMetadataUrl(host, name) {
  const coordinate = extraCoordinate(host, name);
  if (host?.id === "cpan") {
    return coordinate ? cpanMetadataUrl(coordinate) : null;
  }
  if (host?.id === "cran") {
    return coordinate ? cranMetadataUrl(coordinate) : null;
  }
  return core.nativePackageMetadataUrl(host, name);
}

export function nativeVersionMetadataUrl(host, name, version) {
  const coordinate = extraCoordinate(host, name);
  if (host?.id === "cpan") {
    return coordinate && isSafeVersion(version) ? cpanMetadataUrl(coordinate, version) : null;
  }
  if (host?.id === "cran") {
    return coordinate && isSafeVersion(version) ? cranMetadataUrl(coordinate) : null;
  }
  return core.nativeVersionMetadataUrl(host, name, version);
}

export function nativeTarballUrls(host, name, version, filename) {
  const coordinate = extraCoordinate(host, name);
  if (host?.id === "cpan") {
    return [];
  }
  if (host?.id === "cran") {
    if (!coordinate || !isSafeVersion(version)) {
      return [];
    }
    const candidate = cranDownload(
      { Package: coordinate, Version: version },
      coordinate,
      version,
    );
    if (!candidate) {
      return [];
    }
    const expected = `${coordinate}_${version}.tar.gz`;
    if (filename && filename !== expected) {
      return [];
    }
    return [candidate.url];
  }
  return core.nativeTarballUrls(host, name, version, filename);
}

export function isAllowedNativeDownloadUrl(host, rawUrl, name, version) {
  const coordinate = extraCoordinate(host, name);
  if (host?.id === "cpan") {
    if (!coordinate || !isSafeVersion(version)) {
      return false;
    }
    let url;
    try {
      url = new URL(rawUrl);
    } catch {
      return false;
    }
    if (
      url.protocol !== "https:" ||
      url.hostname !== "cpan.metacpan.org" ||
      url.username ||
      url.password ||
      url.port ||
      url.search ||
      url.hash ||
      !url.pathname.startsWith("/authors/id/")
    ) {
      return false;
    }
    let filename;
    try {
      filename = decodeURIComponent(url.pathname).split("/").at(-1) || null;
    } catch {
      return false;
    }
    return filename === `${coordinate}-${version}.tar.gz`;
  }
  if (host?.id === "cran") {
    if (!coordinate || !isSafeVersion(version)) {
      return false;
    }
    const candidate = cranDownload(
      { Package: coordinate, Version: version },
      coordinate,
      version,
    );
    return Boolean(candidate && candidate.url === rawUrl);
  }
  return core.isAllowedNativeDownloadUrl(host, rawUrl, name, version);
}

export function isPrivateOrUnpublished(host, body) {
  if (host?.id === "cpan") {
    return !(
      body &&
      typeof body === "object" &&
      cpanVersions(body).length === 1 &&
      typeof body.release === "string" &&
      typeof body.download_url === "string" &&
      /^[a-f0-9]{64}$/.test(body.checksum_sha256 || "")
    );
  }
  if (host?.id === "cran") {
    return !(
      body &&
      typeof body === "object" &&
      cranVersions(body).length === 1 &&
      typeof body.Package === "string"
    );
  }
  return core.isPrivateOrUnpublished(host, body);
}

export async function readBoundedJson(response, maxBytes = core.MAX_NATIVE_METADATA_BYTES) {
  const contentType = response.headers.get("content-type") || "";
  if (!isCranDescriptionResponse(response, contentType)) {
    return core.readBoundedJson(response, maxBytes);
  }

  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > maxBytes) {
    return null;
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maxBytes) {
    return null;
  }
  return parseCranDescription(new TextDecoder().decode(bytes));
}

export function versionsFromNativeBody(host, body, name = null) {
  if (host?.id === "cpan") {
    return cpanVersions(body);
  }
  if (host?.id === "cran") {
    return cranVersions(body);
  }
  return core.versionsFromNativeBody(host, body, name);
}

export function downloadFromNativeVersion(host, name, version, body) {
  const coordinate = extraCoordinate(host, name);
  if (host?.id === "cpan") {
    return coordinate ? cpanDownload(body, coordinate, version) : null;
  }
  if (host?.id === "cran") {
    return coordinate ? cranDownload(body, coordinate, version) : null;
  }
  return core.downloadFromNativeVersion(host, name, version, body);
}

export function toPackageMetadata(host, org, name, body) {
  if (host?.id !== "cpan" && host?.id !== "cran") {
    return core.toPackageMetadata(host, org, name, body);
  }
  const coordinate = extraCoordinate(host, name);
  const versions = versionsFromNativeBody(host, body, name);
  return {
    org,
    name,
    description: stagedPackageDescription(host.id, body),
    vcs: "git",
    repo_url: coordinate ? stagedRepoUrl(host.id, coordinate) : null,
    latest: versions[0] || null,
    tags: [],
    versions,
    native_host: host.id,
  };
}

export function toVersionMetadata(host, org, name, version, body, download) {
  return core.toVersionMetadata(host, org, name, version, body, download);
}
