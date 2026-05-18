const fs = require("node:fs");
const path = require("node:path");
const { withDangerousMod } = require("expo/config-plugins");

const ICON_FILE = "ic_launcher.png";
const ROUND_ICON_FILE = "ic_launcher_round.png";

function copyLauncherIcons(projectRoot, platformProjectRoot) {
  const sourceRoot = path.join(projectRoot, "assets", "android");
  const resRoot = path.join(platformProjectRoot, "app", "src", "main", "res");

  if (!fs.existsSync(sourceRoot)) {
    throw new Error(`Android launcher icon source directory not found: ${sourceRoot}`);
  }

  const densityDirs = fs
    .readdirSync(sourceRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("mipmap-"))
    .map((entry) => entry.name);

  if (densityDirs.length === 0) {
    throw new Error(`No mipmap-* Android launcher icon directories found in: ${sourceRoot}`);
  }

  for (const densityDir of densityDirs) {
    const sourceIcon = path.join(sourceRoot, densityDir, ICON_FILE);
    if (!fs.existsSync(sourceIcon)) {
      throw new Error(`Android launcher icon not found: ${sourceIcon}`);
    }

    const targetDir = path.join(resRoot, densityDir);
    fs.mkdirSync(targetDir, { recursive: true });
    removeResourceVariants(targetDir, "ic_launcher");
    removeResourceVariants(targetDir, "ic_launcher_foreground");
    removeResourceVariants(targetDir, "ic_launcher_round");
    fs.copyFileSync(sourceIcon, path.join(targetDir, ICON_FILE));
    fs.copyFileSync(sourceIcon, path.join(targetDir, ROUND_ICON_FILE));
  }

  const adaptiveIconDir = path.join(resRoot, "mipmap-anydpi-v26");
  fs.rmSync(path.join(adaptiveIconDir, "ic_launcher.xml"), { force: true });
  fs.rmSync(path.join(adaptiveIconDir, "ic_launcher_round.xml"), { force: true });
}

function removeResourceVariants(resourceDir, resourceName) {
  if (!fs.existsSync(resourceDir)) {
    return;
  }

  for (const entry of fs.readdirSync(resourceDir, { withFileTypes: true })) {
    if (entry.isFile() && path.parse(entry.name).name === resourceName) {
      fs.rmSync(path.join(resourceDir, entry.name), { force: true });
    }
  }
}

module.exports = function withXcodexAndroidIcons(config) {
  return withDangerousMod(config, [
    "android",
    async (modConfig) => {
      copyLauncherIcons(modConfig.modRequest.projectRoot, modConfig.modRequest.platformProjectRoot);
      return modConfig;
    },
  ]);
};
