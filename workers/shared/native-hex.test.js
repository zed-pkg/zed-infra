import assert from "node:assert/strict";
import test from "node:test";

import {
  hexDownload,
  hexPackageUrl,
  hexReleaseUrl,
  hexVersions,
  isAllowedHexDownloadUrl,
  isPublicPackageBody,
} from "./native-hex.js";

const PACKAGE = {
  name: "plug",
  repository: "hexpm",
  releases: [
    { version: "1.16.1", url: "https://hex.pm/api/packages/plug/releases/1.16.1" },
    { version: "1.15.0", url: "https://hex.pm/api/packages/plug/releases/1.15.0" },
    { version: "1.14.0", url: "https://hex.pm/api/packages/plug/releases/1.14.0" },
  ],
  retirements: {
    "1.15.0": { reason: "security", message: "retired" },
  },
};

const RELEASE = {
  version: "1.16.1",
  checksum: "a".repeat(64),
  retirement: null,
  url: "https://hex.pm/api/packages/plug/releases/1.16.1",
  package_url: "https://hex.pm/api/packages/plug",
  inserted_at: "2024-06-20T13:57:58.725910Z",
};

test("Hex staging uses exact public package and release API endpoints", () => {
  assert.equal(hexPackageUrl("plug"), "https://hex.pm/api/packages/plug");
  assert.equal(
    hexReleaseUrl("plug", "1.16.1"),
    "https://hex.pm/api/packages/plug/releases/1.16.1",
  );
  assert.equal(hexPackageUrl("../plug"), null);
  assert.equal(hexReleaseUrl("plug", "../1.16.1"), null);
});

test("Hex package versions exclude retired releases and reject non-public repository identity", () => {
  assert.equal(isPublicPackageBody(PACKAGE), true);
  assert.deepEqual(hexVersions(PACKAGE), ["1.16.1", "1.14.0"]);
  assert.equal(isPublicPackageBody({ ...PACKAGE, repository: "private-org" }), false);
  assert.deepEqual(hexVersions({ ...PACKAGE, repository: "private-org" }), []);
});

test("Hex staging binds exact release identity checksum and deterministic tarball", () => {
  const download = hexDownload(RELEASE, "plug", "1.16.1");
  assert.equal(download?.sha256, "a".repeat(64));
  assert.equal(download?.native_format, "hex-tar");
  assert.equal(download?.size, 0);
  assert.equal(download?.url, "https://repo.hex.pm/tarballs/plug-1.16.1.tar");
  assert.equal(
    isAllowedHexDownloadUrl(download.url, "plug", "1.16.1"),
    true,
  );
});

test("Hex staging rejects retired mismatched or malformed release metadata", () => {
  assert.equal(hexDownload({ ...RELEASE, retirement: { reason: "security" } }, "plug", "1.16.1"), null);
  assert.equal(hexDownload({ ...RELEASE, checksum: "bad" }, "plug", "1.16.1"), null);
  assert.equal(hexDownload({ ...RELEASE, version: "1.16.0" }, "plug", "1.16.1"), null);
  assert.equal(
    hexDownload(
      { ...RELEASE, package_url: "https://hex.pm/api/packages/other" },
      "plug",
      "1.16.1",
    ),
    null,
  );
  assert.equal(
    hexDownload(
      { ...RELEASE, url: "https://hex.pm/api/packages/other/releases/1.16.1" },
      "plug",
      "1.16.1",
    ),
    null,
  );
});

test("Hex tarball validator rejects host path credential port query and version confusion", () => {
  for (const url of [
    "http://repo.hex.pm/tarballs/plug-1.16.1.tar",
    "https://evil.test/tarballs/plug-1.16.1.tar",
    "https://repo.hex.pm/tarballs/other-1.16.1.tar",
    "https://repo.hex.pm/tarballs/plug-1.16.0.tar",
    "https://user:pass@repo.hex.pm/tarballs/plug-1.16.1.tar",
    "https://repo.hex.pm:444/tarballs/plug-1.16.1.tar",
    "https://repo.hex.pm/tarballs/plug-1.16.1.tar?x=1",
  ]) {
    assert.equal(isAllowedHexDownloadUrl(url, "plug", "1.16.1"), false, url);
  }
});

test("Hex remains wire-format gated until shared ArtifactFormat supports its package tar", () => {
  const download = hexDownload(RELEASE, "plug", "1.16.1");
  assert.equal(download?.native_format, "hex-tar");
  assert.equal(Object.prototype.hasOwnProperty.call(download, "format"), false);
});
