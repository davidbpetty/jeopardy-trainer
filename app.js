/* Jeopardy Trainer — Board Mode
   - Full board: N categories x 5 values
   - Random category picked from TSV; one random clue per value in that category
   - Countdown starts ONLY after TTS finishes reading clue
   - Buzz within window => blank screen => reveal => Got it / Missed (score +/- value)
   - No buzz => reveal => Back to board (no score change)
   - Used clues removed from board
   - End => stats + missed/skipped review cards

   Import:
   - TSV jwolle1: round, clue_value, daily_double_value, category, comments, answer, question, air_date, notes
   - CSV custom: id,round,category,value,clue,response,subject_tags,source_url
   - JSON array: id,round,category,value,clue,response,subject_tags,source_url
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

  ttsToggle: $("ttsToggle"),
  voiceSelect: $("voiceSelect"),
  buzzWindowSec: $("buzzWindowSec"),
  blankMs: $("blankMs"),
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
  const ms = Math.round(words * 400); // ~150 wpm fallback
  return clampNum(ms, 1200, 12000, 5000);
}

function speakAsync(text) {
  if (!ui.ttsToggle.checked) return Promise.resolve();
  if (!("speechSynthesis" in window)) return Promise.resolve();

  try { window.speechSynthesis.cancel(); } catch {}

  return new Promise((resolve) => {
    const u = new SpeechSynthesisUtterance(text);
    const v = getSelectedVoice();
    if (v) u.voice = v;

    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };

    u.onend = finish;
    u.onerror = finish;

    const fallback = window.setTimeout(finish, estimateSpeechMs(text) + 500);

    const wrap = () => { window.clearTimeout(fallback); finish(); };
    u.onend = wrap;
    u.onerror = wrap;

    window.speechSynthesis.speak(u);
  });
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
  setScore(0);

  renderBoard();
  showView(ui.boardView);
  setStatus("Board ready. Tap a dollar amount.");
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
}

function markCellUsed(catIndex, value) {
  const cat = state.boardCats[catIndex];
  if (!cat.usedValues.has(value)) {
    cat.usedValues.add(value);
    state.usedCount += 1;
  }
  renderBoard();
  if (state.usedCount >= state.totalCells) endBoard();
}

/* ---------------- Clue flow ---------------- */

function cancelRAF() {
  if (state.rafId) { cancelAnimationFrame(state.rafId); state.rafId = null; }
}

function resetClueUI() {
  cancelRAF();
  ui.progressFill.style.width = "0%";
  ui.progressWrap.classList.add("hidden");
  ui.btnBuzz.classList.add("hidden");
  ui.blankScreen.classList.add("hidden");
  ui.resultActions.classList.add("hidden");
  ui.noBuzzActions.classList.add("hidden");
}

function openClue(catIndex, value) {
  const cat = state.boardCats[catIndex];
  const clueObj = cat.cluesByValue.get(value);

  state.active = { catIndex, value, clueObj };

  ui.clueCategory.textContent = cat.name;
  ui.clueValue.textContent = `$${value}`;
  ui.clueText.textContent = clueObj.clue;

  resetClueUI();
  showView(ui.clueView);

  runClueFlow(clueObj).catch(err => {
    ui.clueText.textContent = `Error: ${String(err)}`;
    ui.noBuzzActions.classList.remove("hidden");
  });
}

async function runClueFlow(clueObj) {
  // Bug fix #1: countdown starts only after reading ends
  await speakAsync(`${normalizeCategory(clueObj.category)}. For ${clueObj.value}. ${clueObj.clue}`);
  startBuzzWindow();
}

function startBuzzWindow() {
  resetClueUI();

  const ms = state.buzzWindowMs;
  const start = performance.now();
  state.buzzDeadline = start + ms;

  ui.progressWrap.classList.remove("hidden");
  ui.btnBuzz.classList.remove("hidden");
  ui.progressLabel.textContent = `Buzz window: ${(ms / 1000).toFixed(1)}s`;

  let buzzed = false;

  const onBuzz = () => {
    if (buzzed) return;
    buzzed = true;
    ui.btnBuzz.disabled = true;
    cancelRAF();
    ui.progressFill.style.width = "100%";
    handleBuzz();
  };

  ui.btnBuzz.disabled = false;
  ui.btnBuzz.onclick = onBuzz;

  const tick = () => {
    const now = performance.now();
    const left = Math.max(0, state.buzzDeadline - now);
    const pct = Math.min(1, (now - start) / ms);
    ui.progressFill.style.width = `${Math.round(pct * 100)}%`;

    if (left <= 0) {
      ui.btnBuzz.disabled = true;
      ui.btnBuzz.classList.add("hidden");
      revealNoBuzz();
      return;
    }
    state.rafId = requestAnimationFrame(tick);
  };

  state.rafId = requestAnimationFrame(tick);
}

