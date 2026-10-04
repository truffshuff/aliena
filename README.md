# Aliena PDF to OFX Converter

Converts Aliena/DriveWealth confirmation PDFs into Quicken investment Web Connect files (one per account). Output is QFX by default, OFX, or both.

Use it as a **Mac desktop app** (drag in PDFs, click Convert) or as a **command-line script**.

## Desktop app (macOS)

### Install

1. Download `Aliena-OFX-Converter-<version>-arm64.dmg` from this repo's **Releases** page. Apple Silicon Macs only (M1 and later).
2. Open the DMG and drag **Aliena OFX Converter** into **Applications**.

### First launch: getting past Gatekeeper

The app is not signed with an Apple Developer ID, so macOS blocks it the first time you open it. Use **either** of these once. In-app updates don't trigger it again:

**Option A: Privacy & Security**

1. Open the app. macOS says it can't verify the developer. Click **Done** (not Move to Trash).
2. Open **System Settings → Privacy & Security**.
3. Scroll down to the message about "Aliena OFX Converter" and click **Open Anyway**.
4. Confirm with your password or Touch ID, then click **Open Anyway** again.

**Option B: Terminal**

```bash
xattr -cr "/Applications/Aliena OFX Converter.app"
```

This removes the "downloaded from the internet" quarantine flag, after which the app opens normally. If macOS ever says the app "is damaged and can't be opened", this command is the fix.

### Using the app

1. Drop confirmation PDFs (or a folder of them) onto the window, or click to choose files. Click a file name to open it in Preview.
2. Pick the format: **QFX** (default), **OFX**, or **Both**.
3. Choose where to save (defaults to `~/Documents/Aliena OFX`).
4. Click **Convert**.

Each account you convert appears in the **Done** list, newest first. Each item shows:
- its trade count;
- the files written, each with **Show in Finder**;
- the source confirmation PDFs it came from. Click one to open it in Preview.

Remove an item with its **×**, or clear the list with **Clear**. This only tidies the list; it never deletes files. The format and output folder are remembered between launches.

The PDFs never leave your Mac. The only network request is the update check.

### Updates

The app checks this repo's latest GitHub release at launch and every 6 hours. You can also check any time with **Aliena OFX Converter → Check for Updates…**. When a newer version is out, a banner offers **Install & Restart**, which:

1. Downloads the release's `-arm64.zip`.
2. Verifies its SHA-256 checksum against GitHub's and checks its code signature.
3. Replaces the app and relaunches it.

The app has to be in a folder you can write to (normally `/Applications`). If you run it straight from the DMG or Downloads, the banner asks you to move it first.

If an update can't be installed, you'll see a message on the next launch. Usually macOS blocked the app from replacing itself. Turn on **Aliena OFX Converter** under **System Settings → Privacy & Security → App Management**, or download the DMG and drag the app into Applications.

> Electron's standard updater (Squirrel.Mac) only works with Developer ID–signed apps, so this app uses its own updater ([desktop/src/updater.js](desktop/src/updater.js)).

## Command line

### Setup

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

### Run

```bash
python aliena_pdf_to_ofx.py --input-dir . --glob "Confirm_*.pdf" --output-dir ofx_output
```

Or pass specific PDF files instead of a folder/glob:

```bash
python aliena_pdf_to_ofx.py --output-dir ofx_output Confirm_A.pdf Confirm_B.pdf
```

Choose the output type with `--format` (`qfx` is the default):

```bash
python aliena_pdf_to_ofx.py --output-dir ofx_output --format both
```

| `--format` | Writes per account |
|---|---|
| `qfx` (default) | `.qfx` |
| `ofx` | `.ofx` |
| `both` | `.qfx` and `.ofx` |

Output filenames include a run timestamp (`YYYYMMDD_HHMMSS`), so each run produces new files:

```text
Wrote ofx_output/ALIN-001-XXXX000001_20260804_210255.qfx (15 trades)
Wrote ofx_output/ALIN-001-XXXX000002_20260804_210255.qfx (68 trades)
Parsed 83 trades across 2 account(s).
```

`--json` prints a machine-readable summary instead (the desktop app uses this).

### Output details

Files use Quicken's investment Web Connect profile:
- OFX 1.0.2 SGML.
- `INTU.BID=9999`, `FI/ORG=Intuit`, `FI/FID=9999`, `BROKERID=drivewealth.com`.
- A numeric account ID.

The `.qfx` and `.ofx` files have identical content; only the extension differs.

- The script reads only page 1 of each confirmation, where trade rows live.
- Transaction IDs (`FITID`) are deterministic and based on account, file, symbol, date, and quantity.

## Development

### Project layout

```text
aliena_pdf_to_ofx.py        Converter (CLI and the engine behind the app)
scripts/build-python.sh     Bundles the converter into a standalone binary (PyInstaller)
desktop/                    Electron app
  src/main.js               Window, menu, file dialogs, runs the converter
  src/updater.js            Self-updater driven by GitHub Releases
  src/preload.js            Safe bridge between UI and main process
  src/renderer/             UI (HTML/CSS/JS)
  build-hooks/adhoc-sign.js Ad-hoc code signing (no Developer ID needed)
  build/icon.svg            App icon source (`npm run icon` re-renders the PNGs)
.github/workflows/release.yml  Builds DMGs and publishes GitHub releases
```

### Run the app from source

Requires Node.js 22+ and the `.venv` from the CLI setup above. In development, the app runs `aliena_pdf_to_ofx.py` with `.venv/bin/python`.

```bash
cd desktop
npm install
npm start
```

The first `npm start` downloads the Electron runtime.

> **Running from VS Code's terminal?** If Electron starts as plain Node (`Cannot find module 'electron'`), the terminal has `ELECTRON_RUN_AS_NODE=1` set. Run `unset ELECTRON_RUN_AS_NODE` first.

### Build a DMG locally

```bash
cd desktop
npm run dist   # bundles the Python converter, then builds dist/*.dmg
```

This builds the DMG and the update ZIP for Apple Silicon.

> **Repo inside iCloud Drive (e.g. `~/Documents` with Desktop & Documents sync)?** iCloud adds Finder metadata that breaks code signing (`resource fork, Finder information, or similar detritus not allowed`). Build to a folder outside iCloud instead:
> `npm run dist -- --config.directories.output=/tmp/aliena-dist`

### Publish a release

Releases are built by GitHub Actions on an Apple Silicon runner.

```bash
git tag v1.0.1
git push origin v1.0.1
```

The workflow sets the app version from the tag, builds the DMG and the update ZIP, and attaches both to a new GitHub release with the first-launch instructions above. Installed apps then pick up the release through the in-app updater. Always increase the version number; the updater only installs releases newer than the running app.

To test the updater against a local fake release, set `ALIENA_UPDATE_URL` to a JSON file shaped like GitHub's `releases/latest` response. With it set, update checks also run from `npm start`, though installing only works in the packaged app. You can also run it manually from the Actions tab (**Release macOS app → Run workflow**) to get the DMGs as downloadable artifacts without creating a release.

## Privacy

Trade confirmations and converter output contain account numbers and trades. `.gitignore` excludes all `*.pdf`, `*.ofx` and `*.qfx` files, the `Old/` and `2SEP/` archive folders, and the output folders, so they're never committed. Check `git status` before committing if you add new folders of statements.
