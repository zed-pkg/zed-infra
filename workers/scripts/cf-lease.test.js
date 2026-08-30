import assert from "node:assert/strict";
import test from "node:test";
import {
  ALLOWED_WORKERS,
  buildLeaseRecord,
  decideAcquire,
  isAllowedWorker,
  leaseKey,
  parseArgs,
  readLiveWorker,
} from "./cf-lease.mjs";

test("live snapshots use Worker-list metadata instead of parsing downloaded source", async () => {
  const realFetch = globalThis.fetch;
  const modifiedOn = "2026-08-30T00:24:25.841934Z";
  globalThis.fetch = async (url) => {
    assert.match(String(url), /\/workers\/scripts$/);
    return new Response(
      JSON.stringify({
        success: true,
        result: [
          {
            id: "zpkg-app-proxy",
            created_on: "2026-08-30T00:20:38.407938Z",
            modified_on: modifiedOn,
            etag: "821595826ab1b9fe3af2f913796a0c6f",
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  try {
    assert.deepEqual(await readLiveWorker("token", "zpkg-app-proxy", "account"), {
      id: "zpkg-app-proxy",
      created_on: "2026-08-30T00:20:38.407938Z",
      modified_on: modifiedOn,
      etag: "821595826ab1b9fe3af2f913796a0c6f",
    });
    assert.equal(await readLiveWorker("token", "zpkg-user-proxy", "account"), null);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("foreign workers cannot be leased or overwritten", () => {
  assert.equal(isAllowedWorker("sonusauris-app-proxy"), false);
  assert.equal(isAllowedWorker("zpkg-cdn"), true);
  const decision = decideAcquire({
    worker: "sonusauris-app-proxy",
    live: { modified_on: "2026-01-01T00:00:00.000Z" },
    expectedModifiedOn: "2026-01-01T00:00:00.000Z",
    createMissing: false,
    existingLease: null,
    nowMs: 0,
    holder: "agent",
  });
  assert.equal(decision.ok, false);
  assert.match(decision.reason, /allowlist/);
});

test("existing live worker refuses acquire without --if-match", () => {
  const decision = decideAcquire({
    worker: "zpkg-cdn",
    live: { modified_on: "2026-08-29T19:10:25.251597Z" },
    expectedModifiedOn: null,
    createMissing: false,
    existingLease: null,
    nowMs: 0,
    holder: "agent",
  });
  assert.equal(decision.ok, false);
  assert.match(decision.reason, /if-match/);
});

test("stale --if-match refuses so a newer remote is not overwritten", () => {
  const decision = decideAcquire({
    worker: "zpkg-cdn",
    live: { modified_on: "2026-08-29T19:10:25.251597Z" },
    expectedModifiedOn: "2026-08-29T18:27:40.444652Z",
    createMissing: false,
    existingLease: null,
    nowMs: 0,
    holder: "agent",
  });
  assert.equal(decision.ok, false);
  assert.match(decision.reason, /does not match/);
});

test("matching --if-match and empty lease is allowed", () => {
  const decision = decideAcquire({
    worker: "zpkg-cdn",
    live: { modified_on: "2026-08-29T19:10:25.251597Z" },
    expectedModifiedOn: "2026-08-29T19:10:25.251597Z",
    createMissing: false,
    existingLease: null,
    nowMs: 0,
    holder: "agent",
  });
  assert.equal(decision.ok, true);
});

test("foreign unexpired lease is exclusive", () => {
  const decision = decideAcquire({
    worker: "zpkg-cdn",
    live: { modified_on: "2026-08-29T19:10:25.251597Z" },
    expectedModifiedOn: "2026-08-29T19:10:25.251597Z",
    createMissing: false,
    existingLease: { holder: "other", expires_at_ms: 10_000 },
    nowMs: 1_000,
    holder: "agent",
  });
  assert.equal(decision.ok, false);
  assert.match(decision.reason, /leased by other/);
});

test("missing live worker requires --create-missing", () => {
  const denied = decideAcquire({
    worker: "zpkg-registry-proxy",
    live: null,
    expectedModifiedOn: null,
    createMissing: false,
    existingLease: null,
    nowMs: 0,
    holder: "agent",
  });
  assert.equal(denied.ok, false);
  const allowed = decideAcquire({
    worker: "zpkg-registry-proxy",
    live: null,
    expectedModifiedOn: null,
    createMissing: true,
    existingLease: null,
    nowMs: 0,
    holder: "agent",
  });
  assert.equal(allowed.ok, true);
});

test("lease record and argv stay deterministic", () => {
  assert.equal(leaseKey("zpkg-cdn"), "lease:worker:zpkg-cdn");
  const record = buildLeaseRecord({
    worker: "zpkg-cdn",
    holder: "agent",
    ttlSeconds: 60,
    live: { modified_on: "2026-08-29T19:10:25.251597Z", id: "18437f84b0884179b855298c7578bd93" },
    nowMs: Date.parse("2026-08-29T19:00:00.000Z"),
  });
  assert.equal(record.schema, "zpkg.cf-deploy-lease/v1");
  assert.equal(record.expires_at, "2026-08-29T19:01:00.000Z");
  const args = parseArgs(["acquire", "--worker", "zpkg-cdn", "--if-match", "ts", "--create-missing"]);
  assert.deepEqual(args._, ["acquire"]);
  assert.equal(args.worker, "zpkg-cdn");
  assert.equal(args.if_match, "ts");
  assert.equal(args.create_missing, true);
  assert.ok(ALLOWED_WORKERS.includes("zpkg-cdn"));
});
