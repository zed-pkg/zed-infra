#!/usr/bin/env node
/**
 * Read-first Cloudflare Worker deploy lease.
 *
 * Never uploads a Worker until:
 *   1. the live script is GET'd (or proven missing for a create),
 *   2. --if-match equals the live `modified_on` (or --create-missing),
 *   3. KV `zed-pkg-deploy-leases` accepts a create-if-absent lease.
 *
 * Foreign workers (sonus, fiducia, …) are refused by allowlist.
 */

export const ACCOUNT_ID = "62b833940607839add74bd2379cac303";
export const LEASE_NAMESPACE_ID = "064c38e7ffbf406c94167542ede580e8";
export const LEASE_NAMESPACE_TITLE = "zed-pkg-deploy-leases";
export const DEFAULT_TTL_SECONDS = 1800;

export const ALLOWED_WORKERS = Object.freeze([
  "zpkg-cdn",
  "zpkg-cdn-dev",
  "zpkg-registry-proxy",
  "zpkg-user-proxy",
  "zpkg-web-proxy",
  "zpkg-app-proxy",
]);

export function leaseKey(worker) {
  return `lease:worker:${worker}`;
}

export function isAllowedWorker(name) {
  return ALLOWED_WORKERS.includes(name);
}

export function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith("--")) {
      const key = token.slice(2).replace(/-/g, "_");
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) {
        args[key] = true;
      } else {
        args[key] = next;
        i += 1;
      }
    } else {
      args._.push(token);
    }
  }
  return args;
}

export function requireToken(env) {
  const token = (env.CLOUDFLARE_API_TOKEN || env.CLOUDFLARE_API_TOKEN_ZPKG || "").trim();
  if (!token || token.includes("PLACEHOLDER")) {
    throw new Error(
      "refusing CF write: CLOUDFLARE_API_TOKEN / CLOUDFLARE_API_TOKEN_ZPKG is missing or PLACEHOLDER",
    );
  }
  return token;
}

export function decideAcquire({
  worker,
  live,
  expectedModifiedOn,
  createMissing,
  existingLease,
  nowMs,
  holder,
}) {
  if (!isAllowedWorker(worker)) {
    return {
      ok: false,
      reason: `worker ${worker} is not on the zed-pkg allowlist; refusing to lock or overwrite foreign scripts`,
    };
  }
  if (!live && !createMissing) {
    return {
      ok: false,
      reason: `live worker ${worker} was not found; pass --create-missing after reading that the name is absent`,
    };
  }
  if (live && !expectedModifiedOn) {
    return {
      ok: false,
      reason: `live worker ${worker} exists (modified_on=${live.modified_on}); pass --if-match <that value> after reading the remote script`,
    };
  }
  if (live && expectedModifiedOn !== live.modified_on) {
    return {
      ok: false,
      reason: `live modified_on ${live.modified_on} does not match --if-match ${expectedModifiedOn}; remote moved, re-read before writing`,
    };
  }
  if (existingLease && existingLease.expires_at_ms > nowMs && existingLease.holder !== holder) {
    return {
      ok: false,
      reason: `worker ${worker} is leased by ${existingLease.holder} until ${new Date(existingLease.expires_at_ms).toISOString()}`,
    };
  }
  return { ok: true };
}

export function buildLeaseRecord({ worker, holder, ttlSeconds, live, nowMs }) {
  const expiresAt = nowMs + ttlSeconds * 1000;
  return {
    schema: "zpkg.cf-deploy-lease/v1",
    worker,
    holder,
    acquired_at: new Date(nowMs).toISOString(),
    expires_at: new Date(expiresAt).toISOString(),
    expires_at_ms: expiresAt,
    live_modified_on: live?.modified_on ?? null,
    live_id: live?.id ?? null,
    namespace: LEASE_NAMESPACE_TITLE,
  };
}

function apiBase(accountId) {
  return `https://api.cloudflare.com/client/v4/accounts/${accountId}`;
}

async function cfJson(token, method, url, body) {
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text.slice(0, 400) };
  }
  return { status: response.status, json: parsed };
}

export async function readLiveWorker(token, worker, accountId = ACCOUNT_ID) {
  const { status, json } = await cfJson(
    token,
    "GET",
    `${apiBase(accountId)}/workers/scripts`,
  );
  if (status !== 200 || json.success === false) {
    throw new Error(`LIST workers returned ${status}: ${JSON.stringify(json.errors || json).slice(0, 300)}`);
  }
  if (!Array.isArray(json.result)) {
    throw new Error("LIST workers returned an unexpected body");
  }
  const result = json.result.find((candidate) => candidate?.id === worker);
  if (!result) return null;
  if (!result.modified_on) {
    throw new Error(`LIST workers omitted modified_on for ${worker}; refusing an unguarded deploy`);
  }
  return {
    id: result.id,
    modified_on: result.modified_on,
    created_on: result.created_on || null,
    etag: result.etag || null,
  };
}

