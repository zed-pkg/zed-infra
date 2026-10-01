import assert from "node:assert/strict";
import test from "node:test";

import {
  cpanDownload,
  cpanMetadataUrl,
  cpanVersions,
  cranDownload,
  cranMetadataUrl,
  cranVersions,
  isCranDescriptionResponse,
  parseCranDescription,
  stagedPackageDescription,
  stagedRepoUrl,
} from "./native-cpan-cran.js";

test("MetaCPAN metadata URLs stay on the canonical API endpoint", () => {
  assert.equal(
    cpanMetadataUrl("HTTP-Message"),
    "https://fastapi.metacpan.org/v1/download_url/HTTP-Message",
  );
  assert.equal(
    cpanMetadataUrl("HTTP-Message", "6.36"),
    "https://fastapi.metacpan.org/v1/download_url/HTTP-Message?version=6.36",
  );
  assert.equal(cpanMetadataUrl("../escape"), null);
  assert.equal(cpanMetadataUrl("HTTP-Message", "../6.36"), null);
});

test("MetaCPAN download metadata binds distribution version checksum size and archive path", () => {
  const candidate = cpanDownload(
    {
      version: "6.36",
      release: "HTTP-Message-6.36",
      checksum_sha256: "a".repeat(64),
      size: 12345,
      download_url:
        "https://cpan.metacpan.org/authors/id/O/OA/OALDERS/HTTP-Message-6.36.tar.gz",
      date: "2026-01-02T03:04:05Z",
    },
    "HTTP-Message",
    "6.36",
  );
  assert.deepEqual(candidate, {
    url: "https://cpan.metacpan.org/authors/id/O/OA/OALDERS/HTTP-Message-6.36.tar.gz",
    sha256: "a".repeat(64),
    size: 12345,
    format: "tar.gz",
    published_at: "2026-01-02T03:04:05.000Z",
  });

  for (const body of [
    {
      version: "6.35",
      release: "HTTP-Message-6.35",
      checksum_sha256: "a".repeat(64),
      size: 12345,
      download_url:
        "https://cpan.metacpan.org/authors/id/O/OA/OALDERS/HTTP-Message-6.35.tar.gz",
    },
    {
      version: "6.36",
      release: "Other-6.36",
      checksum_sha256: "a".repeat(64),
      size: 12345,
      download_url: "https://cpan.metacpan.org/authors/id/O/OA/OALDERS/Other-6.36.tar.gz",
    },
    {
      version: "6.36",
      release: "HTTP-Message-6.36",
      checksum_sha256: "bad",
      size: 12345,
      download_url:
        "https://cpan.metacpan.org/authors/id/O/OA/OALDERS/HTTP-Message-6.36.tar.gz",
    },
    {
      version: "6.36",
      release: "HTTP-Message-6.36",
      checksum_sha256: "a".repeat(64),
      size: 0,
      download_url:
        "https://cpan.metacpan.org/authors/id/O/OA/OALDERS/HTTP-Message-6.36.tar.gz",
    },
    {
      version: "6.36",
      release: "HTTP-Message-6.36",
      checksum_sha256: "a".repeat(64),
      size: 12345,
      download_url: "https://evil.test/HTTP-Message-6.36.tar.gz",
    },
    {
      version: "6.36",
      release: "HTTP-Message-6.36",
      checksum_sha256: "a".repeat(64),
      size: 12345,
      download_url:
        "https://cpan.metacpan.org/authors/id/O/OA/OALDERS/Other-6.36.tar.gz",
    },
    {
      version: "6.36",
      release: "HTTP-Message-6.36",
      checksum_sha256: "a".repeat(64),
      size: 12345,
      download_url:
        "https://user:pass@cpan.metacpan.org/authors/id/O/OA/OALDERS/HTTP-Message-6.36.tar.gz",
    },
  ]) {
    assert.equal(cpanDownload(body, "HTTP-Message", "6.36"), null);
  }
  assert.deepEqual(cpanVersions({ version: "6.36" }), ["6.36"]);
  assert.deepEqual(cpanVersions({ version: "../bad" }), []);
});

test("CRAN metadata is confined to per-package DESCRIPTION", () => {
  assert.equal(
    cranMetadataUrl("jsonlite"),
    "https://cran.r-project.org/web/packages/jsonlite/DESCRIPTION",
  );
  assert.equal(cranMetadataUrl("../jsonlite"), null);

  const good = new Response("Package: jsonlite\nVersion: 2.0.0\n", {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
  Object.defineProperty(good, "url", {
    value: "https://cran.r-project.org/web/packages/jsonlite/DESCRIPTION",
  });
  assert.equal(isCranDescriptionResponse(good, good.headers.get("content-type")), true);

  for (const url of [
    "http://cran.r-project.org/web/packages/jsonlite/DESCRIPTION",
    "https://evil.test/web/packages/jsonlite/DESCRIPTION",
    "https://cran.r-project.org/web/packages/jsonlite/index.html",
    "https://cran.r-project.org/web/packages/jsonlite/DESCRIPTION?x=1",
    "https://user:pass@cran.r-project.org/web/packages/jsonlite/DESCRIPTION",
  ]) {
    const response = new Response("Package: jsonlite\nVersion: 2.0.0\n", {
      headers: { "content-type": "text/plain" },
    });
    Object.defineProperty(response, "url", { value: url });
    assert.equal(isCranDescriptionResponse(response, "text/plain"), false, url);
  }
});

test("CRAN DESCRIPTION parser handles continuation lines but only whitelisted fields", () => {
  const body = parseCranDescription(
    [
      "Package: jsonlite",
      "Version: 2.0.0",
      "Title: A Robust, High Performance JSON Parser and Generator for R",
      "Description: A reasonably fast JSON parser.",
      "  Continuation text stays attached.",
      "URL: https://jeroen.r-universe.dev/jsonlite",
      "Maintainer: ignored@example.test",
      "__proto__: polluted",
      "",
    ].join("\n"),
  );
  assert.deepEqual(body, {
    Package: "jsonlite",
    Version: "2.0.0",
    Title: "A Robust, High Performance JSON Parser and Generator for R",
    Description: "A reasonably fast JSON parser. Continuation text stays attached.",
    URL: "https://jeroen.r-universe.dev/jsonlite",
  });
  assert.equal(parseCranDescription("Package: ../bad\nVersion: 1.0.0\n"), null);
  assert.equal(parseCranDescription("Package: good\nVersion: ../bad\n"), null);
});

test("CRAN current source artifact is deterministic and version-bound", () => {
  const body = {
    Package: "jsonlite",
    Version: "2.0.0",
    Description: "JSON parser",
  };
  assert.deepEqual(cranDownload(body, "jsonlite", "2.0.0"), {
    url: "https://cran.r-project.org/src/contrib/jsonlite_2.0.0.tar.gz",
    sha256: "",
    size: 0,
    format: "tar.gz",
  });
  assert.equal(cranDownload(body, "jsonlite", "1.9.0"), null);
  assert.equal(cranDownload(body, "other", "2.0.0"), null);
  assert.deepEqual(cranVersions(body), ["2.0.0"]);
  assert.equal(stagedPackageDescription("cran", body), "JSON parser");
});

test("staged registry landing URLs are fixed public pages", () => {
  assert.equal(stagedRepoUrl("cpan", "HTTP-Message"), "https://metacpan.org/dist/HTTP-Message");
  assert.equal(
    stagedRepoUrl("cran", "jsonlite"),
    "https://cran.r-project.org/web/packages/jsonlite/",
  );
  assert.equal(stagedRepoUrl("cpan", "../escape"), null);
});
