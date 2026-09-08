import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import worker, { organizationFrom } from "./index.js";

function request(path, init = {}) {
  return new Request(`https://org.zpkg.net${path}`, init);
}

test("root and generic login enter the app sign-in flow", async () => {
  for (const path of ["/", "/login", "/login?ignored=https://evil.test"]) {
    const response = await worker.fetch(request(path));
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), "https://app.zpkg.net/auth/sign-in");
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-zed-edge"), "org.zpkg.net");
  }
});

test("short, canonical, and query routes select an organization", async () => {
  for (const path of [
    "/zed-pkg",
    "/zed-pkg/login",
    "/orgs/zed-pkg",
    "/login?org=zed-pkg",
    "/?org=zed-pkg",
  ]) {
    const response = await worker.fetch(request(path));
    assert.equal(response.status, 302);
    assert.equal(
      response.headers.get("location"),
      "https://app.zpkg.net/auth/sign-in?return_to=%2Forgs%2Fzed-pkg",
    );
  }
});

test("untrusted redirect input and malformed paths fail closed without I/O", async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    throw new Error("org login routing must never perform origin I/O");
  };

  try {
    for (const path of [
      "/login?org=https://evil.test",
      "/login?org=zed_p...kg",
      "/orgs/zed-pkg/settings",
      "/%2f%2fevil.test",
      "/zed-pkg//login",
    ]) {
      const response = await worker.fetch(request(path));
      assert.equal(response.status, 404, path);
      assert.equal(response.headers.get("x-zed-edge"), "org.zpkg.net");
    }
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("non-navigation methods are rejected and HEAD carries no body", async () => {
  const post = await worker.fetch(request("/zed-pkg", { method: "POST" }));
  assert.equal(post.status, 405);
  assert.equal(post.headers.get("allow"), "GET, HEAD");

  const head = await worker.fetch(request("/zed-pkg", { method: "HEAD" }));
  assert.equal(head.status, 302);
  assert.equal(head.body, null);
});

test("the classifier is deterministic and accepts bounded GitHub-style slugs", () => {
  assert.equal(organizationFrom(new URL("https://org.zpkg.net/a")), "a");
  assert.equal(organizationFrom(new URL("https://org.zpkg.net/a-b")), "a-b");
  assert.equal(organizationFrom(new URL(`https://org.zpkg.net/${"a".repeat(64)}`)), "a".repeat(64));
  assert.equal(organizationFrom(new URL(`https://org.zpkg.net/${"a".repeat(65)}`)), false);
  assert.equal(organizationFrom(new URL("https://org.zpkg.net/-zed")), false);
  assert.equal(organizationFrom(new URL("https://org.zpkg.net/zed-")), false);
});

test("org Wrangler config makes the originless hostname a Custom Domain", async () => {
  const config = await readFile(
    new URL("../wrangler.toml", import.meta.url),
    "utf8",
  );
  assert.match(config, /workers_dev = false/);
  assert.match(config, /pattern = "org\.zpkg\.net"/);
  assert.match(config, /custom_domain = true/);
  assert.doesNotMatch(config, /zone_name/);
  assert.match(config, /redact_query_string = true/);
});