export async function readLease(token, worker, accountId = ACCOUNT_ID, ns = LEASE_NAMESPACE_ID) {
  const { status, json } = await cfJson(
    token,
    "GET",
    `${apiBase(accountId)}/storage/kv/namespaces/${ns}/values/${encodeURIComponent(leaseKey(worker))}`,
  );
  if (status === 404) return null;
  if (status !== 200) {
    throw new Error(`GET lease ${worker} returned ${status}`);
  }
  if (json && typeof json === "object" && json.schema) return json;
  if (typeof json?.raw === "string") return JSON.parse(json.raw);
  throw new Error(`GET lease ${worker} returned an unexpected body`);
}

async function writeLeaseIfAbsent(token, worker, record, ttlSeconds, accountId = ACCOUNT_ID, ns = LEASE_NAMESPACE_ID) {
  const url =
    `${apiBase(accountId)}/storage/kv/namespaces/${ns}/values/${encodeURIComponent(leaseKey(worker))}` +
    `?expiration_ttl=${ttlSeconds}`;
  // Cloudflare KV has no If-None-Match. Re-read then PUT is the documented
  // race window; refuse a foreign unexpired holder here.
  const existing = await readLease(token, worker, accountId, ns);
  const nowMs = Date.now();
  if (existing && existing.expires_at_ms > nowMs && existing.holder !== record.holder) {
    throw new Error(
      `worker ${worker} is leased by ${existing.holder} until ${new Date(existing.expires_at_ms).toISOString()}`,
    );
  }
  const { status, json } = await cfJson(token, "PUT", url, record);
  if (status !== 200 || json.success === false) {
    throw new Error(`PUT lease ${worker} returned ${status}: ${JSON.stringify(json.errors || json).slice(0, 300)}`);
  }
}

async function deleteLease(token, worker, holder, accountId = ACCOUNT_ID, ns = LEASE_NAMESPACE_ID) {
  const existing = await readLease(token, worker, accountId, ns);
  if (!existing) return { released: false, reason: "no lease" };
  if (existing.holder !== holder) {
    throw new Error(`refusing to release lease held by ${existing.holder}`);
  }
  const { status, json } = await cfJson(
    token,
    "DELETE",
    `${apiBase(accountId)}/storage/kv/namespaces/${ns}/values/${encodeURIComponent(leaseKey(worker))}`,
  );
  if (status !== 200 || json.success === false) {
    throw new Error(`DELETE lease ${worker} returned ${status}`);
  }
  return { released: true };
}

function holderId(env) {
  return (
    env.ZED_CF_LEASE_HOLDER ||
    `${env.USER || "agent"}@${env.HOSTNAME || "localhost"}:${process.pid}`
  );
}

async function cmdSnapshot(args, env, io = console) {
  const worker = args.worker;
  if (!worker) throw new Error("--worker is required");
  if (!isAllowedWorker(worker)) throw new Error(`worker ${worker} is not allowlisted`);
  const token = requireToken(env);
  const live = await readLiveWorker(token, worker);
  io.log(
    JSON.stringify(
      {
        schema: "zpkg.cf-worker-snapshot/v1",
        worker,
        live,
        read_at: new Date().toISOString(),
        next: live
          ? `node workers/scripts/cf-lease.mjs acquire --worker ${worker} --if-match ${live.modified_on}`
          : `node workers/scripts/cf-lease.mjs acquire --worker ${worker} --create-missing`,
      },
      null,
      2,
    ),
  );
}

async function cmdAcquire(args, env, io = console) {
  const worker = args.worker;
  if (!worker) throw new Error("--worker is required");
  const token = requireToken(env);
  const live = await readLiveWorker(token, worker);
  const nowMs = Date.now();
  const holder = holderId(env);
  const ttl = Number(args.ttl || DEFAULT_TTL_SECONDS);
  const existing = await readLease(token, worker);
  const decision = decideAcquire({
    worker,
    live,
    expectedModifiedOn: args.if_match || null,
    createMissing: Boolean(args.create_missing),
    existingLease: existing,
    nowMs,
    holder,
  });
  if (!decision.ok) throw new Error(decision.reason);
  const record = buildLeaseRecord({
    worker,
    holder,
    ttlSeconds: Number.isFinite(ttl) ? ttl : DEFAULT_TTL_SECONDS,
    live,
    nowMs,
  });
  await writeLeaseIfAbsent(token, worker, record, record.expires_at_ms ? ttl : DEFAULT_TTL_SECONDS);
  io.log(JSON.stringify({ ok: true, phase: "acquired", lease: record }, null, 2));
}

async function cmdRelease(args, env, io = console) {
  const worker = args.worker;
  if (!worker) throw new Error("--worker is required");
  if (!isAllowedWorker(worker)) throw new Error(`worker ${worker} is not allowlisted`);
  const token = requireToken(env);
  const result = await deleteLease(token, worker, holderId(env));
  io.log(JSON.stringify({ ok: true, phase: "released", worker, ...result }, null, 2));
}

async function main(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  const command = args._[0];
  if (command === "snapshot") return cmdSnapshot(args, env);
  if (command === "acquire") return cmdAcquire(args, env);
  if (command === "release") return cmdRelease(args, env);
  throw new Error("usage: cf-lease.mjs snapshot|acquire|release --worker <name> [--if-match <modified_on>]");
}

const invoked = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("cf-lease.mjs");
if (invoked && !process.env.ZED_CF_LEASE_AS_LIB) {
  main().catch((error) => {
    console.error(`cf-lease: ${error.message}`);
    process.exitCode = 1;
  });
}
