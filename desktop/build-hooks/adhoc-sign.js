// Ad-hoc sign the packed .app (no Apple Developer ID needed).
// Without any bundle signature, Apple Silicon reports the downloaded app as
// "damaged"; with an ad-hoc signature macOS offers "Open Anyway" instead.
const { execFileSync } = require("node:child_process");
const path = require("node:path");

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== "darwin") return;
  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`
  );
  // codesign rejects bundles carrying Finder info / resource-fork xattrs.
  execFileSync("xattr", ["-cr", appPath]);
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", appPath], { stdio: "inherit" });
  execFileSync("codesign", ["--verify", "--deep", "--strict", appPath], { stdio: "inherit" });
};
