// Jeopardy Trainer (Local Demo)
// - Tap-to-buzz with a 5s timer (configurable)
// - Read clue aloud via Web Speech API (toggle)
// - On buzz: screen blanks for 2s, then reveals correct response
// - User marks Correct/Wrong: score +/- value
// - Post-round: per-category stats + “TikTok-like” vertical learning feed
// - Next round mixes weak-topic review with new categories
//
// Import support:
// - CSV (your custom schema): id,round,category,value,clue,response,subject_tags,source_url
// - TSV (jwolle1 seasons dataset schema): round, clue_value, daily_double_value, category, comments, answer, question, air_date, notes
//
// NOTE: No real Jeopardy clues included by default. Import your own datasets.

const $ = (id) => document.getElementById(id);

const ui = {
  score: $("score"),
  clueIndex: $("clueIndex"),
  clueTotal: $("clueTotal"),
  timeLeft: $("timeLeft"),
  category: $("category"),
  value: $("value"),
  roundName: $("roundName"),
  hint: $("hint"),
  clueCard: $("clueCard"),
  clueText: $("clueText"),
  blankOverlay: $("blankOverlay"),
  btnStart: $("btnStart"),
  btnSkip: $("btnSkip"),
  btnCorrect: $("btnCorrect"),
  btnWrong: $("btnWrong"),
  ttsToggle: $("ttsToggle"),
  timeLimit: $("timeLimit"),
  blankTime: $("blankTime"),

  gameView: $("gameView"),
  learnView: $("learnView"),
  summary: $("summary"),
  feed: $("feed"),
  btnNextRound: $("btnNextRound"),

  btnSettings: $("btnSettings"),
  settingsModal: $("settingsModal"),
  fileInput: $("fileInput"),
  btnLoadSample: $("btnLoadSample"),
  importStatus: $("importStatus"),
  openaiKey: $("openaiKey"),
  openaiModel: $("openaiModel"),
  aiEnable: $("aiEnable"),
  roundLen: $("roundLen"),
  reviewRatio: $("reviewRatio"),
};

const SAMPLE_BANK = [
  {
    id: "s1",
    round: "J",
    category: "MYTHOLOGY (ORIGINAL)",
    value: 200,
    clue: "In Greek myth, this messenger god is known for winged sandals and carrying a caduceus.",
    response: "Who is Hermes?",
    subject_tags: ["Mythology", "Greece"],
    source_url: ""
  },
  {
    id: "s2",
    round: "J",
    category: "SHAKESPEARE (ORIGINAL)",
    value: 400,
    clue: "‘To be, or not to be’ comes from this tragedy.",
    response: "What is Hamlet?",
    subject_tags: ["Shakespeare", "Drama"],
    source_url: ""
  },
  {
    id: "s3",
    round: "J",
    category: "U.S. GEOGRAPHY (ORIGINAL)",
    value: 600,
    clue: "This river forms much of the border between New York and Pennsylvania.",
    response: "What is the Delaware River?",
    subject_tags: ["Geography", "US"],
    source_url: ""
  },
  {
    id: "s4",
    round: "J",
    category: "WORLD CAPITALS (ORIGINAL)",
    value: 800,
    clue: "This capital city sits on the River Seine.",
    response: "What is Paris?",
    subject_tags: ["Geography", "Capitals"],
    source_url: ""
  },
  {
    id: "s5",
    round: "J",
    category: "SCIENCE BASICS (ORIGINAL)",
    value: 1000,
    clue: "This is the chemical symbol for sodium.",
    response: "What is Na?",
    subject_tags: ["Science", "Chemistry"],
    source_url: ""
  },
  {
    id: "s6",
    round: "J",
    category: "MYTHOLOGY (ORIGINAL)",
    value: 400,
    clue: "In Norse myth, this hammer belongs to Thor.",
    response: "What is Mjölnir?",
    subject_tags: ["Mythology", "Norse"],
    source_url: ""
  },
  {
    id: "s7",
    round: "J",
    category: "SHAKESPEARE (ORIGINAL)",
    value: 600,
    clue: "The lovers Romeo and Juliet are from this Italian city.",
    response: "What is Verona?",
    subject_tags: ["Shakespeare", "Italy"],
    source_url: ""
  },
  {
    id: "s8",
    round: "J",
    category: "HISTORY (ORIGINAL)",
    value: 800,
    clue: "The Magna Carta was sealed in this year (within 5 years is acceptable).",
    response: "What is 1215?",
    subject_tags: ["History", "England"],
    source_url: ""
  }
];