function revealNoBuzz() {
  const { catIndex, value, clueObj } = state.active;

  ui.clueText.textContent = clueObj.response;

  state.outcomes.push({
    status: "skipped",
    cat: state.boardCats[catIndex].name,
    value,
    clue: clueObj.clue,
    response: clueObj.response
  });

  ui.noBuzzActions.classList.remove("hidden");
  ui.btnBackToBoard.onclick = () => {
    markCellUsed(catIndex, value);
    showView(ui.boardView);
    setStatus("Tap the next dollar amount.");
  };
}

function handleBuzz() {
  const { clueObj } = state.active;

  ui.blankScreen.classList.remove("hidden");
  ui.progressWrap.classList.add("hidden");
  ui.btnBuzz.classList.add("hidden");

  window.setTimeout(() => {
    ui.blankScreen.classList.add("hidden");
    ui.clueText.textContent = clueObj.response;
    ui.resultActions.classList.remove("hidden");

    ui.btnGotIt.onclick = () => finalizeBuzzResult(true);
    ui.btnMissed.onclick = () => finalizeBuzzResult(false);
  }, state.blankMs);
}

function finalizeBuzzResult(gotIt) {
  const { catIndex, value, clueObj } = state.active;

  if (gotIt) setScore(state.score + value);
  else setScore(state.score - value);

  state.outcomes.push({
    status: gotIt ? "correct" : "wrong",
    cat: state.boardCats[catIndex].name,
    value,
    clue: clueObj.clue,
    response: clueObj.response
  });

  markCellUsed(catIndex, value);
  showView(ui.boardView);
  setStatus("Tap the next dollar amount.");
}

/* ---------------- Results + learning cards ---------------- */

function endBoard() {
  showView(ui.resultsView);
  renderResults();
}

function pct(n, d) { return d ? `${Math.round((n / d) * 100)}%` : "0%"; }

function renderResults() {
  const total = state.totalCells;
  const buzzed = state.outcomes.filter(o => o.status === "correct" || o.status === "wrong").length;
  const correct = state.outcomes.filter(o => o.status === "correct").length;
  const wrong = state.outcomes.filter(o => o.status === "wrong").length;
  const skipped = state.outcomes.filter(o => o.status === "skipped").length;

  const byCat = new Map();
  for (const o of state.outcomes) {
    if (!byCat.has(o.cat)) byCat.set(o.cat, { correct: 0, wrong: 0, skipped: 0, total: 0 });
    const s = byCat.get(o.cat);
    s.total += 1;
    if (o.status === "correct") s.correct += 1;
    if (o.status === "wrong") s.wrong += 1;
    if (o.status === "skipped") s.skipped += 1;
  }

  const catCards = [...byCat.entries()].map(([cat, s]) => {
    const attempted = s.correct + s.wrong;
    const acc = attempted ? (s.correct / attempted) : 0;
    return { cat, ...s, attempted, acc };
  }).sort((a, b) => a.acc - b.acc);

  ui.resultsSummary.innerHTML = `
    <div class="sumGrid">
      <div class="sumCard">
        <div class="sumTitle">Score</div>
        <div class="sumMeta">${state.score}</div>
      </div>
      <div class="sumCard">
        <div class="sumTitle">Attempted (buzzed)</div>
        <div class="sumMeta">${buzzed}/${total} • Accuracy ${pct(correct, buzzed)}</div>
      </div>
      <div class="sumCard">
        <div class="sumTitle">Correct / Wrong</div>
        <div class="sumMeta">${correct} correct • ${wrong} wrong</div>
      </div>
      <div class="sumCard">
        <div class="sumTitle">Skipped</div>
        <div class="sumMeta">${skipped} revealed, no buzz</div>
      </div>
      ${catCards.slice(0, 6).map(c => `
        <div class="sumCard">
          <div class="sumTitle">${escapeHtml(c.cat)}</div>
          <div class="sumMeta">
            Accuracy ${pct(c.correct, c.attempted)} • Attempted ${c.attempted} • Skipped ${c.skipped}
          </div>
        </div>
      `).join("")}
    </div>
  `;

  const review = state.outcomes.filter(o => o.status === "wrong" || o.status === "skipped");
  ui.feed.innerHTML = "";
  for (const item of review) ui.feed.appendChild(renderReviewCard(item));
}

