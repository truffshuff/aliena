const api = window.aliena;
const $ = (id) => document.getElementById(id);

const FORMAT_HELP = {
  qfx: "One .qfx file per account. Double-click it to import into Quicken.",
  ofx: "One .ofx file per account. Same content, for apps other than Quicken.",
  both: "A .qfx and an .ofx file per account.",
};

const SETTINGS_KEY = "aliena-settings";
const state = {
  pdfs: [],
  outputDir: "",
  format: "qfx",
  done: [], // newest first: { id, account, trades, files, sources, at }
};
let nextDoneId = 1;

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
      JSON.stringify({ outputDir: state.outputDir, format: state.format })
    );
  } catch {
    /* ignore */
  }
}

// ---------- Helpers ----------
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

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function removeButton(title, onClick) {
  const btn = el("button", "remove", "×");
  btn.title = title;
  btn.setAttribute("aria-label", title);
  btn.addEventListener("click", onClick);
  return btn;
}

// ---------- Input files ----------
function renderFiles() {
  $("file-list").replaceChildren(
    ...state.pdfs.map((p) => {
      const li = el("li");
      const name = el("span", "file-name", basename(p));
      name.title = "Open in Preview";
      name.append(el("span", "file-dir", prettyDir(dirname(p))));
      name.addEventListener("click", () => api.openPath(p));
      const rm = removeButton("Remove", () => {
        state.pdfs = state.pdfs.filter((x) => x !== p);
        renderFiles();
      });
      li.append(el("span", "file-badge", "PDF"), name, rm);
      return li;
    })
  );
  const n = state.pdfs.length;
  $("file-count").textContent = n ? `${n} file${n === 1 ? "" : "s"}` : "";
  $("clear-files").hidden = n === 0;
  updateConvertButton();
}

function renderFormat() {
  for (const btn of $("format").querySelectorAll("button")) {
    btn.setAttribute("aria-checked", String(btn.dataset.format === state.format));
  }
  $("format-help").textContent = FORMAT_HELP[state.format];
}

function renderOutputDir() {
  $("output-dir").textContent = prettyDir(state.outputDir);
  $("output-dir").title = state.outputDir;
}

function updateConvertButton() {
  $("convert").disabled = state.pdfs.length === 0 || !state.outputDir;
  $("status").textContent = state.pdfs.length ? "" : "Add confirmation PDFs to get started";
}

function addPdfs(paths) {
  state.pdfs = [...new Set([...state.pdfs, ...paths])].sort();
  renderFiles();
}

// ---------- Done list ----------
const CHECK_SVG =
  '<svg class="check-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.7 2.7L16 9.8"/></svg>';

function renderDoneItem(item) {
  const li = el("li", "done-item");

  const head = el("div", "done-head");
  head.insertAdjacentHTML("beforeend", CHECK_SVG);
  const title = el("div", "done-title");
  title.append(
    el("strong", "", item.account),
    el("span", "muted", `${item.trades} trade${item.trades === 1 ? "" : "s"} · ${item.at}`)
  );
  head.append(
    title,
    removeButton("Remove from list", () => {
      state.done = state.done.filter((d) => d.id !== item.id);
      renderDone();
    })
  );
  li.append(head);

  for (const file of item.files) {
    const row = el("div", "out-file");
    const name = el("span", "file-name", basename(file));
    name.title = file;
    const reveal = el("button", "secondary small", "Show in Finder");
    reveal.addEventListener("click", () => api.reveal(file));
    row.append(el("span", "ext", file.split(".").pop()), name, reveal);
    li.append(row);
  }

  const sources = el("div", "sources");
  sources.append(el("span", "sources-label", item.sources.length === 1 ? "Source PDF" : "Source PDFs"));
  const chips = el("div", "chips");
  for (const pdf of item.sources) {
    const chip = el("button", "pdf-chip");
    chip.title = `Open ${pdf} in Preview`;
    chip.append(el("span", "file-badge", "PDF"), el("span", "", basename(pdf)));
    chip.addEventListener("click", () => api.openPath(pdf));
    chips.append(chip);
  }
  sources.append(chips);
  li.append(sources);
  return li;
}