const state = {
  bank: [...SAMPLE_BANK],
  round: 1,
  roundQueue: [],
  current: null,
  score: 0,
  timerId: null,
  t0: 0,
  timeLimitSec: 5,
  blankMs: 2000,
  phase: "idle", // idle | showing | buzzed | revealed
  stats: {
    // category -> {correct, wrong, total, tags:Set}
  },
  answeredThisRound: 0,
  totalThisRound: 0,
  lastWeakTopics: [],
};

function normalizeCategory(s) {
  return (s || "UNKNOWN").trim();
}

function speak(text) {
  if (!ui.ttsToggle?.checked) return;
  if (!("speechSynthesis" in window)) return;

  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 1.0;
  u.pitch = 1.0;
  u.volume = 1.0;
  window.speechSynthesis.speak(u);
}

function fmtPct(n) {
  return `${Math.round(n * 100)}%`;
}

function setPhase(phase) {
  state.phase = phase;

  if (phase === "idle") {
    ui.btnSkip.disabled = true;
    ui.btnCorrect.disabled = true;
    ui.btnWrong.disabled = true;
    ui.hint.textContent = "Press “Start Round”";
  }
  if (phase === "showing") {
    ui.btnSkip.disabled = false;
    ui.btnCorrect.disabled = true;
    ui.btnWrong.disabled = true;
    ui.hint.textContent = "Tap anywhere to buzz when you know it";
  }
  if (phase === "buzzed") {
    ui.btnSkip.disabled = true;
    ui.btnCorrect.disabled = true;
    ui.btnWrong.disabled = true;
    ui.hint.textContent = "Answer silently (blank screen)";
  }
  if (phase === "revealed") {
    ui.btnSkip.disabled = true;
    ui.btnCorrect.disabled = false;
    ui.btnWrong.disabled = false;
    ui.hint.textContent = "Mark correct / wrong";
  }
}

function stopTimer() {
  if (state.timerId) {
    cancelAnimationFrame(state.timerId);
    state.timerId = null;
  }
}

function startTimer() {
  stopTimer();
  state.t0 = performance.now();

  const tick = () => {
    const elapsed = (performance.now() - state.t0) / 1000;
    const left = Math.max(0, state.timeLimitSec - elapsed);
    ui.timeLeft.textContent = left.toFixed(1);

    if (left <= 0 && state.phase === "showing") {
      // Time's up: reveal without buzz
      revealAnswer(false);
      return;
    }
    state.timerId = requestAnimationFrame(tick);
  };

  state.timerId = requestAnimationFrame(tick);
}

