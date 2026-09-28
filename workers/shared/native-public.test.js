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

const ACTIVE = ["crates-io", "hackage", "jsr", "maven", "npm", "nuget", "pypi"];

test("only protocol-audited public registries are active", () => {
  assert.deepEqual(publicNativeFallbackIds().sort(), ACTIVE);
  assert.equal(publicNativeHostFromOrg("npm")?.id, "npm");
  assert.equal(publicNativeHostFromOrg("cargo")?.id, "crates-io");
  assert.equal(publicNativeHostFromOrg("pip")?.id, "pypi");
  assert.equal(publicNativeHostFromOrg("gradle")?.id, "maven");
  assert.equal(publicNativeHostFromOrg("dotnet")?.id, "nuget");
  assert.equal(publicNativeHostFromOrg("cabal")?.id, "hackage");
  assert.equal(publicNativeHostFromOrg("deno")?.id, "jsr");

  for (const token of [
    "rubygems",
    "hex",
    "packagist",
    "go-proxy",
    "conan",
    "clojars",
    "cpan",
    "luarocks",
    "opam",
    "julia",
    "cran",
    "conda-forge",
    "cocoapods",
    "terraform",
    "docker",
    "test-pypi",
    "artifactory",
  ]) {
    assert.equal(publicNativeHostFromOrg(token), null, token);
  }
});

test("safe coordinates are transport syntax, never proof that a package is public", () => {
  const npm = publicNativeHostFromOrg("npm");
  assert.equal(isHighLikelihoodPublic(npm, "lodash"), true);
  assert.equal(isHighLikelihoodPublic(npm, "private-sdk"), true);
  assert.equal(isHighLikelihoodPublic(npm, "../etc/passwd"), false);
  assert.equal(isHighLikelihoodPublic(npm, "scope/name"), false);

  const encodedScope = encodeNativeCoordinate("@scope/name");
  assert.equal(isHighLikelihoodPublic(npm, encodedScope), true);

  const jsr = publicNativeHostFromOrg("jsr");
  assert.equal(isHighLikelihoodPublic(jsr, encodeNativeCoordinate("@luca/cases")), true);
  assert.equal(isHighLikelihoodPublic(jsr, "unscoped"), false);
  assert.equal(nativeHeaders().Authorization, undefined);
  assert.equal(nativeHeaders().authorization, undefined);
});

test("anonymous metadata rejects private, missing, and empty registry responses", () => {
  const npm = publicNativeHostFromOrg("npm");
  assert.equal(
    isPrivateOrUnpublished(npm, { private: true, versions: { "1.0.0": {} } }),
    true,
  );
  assert.equal(isPrivateOrUnpublished(npm, { versions: { "1.0.0": {} } }), false);

  const pypi = publicNativeHostFromOrg("pypi");
  assert.equal(isPrivateOrUnpublished(pypi, { info: { name: "requests" }, releases: {} }), false);
  assert.equal(isPrivateOrUnpublished(pypi, { info: { name: "requests" } }), true);

  const maven = publicNativeHostFromOrg("maven");
  assert.equal(isPrivateOrUnpublished(maven, { response: { docs: [{ v: "1.0.0" }] } }), false);
  assert.equal(isPrivateOrUnpublished(maven, { response: { docs: [] } }), true);

  const nuget = publicNativeHostFromOrg("nuget");
  assert.equal(isPrivateOrUnpublished(nuget, { versions: ["1.0.0"] }), false);
  assert.equal(isPrivateOrUnpublished(nuget, { versions: [] }), true);

  const hackage = publicNativeHostFromOrg("hackage");
  assert.equal(isPrivateOrUnpublished(hackage, { "2.2.3.0": true }), false);
  assert.equal(isPrivateOrUnpublished(hackage, {}), true);
});

