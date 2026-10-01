import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const policyUrl = new URL("../policy/package-intake.v1.json", import.meta.url);
const policy = JSON.parse(readFileSync(policyUrl, "utf8"));

function hasTransition(from, to) {
  return policy.allowed_transitions.some(([source, target]) => source === from && target === to);
}

assert.equal(policy.schema, "zed.package-intake.policy/v1");
assert.equal(policy.default_decision, "quarantine");

for (const ecosystem of ["npm", "cargo", "python", "git"]) {
  assert.ok(policy.ecosystems.includes(ecosystem), `missing ecosystem: ${ecosystem}`);
}

assert.equal(policy.source.require_immutable_identity_before_execution, true);
assert.equal(policy.source.mutable_ref_must_resolve_to_immutable_identity, true);
for (const evidence of ["source_uri", "source_digest", "resolved_revision"]) {
  assert.ok(policy.source.required_evidence.includes(evidence), `missing source evidence: ${evidence}`);
}

assert.equal(policy.sandbox.ephemeral, true);
assert.equal(policy.sandbox.credentials, "none");
assert.equal(policy.sandbox.network_egress, "deny_by_default");
assert.equal(policy.sandbox.privileged, false);
assert.equal(policy.sandbox.host_mounts, "none");
assert.equal(policy.sandbox.write_scope, "ephemeral_workspace_only");

for (const requiredSignal of [
  "typosquatting",
  "dependency_confusion",
  "install_or_lifecycle_scripts",
  "unexpected_network_behavior",
  "source_artifact_mismatch",
  "obfuscation_or_generated_payload",
  "secret_or_credential_access",
  "native_binary_or_dynamic_library",
]) {
  assert.ok(policy.risk.required_signal_classes.includes(requiredSignal), `missing risk signal: ${requiredSignal}`);
}
assert.equal(policy.risk.missing_required_scanner, "fail_closed");
assert.equal(policy.risk.scanner_timeout, "fail_closed");

assert.equal(policy.rebuild.required_before_publish, true);
for (const comparison of ["artifact_digest", "declared_file_manifest", "dependency_lock_identity"]) {
  assert.ok(policy.rebuild.compare.includes(comparison), `missing rebuild comparison: ${comparison}`);
}
assert.equal(policy.rebuild.source_artifact_mismatch, "reject");
assert.equal(policy.rebuild.missing_rebuild_evidence, "fail_closed");

for (const binding of [
  "artifact_digest",
  "source_digest",
  "policy_digest",
  "risk_receipt_digest",
  "rebuild_receipt_digest",
]) {
  assert.ok(policy.approval.bind_to.includes(binding), `approval is not bound to ${binding}`);
}
assert.equal(policy.approval.stale_approval, "reject");

for (const state of ["received", "quarantined", "evaluated", "pending_approval", "rejected", "publishable", "published"]) {
  assert.ok(policy.states.includes(state), `missing state: ${state}`);
}

assert.equal(hasTransition("received", "published"), false, "direct intake-to-publish transition is forbidden");
assert.equal(hasTransition("received", "publishable"), false, "intake must pass through quarantine/evaluation");
assert.equal(hasTransition("received", "quarantined"), true);
assert.equal(hasTransition("quarantined", "evaluated"), true);
assert.equal(hasTransition("publishable", "published"), true);

for (const evidence of ["risk_receipt", "rebuild_receipt", "policy_receipt", "artifact_digest"]) {
  assert.ok(policy.publication.required_evidence.includes(evidence), `publication missing evidence: ${evidence}`);
}
assert.equal(policy.publication.missing_required_evidence, "fail_closed");
assert.equal(policy.publication.mutable_tag_only_identity, "reject");

console.log("secure package intake policy invariants: OK");