function updateHeaderForClue(clue) {
  ui.category.textContent = normalizeCategory(clue.category);
  ui.value.textContent = `$${clue.value}`;
  ui.roundName.textContent = `Round ${state.round}`;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function clampInt(n, lo, hi) {
  if (Number.isNaN(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

function clampNum(n, lo, hi) {
  if (Number.isNaN(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

function pickRoundQueue() {
  const roundLen = clampInt(parseInt(ui.roundLen.value, 10), 5, 60);
  const reviewRatio = clampNum(parseFloat(ui.reviewRatio.value), 0, 1);
  const reviewCount = Math.round(roundLen * reviewRatio);
  const newCount = roundLen - reviewCount;

  const weakTopics = [...state.lastWeakTopics]; // categories
  const bank = state.bank;

  const fromWeak = shuffle(
    bank.filter(c => weakTopics.includes(normalizeCategory(c.category)))
  ).slice(0, reviewCount);

  const fromNew = shuffle(
    bank.filter(c => !weakTopics.includes(normalizeCategory(c.category)))
  ).slice(0, newCount);

  const combined = shuffle([...fromWeak, ...fromNew]).slice(0, roundLen);

  return combined.length ? combined : shuffle(bank).slice(0, roundLen);
}

function resetRoundStats() {
  state.stats = {};
  state.answeredThisRound = 0;
  state.totalThisRound = state.roundQueue.length;
}

function ensureCat(cat, tagsArr) {
  const k = normalizeCategory(cat);
  if (!state.stats[k]) {
    state.stats[k] = { correct: 0, wrong: 0, total: 0, tags: new Set() };
  }
  (tagsArr || []).forEach(t => state.stats[k].tags.add(t));
  return state.stats[k];
}

function setScore(n) {
  state.score = n;
  ui.score.textContent = String(n);
}

function showClue(i) {
  const clue = state.roundQueue[i];
  state.current = { ...clue, idx: i };

  ui.clueIndex.textContent = String(i + 1);
  ui.clueTotal.textContent = String(state.roundQueue.length);
  updateHeaderForClue(clue);

  ui.blankOverlay.classList.add("hidden");
  ui.clueText.textContent = clue.clue;

  setPhase("showing");
  speak(`${normalizeCategory(clue.category)}. For ${clue.value}. ${clue.clue}`);
  startTimer();
}

function revealAnswer(_wasBuzzed) {
  stopTimer();
  setPhase("buzzed");
  ui.blankOverlay.classList.remove("hidden");

  const blankMs = state.blankMs;
  window.setTimeout(() => {
    ui.blankOverlay.classList.add("hidden");
    ui.clueText.textContent = state.current.response;
    setPhase("revealed");
    speak(`Correct response: ${state.current.response}`);
  }, blankMs);
}

function markResult(isCorrect) {
  const clue = state.current;
  if (!clue) return;

  const catKey = normalizeCategory(clue.category);
  const s = ensureCat(catKey, clue.subject_tags);

  s.total += 1;
  if (isCorrect) s.correct += 1;
  else s.wrong += 1;

  const delta = isCorrect ? clue.value : -clue.value;
  setScore(state.score + delta);

  state.answeredThisRound += 1;

  const nextIdx = clue.idx + 1;
  if (nextIdx >= state.roundQueue.length) {
    endRound();
  } else {
    showClue(nextIdx);
  }
}

function skipClue() {
  stopTimer();

  // Neutral skip (counts as seen, not scored). Switch to markResult(false) for strictness.
  const clue = state.current;
  const catKey = normalizeCategory(clue.category);
  const s = ensureCat(catKey, clue.subject_tags);
  s.total += 1;

  state.answeredThisRound += 1;

  const nextIdx = clue.idx + 1;
  if (nextIdx >= state.roundQueue.length) {
    endRound();
  } else {
    showClue(nextIdx);
  }
}

function endRound() {
  stopTimer();
  renderSummaryAndFeed();
  ui.gameView.classList.add("hidden");
  ui.learnView.classList.remove("hidden");

  ui.btnStart.disabled = false;
  ui.btnStart.textContent = "Start Round";
}

function categoryPerformanceRows() {
  const rows = Object.entries(state.stats).map(([cat, v]) => {
    const attempted = v.total || 0;
    const correct = v.correct || 0;
    const pct = attempted ? correct / attempted : 0;
    return { cat, attempted, correct, wrong: v.wrong || 0, pct, tags: [...v.tags] };
  });

  const filtered = rows.filter(r => r.attempted > 0);
  filtered.sort((a, b) => a.pct - b.pct); // weakest first
  return filtered;
}

function pickWeakTopics(rows) {
  const candidates = rows.filter(r => r.attempted >= 2);
  const base = candidates.length ? candidates : rows;
  return base.slice(0, Math.min(4, base.length)).map(r => r.cat);
}

function renderSummaryAndFeed() {
  const rows = categoryPerformanceRows();
  const weakCats = pickWeakTopics(rows);
  state.lastWeakTopics = weakCats;

  const totalAttempted = rows.reduce((a, r) => a + r.attempted, 0);
  const totalCorrect = rows.reduce((a, r) => a + r.correct, 0);
  const overallPct = totalAttempted ? totalCorrect / totalAttempted : 0;

  ui.summary.innerHTML = `
    <div class="summaryGrid">
      <div class="sumCard">
        <div class="sumTitle">Overall</div>
        <div class="sumMeta">${fmtPct(overallPct)} • ${totalCorrect}/${totalAttempted} correct • Score ${state.score}</div>
      </div>
      ${rows.slice(0, 6).map(r => `
        <div class="sumCard">
          <div class="sumTitle">${escapeHtml(r.cat)}</div>
          <div class="sumMeta">${fmtPct(r.pct)} • ${r.correct}/${r.attempted} correct</div>
        </div>
      `).join("")}
    </div>
  `;

  buildFeed(weakCats, rows).catch(err => {
    ui.feed.innerHTML = `<div class="cardSlide"><div class="slideTitle">Feed build failed</div><div class="slideBody">${escapeHtml(String(err))}</div></div>`;
  });
}

async function buildFeed(weakCats, rows) {
  ui.feed.innerHTML = "";

  const statsByCat = new Map(rows.map(r => [r.cat, r]));
  const useAI = ui.aiEnable.value === "1" && ui.openaiKey.value.trim().length > 0;

  for (const cat of weakCats) {
    const r = statsByCat.get(cat);
    const tags = (r?.tags || []).slice(0, 6);

    let lesson;
    if (useAI) {
      lesson = await aiLesson(cat, tags);
    } else {
      lesson = templateLesson(cat, tags);
    }

    ui.feed.appendChild(renderLessonCard({
      category: cat,
      subtitle: r ? `${fmtPct(r.pct)} • ${r.correct}/${r.attempted} correct` : "",
      lesson
    }));
  }

  ui.feed.appendChild(renderLessonCard({
    category: "Review Loop",
    subtitle: "How the next round is built",
    lesson: {
      title: "Next round = weak-topic review + new categories",
      body: "You’ll see a mix: some clues from your weakest categories (to force retrieval), plus new categories to expand breadth.",
      keyPoints: [
        { h: "Retrieval first", p: "Try to answer before looking. Fast recall matters." },
        { h: "Write miss reasons", p: "Name the failure mode: didn’t know, knew but slow, mixed two facts, misread clue." },
        { h: "One tiny drill", p: "After 5 minutes, do 3 self-made flash prompts from the weak topic." },
      ],
      links: [
        { label: "J-Archive (clue source)", href: "https://j-archive.com" },
      ],
    }
  }));
}

function renderLessonCard({ category, subtitle, lesson }) {
  const slide = document.createElement("div");
  slide.className = "cardSlide";
  slide.innerHTML = `
    <div class="slideTop">
      <div>
        <div class="slideTitle">${escapeHtml(lesson.title || category)}</div>
        <div class="topicPill">${escapeHtml(category)}${subtitle ? " • " + escapeHtml(subtitle) : ""}</div>
      </div>
      <div class="topicPill">~1–2 min</div>
    </div>

    <div class="slideBody">${escapeHtml(lesson.body || "")}</div>

    <div class="kb">
      ${(lesson.keyPoints || []).map(k => `
        <div class="kbItem">
          <h4>${escapeHtml(k.h)}</h4>
          <p>${escapeHtml(k.p)}</p>
        </div>
      `).join("")}
    </div>

    <div class="slideFooter">
      ${(lesson.links || []).map(l => `
        <a class="link" target="_blank" rel="noreferrer" href="${escapeAttr(l.href)}">${escapeHtml(l.label)}</a>
      `).join("")}
    </div>
  `;
  return slide;
}

function templateLesson(category, tags) {
  return {
    title: `${category}: micro-review`,
    body: "Goal: rebuild fast retrieval. Focus on 6 anchor facts, 3 common clue patterns, and 3 likely confusions.",
    keyPoints: [
      { h: "6 anchors", p: buildAnchors(category, tags).join(" • ") },
      { h: "Clue patterns", p: buildPatterns(category).join(" • ") },
      { h: "Common traps", p: buildTraps(category).join(" • ") },
      { h: "30-second drill", p: "Say the answer first, then justify in one sentence. Repeat 5 times." },
    ],
    links: buildLinks(category),
  };
}

function buildAnchors(category, _tags) {
  const c = category.toLowerCase();
  if (c.includes("myth")) return [
    "Greek/Roman name pairs",
    "Major Olympians + symbols",
    "Hero journeys (Odysseus, Heracles)",
    "Norse: Odin/Thor/Loki roles",
    "Egyptian: Ra/Osiris/Isis",
    "Myth creatures: sirens, cyclopes, hydra"
  ];
  if (c.includes("shakes")) return [
    "Major tragedies vs comedies",
    "Key quotes → play mapping",
    "Settings (Verona, Denmark, Scotland)",
    "Common characters (Iago, Falstaff)",
    "Plot cores (revenge, jealousy)",
    "Last lines / famous soliloquies"
  ];
  if (c.includes("capital")) return [
    "Continent clusters",
    "Tricky pairs (Sydney≠capital)",
    "River capitals (Seine, Thames)",
    "Former names (Burma/Myanmar)",
    "Language cues in clues",
    "Map mental snapshots"
  ];
  return [
    "Define the domain",
    "List the top 10 items",
    "Name 5 time periods",
    "3 key people",
    "3 key places",
    "3 signature terms"
  ];
}

function buildPatterns(category) {
  const c = category.toLowerCase();
  if (c.includes("myth")) return [
    "‘This god/goddess of…’",
    "‘Slain by…’ / ‘labors of…’",
    "Symbol/attribute identification"
  ];
  if (c.includes("shakes")) return [
    "Quote → play",
    "Character → role",
    "Setting → play"
  ];
  if (c.includes("geo") || c.includes("capital")) return [
    "River/mountain borders",
    "Former capital / renamed cities",
    "‘Largest/longest’ superlatives"
  ];
  return [
    "Etymology clue",
    "Before/after pattern",
    "Category title is a rule"
  ];
}

function buildTraps(category) {
  const c = category.toLowerCase();
  if (c.includes("myth")) return [
    "Greek vs Roman names",
    "Similar-sounding heroes",
    "Mixing Norse and Greek"
  ];
  if (c.includes("shakes")) return [
    "Confusing tragedies",
    "Misattributing quotes",
    "Mixing character names"
  ];
  if (c.includes("capital")) return [
    "Largest city ≠ capital",
    "Old vs new names",
    "Same-name cities"
  ];
  return [
    "Overthinking category constraints",
    "Not converting clue wording to target type",
    "Confusing near-neighbors"
  ];
}

function buildLinks(category) {
  const q = encodeURIComponent(category.replace(/\(ORIGINAL\)/g, "").trim());
  return [
    { label: "Wikipedia quick scan", href: `https://en.wikipedia.org/wiki/Special:Search?search=${q}` },
    { label: "YouTube quick explainer", href: `https://www.youtube.com/results?search_query=${q}+explained` },
  ];
}

async function aiLesson(category, tags) {
  const key = ui.openaiKey.value.trim();
  const model = ui.openaiModel.value.trim() || "gpt-4.1-mini";

  const prompt = `
You are generating a 1–2 minute micro-lesson card for Jeopardy training.
Topic category: ${category}
Optional tags: ${tags.join(", ")}

Return STRICT JSON:
{
  "title": "short punchy title",
  "body": "80-140 words, dense, high-yield, retrieval-focused",
  "keyPoints": [{"h":"...","p":"..."},{"h":"...","p":"..."},{"h":"...","p":"..."}],
  "links": [{"label":"...","href":"https://..."}]
}

Constraints:
- No fluff. Facts + retrieval prompts.
- Include 1 quick drill prompt.
- Links: Wikipedia search + YouTube search (use query URLs).
`;

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${key}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: "You output strict JSON only." },
        { role: "user", content: prompt }
      ],
      temperature: 0.3,
    })
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`OpenAI error ${res.status}: ${t.slice(0, 400)}`);
  }

  const data = await res.json();
  const txt = data?.choices?.[0]?.message?.content || "{}";
  return JSON.parse(txt);
}

/* ---------- Import parsers ---------- */

function parseDelimited(text, delimiter) {
  // CSV/TSV-style parser with quotes and escaped quotes ("")
  const rows = [];
  let i = 0, field = "", row = [], inQuotes = false;

  const pushField = () => { row.push(field); field = ""; };
  const pushRow = () => { if (row.length) rows.push(row); row = []; };

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
  // Expected columns: id,round,category,value,clue,response,subject_tags,source_url
  const rows = parseDelimited(text, ",");
  const header = (rows.shift() || []).map(h => h.trim());
  const idx = Object.fromEntries(header.map((h, j) => [h, j]));

  const get = (r, name) => r[idx[name]] ?? "";

  const out = rows
    .filter(r => r.some(x => String(x).trim().length))
    .map(r => ({
      id: String(get(r, "id") || crypto.randomUUID()),
      round: String(get(r, "round") || "J"),
      category: String(get(r, "category") || "UNKNOWN"),
      value: parseInt(get(r, "value") || "0", 10) || 0,
      clue: String(get(r, "clue") || ""),
      response: String(get(r, "response") || ""),
      subject_tags: String(get(r, "subject_tags") || "")
        .split("|").map(s => s.trim()).filter(Boolean),
      source_url: String(get(r, "source_url") || ""),
    }))
    .filter(x => x.clue && x.response && x.value > 0);

  return out;
}

function parseJeopardyTSV(text) {
  // jwolle1 dataset columns typically include:
  // round, clue_value, daily_double_value, category, comments, answer, question, air_date, notes
  const rows = parseDelimited(text, "\t");
  const header = (rows.shift() || []).map(h => h.trim());
  const idx = Object.fromEntries(header.map((h, j) => [h, j]));

  const get = (r, name) => r[idx[name]] ?? "";

  const roundMap = { "1": "J", "2": "DJ", "3": "FJ" };

  return rows
    .filter(r => r.some(x => String(x).trim().length))
    .map((r, k) => {
      const air = String(get(r, "air_date") || "").trim();
      const roundRaw = String(get(r, "round") || "").trim();
      const cat = String(get(r, "category") || "UNKNOWN").trim();

      const clueValRaw = String(get(r, "clue_value") || "0");
      const clueVal = parseInt(clueValRaw.replace(/[^0-9]/g, ""), 10) || 0;

      // Dataset naming is historically "answer" = clue prompt, "question" = correct response
      const cluePrompt = String(get(r, "answer") || "").trim();
      const correctResp = String(get(r, "question") || "").trim();

      return {
        id: `${air || "nodate"}_${roundRaw || "r"}_${k}`,
        round: roundMap[roundRaw] || roundRaw || "J",
        category: cat,
        value: clueVal,      // Final often 0; kept as 0
        clue: cluePrompt,
        response: correctResp,
        subject_tags: [],
        source_url: ""
      };
    })
    .filter(x => x.clue && x.response); // allow value 0
}

/* ---------- Escaping helpers ---------- */

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttr(s) {
  return String(s).replaceAll('"', "%22");
}

/* ---------- Events ---------- */

ui.btnSettings.addEventListener("click", () => ui.settingsModal.showModal());

ui.btnLoadSample.addEventListener("click", () => {
  state.bank = [...SAMPLE_BANK];
  ui.importStatus.textContent = `Loaded built-in sample: ${state.bank.length} clues`;
});

ui.fileInput.addEventListener("change", async (e) => {
  const f = e.target.files?.[0];
  if (!f) return;
  const text = await f.text();

  try {
    let cleaned;
    const name = f.name.toLowerCase();

    if (name.endsWith(".json")) {
      const bank = JSON.parse(text);
      if (!Array.isArray(bank)) throw new Error("JSON must be an array");
      cleaned = bank.map(x => ({
        id: String(x.id || crypto.randomUUID()),
        round: String(x.round || "J"),
        category: String(x.category || "UNKNOWN"),
        value: parseInt(x.value || 0, 10) || 0,
        clue: String(x.clue || ""),
        response: String(x.response || ""),
        subject_tags: Array.isArray(x.subject_tags) ? x.subject_tags : String(x.subject_tags || "").split("|").map(s => s.trim()).filter(Boolean),
        source_url: String(x.source_url || ""),
      })).filter(x => x.clue && x.response);
    } else if (name.endsWith(".tsv")) {
      cleaned = parseJeopardyTSV(text);
    } else {
      cleaned = parseCSV(text);
    }

    if (cleaned.length < 10) throw new Error("Need at least 10 valid clues.");
    state.bank = cleaned;
    ui.importStatus.textContent = `Imported: ${cleaned.length} clues`;
  } catch (err) {
    ui.importStatus.textContent = `Import failed: ${String(err)}`;
  } finally {
    ui.fileInput.value = "";
  }
});

ui.timeLimit.addEventListener("change", () => {
  state.timeLimitSec = parseFloat(ui.timeLimit.value) || 5;
});

ui.blankTime.addEventListener("change", () => {
  state.blankMs = parseInt(ui.blankTime.value, 10) || 2000;
});

ui.btnStart.addEventListener("click", () => startRound());

ui.btnSkip.addEventListener("click", () => {
  if (state.phase !== "showing") return;
  skipClue();
});

ui.btnCorrect.addEventListener("click", () => {
  if (state.phase !== "revealed") return;
  markResult(true);
});

ui.btnWrong.addEventListener("click", () => {
  if (state.phase !== "revealed") return;
  markResult(false);
});

ui.clueCard.addEventListener("click", () => {
  if (state.phase !== "showing") return;
  revealAnswer(true);
});

ui.clueCard.addEventListener("keydown", (e) => {
  if (e.key === " " || e.key === "Enter") {
    e.preventDefault();
    if (state.phase === "showing") revealAnswer(true);
  }
});

ui.btnNextRound.addEventListener("click", () => {
  ui.learnView.classList.add("hidden");
  ui.gameView.classList.remove("hidden");
  startRound();
});

function startRound() {
  state.timeLimitSec = parseFloat(ui.timeLimit.value) || 5;
  state.blankMs = parseInt(ui.blankTime.value, 10) || 2000;

  state.roundQueue = pickRoundQueue();
  resetRoundStats();

  ui.clueTotal.textContent = String(state.roundQueue.length);
  ui.clueIndex.textContent = "0";
  ui.timeLeft.textContent = state.timeLimitSec.toFixed(1);

  ui.btnStart.disabled = true;
  ui.btnStart.textContent = "Round Running";

  showClue(0);
}

/* ---------- Init ---------- */

setPhase("idle");
setScore(0);
ui.importStatus.textContent = `Loaded built-in sample: ${state.bank.length} clues`;