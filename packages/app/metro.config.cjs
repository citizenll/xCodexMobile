const { getDefaultConfig } = require("expo/metro-config");
const { resolve } = require("metro-resolver");
const fs = require("fs");
const path = require("path");

const projectRoot = __dirname;
const appNodeModulesRoot = path.resolve(projectRoot, "node_modules");
const appSrcRoot = path.resolve(projectRoot, "src");
const workspaceRoot = path.resolve(projectRoot, "../..");
const workspacePackagesRoot = path.resolve(workspaceRoot, "packages");
const getpaseoNodeModulesRoot = path.resolve(workspaceRoot, "node_modules/@getpaseo");
const customWebPlatform = (process.env.PASEO_WEB_PLATFORM ?? "")
  .trim()
  .replace(/^\./, "")
  .toLowerCase();
const debugResolver = process.env.PASEO_METRO_RESOLVER_DEBUG === "1";

const config = getDefaultConfig(projectRoot);
const defaultResolveRequest = config.resolver.resolveRequest ?? resolve;
const workspacePackages = loadWorkspacePackages();
const escapedAppSrcRoot = appSrcRoot
  .split(path.sep)
  .map((segment) => segment.replace(/[|\\{}()[\]^$+*?.]/g, "\\$&"))
  .join("[\\\\/]");
const pathSeparatorPattern = "[\\\\/]";

config.resolver.extraNodeModules = {
  ...config.resolver.extraNodeModules,
  react: path.join(appNodeModulesRoot, "react"),
  "react-dom": path.join(appNodeModulesRoot, "react-dom"),
  "react/jsx-runtime": path.join(appNodeModulesRoot, "react/jsx-runtime"),
  "react/jsx-dev-runtime": path.join(appNodeModulesRoot, "react/jsx-dev-runtime"),
};
config.resolver.blockList = new RegExp(
  `(^${escapedAppSrcRoot}${pathSeparatorPattern}.*\\.(test|spec)\\.(ts|tsx)$|${pathSeparatorPattern}__tests__${pathSeparatorPattern}.*)$`,
);
config.watchFolders = Array.from(new Set([...(config.watchFolders ?? []), workspaceRoot]));

function isLocalModuleImport(moduleName) {
  return (
    moduleName.startsWith("./") ||
    moduleName.startsWith("../") ||
    moduleName.startsWith("@/") ||
    path.isAbsolute(moduleName)
  );
}

function isInsideDirectory(parent, filePath) {
  const relative = path.relative(parent, filePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return false;
  }
  return true;
}

function isWorkspacePackageSourcePath(filePath) {
  if (!isInsideDirectory(workspacePackagesRoot, filePath)) {
    return false;
  }
  return path.relative(workspacePackagesRoot, filePath).split(path.sep).includes("src");
}

function isGetpaseoNodeModuleSourcePath(filePath) {
  if (!isInsideDirectory(getpaseoNodeModulesRoot, filePath)) {
    return false;
  }
  return path.relative(getpaseoNodeModulesRoot, filePath).split(path.sep).includes("src");
}

function isGetpaseoSourcePath(filePath) {
  return isWorkspacePackageSourcePath(filePath) || isGetpaseoNodeModuleSourcePath(filePath);
}

