import assert from "node:assert/strict";
import test from "node:test";
import { classifyRequest, createHandler, normalizePayload } from "./index.js";

const NOW = Date.parse("2026-09-02T15:00:00.000Z");
const REQUEST_ID = "018f5f52-feb8-7d4a-a9d6-69d8a1559e8b";
const env = Object.freeze({
  API_ORIGIN: "https://api.zpkg.net",
  CONSENT_REVISION: "privacy-2026-09-01",
  MARKETING_CONSENT_REVISION: "marketing-2026-09-01",
  TURNSTILE_SITE_KEY: "1x00000000000000000000AA",
  TURNSTILE_SECRET_KEY: "1x0000000000000000000000000000000AA",
  INTAKE_SIGNING_KEY: "0123456789abcdef0123456789abcdef",
});

function request(path, init = {}) {
  return new Request(`https://${path}`, init);
}

function preInterest(overrides = {}) {
  return {
    schema: "zed.public-intake.v1",
    requestId: REQUEST_ID,
    email: " Person@Example.COM ",
    partyType: "individual",
    sourceHost: "user.zpkg.net",
    interests: ["developer_experience", "private_registry"],
    locale: "en-US",
    consentRevision: "privacy-2026-09-01",
    consentedAt: new Date(NOW).toISOString(),
    contactConsent: true,
    marketingConsent: false,
    ...overrides,
  };
}

function quote(overrides = {}) {
  return {
    schema: "zed.public-intake.v1",
    requestId: REQUEST_ID,
    email: "buyer@example.com",
    sourceHost: "org.zpkg.net",
    organizationName: "Example Corp",
    contactName: "Buyer Person",
    interests: ["enterprise_support"],
    deploymentModel: "hybrid",
    teamSize: "fifty_one_to_two_hundred",
    packageCount: "one_hundred_to_one_thousand",
    monthlyDownloads: "one_hundred_thousand_to_one_million",
    migrationWindow: "three_to_six_months",
    consentRevision: "privacy-2026-09-01",
    consentedAt: new Date(NOW).toISOString(),
    contactConsent: true,
    marketingConsent: false,
    ...overrides,
  };
}

test("path classifier admits only the two exact standard host boundaries", () => {
  assert.equal(classifyRequest(request("user.zpkg.net/pre-interest")).action, "render");
  assert.equal(classifyRequest(request("org.zpkg.net/quote", { method: "POST" })).action, "submit");
  for (const url of [
    "user.zpkg.net/pre-interest-admin",
    "user.zpkg.net/quote",
    "org.zpkg.net/pre-interest",
    "api.zpkg.net/v1/pre-interest",
  ]) {
    assert.equal(classifyRequest(request(url)).action, "not-found", url);
  }
});

test("normalization derives host authority and closes the request object", () => {
  const route = classifyRequest(request("user.zpkg.net/pre-interest")).route;
  const normalized = normalizePayload(route, preInterest(), env, () => NOW);
  assert.equal(normalized.email, "person@example.com");
  assert.equal(normalized.sourceHost, "user.zpkg.net");
  assert.equal(normalized.partyType, "individual");
  assert.deepEqual(normalized.interests, ["developer_experience", "private_registry"]);
  assert.throws(() => normalizePayload(route, preInterest({ admin: true }), env, () => NOW));
  assert.throws(() => normalizePayload(route, preInterest({ sourceHost: "org.zpkg.net" }), env, () => NOW));
  assert.throws(() => normalizePayload(route, preInterest({ organizationName: "Smuggled Org" }), env, () => NOW));
});

test("quote validation rejects unknown bands, missing consent, and secret-like notes", () => {
  const route = classifyRequest(request("org.zpkg.net/quote")).route;
  assert.equal(normalizePayload(route, quote(), env, () => NOW).organizationName, "Example Corp");
  assert.throws(() => normalizePayload(route, quote({ teamSize: "all_users" }), env, () => NOW));
  assert.throws(() => normalizePayload(route, quote({ contactConsent: false }), env, () => NOW));
  assert.throws(() => normalizePayload(route, quote({ requirementsSummary: "password=hunter2" }), env, () => NOW));
});

