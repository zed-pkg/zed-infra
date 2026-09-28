import assert from "node:assert/strict";
import test from "node:test";

import {
  clojarsCoordinate,
  clojarsDescription,
  clojarsDownload,
  clojarsLatest,
  clojarsMetadataUrl,
  clojarsRepoUrl,
  clojarsVersions,
  isAllowedClojarsDownloadUrl,
} from "./native-clojars.js";

const COORDINATE = "org.clojars.dantheman:test";
const BODY = {
  latest_version: "0.0.3-SNAPSHOT",
  latest_release: "0.0.2",
  jar_name: "test",
  group_name: "org.clojars.dantheman",
  description: "TEST",
  scm: { url: "https://github.com/fake/test" },
  recent_versions: [
    { version: "0.0.3-SNAPSHOT" },
    { version: "0.0.2" },
    { version: "0.0.1" },
  ],
};

test("Clojars metadata uses only the public artifact API", () => {
  assert.deepEqual(clojarsCoordinate(COORDINATE), ["org.clojars.dantheman", "test"]);
  assert.equal(
    clojarsMetadataUrl(COORDINATE),
    "https://clojars.org/api/artifacts/org.clojars.dantheman/test",
  );
  for (const bad of [
    "org.clojars.dantheman",
    "../group:test",
    "group:../test",
    "group/test:artifact",
    "group:artifact/other",
    "group:artifact\\other",
  ]) {
    assert.equal(clojarsMetadataUrl(bad), null, bad);
  }
});

test("Clojars package metadata excludes snapshots from deterministic fallback", () => {
  const versions = clojarsVersions(BODY, COORDINATE);
  assert.deepEqual(versions, ["0.0.2", "0.0.1"]);
  assert.equal(clojarsLatest(BODY, COORDINATE, versions), "0.0.2");
  assert.equal(clojarsDescription(BODY), "TEST");
  assert.equal(clojarsRepoUrl(BODY, COORDINATE), "https://github.com/fake/test");

  assert.deepEqual(clojarsVersions({ ...BODY, group_name: "other" }, COORDINATE), []);
  assert.deepEqual(clojarsVersions({ ...BODY, jar_name: "other" }, COORDINATE), []);
});

test("Clojars stable JAR path is deterministic and maps truthfully to zip", () => {
  assert.deepEqual(clojarsDownload(BODY, COORDINATE, "0.0.2"), {
    url: "https://repo.clojars.org/org/clojars/dantheman/test/0.0.2/test-0.0.2.jar",
    sha256: "",
    size: 0,
    format: "zip",
  });
  assert.equal(clojarsDownload(BODY, COORDINATE, "0.0.3-SNAPSHOT"), null);
  assert.equal(clojarsDownload(BODY, COORDINATE, "9.9.9"), null);
});

test("Clojars artifact validator rejects package version host and URL confusion", () => {
  const good = "https://repo.clojars.org/org/clojars/dantheman/test/0.0.2/test-0.0.2.jar";
  assert.equal(isAllowedClojarsDownloadUrl(good, COORDINATE, "0.0.2"), true);

  for (const url of [
    "http://repo.clojars.org/org/clojars/dantheman/test/0.0.2/test-0.0.2.jar",
    "https://repo.clojars.org.evil.test/org/clojars/dantheman/test/0.0.2/test-0.0.2.jar",
    "https://repo.clojars.org/org/clojars/dantheman/other/0.0.2/other-0.0.2.jar",
    "https://repo.clojars.org/org/clojars/dantheman/test/0.0.1/test-0.0.1.jar",
    "https://repo.clojars.org/org/clojars/dantheman/test/0.0.2/test-0.0.2.jar?x=1",
    "https://user:pass@repo.clojars.org/org/clojars/dantheman/test/0.0.2/test-0.0.2.jar",
  ]) {
    assert.equal(isAllowedClojarsDownloadUrl(url, COORDINATE, "0.0.2"), false, url);
  }
});

test("Clojars fallback page remains fixed when SCM is unsafe", () => {
  assert.equal(
    clojarsRepoUrl({ scm: { url: "http://evil.test/repo" } }, COORDINATE),
    "https://clojars.org/org.clojars.dantheman/test",
  );
});
