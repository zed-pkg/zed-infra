import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CredentialBrokerError,
  githubCredentialHeaders,
  requestProviderCredential,
} from "./provider-credential-broker.js";

const NOW = 2_000_000_000;

function plan(overrides = {}) {
  return {
    provider: "github",
    operation: "read",
    package: "acme/private-lib",
    resource: "acme/private-lib",
    credentialRef: "github-app:zed-pkg:installation-42",
    ...overrides,
  };
}

function context(overrides = {}) {
  return {
    principal: "user:test",
    sessionLineage: "session:abc-123",
    capabilityId: "capability-0001",
    capabilityExpiresAt: NOW + 120,
    requestedTtlSeconds: 90,
    nowEpochSeconds: NOW,
    ...overrides,
  };
}

function broker(handler) {
  return { fetch: handler };
}

function response(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": "private, no-store",
      ...init.headers,
    },
    ...init,
  });
}

function validCredential(overrides = {}) {
  return {
    version: 1,
    provider: "github",
    kind: "github-app-installation",
    resource: "acme/private-lib",
    credential_ref: "github-app:zed-pkg:installation-42",
    access_token: "ghs_test_token_1234567890",
    issued_at: NOW,
    expires_at: NOW + 90,
    permissions: {
      contents: "read",
      metadata: "read",
    },
    ...overrides,
  };
}

async function expectCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof CredentialBrokerError);
    assert.equal(error.code, code);
    return true;
  });
}

test("sends only a scoped, secret-free broker request", async () => {
  let seen;
  const credential = await requestProviderCredential(
    broker(async (request) => {
      seen = {
        url: request.url,
        method: request.method,
        headers: Object.fromEntries(request.headers),
        body: await request.json(),
      };
      return response(validCredential());
    }),
    plan(),
    context(),
  );

  assert.equal(seen.url, "https://credential-broker.internal/v1/credentials");
  assert.equal(seen.method, "POST");
  assert.deepEqual(seen.body, {
    version: 1,
    provider: "github",
    operation: "read",
    package: "acme/private-lib",
    resource: "acme/private-lib",
    credential_ref: "github-app:zed-pkg:installation-42",
    principal: "user:test",
    session_lineage: "session:abc-123",
    capability_id: "capability-0001",
    requested_ttl_seconds: 90,
  });
  assert.equal("authorization" in seen.headers, false);
  assert.equal("ssh_key" in seen.body, false);
  assert.equal("access_token" in seen.body, false);

  assert.equal(credential.resource, "acme/private-lib");
  assert.equal(credential.cachePolicy, "private-no-store");
});

test("caps requested TTL to remaining capability lifetime", async () => {
  let requestedTtl;
  await requestProviderCredential(
    broker(async (request) => {
      const body = await request.json();
      requestedTtl = body.requested_ttl_seconds;
      return response(validCredential({ expires_at: NOW + 40 }));
    }),
    plan(),
    context({ capabilityExpiresAt: NOW + 40, requestedTtlSeconds: 300 }),
  );
  assert.equal(requestedTtl, 40);
});

test("rejects unsupported providers and any write semantics", async () => {
  const never = broker(async () => {
    throw new Error("must not call broker");
  });
  await expectCode(
    requestProviderCredential(never, plan({ provider: "npm" }), context()),
    "unsupported_provider",
  );
  await expectCode(
    requestProviderCredential(never, plan({ operation: "write" }), context()),
    "write_forbidden",
  );
});

test("rejects broker responses without no-store", async () => {
  await expectCode(
    requestProviderCredential(
      broker(async () =>
        response(validCredential(), {
          headers: {
            "content-type": "application/json",
            "cache-control": "private, max-age=60",
          },
        }),
      ),
      plan(),
      context(),
    ),
    "unsafe_cache_policy",
  );
});

test("rejects widened repository scope, lifetime, and permissions", async () => {
  await expectCode(
    requestProviderCredential(
      broker(async () => response(validCredential({ resource: "acme/other" }))),
      plan(),
      context(),
    ),
    "scope_mismatch",
  );

  await expectCode(
    requestProviderCredential(
      broker(async () => response(validCredential({ expires_at: NOW + 200 }))),
      plan(),
      context(),
    ),
    "ttl_widened",
  );

  await expectCode(
    requestProviderCredential(
      broker(async () =>
        response(
          validCredential({
            permissions: { contents: "read", issues: "write" },
          }),
        ),
      ),
      plan(),
      context(),
    ),
    "invalid_permissions",
  );
});

test("rejects unversioned secret-bearing response fields", async () => {
  await expectCode(
    requestProviderCredential(
      broker(async () =>
        response(validCredential({ ssh_private_key: "must-never-appear" })),
      ),
      plan(),
      context(),
    ),
    "unknown_field",
  );
});

test("builds GitHub headers only from a validated broker credential", async () => {
  const credential = await requestProviderCredential(
    broker(async () => response(validCredential())),
    plan(),
    context(),
  );
  assert.deepEqual(githubCredentialHeaders(credential), {
    accept: "application/vnd.github+json",
    authorization: "Bearer ghs_test_token_1234567890",
    "x-github-api-version": "2022-11-28",
  });
});
