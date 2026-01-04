// Jeopardy Trainer — static, iOS-friendly, no frameworks, ES module.

const ELEVEN_API_KEY = "sk_67b1ce3047273e14505b4bbdd144bd61a2ad52417a796b0b";
const ELEVEN_VOICE_ID = "NFG5qt843uXKj4pFvR7C";
const ELEVEN_MODEL_ID = "eleven_multilingual_v2";
const ELEVEN_OUTPUT_FORMAT = "mp3_44100_128";

const VALUES_R1 = [200, 400, 600, 800, 1000];
const STORAGE_KEY = "jt_settings_v1";

const $ = (sel) => document.querySelector(sel);
const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
const now = () => performance.now();

const els = {
  statusLine: $("#statusLine"),
  scoreLine: $("#scoreLine"),

  boardView: $("#boardView"),
  boardWrap: $("#boardWrap"),
  categoryCount: $("#categoryCount"),
  newBoardBtn: $("#newBoardBtn"),

  clueView: $("#clueView"),
  clueBackBtn: $("#clueBackBtn"),
  clueMeta: $("#clueMeta"),
  clueStage: $("#clueStage"),
  clueText: $("#clueText"),
  progressWrap: $("#progressWrap"),
  progressFill: $("#progressFill"),
  progressLabel: $("#progressLabel"),
  clueActions: $("#clueActions"),
  buzzBtn: $("#buzzBtn"),
  revealWrap: $("#revealWrap"),
  responseText: $("#responseText"),
  resultButtons: $("#resultButtons"),
  backOnlyButtons: $("#backOnlyButtons"),
  gotItBtn: $("#gotItBtn"),
  missedBtn: $("#missedBtn"),
  backToBoardBtn: $("#backToBoardBtn"),

  resultsView: $("#resultsView"),
  resultsSummary: $("#resultsSummary"),
  categorySummary: $("#categorySummary"),
  reviewFeed: $("#reviewFeed"),
  resultsNewBoardBtn: $("#resultsNewBoardBtn"),

  settingsBtn: $("#settingsBtn"),
  settingsDialog: $("#settingsDialog"),
  settingsForm: $("#settingsForm"),
  datasetFile: $("#datasetFile"),
  useEleven: $("#useEleven"),
  useSystem: $("#useSystem"),
  systemVoice: $("#systemVoice"),
  elevenVoiceId: $("#elevenVoiceId"),
  elevenModelId: $("#elevenModelId"),
  elevenOutputFmt: $("#elevenOutputFmt"),
  buzzSeconds: $("#buzzSeconds"),
  blankMs: $("#blankMs"),
  saveSettingsBtn: $("#saveSettingsBtn"),
  closeSettingsBtn: $("#closeSettingsBtn"),

  dialogFallback: $("#dialogFallback"),
  fallbackBody: $("#fallbackBody"),
  fallbackCloseBtn: $("#fallbackCloseBtn"),
  fallbackSaveBtn: $("#fallbackSaveBtn"),

  audioPlayer: $("#audioPlayer"),
};

const state = {
  dataset: [],
  board: null,
  score: 0,
  outcomes: [],
  current: null,
  audioPrimed: false,
  countdown: {
    rafId: null,
    running: false,
    startT: 0,
    durationMs: 5000,
  },
  speech: {
    synthUtterance: null,
    speakingPollId: null,
  },
  settings: {
    useEleven: true,
    useSystem: true,
    systemVoiceURI: "",
    buzzSeconds: 5.0,
    blankMs: 2000,
    elevenVoiceId: ELEVEN_VOICE_ID,
    elevenModelId: ELEVEN_MODEL_ID,
    elevenOutputFmt: ELEVEN_OUTPUT_FORMAT,
  },
};

init();

function init() {
  try {
    loadSettings();
    syncSettingsUIFromState();
    attachEvents();
    hydrateVoiceList();

    setStatus("Import a TSV/CSV/JSON dataset in Settings to begin.", "info");
    renderScore();
    renderBoardShell();
  } catch (err) {
    console.error(err);
    setStatus("App failed to initialize. Refresh Safari and try again.", "error");
  }
}

function attachEvents() {
  // Top bar
  els.settingsBtn.addEventListener("click", () => openSettings());

  // Board
  els.newBoardBtn.addEventListener("click", () => {
    tryNewBoard();
  });

  els.categoryCount.addEventListener("change", () => {
    if (!state.dataset.length) {
      setStatus("No dataset loaded. Import in Settings.", "warn");
      renderBoardShell();
      return;
    }
    tryNewBoard();
  });

  // Clue
  els.clueBackBtn.addEventListener("click", () => {
    // Treat as skipped if unresolved; still consumes cell.
    if (!state.current) return;
    finalizeClue("skipped");
    goBoard();
  });

  els.buzzBtn.addEventListener("click", () => {
    onBuzz();
  });

  els.gotItBtn.addEventListener("click", () => {
    if (!state.current) return;
    applyScore(+state.current.value);
    finalizeClue("correct");
    goBoard();
  });

  els.missedBtn.addEventListener("click", () => {
    if (!state.current) return;
    applyScore(-state.current.value);
    finalizeClue("wrong");
    goBoard();
  });

  els.backToBoardBtn.addEventListener("click", () => {
    if (!state.current) return;
    finalizeClue("skipped");
    goBoard();
  });

  // Results
  els.resultsNewBoardBtn.addEventListener("click", () => {
    tryNewBoard(true);
  });

  // Settings
  els.saveSettingsBtn.addEventListener("click", () => {
    saveSettingsFromUI();
    closeSettings();
  });

  // Dataset import
  els.datasetFile.addEventListener("change", async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    await importDatasetFile(file);
    // reset input so same file can be re-selected
    els.datasetFile.value = "";
  });

  // Fallback modal
  els.fallbackCloseBtn.addEventListener("click", () => closeSettings());
  els.fallbackSaveBtn.addEventListener("click", () => {
    saveSettingsFromUI();
    closeSettings();
  });

  // Keep Settings button always clickable even during overlays
  document.addEventListener("touchstart", () => {}, { passive: true });
}

