const SCHEMA = "zed.public-intake.v1";
const MAX_BODY_BYTES = 16 * 1024;
const API_TIMEOUT_MS = 5_000;
const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

const INTERESTS = new Set([
  "package_publishing",
  "private_registry",
  "supply_chain_security",
  "enterprise_support",
  "developer_experience",
  "migration",
  "compliance",
  "self_hosted",
  "air_gapped",
]);
const DEPLOYMENT_MODELS = new Set(["evaluating", "zed_cloud", "self_hosted", "hybrid", "air_gapped"]);
const TEAM_SIZES = new Set([
  "one_to_ten",
  "eleven_to_fifty",
  "fifty_one_to_two_hundred",
  "two_hundred_one_to_one_thousand",
  "over_one_thousand",
  "unknown",
]);
const PACKAGE_COUNTS = new Set([
  "under_one_hundred",
  "one_hundred_to_one_thousand",
  "one_thousand_to_ten_thousand",
  "over_ten_thousand",
  "unknown",
]);
const MONTHLY_DOWNLOADS = new Set([
  "under_one_hundred_thousand",
  "one_hundred_thousand_to_one_million",
  "one_million_to_ten_million",
  "over_ten_million",
  "unknown",
]);
const MIGRATION_WINDOWS = new Set([
  "exploring",
  "under_three_months",
  "three_to_six_months",
  "six_to_twelve_months",
  "over_twelve_months",
]);

const ROUTES = Object.freeze([
  Object.freeze({
    host: "user.zpkg.net",
    pagePath: "/pre-interest",
    apiPath: "/v1/pre-interest",
    action: "zed_pre_interest_v1",
    kind: "pre-interest",
  }),
  Object.freeze({
    host: "org.zpkg.net",
    pagePath: "/quote",
    apiPath: "/v1/quote-requests",
    action: "zed_quote_request_v1",
    kind: "quote",
  }),
]);

class IntakeError extends Error {
  constructor(code, status = 400, retryable = false) {
    super(code);
    this.name = "IntakeError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

export function classifyRequest(request) {
  const url = new URL(request.url);
  const route = ROUTES.find(
    (candidate) =>
      candidate.host === url.hostname.toLowerCase() &&
      (url.pathname === candidate.pagePath || url.pathname === `${candidate.pagePath}/`),
  );
  if (!route) return Object.freeze({ action: "not-found" });
  if (request.method === "GET" || request.method === "HEAD") {
    return Object.freeze({ action: "render", route });
  }
  if (request.method === "POST") return Object.freeze({ action: "submit", route });
  return Object.freeze({ action: "method-not-allowed", route });
}

function headers(contentType) {
  return {
    "Cache-Control": "no-store, max-age=0",
    "Content-Security-Policy":
      "default-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; script-src https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; style-src 'unsafe-inline'",
    "Content-Type": contentType,
    "Cross-Origin-Opener-Policy": "same-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "X-Robots-Tag": "noindex, nofollow",
    "X-Zed-Edge": "public-intake",
  };
}

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: headers("application/json; charset=utf-8"),
  });
}

function errorResponse(error, wantsHtml = false) {
  const safe = error instanceof IntakeError
    ? error
    : new IntakeError("temporarily_unavailable", 503, true);
  if (wantsHtml) {
    const retry = safe.retryable
      ? "The service is temporarily unavailable. Please try again later."
      : "The request could not be accepted. Check the form and try again.";
    return new Response(page("Request not accepted", `<p>${retry}</p><p><a href="/">Return</a></p>`), {
      status: safe.status,
      headers: headers("text/html; charset=utf-8"),
    });
  }
  return jsonResponse({ schema: SCHEMA, code: safe.code, retryable: safe.retryable }, safe.status);
}

function acceptedResponse(wantsHtml) {
  if (wantsHtml) {
    return new Response(
      page(
        "Request received",
        "<p>Your request was received. This receipt does not reveal whether the address was already registered.</p>",
      ),
      { status: 202, headers: headers("text/html; charset=utf-8") },
    );
  }
  return jsonResponse({ schema: SCHEMA, status: "accepted" }, 202);
}

