import assert from "node:assert/strict";
import test from "node:test";

import { encodeNativeCoordinate } from "./native-registry-catalog.js";
import {
  downloadFromNativeVersion,
  isAllowedNativeDownloadUrl,
  isHighLikelihoodPublic,
  isPrivateOrUnpublished,
  nativePackageMetadataUrl,
  nativeTarballUrls,
  nativeVersionMetadataUrl,
  publicNativeFallbackIds,
  publicNativeHostFromOrg,
  toPackageMetadata,
  versionsFromNativeBody,
} from "./native-public-v3.js";

const COORDINATE = "org.clojars.dantheman:test";
const NAME = encodeNativeCoordinate(COORDINATE);
const BODY = {
  latest_version: "0.0.3-SNAPSHOT",
  latest_release: "0.0.2",
  jar_name: "test",
  group_name: "org.clojars.dantheman",
  description: "TEST",
  scm: { url: "https://github.com/fake/test" },
  recent_versions: [
    { version: "0.0.3-SNAPSHOT" },
    { version: "0.0.2" },
    { version: "0.0.1" },
  ],
};

test("v3 activates only Clojars beyond the proven ten-adapter v2 set", () => {
  assert.deepEqual(publicNativeFallbackIds().sort(), [
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
  ]);
  assert.equal(publicNativeHostFromOrg("clojars")?.id, "clojars");
  assert.equal(publicNativeHostFromOrg("clojure")?.id, "clojars");
  for (const token of [
    "rubygems",
    "hex",
    "packagist",
    "conan",
    "luarocks",
    "opam",
    "julia",
    "conda-forge",
    "cocoapods",
    "terraform",
    "docker",
  ]) {
    assert.equal(publicNativeHostFromOrg(token), null, token);
  }
});

test("Clojars dispatcher binds metadata identity and excludes snapshots", () => {
  const host = publicNativeHostFromOrg("clojars");
  assert.equal(isHighLikelihoodPublic(host, NAME), true);
  assert.equal(
    nativePackageMetadataUrl(host, NAME),
    "https://clojars.org/api/artifacts/org.clojars.dantheman/test",
  );
  assert.equal(
    nativeVersionMetadataUrl(host, NAME, "0.0.2"),
    "https://clojars.org/api/artifacts/org.clojars.dantheman/test",
  );
  assert.equal(nativeVersionMetadataUrl(host, NAME, "0.0.3-SNAPSHOT"), null);
  assert.equal(isPrivateOrUnpublished(host, BODY), false);
  assert.deepEqual(versionsFromNativeBody(host, BODY, NAME), ["0.0.2", "0.0.1"]);
  assert.deepEqual(versionsFromNativeBody(host, { ...BODY, group_name: "other" }, NAME), []);

  const metadata = toPackageMetadata(host, "clojars", NAME, BODY);
  assert.equal(metadata.latest, "0.0.2");
  assert.equal(metadata.description, "TEST");
  assert.equal(metadata.repo_url, "https://github.com/fake/test");
});

test("Clojars stable JAR is deterministic zip and exactly package-version bound", () => {
  const host = publicNativeHostFromOrg("clojars");
  const expected =
    "https://repo.clojars.org/org/clojars/dantheman/test/0.0.2/test-0.0.2.jar";

  assert.deepEqual(nativeTarballUrls(host, NAME, "0.0.2", "test-0.0.2.jar"), [expected]);
  assert.deepEqual(nativeTarballUrls(host, NAME, "0.0.2", "other-0.0.2.jar"), []);
  assert.deepEqual(nativeTarballUrls(host, NAME, "0.0.3-SNAPSHOT"), []);

  const download = downloadFromNativeVersion(host, NAME, "0.0.2", BODY);
  assert.deepEqual(download, {
    url: expected,
    sha256: "",
    size: 0,
    format: "zip",
  });
  assert.equal(isAllowedNativeDownloadUrl(host, expected, NAME, "0.0.2"), true);

  for (const url of [
    "http://repo.clojars.org/org/clojars/dantheman/test/0.0.2/test-0.0.2.jar",
    "https://repo.clojars.org.evil.test/org/clojars/dantheman/test/0.0.2/test-0.0.2.jar",
    "https://repo.clojars.org/org/clojars/dantheman/other/0.0.2/other-0.0.2.jar",
    "https://repo.clojars.org/org/clojars/dantheman/test/0.0.1/test-0.0.1.jar",
    "https://repo.clojars.org/org/clojars/dantheman/test/0.0.2/test-0.0.2.jar?x=1",
    "https://user:pass@repo.clojars.org/org/clojars/dantheman/test/0.0.2/test-0.0.2.jar",
  ]) {
    assert.equal(isAllowedNativeDownloadUrl(host, url, NAME, "0.0.2"), false, url);
  }
});
