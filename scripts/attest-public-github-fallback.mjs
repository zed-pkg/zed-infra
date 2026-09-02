import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import registryWorker from "../workers/registry-proxy/src/entry.js";

const CANARY = Object.freeze({
  org: "zed-pkg-test",
  repo: "github-api-fallback-canary",
  name: "github-api-fallback-canary",
  version: "0.0.2",
});

const tag = `v${CANARY.version}`;
const asset = `zpkg-${CANARY.org}-${CANARY.name}-${CANARY.version}.tar.gz`;
const sidecar = `zpkg-${CANARY.org}-${CANARY.name}-${CANARY.version}.json`;
const releaseBase =
  `https://github.com/${CANARY.org}/${CANARY.repo}/releases/download/${tag}`;
const directAssetUrl = `${releaseBase}/${asset}`;
const directSidecarUrl = `${releaseBase}/${sidecar}`;
const registryPath =
  `/v1/packages/${CANARY.org}/${CANARY.name}/versions/${CANARY.version}`;
const liveRegistryUrl = `https://registry.zpkg.net${registryPath}`;
const liveCdnUrl =
  `https://cdn.zpkg.net/github/${CANARY.org}/${CANARY.repo}/${tag}/${asset}`;
const evidencePath =
  process.env.EVIDENCE_PATH || "artifacts/public-github-fallback-attestation.json";
const enforceLiveRegistry = process.env.ENFORCE_LIVE_REGISTRY === "1";

const evidence = {
  schema: "zpkg.public-github-fallback-attestation/v1",
  generated_at: new Date().toISOString(),
  git_sha: process.env.GITHUB_SHA || null,
  github_run_id: process.env.GITHUB_RUN_ID || null,
  canary: CANARY,
  checks: {},
};
let requiredFailures = 0;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function proofHeaders(response) {
  const names = [
    "cache-control",
    "cf-cache-status",
    "cf-ray",
    "content-length",
    "content-type",
    "etag",
    "server",
    "x-zed-edge",
    "x-zed-source",
    "x-zpkg-mirror",
  ];
  return Object.fromEntries(
    names
      .map((name) => [name, response.headers.get(name)])
      .filter(([, value]) => value !== null),
  );
}

async function fetchWithRetries(url, init = {}, attempts = 5) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(30_000),
      });
      if (response.status < 500 || attempt === attempts) return response;
      await response.body?.cancel();
      lastError = new Error(`${url} returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
    }
    await new Promise((resolve) => setTimeout(resolve, attempt * 750));
  }
  throw lastError || new Error(`unable to fetch ${url}`);
}

async function record(name, required, operation) {
  try {
    const result = await operation();
    const ok = result?.ok !== false;
    evidence.checks[name] = { ok, required, ...result };
    if (required && !ok) requiredFailures += 1;
  } catch (error) {
    requiredFailures += required ? 1 : 0;
    evidence.checks[name] = {
      ok: false,
      required,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

let expected;
let directBytes;

await record("github_release", true, async () => {
  const sidecarResponse = await fetchWithRetries(directSidecarUrl, {
    headers: { Accept: "application/json" },
    redirect: "follow",
  });
  const assetResponse = await fetchWithRetries(directAssetUrl, {
    headers: { Accept: "application/octet-stream" },
    redirect: "follow",
  });
  if (!sidecarResponse.ok) {
    throw new Error(`GitHub sidecar returned HTTP ${sidecarResponse.status}`);
  }
  if (!assetResponse.ok) {
    throw new Error(`GitHub archive returned HTTP ${assetResponse.status}`);
  }

  expected = await sidecarResponse.json();
  directBytes = Buffer.from(await assetResponse.arrayBuffer());
  const digest = sha256(directBytes);
  const ok =
    expected.org === CANARY.org &&
    expected.name === CANARY.name &&
    expected.version === CANARY.version &&
    expected.sha256 === digest &&
    expected.size === directBytes.byteLength &&
    expected.download_url === directAssetUrl;

  return {
    ok,
    release: `${CANARY.org}/${CANARY.repo}@${tag}`,
    sidecar_status: sidecarResponse.status,
    archive_status: assetResponse.status,
    sha256: digest,
    bytes: directBytes.byteLength,
    sidecar_headers: proofHeaders(sidecarResponse),
    archive_headers: proofHeaders(assetResponse),
  };
});

await record("exact_worker_with_rust_origin_down", true, async () => {
  if (!expected) throw new Error("GitHub release proof did not complete");

  const response = await registryWorker.fetch(
    new Request(`https://registry.zpkg.net${registryPath}`),
    {
      // Port 9 is intentionally unreachable. The same Worker code deployed to
      // Cloudflare must recover from this transport failure before consulting
      // the anonymous public GitHub release path.
      ORIGIN_URL: "http://127.0.0.1:9",
      ORIGIN_TIMEOUT_MS: "100",
      FALLBACK_TIMEOUT_MS: "15000",
    },
  );
  const metadata = await response.json();
  const ok =
    response.status === 200 &&
    response.headers.get("x-zed-edge") === "registry" &&
    response.headers.get("x-zed-source") === "github-public" &&
    ["org", "name", "version", "sha256", "size", "download_url"].every(
      (key) => metadata[key] === expected[key],
    );

  return {
    ok,
    status: response.status,
    headers: proofHeaders(response),
    metadata,
  };
});

