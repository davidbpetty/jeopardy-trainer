/* Jeopardy Trainer — Board Mode (mobile-first)
   Fixes in this version:
   - Always show results when board is exhausted
   - TTS reads only the clue (not category/value)
   - Progress bar animates (ensure .progressFill has a background in CSS)
   - Buzz window starts only AFTER reading completes (robust iOS gating)
   - Optional OpenAI TTS via user-entered key stored in localStorage (not in repo)

   OpenAI TTS REST: POST https://api.openai.com/v1/audio/speech  (model gpt-4o-mini-tts)
   Docs: https://platform.openai.com/docs/api-reference/audio/create-speech
*/

const $ = (id) => document.getElementById(id);

const ui = {
  score: $("score"),
  btnNewBoard: $("btnNewBoard"),
  btnNewBoard2: $("btnNewBoard2"),
  btnSettings: $("btnSettings"),
  settingsModal: $("settingsModal"),

  boardView: $("boardView"),
  board: $("board"),
  statusLine: $("statusLine"),
  categoriesCount: $("categoriesCount"),

  clueView: $("clueView"),
  clueCategory: $("clueCategory"),
  clueValue: $("clueValue"),
  clueText: $("clueText"),
  btnBackToBoardTop: $("btnBackToBoardTop"),

  progressWrap: $("progressWrap"),
  progressFill: $("progressFill"),
  progressLabel: $("progressLabel"),
  btnBuzz: $("btnBuzz"),
  blankScreen: $("blankScreen"),
  resultActions: $("resultActions"),
  btnGotIt: $("btnGotIt"),
  btnMissed: $("btnMissed"),
  noBuzzActions: $("noBuzzActions"),
  btnBackToBoard: $("btnBackToBoard"),

  resultsView: $("resultsView"),
  resultsSummary: $("resultsSummary"),
  feed: $("feed"),

  fileInput: $("fileInput"),
  importStatus: $("importStatus"),

  // System TTS
  ttsToggle: $("ttsToggle"),
  voiceSelect: $("voiceSelect"),

  // Timing
  buzzWindowSec: $("buzzWindowSec"),
  blankMs: $("blankMs"),

  // OpenAI TTS (added in index.html)
  openaiTtsToggle: $("openaiTtsToggle"),
  openaiApiKey: $("openaiApiKey"),
  openaiVoiceSelect: $("openaiVoiceSelect"),
};

const VALUES = [200, 400, 600, 800, 1000];

const state = {
  bank: [],

  boardCats: [], // [{ name, cluesByValue: Map(value -> clueObj), usedValues:Set }]
  usedCount: 0,
  totalCells: 0,

  active: null, // { catIndex, value, clueObj }

  score: 0,
  outcomes: [], // { status: "correct"|"wrong"|"skipped", cat, value, clue, response }

  rafId: null,
  buzzDeadline: 0,

  selectedVoiceURI: null,
  buzzWindowMs: 5000,
  blankMs: 2000,

  // OpenAI TTS audio element (reused)
  openaiAudio: null,
};

function setStatus(msg) { ui.statusLine.textContent = msg; }
function setScore(n) { state.score = n; ui.score.textContent = String(n); }

function showView(which) {
  ui.boardView.classList.add("hidden");
  ui.clueView.classList.add("hidden");
  ui.resultsView.classList.add("hidden");
  which.classList.remove("hidden");
}

function clampNum(n, lo, hi, fallback) {
  const x = Number(n);
  if (Number.isNaN(x)) return fallback;
  return Math.max(lo, Math.min(hi, x));
}

function normalizeCategory(s) { return String(s || "UNKNOWN").trim(); }

function normalizeClueObj(x) {
  return {
    id: String(x.id || crypto.randomUUID()),
    round: String(x.round || "1").trim(),
    category: normalizeCategory(x.category),
    value: Number(x.value || 0) || 0,
    clue: String(x.clue || "").trim(),
    response: String(x.response || "").trim(),
    air_date: String(x.air_date || ""),
    source_url: String(x.source_url || ""),
    subject_tags: Array.isArray(x.subject_tags) ? x.subject_tags : [],
  };
}

/* ---------------- Import parsing ---------------- */

function parseDelimited(text, delimiter) {
  const rows = [];
  let i = 0, field = "", row = [], inQuotes = false;

  const pushField = () => { row.push(field); field = ""; };
  const pushRow = () => { rows.push(row); row = []; };

  while (i < text.length) {
    const c = text[i];

    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i += 2; continue; }
      if (c === '"') { inQuotes = false; i++; continue; }
      field += c; i++; continue;
    } else {
      if (c === '"') { inQuotes = true; i++; continue; }
      if (c === delimiter) { pushField(); i++; continue; }
      if (c === "\n") { pushField(); pushRow(); i++; continue; }
      if (c === "\r") { i++; continue; }
      field += c; i++; continue;
    }
  }

  pushField();
  pushRow();
  return rows;
}

