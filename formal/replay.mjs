import assert from "node:assert/strict";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { modes, statuses, observeOrigin } from "../workers/tests/origin-observation.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const decode = (bytes) => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
const integer = (value) => {
  assert.deepEqual(Object.keys(value), ["#bigint"]);
  assert.match(value["#bigint"], /^(0|[1-9][0-9]{0,3})$/);
  return Number(value["#bigint"]);
};

async function replay() {
  assert.equal(process.argv.length, 2);
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    assert(bytes <= 1024 * 1024);
    chunks.push(chunk);
  }
  const request = decode(Buffer.concat(chunks));
  assert.deepEqual(Object.keys(request).sort(),
    ["adapter", "model", "project", "protocol", "specification", "traces"]);
  assert.equal(request.protocol, "fmctl.adapter.v1");
  assert.equal(request.project, "zed-infra");
  assert.equal(request.model, "origin-handshake-v1");
  assert.equal(request.adapter, "typescript");
  assert.equal(realpathSync(request.specification), realpathSync(`${root}formal/origin_handshake.qnt`));
  assert(Array.isArray(request.traces) && request.traces.length > 0 && request.traces.length <= 64);
  const artifactRoot = realpathSync(`${root}.formal-artifacts`);
  const seen = new Set();
  const mismatches = [];
  let passed = 0;
  for (const path of request.traces) {
    assert.equal(typeof path, "string");
    assert(isAbsolute(path));
    const canonical = realpathSync(path);
    const local = relative(artifactRoot, canonical);
    assert(local && !isAbsolute(local) && local !== ".." && !local.startsWith(`..${sep}`));
    assert(!seen.has(canonical));
    seen.add(canonical);
    const stat = statSync(canonical);
    assert(stat.isFile() && stat.size > 0 && stat.size <= 1024 * 1024);
    bytes += stat.size;
    assert(bytes <= 8 * 1024 * 1024);
    const trace = decode(readFileSync(canonical));
    assert.deepEqual(trace.vars, ["s", "mbt::actionTaken", "mbt::nondetPicks"]);
    assert(Array.isArray(trace.states) && trace.states.length >= 2 && trace.states.length <= 8);
    let scenario;
    let actual;
    let nextPhase = "Start";
    let matched = true;
    for (const [index, state] of trace.states.entries()) {
      assert.deepEqual(Object.keys(state).sort(), ["#meta", "mbt::actionTaken", "mbt::nondetPicks", "s"]);
      assert.equal(state["mbt::actionTaken"], index === 0 ? "init" : "step");
      const { s } = state;
      assert.deepEqual(Object.keys(s).sort(), ["edge_owned", "has_socket", "manual_redirect", "mode",
        "origin_called", "outcome", "phase", "socket_passed", "status", "status_returned", "upgrade_forwarded"]);
      assert(modes.includes(s.mode));
      const status = integer(s.status);
      assert(statuses.includes(status));
      for (const key of ["has_socket", "edge_owned", "origin_called", "upgrade_forwarded", "manual_redirect", "socket_passed"]) {
        assert.equal(typeof s[key], "boolean");
      }
      assert(["pending", "http", "reject", "upgrade", "unavailable"].includes(s.outcome));
      assert.deepEqual(Object.keys(s.phase).sort(), ["tag", "value"]);
      assert.deepEqual(s.phase.value, { "#tup": [] });
      assert.equal(s.phase.tag, nextPhase);
      const input = { mode: s.mode, status, has_socket: s.has_socket, edge_owned: s.edge_owned };
      if (!scenario) scenario = input;
      else assert.deepEqual(input, scenario, "request configuration changed inside trace");
      const expected = { outcome: s.outcome, status_returned: integer(s.status_returned),
        origin_called: s.origin_called, upgrade_forwarded: s.upgrade_forwarded,
        manual_redirect: s.manual_redirect, socket_passed: s.socket_passed };
      if (s.phase.tag === "Done") {
        actual ??= await observeOrigin(scenario);
        if (!isDeepStrictEqual(actual, expected)) {
          matched = false;
          mismatches.push({ trace: canonical, step: index, action: "step",
            message: "Production origin handler disagrees with model observation", expected, actual });
        }
      } else {
        assert.deepEqual(expected, { outcome: "pending", status_returned: 0,
          origin_called: false, upgrade_forwarded: false, manual_redirect: false, socket_passed: false });
      }
      nextPhase = s.phase.tag === "Start" && s.mode !== "reject" ? "Forward" : "Done";
    }
    assert(actual, "trace must reach and exercise the production handler");
    if (matched) passed++;
  }
  const success = mismatches.length === 0;
  process.stdout.write(JSON.stringify({ protocol: "fmctl.adapter.v1", success,
    traces_total: request.traces.length, traces_passed: passed, mismatches,
    implementation: { language: "typescript", name: "zed origin Worker", version: "1" } }) + "\n");
  if (!success) process.exitCode = 1;
}

try { await replay(); }
catch {
  process.stderr.write("Origin replay rejected invalid protocol, trace shape, or path.\n");
  process.exitCode = 1;
}