function setStatus(msg, level = "info") {
  const prefix =
    level === "error" ? "Error: " :
    level === "warn" ? "Warning: " :
    "";
  els.statusLine.textContent = `${prefix}${String(msg || "")}`;
}

function renderScore() {
  els.scoreLine.textContent = `$${state.score}`;
}

function applyScore(delta) {
  if (!Number.isFinite(delta)) return;
  state.score += delta;
  renderScore();
}

function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return;

    state.settings.useEleven = !!parsed.useEleven;
    state.settings.useSystem = !!parsed.useSystem;
    state.settings.systemVoiceURI = String(parsed.systemVoiceURI || "");
    state.settings.buzzSeconds = clamp(Number(parsed.buzzSeconds || 5.0), 1, 15);
    state.settings.blankMs = clamp(Number(parsed.blankMs || 2000), 250, 5000);

    state.settings.elevenVoiceId = String(parsed.elevenVoiceId || ELEVEN_VOICE_ID);
    state.settings.elevenModelId = String(parsed.elevenModelId || ELEVEN_MODEL_ID);
    state.settings.elevenOutputFmt = String(parsed.elevenOutputFmt || ELEVEN_OUTPUT_FORMAT);
  } catch (err) {
    console.warn("Failed to load settings:", err);
  }
}