await record("cloudflare_cdn_to_github", true, async () => {
  if (!directBytes || !expected) throw new Error("GitHub release proof did not complete");

  const response = await fetchWithRetries(liveCdnUrl, {
    headers: { Accept: "application/octet-stream" },
    redirect: "follow",
  });
  const proxiedBytes = Buffer.from(await response.arrayBuffer());
  const digest = sha256(proxiedBytes);
  const cacheControl = response.headers.get("cache-control") || "";
  const ok =
    response.status === 200 &&
    response.headers.get("x-zed-edge") === "cdn" &&
    response.headers.get("x-zed-source") === "github-release" &&
    cacheControl.includes("immutable") &&
    proxiedBytes.equals(directBytes) &&
    digest === expected.sha256;

  return {
    ok,
    status: response.status,
    headers: proofHeaders(response),
    sha256: digest,
    bytes: proxiedBytes.byteLength,
    byte_identical_to_github: proxiedBytes.equals(directBytes),
  };
});

await record("live_cloudflare_registry_to_github", enforceLiveRegistry, async () => {
  const response = await fetchWithRetries(liveRegistryUrl, {
    headers: { Accept: "application/json" },
    redirect: "manual",
  });
  const text = await response.text();
  let metadata = null;
  try {
    metadata = JSON.parse(text);
  } catch {
    metadata = null;
  }

  const matchingMetadata =
    expected &&
    metadata &&
    ["org", "name", "version", "sha256", "size", "download_url"].every(
      (key) => metadata[key] === expected[key],
    );
  const ok =
    response.status === 200 &&
    response.headers.get("x-zed-edge") === "registry" &&
    response.headers.get("x-zed-source") === "github-public" &&
    matchingMetadata;

  return {
    ok,
    enforced: enforceLiveRegistry,
    status: response.status,
    headers: proofHeaders(response),
    metadata,
    body_preview: metadata ? null : text.slice(0, 500),
  };
});

await record("public_site_and_github_org_link", true, async () => {
  const response = await fetchWithRetries("https://zpkg.net/", {
    headers: { Accept: "text/html" },
    redirect: "follow",
  });
  const html = await response.text();
  const renderedText = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
  const titlePresent = renderedText
    .toLowerCase()
    .includes("install packages, not repositories");
  const githubOrgLinkPresent = html.includes("https://github.com/zed-pkg");
  const ok = response.status === 200 && titlePresent && githubOrgLinkPresent;
  return {
    ok,
    status: response.status,
    headers: proofHeaders(response),
    title_present: titlePresent,
    github_org_link_present: githubOrgLinkPresent,
  };
});

evidence.summary = {
  required_failures: requiredFailures,
  all_required_checks_passed: requiredFailures === 0,
  live_registry_enforced: enforceLiveRegistry,
};

await mkdir(path.dirname(evidencePath), { recursive: true });
await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
console.log(JSON.stringify(evidence, null, 2));

if (requiredFailures > 0) process.exitCode = 1;
