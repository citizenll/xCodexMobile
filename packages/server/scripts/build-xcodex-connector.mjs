import { createHash } from "node:crypto";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(scriptDir, "..");
const packageJson = JSON.parse(
  await readFile(path.join(packageRoot, "package.json"), "utf8"),
);
const outDir = path.join(packageRoot, "dist", "xcodex-connector");
const outFile = path.join(outDir, "xcodex-mobile-connector.mjs");
const metaFile = path.join(outDir, "metafile.json");
const manifestFile = path.join(outDir, "manifest.json");
const maxBundleBytes = Number(process.env.XCODEX_CONNECTOR_MAX_BYTES ?? 5 * 1024 * 1024);

const bannedInputs = [
  "node_modules/node-pty",
  "node_modules/onnxruntime-node",
  "node_modules/sherpa-onnx",
  "node_modules/@anthropic-ai",
  "node_modules/@opencode-ai",
  "node_modules/@mariozechner",
  "node_modules/openai",
  "node_modules/@modelcontextprotocol",
  "src/server/speech/",
  "src/server/agent/providers/",
  "src/terminal/",
];

await rm(outDir, { recursive: true, force: true });

const buildTime = new Date().toISOString();
const result = await build({
  entryPoints: [path.join(packageRoot, "src", "server", "xcodex-mobile-connector", "main.ts")],
  outfile: outFile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: ["node20"],
  conditions: ["node", "import", "default"],
  sourcemap: false,
  minify: true,
  treeShaking: true,
  legalComments: "none",
  metafile: true,
  banner: {
    js: "import { createRequire as __xcodexCreateRequire } from 'node:module'; const require = __xcodexCreateRequire(import.meta.url);",
  },
  define: {
    __XCODEX_CONNECTOR_VERSION__: JSON.stringify(packageJson.version),
    __XCODEX_CONNECTOR_BUILD_TIME__: JSON.stringify(buildTime),
  },
});

await writeFile(metaFile, JSON.stringify(result.metafile, null, 2));

const normalizedInputs = Object.keys(result.metafile.inputs).map((input) =>
  input.replaceAll("\\", "/"),
);
const bannedMatches = normalizedInputs.filter((input) =>
  bannedInputs.some((banned) => input.includes(banned)),
);
if (bannedMatches.length > 0) {
  throw new Error(
    `xCodex connector bundle pulled forbidden daemon dependencies:\n${bannedMatches.join("\n")}`,
  );
}

const bytes = (await stat(outFile)).size;
if (bytes > maxBundleBytes) {
  throw new Error(
    `xCodex connector bundle is ${(bytes / 1024 / 1024).toFixed(2)} MiB, over budget ${(maxBundleBytes / 1024 / 1024).toFixed(2)} MiB.`,
  );
}

const bundle = await readFile(outFile);
const sha256 = createHash("sha256").update(bundle).digest("hex");
const manifest = {
  name: "xcodex-mobile-connector",
  version: packageJson.version,
  generatedAt: buildTime,
  entry: "xcodex-mobile-connector.mjs",
  bytes,
  sha256,
  maxBundleBytes,
  relayEndpoint: "relay.xcodex.app:443",
  relayUseTls: true,
  appBaseUrl: "xcodex://pair",
};

await writeFile(manifestFile, JSON.stringify(manifest, null, 2) + "\n");
console.log(
  `Built xCodex mobile connector: ${path.relative(process.cwd(), outFile)} (${(bytes / 1024).toFixed(1)} KiB)`,
);
