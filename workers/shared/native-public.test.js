import assert from "node:assert/strict";
import test from "node:test";

import {
  downloadFromNativeVersion,
  isAllowedNativeDownloadUrl,
  isHighLikelihoodPublic,
  isPrivateOrUnpublished,
  nativeHeaders,
  nativePackageMetadataUrl,
  nativeTarballUrls,
  nativeVersionMetadataUrl,
  publicNativeHostFromOrg,
  readBoundedJson,
  toPackageMetadata,
  versionsFromNativeBody,
} from "./native-public.js";

test("only the explicitly audited public registries are recognized", () => {
  assert.equal(publicNativeHostFromOrg("npm").id, "npm");
  assert.equal(publicNativeHostFromOrg("npmjs.com").id, "npm");
  assert.equal(publicNativeHostFromOrg("crates-io").id, "crates-io");
  assert.equal(publicNativeHostFromOrg("cargo").id, "crates-io");
  for (const token of ["pypi", "rubygems", "hex", "nuget", "test-pypi", "artifactory"]) {
    assert.equal(publicNativeHostFromOrg(token), null, token);
  }
});

test("a safe coordinate is not confused with proof that a package is public", () => {
  const npm = publicNativeHostFromOrg("npm");
  assert.equal(isHighLikelihoodPublic(npm, "lodash"), true);
  assert.equal(isHighLikelihoodPublic(npm, "private-sdk"), true);
  assert.equal(isHighLikelihoodPublic(npm, "../etc/passwd"), false);
  assert.equal(isHighLikelihoodPublic(npm, "scope/name"), false);
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
});

test("metadata and tarball URLs are fixed to canonical public hosts", () => {
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

  const crates = publicNativeHostFromOrg("crates-io");
  assert.equal(
    nativePackageMetadataUrl(crates, "serde"),
    "https://crates.io/api/v1/crates/serde",
  );
  assert.deepEqual(nativeTarballUrls(crates, "serde", "1.0.0", "serde-1.0.0.crate"), [
    "https://static.crates.io/crates/serde/serde-1.0.0.crate",
  ]);
});

test("untrusted metadata cannot redirect downloads off the allowlist", () => {
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

test("native package metadata maps only visible versions", () => {
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
  assert.deepEqual(
    downloadFromNativeVersion(crates, "serde", "1.0.0", {
      version: {
        num: "1.0.0",
        checksum: "a".repeat(64),
        crate_size: 1234,
        dl_path: "/api/v1/crates/serde/1.0.0/download",
        yanked: false,
      },
    }),
    {
      url: "https://crates.io/api/v1/crates/serde/1.0.0/download",
      sha256: "a".repeat(64),
      size: 1234,
      format: "crate",
    },
  );
});
