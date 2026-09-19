/**
 * GitHub Packages (GHCR) as a second home for published artifacts.
 *
 * R2 is the primary store; this is the copy that survives losing the bucket,
 * and the one a consumer can reach with nothing but a GitHub account.
 *
 * Two asymmetric halves, deliberately:
 *
 * - **Reading is anonymous.** The public edge must never make private
 *   repositories observable, so reads carry no credential and simply fail for
 *   anything that is not publicly readable. That is the same rule the GitHub
 *   release fallback already follows.
 * - **Writing needs a token**, and only ever runs inside a publish that has
 *   already authenticated. The token is a push credential for the packages
 *   namespace, so it is never attached to a request that a stranger can cause.
 *
 * The artifact is stored as a single-layer OCI image: the tarball is the
 * layer, the config is the empty JSON object, and the manifest is tagged with
 * the package version.
 */

export const GHCR_HOST = "https://ghcr.io";
export const OCI_MANIFEST_TYPE = "application/vnd.oci.image.manifest.v1+json";
export const OCI_CONFIG_TYPE = "application/vnd.oci.image.config.v1+json";
export const OCI_LAYER_TYPE = "application/vnd.oci.image.layer.v1.tar+gzip";

/** The empty JSON object every single-layer artifact image uses as its config. */
export const EMPTY_CONFIG = "{}";
export const EMPTY_CONFIG_DIGEST =
  "sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a";

const SHA256 = /^[a-f0-9]{64}$/;
const SEGMENT = /^[a-z0-9][a-z0-9._-]*$/;
const TAG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * Repository path for a package.
 *
 * GHCR namespaces by owner, and package names are lowercased there, so a
 * coordinate maps to `<org>/<name>` with both segments already slug-shaped.
 */
export function ghcrRepositoryPath(org, name) {
  if (typeof org !== "string" || typeof name !== "string") return null;
  const owner = org.toLowerCase();
  const pkg = name.toLowerCase();
  if (!SEGMENT.test(owner) || !SEGMENT.test(pkg)) return null;
  return `${owner}/${pkg}`;
}

export function ghcrManifestUrl(repository, reference) {
  return `${GHCR_HOST}/v2/${repository}/manifests/${reference}`;
}

export function ghcrBlobUrl(repository, digest) {
  return `${GHCR_HOST}/v2/${repository}/blobs/${digest}`;
}

export function ghcrUploadUrl(repository, digest) {
  return `${GHCR_HOST}/v2/${repository}/blobs/uploads/?digest=${encodeURIComponent(digest)}`;
}

/**
 * Exchange a credential for a registry bearer token.
 *
 * `token` is optional: without it the request is anonymous, which is what read
 * paths use and is sufficient for public packages.
 */
export async function ghcrToken(repository, actions, { token, fetchImpl = fetch } = {}) {
  const scope = `repository:${repository}:${actions}`;
  const url = `${GHCR_HOST}/token?service=ghcr.io&scope=${encodeURIComponent(scope)}`;
  const headers = new Headers({ accept: "application/json" });
  if (token) {
    // GHCR accepts a PAT as the password of a basic credential; the username
    // is ignored but must be present.
    headers.set("authorization", `Basic ${btoa(`x-access-token:${token}`)}`);
  }
  const response = await fetchImpl(url, { headers });
  if (!response.ok) return null;
  const body = await response.json();
  return typeof body.token === "string" ? body.token : null;
}

/**
 * Build the single-layer image manifest for an artifact.
 */
export function artifactManifest({ digest, size }) {
  if (!SHA256.test(digest) || !Number.isInteger(size) || size <= 0) return null;
  return {
    schemaVersion: 2,
    mediaType: OCI_MANIFEST_TYPE,
    config: {
      mediaType: OCI_CONFIG_TYPE,
      digest: EMPTY_CONFIG_DIGEST,
      size: EMPTY_CONFIG.length,
    },
    layers: [
      {
        mediaType: OCI_LAYER_TYPE,
        digest: `sha256:${digest}`,
        size,
      },
    ],
  };
}

/**
 * Read the artifact coordinates a published image points at.
 *
 * Returns `{ digest, size }` for the single layer, or null when the reference
 * is absent, private, or not an artifact image this scheme produced.
 */
export async function readGhcrArtifact(repository, reference, { fetchImpl = fetch } = {}) {
  if (!TAG.test(reference)) return null;
  const token = await ghcrToken(repository, "pull", { fetchImpl });
  const headers = new Headers({ accept: OCI_MANIFEST_TYPE });
  if (token) headers.set("authorization", `Bearer ${token}`);
  const response = await fetchImpl(ghcrManifestUrl(repository, reference), { headers });
  if (!response.ok) return null;
  let manifest;
  try {
    manifest = await response.json();
  } catch {
    return null;
  }
  const layer = Array.isArray(manifest?.layers) ? manifest.layers[0] : null;
  if (!layer || typeof layer.digest !== "string") return null;
  const digest = layer.digest.startsWith("sha256:") ? layer.digest.slice(7) : null;
  if (!digest || !SHA256.test(digest)) return null;
  const size = Number(layer.size);
  if (!Number.isInteger(size) || size <= 0) return null;
  return { digest, size, downloadUrl: ghcrBlobUrl(repository, `sha256:${digest}`) };
}

/**
 * Push one artifact to GHCR as a tagged single-layer image.
 *
 * Best effort by contract: the caller has already stored the authoritative
 * copy, so a failure here is reported and swallowed rather than failing a
 * publish that already succeeded.
 */
export async function pushArtifactToGhcr({
  repository,
  reference,
  bytes,
  digest,
  token,
  fetchImpl = fetch,
}) {
  if (!token) return { ok: false, reason: "no_token" };
  if (!repository || !TAG.test(reference)) return { ok: false, reason: "invalid_target" };
  const manifest = artifactManifest({ digest, size: bytes.byteLength });
  if (!manifest) return { ok: false, reason: "invalid_artifact" };

  const registryToken = await ghcrToken(repository, "push,pull", { token, fetchImpl });
  if (!registryToken) return { ok: false, reason: "token_refused" };
  const authorized = (extra = {}) =>
    new Headers({ authorization: `Bearer ${registryToken}`, ...extra });

  // Monolithic uploads: one request per blob, which keeps this path free of
  // chunk bookkeeping the Worker would otherwise have to resume.
  const configUpload = await fetchImpl(ghcrUploadUrl(repository, EMPTY_CONFIG_DIGEST), {
    method: "POST",
    headers: authorized({ "content-type": "application/octet-stream" }),
    body: EMPTY_CONFIG,
  });
  if (!uploadAccepted(configUpload)) return { ok: false, reason: "config_upload_failed" };

  const layerUpload = await fetchImpl(ghcrUploadUrl(repository, `sha256:${digest}`), {
    method: "POST",
    headers: authorized({ "content-type": "application/octet-stream" }),
    body: bytes,
  });
  if (!uploadAccepted(layerUpload)) return { ok: false, reason: "layer_upload_failed" };

  const manifestPut = await fetchImpl(ghcrManifestUrl(repository, reference), {
    method: "PUT",
    headers: authorized({ "content-type": OCI_MANIFEST_TYPE }),
    body: JSON.stringify(manifest),
  });
  if (!manifestPut.ok) return { ok: false, reason: "manifest_rejected" };
  return { ok: true, reference, digest };
}

/**
 * A blob that already exists answers 200; a fresh upload answers 201.
 */
function uploadAccepted(response) {
  return Boolean(response && (response.ok || response.status === 201 || response.status === 200));
}
