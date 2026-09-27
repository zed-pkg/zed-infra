import assert from "node:assert/strict";
import test from "node:test";

import { encodeNativeCoordinate } from "./native-registry-catalog.js";
import {
  downloadFromNativeVersion,
  isAllowedNativeDownloadUrl,
  isHighLikelihoodPublic,
  isPrivateOrUnpublished,
  nativeHeaders,
  nativePackageMetadataUrl,
  nativeTarballUrls,
  nativeVersionMetadataUrl,
  publicNativeFallbackIds,
  publicNativeHostFromOrg,
  readBoundedJson,
  toPackageMetadata,
  versionsFromNativeBody,
} from "./native-public.js";

test("only protocol-audited public registries are active", () => {
  assert.deepEqual(publicNativeFallbackIds().sort(), ["crates-io", "npm", "nuget", "pypi"]);
  assert.equal(publicNativeHostFromOrg("npm").id, "npm");
  assert.equal(publicNativeHostFromOrg("npmjs.com").id, "npm");
  assert.equal(publicNativeHostFromOrg("crates-io").id, "crates-io");
  assert.equal(publicNativeHostFromOrg("cargo").id, "crates-io");
  assert.equal(publicNativeHostFromOrg("pip").id, "pypi");
  assert.equal(publicNativeHostFromOrg("dotnet").id, "nuget");

  for (const token of [
    "maven",
    "rubygems",
    "hex",
    "packagist",
    "docker",
    "terraform",
    "test-pypi",
    "artifactory",
  ]) {
    assert.equal(publicNativeHostFromOrg(token), null, token);
  }
});

test("safe coordinates are not confused with proof that a package is public", () => {
  const npm = publicNativeHostFromOrg("npm");
  assert.equal(isHighLikelihoodPublic(npm, "lodash"), true);
  assert.equal(isHighLikelihoodPublic(npm, "private-sdk"), true);
  assert.equal(isHighLikelihoodPublic(npm, "../etc/passwd"), false);
  assert.equal(isHighLikelihoodPublic(npm, "scope/name"), false);

  const encodedScope = encodeNativeCoordinate("@scope/name");
  assert.equal(isHighLikelihoodPublic(npm, encodedScope), true);
  assert.equal(nativeHeaders().Authorization, undefined);
  assert.equal(nativeHeaders().authorization, undefined);
});

test("anonymous metadata still rejects private and unpublished bodies", () => {
  const npm = publicNativeHostFromOrg("npm");
  assert.equal(
    isPrivateOrUnpublished(npm, { private: true, versions: { "1.0.0": {} } }),
    true,
  );
  assert.equal(isPrivateOrUnpublished(npm, { unpublished: { time: "2020-01-01" } }), true);
  assert.equal(
    isPrivateOrUnpublished(npm, {
      name: "lodash",
      versions: { "4.17.21": { dist: { tarball: "https://registry.npmjs.org/x" } } },
    }),
    false,
  );

  const pypi = publicNativeHostFromOrg("pypi");
  assert.equal(isPrivateOrUnpublished(pypi, { info: { name: "requests" }, releases: {} }), false);
  assert.equal(isPrivateOrUnpublished(pypi, { info: { name: "requests" } }), true);

  const nuget = publicNativeHostFromOrg("nuget");
  assert.equal(isPrivateOrUnpublished(nuget, { versions: ["1.0.0"] }), false);
  assert.equal(isPrivateOrUnpublished(nuget, { versions: [] }), true);
});

