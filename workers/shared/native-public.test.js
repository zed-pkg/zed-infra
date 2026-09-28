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
  readBoundedJson,
} from "./native-public.js";

test("production native dispatcher exposes exactly twelve audited adapters", () => {
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
  assert.equal(publicNativeHostFromOrg("clojars")?.id, "clojars");
  assert.equal(publicNativeHostFromOrg("cpan")?.id, "cpan");
  assert.equal(publicNativeHostFromOrg("cran")?.id, "cran");
  assert.equal(publicNativeHostFromOrg("packagist")?.id, "packagist");
  assert.equal(publicNativeHostFromOrg("composer")?.id, "packagist");
  for (const token of [
    "rubygems",
    "hex",
    "conan",
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

test("production Clojars adapter binds stable Maven identity and JAR path", () => {
  const host = publicNativeHostFromOrg("clojars");
  const name = encodeNativeCoordinate("org.clojars.dantheman:test");
  const body = {
    latest_version: "0.0.3-SNAPSHOT",
    latest_release: "0.0.2",
    jar_name: "test",
    group_name: "org.clojars.dantheman",
    recent_versions: [
      { version: "0.0.3-SNAPSHOT" },
      { version: "0.0.2" },
    ],
  };
  assert.equal(
    nativePackageMetadataUrl(host, name),
    "https://clojars.org/api/artifacts/org.clojars.dantheman/test",
  );
  assert.equal(nativeVersionMetadataUrl(host, name, "0.0.3-SNAPSHOT"), null);
  assert.equal(isPrivateOrUnpublished(host, body), false);
  const download = downloadFromNativeVersion(host, name, "0.0.2", body);
  assert.deepEqual(download, {
    url: "https://repo.clojars.org/org/clojars/dantheman/test/0.0.2/test-0.0.2.jar",
    sha256: "",
    size: 0,
    format: "zip",
  });
  assert.equal(isAllowedNativeDownloadUrl(host, download.url, name, "0.0.2"), true);
  assert.equal(
    isAllowedNativeDownloadUrl(
      host,
      "https://repo.clojars.org/org/clojars/dantheman/other/0.0.2/other-0.0.2.jar",
      name,
      "0.0.2",
    ),
    false,
  );
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

test("production Packagist adapter binds stable package identity to an immutable GitHub commit", () => {
  const host = publicNativeHostFromOrg("packagist");
  const coordinate = "vendor/package";
  const name = encodeNativeCoordinate(coordinate);
  const reference = "a".repeat(40);
  const body = {
    minified: "composer/2.0",
    packages: {
      [coordinate]: [
        {
          name: coordinate,
          version: "1.2.3",
          source: {
            type: "git",
            url: "https://github.com/upstream/project.git",
            reference,
          },
          dist: {
            type: "zip",
            url: `https://api.github.com/repos/upstream/project/zipball/${reference}`,
            reference,
            shasum: "",
          },
        },
      ],
    },
  };
  assert.equal(
    nativePackageMetadataUrl(host, name),
    "https://repo.packagist.org/p2/vendor/package.json",
  );
  assert.equal(nativeVersionMetadataUrl(host, name, "dev-main"), null);
  const download = downloadFromNativeVersion(host, name, "1.2.3", body);
  assert.equal(download?.format, "zip");
  assert.equal(
    download?.url,
    `https://codeload.github.com/upstream/project/zip/${reference}`,
  );
  assert.equal(
    isAllowedNativeDownloadUrl(host, download.url, name, "1.2.3", download),
    true,
  );
  assert.equal(
    isAllowedNativeDownloadUrl(
      host,
      `https://codeload.github.com/upstream/project/zip/${"b".repeat(40)}`,
      name,
      "1.2.3",
      download,
    ),
    false,
  );
});