test("GET renders an accessible no-store form with Turnstile and no contact data", async () => {
  const handle = createHandler({ now: () => NOW, randomUUID: () => REQUEST_ID });
  const response = await handle(request("user.zpkg.net/pre-interest"), env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store, max-age=0");
  assert.equal(response.headers.get("x-zed-edge"), "public-intake");
  const body = await response.text();
  assert.match(body, /<form method="post" action="\/pre-interest">/);
  assert.match(body, /data-action="zed_pre_interest_v1"/);
  assert.match(body, /name="contactConsent"/);
  assert.doesNotMatch(body, /person@example\.com/);
});

test("missing deployment bindings fail closed before rendering a form", async () => {
  const handle = createHandler({ now: () => NOW, randomUUID: () => REQUEST_ID });
  const response = await handle(request("org.zpkg.net/quote"), { ...env, TURNSTILE_SITE_KEY: "" });
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("cache-control"), "no-store, max-age=0");
});

test("JSON submission verifies Turnstile, signs the canonical body, and returns a generic receipt", async () => {
  const seen = [];
  const fetchImpl = async (target, init) => {
    seen.push({ target: String(target), init });
    if (String(target).startsWith("https://challenges.cloudflare.com/")) {
      return Response.json({ success: true, hostname: "user.zpkg.net", action: "zed_pre_interest_v1" });
    }
    assert.equal(String(target), "https://api.zpkg.net/v1/pre-interest");
    assert.equal(init.headers["Idempotency-Key"], REQUEST_ID);
    assert.match(init.headers["X-Zed-Intake-Body-Sha256"], /^[0-9a-f]{64}$/);
    assert.match(init.headers["X-Zed-Intake-Signature"], /^v1=[0-9a-f]{64}$/);
    assert.equal(init.headers["X-Zed-Intake-Source-Host"], "user.zpkg.net");
    const forwarded = JSON.parse(init.body);
    assert.equal(forwarded.email, "person@example.com");
    return Response.json({ schema: "zed.public-intake.v1", status: "accepted" }, { status: 202 });
  };
  const handle = createHandler({ fetchImpl, now: () => NOW, randomUUID: () => REQUEST_ID });
  const response = await handle(
    request("user.zpkg.net/pre-interest", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": REQUEST_ID,
        "x-zed-abuse-proof": "valid-proof",
      },
      body: JSON.stringify(preInterest()),
    }),
    env,
  );
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { schema: "zed.public-intake.v1", status: "accepted" });
  assert.equal(seen.length, 2);
});

test("form submissions require exact same-origin context", async () => {
  let calls = 0;
  const handle = createHandler({
    now: () => NOW,
    randomUUID: () => REQUEST_ID,
    fetchImpl: async () => {
      calls += 1;
      throw new Error("must not fetch");
    },
  });
  const body = new URLSearchParams({
    schema: "zed.public-intake.v1",
    requestId: REQUEST_ID,
    email: "person@example.com",
    consentRevision: "privacy-2026-09-01",
    consentedAt: new Date(NOW).toISOString(),
    contactConsent: "true",
    interests: "developer_experience",
    "cf-turnstile-response": "proof",
  });
  const response = await handle(
    request("user.zpkg.net/pre-interest", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://evil.example" },
      body,
    }),
    env,
  );
  assert.equal(response.status, 403);
  assert.equal(calls, 0);
  assert.doesNotMatch(await response.text(), /person@example\.com/);
});

test("Turnstile hostname or action mismatch fails before API I/O", async () => {
  let apiCalls = 0;
  const handle = createHandler({
    now: () => NOW,
    fetchImpl: async (target) => {
      if (String(target).startsWith("https://challenges.cloudflare.com/")) {
        return Response.json({ success: true, hostname: "org.zpkg.net", action: "zed_quote_request_v1" });
      }
      apiCalls += 1;
      return Response.json({ schema: "zed.public-intake.v1", status: "accepted" }, { status: 202 });
    },
  });
  const response = await handle(
    request("user.zpkg.net/pre-interest", {
      method: "POST",
      headers: { "content-type": "application/json", "x-zed-abuse-proof": "proof" },
      body: JSON.stringify(preInterest()),
    }),
    env,
  );
  assert.equal(response.status, 400);
  assert.equal(apiCalls, 0);
});

test("oversized bodies and unsupported media types are rejected without I/O", async () => {
  let calls = 0;
  const handle = createHandler({ fetchImpl: async () => { calls += 1; } });
  const tooLarge = await handle(
    request("user.zpkg.net/pre-interest", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(20_000) },
      body: "{}",
    }),
    env,
  );
  assert.equal(tooLarge.status, 413);
  const unsupported = await handle(
    request("user.zpkg.net/pre-interest", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "hello",
    }),
    env,
  );
  assert.equal(unsupported.status, 415);
  assert.equal(calls, 0);
});