test("metadata URLs are canonical and coordinates never become arbitrary paths", () => {
  const npm = publicNativeHostFromOrg("npm");
  assert.equal(nativePackageMetadataUrl(npm, "lodash"), "https://registry.npmjs.org/lodash");
  assert.equal(
    nativeVersionMetadataUrl(npm, "lodash", "4.17.21"),
    "https://registry.npmjs.org/lodash/4.17.21",
  );

  const scoped = encodeNativeCoordinate("@scope/pkg");
  assert.equal(
    nativePackageMetadataUrl(npm, scoped),
    "https://registry.npmjs.org/%40scope%2Fpkg",
  );

  const crates = publicNativeHostFromOrg("crates-io");
  assert.equal(nativePackageMetadataUrl(crates, "serde"), "https://crates.io/api/v1/crates/serde");

  const pypi = publicNativeHostFromOrg("pypi");
  assert.equal(nativePackageMetadataUrl(pypi, "requests"), "https://pypi.org/pypi/requests/json");

  const maven = publicNativeHostFromOrg("maven");
  const mavenName = encodeNativeCoordinate("com.google.guava:guava");
  const mavenPackage = new URL(nativePackageMetadataUrl(maven, mavenName));
  assert.equal(mavenPackage.origin, "https://search.maven.org");
  assert.equal(mavenPackage.pathname, "/solrsearch/select");
  assert.equal(mavenPackage.searchParams.get("q"), 'g:"com.google.guava" AND a:"guava"');
  assert.equal(mavenPackage.searchParams.get("core"), "gav");
  assert.equal(mavenPackage.searchParams.get("wt"), "json");

  const mavenVersion = new URL(nativeVersionMetadataUrl(maven, mavenName, "33.4.8-jre"));
  assert.equal(
    mavenVersion.searchParams.get("q"),
    'g:"com.google.guava" AND a:"guava" AND v:"33.4.8-jre" AND p:"jar"',
  );

  const nuget = publicNativeHostFromOrg("nuget");
  assert.equal(
    nativePackageMetadataUrl(nuget, "Newtonsoft.Json"),
    "https://api.nuget.org/v3-flatcontainer/newtonsoft.json/index.json",
  );

  const hackage = publicNativeHostFromOrg("hackage");
  assert.equal(
    nativePackageMetadataUrl(hackage, "aeson"),
    "https://hackage.haskell.org/package/aeson",
  );

  const jsr = publicNativeHostFromOrg("jsr");
  const jsrName = encodeNativeCoordinate("@luca/cases");
  assert.equal(nativePackageMetadataUrl(jsr, jsrName), "https://npm.jsr.io/@jsr/luca__cases");
  assert.equal(
    nativeVersionMetadataUrl(jsr, jsrName, "1.0.0"),
    "https://npm.jsr.io/@jsr/luca__cases",
  );
  assert.equal(nativePackageMetadataUrl(jsr, "unscoped"), null);
});

test("deterministic artifact URLs are bound to package and version", () => {
  const npm = publicNativeHostFromOrg("npm");
  assert.deepEqual(nativeTarballUrls(npm, "lodash", "4.17.21", "lodash-4.17.21.tgz"), [
    "https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz",
  ]);
  assert.deepEqual(nativeTarballUrls(npm, "lodash", "4.17.21", "other.tgz"), []);

  const crates = publicNativeHostFromOrg("crates-io");
  assert.deepEqual(nativeTarballUrls(crates, "serde", "1.0.0", "serde-1.0.0.crate"), [
    "https://static.crates.io/crates/serde/serde-1.0.0.crate",
  ]);

  const maven = publicNativeHostFromOrg("maven");
  const mavenName = encodeNativeCoordinate("com.google.guava:guava");
  assert.deepEqual(
    nativeTarballUrls(maven, mavenName, "33.4.8-jre", "guava-33.4.8-jre.jar"),
    [
      "https://repo1.maven.org/maven2/com/google/guava/guava/33.4.8-jre/guava-33.4.8-jre.jar",
    ],
  );

  const nuget = publicNativeHostFromOrg("nuget");
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

  const hackage = publicNativeHostFromOrg("hackage");
  assert.deepEqual(nativeTarballUrls(hackage, "aeson", "2.2.3.0", "aeson-2.2.3.0.tar.gz"), [
    "https://hackage.haskell.org/package/aeson-2.2.3.0/aeson-2.2.3.0.tar.gz",
  ]);
});

