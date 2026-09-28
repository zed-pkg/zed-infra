export * from "./native-public-v3.js";

import * as v3 from "./native-public-v3.js";
import {
  NATIVE_REGISTRIES,
  decodeAndValidateNativeCoordinate,
  nativeRegistryFromOrg,
} from "./native-registry-catalog.js";
import {
  PACKAGIST_METADATA_BASE,
  isAllowedPackagistDownloadUrl,
  packagistCoordinate,
  packagistDescription,
  packagistDownload,
  packagistLatest,
  packagistMetadataUrl,
  packagistRepoUrl,
  packagistVersions,
} from "./native-packagist.js";

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
  packagist: activeRegistry("packagist", PACKAGIST_METADATA_BASE, ["codeload.github.com"]),
});

export const PUBLIC_NATIVE_HOSTS = Object.freeze({
  ...v3.PUBLIC_NATIVE_HOSTS,
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

function packagistNativeCoordinate(host, name) {
  if (host?.id !== "packagist") {
    return null;
  }
  return decodeAndValidateNativeCoordinate(host, name);
}

function safeStableVersion(version) {
  return (
    typeof version === "string" &&
    /^[0-9A-Za-z][0-9A-Za-z.!_+~-]{0,127}$/.test(version) &&
    !version.includes("..") &&
    !version.includes("/") &&
    !version.includes("\\") &&
    !/^dev-/i.test(version) &&
    !/-dev$/i.test(version)
  );
}

export function isHighLikelihoodPublic(host, name) {
  if (host?.id === "packagist") {
    const coordinate = packagistNativeCoordinate(host, name);
    return Boolean(coordinate && packagistCoordinate(coordinate));
  }
  return v3.isHighLikelihoodPublic(host, name);
}

export function nativePackageMetadataUrl(host, name) {
  if (host?.id === "packagist") {
    const coordinate = packagistNativeCoordinate(host, name);
    return coordinate ? packagistMetadataUrl(coordinate) : null;
  }
  return v3.nativePackageMetadataUrl(host, name);
}

export function nativeVersionMetadataUrl(host, name, version) {
  if (host?.id === "packagist") {
    const coordinate = packagistNativeCoordinate(host, name);
    return coordinate && safeStableVersion(version) ? packagistMetadataUrl(coordinate) : null;
  }
  return v3.nativeVersionMetadataUrl(host, name, version);
}

export function nativeTarballUrls(host, name, version, filename) {
  if (host?.id === "packagist") {
    return [];
  }
  return v3.nativeTarballUrls(host, name, version, filename);
}

export function isAllowedNativeDownloadUrl(host, rawUrl, name, version, candidate = null) {
  if (host?.id === "packagist") {
    const coordinate = packagistNativeCoordinate(host, name);
    return Boolean(
      coordinate &&
      safeStableVersion(version) &&
      candidate &&
      isAllowedPackagistDownloadUrl(rawUrl, candidate),
    );
  }
  return v3.isAllowedNativeDownloadUrl(host, rawUrl, name, version, candidate);
}

export function isPrivateOrUnpublished(host, body) {
  if (host?.id === "packagist") {
    return !(
      body &&
      typeof body === "object" &&
      body.packages &&
      typeof body.packages === "object" &&
      !Array.isArray(body.packages) &&
      (body.minified === undefined || body.minified === "composer/2.0")
    );
  }
  return v3.isPrivateOrUnpublished(host, body);
}

export async function readBoundedJson(response, maxBytes = v3.MAX_NATIVE_METADATA_BYTES) {
  return v3.readBoundedJson(response, maxBytes);
}

export function versionsFromNativeBody(host, body, name = null) {
  if (host?.id === "packagist") {
    const coordinate = packagistNativeCoordinate(host, name);
    return coordinate ? packagistVersions(body, coordinate) : [];
  }
  return v3.versionsFromNativeBody(host, body, name);
}

export function downloadFromNativeVersion(host, name, version, body) {
  if (host?.id === "packagist") {
    const coordinate = packagistNativeCoordinate(host, name);
    return coordinate ? packagistDownload(body, coordinate, version) : null;
  }
  return v3.downloadFromNativeVersion(host, name, version, body);
}

export function toPackageMetadata(host, org, name, body) {
  if (host?.id !== "packagist") {
    return v3.toPackageMetadata(host, org, name, body);
  }
  const coordinate = packagistNativeCoordinate(host, name);
  if (!coordinate) {
    return v3.toPackageMetadata(host, org, name, body);
  }
  const versions = packagistVersions(body, coordinate);
  return {
    org,
    name,
    description: packagistDescription(body, coordinate),
    vcs: "git",
    repo_url: packagistRepoUrl(body, coordinate),
    latest: packagistLatest(body, coordinate, versions),
    tags: [],
    versions,
    native_host: host.id,
  };
}

export function toVersionMetadata(host, org, name, version, body, download) {
  return v3.toVersionMetadata(host, org, name, version, body, download);
}
