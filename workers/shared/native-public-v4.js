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
import {
  isAllowedTerraformModuleArtifact,
  terraformModuleCoordinate,
  terraformModuleDownloadCandidate,
  terraformModuleDownloadUrl,
  terraformModuleVersions,
  terraformModuleVersionsUrl,
} from "./native-terraform-module.js";

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
  terraform: activeRegistry("terraform", "https://registry.terraform.io/v1/modules", [
    "codeload.github.com",
  ]),
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

function terraformNativeCoordinate(host, name) {
  if (host?.id !== "terraform") {
    return null;
  }
  return terraformModuleCoordinate(name);
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
  if (host?.id === "terraform") {
    return Boolean(terraformNativeCoordinate(host, name));
  }
  return v3.isHighLikelihoodPublic(host, name);
}

export function nativePackageMetadataUrl(host, name) {
  if (host?.id === "packagist") {
    const coordinate = packagistNativeCoordinate(host, name);
    return coordinate ? packagistMetadataUrl(coordinate) : null;
  }
  if (host?.id === "terraform") {
    return terraformModuleVersionsUrl(name);
  }
  return v3.nativePackageMetadataUrl(host, name);
}

export function nativeVersionMetadataUrl(host, name, version) {
  if (host?.id === "packagist") {
    const coordinate = packagistNativeCoordinate(host, name);
    return coordinate && safeStableVersion(version) ? packagistMetadataUrl(coordinate) : null;
  }
  if (host?.id === "terraform") {
    return terraformModuleDownloadUrl(name, version);
  }
  return v3.nativeVersionMetadataUrl(host, name, version);
}

export function nativeTarballUrls(host, name, version, filename) {
  if (host?.id === "packagist" || host?.id === "terraform") {
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
  if (host?.id === "terraform") {
    return Boolean(
      terraformNativeCoordinate(host, name) &&
      candidate?.validation?.version === version &&
      isAllowedTerraformModuleArtifact(rawUrl, candidate),
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
  if (host?.id === "terraform") {
    if (body?.__terraform_module_download === true) {
      return typeof body.x_terraform_get !== "string" || body.x_terraform_get.length === 0;
    }
    return terraformModuleVersions(body).length === 0;
  }
  return v3.isPrivateOrUnpublished(host, body);
}

export async function readBoundedJson(response, maxBytes = v3.MAX_NATIVE_METADATA_BYTES) {
  if (response?.status === 204) {
    const getter = response.headers?.get?.("x-terraform-get");
    let url = null;
    try {
      url = new URL(response.url);
    } catch {
      return null;
    }
    if (
      url.protocol !== "https:" ||
      url.hostname !== "registry.terraform.io" ||
      !/^\/v1\/modules\/[^/]+\/[^/]+\/[^/]+\/[^/]+\/download$/.test(url.pathname) ||
      url.search ||
      url.hash ||
      typeof getter !== "string" ||
      getter.length === 0 ||
      getter.length > 2048
    ) {
      return null;
    }
    return {
      __terraform_module_download: true,
      x_terraform_get: getter,
    };
  }
  return v3.readBoundedJson(response, maxBytes);
}

export function versionsFromNativeBody(host, body, name = null) {
  if (host?.id === "packagist") {
    const coordinate = packagistNativeCoordinate(host, name);
    return coordinate ? packagistVersions(body, coordinate) : [];
  }
  if (host?.id === "terraform") {
    return terraformModuleVersions(body);
  }
  return v3.versionsFromNativeBody(host, body, name);
}

export function downloadFromNativeVersion(host, name, version, body) {
  if (host?.id === "packagist") {
    const coordinate = packagistNativeCoordinate(host, name);
    return coordinate ? packagistDownload(body, coordinate, version) : null;
  }
  if (host?.id === "terraform") {
    if (body?.__terraform_module_download !== true) {
      return null;
    }
    const response = new Response(null, {
      status: 204,
      headers: {
        "x-terraform-get": body.x_terraform_get,
      },
    });
    return terraformModuleDownloadCandidate(response, name, version);
  }
  return v3.downloadFromNativeVersion(host, name, version, body);
}

export function toPackageMetadata(host, org, name, body) {
  if (host?.id === "packagist") {
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
  if (host?.id === "terraform") {
    const module = terraformNativeCoordinate(host, name);
    const versions = terraformModuleVersions(body);
    return {
      org,
      name,
      description: null,
      vcs: "git",
      repo_url: module
        ? `https://registry.terraform.io/modules/${module.namespace}/${module.name}/${module.system}`
        : null,
      latest: versions[0] || null,
      tags: [],
      versions,
      native_host: host.id,
    };
  }
  return v3.toPackageMetadata(host, org, name, body);
}

export function toVersionMetadata(host, org, name, version, body, download) {
  return v3.toVersionMetadata(host, org, name, version, body, download);
}
