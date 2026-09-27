import assert from "node:assert/strict";
import test from "node:test";

import {
  NATIVE_REGISTRIES,
  decodeAndValidateNativeCoordinate,
  decodeNativeCoordinate,
  encodeNativeCoordinate,
  isAllowedNativeHost,
  isValidNativeCoordinate,
  nativeRegistryFromOrg,
} from "./native-registry-catalog.js";

test("catalog includes all required public fallback ecosystems", () => {
  for (const id of [
    "npm",
    "crates-io",
    "pypi",
    "maven",
    "nuget",
    "packagist",
    "rubygems",
    "go-proxy",
    "hex",
    "conan",
    "hackage",
    "clojars",
    "cpan",
    "luarocks",
    "opam",
    "julia",
    "cran",
    "conda-forge",
    "cocoapods",
    "jsr",
    "terraform",
    "docker",
  ]) {
    assert.ok(NATIVE_REGISTRIES[id], id);
  }
});

test("common package manager aliases resolve to canonical registries", () => {
  assert.equal(nativeRegistryFromOrg("pip").id, "pypi");
  assert.equal(nativeRegistryFromOrg("uv").id, "pypi");
  assert.equal(nativeRegistryFromOrg("cargo").id, "crates-io");
  assert.equal(nativeRegistryFromOrg("gradle").id, "maven");
  assert.equal(nativeRegistryFromOrg("composer").id, "packagist");
  assert.equal(nativeRegistryFromOrg("bundler").id, "rubygems");
  assert.equal(nativeRegistryFromOrg("golang").id, "go-proxy");
  assert.equal(nativeRegistryFromOrg("elixir").id, "hex");
  assert.equal(nativeRegistryFromOrg("mamba").id, "conda-forge");
  assert.equal(nativeRegistryFromOrg("tofu").id, "terraform");
  assert.equal(nativeRegistryFromOrg("dockerhub").id, "docker");
});

test("native coordinate codec round-trips multi-part package identifiers", () => {
  for (const coordinate of [
    "@scope/package",
    "org.example:artifact",
    "vendor/package",
    "github.com/owner/module/v2",
    "hashicorp/aws",
    "hashicorp/aws/provider",
    "library/postgres",
  ]) {
    const encoded = encodeNativeCoordinate(coordinate);
    assert.match(encoded, /^z1_[A-Za-z0-9_-]+$/);
    assert.equal(decodeNativeCoordinate(encoded), coordinate);
  }
});

test("coordinate validation is ecosystem-specific", () => {
  assert.equal(isValidNativeCoordinate(nativeRegistryFromOrg("npm"), "@scope/pkg"), true);
  assert.equal(isValidNativeCoordinate(nativeRegistryFromOrg("npm"), "scope/pkg"), false);
  assert.equal(isValidNativeCoordinate(nativeRegistryFromOrg("maven"), "org.example:artifact"), true);
  assert.equal(isValidNativeCoordinate(nativeRegistryFromOrg("maven"), "org/example/artifact"), false);
  assert.equal(isValidNativeCoordinate(nativeRegistryFromOrg("composer"), "vendor/package"), true);
  assert.equal(isValidNativeCoordinate(nativeRegistryFromOrg("go"), "github.com/owner/module/v2"), true);
  assert.equal(isValidNativeCoordinate(nativeRegistryFromOrg("terraform"), "hashicorp/aws"), true);
  assert.equal(isValidNativeCoordinate(nativeRegistryFromOrg("docker"), "library/postgres"), true);
  assert.equal(isValidNativeCoordinate(nativeRegistryFromOrg("docker"), "../root"), false);
});

test("encoded and legacy coordinates both fail closed", () => {
  const go = nativeRegistryFromOrg("go");
  const encoded = encodeNativeCoordinate("github.com/owner/module/v2");
  assert.equal(decodeAndValidateNativeCoordinate(go, encoded), "github.com/owner/module/v2");
  assert.equal(decodeAndValidateNativeCoordinate(go, "../etc/passwd"), null);
  assert.equal(decodeAndValidateNativeCoordinate(go, "z1_bad***"), null);
});

test("redirect targets are constrained to each registry allowlist", () => {
  const pypi = nativeRegistryFromOrg("pypi");
  assert.equal(isAllowedNativeHost(pypi, "https://pypi.org/pypi/requests/json"), true);
  assert.equal(isAllowedNativeHost(pypi, "https://files.pythonhosted.org/packages/x/y.whl"), true);
  assert.equal(isAllowedNativeHost(pypi, "http://pypi.org/pypi/requests/json"), false);
  assert.equal(isAllowedNativeHost(pypi, "https://evil.example/payload.whl"), false);
  assert.equal(isAllowedNativeHost(pypi, "https://u:p@pypi.org/pypi/requests/json"), false);

  const docker = nativeRegistryFromOrg("docker");
  assert.equal(isAllowedNativeHost(docker, "https://registry-1.docker.io/v2/library/postgres/manifests/latest"), true);
  assert.equal(isAllowedNativeHost(docker, "https://registry.example.com/v2/x/manifests/latest"), false);
});