function loadWorkspacePackages() {
  const packages = new Map();
  for (const entry of fs.readdirSync(workspacePackagesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const packageRoot = path.join(workspacePackagesRoot, entry.name);
    const packageJsonPath = path.join(packageRoot, "package.json");
    if (!fs.existsSync(packageJsonPath)) {
      continue;
    }
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
    if (typeof packageJson.name === "string") {
      packages.set(packageJson.name, { packageJson, packageRoot });
    }
  }
  return packages;
}

function parsePackageSpecifier(moduleName) {
  const [first, second, ...rest] = moduleName.split("/");
  if (!first) {
    return null;
  }
  if (first.startsWith("@")) {
    if (!second) {
      return null;
    }
    return {
      packageName: `${first}/${second}`,
      subpath: rest.length > 0 ? `./${rest.join("/")}` : ".",
    };
  }
  return {
    packageName: first,
    subpath: second ? `./${[second, ...rest].join("/")}` : ".",
  };
}

function getConditionalExportTarget(exportValue) {
  if (typeof exportValue === "string") {
    return exportValue;
  }
  if (!exportValue || typeof exportValue !== "object" || Array.isArray(exportValue)) {
    return null;
  }

  for (const condition of ["react-native", "source", "import", "default", "node", "require"]) {
    const target = getConditionalExportTarget(exportValue[condition]);
    if (target) {
      return target;
    }
  }

  return null;
}

function getWorkspacePackageEntry(packageJson, subpath) {
  const exportsField = packageJson.exports;
  if (exportsField) {
    const exportValue = typeof exportsField === "string" ? exportsField : exportsField[subpath];
    const exportTarget = getConditionalExportTarget(exportValue);
    if (exportTarget) {
      return exportTarget;
    }
  }

  if (subpath === "." && typeof packageJson.main === "string") {
    return packageJson.main;
  }

  if (subpath === ".") {
    return "index";
  }

  return subpath;
}

function resolveWorkspacePackageModule(moduleName) {
  const parsed = parsePackageSpecifier(moduleName);
  if (!parsed) {
    return null;
  }

  const workspacePackage = workspacePackages.get(parsed.packageName);
  if (!workspacePackage) {
    return null;
  }

  const entry = getWorkspacePackageEntry(workspacePackage.packageJson, parsed.subpath);
  if (!entry || path.isAbsolute(entry) || /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(entry)) {
    return null;
  }

  return path.resolve(workspacePackage.packageRoot, entry);
}

function getPlatformFileCandidates(filePath, platform, sourceExts) {
  const extension = path.extname(filePath);
  const basePath = extension ? filePath.slice(0, -extension.length) : filePath;
  const extensionWithoutDot = extension.replace(/^\./, "");
  const extensions = extensionWithoutDot ? [extensionWithoutDot] : sourceExts;
  const platforms = [platform, "native", ""].filter(Boolean);
  const candidates = [];

  for (const ext of extensions) {
    for (const candidatePlatform of platforms) {
      candidates.push(
        candidatePlatform ? `${basePath}.${candidatePlatform}.${ext}` : `${basePath}.${ext}`,
      );
    }
  }

  candidates.push(path.join(filePath, "index"));
  return candidates;
}

function resolveSourceFilePath(filePath, platform, sourceExts) {
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    return filePath;
  }

  for (const candidate of getPlatformFileCandidates(filePath, platform, sourceExts)) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }

  return null;
}

function resolveWorkspacePackageSourceFile(context, moduleName, platform) {
  const candidate = resolveWorkspacePackageModule(moduleName);
  if (!candidate) {
    return null;
  }

  const resolvedFilePath = resolveSourceFilePath(candidate, platform, context.sourceExts);
  if (resolvedFilePath) {
    if (debugResolver) {
      console.warn(`[metro] workspace package ${moduleName} -> ${resolvedFilePath}`);
    }
    return { type: "sourceFile", filePath: resolvedFilePath };
  }

  if (debugResolver) {
    console.warn(`[metro] workspace package ${moduleName} unresolved from ${candidate}`);
  }
  return null;
}

function resolveTsSiblingForJsSpecifier(origin, moduleName) {
  if (!origin || !moduleName.endsWith(".js") || !isGetpaseoSourcePath(origin)) {
    return null;
  }
  const tsModuleName = moduleName.replace(/\.js$/, ".ts");
  const candidatePath = path.resolve(path.dirname(origin), tsModuleName);
  return fs.existsSync(candidatePath) ? tsModuleName : null;
}

function resolveWithCustomWebOverlay(context, moduleName, platform) {
  const shouldResolveCustomWebVariant =
    platform === "web" &&
    customWebPlatform.length > 0 &&
    customWebPlatform !== "web" &&
    isLocalModuleImport(moduleName);

  if (shouldResolveCustomWebVariant) {
    const overlayContext = {
      ...context,
      // Resolve only "<custom-platform>.<ext>" variants in overlay mode.
      sourceExts: context.sourceExts.map((ext) => `${customWebPlatform}.${ext}`),
      preferNativePlatform: false,
    };

    try {
      return defaultResolveRequest(overlayContext, moduleName, null);
    } catch {
      // Ignore overlay misses and continue with normal web resolution.
    }
  }

  return defaultResolveRequest(context, moduleName, platform);
}

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (
    debugResolver &&
    (moduleName.includes("two-way") || context.originModulePath?.includes("audio-engine"))
  ) {
    console.warn(`[metro] resolving ${moduleName} from ${context.originModulePath ?? "<unknown>"}`);
  }

  const workspacePackageResolution = resolveWorkspacePackageSourceFile(
    context,
    moduleName,
    platform,
  );
  if (workspacePackageResolution) {
    return workspacePackageResolution;
  }

  const origin = context.originModulePath;
  const tsModuleName = resolveTsSiblingForJsSpecifier(origin, moduleName);
  if (tsModuleName) {
    return resolveWithCustomWebOverlay(context, tsModuleName, platform);
  }

  return resolveWithCustomWebOverlay(context, moduleName, platform);
};

module.exports = config;