test("metadata and artifact URLs are fixed to canonical public hosts", () => {
  const npm = publicNativeHostFromOrg("npm");
  assert.equal(nativePackageMetadataUrl(npm, "lodash"), "https://registry.npmjs.org/lodash");
  assert.equal(
    nativeVersionMetadataUrl(npm, "lodash", "4.17.21"),
    "https://registry.npmjs.org/lodash/4.17.21",
  );
  assert.deepEqual(nativeTarballUrls(npm, "lodash", "4.17.21", "lodash-4.17.21.tgz"), [
    "https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz",
  ]);
  assert.deepEqual(nativeTarballUrls(npm, "lodash", "4.17.21", "other.tgz"), []);

  const scoped = encodeNativeCoordinate("@scope/pkg");
  assert.equal(
    nativePackageMetadataUrl(npm, scoped),
    "https://registry.npmjs.org/%40scope%2Fpkg",
  );
  assert.deepEqual(nativeTarballUrls(npm, scoped, "1.2.3", "pkg-1.2.3.tgz"), [
    "https://registry.npmjs.org/%40scope%2Fpkg/-/pkg-1.2.3.tgz",
  ]);

  const crates = publicNativeHostFromOrg("crates-io");
  assert.equal(
    nativePackageMetadataUrl(crates, "serde"),
    "https://crates.io/api/v1/crates/serde",
  );
  assert.deepEqual(nativeTarballUrls(crates, "serde", "1.0.0", "serde-1.0.0.crate"), [
    "https://static.crates.io/crates/serde/serde-1.0.0.crate",
  ]);

  const pypi = publicNativeHostFromOrg("pypi");
  assert.equal(nativePackageMetadataUrl(pypi, "requests"), "https://pypi.org/pypi/requests/json");
  assert.equal(
    nativeVersionMetadataUrl(pypi, "requests", "2.32.5"),
    "https://pypi.org/pypi/requests/2.32.5/json",
  );

  const nuget = publicNativeHostFromOrg("nuget");
  assert.equal(
    nativePackageMetadataUrl(nuget, "Newtonsoft.Json"),
    "https://api.nuget.org/v3-flatcontainer/newtonsoft.json/index.json",
  );
  assert.equal(
    nativeVersionMetadataUrl(nuget, "Newtonsoft.Json", "13.0.3"),
    "https://api.nuget.org/v3-flatcontainer/newtonsoft.json/index.json",
  );
  assert.deepEqual(
    nativeTarballUrls(
      nuget,
      "Newtonsoft.Json",
      "13.0.3",
      "newtonsoft.json.13.0.3.nupkg",
    ),
    [
      "https://api.nuget.org/v3-flatcontainer/newtonsoft.json/13.0.3/newtonsoft.json.13.0.3.nupkg",
    ],
  );
});

test("untrusted metadata cannot redirect downloads off registry path allowlists", () => {
  const npm = publicNativeHostFromOrg("npm");
  assert.equal(
    isAllowedNativeDownloadUrl(
      npm,
      "https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz",
      "lodash",
      "4.17.21",
    ),
    true,
  );
  for (const url of [
    "http://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz",
    "https://evil.test/lodash-4.17.21.tgz",
    "https://registry.npmjs.org/other/-/other-4.17.21.tgz",
    "https://user:pass@registry.npmjs.org/lodash/-/lodash-4.17.21.tgz",
  ]) {
    assert.equal(isAllowedNativeDownloadUrl(npm, url, "lodash", "4.17.21"), false, url);
  }
  assert.equal(
    downloadFromNativeVersion(npm, "lodash", "4.17.21", {
      dist: { tarball: "https://evil.test/payload.tgz" },
    }),
    null,
  );

  const pypi = publicNativeHostFromOrg("pypi");
  assert.equal(
    isAllowedNativeDownloadUrl(
      pypi,
      "https://files.pythonhosted.org/packages/aa/bb/deadbeef/requests-2.32.5.tar.gz",
      "requests",
      "2.32.5",
    ),
    true,
  );
  assert.equal(
    isAllowedNativeDownloadUrl(
      pypi,
      "https://pypi.org/packages/aa/bb/deadbeef/requests-2.32.5.tar.gz",
      "requests",
      "2.32.5",
    ),
    false,
  );

  const nuget = publicNativeHostFromOrg("nuget");
  assert.equal(
    isAllowedNativeDownloadUrl(
      nuget,
      "https://api.nuget.org/v3-flatcontainer/newtonsoft.json/13.0.3/newtonsoft.json.13.0.3.nupkg",
      "Newtonsoft.Json",
      "13.0.3",
    ),
    true,
  );
  assert.equal(
    isAllowedNativeDownloadUrl(
      nuget,
      "https://api.nuget.org/v3-flatcontainer/other/13.0.3/other.13.0.3.nupkg",
      "Newtonsoft.Json",
      "13.0.3",
    ),
    false,
  );
});

