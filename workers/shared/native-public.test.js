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
  toVersionMetadata,
  versionsFromNativeBody,
} from "./native-public.js";

test("only audited normalized registries use the Zed DTO fallback", () => {
  const supported = {
    npm: "npm",
    "npmjs.com": "npm",
    "crates-io": "crates-io",
    cargo: "crates-io",
    pypi: "pypi",
    python: "pypi",
    nuget: "nuget",
    rubygems: "rubygems",
    gem: "rubygems",
    hex: "hex",
    hackage: "hackage",
  };
  for (const [token, id] of Object.entries(supported)) {
    assert.equal(publicNativeHostFromOrg(token)?.id, id, token);
  }

  // These remain first-class providers in native-provider-catalog.js, but
  // their coordinates/platform selection need the protocol-preserving gateway.
  for (const token of [
    "maven-central",
    "packagist",
    "go-proxy",
    "conan-center",
    "clojars",
    "cpan",
    "luarocks",
    "opam",
    "julia-general",
    "cran",
    "conda-forge",
    "cocoapods",
    "jsr",
    "terraform-registry",
    "docker-hub",
    "artifactory",
  ]) {
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

  assert.equal(
    isPrivateOrUnpublished(publicNativeHostFromOrg("pypi"), {
      info: { name: "requests" },
      releases: { "2.32.5": [] },
    }),
    false,
  );
});

test("metadata URLs are fixed to canonical public hosts", () => {
  const npm = publicNativeHostFromOrg("npm");
  assert.equal(nativePackageMetadataUrl(npm, "lodash"), "https://registry.npmjs.org/lodash");
  assert.equal(
    nativeVersionMetadataUrl(npm, "lodash", "4.17.21"),
    "https://registry.npmjs.org/lodash/4.17.21",
  );

  const crates = publicNativeHostFromOrg("crates-io");
  assert.equal(
    nativePackageMetadataUrl(crates, "serde"),
    "https://crates.io/api/v1/crates/serde",
  );

  const pypi = publicNativeHostFromOrg("pypi");
  assert.equal(
    nativeVersionMetadataUrl(pypi, "requests", "2.32.5"),
    "https://pypi.org/pypi/requests/2.32.5/json",
  );

  const nuget = publicNativeHostFromOrg("nuget");
  assert.equal(
    nativePackageMetadataUrl(nuget, "Newtonsoft.Json"),
    "https://api.nuget.org/v3-flatcontainer/newtonsoft.json/index.json",
  );

  const ruby = publicNativeHostFromOrg("rubygems");
  assert.equal(
    nativeVersionMetadataUrl(ruby, "rails", "8.1.3.1"),
    "https://rubygems.org/api/v2/rubygems/rails/versions/8.1.3.1.json",
  );

  const hex = publicNativeHostFromOrg("hex");
  assert.equal(nativePackageMetadataUrl(hex, "decimal"), "https://hex.pm/api/packages/decimal");

  const hackage = publicNativeHostFromOrg("hackage");
  assert.equal(
    nativePackageMetadataUrl(hackage, "aeson"),
    "https://hackage.haskell.org/package/aeson.json",
  );
});

test("tarball URLs are deterministic where the ecosystem protocol allows it", () => {
  const npm = publicNativeHostFromOrg("npm");
  assert.deepEqual(nativeTarballUrls(npm, "lodash", "4.17.21", "lodash-4.17.21.tgz"), [
    "https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz",
  ]);
  assert.deepEqual(nativeTarballUrls(npm, "lodash", "4.17.21", "other.tgz"), []);

  const nuget = publicNativeHostFromOrg("nuget");
  assert.deepEqual(nativeTarballUrls(nuget, "Newtonsoft.Json", "9.0.1"), [
    "https://api.nuget.org/v3-flatcontainer/newtonsoft.json/9.0.1/newtonsoft.json.9.0.1.nupkg",
  ]);

  const ruby = publicNativeHostFromOrg("rubygems");
  assert.deepEqual(nativeTarballUrls(ruby, "rails", "8.1.3.1"), [
    "https://rubygems.org/gems/rails-8.1.3.1.gem",
  ]);

  const hex = publicNativeHostFromOrg("hex");
  assert.deepEqual(nativeTarballUrls(hex, "decimal", "2.3.0"), [
    "https://repo.hex.pm/tarballs/decimal-2.3.0.tar",
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
      format: "tar.gz",
    },
  );
});

test("PyPI selects an sdist and preserves its upstream sha256", () => {
  const pypi = publicNativeHostFromOrg("pypi");
  const body = {
    info: { version: "2.32.5", summary: "HTTP client" },
    urls: [
      {
        filename: "requests-2.32.5.tar.gz",
        packagetype: "sdist",
        url: "https://files.pythonhosted.org/packages/aa/bb/requests-2.32.5.tar.gz",
        size: 100,
        digests: { sha256: "b".repeat(64) },
        upload_time_iso_8601: "2026-01-01T00:00:00Z",
      },
    ],
  };
  const download = downloadFromNativeVersion(pypi, "requests", "2.32.5", body);
  assert.equal(download.sha256, "b".repeat(64));
  assert.equal(download.format, "tar.gz");
  const metadata = toVersionMetadata(pypi, "pypi", "requests", "2.32.5", body, download);
  assert.deepEqual(metadata.mirrors, []);
  assert.equal(metadata.native_host, "pypi");
});

test("NuGet flat-container package is admitted as a ZIP artifact", () => {
  const nuget = publicNativeHostFromOrg("nuget");
  const download = downloadFromNativeVersion(nuget, "Newtonsoft.Json", "9.0.1", {
    versions: ["9.0.1"],
  });
  assert.deepEqual(download, {
    url: "https://api.nuget.org/v3-flatcontainer/newtonsoft.json/9.0.1/newtonsoft.json.9.0.1.nupkg",
    sha256: "",
    size: 0,
    format: "zip",
  });
});

test("RubyGems and Hex retain ecosystem bytes while exposing decodable Zed container metadata", () => {
  const ruby = publicNativeHostFromOrg("rubygems");
  assert.deepEqual(
    downloadFromNativeVersion(ruby, "rails", "8.1.3.1", {
      name: "rails",
      version: "8.1.3.1",
      sha: "c".repeat(64),
      yanked: false,
    }),
    {
      url: "https://rubygems.org/gems/rails-8.1.3.1.gem",
      sha256: "c".repeat(64),
      size: 0,
      format: "tar.gz",
    },
  );

  const hex = publicNativeHostFromOrg("hex");
  assert.equal(
    downloadFromNativeVersion(hex, "decimal", "2.3.0", {
      name: "decimal",
      releases: [{ version: "2.3.0", checksum: "D".repeat(64) }],
    }).sha256,
    "d".repeat(64),
  );
});