function persistSettings() {
  try {
    const payload = {
      useEleven: state.settings.useEleven,
      useSystem: state.settings.useSystem,
      systemVoiceURI: state.settings.systemVoiceURI,
      buzzSeconds: state.settings.buzzSeconds,
      blankMs: state.settings.blankMs,
      elevenVoiceId: state.settings.elevenVoiceId,
      elevenModelId: state.settings.elevenModelId,
      elevenOutputFmt: state.settings.elevenOutputFmt,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch (err) {
    console.warn("Failed to persist settings:", err);
  }
}

function syncSettingsUIFromState() {
  els.useEleven.checked = !!state.settings.useEleven;
  els.useSystem.checked = !!state.settings.useSystem;
  els.buzzSeconds.value = String(state.settings.buzzSeconds);
  els.blankMs.value = String(state.settings.blankMs);

  els.elevenVoiceId.value = state.settings.elevenVoiceId || "";
  els.elevenModelId.value = state.settings.elevenModelId || "";
  els.elevenOutputFmt.value = state.settings.elevenOutputFmt || "";
}

function saveSettingsFromUI() {
  try {
    state.settings.useEleven = !!els.useEleven.checked;
    state.settings.useSystem = !!els.useSystem.checked;

    const buzz = clamp(Number(els.buzzSeconds.value || 5.0), 1, 15);
    // Snap to 0.5 steps defensively
    state.settings.buzzSeconds = Math.round(buzz * 2) / 2;

    state.settings.blankMs = clamp(Number(els.blankMs.value || 2000), 250, 5000);

    state.settings.systemVoiceURI = String(els.systemVoice.value || "");

    state.settings.elevenVoiceId = String(els.elevenVoiceId.value || ELEVEN_VOICE_ID);
    state.settings.elevenModelId = String(els.elevenModelId.value || ELEVEN_MODEL_ID);
    state.settings.elevenOutputFmt = String(els.elevenOutputFmt.value || ELEVEN_OUTPUT_FORMAT);

    persistSettings();

    // Update any live labels
    if (state.current) {
      els.progressLabel.textContent = `Buzz window: ${state.settings.buzzSeconds.toFixed(1)}s`;
    }

    setStatus("Settings saved.", "info");
  } catch (err) {
    console.error(err);
    setStatus("Failed to save settings.", "error");
  }
}

function supportsDialog() {
  return !!(els.settingsDialog && typeof els.settingsDialog.showModal === "function");
}

function openSettings() {
  try {
    syncSettingsUIFromState();
    hydrateVoiceList(); // ensure it stays fresh

    if (supportsDialog()) {
      els.settingsDialog.showModal();
      return;
    }

    // Fallback overlay: clone dialog body into fallback container
    els.fallbackBody.innerHTML = "";
    const bodyClone = els.settingsDialog.querySelector(".dialog__body")?.cloneNode(true);
    if (!bodyClone) {
      setStatus("Settings UI failed to open.", "error");
      return;
    }

    // Move cloned content into fallback, and wire up inputs to existing IDs by mapping values back and forth.
    // Approach: swap fallback body with the real body node temporarily to preserve IDs.
    // Simpler: reuse the real dialog body node inside fallback and put it back on close.
    const realBody = els.settingsDialog.querySelector(".dialog__body");
    if (!realBody) {
      setStatus("Settings UI failed to open.", "error");
      return;
    }

    // Detach and append to fallback
    els.fallbackBody.appendChild(realBody);

    els.dialogFallback.hidden = false;
    document.body.style.overflow = "hidden";
  } catch (err) {
    console.error(err);
    setStatus("Failed to open Settings.", "error");
  }
}

function closeSettings() {
  try {
    if (supportsDialog() && els.settingsDialog.open) {
      els.settingsDialog.close();
      return;
    }

    // If fallback is open, restore the real body back to dialog.
    if (!els.dialogFallback.hidden) {
      const panelBody = els.fallbackBody.querySelector(".dialog__body");
      const dialogForm = els.settingsDialog.querySelector(".dialog__form");
      const header = els.settingsDialog.querySelector(".dialog__header");
      const footer = els.settingsDialog.querySelector(".dialog__footer");
      if (panelBody && dialogForm && header && footer) {
        // Insert between header and footer
        dialogForm.insertBefore(panelBody, footer);
      }
      els.dialogFallback.hidden = true;
      document.body.style.overflow = "";
    }
  } catch (err) {
    console.error(err);
    setStatus("Failed to close Settings.", "error");
  }
}

function hydrateVoiceList() {
  try {
    const synth = window.speechSynthesis;
    if (!synth) {
      els.systemVoice.innerHTML = `<option value="">(SpeechSynthesis unavailable)</option>`;
      return;
    }

    const voices = synth.getVoices ? synth.getVoices() : [];
    els.systemVoice.innerHTML = "";

    if (!voices.length) {
      els.systemVoice.innerHTML = `<option value="">(No voices found)</option>`;
      // iOS often loads voices asynchronously.
      setTimeout(() => {
        try {
          const v2 = synth.getVoices ? synth.getVoices() : [];
          if (!v2.length) return;
          fillVoices(v2);
        } catch {}
      }, 250);
      return;
    }

    fillVoices(voices);
  } catch (err) {
    console.warn("Voice list error:", err);
    els.systemVoice.innerHTML = `<option value="">(Voice list error)</option>`;
  }

  function fillVoices(voices) {
    els.systemVoice.innerHTML = "";
    const preferred = state.settings.systemVoiceURI || "";
    const frag = document.createDocumentFragment();

    const sorted = [...voices].sort((a, b) => {
      const al = `${a.lang || ""} ${a.name || ""}`.toLowerCase();
      const bl = `${b.lang || ""} ${b.name || ""}`.toLowerCase();
      return al.localeCompare(bl);
    });

    for (const v of sorted) {
      const opt = document.createElement("option");
      opt.value = v.voiceURI || "";
      opt.textContent = `${v.name || "Voice"} (${v.lang || "?"})${v.default ? " — default" : ""}`;
      if (preferred && opt.value === preferred) opt.selected = true;
      frag.appendChild(opt);
    }
    els.systemVoice.appendChild(frag);

    // If preferred not found, keep first
    if (preferred && !els.systemVoice.value) {
      els.systemVoice.value = sorted[0]?.voiceURI || "";
    }
  }
}

// ------------------------ Dataset import ------------------------

async function importDatasetFile(file) {
  setStatus(`Importing: ${file.name}…`, "info");
  let text = "";
  try {
    text = await file.text();
  } catch (err) {
    console.error(err);
    setStatus("Failed to read file. Try again from iPhone Files app.", "error");
    return;
  }

  let normalized = [];
  try {
    normalized = parseAndNormalize(text, file.name);
  } catch (err) {
    console.error(err);
    setStatus("Failed to parse dataset. Check file format.", "error");
    return;
  }

  const validR1 = normalized.filter(isValidR1Clue);
  if (validR1.length < 10) {
    setStatus("Import produced fewer than 10 valid Round 1 clues. Needs: round=Jeopardy/1/J, value 200–1000, clue+response.", "error");
    state.dataset = [];
    state.board = null;
    state.score = 0;
    state.outcomes = [];
    renderScore();
    renderBoardShell();
    return;
  }

  state.dataset = validR1;
  state.score = 0;
  state.outcomes = [];
  state.board = null;
  renderScore();

  setStatus(`Imported: ${validR1.length} clues. Create a new board.`, "info");
  tryNewBoard(true);
}

function parseAndNormalize(text, filename = "") {
  const trimmed = (text || "").trim();
  if (!trimmed) return [];

  const lower = filename.toLowerCase();
  const looksJson = trimmed.startsWith("[") || trimmed.startsWith("{");
  const looksTsv = trimmed.includes("\t");
  const looksCsv = trimmed.includes(",") && !looksTsv;

  if (lower.endsWith(".json") || looksJson) {
    const data = JSON.parse(trimmed);
    const arr = Array.isArray(data) ? data : (Array.isArray(data?.data) ? data.data : []);
    if (!Array.isArray(arr)) throw new Error("JSON is not an array");
    return arr.map((row, idx) => normalizeRow(row, idx));
  }

  if (lower.endsWith(".tsv") || looksTsv) {
    const rows = parseDelimited(trimmed, "\t");
    return rows.map((row, idx) => normalizeRow(row, idx));
  }

  if (lower.endsWith(".csv") || looksCsv) {
    const rows = parseCSV(trimmed);
    return rows.map((row, idx) => normalizeRow(row, idx));
  }

  // Fallback: try TSV then CSV then JSON
  try {
    const rows = parseDelimited(trimmed, "\t");
    return rows.map((row, idx) => normalizeRow(row, idx));
  } catch {}
  try {
    const rows = parseCSV(trimmed);
    return rows.map((row, idx) => normalizeRow(row, idx));
  } catch {}
  const data = JSON.parse(trimmed);
  const arr = Array.isArray(data) ? data : [];
  return arr.map((row, idx) => normalizeRow(row, idx));
}

function parseDelimited(text, delim) {
  const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
  if (lines.length < 2) return [];
  const header = lines[0].split(delim).map(s => s.trim());
  const out = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(delim);
    const row = {};
    for (let c = 0; c < header.length; c++) {
      const key = header[c];
      if (!key) continue;
      row[key] = (cols[c] ?? "").trim();
    }
    out.push(row);
  }
  return out;
}

// Minimal CSV parser with quoted fields support.
function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
  if (lines.length < 2) return [];

  const header = readCsvLine(lines[0]);
  const out = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = readCsvLine(lines[i]);
    const row = {};
    for (let c = 0; c < header.length; c++) {
      const key = (header[c] ?? "").trim();
      if (!key) continue;
      row[key] = (cols[c] ?? "").trim();
    }
    out.push(row);
  }
  return out;

  function readCsvLine(line) {
    const res = [];
    let cur = "";
    let inQ = false;

    for (let i = 0; i < line.length; i++) {
      const ch = line[i];

      if (ch === '"') {
        if (inQ && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQ = !inQ;
        }
        continue;
      }

      if (ch === "," && !inQ) {
        res.push(cur);
        cur = "";
        continue;
      }

      cur += ch;
    }
    res.push(cur);
    return res;
  }
}

