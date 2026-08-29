import assert from "node:assert/strict";
import test from "node:test";

import {
  githubFallbackUrlsForCdn,
  githubReleaseAssetNames,
  githubReleaseSidecarNames,
  gitTagsForVersion,
  isSlug,
  isRegistryOnlyPath,
  parseCdnPath,
  parseRegistryPath,
  versionFromGitTag,
} from "./github-fallback.js";

test("slug matches zed-interfaces is_slug", () => {
  assert.equal(isSlug("zed-pkg-test"), true);
  assert.equal(isSlug("github-api-fallback-canary"), true);
  assert.equal(isSlug("Node"), false);
  assert.equal(isSlug("-bad"), false);
  assert.equal(isSlug("has_underscore"), false);
});

test("registry hostname only forwards the API /v1 slice", () => {
  assert.equal(isRegistryOnlyPath("/healthz"), true);
  assert.equal(isRegistryOnlyPath("/v1/packages/npm/lodash"), true);
  assert.equal(isRegistryOnlyPath("/v1/search"), true);
  assert.equal(isRegistryOnlyPath("/"), false);
  assert.equal(isRegistryOnlyPath("/auth/login"), false);
  assert.equal(isRegistryOnlyPath("/shared-auth"), false);
  assert.equal(isRegistryOnlyPath("/v1/../secret"), false);
});

test("parseRegistryPath covers health, package, version, artifact", () => {
  assert.deepEqual(parseRegistryPath("/healthz"), { kind: "healthz" });
  assert.deepEqual(parseRegistryPath("/v1/packages/zed-pkg-test/node-lib"), {
    kind: "get_package",
    org: "zed-pkg-test",
    name: "node-lib",
  });
  assert.deepEqual(
    parseRegistryPath("/v1/packages/zed-pkg-test/node-lib/versions/1.0.0"),
    {
      kind: "get_version",
      org: "zed-pkg-test",
      name: "node-lib",
      version: "1.0.0",
    },
  );
  const sha = "a".repeat(64);
  assert.deepEqual(parseRegistryPath(`/v1/artifacts/${sha}`), {
    kind: "get_artifact",
    sha256: sha,
  });
  assert.equal(parseRegistryPath("/v1/packages/../etc/passwd"), null);
  assert.equal(parseRegistryPath("/v1/orgs"), null);
});

test("parseCdnPath matches guessable R2 keys", () => {
  assert.deepEqual(
    parseCdnPath("/packages/zed-pkg-test/node-lib/1.0.0/node-lib-1.0.0.tar.gz"),
    {
      kind: "cdn_package_object",
      org: "zed-pkg-test",
      name: "node-lib",
      version: "1.0.0",
      filename: "node-lib-1.0.0.tar.gz",
      key: "packages/zed-pkg-test/node-lib/1.0.0/node-lib-1.0.0.tar.gz",
    },
  );
  assert.deepEqual(
    parseCdnPath("/github/zed-pkg-test/node-lib/v1.0.0/zpkg-node-lib-1.0.0.tar.gz"),
    {
      kind: "cdn_github_object",
      owner: "zed-pkg-test",
      repo: "node-lib",
      tag: "v1.0.0",
      filename: "zpkg-node-lib-1.0.0.tar.gz",
      key: "github/zed-pkg-test/node-lib/v1.0.0/zpkg-node-lib-1.0.0.tar.gz",
    },
  );
  const sha = "b".repeat(64);
  assert.deepEqual(parseCdnPath(`/artifacts/${sha}.tar.gz`), {
    kind: "cdn_content_object",
    sha256: sha,
    ext: "tar.gz",
    key: `artifacts/${sha}.tar.gz`,
  });
  assert.equal(parseCdnPath("/github/zed-pkg-test/node-lib/v1.0.0/../secret"), null);
});

test("asset names and tags match the CLI contract", () => {
  assert.deepEqual(gitTagsForVersion("1.0.0"), ["v1.0.0", "1.0.0"]);
  assert.equal(versionFromGitTag("v1.0.0"), "1.0.0");
  assert.deepEqual(
    githubReleaseAssetNames("zed-pkg-test", "node-lib", "1.0.0"),
    ["zpkg-zed-pkg-test-node-lib-1.0.0.tar.gz", "zpkg-node-lib-1.0.0.tar.gz"],
  );
  assert.deepEqual(
    githubReleaseSidecarNames("zed-pkg-test", "node-lib", "1.0.0"),
    ["zpkg-zed-pkg-test-node-lib-1.0.0.json", "zpkg-node-lib-1.0.0.json"],
  );
});

test("cdn package keys fall back to GitHub Release download URLs", () => {
  const urls = githubFallbackUrlsForCdn(
    parseCdnPath("/packages/zed-pkg-test/node-lib/1.0.0/node-lib-1.0.0.tar.gz"),
  );
  assert.ok(
    urls.includes(
      "https://github.com/zed-pkg-test/node-lib/releases/download/v1.0.0/zpkg-zed-pkg-test-node-lib-1.0.0.tar.gz",
    ),
  );
  assert.ok(
    urls.includes(
      "https://github.com/zed-pkg-test/node-lib/releases/download/v1.0.0/node-lib-1.0.0.tar.gz",
    ),
  );
});
