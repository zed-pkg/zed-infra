import assert from "node:assert/strict";
import test from "node:test";

import {
  isAllowedRubyGemsDownloadUrl,
  rubyGemsDownload,
  rubyGemsVersions,
  rubyGemsVersionsUrl,
} from "./native-rubygems.js";

const BODY = [
  {
    number: "3.1.0",
    platform: "ruby",
    prerelease: false,
    sha: "a".repeat(64),
    created_at: "2026-08-01T00:00:00Z",
  },
  {
    number: "3.0.0-java",
    platform: "java",
    prerelease: false,
    sha: "b".repeat(64),
  },
  {
    number: "3.2.0.pre",
    platform: "ruby",
    prerelease: true,
    sha: "c".repeat(64),
  },
  {
    number: "2.9.0",
    platform: "ruby",
    prerelease: false,
    sha: "d".repeat(64),
  },
];

test("RubyGems staging uses exact per-gem public version metadata", () => {
  assert.equal(
    rubyGemsVersionsUrl("rack"),
    "https://rubygems.org/api/v1/versions/rack.json",
  );
  assert.equal(rubyGemsVersionsUrl("../rack"), null);
  assert.deepEqual(rubyGemsVersions(BODY), ["3.1.0", "2.9.0"]);
});

test("RubyGems staging binds ruby-platform release digest and exact gem URL", () => {
  const download = rubyGemsDownload(BODY, "rack", "3.1.0");
  assert.deepEqual(download, {
    url: "https://rubygems.org/downloads/rack-3.1.0.gem",
    sha256: "a".repeat(64),
    size: 0,
    native_format: "gem",
    published_at: "2026-08-01T00:00:00.000Z",
  });
  assert.equal(
    isAllowedRubyGemsDownloadUrl(download.url, "rack", "3.1.0"),
    true,
  );
});

test("RubyGems staging rejects alternate platform prerelease digest and path confusion", () => {
  assert.equal(rubyGemsDownload(BODY, "rack", "3.0.0-java"), null);
  assert.equal(rubyGemsDownload(BODY, "rack", "3.2.0.pre"), null);
  assert.equal(
    rubyGemsDownload([{ number: "3.1.0", platform: "ruby", sha: "bad" }], "rack", "3.1.0"),
    null,
  );
  for (const url of [
    "http://rubygems.org/downloads/rack-3.1.0.gem",
    "https://evil.test/downloads/rack-3.1.0.gem",
    "https://rubygems.org/downloads/other-3.1.0.gem",
    "https://rubygems.org/downloads/rack-3.1.1.gem",
    "https://user:pass@rubygems.org/downloads/rack-3.1.0.gem",
    "https://rubygems.org:444/downloads/rack-3.1.0.gem",
    "https://rubygems.org/downloads/rack-3.1.0.gem?x=1",
  ]) {
    assert.equal(isAllowedRubyGemsDownloadUrl(url, "rack", "3.1.0"), false, url);
  }
});

test("RubyGems stays a staged native format until shared ArtifactFormat supports gem", () => {
  const download = rubyGemsDownload(BODY, "rack", "3.1.0");
  assert.equal(download?.native_format, "gem");
  assert.equal(Object.prototype.hasOwnProperty.call(download, "format"), false);
});
