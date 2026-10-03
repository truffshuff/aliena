# Aliena PDF to OFX Converter

Converts Aliena/DriveWealth confirmation PDFs into OFX investment statement files (one file per account) for import into Quicken.

Use it as a **Mac desktop app** (drag in PDFs, click Convert) or as a **command-line script**.

## Desktop app (macOS)

### Install

1. Download the latest `.dmg` from this repo's **Releases** page:
   - Apple Silicon (M1 and later): `Aliena-OFX-Converter-<version>-arm64.dmg`
   - Intel Macs: `Aliena-OFX-Converter-<version>-x64.dmg`
2. Open the DMG and drag **Aliena OFX Converter** into **Applications**.

### First launch: getting past Gatekeeper

The app is not signed with an Apple Developer ID, so macOS blocks it the first time you open it. Use **either** of these once per downloaded version:

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

1. Drop confirmation PDFs (or a folder of them) onto the window, or click to choose files.
2. Pick an output format. **Quicken Investment** is the recommended default.
3. Choose where to save (defaults to `~/Documents/Aliena OFX`).
4. Click **Convert**. Each output file is listed with its trade count and a **Show in Finder** button.

**Advanced options** exposes the same overrides as the CLI flags below (Broker ID, INTU.BID, FI/ORG, FI/FID, numeric account ID). Your choices are remembered between launches.

The app runs entirely offline. The PDFs never leave your Mac.

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

Force legacy OFX 1.0.2 SGML output:

```bash
python aliena_pdf_to_ofx.py --input-dir . --glob "Confirm_*.pdf" --output-dir ofx_output --ofx-version 1.0.2
```

Quicken-focused compatibility mode (recommended if Web Connect import fails):

```bash
python aliena_pdf_to_ofx.py --input-dir . --glob "Confirm_*.pdf" --output-dir ofx-output --quicken-mode
```

This mode does three things:
- Forces OFX 1.0.2 SGML output.
- Leaves `INTU.BID` out unless you explicitly pass `--intu-bid`.
- Writes both `.ofx` and `.qfx` files per account.

Quicken investment-profile mode (recommended for repeated investment updates):

```bash
python aliena_pdf_to_ofx.py --input-dir . --glob "Confirm_*.pdf" --output-dir ofx-output --quicken-investment-mode
```

This preset forces OFX 1.0.2, writes both `.ofx` and `.qfx`, and applies `INTU.BID=9999`, `FI/ORG=Intuit`, `FI/FID=9999`.

All output filenames include a run timestamp suffix (`YYYYMMDD_HHMMSS`) so each run produces uniquely named files.

Expected output example:

```text
Wrote ofx_output/ALIN-001-XXXX000001_20260804_210255.ofx (15 trades)
Wrote ofx_output/ALIN-001-XXXX000002_20260804_210255.ofx (68 trades)
Parsed 83 trades across 2 account(s).
```

### Notes

- The script reads only page 1 of each confirmation, where trade rows live.
- OFX transaction IDs (`FITID`) are deterministic and based on account, file, symbol, date, and quantity.
- `BROKERID` defaults to `drivewealth.com`; override with `--broker-id` if your Quicken setup prefers a different value.
- `--ofx-version` supports `2.3` (default XML) and `1.0.2` (legacy SGML).
- Override Intuit BID header with `--intu-bid` if needed.

## Development

### Project layout

```text
aliena_pdf_to_ofx.py        Converter (CLI and the engine behind the app)
scripts/build-python.sh     Bundles the converter into a standalone binary (PyInstaller)
desktop/                    Electron app
  src/main.js               Window, file dialogs, runs the converter
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

The DMG is built for your Mac's architecture.

> **Repo inside iCloud Drive (e.g. `~/Documents` with Desktop & Documents sync)?** iCloud adds Finder metadata that breaks code signing (`resource fork, Finder information, or similar detritus not allowed`). Build to a folder outside iCloud instead:
> `npm run dist -- --config.directories.output=/tmp/aliena-dist`

### Publish a release

Releases are built by GitHub Actions on Apple Silicon and Intel runners.

```bash
git tag v1.0.1
git push origin v1.0.1
```

The workflow sets the app version from the tag, builds both DMGs, and attaches them to a new GitHub release with the first-launch instructions above. You can also run it manually from the Actions tab (**Release macOS app → Run workflow**) to get the DMGs as downloadable artifacts without creating a release.

## Privacy

Trade confirmations and converter output contain account numbers and trades. `.gitignore` excludes all `*.pdf`, `*.ofx` and `*.qfx` files, the `Old/` and `2SEP/` archive folders, and the output folders, so they're never committed. Check `git status` before committing if you add new folders of statements.