function page(title, content) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · Zed</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:52rem;margin:0 auto;padding:2rem}label,fieldset{display:block;margin:1rem 0}input,select,textarea,button{font:inherit;box-sizing:border-box;max-width:100%;padding:.55rem}input[type=text],input[type=email],input[type=url],select,textarea{width:100%}fieldset label{display:inline-block;margin:.35rem 1rem .35rem 0}button{cursor:pointer}small{display:block}.hp{position:absolute;left:-10000px;width:1px;height:1px;overflow:hidden}</style></head><body><main><h1>${escapeHtml(title)}</h1>${content}</main></body></html>`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function interestControls() {
  return [...INTERESTS]
    .map(
      (interest) =>
        `<label><input type="checkbox" name="interests" value="${interest}"> ${escapeHtml(interest.replaceAll("_", " "))}</label>`,
    )
    .join("");
}

function select(name, values) {
  return `<select name="${name}" required>${[...values]
    .map((value) => `<option value="${value}">${escapeHtml(value.replaceAll("_", " "))}</option>`)
    .join("")}</select>`;
}

function renderForm(route, env, now, randomUUID) {
  const siteKey = String(env.TURNSTILE_SITE_KEY ?? "").trim();
  if (!siteKey || siteKey.startsWith("replace-")) {
    throw new IntakeError("temporarily_unavailable", 503, true);
  }
  const requestId = randomUUID();
  const consentedAt = new Date(now()).toISOString();
  const consentRevision = requiredPortableEnv(env, "CONSENT_REVISION");
  const common = `
<input type="hidden" name="schema" value="${SCHEMA}">
<input type="hidden" name="requestId" value="${escapeHtml(requestId)}">
<input type="hidden" name="consentedAt" value="${escapeHtml(consentedAt)}">
<input type="hidden" name="consentRevision" value="${escapeHtml(consentRevision)}">
<label>Email <input type="email" name="email" maxlength="254" autocomplete="email" required></label>
<label>Contact name <input type="text" name="contactName" maxlength="120" autocomplete="name"></label>
<label>Website <input type="url" name="websiteUrl" maxlength="2048" inputmode="url"></label>
<label>Locale <input type="text" name="locale" maxlength="35" value="en-US"></label>
<fieldset><legend>Areas of interest</legend>${interestControls()}</fieldset>
<label><input type="checkbox" name="contactConsent" value="true" required> I consent to storage of this request and contact about it.</label>
<label><input type="checkbox" name="marketingConsent" value="true"> I separately consent to marketing contact.</label>
<div class="hp" aria-hidden="true"><label>Leave this field empty <input type="text" name="companyUrl" tabindex="-1" autocomplete="off"></label></div>
<div class="cf-turnstile" data-sitekey="${escapeHtml(siteKey)}" data-action="${route.action}"></div>
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>`;

  const specific = route.kind === "quote"
    ? `<label>Organization <input type="text" name="organizationName" maxlength="200" required></label>