function normalizeRow(row, idx) {
  const obj = row && typeof row === "object" ? row : {};
  const get = (...keys) => {
    for (const k of keys) {
      if (k in obj && obj[k] != null) return obj[k];
      const lk = String(k).toLowerCase();
      for (const key of Object.keys(obj)) {
        if (String(key).toLowerCase() === lk) return obj[key];
      }
    }
    return "";
  };

  // TSV jwolle1 format note:
  // answer = clue text; question = correct response
  const clue = String(get("clue", "answer", "question_text", "clue_text") || "").trim();
  const response = String(get("response", "question", "correct_response", "response_text") || "").trim();

  const roundRaw = String(get("round", "j_round", "game_round") || "").trim();
  const category = String(get("category", "category_name") || "").trim();

  const valueRaw = String(get("value", "clue_value", "dollar_value") || "").trim();
  const airDate = String(get("air_date", "date", "airDate") || "").trim();

  const idRaw = get("id", "clue_id", "guid") || "";
  const id = String(idRaw || `${idx + 1}_${hashTiny(category + clue + response)}`).trim();

  return {
    id,
    round: normalizeRound(roundRaw),
    category,
    value: normalizeValue(valueRaw),
    clue,
    response,
    air_date: airDate,
  };
}

function normalizeRound(r) {
  const s = String(r || "").trim().toLowerCase();
  if (!s) return "";
  if (s === "1" || s === "j" || s === "jeopardy" || s === "jeopardy!" || s === "round 1") return "J";
  if (s === "2" || s === "dj" || s.includes("double")) return "DJ";
  if (s.includes("final")) return "FJ";
  // Some dumps use "Jeopardy Round" etc.
  if (s.includes("jeopardy") && !s.includes("double")) return "J";
  if (s.includes("double")) return "DJ";
  return s.toUpperCase();
}

function normalizeValue(v) {
  const s = String(v || "").trim();
  if (!s) return 0;

  // handle "200", "$200", "200.0", "200 " etc.
  const cleaned = s.replace(/[$,]/g, "").trim();
  const num = Number(cleaned);
  if (!Number.isFinite(num)) return 0;
  return Math.round(num);
}

function isValidR1Clue(c) {
  if (!c || typeof c !== "object") return false;
  if (normalizeRound(c.round) !== "J") return false;
  if (!c.category || !String(c.category).trim()) return false;
  if (!VALUES_R1.includes(Number(c.value))) return false;
  if (!c.clue || !String(c.clue).trim()) return false;
  if (!c.response || !String(c.response).trim()) return false;
  return true;
}

function hashTiny(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).slice(0, 8);
}

// ------------------------ Board generation ------------------------

function renderBoardShell() {
  els.boardWrap.innerHTML = `
    <div class="boardHint">
      ${state.dataset.length
        ? "Tap <b>New Board</b> to generate a game from your imported dataset."
        : "No dataset loaded. Open <b>Settings</b> and import a TSV/CSV/JSON file. Only Round 1 (Jeopardy) clues with values $200–$1000 are used."}
    </div>
  `;
}

function tryNewBoard(force = false) {
  try {
    if (!state.dataset.length) {
      setStatus("No dataset loaded. Import in Settings.", "warn");
      renderBoardShell();
      return;
    }

    const n = clamp(Number(els.categoryCount.value || 4), 3, 6);
    const board = buildBoardFromDataset(state.dataset, n);

    if (!board) {
      setStatus("Not enough complete categories (need at least one clue for each $200–$1000). Import a larger dataset.", "error");
      renderBoardShell();
      return;
    }

    state.board = board;
    state.score = force ? 0 : state.score;
    state.outcomes = force ? [] : state.outcomes;

    renderScore();
    setStatus("Board ready. Tap a dollar value to play.", "info");
    goBoard();
    renderBoard();
  } catch (err) {
    console.error(err);
    setStatus("Failed to generate board. Try a different dataset.", "error");
    renderBoardShell();
  }
}

function buildBoardFromDataset(dataset, categoryCount) {
  const byCat = new Map();

  for (const clue of dataset) {
    const catRaw = String(clue.category || "").trim();
    if (!catRaw) continue;
    const catKey = catRaw.toLowerCase().replace(/\s+/g, " ").trim();
    if (!byCat.has(catKey)) {
      byCat.set(catKey, {
        key: catKey,
        display: catRaw,
        buckets: new Map(), // value -> array
      });
    }
    const entry = byCat.get(catKey);
    if (!entry.buckets.has(clue.value)) entry.buckets.set(clue.value, []);
    entry.buckets.get(clue.value).push(clue);
  }

  const complete = [];
  for (const entry of byCat.values()) {
    const ok = VALUES_R1.every(v => (entry.buckets.get(v) || []).length > 0);
    if (ok) complete.push(entry);
  }

  if (complete.length < categoryCount) return null;

  const picked = sampleN(complete, categoryCount);
  const categories = picked.map(p => ({ key: p.key, name: p.display }));

  const grid = new Map(); // cellKey -> clue
  const used = new Set();

  for (let ci = 0; ci < picked.length; ci++) {
    const p = picked[ci];
    for (const v of VALUES_R1) {
      const bucket = p.buckets.get(v) || [];
      const clue = bucket[Math.floor(Math.random() * bucket.length)];
      const cellKey = makeCellKey(p.key, v);
      grid.set(cellKey, { ...clue, _catKey: p.key, _catName: p.display, _value: v });
    }
  }

  return { categories, grid, used };
}

