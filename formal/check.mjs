import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const fmctl = process.argv[2];
assert(fmctl && process.argv.length === 3, "Usage: node formal/check.mjs /path/to/fmctl");
const read = (path) => readFileSync(`${root}${path}`, "utf8");
const json = (path) => JSON.parse(read(path));
function execute(args, expectSuccess = true) {
  const result = spawnSync(fmctl, args, {
    cwd: root, encoding: "utf8", timeout: 650_000, maxBuffer: 8 * 1024 * 1024,
  });
  assert(!result.error && result.status !== null, "fmctl process failed or exceeded bounds");
  if (expectSuccess && result.status !== 0) {
    process.stderr.write(result.stdout + result.stderr);
    assert.fail("fmctl verification or implementation replay failed");
  }
  if (!expectSuccess) assert.notEqual(result.status, 0, "negative control incorrectly passed");
  process.stdout.write(`Checked ${args.join(" ")} (${expectSuccess ? "pass" : "expected failure"})\n`);
}
for (const operation of ["validate", "check", "simulate", "verify", "trace"]) execute([operation]);
const traceReport = json(".formal-artifacts/fmctl/trace.result.json");
assert.equal(traceReport.success, true);
assert(traceReport.args.includes("--n-traces=16"));
const pattern = traceReport.artifacts.trace_pattern;
assert.equal(pattern.split("{seq}").length, 2);
const paths = Array.from({ length: 16 }, (_, index) => {
  const path = relative(root, pattern.replace("{seq}", String(index)));
  assert(path && !isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
  return path;
});
execute(["replay", "--adapter", "typescript", ...paths.flatMap((path) => ["--trace", path])]);

// Independent controls: the verifier must find a real counterexample, and
// the adapter must report actual production/model disagreement. A parser,
// timeout, missing dependency, or malformed protocol is not an acceptable red.
const negative = ".formal-artifacts/negative-controls";
mkdirSync(`${root}${negative}`, { recursive: true });
const model = read("formal/origin_handshake.qnt");
const needle = "upgrade_forwarded: s.mode == \"websocket\", manual_redirect: true,";
assert.equal(model.split(needle).length, 2);
writeFileSync(`${root}${negative}/redirect-mutant.qnt`, model.replace(needle,
  "upgrade_forwarded: s.mode == \"websocket\", manual_redirect: false,"));
const manifest = read("formal/fm.toml");
writeFileSync(`${root}${negative}/verify.toml`, manifest
  .replace('spec = "formal/origin_handshake.qnt"', `spec = "${negative}/redirect-mutant.qnt"`)
  .replace('artifacts_dir = ".formal-artifacts"', `artifacts_dir = "${negative}/verification"`));
execute(["--manifest", `${negative}/verify.toml`, "verify"], false);
const counterexample = json(`${negative}/verification/fmctl/verify.result.json`);
assert.equal(counterexample.success, false);
assert.match(counterexample.stdout, /Invariant .* is violated/);

const mutant = json(paths[0]);
for (const { s } of mutant.states) {
  if (s.phase.tag === "Done") s.manual_redirect = !s.manual_redirect;
}
writeFileSync(`${root}${negative}/observation-mutant.itf.json`, JSON.stringify(mutant));
writeFileSync(`${root}${negative}/replay.toml`, manifest
  .replace('artifacts_dir = ".formal-artifacts"', `artifacts_dir = "${negative}/adapter"`));
execute(["--manifest", `${negative}/replay.toml`, "replay", "--adapter", "typescript",
  "--trace", `${negative}/observation-mutant.itf.json`], false);
const replayReport = json(`${negative}/adapter/fmctl/replay-typescript.result.json`);
assert.equal(replayReport.success, false);
const mismatch = JSON.parse(replayReport.stdout);
assert.equal(mismatch.success, false);
assert(mismatch.mismatches.some((item) =>
  item.message === "Production origin handler disagrees with model observation"));
writeFileSync(`${root}${negative}/result.json`, JSON.stringify({
  success: true, verifier_counterexample: true, production_replay_mismatch: true,
}) + "\n");
process.stdout.write("Finite verification, 16 production replays, and both negative controls passed.\n");
