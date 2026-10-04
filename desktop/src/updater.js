// Self-updater driven by GitHub Releases.
//
// Electron's built-in autoUpdater (Squirrel.Mac) requires a Developer ID
// signature, so this app updates itself instead: download the release's
// -<arch>.zip, verify its SHA-256 digest and code signature, then a detached
// shell script swaps the bundle once this process exits and relaunches it.
// Files fetched by the app are not quarantined, so updates never hit Gatekeeper.
const { app, BrowserWindow, dialog, net, shell } = require("electron");
const { execFile, spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");

const execFileP = promisify(execFile);

const REPO = "truffshuff/aliena";
const LATEST_URL =
  process.env.ALIENA_UPDATE_URL || `https://api.github.com/repos/${REPO}/releases/latest`;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const FIRST_CHECK_DELAY_MS = 3000;

// Waits for the app to exit, swaps bundles (rolling back on failure), relaunches.
// Args: pid, installed app path, new app path, work dir, failure-report file.
const SWAP_SCRIPT = `
pid="$1"; old="$2"; new="$3"; work="$4"; report="$5"
while kill -0 "$pid" 2>/dev/null; do sleep 0.2; done
backup="$work/previous.app"
if mv "$old" "$backup" 2>"$work/mv.log"; then
  if mv "$new" "$old" 2>>"$work/mv.log"; then
    xattr -dr com.apple.quarantine "$old" 2>/dev/null
    rm -rf "$work"
  else
    mv "$backup" "$old"
    cp "$work/mv.log" "$report"
  fi
else
  cp "$work/mv.log" "$report"
fi
open "$old"
`;

let latest = null; // { version, notesUrl, asset }
let busy = false;

function failureReportPath() {
  return path.join(app.getPath("userData"), "update-failed.log");
}

function versionParts(v) {
  return String(v)
    .replace(/^v/, "")
    .split("-")[0]
    .split(".")
    .map((n) => parseInt(n, 10) || 0);
}

function isNewer(candidate, current) {
  const a = versionParts(candidate);
  const b = versionParts(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  }
  return false;
}

function send(status) {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send("update-status", status);
}

// .../Aliena OFX Converter.app/Contents/MacOS/Aliena OFX Converter -> the .app
function appBundlePath() {
  return path.resolve(process.execPath, "..", "..", "..");
}

function installBlocker() {
  if (!app.isPackaged) return "Updates can only be installed from the packaged app.";
  const bundle = appBundlePath();
  if (bundle.includes("/AppTranslocation/") || bundle.startsWith("/Volumes/")) {
    return "Move Aliena OFX Converter to your Applications folder and reopen it to install updates.";
  }
  try {
    fs.accessSync(path.dirname(bundle), fs.constants.W_OK);
  } catch {
    return `This app can't be replaced in ${path.dirname(bundle)} (no write permission).`;
  }
  return null;
}

function statusFor(state, extra = {}) {
  return {
    state,
    version: latest?.version,
    currentVersion: app.getVersion(),
    notesUrl: latest?.notesUrl,
    hasAsset: Boolean(latest?.asset),
    blocker: installBlocker(),
    ...extra,
  };
}

async function checkForUpdates({ manual = false } = {}) {
  if (busy) return;
  try {
    const res = await net.fetch(LATEST_URL, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "aliena-ofx-converter" },
    });
    if (!res.ok && res.status !== 404) throw new Error(`GitHub returned HTTP ${res.status}`);
    const rel = res.status === 404 ? {} : await res.json();
    const version = String(rel.tag_name || "").replace(/^v/, "");

    if (version && isNewer(version, app.getVersion())) {
      latest = {
        version,
        notesUrl: rel.html_url,
        asset: (rel.assets || []).find((a) => a.name.endsWith(`-${process.arch}.zip`)) || null,
      };
      send(statusFor("available"));
      return;
    }

    latest = null;
    if (manual) {
      await dialog.showMessageBox({
        type: "info",
        message: "You're up to date",
        detail: `Aliena OFX Converter ${app.getVersion()} is the latest version.`,
      });
    }
  } catch (err) {
    if (manual) {
      await dialog.showMessageBox({
        type: "warning",
        message: "Couldn't check for updates",
        detail: err.message,
      });
    }
  }
}