function makeCellKey(catKey, value) {
  return `${catKey}::${value}`;
}

function sampleN(arr, n) {
  const copy = [...arr];
  shuffle(copy);
  return copy.slice(0, n);
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function renderBoard() {
  if (!state.board) {
    renderBoardShell();
    return;
  }

  const cols = state.board.categories.length;
  const colStyle = `grid-template-columns: repeat(${cols}, 1fr);`;

  const headRow = `
    <div class="boardRow boardHead" style="${colStyle}">
      ${state.board.categories.map(c => `<div class="boardCell">${escapeHtml(c.name)}</div>`).join("")}
    </div>
  `;

  const rows = VALUES_R1.map(v => {
    return `
      <div class="boardRow" style="${colStyle}">
        ${state.board.categories.map(c => {
          const key = makeCellKey(c.key, v);
          const used = state.board.used.has(key);
          const classes = `boardCell boardMoney${used ? " boardMoney--used" : ""}`;
          const label = `$${v}`;
          return `
            <div class="${classes}" role="button" tabindex="0"
              data-cell="${escapeAttr(key)}"
              aria-disabled="${used ? "true" : "false"}">
              ${label}
            </div>
          `;
        }).join("")}
      </div>
    `;
  }).join("");

  els.boardWrap.innerHTML = `<div class="board">${headRow}${rows}</div>`;

  // Attach handlers
  els.boardWrap.querySelectorAll(".boardMoney").forEach((cell) => {
    const key = cell.getAttribute("data-cell") || "";
    const isUsed = cell.classList.contains("boardMoney--used");

    const handler = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (isUsed) return;
      openClueByCellKey(key);
    };

    cell.addEventListener("click", handler);
    cell.addEventListener("touchend", handler, { passive: false });
    cell.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") handler(e);
    });
  });
}

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
function escapeAttr(s) {
  return escapeHtml(s).replaceAll("`", "&#096;");
}

// ------------------------ View routing ------------------------

function showView(which) {
  for (const v of [els.boardView, els.clueView, els.resultsView]) {
    v.classList.remove("view--active");
  }
  which.classList.add("view--active");
}

function goBoard() {
  stopAllAudioAndTimers();
  showView(els.boardView);
  renderScore();

  // If board exhausted, transition
  if (state.board && state.board.used.size >= state.board.categories.length * VALUES_R1.length) {
    goResults();
    return;
  }
  renderBoard();
}

function goClue() {
  showView(els.clueView);
}

function goResults() {
  stopAllAudioAndTimers();
  showView(els.resultsView);
  renderResults();
}

// ------------------------ Clue flow ------------------------

async function openClueByCellKey(cellKey) {
  if (!state.board || !state.board.grid.has(cellKey)) {
    setStatus("That clue is unavailable. Generate a new board.", "warn");
    return;
  }
  if (state.board.used.has(cellKey)) return;

  const clue = state.board.grid.get(cellKey);
  const value = Number(clue.value || clue._value || 0) || 0;

  state.current = {
    cellKey,
    category: clue._catName || clue.category || "",
    catKey: clue._catKey || String(clue.category || "").toLowerCase(),
    value,
    clue: String(clue.clue || "").trim(),
    response: String(clue.response || "").trim(),
    air_date: clue.air_date || "",
    id: clue.id || "",
    phase: "init",
    buzzed: false,
    resolved: false,
  };

  // Prime audio on initial tap (iOS unlock)
  await primeAudioOnce();

  // Immediately consume the cell if user navigates back or leaves
  markCellUsed(cellKey);

  // Render clue UI
  renderClueBase();

  goClue();

  // Speak clue text only, then start countdown
  await startClueAudioThenCountdown();
}

function markCellUsed(cellKey) {
  if (!state.board) return;
  state.board.used.add(cellKey);
}

function renderClueBase() {
  if (!state.current) return;

  els.clueStage.classList.remove("clueStage--blank");
  els.revealWrap.hidden = true;
  els.resultButtons.hidden = true;
  els.backOnlyButtons.hidden = true;

  els.clueText.textContent = state.current.clue || "(No clue text)";
  els.responseText.textContent = "";

  els.progressFill.style.width = "0%";
  els.progressLabel.textContent = `Buzz window: ${state.settings.buzzSeconds.toFixed(1)}s`;

  els.buzzBtn.disabled = true; // enabled when countdown starts
  els.progressWrap.style.opacity = "0.6";
  els.progressWrap.setAttribute("aria-hidden", "false");
  els.clueActions.style.opacity = "0.75";

  els.clueMeta.textContent = `${state.current.category} • $${state.current.value}`;
}

