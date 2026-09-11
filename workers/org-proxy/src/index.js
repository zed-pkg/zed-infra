const ORG_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const APP_ORIGIN = "https://app.zpkg.net";

export default {
  async fetch(request) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return problem(request.method, 405, "method_not_allowed", {
        allow: "GET, HEAD",
      });
    }

    const url = new URL(request.url);
    const org = organizationFrom(url);
    if (org === false) {
      return problem(request.method, 404, "not_org_login_route");
    }

    const target = new URL("/auth/sign-in", APP_ORIGIN);
    if (org) target.searchParams.set("return_to", `/orgs/${org}`);

    const headers = securityHeaders();
    headers.set("location", target.toString());
    return new Response(null, { status: 302, headers });
  },
};

/**
 * Total, side-effect-free route classifier for the organization login host.
 * It deliberately never forwards arbitrary paths or query-string redirects.
 *
 * @returns {string|null|false} an org slug, a generic login, or a rejection
 */
export function organizationFrom(url) {
  const pathname = normalizePath(url.pathname);
  if (!pathname) return false;

  if (pathname === "/" || pathname === "/login") {
    const org = url.searchParams.get("org");
    if (org === null || org === "") return null;
    return isOrgSlug(org) ? org : false;
  }

  const orgPath = pathname.match(/^\/orgs\/([^/]+)$/);
  if (orgPath) return isOrgSlug(orgPath[1]) ? orgPath[1] : false;

  const shortPath = pathname.match(/^\/([^/]+)(?:\/login)?$/);
  if (shortPath && shortPath[1] !== "orgs" && shortPath[1] !== "login") {
    return isOrgSlug(shortPath[1]) ? shortPath[1] : false;
  }

  return false;
}

function normalizePath(pathname) {
  if (
    typeof pathname !== "string" ||
    pathname.length > 512 ||
    pathname.includes("%") ||
    pathname.includes("\\") ||
    pathname.includes("\0") ||
    pathname.includes("//") ||
    pathname.includes("..")
  ) {
    return null;
  }
  return pathname.replace(/\/+$/, "") || "/";
}

function isOrgSlug(value) {
  return typeof value === "string" && ORG_SLUG.test(value);
}

function securityHeaders() {
  return new Headers({
    "cache-control": "no-store",
    "permissions-policy": "camera=(), geolocation=(), microphone=()",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-robots-tag": "noindex, nofollow",
    "x-zed-edge": "org.zpkg.net",
  });
}

function problem(method, status, code, extraHeaders = {}) {
  const headers = securityHeaders();
  headers.set("content-type", "application/json; charset=utf-8");
  for (const [name, value] of Object.entries(extraHeaders)) headers.set(name, value);
  const body = JSON.stringify({ ok: false, code });
  return new Response(method === "HEAD" ? null : body, { status, headers });
}
