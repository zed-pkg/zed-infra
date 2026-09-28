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

const COORDINATE = "acme/widget";
const NAME = encodeNativeCoordinate(COORDINATE);
const SHA = "a".repeat(40);
const BODY = {
  package: {
    name: COORDINATE,
    description: "A stable Composer package",
    repository: "https://github.com/acme/widget",
    versions: {
      "1.2.3": {
        name: COORDINATE,
        version: "1.2.3",
        time: "2026-09-01T12:00:00+00:00",
        source: {
          type: "git",
          url: "https://github.com/acme/widget.git",
          reference: SHA,
        },
        dist: {
          type: "zip",
          url: `https://api.github.com/repos/acme/widget/zipball/${SHA}`,
          reference: SHA,
        },
      },
    },
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
    "https://packagist.org/packages/acme/widget.json",
  );
  assert.equal(
    nativeVersionMetadataUrl(host, NAME, "1.2.3"),
    "https://packagist.org/packages/acme/widget.json",
  );
  assert.equal(nativeVersionMetadataUrl(host, NAME, "dev-main"), null);
  assert.equal(isPrivateOrUnpublished(host, BODY), false);
  assert.deepEqual(versionsFromNativeBody(host, BODY, NAME), ["1.2.3"]);

  const metadata = toPackageMetadata(host, "packagist", NAME, BODY);
  assert.equal(metadata.latest, "1.2.3");
  assert.equal(metadata.description, "A stable Composer package");
  assert.equal(metadata.repo_url, "https://github.com/acme/widget");
});

test("v4 Packagist candidate carries commit provenance into URL validation", () => {
  const host = publicNativeHostFromOrg("packagist");
  const candidate = downloadFromNativeVersion(host, NAME, "1.2.3", BODY);
  assert.equal(candidate?.reference, SHA);
  assert.equal(candidate?.format, "zip");
  assert.equal(
    candidate?.url,
    `https://codeload.github.com/acme/widget/legacy.zip/${SHA}`,
  );
  assert.equal(
    isAllowedNativeDownloadUrl(host, candidate.url, NAME, "1.2.3", candidate),
    true,
  );
  assert.equal(
    isAllowedNativeDownloadUrl(
      host,
      `https://codeload.github.com/acme/widget/legacy.zip/${"b".repeat(40)}`,
      NAME,
      "1.2.3",
      candidate,
    ),
    false,
  );
});