async function startClueAudioThenCountdown() {
  if (!state.current) return;

  stopAllAudioAndTimers();

  // Enable user feedback if Eleven isn't usable
  const elevenEnabled = state.settings.useEleven && canUseElevenLabs();
  const systemEnabled = state.settings.useSystem && !!window.speechSynthesis;

  state.current.phase = "reading";
  els.buzzBtn.disabled = true;
  els.progressWrap.style.opacity = "0.6";
  els.clueActions.style.opacity = "0.75";

  try {
    if (elevenEnabled) {
      const ok = await speakWithElevenLabs(state.current.clue);
      if (!ok && systemEnabled) {
        setStatus("ElevenLabs TTS failed. Falling back to System Voice.", "warn");
        await speakWithSystemVoice(state.current.clue);
      } else if (!ok && !systemEnabled) {
        setStatus("TTS failed (ElevenLabs) and System Voice is disabled.", "error");
      }
    } else if (systemEnabled) {
      if (state.settings.useEleven && !canUseElevenLabs()) {
        setStatus("ElevenLabs unavailable (missing key/voice). Using System Voice.", "warn");
      }
      await speakWithSystemVoice(state.current.clue);
    } else {
      setStatus("TTS is disabled. Enable a reader in Settings.", "warn");
    }
  } catch (err) {
    console.error(err);
    if (systemEnabled) {
      setStatus("TTS failed. Using System Voice fallback.", "warn");
      try { await speakWithSystemVoice(state.current.clue); } catch {}
    } else {
      setStatus("TTS failed.", "error");
    }
  }

  // Only after speaking ends, start countdown
  if (!state.current) return;
  await startCountdown();
}

function canUseElevenLabs() {
  const keyOk = typeof ELEVEN_API_KEY === "string" && ELEVEN_API_KEY && !ELEVEN_API_KEY.includes("PASTE_");
  const voiceOk = (state.settings.elevenVoiceId || ELEVEN_VOICE_ID || "").trim() && !(state.settings.elevenVoiceId || ELEVEN_VOICE_ID).includes("PASTE_");
  return keyOk && voiceOk;
}

async function primeAudioOnce() {
  if (state.audioPrimed) return true;
  try {
    const a = els.audioPlayer;
    if (!a) return false;

    // Very short silent WAV (data URI). Play muted then pause to unlock playback on iOS.
    const silentWav =
      "data:audio/wav;base64," +
      "UklGRiQAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABAAZGF0YQAAAAA=";

    a.src = silentWav;
    a.muted = true;
    a.playsInline = true;

    // Play attempt (must happen inside user gesture handler; we call this at board-cell tap).
    const p = a.play();
    if (p && typeof p.then === "function") {
      await p;
    }
    a.pause();
    a.currentTime = 0;
    a.muted = false;

    state.audioPrimed = true;
    return true;
  } catch (err) {
    console.warn("Audio prime failed:", err);
    state.audioPrimed = true; // avoid repeated attempts
    return false;
  }
}