<label>Role <input type="text" name="role" maxlength="120"></label>
<label>Deployment model ${select("deploymentModel", DEPLOYMENT_MODELS)}</label>
<label>Team size ${select("teamSize", TEAM_SIZES)}</label>
<label>Package count ${select("packageCount", PACKAGE_COUNTS)}</label>
<label>Monthly downloads ${select("monthlyDownloads", MONTHLY_DOWNLOADS)}</label>
<label>Migration window ${select("migrationWindow", MIGRATION_WINDOWS)}</label>
<label>Requirements summary <textarea name="requirementsSummary" maxlength="1000" rows="7"></textarea><small>Do not include passwords, API keys, private keys, tokens, or regulated data.</small></label>`
    : "";
  const title = route.kind === "quote" ? "Request an organization quote" : "Register pre-interest";
  return page(title, `<form method="post" action="${route.pagePath}">${common}${specific}<button type="submit">Submit</button></form>`);
}

function requiredPortableEnv(env, name) {
  const value = String(env[name] ?? "").trim();
  if (!portableIdentifier(value, 64) || value.startsWith("replace-")) {
    throw new IntakeError("temporarily_unavailable", 503, true);
  }
  return value;
}

function normalizeBoolean(value) {
  return value === true || value === "true" || value === "on" || value === "1";
}

function stringValue(value, maximum, required = false) {
  if (value === undefined || value === null || value === "") {
    if (required) throw new IntakeError("invalid_request");
    return undefined;
  }
  if (typeof value !== "string") throw new IntakeError("invalid_request");
  const normalized = value.trim().replace(/\s+/g, " ");
  if ((!normalized && required) || [...normalized].length > maximum || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new IntakeError("invalid_request");
  }
  return normalized || undefined;
}

function portableIdentifier(value, maximum) {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/u.test(value);
}

function normalizeEmail(value) {
  const email = stringValue(value, 254, true)?.toLowerCase();
  if (!email || !email.includes("@") || /\s/u.test(email)) throw new IntakeError("invalid_request");
  const parts = email.split("@");
  if (parts.length !== 2 || !parts[0] || parts[0].length > 64) throw new IntakeError("invalid_request");
  const labels = parts[1].split(".");
  if (labels.length < 2 || labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label))) {
    throw new IntakeError("invalid_request");
  }
  return email;
}

function normalizeWebsite(value) {
  const raw = stringValue(value, 2048, false);
  if (!raw) return undefined;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new IntakeError("invalid_request");
  }
  if (url.protocol !== "https:" || url.username || url.password || !url.hostname.includes(".")) {
    throw new IntakeError("invalid_request");
  }
  return url.toString();
}

function normalizeInterests(value) {
  const values = Array.isArray(value) ? value : value === undefined ? [] : [value];
  if (values.length < 1 || values.length > INTERESTS.size) throw new IntakeError("invalid_request");
  if (values.some((item) => typeof item !== "string" || !INTERESTS.has(item))) {
    throw new IntakeError("invalid_request");
  }
  const unique = [...new Set(values)];
  if (unique.length !== values.length) throw new IntakeError("invalid_request");
  return unique.sort();
}

function normalizeTimestamp(value, now) {
  if (typeof value !== "string" || value.length < 20 || value.length > 35) throw new IntakeError("invalid_request");
  const time = Date.parse(value);
  if (!Number.isFinite(time) || Math.abs(now() - time) > 24 * 60 * 60 * 1000) throw new IntakeError("invalid_request");
  return new Date(time).toISOString();
}

function normalizeRequestId(value) {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
    throw new IntakeError("invalid_request");
  }
  return value.toLowerCase();
}

function rejectSecretLikeSummary(value) {
  if (!value) return value;
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:ghp|github_pat|sk)-[A-Za-z0-9_-]{12,}|\bAKIA[0-9A-Z]{16}\b|\bpassword\s*=/iu.test(value)) {
    throw new IntakeError("invalid_request");
  }
  return value;
}

function exactObject(value, allowed) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new IntakeError("invalid_request");
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new IntakeError("invalid_request");
  }
}

const COMMON_FIELDS = new Set([
  "schema",
  "requestId",
  "email",
  "sourceHost",
  "interests",
  "contactName",
  "organizationName",
  "websiteUrl",
  "locale",
  "referralCode",
  "consentRevision",
  "consentedAt",
  "contactConsent",
  "marketingConsent",
  "marketingConsentRevision",
]);
const PRE_INTEREST_FIELDS = new Set([...COMMON_FIELDS, "partyType"]);
const QUOTE_FIELDS = new Set([
  ...COMMON_FIELDS,
  "role",
  "deploymentModel",
  "teamSize",
  "packageCount",
  "monthlyDownloads",
  "migrationWindow",
  "requirementsSummary",
]);

export function normalizePayload(route, input, env, now = Date.now) {
  exactObject(input, route.kind === "quote" ? QUOTE_FIELDS : PRE_INTEREST_FIELDS);
  if (input.schema !== SCHEMA) throw new IntakeError("invalid_request");
  const requestId = normalizeRequestId(input.requestId);
  const sourceHost = route.host;
  if (input.sourceHost !== undefined && input.sourceHost !== sourceHost) throw new IntakeError("invalid_request");
  const interests = normalizeInterests(input.interests);
  const consentRevision = stringValue(input.consentRevision, 64, true);
  if (!portableIdentifier(consentRevision, 64)) throw new IntakeError("invalid_request");
  if (consentRevision !== requiredPortableEnv(env, "CONSENT_REVISION")) throw new IntakeError("invalid_request");
  if (!normalizeBoolean(input.contactConsent)) throw new IntakeError("invalid_request");
  const marketingConsent = normalizeBoolean(input.marketingConsent);
  const marketingRevision = marketingConsent
    ? requiredPortableEnv(env, "MARKETING_CONSENT_REVISION")
    : undefined;
  if (!marketingConsent && input.marketingConsentRevision !== undefined) throw new IntakeError("invalid_request");
  if (marketingConsent && input.marketingConsentRevision !== undefined && input.marketingConsentRevision !== marketingRevision) {
    throw new IntakeError("invalid_request");
  }

  const common = {
    schema: SCHEMA,
    requestId,
    email: normalizeEmail(input.email),
    sourceHost,
    interests,
    contactName: stringValue(input.contactName, 120),
    websiteUrl: normalizeWebsite(input.websiteUrl),
    locale: stringValue(input.locale, 35),
    referralCode: stringValue(input.referralCode, 64),
    consentRevision,
    consentedAt: normalizeTimestamp(input.consentedAt, now),
    contactConsent: true,
    marketingConsent,
    marketingConsentRevision: marketingRevision,
  };

  if (route.kind === "pre-interest") {
    if (input.partyType !== undefined && input.partyType !== "individual") throw new IntakeError("invalid_request");
    if (input.organizationName !== undefined) throw new IntakeError("invalid_request");
    return compact({
      ...common,
      partyType: "individual",
      organizationName: undefined,
    });
  }

  if (input.organizationName === undefined) throw new IntakeError("invalid_request");
  const deploymentModel = enumValue(input.deploymentModel, DEPLOYMENT_MODELS);
  const teamSize = enumValue(input.teamSize, TEAM_SIZES);
  const packageCount = enumValue(input.packageCount, PACKAGE_COUNTS);
  const monthlyDownloads = enumValue(input.monthlyDownloads, MONTHLY_DOWNLOADS);
  const migrationWindow = enumValue(input.migrationWindow, MIGRATION_WINDOWS);
  return compact({
    ...common,
    organizationName: stringValue(input.organizationName, 200, true),
    contactName: stringValue(input.contactName, 120, true),
    role: stringValue(input.role, 120),
    deploymentModel,
    teamSize,
    packageCount,
    monthlyDownloads,
    migrationWindow,
    requirementsSummary: rejectSecretLikeSummary(stringValue(input.requirementsSummary, 1000)),
  });
}

function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function enumValue(value, allowed) {
  if (typeof value !== "string" || !allowed.has(value)) throw new IntakeError("invalid_request");
  return value;
}

async function readBody(request) {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new IntakeError("payload_too_large", 413, false);
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > MAX_BODY_BYTES) throw new IntakeError("payload_too_large", 413, false);
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function formToObject(route, params) {
  const allowed = new Set([
    ...COMMON_FIELDS,
    ...PRE_INTEREST_FIELDS,
    ...QUOTE_FIELDS,
    "cf-turnstile-response",
    "companyUrl",
  ]);
  for (const key of params.keys()) {
    if (!allowed.has(key)) throw new IntakeError("invalid_request");
  }
  if (params.get("companyUrl")) throw new IntakeError("abuse_challenge_failed", 400, false);
  const input = {};
  for (const key of route.kind === "quote" ? QUOTE_FIELDS : PRE_INTEREST_FIELDS) {
    if (key === "interests") continue;
    const value = params.get(key);
    if (value !== null) input[key] = value;
  }
  input.interests = params.getAll("interests");
  input.contactConsent = normalizeBoolean(params.get("contactConsent"));
  input.marketingConsent = normalizeBoolean(params.get("marketingConsent"));
  return { input, proof: params.get("cf-turnstile-response") ?? "" };
}

async function parseSubmission(request, route) {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  const text = await readBody(request);
  if (contentType === "application/json") {
    let input;
    try {
      input = JSON.parse(text);
    } catch {
      throw new IntakeError("invalid_request");
    }
    return { input, proof: request.headers.get("x-zed-abuse-proof") ?? "", wantsHtml: false };
  }
  if (contentType === "application/x-www-form-urlencoded") {
    const { input, proof } = formToObject(route, new URLSearchParams(text));
    return { input, proof, wantsHtml: true };
  }
  throw new IntakeError("unsupported_media_type", 415, false);
}

function validateOrigin(request, route, wantsHtml) {
  const origin = request.headers.get("origin");
  if ((wantsHtml && origin !== `https://${route.host}`) || (origin && origin !== `https://${route.host}`)) {
    throw new IntakeError("abuse_challenge_failed", 403, false);
  }
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && !new Set(["same-origin", "none"]).has(fetchSite)) {
    throw new IntakeError("abuse_challenge_failed", 403, false);
  }
}