function renderReviewCard(item) {
  const div = document.createElement("div");
  div.className = "feedCard";

  const statusLabel = item.status === "wrong" ? "MISSED" : "SKIPPED";
  const query = encodeURIComponent(`${item.response} ${item.cat}`);
  const wiki = `https://en.wikipedia.org/wiki/Special:Search?search=${query}`;
  const yt = `https://www.youtube.com/results?search_query=${query}`;

  div.innerHTML = `
    <div class="feedCardTitle">${escapeHtml(item.cat)} • $${item.value} • ${statusLabel}</div>
    <div class="feedCardSub">Clue → Correct response</div>
    <div class="feedBody">
      <div><strong>Clue:</strong> ${escapeHtml(item.clue)}</div>
      <div style="margin-top:8px;"><strong>Correct:</strong> ${escapeHtml(item.response)}</div>
      <div style="margin-top:10px;">${escapeHtml(buildExplanation(item))}</div>
      <div style="margin-top:10px;"><strong>Drill:</strong> Say the response first, then justify it in one sentence. Repeat 3 times.</div>
    </div>
    <div class="feedLinks">
      <a class="link" href="${wiki}" target="_blank" rel="noreferrer">Wikipedia</a>
      <a class="link" href="${yt}" target="_blank" rel="noreferrer">YouTube</a>
    </div>
  `;
  return div;
}

function buildExplanation(item) {
  const resp = item.response.replace(/^(who|what)\s+is\s+/i, "").replace(/\?$/, "");
  return `Anchor: ${resp}. Translate the clue into a one-line definition, then retrieve the proper noun. If you hesitated, you lacked an immediate anchor—fix by drilling 5 fast prompts using the response as the starting cue.`;
}

/* ---------------- Escaping ---------------- */

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

/* ---------------- UI wiring ---------------- */

function applySettingsFromUI() {
  state.buzzWindowMs = Math.round(clampNum(ui.buzzWindowSec.value, 1, 15, 5) * 1000);
  state.blankMs = Math.round(clampNum(ui.blankMs.value, 250, 5000, 2000));
}

ui.btnSettings.addEventListener("click", () => ui.settingsModal.showModal());

ui.voiceSelect.addEventListener("change", () => {
  state.selectedVoiceURI = ui.voiceSelect.value || null;
  localStorage.setItem("jt_voice_uri", ui.voiceSelect.value || "");
});

ui.buzzWindowSec.addEventListener("change", applySettingsFromUI);
ui.blankMs.addEventListener("change", applySettingsFromUI);

ui.btnNewBoard.addEventListener("click", () => {
  applySettingsFromUI();
  try { buildBoard(); } catch (e) { setStatus(String(e)); }
});

ui.btnNewBoard2.addEventListener("click", () => {
  applySettingsFromUI();
  try { buildBoard(); } catch (e) { setStatus(String(e)); showView(ui.boardView); }
});

ui.btnBackToBoardTop.addEventListener("click", () => {
  if (state.active) {
    const { catIndex, value } = state.active;
    markCellUsed(catIndex, value);
  }
  showView(ui.boardView);
  setStatus("Tap the next dollar amount.");
});

ui.fileInput.addEventListener("change", async (e) => {
  const f = e.target.files?.[0];
  if (!f) return;

  try {
    const text = await f.text();
    const name = (f.name || "").toLowerCase();
    const looksTSV = name.endsWith(".tsv") || detectTSVByContent(text);

    let cleaned;
    if (name.endsWith(".json")) {
      const arr = JSON.parse(text);
      if (!Array.isArray(arr)) throw new Error("JSON must be an array");
      cleaned = arr.map(normalizeClueObj).filter(x => x.clue && x.response);
    } else if (looksTSV) {
      cleaned = parseJeopardyTSV(text);
    } else {
      cleaned = parseCSV(text);
    }

    if (!cleaned.length) throw new Error("Import produced 0 clues.");

    state.bank = cleaned;
    ui.importStatus.textContent = `Imported: ${cleaned.length} clues`;
    setStatus("Dataset imported. Tap New Board.");
  } catch (err) {
    ui.importStatus.textContent = `Import failed: ${String(err)}`;
    setStatus("Import failed.");
  } finally {
    ui.fileInput.value = "";
  }
});

/* ---------------- Init ---------------- */

function init() {
  setScore(0);
  applySettingsFromUI();

  if ("speechSynthesis" in window) {
    window.speechSynthesis.onvoiceschanged = loadVoices;
  }
  loadVoices();

  setStatus("Import a TSV in Settings, then tap New Board.");
  ui.importStatus.textContent = "No import yet.";
  showView(ui.boardView);
}

init();