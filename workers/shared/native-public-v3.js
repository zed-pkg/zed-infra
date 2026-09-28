export * from "./native-public-v2.js";

import * as v2 from "./native-public-v2.js";
import {
  NATIVE_REGISTRIES,
  decodeAndValidateNativeCoordinate,
  nativeRegistryFromOrg,
} from "./native-registry-catalog.js";
import {
  CLOJARS_METADATA_BASE,
  clojarsCoordinate,
  clojarsDescription,
  clojarsDownload,
  clojarsLatest,
  clojarsMetadataUrl,
  clojarsRepoUrl,
  clojarsVersions,
  isAllowedClojarsDownloadUrl,
} from "./native-clojars.js";

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
  clojars: activeRegistry("clojars", CLOJARS_METADATA_BASE, ["repo.clojars.org"]),
});

export const PUBLIC_NATIVE_HOSTS = Object.freeze({
  ...v2.PUBLIC_NATIVE_HOSTS,
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

function clojarsNativeCoordinate(host, name) {
  if (host?.id !== "clojars") {
    return null;
  }
  return decodeAndValidateNativeCoordinate(host, name);
}

function safeVersion(version) {
  return (
    typeof version === "string" &&
    /^[0-9A-Za-z][0-9A-Za-z.!_+~-]{0,127}$/.test(version) &&
    !version.includes("..") &&
    !version.includes("/") &&
    !version.includes("\\") &&
    !/-SNAPSHOT$/i.test(version)
  );
}

export function isHighLikelihoodPublic(host, name) {
  if (host?.id === "clojars") {
    const coordinate = clojarsNativeCoordinate(host, name);
    return Boolean(coordinate && clojarsCoordinate(coordinate));
  }
  return v2.isHighLikelihoodPublic(host, name);
}

export function nativePackageMetadataUrl(host, name) {
  if (host?.id === "clojars") {
    const coordinate = clojarsNativeCoordinate(host, name);
    return coordinate ? clojarsMetadataUrl(coordinate) : null;
  }
  return v2.nativePackageMetadataUrl(host, name);
}

export function nativeVersionMetadataUrl(host, name, version) {
  if (host?.id === "clojars") {
    const coordinate = clojarsNativeCoordinate(host, name);
    return coordinate && safeVersion(version) ? clojarsMetadataUrl(coordinate) : null;
  }
  return v2.nativeVersionMetadataUrl(host, name, version);
}

export function nativeTarballUrls(host, name, version, filename) {
  if (host?.id === "clojars") {
    const coordinate = clojarsNativeCoordinate(host, name);
    const parts = coordinate ? clojarsCoordinate(coordinate) : null;
    if (!parts || !safeVersion(version)) {
      return [];
    }
    const expected = `${parts[1]}-${version}.jar`;
    if (filename && filename !== expected) {
      return [];
    }
    const download = clojarsDownload(
      {
        group_name: parts[0],
        jar_name: parts[1],
        recent_versions: [{ version }],
      },
      coordinate,
      version,
    );
    return download ? [download.url] : [];
  }
  return v2.nativeTarballUrls(host, name, version, filename);
}

export function isAllowedNativeDownloadUrl(host, rawUrl, name, version) {
  if (host?.id === "clojars") {
    const coordinate = clojarsNativeCoordinate(host, name);
    return Boolean(
      coordinate &&
      safeVersion(version) &&
      isAllowedClojarsDownloadUrl(rawUrl, coordinate, version),
    );
  }
  return v2.isAllowedNativeDownloadUrl(host, rawUrl, name, version);
}

export function isPrivateOrUnpublished(host, body) {
  if (host?.id === "clojars") {
    return !(
      body &&
      typeof body === "object" &&
      typeof body.group_name === "string" &&
      typeof body.jar_name === "string" &&
      Array.isArray(body.recent_versions) &&
      body.recent_versions.some((row) => safeVersion(row?.version))
    );
  }
  return v2.isPrivateOrUnpublished(host, body);
}

export async function readBoundedJson(response, maxBytes = v2.MAX_NATIVE_METADATA_BYTES) {
  return v2.readBoundedJson(response, maxBytes);
}

export function versionsFromNativeBody(host, body, name = null) {
  if (host?.id === "clojars") {
    const coordinate = clojarsNativeCoordinate(host, name);
    return coordinate ? clojarsVersions(body, coordinate) : [];
  }
  return v2.versionsFromNativeBody(host, body, name);
}

export function downloadFromNativeVersion(host, name, version, body) {
  if (host?.id === "clojars") {
    const coordinate = clojarsNativeCoordinate(host, name);
    return coordinate ? clojarsDownload(body, coordinate, version) : null;
  }
  return v2.downloadFromNativeVersion(host, name, version, body);
}

export function toPackageMetadata(host, org, name, body) {
  if (host?.id !== "clojars") {
    return v2.toPackageMetadata(host, org, name, body);
  }
  const coordinate = clojarsNativeCoordinate(host, name);
  if (!coordinate) {
    return v2.toPackageMetadata(host, org, name, body);
  }
  const versions = clojarsVersions(body, coordinate);
  return {
    org,
    name,
    description: clojarsDescription(body),
    vcs: "git",
    repo_url: clojarsRepoUrl(body, coordinate),
    latest: clojarsLatest(body, coordinate, versions),
    tags: [],
    versions,
    native_host: host.id,
  };
}

export function toVersionMetadata(host, org, name, version, body, download) {
  return v2.toVersionMetadata(host, org, name, version, body, download);
}
