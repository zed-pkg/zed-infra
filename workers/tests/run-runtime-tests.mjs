import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = new URL("./", import.meta.url);
const sourceUrl = new URL("edge-publish.test.mjs", here);
const generatedUrl = new URL(".edge-publish.generated.test.mjs", here);
const source = readFileSync(sourceUrl, "utf8");

const v4Import = 'import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from "miniflare";';
const v5Import = 'import { Miniflare, Log, LogLevel } from "miniflare";';
const v4Open = `  const mf = new Miniflare(\n    convertV4MiniflareOptions({`;
const v5Open = `  const mf = new Miniflare({`;
const v4Close = `      log: new Log(LogLevel.ERROR),\n    }),\n  );`;
const v5Close = `      log: new Log(LogLevel.ERROR),\n    },\n  );`;

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

if (!source.includes(v4Import) || !source.includes(v4Open) || !source.includes(v4Close)) {
  throw new Error("edge-publish Miniflare v4 wrapper drifted; update the graph-crawl launcher explicitly");
}

const generated = source
  .replace(v4Import, v5Import)
  .replace(v4Open, v5Open)
  .replace(v4Close, v5Close)
  .replace(registryModules, registryGraph)
  .replace(cdnModules, cdnGraph);

if (
  generated.includes(registryModules) ||
  generated.includes(cdnModules) ||
  generated.includes("convertV4MiniflareOptions")
) {
  throw new Error("edge-publish Miniflare v5 graph-crawl replacement was incomplete");
}

writeFileSync(generatedUrl, generated, { encoding: "utf8", mode: 0o600 });
try {
  const result = spawnSync(
    process.execPath,
    ["--test", fileURLToPath(generatedUrl), fileURLToPath(new URL("origin-websocket.test.mjs", here))],
    { stdio: "inherit", timeout: 180_000, killSignal: "SIGKILL" },
  );
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  try {
    unlinkSync(generatedUrl);
  } catch {}
}
