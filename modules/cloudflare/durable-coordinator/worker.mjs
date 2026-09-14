const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const MAX_BODY_BYTES = 64 * 1024;

function json(value, init = {}) {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: { ...JSON_HEADERS, ...(init.headers || {}) },
  });
}

function stateKey(url) {
  const prefix = "/state/";
  if (!url.pathname.startsWith(prefix)) return null;
  const key = decodeURIComponent(url.pathname.slice(prefix.length));
  if (!key || key.length > 256 || key.includes("\0")) return null;
  return `kv:${key}`;
}

function expectedVersion(request) {
  const raw = request.headers.get("if-match");
  if (!raw || raw === "*") return null;
  const normalized = raw.replace(/^W\//, "").replace(/^"|"$/g, "");
  const version = Number(normalized);
  return Number.isSafeInteger(version) && version >= 0 ? version : NaN;
}

export class ZedPackageCoordinator {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, project: "zed-pkg", durable_object: "ZedPackageCoordinator", storage: "sqlite" });
    }

    const key = stateKey(url);
    if (!key) return json({ error: "not_found" }, { status: 404 });

    if (request.method === "GET") {
      const record = await this.ctx.storage.get(key);
      if (record === undefined) return json({ error: "not_found" }, { status: 404 });
      return json(record, { headers: { etag: `"${record.version}"` } });
    }

    if (request.method === "PUT") {
      const expected = expectedVersion(request);
      if (Number.isNaN(expected)) return json({ error: "invalid_if_match" }, { status: 400 });
      const raw = await request.text();
      if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) return json({ error: "payload_too_large" }, { status: 413 });
      let value;
      try { value = JSON.parse(raw); } catch { return json({ error: "invalid_json" }, { status: 400 }); }
      const current = await this.ctx.storage.get(key);
      const currentVersion = current?.version ?? 0;
      if (expected !== null && expected !== currentVersion) {
        return json({ error: "version_mismatch", expected, actual: currentVersion }, { status: 412, headers: { etag: `"${currentVersion}"` } });
      }
      const record = { value, version: currentVersion + 1, updated_at: new Date().toISOString() };
      await this.ctx.storage.put(key, record);
      return json(record, { status: current ? 200 : 201, headers: { etag: `"${record.version}"` } });
    }

    if (request.method === "DELETE") {
      const deleted = await this.ctx.storage.delete(key);
      return new Response(null, { status: deleted ? 204 : 404 });
    }

    return json({ error: "method_not_allowed" }, { status: 405, headers: { allow: "GET, PUT, DELETE" } });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const objectName = url.searchParams.get("object") || "default";
    if (objectName.length > 256) return json({ error: "invalid_object_name" }, { status: 400 });
    const id = env.COORDINATOR.idFromName(objectName);
    return env.COORDINATOR.get(id).fetch(request);
  },
};
