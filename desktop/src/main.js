const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const updater = require("./updater");

const REPO_ROOT = path.resolve(__dirname, "..", "..");

// Packaged app: bundled PyInstaller binary. Dev: run the script with the repo's venv.
function converterCommand() {
  if (app.isPackaged) {
    return { cmd: path.join(process.resourcesPath, "bin", "aliena_pdf_to_ofx"), pre: [] };
  }
  const venvPython = path.join(REPO_ROOT, ".venv", "bin", "python");
  const python = fs.existsSync(venvPython) ? venvPython : "python3";
  return { cmd: python, pre: [path.join(REPO_ROOT, "aliena_pdf_to_ofx.py")] };
}

function buildMenu() {
  const template = [
    {
      label: app.name,
      submenu: [
        { role: "about" },
        { label: "Check for Updates…", click: () => updater.checkForUpdates({ manual: true }) },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    { role: "fileMenu" },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  const win = new BrowserWindow({
    width: 880,
    height: 760,
    minWidth: 720,
    minHeight: 620,
    titleBarStyle: "hiddenInset",
    vibrancy: "under-window",
    visualEffectState: "active",
    backgroundColor: "#00000000",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.once("ready-to-show", () => win.show());
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
}

// Expand dropped/selected paths: folders contribute their top-level PDFs.
function expandToPdfs(paths) {
  const out = new Set();
  for (const p of paths) {
    let stat;
    try {
      stat = fs.statSync(p);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(p)) {
        if (name.toLowerCase().endsWith(".pdf")) out.add(path.join(p, name));
      }
    } else if (p.toLowerCase().endsWith(".pdf")) {
      out.add(p);
    }
  }
  return [...out].sort();
}

ipcMain.handle("pick-pdfs", async (event) => {
  const res = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
    title: "Choose confirmation PDFs",
    properties: ["openFile", "openDirectory", "multiSelections"],
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  });
  return res.canceled ? [] : expandToPdfs(res.filePaths);
});

ipcMain.handle("expand-paths", (_event, paths) => expandToPdfs(paths));

ipcMain.handle("pick-output-dir", async (event, current) => {
  const res = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
    title: "Choose output folder",
    defaultPath: current || undefined,
    properties: ["openDirectory", "createDirectory"],
  });
  return res.canceled ? null : res.filePaths[0];
});

ipcMain.handle("default-output-dir", () =>
  path.join(app.getPath("documents"), "Aliena OFX")
);

ipcMain.handle("reveal", (_event, target) => shell.showItemInFolder(target));
ipcMain.handle("open-path", (_event, target) => shell.openPath(target));

ipcMain.handle("update-status", () => updater.currentStatus());
ipcMain.handle("update-install", () => updater.installUpdate());
ipcMain.handle("update-open-release", () => updater.openReleasePage());

ipcMain.handle("convert", (_event, { pdfs, outputDir, options }) => {
  const args = ["--output-dir", outputDir];
  if (options.mode === "quicken-investment") args.push("--quicken-investment-mode");
  else if (options.mode === "quicken") args.push("--quicken-mode");
  else args.push("--ofx-version", options.mode === "ofx-1.0.2" ? "1.0.2" : "2.3");
  if (options.brokerId) args.push("--broker-id", options.brokerId);
  if (options.intuBid) args.push("--intu-bid", options.intuBid);
  if (options.fiOrg) args.push("--fi-org", options.fiOrg);
  if (options.fiFid) args.push("--fi-fid", options.fiFid);
  if (options.numericAcctId) args.push("--numeric-acctid");
  args.push("--", ...pdfs);

  const { cmd, pre } = converterCommand();
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(cmd, [...pre, ...args]);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => resolve({ ok: false, error: err.message, stdout, stderr }));
    child.on("close", (code) => {
      const files = [...stdout.matchAll(/^Wrote (.+) \((\d+) trades\)$/gm)].map((m) => ({
        path: m[1],
        trades: Number(m[2]),
      }));
      const summary = (stdout.match(/^Parsed .+$/m) || [""])[0];
      resolve({
        ok: code === 0,
        error: code === 0 ? null : stderr.trim().split("\n").pop() || `Exited with code ${code}`,
        files,
        summary,
        stdout,
        stderr,
      });
    });
  });
});

app.whenReady().then(() => {
  if (!app.isPackaged && process.platform === "darwin") {
    app.dock.setIcon(path.join(__dirname, "..", "build", "icon.png"));
  }
  buildMenu();
  createWindow();
  updater.startUpdater();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