function parseCSV(text) {
  const rows = parseDelimited(text, ",");
  const header = (rows.shift() || []).map(h => h.trim());
  const idx = Object.fromEntries(header.map((h, j) => [h, j]));
  const get = (r, name) => r[idx[name]] ?? "";

  return rows
    .filter(r => r.some(x => String(x).trim().length))
    .map(r => normalizeClueObj({
      id: get(r, "id") || crypto.randomUUID(),
      round: get(r, "round") || "1",
      category: get(r, "category") || "UNKNOWN",
      value: parseInt(String(get(r, "value") || "0").replace(/[^0-9]/g, ""), 10) || 0,
      clue: get(r, "clue") || "",
      response: get(r, "response") || "",
      subject_tags: String(get(r, "subject_tags") || "").split("|").map(s => s.trim()).filter(Boolean),
      source_url: get(r, "source_url") || ""
    }))
    .filter(x => x.clue && x.response);
}

function parseJeopardyTSV(text) {
  const rows = parseDelimited(text, "\t");
  const header = (rows.shift() || []).map(h => h.trim());
  const idx = Object.fromEntries(header.map((h, j) => [h, j]));
  const get = (r, name) => r[idx[name]] ?? "";

  return rows
    .filter(r => r.some(x => String(x).trim().length))
    .map((r, k) => {
      const roundRaw = String(get(r, "round") || "").trim();
      const valueRaw = String(get(r, "clue_value") || "0");
      const value = parseInt(valueRaw.replace(/[^0-9]/g, ""), 10) || 0;

      return normalizeClueObj({
        id: `${String(get(r, "air_date") || "nodate").trim()}_${roundRaw || "r"}_${k}`,
        round: roundRaw || "1",
        category: get(r, "category") || "UNKNOWN",
        value,
        clue: get(r, "answer") || "",
        response: get(r, "question") || "",
        air_date: get(r, "air_date") || ""
      });
    })
    .filter(x => x.clue && x.response);
}

function detectTSVByContent(text) {
  const firstLine = (text.split(/\r?\n/, 1)[0] || "");
  return firstLine.includes("\t") && (
    firstLine.includes("clue_value") ||
    firstLine.includes("air_date") ||
    firstLine.includes("answer") ||
    firstLine.includes("question")
  );
}

/* ---------------- Voice / TTS ---------------- */

let cachedVoices = [];

function loadVoices() {
  if (!("speechSynthesis" in window)) {
    ui.voiceSelect.innerHTML = `<option value="">(No speech available)</option>`;
    return;
  }
  cachedVoices = window.speechSynthesis.getVoices() || [];
  ui.voiceSelect.innerHTML = "";

  if (!cachedVoices.length) {
    ui.voiceSelect.innerHTML = `<option value="">(Voices loading…)</option>`;
    return;
  }

  const saved = localStorage.getItem("jt_voice_uri") || "";
  let found = false;

  for (const v of cachedVoices) {
    const opt = document.createElement("option");
    opt.value = v.voiceURI;
    opt.textContent = `${v.name} — ${v.lang}${v.default ? " (default)" : ""}`;
    if (v.voiceURI === saved) { opt.selected = true; found = true; }
    ui.voiceSelect.appendChild(opt);
  }

  if (!found) {
    ui.voiceSelect.value = "";
    localStorage.setItem("jt_voice_uri", "");
  }

  state.selectedVoiceURI = ui.voiceSelect.value || null;
}

function getSelectedVoice() {
  const uri = state.selectedVoiceURI;
  if (!uri) return null;
  return cachedVoices.find(v => v.voiceURI === uri) || null;
}

function estimateSpeechMs(text) {
  const words = String(text || "").trim().split(/\s+/).filter(Boolean).length;
  const ms = Math.round(words * 420); // conservative fallback
  return clampNum(ms, 1200, 15000, 6000);
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

async function waitForSpeechSynthesisToFinish(maxMs) {
  if (!("speechSynthesis" in window)) return;
  const startedAt = performance.now();
  // iOS can fire onend early or fail to fire; gate on speechSynthesis.speaking
  while (performance.now() - startedAt < maxMs) {
    if (!window.speechSynthesis.speaking) return;
    await delay(80);
  }
}

async function speakSystemAsync(text) {
  if (!ui.ttsToggle.checked) return;
  if (!("speechSynthesis" in window)) return;

  try { window.speechSynthesis.cancel(); } catch {}

  const estimated = estimateSpeechMs(text);

  await new Promise((resolve) => {
    const u = new SpeechSynthesisUtterance(text);
    const v = getSelectedVoice();
    if (v) u.voice = v;

    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };

    u.onend = finish;
    u.onerror = finish;

    // absolute fallback
    const hard = window.setTimeout(finish, estimated + 1200);

    // If onend fires, clear fallback
    const wrappedFinish = () => { window.clearTimeout(hard); finish(); };
    u.onend = wrappedFinish;
    u.onerror = wrappedFinish;

    window.speechSynthesis.speak(u);
  });

  // Extra gate to prevent early countdown starts
  await waitForSpeechSynthesisToFinish(estimated + 1500);
}

