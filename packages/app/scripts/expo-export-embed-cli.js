#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const projectRoot = path.resolve(__dirname, "..");
const args = process.argv.slice(2);
const entryFileFlagIndex = args.indexOf("--entry-file");

if (entryFileFlagIndex >= 0 && args[entryFileFlagIndex + 1]) {
  const entryFile = args[entryFileFlagIndex + 1];
  const appRelativeEntryFile = path.resolve(projectRoot, entryFile);
  if (!path.isAbsolute(entryFile) && fs.existsSync(appRelativeEntryFile)) {
    args[entryFileFlagIndex + 1] = appRelativeEntryFile;
  }
}

const expoCli = require.resolve("@expo/cli/build/bin/cli", { paths: [projectRoot] });
const result = spawnSync(process.execPath, [expoCli, ...args], {
  cwd: projectRoot,
  env: process.env,
  stdio: "inherit",
});

if (result.error) {
  throw result.error;
}

if (result.signal) {
  process.kill(process.pid, result.signal);
} else {
  process.exit(result.status ?? 1);
}