test("artifact validators reject cross-package, cross-version, query, and credential confusion", () => {
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
    "https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz?x=1",
  ]) {
    assert.equal(isAllowedNativeDownloadUrl(npm, url, "lodash", "4.17.21"), false, url);
  }

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
      "https://files.pythonhosted.org/packages/aa/bb/deadbeef/not-requests-2.32.5.tar.gz",
      "requests",
      "2.32.5",
    ),
    false,
  );

  const maven = publicNativeHostFromOrg("maven");
  const mavenName = encodeNativeCoordinate("com.google.guava:guava");
  assert.equal(
    isAllowedNativeDownloadUrl(
      maven,
      "https://repo1.maven.org/maven2/com/google/guava/guava/33.4.8-jre/guava-33.4.8-jre.jar",
      mavenName,
      "33.4.8-jre",
    ),
    true,
  );
  assert.equal(
    isAllowedNativeDownloadUrl(
      maven,
      "https://repo1.maven.org/maven2/com/google/guava/failureaccess/1.0/failureaccess-1.0.jar",
      mavenName,
      "33.4.8-jre",
    ),
    false,
  );

  const hackage = publicNativeHostFromOrg("hackage");
  assert.equal(
    isAllowedNativeDownloadUrl(
      hackage,
      "https://hackage.haskell.org/package/aeson-2.2.3.0/aeson-2.2.3.0.tar.gz",
      "aeson",
      "2.2.3.0",
    ),
    true,
  );

  const jsr = publicNativeHostFromOrg("jsr");
  const jsrName = encodeNativeCoordinate("@luca/cases");
  assert.equal(
    isAllowedNativeDownloadUrl(
      jsr,
      "https://npm.jsr.io/~/11/@jsr/luca__cases/1.0.0.tgz",
      jsrName,
      "1.0.0",
    ),
    true,
  );
  for (const url of [
    "https://npm.jsr.io/~/11/@jsr/other__package/1.0.0.tgz",
    "https://npm.jsr.io/~/11/@jsr/luca__cases/2.0.0.tgz",
    "https://npm.jsr.io/@jsr/luca__cases/-/luca__cases-1.0.0.tgz",
    "https://npm.jsr.io/~/revision/@jsr/luca__cases/1.0.0.tgz",
  ]) {
    assert.equal(isAllowedNativeDownloadUrl(jsr, url, jsrName, "1.0.0"), false, url);
  }
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

test("package metadata exposes only validated installable versions", () => {
  const npm = publicNativeHostFromOrg("npm");
  const npmMeta = toPackageMetadata(npm, "npm", "left-pad", {
    description: "pad",
    "dist-tags": { latest: "1.3.0" },
    versions: { "1.0.0": {}, "1.3.0": {}, "../escape": {} },
  });
  assert.deepEqual(npmMeta.versions, ["1.3.0", "1.0.0"]);
  assert.equal(npmMeta.latest, "1.3.0");

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

  const maven = publicNativeHostFromOrg("maven");
  const mavenName = encodeNativeCoordinate("com.google.guava:guava");
  assert.deepEqual(
    versionsFromNativeBody(
      maven,
      {
        response: {
          docs: [
            { g: "com.google.guava", a: "guava", v: "33.4.8-jre", p: "jar" },
            { g: "com.google.guava", a: "guava", v: "33.4.7-jre", p: "jar" },
            { g: "evil", a: "guava", v: "99.0.0", p: "jar" },
            { g: "com.google.guava", a: "guava", v: "1.0.0", p: "pom" },
          ],
        },
      },
      mavenName,
    ),
    ["33.4.8-jre", "33.4.7-jre"],
  );

  const hackage = publicNativeHostFromOrg("hackage");
  assert.deepEqual(
    versionsFromNativeBody(hackage, { "2.2.3.0": true, "2.2.2.0": false, "../bad": true }),
    ["2.2.3.0", "2.2.2.0"],
  );

  const jsr = publicNativeHostFromOrg("jsr");
  assert.deepEqual(
    versionsFromNativeBody(jsr, {
      versions: { "1.0.1": {}, "1.0.0": {}, "../bad": {} },
    }),
    ["1.0.1", "1.0.0"],
  );
});

