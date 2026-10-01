#!/usr/bin/env node
/**
 * Make a Worker's secrets equal to what the deploy environment declares.
 *
 * "Equal" is the point. A sync that only ever writes cannot take access away:
 * once a publish token has reached the Worker, deleting the repository secret
 * would leave the old credential live and the write path open, with nothing
 * in the repository saying so. Here an absent or empty value means the Worker
 * must not hold that secret, and it is deleted.
 *
 * Values are never logged, never placed in argv, and never written to disk.
 * An empty string is treated as absent rather than synced, because an empty
 * secret would compare equal to an empty bearer.
 */

import { ACCOUNT_ID, isAllowedWorker } from "./cf-lease.mjs";

/** Secrets this script manages, by Worker. Anything else is left untouched. */
export const MANAGED_SECRETS = Object.freeze({
  "zpkg-registry-proxy": Object.freeze({
    EDGE_PUBLISH_TOKEN: "EDGE_PUBLISH_TOKEN",
    GITHUB_PACKAGES_TOKEN: "GITHUB_PACKAGES_TOKEN",
  }),
});

/**
 * Decide, without touching the network, what each managed secret should become.
 *
 * @returns {{ name: string, action: "put" | "delete", value?: string }[]}
 */
export function planSecretSync(worker, env) {
  const managed = MANAGED_SECRETS[worker];
  if (!managed) throw new Error(`no managed secrets are declared for ${worker}`);
  return Object.entries(managed).map(([name, source]) => {
    const value = env[source];
    if (typeof value === "string" && value.trim() !== "") {
      return { name, action: "put", value };
    }
    return { name, action: "delete" };
  });
}

function secretsUrl(accountId, worker) {
  return `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${worker}/secrets`;
}

/**
 * Apply a plan. Deleting a secret the Worker never held is success: the
 * postcondition — the Worker does not hold it — is what matters.
 *
 * @returns {Promise<{ name: string, outcome: "synced" | "revoked" | "absent" }[]>}
 */
export async function applySecretSync({ worker, plan, token, accountId = ACCOUNT_ID, fetchImpl = fetch }) {
  if (!isAllowedWorker(worker)) throw new Error(`refusing to manage secrets for foreign worker ${worker}`);
  if (!token) throw new Error("CLOUDFLARE_API_TOKEN is required");
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const results = [];
  for (const step of plan) {
    if (step.action === "put") {
      const response = await fetchImpl(secretsUrl(accountId, worker), {
        method: "PUT",
        headers,
        body: JSON.stringify({ name: step.name, text: step.value, type: "secret_text" }),
      });
      if (!response.ok) throw new Error(`could not sync ${step.name} (HTTP ${response.status})`);
      results.push({ name: step.name, outcome: "synced" });
      continue;
    }
    const response = await fetchImpl(`${secretsUrl(accountId, worker)}/${step.name}`, {
      method: "DELETE",
      headers,
    });
    if (response.ok) {
      results.push({ name: step.name, outcome: "revoked" });
    } else if (response.status === 404) {
      results.push({ name: step.name, outcome: "absent" });
    } else {
      // Fail the deploy: an access-removal step that silently did not happen
      // is exactly the failure this script exists to prevent.
      throw new Error(`could not revoke ${step.name} (HTTP ${response.status})`);
    }
  }
  return results;
}

async function main() {
  const worker = process.argv[2];
  if (!worker) throw new Error("usage: sync-worker-secrets.mjs <worker>");
  const plan = planSecretSync(worker, process.env);
  const results = await applySecretSync({
    worker,
    plan,
    token: process.env.CLOUDFLARE_API_TOKEN,
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID || ACCOUNT_ID,
  });
  for (const { name, outcome } of results) console.log(`${worker}: ${name} ${outcome}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
