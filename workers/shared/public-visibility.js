/**
 * Public-edge admission only. This does not authenticate users or grant
 * private-package access. Absent visibility retains the legacy public-only
 * storage contract; an explicit value must be exactly "public".
 */
export function permitsPublicVisibility(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return false;
  }
  return !Object.hasOwn(record, "visibility") || record.visibility === "public";
}

export class NonPublicObjectError extends Error {
  constructor() {
    super("object is not available from the public edge");
    this.name = "NonPublicObjectError";
  }
}

export function requirePublicObject(object) {
  if (object.customMetadata !== undefined && !permitsPublicVisibility(object.customMetadata)) {
    throw new NonPublicObjectError();
  }
}
