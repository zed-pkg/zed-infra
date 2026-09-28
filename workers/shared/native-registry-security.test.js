import assert from "node:assert/strict";
import test from "node:test";

import {
  NATIVE_REGISTRIES,
  decodeAndValidateNativeCoordinate,
  decodeNativeCoordinate,
  encodeNativeCoordinate,
  isAllowedNativeHost,
  nativeRegistryFromOrg,
  normalizeEcosystem,
} from "./native-registry-catalog.js";
import {
  publicNativeFallbackIds,
  publicNativeHostFromOrg,
} from "./native-public.js";

const REQUIRED_REGISTRIES = [
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
];

const ACTIVE_REGISTRIES = [
  "clojars",
  "cpan",
  "cran",
  "crates-io",
  "go-proxy",
  "hackage",
  "jsr",
  "maven",
  "npm",
  "nuget",
  "pypi",
];

const INACTIVE_REGISTRIES = [
  "packagist",
  "rubygems",
  "hex",
  "conan",
  "luarocks",
  "opam",
  "julia",
  "conda-forge",
  "cocoapods",
  "terraform",
  "docker",
];

test("the complete requested registry catalog is present exactly once", () => {
  assert.deepEqual(Object.keys(NATIVE_REGISTRIES).sort(), [...REQUIRED_REGISTRIES].sort());

  const normalizedOwners = new Map();
  for (const [id, entry] of Object.entries(NATIVE_REGISTRIES)) {
    assert.equal(entry.id, id);
    assert.ok(entry.aliases.length > 0, id);
    assert.ok(entry.hosts.length > 0, id);

    for (const alias of entry.aliases) {
      const normalized = normalizeEcosystem(alias);
      if (!normalized) {
        continue;
      }
      const existing = normalizedOwners.get(normalized);
      assert.ok(!existing || existing === id, `${normalized}: ${existing} conflicts with ${id}`);
      normalizedOwners.set(normalized, id);
      assert.equal(nativeRegistryFromOrg(alias)?.id, id, alias);
    }
  }
});

test("aliases fail closed instead of collapsing invalid input to a registry", () => {
  for (const token of ["", " ", "..", "../../npm", "https://npm", "c++", "a/b", "@npm"]) {
    assert.equal(nativeRegistryFromOrg(token), null, token);
  }

  assert.equal(nativeRegistryFromOrg("npmjs.com")?.id, "npm");
  assert.equal(nativeRegistryFromOrg("proxy.golang.org")?.id, "go-proxy");
  assert.equal(nativeRegistryFromOrg("dockerhub")?.id, "docker");
});

test("catalog host rules are exact HTTPS origins, never suffix or wildcard matches", () => {
  for (const [id, entry] of Object.entries(NATIVE_REGISTRIES)) {
    for (const host of entry.hosts) {
      assert.equal(host, host.toLowerCase(), `${id}: host must be lowercase`);
      assert.equal(host.includes("*"), false, `${id}: wildcard host forbidden`);
      assert.equal(host.includes("/"), false, `${id}: host must not contain a path`);
      assert.equal(isAllowedNativeHost(entry, `https://${host}/artifact`), true, `${id}:${host}`);
      assert.equal(isAllowedNativeHost(entry, `http://${host}/artifact`), false, `${id}: http`);
      assert.equal(
        isAllowedNativeHost(entry, `https://user:pass@${host}/artifact`),
        false,
        `${id}: userinfo`,
      );
      assert.equal(isAllowedNativeHost(entry, `https://${host}:444/artifact`), false, `${id}: port`);
      assert.equal(
        isAllowedNativeHost(entry, `https://evil-${host}/artifact`),
        false,
        `${id}: prefix confusion`,
      );
      assert.equal(
        isAllowedNativeHost(entry, `https://${host}.evil.test/artifact`),
        false,
        `${id}: suffix confusion`,
      );
    }
  }
});

test("multi-part coordinates round-trip without becoming path syntax", () => {
  const cases = [
    ["npm", "@scope/package"],
    ["maven", "org.example:artifact"],
    ["clojars", "org.clojars.example:artifact"],
    ["packagist", "vendor/package"],
    ["go-proxy", "github.com/owner/module/v2"],
    ["terraform", "hashicorp/aws/provider"],
    ["docker", "library/postgres"],
  ];

  for (const [registryId, coordinate] of cases) {
    const entry = NATIVE_REGISTRIES[registryId];
    const encoded = encodeNativeCoordinate(coordinate);
    assert.ok(encoded?.startsWith("z1_"), `${registryId}: encoded`);
    assert.equal(encoded.includes("/"), false, `${registryId}: encoded path separator`);
    assert.equal(decodeNativeCoordinate(encoded), coordinate, `${registryId}: raw round-trip`);
    assert.equal(
      decodeAndValidateNativeCoordinate(entry, encoded),
      coordinate,
      `${registryId}: validated round-trip`,
    );
  }
});

test("coordinate decoder rejects traversal, malformed UTF-8 and oversized payloads", () => {
  const npm = NATIVE_REGISTRIES.npm;
  for (const coordinate of ["../pkg", "pkg/../other", "pkg\\other", "pkg\nother", "pkg\rother"]) {
    const encoded = encodeNativeCoordinate(coordinate);
    assert.equal(decodeAndValidateNativeCoordinate(npm, encoded), null, coordinate);
  }

  assert.equal(decodeNativeCoordinate("z1_%%%"), null);
  assert.equal(encodeNativeCoordinate("x".repeat(1025)), null);
  assert.equal(decodeAndValidateNativeCoordinate(npm, "z1_" + "A".repeat(2049)), null);
});

test("only protocol-audited registries are activated as network fallbacks", () => {
  assert.deepEqual(publicNativeFallbackIds().sort(), ACTIVE_REGISTRIES);

  for (const id of INACTIVE_REGISTRIES) {
    assert.equal(
      publicNativeHostFromOrg(id),
      null,
      `${id} must remain fail-closed until its protocol adapter is audited`,
    );
  }
});

test("active registries resolve only through their catalog identities", () => {
  for (const id of ACTIVE_REGISTRIES) {
    assert.equal(publicNativeHostFromOrg(id)?.id, id, id);
  }

  assert.equal(publicNativeHostFromOrg("maven-central")?.id, "maven");
  assert.equal(publicNativeHostFromOrg("clojure")?.id, "clojars");
  assert.equal(publicNativeHostFromOrg("golang")?.id, "go-proxy");
  assert.equal(publicNativeHostFromOrg("cabal")?.id, "hackage");
  assert.equal(publicNativeHostFromOrg("deno")?.id, "jsr");
});

test("registries with generic GitHub/CDN hosts cannot become accidental generic proxies", () => {
  for (const id of ["packagist", "julia", "cocoapods", "terraform", "docker"]) {
    const entry = NATIVE_REGISTRIES[id];
    assert.ok(entry, id);
    assert.equal(publicNativeHostFromOrg(id), null, id);
  }
});
