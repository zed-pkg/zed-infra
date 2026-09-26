import assert from "node:assert/strict";
import test from "node:test";

import {
  brokerRequestFromCapability,
  requestProviderCredential,
  upstreamAuthorizationHeaders,
} from "./private-source-broker.js";

const capability = Object.freeze({
  subject: "user:123",
  jti: "capability-1",
  exp: 1_800_000_200,
  proof: {
    sessionId: "session-1",
    authEpoch: 4,
    policyEpoch: 9,
  },
  source: {
    provider: "github",
    owner: "acme",
    repo: "private-lib",
  },
});

test("broker requests are derived from exact authorized source identity", () => {
  assert.deepEqual(
    brokerRequestFromCapability(capability, "github", {
      owner: "acme",
      repo: "private-lib",
    }),
    {
      schema: "zed.private-source-credential-request.v1",
      provider: "github",
      resource: { owner: "acme", repo: "private-lib" },
      principal: "user:123",
      sessionId: "session-1",
      capabilityId: "capability-1",
      authEpoch: 4,
      policyEpoch: 9,
      expiresAt: 1_800_000_200,
    },
  );

  assert.throws(
    () => brokerRequestFromCapability(capability, "github", {
      owner: "other",
      repo: "private-lib",
    }),
    /resource mismatch/,
  );
  assert.throws(
    () => brokerRequestFromCapability(capability, "npm", {
      scope: "@acme",
      package: "private-lib",
    }),
    /provider mismatch/,
  );
});

test("GitHub broker response must be a short-lived exact installation credential", async () => {
  const request = brokerRequestFromCapability(capability, "github", {
    owner: "acme",
    repo: "private-lib",
  });
  const binding = {
    async fetch(_url, init) {
      const received = JSON.parse(init.body);
      assert.deepEqual(received, request);
      const payload = JSON.stringify({
        schema: "zed.private-source-credential.v1",
        provider: "github",
        kind: "github-app-installation",
        token: "short-lived-installation-token",
        expiresAt: 1_800_000_120,
        resource: { owner: "acme", repo: "private-lib" },
      });
      return new Response(payload, {
        status: 200,
        headers: {
          "content-type": "application/json",
          "content-length": String(new TextEncoder().encode(payload).byteLength),
        },
      });
    },
  };
  const credential = await requestProviderCredential(binding, request, {
    now: 1_800_000_000,
  });
  assert.equal(credential.kind, "github-app-installation");
  assert.equal(credential.resource.repo, "private-lib");
  const headers = upstreamAuthorizationHeaders(credential);
  assert.equal(headers.get("authorization"), "Bearer short-lived-installation-token");
  assert.equal(headers.get("cache-control"), "private, no-store");
});

test("broker credentials cannot widen resource, lifetime, or provider kind", async () => {
  const request = brokerRequestFromCapability(capability, "github", {
    owner: "acme",
    repo: "private-lib",
  });
  for (const mutation of [
    { resource: { owner: "acme", repo: "other" } },
    { expiresAt: 1_800_001_000 },
    { kind: "generic-bearer" },
  ]) {
    const binding = {
      async fetch() {
        const payload = JSON.stringify({
          schema: "zed.private-source-credential.v1",
          provider: "github",
          kind: "github-app-installation",
          token: "token",
          expiresAt: 1_800_000_120,
          resource: { owner: "acme", repo: "private-lib" },
          ...mutation,
        });
        return new Response(payload, { status: 200 });
      },
    };
    await assert.rejects(
      () => requestProviderCredential(binding, request, { now: 1_800_000_000 }),
      /credential/,
    );
  }
});

test("the broker never accepts unavailable, denied, malformed, or oversized replies", async () => {
  const request = brokerRequestFromCapability(capability, "github", {
    owner: "acme",
    repo: "private-lib",
  });
  await assert.rejects(
    () => requestProviderCredential({ fetch: async () => { throw new Error("down"); } }, request),
    /unavailable/,
  );
  await assert.rejects(
    () => requestProviderCredential({ fetch: async () => new Response("no", { status: 403 }) }, request),
    /denied/,
  );
  await assert.rejects(
    () => requestProviderCredential({ fetch: async () => new Response("not-json") }, request),
    /malformed/,
  );
});
