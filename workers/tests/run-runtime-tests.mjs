import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = new URL("./", import.meta.url);
const sourceUrl = new URL("edge-publish.test.mjs", here);
const generatedUrl = new URL(".edge-publish.generated.test.mjs", here);
const source = readFileSync(sourceUrl, "utf8");

const registryModules = `          modules: [
            "registry-proxy/src/index.js",
            "shared/github-fallback.js",
            "shared/native-public.js",
            "shared/edge-publish.js",
            "shared/ghcr.js",
            "shared/public-visibility.js",
          ].map((path) => ({ type: "ESModule", path: \`\${root}\${path}\` })),
          modulesRoot: root,`;

const registryGraph = `          scriptPath: \`\${root}registry-proxy/src/index.js\`,
          modules: true,
          modulesRules: [{ type: "ESModule", include: ["**/*.js"], fallthrough: true }],
          modulesRoot: root,`;

const cdnModules = `          modules: [
            "cdn-proxy/src/index.js",
            "shared/github-fallback.js",
            "shared/native-public.js",
            "shared/public-visibility.js",
          ].map((path) => ({ type: "ESModule", path: \`\${root}\${path}\` })),
          modulesRoot: root,`;

const cdnGraph = `          scriptPath: \`\${root}cdn-proxy/src/index.js\`,
          modules: true,
          modulesRules: [{ type: "ESModule", include: ["**/*.js"], fallthrough: true }],
          modulesRoot: root,`;

if (!source.includes(registryModules) || !source.includes(cdnModules)) {
  throw new Error("edge-publish Miniflare harness shape drifted; update the graph-crawl launcher explicitly");
}

const generated = source.replace(registryModules, registryGraph).replace(cdnModules, cdnGraph);
if (generated.includes(registryModules) || generated.includes(cdnModules)) {
  throw new Error("edge-publish Miniflare module-list replacement was incomplete");
}

writeFileSync(generatedUrl, generated, { encoding: "utf8", mode: 0o600 });
try {
  const result = spawnSync(
    process.execPath,
    ["--test", fileURLToPath(generatedUrl), fileURLToPath(new URL("origin-websocket.test.mjs", here))],
    { stdio: "inherit" },
  );
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  try {
    unlinkSync(generatedUrl);
  } catch {}
}
