const { withAppBuildGradle } = require("expo/config-plugins");

const EXPO_CLI_LINE =
  '    cliFile = new File(["node", "--print", "require.resolve(\'@expo/cli\', { paths: [require.resolve(\'expo/package.json\')] })"].execute(null, rootDir).text.trim())';
const XCODEX_CLI_LINE = [
  "    // Keep native release bundling rooted at the Expo app package in this monorepo.",
  '    cliFile = file("${projectRoot}/scripts/expo-export-embed-cli.js")',
].join("\n");

module.exports = function withXcodexAndroidBuild(config) {
  return withAppBuildGradle(config, (modConfig) => {
    const contents = modConfig.modResults.contents;
    if (contents.includes("expo-export-embed-cli.js")) {
      return modConfig;
    }

    if (!contents.includes(EXPO_CLI_LINE)) {
      throw new Error("Unable to locate Expo CLI line in android/app/build.gradle");
    }

    modConfig.modResults.contents = contents.replace(EXPO_CLI_LINE, XCODEX_CLI_LINE);
    return modConfig;
  });
};