async function speakWithElevenLabs(text) {
  try {
    const voiceId = (state.settings.elevenVoiceId || ELEVEN_VOICE_ID || "").trim();
    const modelId = (state.settings.elevenModelId || ELEVEN_MODEL_ID || "").trim();
    const outFmt = (state.settings.elevenOutputFmt || ELEVEN_OUTPUT_FORMAT || "").trim();

    if (!voiceId || !modelId || !outFmt) {
      setStatus("ElevenLabs settings missing. Check Settings → Advanced.", "error");
      return false;
    }

    if (!canUseElevenLabs()) {
      setStatus("ElevenLabs key/voice not set in app.js constants. Using fallback.", "warn");
      return false;
    }

    const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=${encodeURIComponent(outFmt)}`;
    const payload = {
      text: String(text || ""),
      model_id: modelId,
      voice_settings: {
        stability: 0.45,
        similarity_boost: 0.75,
        style: 0.2,
        use_speaker_boost: true,
      },
    };

    const controller = new AbortController();
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "xi-api-key": ELEVEN_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!resp.ok) {
      const body = await safeText(resp);
      console.warn("ElevenLabs HTTP not ok:", resp.status, body);
      setStatus(`ElevenLabs failed (HTTP ${resp.status}).`, "warn");
      return false;
    }

    const blob = await resp.blob();
    if (!blob || !blob.size) {
      setStatus("ElevenLabs returned empty audio.", "warn");
      return false;
    }

    const a = els.audioPlayer;
    if (!a) return false;

    const objUrl = URL.createObjectURL(blob);
    a.src = objUrl;
    a.playsInline = true;

    const ended = new Promise((resolve) => {
      const onEnd = () => {
        cleanup();
        resolve(true);
      };
      const onErr = () => {
        cleanup();
        resolve(false);
      };
      const cleanup = () => {
        a.removeEventListener("ended", onEnd);
        a.removeEventListener("error", onErr);
        try { URL.revokeObjectURL(objUrl); } catch {}
      };
      a.addEventListener("ended", onEnd);
      a.addEventListener("error", onErr);
    });

    // Attempt playback
    const playPromise = a.play();
    if (playPromise && typeof playPromise.catch === "function") {
      await playPromise.catch((err) => {
        console.warn("Audio play blocked:", err);
      });
    }

    const ok = await ended;
    if (!ok) setStatus("ElevenLabs playback failed.", "warn");
    return ok;
  } catch (err) {
    console.warn("ElevenLabs TTS error:", err);
    setStatus("ElevenLabs TTS failed.", "warn");
    return false;
  }
}

function safeText(resp) {
  try {
    return resp.text();
  } catch {
    return Promise.resolve("");
  }
}

async function speakWithSystemVoice(text) {
  const synth = window.speechSynthesis;
  if (!synth) throw new Error("SpeechSynthesis unavailable");

  stopSystemSpeech();

  const utter = new SpeechSynthesisUtterance(String(text || ""));
  state.speech.synthUtterance = utter;

  const voiceURI = String(state.settings.systemVoiceURI || "");
  const voices = synth.getVoices ? synth.getVoices() : [];
  const chosen = voices.find(v => v.voiceURI === voiceURI) || null;
  if (chosen) utter.voice = chosen;

  utter.rate = 0.98;
  utter.pitch = 1.0;
  utter.volume = 1.0;

  const done = new Promise((resolve) => {
    let resolved = false;

    const finish = () => {
      if (resolved) return;
      resolved = true;
      cleanup();
      resolve(true);
    };

    const cleanup = () => {
      utter.onend = null;
      utter.onerror = null;
      if (state.speech.speakingPollId) {
        clearInterval(state.speech.speakingPollId);
        state.speech.speakingPollId = null;
      }
    };

    utter.onend = () => finish();
    utter.onerror = () => finish();

    // Fallback poll: iOS sometimes misses onend.
    state.speech.speakingPollId = setInterval(() => {
      try {
        if (!synth.speaking && !synth.pending) finish();
      } catch {
        finish();
      }
    }, 200);
  });

  try {
    synth.speak(utter);
  } catch (err) {
    console.warn("speak() failed:", err);
    // Resolve quickly to not deadlock
    stopSystemSpeech();
    return;
  }

  await done;
}

function stopSystemSpeech() {
  try {
    const synth = window.speechSynthesis;
    if (!synth) return;
    synth.cancel();
  } catch {}
  state.speech.synthUtterance = null;
  if (state.speech.speakingPollId) {
    clearInterval(state.speech.speakingPollId);
    state.speech.speakingPollId = null;
  }
}

function stopAllAudioAndTimers() {
  stopCountdown();
  stopSystemSpeech();
  try {
    const a = els.audioPlayer;
    if (a) {
      a.pause();
      a.currentTime = 0;
      // keep src for unlocked behavior
    }
  } catch {}
}

async function startCountdown() {
  if (!state.current) return;

  state.current.phase = "buzz";
  els.buzzBtn.disabled = false;
  els.progressWrap.style.opacity = "1";
  els.clueActions.style.opacity = "1";
  els.revealWrap.hidden = true;

  const durationMs = Math.round(clamp(state.settings.buzzSeconds, 1, 15) * 1000);
  state.countdown.durationMs = durationMs;
  state.countdown.startT = now();
  state.countdown.running = true;

  els.progressFill.style.width = "0%";

  return new Promise((resolve) => {
    const tick = () => {
      if (!state.countdown.running) return resolve();
      const t = now();
      const elapsed = t - state.countdown.startT;
      const p = clamp(elapsed / durationMs, 0, 1);
      els.progressFill.style.width = `${(p * 100).toFixed(2)}%`;

      if (p >= 1) {
        state.countdown.running = false;
        state.countdown.rafId = null;
        onCountdownExpired();
        return resolve();
      }

      state.countdown.rafId = requestAnimationFrame(tick);
    };
    state.countdown.rafId = requestAnimationFrame(tick);
  });
}

function stopCountdown() {
  state.countdown.running = false;
  if (state.countdown.rafId) {
    cancelAnimationFrame(state.countdown.rafId);
    state.countdown.rafId = null;
  }
}

function onBuzz() {
  if (!state.current) return;
  if (state.current.phase !== "buzz") return;

  state.current.buzzed = true;
  stopCountdown();

  // Disable buzz immediately
  els.buzzBtn.disabled = true;
  els.progressWrap.style.opacity = "0.6";
  els.clueActions.style.opacity = "0.75";

  // Blank screen phase
  const blankMs = clamp(Number(state.settings.blankMs || 2000), 250, 5000);
  state.current.phase = "blank";
  els.clueStage.classList.add("clueStage--blank");

  setTimeout(() => {
    if (!state.current) return;
    els.clueStage.classList.remove("clueStage--blank");
    revealResponse({ withScoringButtons: true });
  }, blankMs);
}

function onCountdownExpired() {
  if (!state.current) return;
  if (state.current.phase !== "buzz") return;

  state.current.phase = "timeout";
  els.buzzBtn.disabled = true;
  revealResponse({ withScoringButtons: false });
}

function revealResponse({ withScoringButtons }) {
  if (!state.current) return;

  els.revealWrap.hidden = false;
  els.responseText.textContent = state.current.response || "(No response)";

  if (withScoringButtons) {
    els.resultButtons.hidden = false;
    els.backOnlyButtons.hidden = true;
  } else {
    els.resultButtons.hidden = true;
    els.backOnlyButtons.hidden = false;
  }
}

function finalizeClue(status) {
  if (!state.current) return;

  // If leaving before buzzing or after timeout without scoring, treat as skipped (no score change).
  const normalized =
    status === "correct" ? "correct" :
    status === "wrong" ? "wrong" :
    "skipped";

  const entry = {
    id: state.current.id,
    category: state.current.category,
    value: state.current.value,
    clue: state.current.clue,
    response: state.current.response,
    air_date: state.current.air_date,
    status: normalized,
    attempted: normalized === "correct" || normalized === "wrong",
    ts: Date.now(),
  };

  state.outcomes.push(entry);
  state.current = null;

  // Exhaustion check
  if (state.board && state.board.used.size >= state.board.categories.length * VALUES_R1.length) {
    goResults();
  }
}

// ------------------------ Results ------------------------

function renderResults() {
  const score = state.score;

  const correct = state.outcomes.filter(o => o.status === "correct").length;
  const wrong = state.outcomes.filter(o => o.status === "wrong").length;
  const skipped = state.outcomes.filter(o => o.status === "skipped").length;
  const buzzed = correct + wrong;
  const accuracy = buzzed > 0 ? (correct / buzzed) : 0;

  els.resultsSummary.innerHTML = `
    ${statCard("Final score", `$${score}`)}
    ${statCard("Buzzed", `${buzzed}`)}
    ${statCard("Accuracy", `${Math.round(accuracy * 100)}%`)}
    ${statCard("Skipped", `${skipped}`)}
  `;

  renderCategorySummary();
  renderReviewFeed();

  if (!state.dataset.length) {
    setStatus("No dataset loaded. Import in Settings.", "warn");
  } else {
    setStatus("Results ready. Tap New Board to play again.", "info");
  }
}

function statCard(label, value) {
  return `
    <div class="stat">
      <div class="stat__label">${escapeHtml(label)}</div>
      <div class="stat__value">${escapeHtml(value)}</div>
    </div>
  `;
}

function renderCategorySummary() {
  // Use only categories from current board if present; otherwise compute from outcomes.
  const boardCats = state.board?.categories?.map(c => c.name) || [];
  const inScope = boardCats.length ? new Set(boardCats.map(n => n.toLowerCase())) : null;

  const byCat = new Map();
  for (const o of state.outcomes) {
    const cat = o.category || "(Unknown)";
    if (inScope && !inScope.has(cat.toLowerCase())) continue;

    if (!byCat.has(cat)) byCat.set(cat, { cat, correct: 0, wrong: 0, skipped: 0 });
    const agg = byCat.get(cat);
    if (o.status === "correct") agg.correct++;
    else if (o.status === "wrong") agg.wrong++;
    else agg.skipped++;
  }

  const rows = [...byCat.values()].map(v => {
    const attempted = v.correct + v.wrong;
    const acc = attempted ? (v.correct / attempted) : 0;
    return { ...v, attempted, acc };
  });

  rows.sort((a, b) => (b.attempted - a.attempted) || (b.acc - a.acc) || a.cat.localeCompare(b.cat));

  const top = rows.slice(0, 8);

  if (!top.length) {
    els.categorySummary.innerHTML = `<div class="boardHint">No category stats yet.</div>`;
    return;
  }

  els.categorySummary.innerHTML = top.map(r => {
    const accPct = r.attempted ? `${Math.round(r.acc * 100)}%` : "—";
    return `
      <div class="catRow">
        <div class="catName">${escapeHtml(r.cat)}</div>
        <div class="catStats">
          attempted ${r.attempted} • skipped ${r.skipped} • acc ${accPct}
        </div>
      </div>
    `;
  }).join("");
}

function renderReviewFeed() {
  const items = state.outcomes.filter(o => o.status === "wrong" || o.status === "skipped");
  if (!items.length) {
    els.reviewFeed.innerHTML = `<div class="boardHint">No missed or skipped clues to review.</div>`;
    return;
  }

  els.reviewFeed.innerHTML = items.map(o => {
    const badge = o.status === "wrong"
      ? `<span class="badge badge--bad">Missed</span>`
      : `<span class="badge badge--skip">Skipped</span>`;

    const query = `${o.response} ${o.category}`.trim();
    const wiki = `https://en.wikipedia.org/w/index.php?search=${encodeURIComponent(query)}`;
    const yt = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;

    const blurb = buildLearningBlurb(o);

    return `
      <div class="card">
        <div class="cardTop">
          <div class="cardMeta">
            <div><b>${escapeHtml(o.category)}</b> • $${escapeHtml(o.value)}</div>
            <div>${o.air_date ? `Air date: ${escapeHtml(o.air_date)}` : ""}</div>
          </div>
          ${badge}
        </div>

        <div class="cardQ">${escapeHtml(o.clue)}</div>

        <div class="cardA">Answer: ${escapeHtml(o.response)}</div>

        <div class="cardBlurb">${escapeHtml(blurb)}</div>

        <div class="cardLinks">
          <a href="${escapeAttr(wiki)}" target="_blank" rel="noopener noreferrer">Wikipedia</a>
          <a href="${escapeAttr(yt)}" target="_blank" rel="noopener noreferrer">YouTube</a>
        </div>
      </div>
    `;
  }).join("");
}

