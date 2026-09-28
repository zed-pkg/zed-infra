import assert from "node:assert/strict";
import test from "node:test";

import {
  isAllowedPackagistDownloadUrl,
  packagistCoordinate,
  packagistDescription,
  packagistDownload,
  packagistMetadataUrl,
  packagistRepoUrl,
  packagistVersions,
} from "./native-packagist.js";

const COORDINATE = "acme/widget";
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
      "dev-main": {
        name: COORDINATE,
        version: "dev-main",
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

test("Packagist metadata URL is canonical and coordinate-safe", () => {
  assert.deepEqual(packagistCoordinate(COORDINATE), ["acme", "widget"]);
  assert.equal(
    packagistMetadataUrl(COORDINATE),
    "https://packagist.org/packages/acme/widget.json",
  );
  for (const value of ["acme", "../widget/pkg", "acme/../widget", "acme/widget/extra", "acme\\widget"]){
    assert.equal(packagistMetadataUrl(value), null, value);
  }
});

test("Packagist activates only stable exact GitHub-backed ZIP releases", () => {
  assert.deepEqual(packagistVersions(BODY, COORDINATE), ["1.2.3"]);
  assert.equal(packagistDescription(BODY), "A stable Composer package");
  assert.equal(packagistRepoUrl(BODY, COORDINATE), "https://github.com/acme/widget");

  const download = packagistDownload(BODY, COORDINATE, "1.2.3");
  assert.deepEqual(download, {
    url: `https://codeload.github.com/acme/widget/legacy.zip/${SHA}`,
    sha256: "",
    size: 0,
    format: "zip",
    published_at: "2026-09-01T12:00:00.000Z",
    reference: SHA,
  });
  assert.equal(packagistDownload(BODY, COORDINATE, "dev-main"), null);
});

test("Packagist fails closed on identity, format, source, and reference mismatches", () => {
  const row = BODY.package.versions["1.2.3"];
  const cases = [
    { ...BODY, package: { ...BODY.package, name: "other/widget" } },
    { ...BODY, package: { ...BODY.package, repository: "https://github.com/other/widget" } },
    { ...BODY, package: { ...BODY.package, versions: { "1.2.3": { ...row, dist: { ...row.dist, type: "tar" } } } } },
    { ...BODY, package: { ...BODY.package, versions: { "1.2.3": { ...row, source: { ...row.source, url: "https://github.com/other/widget.git" } } } } },
    { ...BODY, package: { ...BODY.package, versions: { "1.2.3": { ...row, source: { ...row.source, reference: "b".repeat(40) } } } } },
    { ...BODY, package: { ...BODY.package, versions: { "1.2.3": { ...row, dist: { ...row.dist, url: "https://evil.test/widget.zip" } } } } },
  ];
  for (const body of cases) {
    assert.equal(packagistDownload(body, COORDINATE, "1.2.3"), null);
  }
});

test("Packagist codeload validator binds repository and optional exact SHA", () => {
  const good = `https://codeload.github.com/acme/widget/legacy.zip/${SHA}`;
  assert.equal(isAllowedPackagistDownloadUrl(good, COORDINATE, "1.2.3", SHA), true);
  assert.equal(isAllowedPackagistDownloadUrl(good, COORDINATE, "1.2.3"), true);

  for (const url of [
    `http://codeload.github.com/acme/widget/legacy.zip/${SHA}`,
    `https://codeload.github.com.evil.test/acme/widget/legacy.zip/${SHA}`,
    `https://codeload.github.com/other/widget/legacy.zip/${SHA}`,
    `https://codeload.github.com/acme/other/legacy.zip/${SHA}`,
    `https://codeload.github.com/acme/widget/legacy.zip/${"b".repeat(40)}`,
    `https://codeload.github.com/acme/widget/legacy.zip/${SHA}?x=1`,
    `https://user:pass@codeload.github.com/acme/widget/legacy.zip/${SHA}`,
    `https://api.github.com/repos/acme/widget/zipball/${SHA}`,
  ]) {
    assert.equal(isAllowedPackagistDownloadUrl(url, COORDINATE, "1.2.3", SHA), false, url);
  }
});
