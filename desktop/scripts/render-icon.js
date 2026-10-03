// Render build/icon.svg to build/icon.png (1024x1024, used by electron-builder)
// and src/renderer/icon.png (in-app header). Run with: npm run icon
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const svg = fs.readFileSync(path.join(root, "build", "icon.svg"), "utf8");
const html = `<!doctype html><html><body style="margin:0;background:transparent">${svg}</body></html>`;

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1024,
    height: 1024,
    show: false,
    transparent: true,
    frame: false,
    webPreferences: { offscreen: true },
  });
  win.webContents.setFrameRate(1);
  await win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
  await new Promise((r) => setTimeout(r, 500));
  const img = (await win.webContents.capturePage()).resize({ width: 1024, height: 1024, quality: "best" });
  fs.writeFileSync(path.join(root, "build", "icon.png"), img.toPNG());
  fs.writeFileSync(
    path.join(root, "src", "renderer", "icon.png"),
    img.resize({ width: 128, height: 128, quality: "best" }).toPNG()
  );
  console.log("Wrote build/icon.png and src/renderer/icon.png");
  app.quit();
});