async function verifyTurnstile({ fetchImpl, proof, request, route, env }) {
  const secret = String(env.TURNSTILE_SECRET_KEY ?? "").trim();
  if (secret.length < 20 || !proof) throw new IntakeError("abuse_challenge_failed", 400, false);
  const body = new URLSearchParams({ secret, response: proof });
  const remoteIp = request.headers.get("cf-connecting-ip");
  if (remoteIp) body.set("remoteip", remoteIp);
  let response;
  try {
    response = await fetchImpl(TURNSTILE_VERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      redirect: "error",
    });
  } catch {
    throw new IntakeError("temporarily_unavailable", 503, true);
  }
  if (!response.ok) throw new IntakeError("temporarily_unavailable", 503, true);
  let result;
  try {
    result = await response.json();
  } catch {
    throw new IntakeError("temporarily_unavailable", 503, true);
  }
  if (result?.success !== true || result.hostname !== route.host || result.action !== route.action) {
    throw new IntakeError("abuse_challenge_failed", 400, false);
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function toHex(bytes) {
  return [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(value) {
  return toHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

async function hmacHex(key, value) {
  const imported = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return toHex(await crypto.subtle.sign("HMAC", imported, new TextEncoder().encode(value)));
}

function apiOrigin(env) {
  let url;
  try {
    url = new URL(String(env.API_ORIGIN ?? "https://api.zpkg.net"));
  } catch {
    throw new IntakeError("temporarily_unavailable", 503, true);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new IntakeError("temporarily_unavailable", 503, true);
  }
  return url;
}

async function forwardToApi({ fetchImpl, route, payload, env, now }) {
  const key = String(env.INTAKE_SIGNING_KEY ?? "");
  if (key.length < 32) throw new IntakeError("temporarily_unavailable", 503, true);
  const body = canonicalJson(payload);
  const digest = await sha256Hex(body);
  const timestamp = String(Math.floor(now() / 1000));
  const signed = `v1\n${timestamp}\n${route.host}\n${route.apiPath}\n${payload.requestId}\n${digest}`;
  const signature = await hmacHex(key, signed);
  const target = new URL(route.apiPath, apiOrigin(env));
  let response;
  try {
    response = await fetchImpl(target, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": payload.requestId,
        "X-Zed-Intake-Body-Sha256": digest,
        "X-Zed-Intake-Signature": `v1=${signature}`,
        "X-Zed-Intake-Source-Host": route.host,
        "X-Zed-Intake-Timestamp": timestamp,
      },
      body,
      redirect: "error",
      signal: typeof AbortSignal?.timeout === "function" ? AbortSignal.timeout(API_TIMEOUT_MS) : undefined,
    });
  } catch {
    throw new IntakeError("temporarily_unavailable", 503, true);
  }
  if (response.status === 202) {
    let value;
    try {
      value = await response.json();
    } catch {
      throw new IntakeError("temporarily_unavailable", 503, true);
    }
    if (value?.schema === SCHEMA && value?.status === "accepted") return;
    throw new IntakeError("temporarily_unavailable", 503, true);
  }
  if (response.status === 429) throw new IntakeError("rate_limited", 429, true);
  if ([400, 403, 413, 415, 422].includes(response.status)) throw new IntakeError("invalid_request", 400, false);
  throw new IntakeError("temporarily_unavailable", 503, true);
}

export function createHandler({ fetchImpl = fetch, now = Date.now, randomUUID = () => crypto.randomUUID() } = {}) {
  return async function handle(request, env) {
    const decision = classifyRequest(request);
    if (decision.action === "not-found") return new Response("Not Found", { status: 404, headers: headers("text/plain; charset=utf-8") });
    if (decision.action === "method-not-allowed") {
      return new Response("Method Not Allowed", { status: 405, headers: { ...headers("text/plain; charset=utf-8"), Allow: "GET, HEAD, POST" } });
    }
    if (decision.action === "render") {
      try {
        const html = renderForm(decision.route, env, now, randomUUID);
        return new Response(request.method === "HEAD" ? null : html, { status: 200, headers: headers("text/html; charset=utf-8") });
      } catch (error) {
        return errorResponse(error, true);
      }
    }

    let wantsHtml = false;
    try {
      const parsed = await parseSubmission(request, decision.route);
      wantsHtml = parsed.wantsHtml;
      validateOrigin(request, decision.route, wantsHtml);
      const payload = normalizePayload(decision.route, parsed.input, env, now);
      const idempotency = request.headers.get("idempotency-key");
      if (idempotency && idempotency !== payload.requestId) throw new IntakeError("invalid_request");
      await verifyTurnstile({ fetchImpl, proof: parsed.proof, request, route: decision.route, env });
      await forwardToApi({ fetchImpl, route: decision.route, payload, env, now });
      return acceptedResponse(wantsHtml);
    } catch (error) {
      return errorResponse(error, wantsHtml);
    }
  };
}

const handle = createHandler();

export default {
  fetch(request, env) {
    return handle(request, env);
  },
};
