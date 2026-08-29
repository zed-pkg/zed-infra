import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyRegistryRequest,
  githubFallbackUrlsForCdn,
  githubReleaseAssetNames,
  githubReleaseSidecarNames,
  gitTagsForVersion,
  isSlug,
  isRegistryOnlyPath,
  parseCdnPath,
  parseRegistryPath,
  REGISTRY_ACTION,
  versionFromGitTag,
} from "./github-fallback.js";

test("slug matches zed-interfaces is_slug", () => {
  assert.equal(isSlug("zed-pkg-test"), true);
  assert.equal(isSlug("github-api-fallback-canary"), true);
  assert.equal(isSlug("Node"), false);
  assert.equal(isSlug("-bad"), false);
  assert.equal(isSlug("has_underscore"), false);
});

test("registry state machine covers every current machine-registry route", () => {
  const cases = [
    ["GET", "/healthz", REGISTRY_ACTION.HEALTH],
    ["GET", "/v1/packages", REGISTRY_ACTION.ORIGIN_READ],
    ["GET", "/v1/packages/npm/lodash", REGISTRY_ACTION.FALLBACK_READ],
    ["PUT", "/v1/packages/acme/http-kit/versions/1.0.0", REGISTRY_ACTION.ORIGIN_WRITE],
    ["POST", "/v1/packages/acme/http-kit/versions/1.0.0/yank", REGISTRY_ACTION.ORIGIN_WRITE],
    ["GET", `/v1/artifacts/${"a".repeat(64)}`, REGISTRY_ACTION.ORIGIN_READ],
    ["GET", "/v1/files/acme/http-kit/1.0.0/README.md", REGISTRY_ACTION.ORIGIN_READ],
    ["GET", "/v1/search", REGISTRY_ACTION.ORIGIN_READ],
    ["POST", "/v1/search/semantic", REGISTRY_ACTION.ORIGIN_WRITE],
    ["PUT", "/v1/packages/acme/http-kit/embedding", REGISTRY_ACTION.ORIGIN_WRITE],
    ["POST", "/v1/orgs", REGISTRY_ACTION.ORIGIN_WRITE],
    ["GET", "/v1/orgs/acme/audit", REGISTRY_ACTION.ORIGIN_READ],
    ["GET", "/v1/orgs/acme/audit/verify", REGISTRY_ACTION.ORIGIN_READ],
    [
      "GET",
      "/v1/packages/acme/http-kit/versions/1.0.0/dependency-graph",
      REGISTRY_ACTION.ORIGIN_READ,
    ],
    [
      "GET",
      "/v1/packages/acme/http-kit/versions/1.0.0/dependency-graph/export/json",
      REGISTRY_ACTION.ORIGIN_READ,
    ],
    [
      "GET",
      `/v1/resolutions/sha256:${"b".repeat(64)}/dependency-graph`,
      REGISTRY_ACTION.ORIGIN_READ,
    ],
  ];
  for (const [method, path, action] of cases) {
    assert.equal(classifyRegistryRequest(method, path).action, action, `${method} ${path}`);
    assert.equal(isRegistryOnlyPath(path), true, path);
  }
});

test("account, auth, malformed, and unknown routes fail closed before origin I/O", () => {
  for (const path of [
    "/",
    "/auth/login",
    "/shared-auth",
    "/api/v1/account/me",
    "/v1/account/me",
    "/v1/me",
    "/v1/session/bootstrap",
    "/v1/admin",
    "/v1/../secret",
    "/v1/%2e%2e/secret",
    "/v1/packages/acme/http-kit/extra",
  ]) {
    assert.equal(classifyRegistryRequest("GET", path).action, REGISTRY_ACTION.DENY_ROUTE, path);
    assert.equal(isRegistryOnlyPath(path), false, path);
  }
});

test("known route plus invalid method is distinct from an unknown route", () => {
  const decision = classifyRegistryRequest("DELETE", "/v1/packages/npm/lodash");
  assert.equal(decision.action, REGISTRY_ACTION.DENY_METHOD);
  assert.deepEqual(decision.allow, ["GET", "HEAD", "OPTIONS"]);
  assert.equal(
    classifyRegistryRequest("OPTIONS", "/v1/account/me").action,
    REGISTRY_ACTION.DENY_ROUTE,
  );
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
