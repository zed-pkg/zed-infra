import assert from "node:assert/strict";
import test from "node:test";

import { encodeNativeCoordinate } from "./native-registry-catalog.js";
import {
  downloadFromNativeVersion,
  isAllowedNativeDownloadUrl,
  isPrivateOrUnpublished,
  nativePackageMetadataUrl,
  nativeVersionMetadataUrl,
  publicNativeFallbackIds,
  publicNativeHostFromOrg,
  toPackageMetadata,
  versionsFromNativeBody,
} from "./native-public-v4.js";

const COORDINATE = "vendor/package";
const NAME = encodeNativeCoordinate(COORDINATE);
const SHA = "a".repeat(40);
const BODY = {
  minified: "composer/2.0",
  packages: {
    [COORDINATE]: [
      {
        name: COORDINATE,
        version: "1.2.3",
        description: "A stable Composer package",
        time: "2026-09-01T12:00:00+00:00",
        source: {
          type: "git",
          url: "https://github.com/upstream/project.git",
          reference: SHA,
        },
        dist: {
          type: "zip",
          url: `https://api.github.com/repos/upstream/project/zipball/${SHA}`,
          reference: SHA,
          shasum: "",
        },
      },
    ],
  },
};

test("v4 stages Packagist as the only adapter beyond production v3", () => {
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
    "packagist",
    "pypi",
  ]);
  assert.equal(publicNativeHostFromOrg("packagist")?.id, "packagist");
  assert.equal(publicNativeHostFromOrg("composer")?.id, "packagist");
});

test("v4 Packagist metadata and package normalization are identity-bound", () => {
  const host = publicNativeHostFromOrg("packagist");
  assert.equal(
    nativePackageMetadataUrl(host, NAME),
    "https://repo.packagist.org/p2/vendor/package.json",
  );
  assert.equal(
    nativeVersionMetadataUrl(host, NAME, "1.2.3"),
    "https://repo.packagist.org/p2/vendor/package.json",
  );
  assert.equal(nativeVersionMetadataUrl(host, NAME, "dev-main"), null);
  assert.equal(isPrivateOrUnpublished(host, BODY), false);
  assert.deepEqual(versionsFromNativeBody(host, BODY, NAME), ["1.2.3"]);

  const metadata = toPackageMetadata(host, "packagist", NAME, BODY);
  assert.equal(metadata.latest, "1.2.3");
  assert.equal(metadata.description, "A stable Composer package");
  assert.equal(metadata.repo_url, "https://github.com/upstream/project");
});

test("v4 Packagist candidate carries immutable repo/reference context into URL validation", () => {
  const host = publicNativeHostFromOrg("packagist");
  const candidate = downloadFromNativeVersion(host, NAME, "1.2.3", BODY);
  assert.equal(candidate?.format, "zip");
  assert.equal(
    candidate?.url,
    `https://codeload.github.com/upstream/project/zip/${SHA}`,
  );
  assert.deepEqual(candidate?.validation, {
    kind: "packagist-github-zip",
    owner: "upstream",
    repo: "project",
    reference: SHA,
  });
  assert.equal(
    isAllowedNativeDownloadUrl(host, candidate.url, NAME, "1.2.3", candidate),
    true,
  );
  assert.equal(
    isAllowedNativeDownloadUrl(
      host,
      `https://codeload.github.com/upstream/project/zip/${"b".repeat(40)}`,
      NAME,
      "1.2.3",
      candidate,
    ),
    false,
  );
  assert.equal(
    isAllowedNativeDownloadUrl(
      host,
      candidate.url,
      NAME,
      "1.2.3",
      { ...candidate, validation: { ...candidate.validation, repo: "other" } },
    ),
    false,
  );
});

test("v4 rejects wrong package keys even when the outer JSON is valid Composer metadata", () => {
  const host = publicNativeHostFromOrg("packagist");
  const wrong = {
    packages: {
      "other/package": BODY.packages[COORDINATE],
    },
  };
  assert.equal(isPrivateOrUnpublished(host, wrong), false);
  assert.deepEqual(versionsFromNativeBody(host, wrong, NAME), []);
  const metadata = toPackageMetadata(host, "packagist", NAME, wrong);
  assert.deepEqual(metadata.versions, []);
  assert.equal(metadata.latest, null);
});