function getOpenAISettings() {
  const enabled = ui.openaiTtsToggle ? ui.openaiTtsToggle.checked : false;
  const key = ui.openaiApiKey ? (ui.openaiApiKey.value || "").trim() : "";
  const voice = ui.openaiVoiceSelect ? (ui.openaiVoiceSelect.value || "alloy") : "alloy";
  return { enabled, key, voice };
}

async function speakOpenAIAsync(text) {
  const { enabled, key, voice } = getOpenAISettings();
  if (!enabled) return false;
  if (!key) return false;

  try {
    if (!state.openaiAudio) state.openaiAudio = new Audio();

    // Use AAC for iOS friendliness (supported output formats are documented)
    const res = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini-tts",
        voice,
        input: text,
        format: "aac",
      }),
    });

    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new Error(`OpenAI TTS HTTP ${res.status}: ${t.slice(0, 200)}`);
    }

    const blob = await res.blob();
    const url = URL.createObjectURL(blob);

    // Stop any system speech
    try { window.speechSynthesis?.cancel?.(); } catch {}

    await new Promise((resolve, reject) => {
      const a = state.openaiAudio;
      a.onended = () => { resolve(); };
      a.onerror = () => { reject(new Error("Audio playback failed")); };
      a.src = url;
      a.currentTime = 0;
      a.play().then(() => {}).catch(reject);
    });

    URL.revokeObjectURL(url);
    return true;
  } catch {
    return false;
  }
}

async function speakAsync(text) {
  // Prefer OpenAI TTS when enabled; fall back to system
  const ok = await speakOpenAIAsync(text);
  if (ok) return;
  await speakSystemAsync(text);
}

/* ---------------- Board building ---------------- */

function eligibleForBoard(c) {
  const r = String(c.round || "").trim().toUpperCase();
  const isJ = (r === "1" || r === "J" || r === "JEOPARDY");
  const vOK = VALUES.includes(Number(c.value || 0));
  return isJ && vOK && c.clue && c.response;
}

function groupByCategoryAndValue(clues) {
  const map = new Map(); // cat -> Map(value -> [clues])
  for (const c of clues) {
    const cat = normalizeCategory(c.category);
    if (!map.has(cat)) map.set(cat, new Map());
    const m = map.get(cat);
    if (!m.has(c.value)) m.set(c.value, []);
    m.get(c.value).push(c);
  }
  return map;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function buildBoard() {
  const nCats = clampNum(parseInt(ui.categoriesCount.value, 10), 3, 6, 4);
  if (!state.bank.length) throw new Error("No dataset loaded. Import a TSV in Settings.");

  const eligible = state.bank.filter(eligibleForBoard);
  const grouped = groupByCategoryAndValue(eligible);

  const completeCats = [];
  for (const [cat, m] of grouped.entries()) {
    const ok = VALUES.every(v => (m.get(v) || []).length > 0);
    if (ok) completeCats.push(cat);
  }

  if (completeCats.length < nCats) {
    throw new Error(`Not enough complete categories for a ${nCats}-category board. Found ${completeCats.length}.`);
  }

  const pickedCats = shuffle(completeCats).slice(0, nCats);

  state.boardCats = pickedCats.map((catName) => {
    const valueMap = grouped.get(catName);
    const cluesByValue = new Map();
    for (const v of VALUES) {
      const options = valueMap.get(v) || [];
      const clue = options[Math.floor(Math.random() * options.length)];
      cluesByValue.set(v, clue);
    }
    return { name: catName, cluesByValue, usedValues: new Set() };
  });

  state.usedCount = 0;
  state.totalCells = nCats * VALUES.length;
  state.outcomes = [];
  state.active = null;
  setScore(0);

  renderBoard();
  showView(ui.boardView);
  setStatus("Board ready. Tap a dollar amount.");
}

function isBoardExhausted() {
  if (!state.boardCats.length) return false;
  return state.usedCount >= state.totalCells;
}

function renderBoard() {
  const n = state.boardCats.length;
  const grid = document.createElement("div");
  grid.className = "boardGrid";
  grid.style.gridTemplateColumns = `repeat(${n}, minmax(0, 1fr))`;

  for (let c = 0; c < n; c++) {
    const h = document.createElement("div");
    h.className = "boardHead";
    h.textContent = state.boardCats[c].name;
    grid.appendChild(h);
  }

  for (const value of VALUES) {
    for (let c = 0; c < n; c++) {
      const cell = document.createElement("div");
      const used = state.boardCats[c].usedValues.has(value);
      cell.className = `boardCell ${used ? "used" : ""}`;

      const btn = document.createElement("button");
      btn.className = "boardCellBtn";
      btn.textContent = `$${value}`;
      btn.disabled = used;
      btn.addEventListener("click", () => openClue(c, value));
      cell.appendChild(btn);

      grid.appendChild(cell);
    }
  }

  ui.board.innerHTML = "";
  ui.board.appendChild(grid);

  // Secondary exhaustion guard: if every cell is disabled, force results
  if (state.boardCats.length) {
    const disabled = ui.board.querySelectorAll("button.boardCellBtn