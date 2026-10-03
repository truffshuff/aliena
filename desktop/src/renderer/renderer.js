const api = window.aliena;
const $ = (id) => document.getElementById(id);

const MODE_HELP = {
  "quicken-investment":
    "Recommended. OFX 1.0.2 plus a .qfx copy, with Intuit BID/FI presets for repeated investment updates.",
  quicken: "OFX 1.0.2 plus a .qfx copy. Try this if Web Connect import fails in Investment mode.",
  "ofx-2.3": "Standard OFX 2.3 XML (.ofx only).",
  "ofx-1.0.2": "Legacy OFX 1.0.2 SGML (.ofx only).",
};

const SETTINGS_KEY = "aliena-settings";
const state = {
  pdfs: [],
  outputDir: "",
  mode: "quicken-investment",
};

// ---------- Settings persistence (best-effort) ----------
function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {};
  } catch {
    return {};
  }
}

function saveSettings() {
  try {
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({
        outputDir: state.outputDir,
        mode: state.mode,
        brokerId: $("broker-id").value,
        intuBid: $("intu-bid").value,
        fiOrg: $("fi-org").value,
        fiFid: $("fi-fid").value,
        numericAcctId: $("numeric-acctid").checked,
      })
    );
  } catch {
    /* ignore */
  }
}

// ---------- Rendering ----------
function basename(p) {
  return p.split("/").pop();
}

function dirname(p) {
  const parts = p.split("/");
  parts.pop();
  return parts.join("/");
}

function prettyDir(p) {
  return p.replace(/^\/Users\/[^/]+/, "~");
}

function renderFiles() {
  const list = $("file-list");
  list.replaceChildren(
    ...state.pdfs.map((p) => {
      const li = document.createElement("li");
      const badge = document.createElement("span");
      badge.className = "file-badge";
      badge.textContent = "PDF";
      const name = document.createElement("span");
      name.className = "file-name";
      name.title = p;
      name.textContent = basename(p);
      const dir = document.createElement("span");
      dir.className = "file-dir";
      dir.textContent = prettyDir(dirname(p));
      name.append(dir);
      const rm = document.createElement("button");
      rm.className = "remove";
      rm.title = "Remove";
      rm.textContent = "×";
      rm.addEventListener("click", () => {
        state.pdfs = state.pdfs.filter((x) => x !== p);
        renderFiles();
      });
      li.append(badge, name, rm);
      return li;
    })
  );
  const n = state.pdfs.length;
  $("file-count").textContent = n ? `${n} file${n === 1 ? "" : "s"}` : "";
  $("clear-files").hidden = n === 0;
  updateConvertButton();
}

function renderMode() {
  for (const btn of $("mode").querySelectorAll("button")) {
    btn.setAttribute("aria-checked", String(btn.dataset.mode === state.mode));
  }
  $("mode-help").textContent = MODE_HELP[state.mode];
}

function renderOutputDir() {
  $("output-dir").textContent = prettyDir(state.outputDir);
  $("output-dir").title = state.outputDir;
}

function updateConvertButton() {
  $("convert").disabled = state.pdfs.length === 0 || !state.outputDir;
  const n = state.pdfs.length;
  $("status").textContent = n ? "" : "Add confirmation PDFs to get started";
}

function addPdfs(paths) {
  state.pdfs = [...new Set([...state.pdfs, ...paths])].sort();
  renderFiles();
}

// ---------- Events ----------
const dropzone = $("dropzone");

dropzone.addEventListener("click", async () => addPdfs(await api.pickPdfs()));
dropzone.addEventListener("keydown", async (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    addPdfs(await api.pickPdfs());
  }
});

// Accept drops anywhere in the window, highlight the drop zone.
let dragDepth = 0;
window.addEventListener("dragenter", (e) => {
  e.preventDefault();
  dragDepth++;
  dropzone.classList.add("over");
});
window.addEventListener("dragleave", () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    dropzone.classList.remove("over");
  }
});
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", async (e) => {
  e.preventDefault();
  dragDepth = 0;
  dropzone.classList.remove("over");
  const paths = [...e.dataTransfer.files].map((f) => api.pathForFile(f)).filter(Boolean);
  if (paths.length) addPdfs(await api.expandPaths(paths));
});

$("clear-files").addEventListener("click", () => {
  state.pdfs = [];
  renderFiles();
});

$("mode").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-mode]");
  if (!btn) return;
  state.mode = btn.dataset.mode;
  renderMode();
  saveSettings();
});

$("pick-output").addEventListener("click", async () => {
  const dir = await api.pickOutputDir(state.outputDir);
  if (dir) {
    state.outputDir = dir;
    renderOutputDir();
    updateConvertButton();
    saveSettings();
  }
});

for (const id of ["broker-id", "intu-bid", "fi-org", "fi-fid", "numeric-acctid"]) {
  $(id).addEventListener("change", saveSettings);
}

$("open-output").addEventListener("click", () => api.openPath(state.outputDir));

$("convert").addEventListener("click", async () => {
  const btn = $("convert");
  btn.disabled = true;
  btn.classList.add("busy");
  btn.querySelector(".label").textContent = "Converting…";
  $("status").textContent = "";

  const result = await api.convert({
    pdfs: state.pdfs,
    outputDir: state.outputDir,
    options: {
      mode: state.mode,
      brokerId: $("broker-id").value.trim(),
      intuBid: $("intu-bid").value.trim(),
      fiOrg: $("fi-org").value.trim(),
      fiFid: $("fi-fid").value.trim(),
      numericAcctId: $("numeric-acctid").checked,
    },
  });

  btn.classList.remove("busy");
  btn.querySelector(".label").textContent = "Convert";
  updateConvertButton();
  showResults(result);
});

function showResults(result) {
  const section = $("results");
  section.hidden = false;
  section.classList.toggle("ok", result.ok);
  section.classList.toggle("err", !result.ok);
  $("results-title").textContent = result.ok ? "Done" : "Conversion failed";
  $("results-summary").textContent = result.ok
    ? result.summary || "Conversion complete."
    : result.error || "Something went wrong.";

  $("results-list").replaceChildren(
    ...(result.files || []).map((f) => {
      const li = document.createElement("li");
      const ext = document.createElement("span");
      ext.className = "ext";
      ext.textContent = f.path.split(".").pop();
      const name = document.createElement("span");
      name.className = "file-name";
      name.title = f.path;
      name.textContent = basename(f.path);
      const trades = document.createElement("span");
      trades.className = "trades";
      trades.textContent = `${f.trades} trades`;
      const reveal = document.createElement("button");
      reveal.className = "secondary";
      reveal.textContent = "Show in Finder";
      reveal.addEventListener("click", () => api.reveal(f.path));
      li.append(ext, name, trades, reveal);
      return li;
    })
  );

  $("log").textContent = [result.stdout, result.stderr].filter(Boolean).join("\n").trim() || "(no output)";
  $("log-wrap").open = !result.ok;
  section.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

// ---------- Init ----------
(async function init() {
  const saved = loadSettings();
  state.outputDir = saved.outputDir || (await api.defaultOutputDir());
  if (MODE_HELP[saved.mode]) state.mode = saved.mode;
  $("broker-id").value = saved.brokerId || "";
  $("intu-bid").value = saved.intuBid || "";
  $("fi-org").value = saved.fiOrg || "";
  $("fi-fid").value = saved.fiFid || "";
  $("numeric-acctid").checked = Boolean(saved.numericAcctId);
  renderMode();
  renderOutputDir();
  renderFiles();
})();