test("metadata bodies are JSON-only and bounded", async () => {
  const good = new Response(JSON.stringify({ ok: true }), {
    headers: { "content-type": "application/json", "content-length": "11" },
  });
  assert.deepEqual(await readBoundedJson(good), { ok: true });

  const html = new Response("<html>", { headers: { "content-type": "text/html" } });
  assert.equal(await readBoundedJson(html), null);

  const oversized = new Response("{}", {
    headers: { "content-type": "application/json", "content-length": "2000000" },
  });
  assert.equal(await readBoundedJson(oversized), null);
});

test("native package metadata maps only installable visible versions", () => {
  const npm = publicNativeHostFromOrg("npm");
  const meta = toPackageMetadata(npm, "npm", "left-pad", {
    description: "pad",
    "dist-tags": { latest: "1.3.0" },
    versions: { "1.0.0": {}, "1.3.0": {} },
  });
  assert.equal(meta.native_host, "npm");
  assert.deepEqual(versionsFromNativeBody(npm, { versions: { "1.0.0": {}, "1.3.0": {} } }), [
    "1.3.0",
    "1.0.0",
  ]);
  assert.equal(meta.latest, "1.3.0");

  const crates = publicNativeHostFromOrg("crates-io");
  assert.deepEqual(
    versionsFromNativeBody(crates, {
      versions: [
        { num: "2.0.0", yanked: true },
        { num: "1.0.0", yanked: false },
      ],
    }),
    ["1.0.0"],
  );

  const pypi = publicNativeHostFromOrg("pypi");
  assert.deepEqual(
    versionsFromNativeBody(pypi, {
      releases: {
        "2.0.0": [{ filename: "pkg-2.0.0-py3-none-any.whl", packagetype: "bdist_wheel" }],
        "1.1.0": [{ filename: "pkg-1.1.0.tar.gz", packagetype: "sdist", yanked: true }],
        "1.0.0": [{ filename: "pkg-1.0.0.tar.gz", packagetype: "sdist", yanked: false }],
      },
    }),
    ["1.0.0"],
  );
});

test("native version candidates stay inside the Rust artifact format contract", () => {
  const npm = publicNativeHostFromOrg("npm");
  const npmCandidate = downloadFromNativeVersion(npm, "lodash", "4.17.21", {
    dist: {
      tarball: "https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz",
      integrity: "sha512-not-a-sha256",
      unpackedSize: 999999,
    },
  });
  assert.equal(npmCandidate.format, "tar.gz");
  assert.equal(npmCandidate.size, 0, "unpackedSize must not be treated as tarball size");

  const crates = publicNativeHostFromOrg("crates-io");
  const crateCandidate = downloadFromNativeVersion(crates, "serde", "1.0.0", {
    version: {
      num: "1.0.0",
      checksum: "a".repeat(64),
      crate_size: 1234,
      dl_path: "/api/v1/crates/serde/1.0.0/download",
      yanked: false,
    },
  });
  assert.deepEqual(crateCandidate, {
    url: "https://crates.io/api/v1/crates/serde/1.0.0/download",
    sha256: "a".repeat(64),
    size: 1234,
    format: "tar.gz",
  });

  const pypi = publicNativeHostFromOrg("pypi");
  const pypiCandidate = downloadFromNativeVersion(pypi, "requests", "2.32.5", {
    urls: [
      {
        filename: "requests-2.32.5.tar.gz",
        packagetype: "sdist",
        yanked: false,
        size: 150000,
        digests: { sha256: "b".repeat(64) },
        url: "https://files.pythonhosted.org/packages/aa/bb/deadbeef/requests-2.32.5.tar.gz",
        upload_time_iso_8601: "2026-01-02T03:04:05Z",
      },
    ],
  });
  assert.equal(pypiCandidate.format, "tar.gz");
  assert.equal(pypiCandidate.sha256, "b".repeat(64));

  const nuget = publicNativeHostFromOrg("nuget");
  const nugetCandidate = downloadFromNativeVersion(nuget, "Newtonsoft.Json", "13.0.3", {
    versions: ["12.0.1", "13.0.3"],
  });
  assert.equal(nugetCandidate.format, "zip");
  assert.equal(
    nugetCandidate.url,
    "https://api.nuget.org/v3-flatcontainer/newtonsoft.json/13.0.3/newtonsoft.json.13.0.3.nupkg",
  );

  for (const candidate of [npmCandidate, crateCandidate, pypiCandidate, nugetCandidate]) {
    assert.ok(["tar.gz", "zip"].includes(candidate.format), candidate.format);
  }
});
