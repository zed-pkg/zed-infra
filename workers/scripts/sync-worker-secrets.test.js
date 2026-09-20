import assert from "node:assert/strict";
import test from "node:test";

import { applySecretSync, planSecretSync } from "./sync-worker-secrets.mjs";

const WORKER = "zpkg-registry-proxy";

function recordingFetch(respond) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url: String(url), method: init.method, body: init.body });
    return respond(String(url), init);
  };
  impl.calls = calls;
  return impl;
}

test("a configured secret is synced and an absent one is revoked", () => {
  const plan = planSecretSync(WORKER, { EDGE_PUBLISH_TOKEN: "value" });
  assert.deepEqual(plan, [
    { name: "EDGE_PUBLISH_TOKEN", action: "put", value: "value" },
    // Never configured here, so the Worker must not hold it either.
    { name: "GITHUB_PACKAGES_TOKEN", action: "delete" },
  ]);
});

test("an empty or blank value revokes rather than syncing an empty secret", () => {
  // An empty secret would compare equal to an empty bearer.
  for (const value of ["", "   ", undefined]) {
    const [step] = planSecretSync(WORKER, { EDGE_PUBLISH_TOKEN: value });
    assert.deepEqual(step, { name: "EDGE_PUBLISH_TOKEN", action: "delete" }, JSON.stringify(value));
  }
});

test("removing the repository secret takes the credential off the Worker", async () => {
  // Deploy 1: the token exists and is synced.
  let fetchImpl = recordingFetch(() => new Response("{}", { status: 200 }));
  let results = await applySecretSync({
    worker: WORKER,
    plan: planSecretSync(WORKER, { EDGE_PUBLISH_TOKEN: "first" }),
    token: "cf-token",
    fetchImpl,
  });
  assert.equal(results[0].outcome, "synced");
  assert.equal(fetchImpl.calls[0].method, "PUT");

  // Deploy 2: the repository secret was deleted. The old value must not stay
  // live on the Worker just because nothing new was written.
  fetchImpl = recordingFetch(() => new Response("{}", { status: 200 }));
  results = await applySecretSync({
    worker: WORKER,
    plan: planSecretSync(WORKER, {}),
    token: "cf-token",
    fetchImpl,
  });
  assert.deepEqual(results.map((result) => result.outcome), ["revoked", "revoked"]);
  assert.ok(fetchImpl.calls.every((call) => call.method === "DELETE"));
  assert.ok(fetchImpl.calls[0].url.endsWith("/secrets/EDGE_PUBLISH_TOKEN"));
});

test("rotation replaces the value in place", async () => {
  const fetchImpl = recordingFetch(() => new Response("{}", { status: 200 }));
  await applySecretSync({
    worker: WORKER,
    plan: planSecretSync(WORKER, { EDGE_PUBLISH_TOKEN: "rotated" }),
    token: "cf-token",
    fetchImpl,
  });
  assert.equal(JSON.parse(fetchImpl.calls[0].body).text, "rotated");
  assert.equal(JSON.parse(fetchImpl.calls[0].body).type, "secret_text");
});

test("revoking a secret the Worker never held is success", async () => {
  const fetchImpl = recordingFetch(() => new Response("{}", { status: 404 }));
  const results = await applySecretSync({
    worker: WORKER,
    plan: planSecretSync(WORKER, {}),
    token: "cf-token",
    fetchImpl,
  });
  assert.deepEqual(results.map((result) => result.outcome), ["absent", "absent"]);
});

test("a revocation that did not happen fails the deploy", async () => {
  const fetchImpl = recordingFetch(() => new Response("{}", { status: 500 }));
  await assert.rejects(
    applySecretSync({ worker: WORKER, plan: planSecretSync(WORKER, {}), token: "cf-token", fetchImpl }),
    /could not revoke EDGE_PUBLISH_TOKEN/,
  );
});

test("foreign workers and unmanaged workers are refused", async () => {
  assert.throws(() => planSecretSync("zpkg-cdn", {}), /no managed secrets/);
  await assert.rejects(
    applySecretSync({ worker: "someone-elses-worker", plan: [], token: "cf-token" }),
    /foreign worker/,
  );
});

test("secret values never appear in an error", async () => {
  const fetchImpl = recordingFetch(() => new Response("{}", { status: 403 }));
  await assert.rejects(
    applySecretSync({
      worker: WORKER,
      plan: planSecretSync(WORKER, { EDGE_PUBLISH_TOKEN: "super-secret-value" }),
      token: "cf-token",
      fetchImpl,
    }),
    (error) => !error.message.includes("super-secret-value") && !error.message.includes("cf-token"),
  );
});
