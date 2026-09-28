import {
  NATIVE_REGISTRIES,
  decodeAndValidateNativeCoordinate,
} from "./native-registry-catalog.js";

const TERRAFORM_MODULE_BASE = "https://registry.terraform.io/v1/modules";
const COMPONENT = /^[A-Za-z0-9][A-Za-z0-9._+@-]{0,191}$/;
const VERSION = /^[0-9][0-9A-Za-z.!_+~-]{0,127}$/;
const GITHUB_COMPONENT = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$/;
const GIT_REF = /^[0-9A-Za-z][0-9A-Za-z._+~/-]{0,191}$/;

export function terraformModuleCoordinate(encodedOrLegacy) {
  const coordinate = decodeAndValidateNativeCoordinate(
    NATIVE_REGISTRIES.terraform,
    encodedOrLegacy,
  );
  if (!coordinate) {
    return null;
  }
  const parts = coordinate.split("/");
  if (parts.length !== 3 || !parts.every((part) => COMPONENT.test(part))) {
    return null;
  }
  return Object.freeze({
    coordinate,
    namespace: parts[0],
    name: parts[1],
    system: parts[2],
  });
}

export function terraformModuleVersionsUrl(encodedOrLegacy) {
  const module = terraformModuleCoordinate(encodedOrLegacy);
  if (!module) {
    return null;
  }
  return `${TERRAFORM_MODULE_BASE}/${encodeURIComponent(module.namespace)}/${encodeURIComponent(module.name)}/${encodeURIComponent(module.system)}/versions`;
}

export function terraformModuleDownloadUrl(encodedOrLegacy, version) {
  const module = terraformModuleCoordinate(encodedOrLegacy);
  if (!module || !isSafeTerraformVersion(version)) {
    return null;
  }
  return `${TERRAFORM_MODULE_BASE}/${encodeURIComponent(module.namespace)}/${encodeURIComponent(module.name)}/${encodeURIComponent(module.system)}/${encodeURIComponent(version)}/download`;
}

export function terraformModuleVersions(body) {
  if (!body || typeof body !== "object" || !Array.isArray(body.modules)) {
    return [];
  }
  const first = body.modules[0];
  if (!first || !Array.isArray(first.versions)) {
    return [];
  }
  return [...new Set(
    first.versions
      .map((row) => row?.version)
      .filter(isSafeTerraformVersion),
  )].sort(sortVersionsDesc);
}

/**
 * Parse the public registry's module download response without interpreting
 * arbitrary go-getter syntax.
 *
 * The Terraform protocol permits many source forms and relative URLs. The
 * degraded Zed adapter deliberately accepts only the documented GitHub API
 * tarball form for now, rewrites it to an immutable codeload endpoint, and
 * rejects everything else until a source-specific adapter exists.
 */
export function terraformModuleDownloadCandidate(response, encodedOrLegacy, version) {
  const module = terraformModuleCoordinate(encodedOrLegacy);
  if (!module || !isSafeTerraformVersion(version) || response?.status !== 204) {
    return null;
  }
  const raw = response.headers?.get?.("x-terraform-get");
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2048) {
    return null;
  }
  const parsed = parseDocumentedGithubGetter(raw);
  if (!parsed) {
    return null;
  }
  return {
    url: `https://codeload.github.com/${parsed.owner}/${parsed.repo}/tar.gz/${encodeURIComponent(parsed.reference)}`,
    sha256: "",
    size: 0,
    format: "tar.gz",
    validation: {
      kind: "terraform-module-github-tarball",
      owner: parsed.owner,
      repo: parsed.repo,
      reference: parsed.reference,
      module: module.coordinate,
      version,
    },
  };
}

export function isAllowedTerraformModuleArtifact(rawUrl, candidate) {
  const validation = candidate?.validation;
  if (
    validation?.kind !== "terraform-module-github-tarball" ||
    !GITHUB_COMPONENT.test(validation.owner || "") ||
    !GITHUB_COMPONENT.test(validation.repo || "") ||
    !isSafeGitRef(validation.reference)
  ) {
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
    url.hostname !== "codeload.github.com" ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash
  ) {
    return false;
  }
  return url.pathname ===
    `/${validation.owner}/${validation.repo}/tar.gz/${encodeURIComponent(validation.reference)}`;
}

function parseDocumentedGithubGetter(raw) {
  if (
    raw.startsWith("/") ||
    raw.startsWith("./") ||
    raw.startsWith("../") ||
    raw.includes("::") ||
    raw.includes("#")
  ) {
    return null;
  }

  const marker = "//*?archive=tar.gz";
  if (!raw.endsWith(marker)) {
    return null;
  }
  const ordinaryUrl = raw.slice(0, -marker.length);
  let url;
  try {
    url = new URL(ordinaryUrl);
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "api.github.com" ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash
  ) {
    return null;
  }
  const match = url.pathname.match(
    /^\/repos\/([^/]+)\/([^/]+)\/tarball\/([^/]+)$/,
  );
  if (!match) {
    return null;
  }
  let owner;
  let repo;
  let reference;
  try {
    owner = decodeURIComponent(match[1]);
    repo = decodeURIComponent(match[2]);
    reference = decodeURIComponent(match[3]);
  } catch {
    return null;
  }
  if (
    !GITHUB_COMPONENT.test(owner) ||
    !GITHUB_COMPONENT.test(repo) ||
    !isSafeGitRef(reference)
  ) {
    return null;
  }
  return { owner, repo, reference };
}

function isSafeTerraformVersion(value) {
  return (
    typeof value === "string" &&
    VERSION.test(value) &&
    !value.includes("..") &&
    !value.includes("/") &&
    !value.includes("\\")
  );
}

function isSafeGitRef(value) {
  return (
    typeof value === "string" &&
    GIT_REF.test(value) &&
    !value.includes("..") &&
    !value.includes("\\") &&
    !value.startsWith("/") &&
    !value.endsWith("/")
  );
}

function sortVersionsDesc(a, b) {
  return String(b).localeCompare(String(a), undefined, {
    numeric: true,
    sensitivity: "base",
  });
}
