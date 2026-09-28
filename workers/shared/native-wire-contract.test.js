import assert from "node:assert/strict";
import test from "node:test";

import {
  downloadFromNativeVersion,
  publicNativeHostFromOrg,
  toVersionMetadata,
} from "./native-public.js";

const RUST_ARTIFACT_FORMATS = new Set(["tar.gz", "zip"]);

test("native version metadata uses only Rust ArtifactFormat values and no invented mirror kind", () => {
  const crates = publicNativeHostFromOrg("crates-io");
  const candidate = downloadFromNativeVersion(crates, "serde", "1.0.0", {
    version: {
      num: "1.0.0",
      checksum: "a".repeat(64),
      crate_size: 1234,
      dl_path: "/api/v1/crates/serde/1.0.0/download",
      yanked: false,
    },
  });

  assert.ok(candidate);
  assert.equal(RUST_ARTIFACT_FORMATS.has(candidate.format), true);

  const metadata = toVersionMetadata(
    crates,
    "crates-io",
    "serde",
    "1.0.0",
    { version: { created_at: "2026-01-01T00:00:00Z" } },
    candidate,
  );
  assert.deepEqual(metadata.mirrors, []);
  assert.equal(metadata.format, "tar.gz");
  assert.equal(metadata.sha256, "a".repeat(64));
});

test("NuGet nupkg maps to the existing zip wire format", () => {
  const nuget = publicNativeHostFromOrg("nuget");
  const candidate = downloadFromNativeVersion(nuget, "Newtonsoft.Json", "13.0.3", {
    versions: ["13.0.3"],
  });

  assert.ok(candidate);
  assert.equal(candidate.format, "zip");
  assert.equal(RUST_ARTIFACT_FORMATS.has(candidate.format), true);
});
