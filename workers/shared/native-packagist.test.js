import assert from "node:assert/strict";
import test from "node:test";

import {
  expandPackagistVersions,
  isAllowedPackagistDownloadUrl,
  packagistCoordinate,
  packagistDescription,
  packagistDownload,
  packagistLatest,
  packagistMetadataUrl,
  packagistRepoUrl,
  packagistVersions,
} from "./native-packagist.js";

const COORDINATE = "vendor/package";
const REF_1 = "a".repeat(40);
const REF_2 = "b".repeat(40);

function version({ version, reference, description = "Package description", shasum = "" }) {
  return {
    name: COORDINATE,
    description,
    version,
    time: "2026-01-02T03:04:05+00:00",
    source: {
      type: "git",
      url: "https://github.com/upstream/project.git",
      reference,
    },
    dist: {
      type: "zip",
      url: `https://api.github.com/repos/upstream/project/zipball/${reference}`,
      reference,
      shasum,
    },
  };
}

test("Packagist v2 metadata URL is exact and path-safe", () => {
  assert.deepEqual(packagistCoordinate(COORDINATE), ["vendor", "package"]);
  assert.equal(
    packagistMetadataUrl(COORDINATE),
    "https://repo.packagist.org/p2/vendor/package.json",
  );
  for (const bad of [
    "vendor",
    "../vendor/package",
    "vendor/../package",
    "vendor/package/extra",
    "vendor\\package",
  ]) {
    assert.equal(packagistMetadataUrl(bad), null, bad);
  }
});

test("Composer 2 minified metadata expands with shallow inheritance and __unset", () => {
  const first = version({ version: "2.0.0", reference: REF_2, description: "Newest" });
  const body = {
    minified: "composer/2.0",
    packages: {
      [COORDINATE]: [
        first,
        {
          version: "1.0.0",
          source: { ...first.source, reference: REF_1 },
          dist: {
            ...first.dist,
            url: `https://api.github.com/repos/upstream/project/zipball/${REF_1}`,
            reference: REF_1,
          },
          description: "__unset",
        },
      ],
    },
  };
  const expanded = expandPackagistVersions(body, COORDINATE);
  assert.equal(expanded.length, 2);
  assert.equal(expanded[0].description, "Newest");
  assert.equal(expanded[1].description, undefined);
  assert.equal(expanded[1].name, COORDINATE);
  assert.equal(expanded[1].source.reference, REF_1);
  assert.equal(expanded[1].dist.reference, REF_1);
  assert.deepEqual(packagistVersions(body, COORDINATE), ["2.0.0", "1.0.0"]);
  assert.equal(packagistLatest(body, COORDINATE, ["2.0.0", "1.0.0"]), "2.0.0");
  assert.equal(packagistDescription(body, COORDINATE), "Newest");
  assert.equal(packagistRepoUrl(body, COORDINATE), "https://github.com/upstream/project");
});

test("Packagist download binds package metadata source dist and immutable reference", () => {
  const body = {
    packages: {
      [COORDINATE]: [version({ version: "2.0.0", reference: REF_2 })],
    },
  };
  const download = packagistDownload(body, COORDINATE, "2.0.0");
  assert.deepEqual(download, {
    url: `https://codeload.github.com/upstream/project/zip/${REF_2}`,
    sha256: "",
    size: 0,
    format: "zip",
    published_at: "2026-01-02T03:04:05.000Z",
    validation: {
      kind: "packagist-github-zip",
      owner: "upstream",
      repo: "project",
      reference: REF_2,
    },
  });
  assert.equal(isAllowedPackagistDownloadUrl(download.url, download), true);
});

test("Packagist rejects wrong package identity repository reference and alternate dist representations", () => {
  const good = version({ version: "2.0.0", reference: REF_2 });
  const badRows = [
    { ...good, name: "other/package" },
    { ...good, source: { ...good.source, url: "https://github.com/other/project.git" } },
    { ...good, source: { ...good.source, reference: REF_1 } },
    { ...good, dist: { ...good.dist, type: "tar" } },
    { ...good, dist: { ...good.dist, url: `https://evil.test/upstream/project/${REF_2}.zip` } },
    { ...good, dist: { ...good.dist, reference: REF_1 } },
    { ...good, dist: { ...good.dist, shasum: "deadbeef" } },
    { ...good, source: { ...good.source, url: "http://github.com/upstream/project.git" } },
  ];
  for (const row of badRows) {
    const body = { packages: { [COORDINATE]: [row] } };
    assert.equal(packagistDownload(body, COORDINATE, "2.0.0"), null);
    assert.deepEqual(packagistVersions(body, COORDINATE), []);
  }
});

test("Packagist codeload validator rejects host path credential and candidate confusion", () => {
  const body = {
    packages: {
      [COORDINATE]: [version({ version: "2.0.0", reference: REF_2 })],
    },
  };
  const candidate = packagistDownload(body, COORDINATE, "2.0.0");
  const good = candidate.url;
  assert.equal(isAllowedPackagistDownloadUrl(good, candidate), true);

  for (const url of [
    `http://codeload.github.com/upstream/project/zip/${REF_2}`,
    `https://codeload.github.com.evil.test/upstream/project/zip/${REF_2}`,
    `https://codeload.github.com/other/project/zip/${REF_2}`,
    `https://codeload.github.com/upstream/other/zip/${REF_2}`,
    `https://codeload.github.com/upstream/project/zip/${REF_1}`,
    `https://codeload.github.com/upstream/project/zip/${REF_2}?x=1`,
    `https://user:pass@codeload.github.com/upstream/project/zip/${REF_2}`,
  ]) {
    assert.equal(isAllowedPackagistDownloadUrl(url, candidate), false, url);
  }
  assert.equal(
    isAllowedPackagistDownloadUrl(good, {
      ...candidate,
      validation: { ...candidate.validation, repo: "other" },
    }),
    false,
  );
});

test("unknown metadata-minifier versions and dev versions fail closed", () => {
  const body = {
    minified: "composer/9.0",
    packages: { [COORDINATE]: [version({ version: "2.0.0", reference: REF_2 })] },
  };
  assert.deepEqual(expandPackagistVersions(body, COORDINATE), []);

  const dev = {
    packages: {
      [COORDINATE]: [version({ version: "dev-main", reference: REF_2 })],
    },
  };
  assert.equal(packagistDownload(dev, COORDINATE, "dev-main"), null);
  assert.deepEqual(packagistVersions(dev, COORDINATE), []);
});
