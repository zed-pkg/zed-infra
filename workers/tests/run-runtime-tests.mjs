import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = new URL("./", import.meta.url);
const workersRoot = fileURLToPath(new URL("../", import.meta.url));
const sourceUrl = new URL("edge-publish.test.mjs", here);
const generatedUrl = new URL(".edge-publish.generated.test.mjs", here);
const source = readFileSync(sourceUrl, "utf8");

function normalize(path) {
  return path.replaceAll("\\", "/");
}

function crawlModules(entrypoint) {
  const ordered = [];
  const seen = new Set();

  function visit(modulePath) {
    const normalized = normalize(modulePath);
    if (seen.has(normalized)) return;
    if (normalized.startsWith("../") || normalized.startsWith("/")) {
      throw new Error(`module escaped workers root: ${normalized}`);
    }

    seen.add(normalized);
    ordered.push(normalized);

    const absolute = resolve(workersRoot, normalized);
    const text = readFileSync(absolute, "utf8");
    const specifiers = new Set();

    for (const regex of [
      /\b(?:import|export)\s+(?:[^"'\`]*?\s+from\s+)?["'](\.[^"']+)["']/g,
      /\bimport\s*\(\s*["'](\.[^"']+)["']\s*\)/g,
    ]) {
      for (const match of text.matchAll(regex)) specifiers.add(match[1]);
    }

    for (const specifier of specifiers) {
      const child = normalize(relative(workersRoot, resolve(dirname(absolute), specifier)));
      visit(child);
    }
  }

  visit(entrypoint);
  return ordered;
}

function moduleBlock(paths) {
  const rows = paths.map((path) => `            ${JSON.stringify(path)},`).join("\n");
  return `          modules: [\n${rows}\n          ].map((path) => ({ type: "ESModule", path: \`\${root}\${path}\` })),\n          modulesRoot: root,`;
}

const registryModules = `          modules: [
            "registry-proxy/src/index.js",
            "shared/github-fallback.js",
            "shared/native-public.js",
            "shared/edge-publish.js",
            "shared/ghcr.js",
            "shared/public-visibility.js",
          ].map((path) => ({ type: "ESModule", path: \`\${root}\${path}\` })),
          modulesRoot: root,`;

const cdnModules = `          modules: [
            "cdn-proxy/src/index.js",
            "shared/github-fallback.js",
            "shared/native-public.js",
            "shared/public-visibility.js",
          ].map((path) => ({ type: "ESModule", path: \`\${root}\${path}\` })),
          modulesRoot: root,`;

if (!source.includes(registryModules) || !source.includes(cdnModules)) {
  throw new Error("edge-publish Miniflare harness shape drifted; update the module crawler explicitly");
}

const registryGraph = moduleBlock(crawlModules("registry-proxy/src/index.js"));
const cdnGraph = moduleBlock(crawlModules("cdn-proxy/src/index.js"));
const generated = source.replace(registryModules, registryGraph).replace(cdnModules, cdnGraph);

if (generated.includes(registryModules) || generated.includes(cdnModules)) {
  throw new Error("edge-publish Miniflare module-list replacement was incomplete");
}

writeFileSync(generatedUrl, generated, { encoding: "utf8", mode: 0o600 });
try {
  const result = spawnSync(
    process.execPath,
    [
      "--test",
      "--test-reporter=tap",
      fileURLToPath(generatedUrl),
      fileURLToPath(new URL("origin-websocket.test.mjs", here)),
    ],
    { stdio: "inherit", timeout: 60_000, killSignal: "SIGKILL" },
  );
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  try {
    unlinkSync(generatedUrl);
  } catch {}
}