test("version candidates stay inside the Rust tar.gz/zip artifact contract", () => {
  const npm = publicNativeHostFromOrg("npm");
  const npmCandidate = downloadFromNativeVersion(npm, "lodash", "4.17.21", {
    dist: {
      tarball: "https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz",
      integrity: "sha512-not-a-sha256",
      unpackedSize: 999999,
    },
  });
  assert.equal(npmCandidate.format, "tar.gz");
  assert.equal(npmCandidate.size, 0);

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
  assert.equal(crateCandidate.format, "tar.gz");

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
      },
    ],
  });
  assert.equal(pypiCandidate.format, "tar.gz");
  assert.equal(pypiCandidate.sha256, "b".repeat(64));
  assert.equal(
    downloadFromNativeVersion(pypi, "requests", "2.32.5", {
      urls: [
        {
          filename: "requests-2.32.5.tar.gz",
          packagetype: "sdist",
          yanked: false,
          digests: { sha256: "b".repeat(64) },
          url: "https://files.pythonhosted.org/packages/aa/bb/deadbeef/not-requests-2.32.5.tar.gz",
        },
      ],
    }),
    null,
  );

  const maven = publicNativeHostFromOrg("maven");
  const mavenName = encodeNativeCoordinate("com.google.guava:guava");
  const mavenCandidate = downloadFromNativeVersion(maven, mavenName, "33.4.8-jre", {
    response: {
      docs: [
        {
          g: "com.google.guava",
          a: "guava",
          v: "33.4.8-jre",
          p: "jar",
          timestamp: 1760000000000,
        },
      ],
    },
  });
  assert.equal(mavenCandidate.format, "zip");

  const nuget = publicNativeHostFromOrg("nuget");
  const nugetCandidate = downloadFromNativeVersion(nuget, "Newtonsoft.Json", "13.0.3", {
    versions: ["12.0.1", "13.0.3"],
  });
  assert.equal(nugetCandidate.format, "zip");

  const hackage = publicNativeHostFromOrg("hackage");
  const hackageCandidate = downloadFromNativeVersion(hackage, "aeson", "2.2.3.0", {
    "2.2.3.0": true,
  });
  assert.equal(hackageCandidate.format, "tar.gz");

  const jsr = publicNativeHostFromOrg("jsr");
  const jsrName = encodeNativeCoordinate("@luca/cases");
  const jsrCandidate = downloadFromNativeVersion(jsr, jsrName, "1.0.0", {
    versions: {
      "1.0.0": {
        dist: {
          tarball: "https://npm.jsr.io/~/11/@jsr/luca__cases/1.0.0.tgz",
          integrity: "sha512-edge-will-hash-this",
        },
      },
    },
  });
  assert.equal(jsrCandidate.format, "tar.gz");

  for (const candidate of [
    npmCandidate,
    crateCandidate,
    pypiCandidate,
    mavenCandidate,
    nugetCandidate,
    hackageCandidate,
    jsrCandidate,
  ]) {
    assert.ok(candidate);
    assert.ok(["tar.gz", "zip"].includes(candidate.format), candidate.format);
  }
});
