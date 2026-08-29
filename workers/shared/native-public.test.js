import assert from "node:assert/strict";
import test from "node:test";

import {
  isHighLikelihoodPublic,
  isPrivateOrUnpublished,
  nativePackageMetadataUrl,
  nativeTarballUrls,
  nativeVersionMetadataUrl,
  publicNativeHostFromOrg,
  toPackageMetadata,
  versionsFromNativeBody,
} from "./native-public.js";

test("org tokens match NativeHost::from_token public aliases", () => {
  assert.equal(publicNativeHostFromOrg("npm").id, "npm");
  assert.equal(publicNativeHostFromOrg("npmjs.com").id, "npm");
  assert.equal(publicNativeHostFromOrg("crates-io").id, "crates-io");
  assert.equal(publicNativeHostFromOrg("cargo").id, "crates-io");
  assert.equal(publicNativeHostFromOrg("pypi.org").id, "pypi");
  assert.equal(publicNativeHostFromOrg("rubygems").id, "rubygems");
  assert.equal(publicNativeHostFromOrg("hex.pm").id, "hex");
  assert.equal(publicNativeHostFromOrg("zed-pkg-test"), null);
  assert.equal(publicNativeHostFromOrg("test-pypi"), null);
  assert.equal(publicNativeHostFromOrg("artifactory"), null);
});

test("private-looking names are not high-likelihood public", () => {
  const npm = publicNativeHostFromOrg("npm");
  assert.equal(isHighLikelihoodPublic(npm, "lodash"), true);
  assert.equal(isHighLikelihoodPublic(npm, "private-sdk"), false);
  assert.equal(isHighLikelihoodPublic(npm, "internal-api"), false);
  assert.equal(isHighLikelihoodPublic(npm, "../etc/passwd"), false);
});

test("npm packument marked private is rejected", () => {
  const npm = publicNativeHostFromOrg("npm");
  assert.equal(isPrivateOrUnpublished(npm, { private: true, versions: { "1.0.0": {} } }), true);
  assert.equal(isPrivateOrUnpublished(npm, { unpublished: { time: "2020-01-01" } }), true);
  assert.equal(
    isPrivateOrUnpublished(npm, { name: "lodash", versions: { "4.17.21": { dist: { tarball: "https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz" } } } }),
    false,
  );
});

test("public metadata and tarball URLs are unauthenticated", () => {
  const npm = publicNativeHostFromOrg("npm");
  assert.equal(nativePackageMetadataUrl(npm, "lodash"), "https://registry.npmjs.org/lodash");
  assert.equal(
    nativeVersionMetadataUrl(npm, "lodash", "4.17.21"),
    "https://registry.npmjs.org/lodash/4.17.21",
  );
  assert.deepEqual(nativeTarballUrls(npm, "lodash", "4.17.21", "lodash-4.17.21.tgz"), [
    "https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz",
  ]);

  const crates = publicNativeHostFromOrg("crates-io");
  assert.equal(
    nativePackageMetadataUrl(crates, "serde"),
    "https://crates.io/api/v1/crates/serde",
  );
  assert.deepEqual(nativeTarballUrls(crates, "serde", "1.0.0"), [
    "https://static.crates.io/crates/serde/serde-1.0.0.crate",
  ]);

  const pypi = publicNativeHostFromOrg("pypi");
  assert.equal(nativePackageMetadataUrl(pypi, "requests"), "https://pypi.org/pypi/requests/json");
});

test("native package metadata maps versions newest-first", () => {
  const npm = publicNativeHostFromOrg("npm");
  const meta = toPackageMetadata(npm, "npm", "left-pad", {
    description: "pad",
    versions: { "1.0.0": {}, "1.3.0": {} },
  });
  assert.equal(meta.native_host, "npm");
  assert.deepEqual(versionsFromNativeBody(npm, { versions: { "1.0.0": {}, "1.3.0": {} } }), [
    "1.3.0",
    "1.0.0",
  ]);
  assert.equal(meta.latest, "1.3.0");
});