function renderDone() {
  $("done-list").replaceChildren(...state.done.map(renderDoneItem));
  const hasError = !$("error-box").hidden;
  $("results").hidden = state.done.length === 0 && !hasError;
  $("clear-results").hidden = state.done.length === 0;
}

function showError(result) {
  $("error-box").hidden = false;
  $("error-text").textContent = result.error || "Something went wrong.";
  $("log").textContent = (result.stderr || "").trim() || "(no output)";
  renderDone();
}

function hideError() {
  $("error-box").hidden = true;
  renderDone();
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

$("format").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-format]");
  if (!btn) return;
  state.format = btn.dataset.format;
  renderFormat();
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

$("open-output").addEventListener("click", () => api.openPath(state.outputDir));
$("clear-results").addEventListener("click", () => {
  state.done = [];
  renderDone();
});
$("dismiss-error").addEventListener("click", hideError);

$("convert").addEventListener("click", async () => {
  const btn = $("convert");
  btn.disabled = true;
  btn.classList.add("busy");
  btn.querySelector(".label").textContent = "Converting…";
  $("status").textContent = "";

  const result = await api.convert({
    pdfs: state.pdfs,
    outputDir: state.outputDir,
    format: state.format,
  });

  btn.classList.remove("busy");
  btn.querySelector(".label").textContent = "Convert";
  updateConvertButton();

  if (result.ok) {
    const at = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    const items = result.accounts.map((a) => ({ id: nextDoneId++, at, ...a }));
    state.done = [...items, ...state.done];
    $("error-box").hidden = true;
    renderDone();
    $("status").textContent = `Converted ${result.trades} trades across ${result.accounts.length} account${result.accounts.length === 1 ? "" : "s"}`;
  } else {
    showError(result);
  }
  $("results").scrollIntoView({ behavior: "smooth", block: "nearest" });
});

// ---------- Updates ----------
let updateStatus = null;

function renderUpdate(status) {
  updateStatus = status;
  const banner = $("update-banner");
  if (!status) {
    banner.hidden = true;
    return;
  }
  const { state, version, currentVersion, hasAsset, blocker } = status;
  const canInstall = hasAsset && !blocker;
  const busy = state === "downloading" || state === "installing";
  const titles = {
    available: `Version ${version} is available`,
    downloading: `Downloading version ${version}…`,
    installing: `Installing version ${version}…`,
    error: "Update failed",
  };
  let detail = `You have ${currentVersion}.`;
  if (state === "installing") detail = "The app will restart in a moment.";
  else if (state === "downloading") detail = `${status.progress || 0}%`;
  else if (state === "error") detail = status.message;
  else if (blocker) detail = blocker;
  else if (!hasAsset) detail = "Download it from GitHub to update.";

  banner.hidden = false;
  banner.classList.toggle("err", state === "error");
  $("update-title").textContent = titles[state];
  $("update-detail").textContent = detail;

  const progress = $("update-progress");
  progress.hidden = !busy;
  progress.classList.toggle("indeterminate", state === "installing");
  $("update-bar").style.width = state === "downloading" ? `${status.progress || 0}%` : "";

  const install = $("update-install");
  install.hidden = busy || (!canInstall && hasAsset);
  install.querySelector(".label").textContent = !hasAsset
    ? "Download"
    : state === "error"
      ? "Try Again"
      : "Install & Restart";
  $("update-notes").hidden = busy;
  $("update-notes").textContent = state === "error" || blocker ? "Download manually" : "What's new";
  $("update-dismiss").hidden = busy;
}

$("update-install").addEventListener("click", () => {
  if (updateStatus?.hasAsset) api.installUpdate();
  else api.openRelease();
});
$("update-notes").addEventListener("click", () => api.openRelease());
$("update-dismiss").addEventListener("click", () => ($("update-banner").hidden = true));
api.onUpdateStatus(renderUpdate);

// ---------- Init ----------
(async function init() {
  const saved = loadSettings();
  state.outputDir = saved.outputDir || (await api.defaultOutputDir());
  if (FORMAT_HELP[saved.format]) state.format = saved.format;
  renderFormat();
  renderOutputDir();
  renderFiles();
  renderUpdate(await api.updateStatus());
})();