async function download(url, dest, expectedSize, onProgress) {
  const res = await net.fetch(url, { headers: { "User-Agent": "aliena-ofx-converter" } });
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
  const total = Number(res.headers.get("content-length")) || expectedSize || 0;
  const hash = crypto.createHash("sha256");
  const out = await fs.promises.open(dest, "w");
  let received = 0;
  let lastPct = -1;
  try {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      hash.update(value);
      await out.write(value);
      received += value.length;
      const pct = total ? Math.floor((received / total) * 100) : 0;
      if (pct !== lastPct) {
        lastPct = pct;
        onProgress(pct);
      }
    }
  } finally {
    await out.close();
  }
  return hash.digest("hex");
}

async function installUpdate() {
  if (busy || !latest?.asset) return;
  const blocker = installBlocker();
  if (blocker) {
    send(statusFor("error", { message: blocker }));
    return;
  }

  busy = true;
  const { asset } = latest;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "aliena-update-"));
  try {
    const zipPath = path.join(work, asset.name);
    const sha256 = await download(asset.browser_download_url, zipPath, asset.size, (progress) =>
      send(statusFor("downloading", { progress }))
    );
    send(statusFor("installing"));

    if (asset.digest?.startsWith("sha256:") && asset.digest.slice(7) !== sha256) {
      throw new Error("Downloaded update failed its checksum. Please try again.");
    }

    const extractDir = path.join(work, "extract");
    await execFileP("ditto", ["-x", "-k", zipPath, extractDir]);
    const appName = fs.readdirSync(extractDir).find((n) => n.endsWith(".app"));
    if (!appName) throw new Error("The update archive doesn't contain an app.");
    const newApp = path.join(extractDir, appName);
    await execFileP("codesign", ["--verify", "--deep", "--strict", newApp]);

    fs.rmSync(failureReportPath(), { force: true });
    spawn(
      "/bin/bash",
      ["-c", SWAP_SCRIPT, "aliena-update", String(process.pid), appBundlePath(), newApp, work, failureReportPath()],
      { detached: true, stdio: "ignore" }
    ).unref();
    app.quit();
  } catch (err) {
    busy = false;
    fs.rmSync(work, { recursive: true, force: true });
    send(statusFor("error", { message: err.message }));
  }
}

function openReleasePage() {
  const url = latest?.notesUrl || `https://github.com/${REPO}/releases/latest`;
  if (url.startsWith("https://github.com/")) shell.openExternal(url);
}

// The swap script can't show UI, so it leaves a report if the bundle swap failed.
function reportPreviousFailure() {
  const report = failureReportPath();
  if (!fs.existsSync(report)) return;
  const detail = fs.readFileSync(report, "utf8").trim();
  fs.rmSync(report, { force: true });
  dialog.showMessageBox({
    type: "warning",
    message: "The last update couldn't be installed",
    detail:
      "macOS didn't allow the app to replace itself. If System Settings → Privacy & Security → " +
      "App Management lists Aliena OFX Converter, turn it on and try again, or download the update " +
      "from GitHub and drag it into Applications.\n\n" +
      detail,
  });
}

// Lets a freshly loaded window pick up an update found before it existed.
function currentStatus() {
  if (!latest) return null;
  return statusFor(busy ? "installing" : "available");
}

function startUpdater() {
  reportPreviousFailure();
  if (!app.isPackaged && !process.env.ALIENA_UPDATE_URL) return;
  setTimeout(() => checkForUpdates(), FIRST_CHECK_DELAY_MS);
  setInterval(() => checkForUpdates(), CHECK_INTERVAL_MS);
}

module.exports = { startUpdater, checkForUpdates, installUpdate, openReleasePage, currentStatus };
