import assert from "node:assert/strict";
import test from "node:test";
import { MAX_LEASE_TTL_MS, leaseIsLive, normalizeExpectedVersion, normalizeKey, normalizeTtlMs } from "./protocol.mjs";

test("normalizes safe keys and rejects traversal", () => {
  assert.equal(normalizeKey(" package:scope/name "), "package:scope/name");
  assert.throws(() => normalizeKey("../escape"), TypeError);
  assert.throws(() => normalizeKey(""), TypeError);
});

test("bounds lease TTL", () => {
  assert.equal(normalizeTtlMs(1_000), 1_000);
  assert.equal(normalizeTtlMs(MAX_LEASE_TTL_MS), MAX_LEASE_TTL_MS);
  assert.throws(() => normalizeTtlMs(999), RangeError);
});

test("lease liveness and versions are deterministic", () => {
  assert.equal(leaseIsLive({ expires_at: 5_000 }, 4_999), true);
  assert.equal(leaseIsLive({ expires_at: 5_000 }, 5_000), false);
  assert.equal(normalizeExpectedVersion(0), 0);
  assert.throws(() => normalizeExpectedVersion(-1), RangeError);
});
