import assert from "node:assert/strict";
import test from "node:test";

import {
  REGISTRY_ACTION,
  classifyRegistryRequest,
  parseRegistryPath,
} from "./github-fallback.js";
import { encodeNativeCoordinate } from "./native-registry-catalog.js";

test("encoded native coordinates reach fallback package and version routes", () => {
  const coordinate = encodeNativeCoordinate("vendor/package");
  const packagePath = `/v1/packages/packagist/${coordinate}`;
  const versionPath = `${packagePath}/versions/1.2.3`;

  assert.deepEqual(parseRegistryPath(packagePath), {
    kind: "get_package",
    org: "packagist",
    name: coordinate,
  });
  assert.deepEqual(parseRegistryPath(versionPath), {
    kind: "get_version",
    org: "packagist",
    name: coordinate,
    version: "1.2.3",
  });
  assert.equal(
    classifyRegistryRequest("GET", packagePath).action,
    REGISTRY_ACTION.FALLBACK_READ,
  );
  assert.equal(
    classifyRegistryRequest("GET", versionPath).action,
    REGISTRY_ACTION.FALLBACK_READ,
  );
});

test("native coordinate route grammar remains path-segment confined", () => {
  for (const name of [
    "z1_",
    "z1_%%%",
    "z1_bad/name",
    "z1_bad.name",
    `z1_${"A".repeat(1401)}`,
  ]) {
    assert.equal(
      classifyRegistryRequest("GET", `/v1/packages/packagist/${name}`).action,
      REGISTRY_ACTION.DENY_ROUTE,
      name,
    );
  }
});
