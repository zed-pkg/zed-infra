import {
  githubFallbackUrlsForCdn,
  originIsUnavailable,
  parseCdnPath,
  USER_AGENT,
} from "../../shared/github-fallback.js";

export default {
  async fetch(request, env) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("method not allowed\n", { status: 405 });
    }

    const url = new URL(request.url);
    const parsed = parseCdnPath(url.pathname);
    if (!parsed) {
      return new Response("not found\n", { status: 404 });
    }

    const fromR2 = await getR2(env, parsed.key);
    if (fromR2) return fromR2;

    const github = await getGithub(parsed);
    if (github) return github;

    return new Response("not found\n", {
      status: 404,
      headers: { "x-zed-edge": "cdn", "x-zed-source": "miss" },
    });
  },
};

async function getR2(env, key) {
  if (!env.ARTIFACTS) return null;
  try {
    const object = await env.ARTIFACTS.get(key);
    if (!object) return null;
    const headers = new Headers();
    headers.set("x-zed-edge", "cdn");
    headers.set("x-zed-source", "r2");
    headers.set("x-content-type-options", "nosniff");
    if (object.httpEtag) headers.set("etag", object.httpEtag);
    headers.set(
      "content-type",
      object.httpMetadata?.contentType || "application/octet-stream",
    );
    if (object.size != null) headers.set("content-length", String(object.size));
    return new Response(object.body, { status: 200, headers });
  } catch {
    return null;
  }
}

async function getGithub(parsed) {
  for (const url of githubFallbackUrlsForCdn(parsed)) {
    try {
      const response = await fetch(url, {
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "application/octet-stream",
        },
        redirect: "follow",
      });
      if (originIsUnavailable(response.status) || response.status === 404) {
        continue;
      }
      if (!response.ok) continue;
      const headers = new Headers(response.headers);
      headers.set("x-zed-edge", "cdn");
      headers.set("x-zed-source", "github-release");
      headers.set("x-content-type-options", "nosniff");
      return new Response(response.body, { status: 200, headers });
    } catch {
      continue;
    }
  }
  return null;
}