function buildLearningBlurb(o) {
  const resp = String(o.response || "").trim();
  const cat = String(o.category || "").trim();

  const keyWords = pickKeywords(resp, 3);
  const cue = keyWords.length ? `Cue: ${keyWords.join(" • ")}` : `Cue: ${cat}`;
  const anchor = `Anchor: ${resp}.`;
  const retrieval = `Retrieval cue: link "${resp}" to "${cat}" and the first 3–5 words of the clue. ${cue}.`;
  const drill = `Drill: write the answer once, then recall it 3 times spaced over 10 minutes; next, say it aloud in a full sentence (“${resp} is …”).`;
  return `${anchor} ${retrieval}\n\n${drill}`;
}

function pickKeywords(text, max = 3) {
  const s = String(text || "").toLowerCase();
  const words = s
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .filter(w => w.length >= 5)
    .filter(w => !["which","there","their","about","these","those","where","after","before","would","could","whose","often"].includes(w));

  const unique = [];
  for (const w of words) {
    if (!unique.includes(w)) unique.push(w);
    if (unique.length >= max) break;
  }
  return unique.map(w => w[0].toUpperCase() + w.slice(1));
}

// ------------------------ Helpers ------------------------

function renderBoardTopSafety() {
  // If board exists but has no DOM, rerender
  if (state.board) renderBoard();
  else renderBoardShell();
}

function setSafeProgressWidth(p) {
  const pct = clamp(p, 0, 1) * 100;
  els.progressFill.style.width = `${pct.toFixed(2)}%`;
}

function stopEverythingAndResetClueUI() {
  stopAllAudioAndTimers();
  els.clueStage.classList.remove("clueStage--blank");
  els.revealWrap.hidden = true;
  els.resultButtons.hidden = true;
  els.backOnlyButtons.hidden = true;
  els.buzzBtn.disabled = true;
  setSafeProgressWidth(0);
}

function renderBoardTopIfNeeded() {
  renderScore();
  renderBoardTopSafety();
}

// Prevent dead ends if user uses browser navigation or unexpected state
window.addEventListener("pageshow", () => {
  try {
    renderScore();
    if (els.boardView.classList.contains("view--active")) renderBoardTopSafety();
  } catch {}
});