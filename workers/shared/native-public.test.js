import assert from "node:assert/strict";
import test from "node:test";

import {
  downloadFromNativeVersion,
  isAllowedNativeDownloadUrl,
  isPrivateOrUnpublished,
  nativePackageMetadataUrl,
  nativeVersionMetadataUrl,
  publicNativeFallbackIds,
  publicNativeHostFromOrg,
  readBoundedJson,
} from "./native-public.js";

test("production native dispatcher exposes exactly ten audited adapters", () => {
  assert.deepEqual(publicNativeFallbackIds().sort(), [
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
  assert.equal(publicNativeHostFromOrg("cpan")?.id, "cpan");
  assert.equal(publicNativeHostFromOrg("cran")?.id, "cran");
  for (const token of [
    "rubygems",
    "hex",
    "packagist",
    "conan",
    "clojars",
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

test("production CPAN adapter requires exact trusted digest and size metadata", () => {
  const host = publicNativeHostFromOrg("cpan");
  const body = {
    version: "6.36",
    release: "HTTP-Message-6.36",
    checksum_sha256: "a".repeat(64),
    size: 12345,
    download_url:
      "https://cpan.metacpan.org/authors/id/O/OA/OALDERS/HTTP-Message-6.36.tar.gz",
  };
  assert.equal(
    nativeVersionMetadataUrl(host, "HTTP-Message", "6.36"),
    "https://fastapi.metacpan.org/v1/download_url/HTTP-Message?version=6.36",
  );
  assert.equal(isPrivateOrUnpublished(host, body), false);
  assert.equal(isPrivateOrUnpublished(host, { ...body, size: 0 }), true);
  const download = downloadFromNativeVersion(host, "HTTP-Message", "6.36", body);
  assert.equal(download?.sha256, "a".repeat(64));
  assert.equal(download?.size, 12345);
  assert.equal(
    isAllowedNativeDownloadUrl(host, download.url, "HTTP-Message", "6.36"),
    true,
  );
  assert.equal(
    isAllowedNativeDownloadUrl(
      host,
      "https://cpan.metacpan.org/authors/id/O/OA/OALDERS/Other-6.36.tar.gz",
      "HTTP-Message",
      "6.36",
    ),
    false,
  );
});

test("production CRAN adapter parses only exact DESCRIPTION endpoints", async () => {
  const host = publicNativeHostFromOrg("cran");
  assert.equal(
    nativePackageMetadataUrl(host, "jsonlite"),
    "https://cran.r-project.org/web/packages/jsonlite/DESCRIPTION",
  );
  const response = new Response(
    "Package: jsonlite\nVersion: 2.0.0\nDescription: JSON parser\n",
    { headers: { "content-type": "text/plain; charset=utf-8" } },
  );
  Object.defineProperty(response, "url", {
    value: "https://cran.r-project.org/web/packages/jsonlite/DESCRIPTION",
  });
  const body = await readBoundedJson(response);
  assert.deepEqual(body, {
    Package: "jsonlite",
    Version: "2.0.0",
    Description: "JSON parser",
  });
  const download = downloadFromNativeVersion(host, "jsonlite", "2.0.0", body);
  assert.deepEqual(download, {
    url: "https://cran.r-project.org/src/contrib/jsonlite_2.0.0.tar.gz",
    sha256: "",
    size: 0,
    format: "tar.gz",
  });
  assert.equal(
    isAllowedNativeDownloadUrl(host, download.url, "jsonlite", "2.0.0"),
    true,
  );
});
