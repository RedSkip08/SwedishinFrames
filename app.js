const MANIFEST_PATH = "data/manifest.json";
const PREFS_KEY = "sif_prefs_v3";

/** @typedef {'relevance'|'az'} SortMode */
/** @typedef {'simple'|'color'|'annotated'} ExampleMode */

const state = {
  db: {
    frames: [],
    lus: [],
    constructions: [],

    framesById: new Map(),
    lusById: new Map(),
    constructionsById: new Map(),

    lusByFrameId: new Map(),
    constructionsByFrameId: new Map(),

    allItems: [],
  },
  ui: {
    filters: { lu: true, construction: true, frame: true },
    sort: /** @type {SortMode} */ ("relevance"),
    lastQuery: "",
    exampleMode: /** @type {ExampleMode} */ ("simple"),
    adv: { pos: "", frame: "" },
    browse: { type: "lu", letter: "A" },
  },
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function hash32(str) {
  let h = 2166136261;
  const s = String(str ?? "");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function feHue(feId) {
  // Spread hues across the wheel, stable per FE id.
  return hash32(`fe:${feId}`) % 360;
}

function feChipHtml(label, feId) {
  const h = feHue(feId);
  return `<span class="fe-chip" style="--fe-h:${h}" data-fe="${esc(feId)}">${esc(label)}</span>`;
}

function decorateFeHtml(html, feMentions) {
  const src = String(html ?? "");
  const mentions = Array.isArray(feMentions) ? feMentions : [];
  if (!src.trim() || !mentions.length) return src;

  let out = src;
  for (const m of mentions) {
    if (!m?.fe_id || !m?.span_en) continue;
    const h = feHue(m.fe_id);
    const cls = String(m.span_en).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`<span\\s+class=\\"${cls}\\"\\s*>`, "g");
    out = out.replace(re, `<span class="fe-chip" style="--fe-h:${h}" data-fe="${esc(m.fe_id)}">`);
  }
  return out;
}

function setEntryHeader(title, typeLabel, typeKey = "") {
  const h = document.getElementById("entryTitle");
  const t = document.getElementById("entryType");
  const entry = document.getElementById("entry");
  if (h) h.textContent = title || "Entry";
  if (t) {
    t.textContent = typeLabel || "";
    if (typeKey) t.setAttribute("data-type", typeKey);
    else t.removeAttribute("data-type");
  }


  if (entry) {
    if (typeKey) entry.setAttribute("data-kind", typeKey);
    else entry.removeAttribute("data-kind");
  }
}


function esc(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function setStatus(_) {

}


function loadPrefs() {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return;
    const p = JSON.parse(raw);
    if (p?.filters) state.ui.filters = { ...state.ui.filters, ...p.filters };
    if (p?.sort) state.ui.sort = p.sort;
    if (p?.exampleMode) state.ui.exampleMode = p.exampleMode;
    if (p?.adv) state.ui.adv = { ...state.ui.adv, ...p.adv };
    if (p?.browse) state.ui.browse = { ...state.ui.browse, ...p.browse };
  } catch {
   
  }
}

function savePrefs() {
  try {
    localStorage.setItem(
      PREFS_KEY,
      JSON.stringify({
        filters: state.ui.filters,
        sort: state.ui.sort,
        exampleMode: state.ui.exampleMode,
        adv: state.ui.adv,
        browse: state.ui.browse,
      })
    );
  } catch {
 
  }
}

async function fetchJson(path) {
  const res = await fetch(path, { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to load ${path}: ${res.status} ${res.statusText}`);
  return await res.json();
}

function normalizeManifestPath(p) {
  if (!p) return p;
  let s = String(p).trim();
  if (s.startsWith("./")) s = s.slice(2);
  if (s.startsWith("/")) s = s.slice(1);
  if (s.startsWith("data/")) return s;
  return `data/${s}`;
}

// Panel open/close

function isPanelOpen() {
  const p = $("#searchPanel");
  return !!p && !p.hasAttribute("hidden");
}

function openPanel(tab = "search") {
  const p = $("#searchPanel");
  if (!p) return;
  p.removeAttribute("hidden");
  document.body.style.overflow = "hidden";

  // switch tab
  const btn = $(`.tab[data-tab="${tab}"]`, p);
  if (btn) btn.click();

  const q = $("#q");
  if (q) q.focus();

  // render current view
  if (tab === "browse") {
    renderBrowse();
  } else {
    renderPanelResults(sortResults(runSearchIndex($("#q")?.value || "")));
  }
}

function closePanel() {
  const p = $("#searchPanel");
  if (!p) return;
  p.setAttribute("hidden", "");
  document.body.style.overflow = "";
}

// Normalizers

function normalizeFrame(doc, path) {
  const fr = doc?.frame;
  if (!fr?.id) throw new Error(`Frame missing frame.id in ${path}`);

  return {
    type: "frame",
    id: fr.id,
    key: `frame:${fr.id}`,
    name_en: fr.name_en ?? fr.id,
    slug: fr.slug ?? "",
    description_en: fr.frame_description_en ?? "",
    description_html: fr.frame_description_html ?? "",
    fe_mentions: fr.frame_description_fe_mentions ?? [],
    note_on_roles_en: fr.note_on_roles_en ?? "",
    elements: fr.elements ?? [],
    examples: fr.examples ?? [],
    linked_lexical_units: fr.linked_lexical_units ?? [],
    confusable_with: fr.confusable_with ?? [],

    constructions: doc?.constructions ?? [],

    _path: path,
    raw: doc,
  };
}

function normalizeLu(doc, path) {
  const lu = doc?.lexical_unit;
  if (!lu?.id) throw new Error(`LU missing lexical_unit.id in ${path}`);

  const morphSv = (lu.morphology_sv && typeof lu.morphology_sv === "object") ? lu.morphology_sv : null;
  const morphLegacy = (lu.morphology && typeof lu.morphology === "object") ? lu.morphology : null;
  const morphPreferred = morphSv ?? morphLegacy ?? {};

  return {
    type: "lu",
    id: lu.id,
    key: `lu:${lu.id}`,

    display_sv: lu.display_sv ?? lu.lemma_sv ?? lu.id,
    lemma_sv: lu.lemma_sv ?? "",
    lu_de_normalized: lu?.source_de?.lu_de_normalized ?? lu?.source_de?.lu_de_raw ?? "",
    english_equivalent_en: lu.english_equivalent_en ?? "",

  
    pronunciation: lu.pronunciation ?? {},

    pos: lu.pos ?? "",
    cefr: lu.cefr ?? "",
    multiword: !!lu.multiword,
    forms: lu.forms ?? [],
    morphology: morphPreferred,
    morphology_sv: morphSv ?? {},
    morphology_legacy: morphLegacy ?? {},

    derived_words_sv: lu.derived_words_sv ?? [],
    synonyms_sv: lu.synonyms_sv ?? [],
    antonyms_sv: lu.antonyms_sv ?? [],

    linked_frames: lu.linked_frames ?? [],
    senses: lu.senses ?? [],

    _path: path,
    raw: doc,
  };
}

function normalizeConstructionFromFrame(frame, cxn) {
  if (!cxn || typeof cxn !== "object") return null;
  const orig_cxn_id = cxn.cxn_id || cxn.id;
  if (!orig_cxn_id) return null;


  const id = `${frame.id}::${orig_cxn_id}`;

  return {
    type: "construction",
    id,
    key: `construction:${id}`,

    orig_cxn_id,

    name_user: cxn.cxn_name_user_friendly_en ?? cxn.name_user ?? cxn.name ?? orig_cxn_id,
    name_linguistic_sv: cxn.cxn_name_linguistic_sv ?? cxn.name_linguistic_sv ?? cxn.name_linguistic ?? "",

    pattern: cxn.pattern ?? "",
    meaning_en: cxn.meaning_en ?? "",
    usage_notes_en: cxn.usage_notes_en ?? [],
    frame_mapping: cxn.frame_mapping ?? [],

    frames: [{ frame_id: frame.id }],
    examples: cxn.examples ?? [],

    _frame_id: frame.id,
    raw: cxn,
  };
}

// Index building

function mapSetPush(map, key, value) {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
}

function buildIndexes() {
  state.db.framesById = new Map(state.db.frames.map((f) => [f.id, f]));
  state.db.lusById = new Map(state.db.lus.map((l) => [l.id, l]));
  state.db.constructionsById = new Map(state.db.constructions.map((c) => [c.id, c]));

  // frame -> LUs
  state.db.lusByFrameId = new Map();
  for (const lu of state.db.lus) {
    for (const lf of lu.linked_frames || []) {
      const fid = lf.frame_id ?? lf.id;
      if (!fid) continue;
      mapSetPush(state.db.lusByFrameId, fid, lu.id);
    }
  }

  // frame -> constructions
  state.db.constructionsByFrameId = new Map();
  for (const cx of state.db.constructions) {
    for (const f of cx.frames || []) {
      const fid = f.frame_id ?? f.id ?? f;
      if (!fid) continue;
      mapSetPush(state.db.constructionsByFrameId, fid, cx.id);
    }
  }

  state.db.allItems = [...state.db.lus, ...state.db.constructions, ...state.db.frames];
}

function applyPrefsToUI() {
  // chips
  for (const [k, on] of Object.entries(state.ui.filters)) {
    const btn = $(`.chip[data-filter='type'][data-value='${k}']`);
    if (btn) btn.classList.toggle("on", !!on);
  }
  $$(".chip[data-filter='sort']").forEach((b) => b.classList.toggle("on", b.dataset.value === state.ui.sort));

  const posSel = $("#filterPos");
  if (posSel) posSel.value = state.ui.adv.pos || "";
  const frameSel = $("#filterFrame");
  if (frameSel) frameSel.value = state.ui.adv.frame || "";

  $$("[data-browse-type]").forEach((b) => b.classList.toggle("on", b.getAttribute("data-browse-type") === state.ui.browse.type));
}

function populateAdvancedFilterOptions() {
  const posSel = $("#filterPos");
  const frameSel = $("#filterFrame");

  if (posSel) {
    const posVals = Array.from(new Set(state.db.lus.map((l) => String(l.pos || "")).filter(Boolean))).sort((a, b) => a.localeCompare(b));
    posSel.innerHTML = `<option value="">Any</option>` + posVals.map((p) => `<option value="${esc(p)}">${esc(p)}</option>`).join("");
    posSel.value = state.ui.adv.pos || "";
  }

  if (frameSel) {
    const frames = state.db.frames.slice().sort((a, b) => String(a.name_en || a.id).localeCompare(String(b.name_en || b.id)));
    frameSel.innerHTML = `<option value="">Any</option>` + frames
      .map((f) => `<option value="${esc(f.id)}">${esc(f.name_en || f.id)} (${esc(f.id)})</option>`)
      .join("");
    frameSel.value = state.ui.adv.frame || "";
  }
}

// Search

function currentTypeFilters() {
  return new Set(Object.entries(state.ui.filters).filter(([, on]) => on).map(([k]) => k));
}

function normExact(s) {
  return String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function findExactLu(query) {
  const q = normExact(query);
  if (!q) return null;

  const matches = [];
  for (const lu of state.db.lus) {
    const sw = normExact(lu.display_sv);
    const lem = normExact(lu.lemma_sv);
    const en = normExact(lu.english_equivalent_en);
    const de = normExact(lu.lu_de_normalized);
    const id = normExact(lu.id);

    if (q === id || (sw && q === sw) || (lem && q === lem) || (en && q === en) || (de && q === de)) {
      matches.push(lu);
    }
  }
  return matches.length === 1 ? matches[0] : null;
}

function textify(x) {
  if (x == null) return "";
  if (typeof x === "string") return x;
  if (typeof x === "number") return String(x);
  if (typeof x === "object") {
    if (x.pattern_sv) return x.pattern_sv;
    if (x.pattern) return x.pattern;
    if (x.text) return x.text;
    if (x.word_sv) return x.word_sv;
    if (x.word) return x.word;
    if (x.meaning_en) return x.meaning_en;
    try { return JSON.stringify(x); } catch { return String(x); }
  }
  return String(x);
}

function searchableText(item) {
  if (item.type === "frame") {
    return [
      item.id,
      item.name_en,
      item.slug,
      item.description_en,
      ...(item.elements || []).map((e) => e?.name || e?.id || ""),
    ].join(" ").toLowerCase();
  }

  if (item.type === "lu") {
    const senseBits = (item.senses || []).flatMap((s) => [s.meaning_en, s.how_to_use_en, ...(s.patterns || []), ...(s.common_errors_en || [])]);
    return [
      item.id,
      item.display_sv,
      item.lemma_sv,
      item.lu_de_normalized,
      item.english_equivalent_en,
      item.pos,
      item.cefr,
      ...(item.linked_frames || []).map((x) => x.frame_id || x.id || ""),
      ...senseBits,
      ...(item.synonyms_sv || []),
      ...(item.antonyms_sv || []),
      ...(item.derived_words_sv || []),
    ].filter(Boolean).join(" ").toLowerCase();
  }

  // construction
  const tips = Array.isArray(item.usage_notes_en) ? item.usage_notes_en : item.usage_notes_en ? [item.usage_notes_en] : [];
  return [item.id, item.name_user, item.name_linguistic, item.pattern, item.meaning_en, ...tips]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function scoreItem(item, tokens, rawQuery) {
  const hay = searchableText(item);
  let score = 0;

  if (item.id?.toLowerCase?.() === rawQuery) score += 200;
  if (item.key?.toLowerCase?.() === rawQuery) score += 200;

  const title = itemTitle(item).toLowerCase();
  if (title.startsWith(rawQuery)) score += 60;

  for (const t of tokens) {
    if (!t) continue;
    const idx = hay.indexOf(t);
    if (idx === -1) continue;
    score += 15;
    score += Math.max(0, 10 - Math.floor(idx / 40));
  }

  return score;
}

function applyAdvancedFilters(rows) {
  const pos = (state.ui.adv.pos || "").trim();
  const frame = (state.ui.adv.frame || "").trim();
  if (!pos && !frame) return rows;

  return rows.filter(({ item }) => {
    if (item.type === "lu") {
      if (pos && String(item.pos || "") !== pos) return false;
      if (frame) {
        const lf = item.linked_frames || [];
        const ok = lf.some((x) => (x.frame_id || x.id || x) === frame);
        if (!ok) return false;
      }
      return true;
    }

    if (item.type === "construction") {
      if (pos) return false; // POS only for LUs
      if (frame) {
        const frames = item.frames || [];
        return frames.some((f) => (f.frame_id || f.id || f) === frame);
      }
      return true;
    }

    // frames
    if (pos) return false;
    if (frame) return item.id === frame;
    return true;
  });
}

function runSearchIndex(query) {
  const q = (query || "").trim().toLowerCase();
  const types = currentTypeFilters();

  const base = state.db.allItems.filter((it) => types.has(it.type));
  if (!q) return applyAdvancedFilters(base.map((item) => ({ item, score: 0 })));

  const tokens = q.split(/\s+/).filter(Boolean);
  const rows = base
    .map((item) => ({ item, score: scoreItem(item, tokens, q) }))
    .filter((r) => r.score > 0);

  return applyAdvancedFilters(rows);
}

function sortResults(rows) {
  if (state.ui.sort === "az") {
    return rows.sort((a, b) => itemTitle(a.item).localeCompare(itemTitle(b.item), "sv"));
  }
  return rows.sort((a, b) => b.score - a.score);
}

// Results rendering

function typeLabel(type) {
  if (type === "lu") return "Lexical Units";
  if (type === "frame") return "Frames";
  return "Constructions";
}

function tagClass(type) {
  if (type === "lu") return "lu";
  if (type === "frame") return "frame";
  return "cx";
}

function itemTitle(item) {
  if (item.type === "frame") return item.name_en || item.id;
  if (item.type === "lu") return item.display_sv || item.id;
  return item.name_user || item.id;
}

function itemMeta(item) {
  if (item.type === "frame") return item.id;
  if (item.type === "lu") {
    const bits = [item.lemma_sv, item.pos, item.cefr].filter(Boolean);
    return bits.join(" · ");
  }
  return item.name_linguistic || item.pattern || "";
}

function groupResults(rows) {
  const groups = { lu: [], frame: [], construction: [] };
  for (const r of rows) groups[r.item.type].push(r);
  return groups;
}

function renderResultsInto(el, rows, { limit = 120 } = {}) {
  if (!el) return;

  if (!rows.length) {
    el.innerHTML = `<div class="small muted">No results.</div>`;
    return;
  }

  const grouped = groupResults(rows);
  const order = ["lu", "construction", "frame"].filter((t) => grouped[t].length);

  el.innerHTML = order
    .map((t) => {
      const list = grouped[t]
        .slice(0, limit)
        .map(({ item, score }) => {
          const title = itemTitle(item);
          const meta = itemMeta(item);
          return `
            <button class="result" type="button" data-key="${esc(item.key)}">
              <div>
                <div class="r-title">
                  <strong>${esc(title)}</strong>
                  ${meta ? `<span class="meta">${esc(meta)}</span>` : ""}
                </div>
                <div class="meta">${esc(typeLabel(item.type))}${state.ui.sort === "relevance" && state.ui.lastQuery ? ` · score ${score}` : ""}</div>
              </div>
              <div class="tags">
                <span class="tag ${tagClass(item.type)}">${esc(item.type)}</span>
              </div>
            </button>
          `;
        })
        .join("");

      return `
        <div class="results-group">
          <div class="small label" style="margin:8px 0 8px 2px">${esc(typeLabel(t))}</div>
          <div class="results">${list}</div>
        </div>
      `;
    })
    .join("");

  $$(".result", el).forEach((btn) => {
    btn.addEventListener("click", () => {
      const key = btn.dataset.key;
      if (!key) return;
      closePanel();
      location.hash = `#${key}`;
    });
  });
}

function renderPanelResults(rows) {
  renderResultsInto($("#results"), rows);
}

// Example rendering

function hashHue(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return h % 360;
}

function feLabel(frame, fe_id) {
  if (!frame) return fe_id;
  const el = (frame.elements || []).find((e) => e.id === fe_id);
  return el?.name || fe_id;
}

function getExampleWikiUrl(ex) {
  const src = ex?.source || ex?.provenance || {};
  return src.text_url || src.wikipedia_url || src.url || "";
}

function getExampleSourceLabel(ex) {
  const src = ex?.source || ex?.provenance || {};
  const corpus = src.corpus || "";
  if (corpus) return "Sourced by Wiki Corpus of Språkbanken Text";
  return "Sourced by Språkbanken Text";
}

function renderSentenceWithSpans(sentence, fe_tags, frame) {
  const text = String(sentence || "");
  const tags = Array.isArray(fe_tags) ? fe_tags : [];
  if (!text || !tags.length) return esc(text);

  const ordered = tags
    .map((t) => ({ ...t, span: String(t.span_sv || "") }))
    .filter((t) => t.span)
    .sort((a, b) => b.span.length - a.span.length);

  const used = [];
  for (const t of ordered) {
    const span = t.span;
    let from = 0;
    while (true) {
      const idx = text.indexOf(span, from);
      if (idx === -1) break;
      const start = idx;
      const end = idx + span.length;
      const overlaps = used.some((r) => !(end <= r.start || start >= r.end));
      if (!overlaps) {
        used.push({ start, end, fe_id: t.fe_id, span });
        break;
      }
      from = idx + 1;
    }
  }

  if (!used.length) return esc(text);
  used.sort((a, b) => a.start - b.start);

  let out = "";
  let pos = 0;
  for (const r of used) {
    out += esc(text.slice(pos, r.start));
    const label = feLabel(frame, r.fe_id);
    const hue = hashHue(r.fe_id);
    out += `<span class="fe-span" title="${esc(label)}" data-fe="${esc(r.fe_id)}" style="--fe-h:${hue}">${esc(text.slice(r.start, r.end))}</span>`;
    pos = r.end;
  }
  out += esc(text.slice(pos));
  return out;
}

function renderExample(ex, mode, frame) {
  const sv = ex?.sv || "";
  const en = ex?.en || "";
  const fe_tags = ex?.fe_tags || [];
  const url = getExampleWikiUrl(ex);
  const sourceLabel = getExampleSourceLabel(ex);
  const title = ex?.source?.text_title || ex?.source?.title || "";

  let svHtml = "";
  let annoHtml = "";

  if (mode === "simple") {
    svHtml = `<div class="ex-sv">${esc(sv)}</div>`;
  } else if (mode === "color") {
    svHtml = `<div class="ex-sv">${renderSentenceWithSpans(sv, fe_tags, frame)}</div>`;
  } else {
    svHtml = `<div class="ex-sv">${renderSentenceWithSpans(sv, fe_tags, frame)}</div>`;
    if (Array.isArray(fe_tags) && fe_tags.length) {
      const parts = fe_tags.map((t) => `${feLabel(frame, t.fe_id)}: ${t.span_sv}`).join(" · ");
      annoHtml = `<div class="anno-line">${esc(parts)}</div>`;
    }
  }

  const link = url
    ? `<a href="${esc(url)}" target="_blank" rel="noopener">Wiki Corpus</a>`
    : `<span>Wiki Corpus</span>`;

  const sourceLine = `${esc(sourceLabel).replace("Wiki Corpus", "__WIKI__")}`.replace("__WIKI__", link);

  return `
    <div class="ex">
      ${svHtml}
      ${annoHtml}
      ${en ? `<div class="ex-en">${esc(en)}</div>` : ""}
      <div class="ex-meta">
        <span class="ex-src">${sourceLine}</span>
        ${title ? `<span class="ex-title">· ${esc(title)}</span>` : ""}
      </div>
    </div>
  `;
}

function renderExampleToolbar(mode) {
  return `
    <div class="ex-toolbar">
      <div class="seg" role="tablist" aria-label="Example display mode">
        <button class="segbtn ${mode === "simple" ? "on" : ""}" type="button" data-mode="simple">Simple</button>
        <button class="segbtn ${mode === "color" ? "on" : ""}" type="button" data-mode="color">Color-coded</button>
        <button class="segbtn ${mode === "annotated" ? "on" : ""}" type="button" data-mode="annotated">Annotated</button>
      </div>
    </div>
  `;
}

function wireExampleToolbar(root, onChange) {
  $$(".segbtn", root).forEach((btn) => {
    btn.addEventListener("click", () => onChange(btn.dataset.mode));
  });
}

// Tabs (entry pages)

function renderTabs(tabs, activeId) {
  const buttons = tabs
    .map(
      (t) => `
        <button class="tab ${t.id === activeId ? "on" : ""}" type="button" data-tab="${esc(t.id)}">
          ${esc(t.label)}
        </button>`
    )
    .join("");
  return `<div class="tabs" role="tablist">${buttons}</div>`;
}

function wireTabs(root, onTab) {
  $$(".tabs .tab", root).forEach((btn) => {
    btn.addEventListener("click", () => onTab(btn.dataset.tab));
  });
}

// Entry renderers

function renderFrameHeader(frame) {

  const baseDesc = frame.description_html?.trim() ? frame.description_html : `<p>${esc(frame.description_en || "")}</p>`;
  const descHtml = decorateFeHtml(baseDesc, frame.fe_mentions);

  const elements = frame.elements || [];
  const feList = elements.length
    ? `
      <div class="section" style="margin-top:12px">
        <h4>Frame elements</h4>
        <div class="kv">
          ${elements
            .map((fe) => {
              const htmlRaw = (fe?.description_html ?? "").trim();
              const text = String(fe?.description_en ?? "").trim();
              const vRaw = htmlRaw ? htmlRaw : esc(text);
              const v = decorateFeHtml(vRaw, frame.fe_mentions);
              const label = fe.name || fe.id;
              return `<div class="k">${feChipHtml(label, fe.id || label)}</div><div class="v">${v || '<span class="muted">(no description)</span>'}</div>`;
            })
            .join("")}
        </div>
      </div>
    `
    : `<div class="section" style="margin-top:12px"><div class="small muted">No frame elements listed.</div></div>`;

  return `
    <div class="section">
      <div class="rich">${descHtml}</div>
    </div>
    ${feList}
  `;
}

function renderFrameTabsContent(frame, tabId, exampleMode) {
  if (tabId === "examples") {
    const toolbar = renderExampleToolbar(exampleMode);
    const items = (frame.examples || []).map((ex) => renderExample(ex, exampleMode, frame)).join("") || `<div class="small muted">No examples.</div>`;
    return `${toolbar}<div class="ex-list">${items}</div>`;
  }

  if (tabId === "lus") {
    const ids = state.db.lusByFrameId.get(frame.id) || [];
    if (!ids.length) return `<div class="small muted">No lexical units linked to this frame (yet).</div>`;
    const lis = ids
      .map((id) => state.db.lusById.get(id))
      .filter(Boolean)
      .map(
        (lu) => `
        <li class="li">
          <div class="left">
            <div class="name">${esc(lu.display_sv)}</div>
            <div class="desc">${esc(lu.english_equivalent_en || "")}${lu.pos ? ` · ${esc(lu.pos)}` : ""}${lu.cefr ? ` · ${esc(lu.cefr)}` : ""}</div>
          </div>
          <button class="btn" type="button" data-goto="lu:${esc(lu.id)}">Open</button>
        </li>`
      )
      .join("");
    return `<ul class="list">${lis}</ul>`;
  }

  // constructions
  const cxIds = state.db.constructionsByFrameId.get(frame.id) || [];
  if (!cxIds.length) return `<div class="small muted">No constructions linked to this frame (yet).</div>`;

  const lis = cxIds
    .map((id) => state.db.constructionsById.get(id))
    .filter(Boolean)
    .map(
      (cx) => `
      <li class="li">
        <div class="left">
          <div class="name">${esc(cx.name_user || cx.id)}</div>
          <div class="desc">${esc(cx.name_linguistic || "")}${cx.pattern ? ` · ${esc(cx.pattern)}` : ""}</div>
        </div>
        <button class="btn" type="button" data-goto="construction:${esc(cx.id)}">Open</button>
      </li>`
    )
    .join("");

  return `<ul class="list">${lis}</ul>`;
}

function renderFrame(frame) {
  setEntryHeader(frame.name_en || frame.id, "FRAME", "frame");
  const entry = $("#entry");
  if (!entry) return;

  let activeTab = "examples";
  let mode = state.ui.exampleMode;

  const tabs = [
    { id: "examples", label: "Examples" },
    { id: "lus", label: "Related lexical units" },
    { id: "cx", label: "Related constructions" },
  ];

  const render = () => {
    entry.innerHTML = `
      ${renderFrameHeader(frame)}
      ${renderTabs(tabs, activeTab)}
      <div class="section" style="margin-top:12px">
        ${renderFrameTabsContent(frame, activeTab, mode)}
      </div>
    `;

    wireTabs(entry, (nextTab) => {
      activeTab = nextTab || "examples";
      render();
    });

    if (activeTab === "examples") {
      wireExampleToolbar(entry, (nextMode) => {
        mode = /** @type {ExampleMode} */ (nextMode);
        state.ui.exampleMode = mode;
        savePrefs();
        render();
      });
    }

    $$('[data-goto]', entry).forEach((btn) => {
      btn.addEventListener("click", () => {
        const to = btn.dataset.goto;
        if (to) location.hash = `#${to}`;
      });
    });
  };

  render();
}

function renderLu(lu) {
  setEntryHeader(lu.display_sv || lu.lemma_sv || lu.id, "LEXICAL UNIT", "lu");
  const entry = $("#entry");
  if (!entry) return;

  const frameIds = (lu.linked_frames || []).map((x) => x.frame_id || x.id).filter(Boolean);
  const primaryFrame = frameIds.length ? state.db.framesById.get(frameIds[0]) : null;

  let mode = state.ui.exampleMode;

  const hasMultipleSenses = Array.isArray(lu.senses) && lu.senses.length > 1;

  function buildSenseParts(sense, idx) {
    const title = sense?.meaning_en ? String(sense.meaning_en) : `Meaning ${idx + 1}`;
    const neutralLabel = hasMultipleSenses ? `Sense ${idx + 1}` : "";

    const how = Array.isArray(sense?.how_to_use_en)
      ? sense.how_to_use_en
      : (sense?.how_to_use_en ? [sense.how_to_use_en] : []);

    const howHtml = how.length
      ? `
        <div class="lu-sub">
          <h5>How to use</h5>
          <ul class="bullets">${how.map((t) => `<li>${esc(textify(t))}</li>`).join("")}</ul>
        </div>
      `
      : "";

    const patternsArr = Array.isArray(sense?.patterns) ? sense.patterns : [];
    const patterns = patternsArr.length
      ? `<ul class="bullets">
          ${patternsArr
            .map((p) => {
              if (p && typeof p === "object") {
                const pat = p.pattern || p.pattern_sv || p.text || "";
                const note = p.note_en || p.note || "";
                return `
                  <li>
                    <div>${esc(String(pat || ""))}</div>
                    ${note ? `<div class="small muted" style="margin-top:4px"><strong>Note:</strong> ${esc(String(note))}</div>` : ""}
                  </li>
                `;
              }
              return `<li>${esc(textify(p))}</li>`;
            })
            .join("")}
        </ul>`
      : `<div class="small muted">No patterns listed.</div>`;

    const errorsArr = Array.isArray(sense?.common_errors_en) ? sense.common_errors_en : [];
    const errors = errorsArr.length
      ? `
        <div>
          ${errorsArr
            .map((e) => {
              if (!e || typeof e !== "object") return `<div class="small muted">${esc(textify(e))}</div>`;
              const err = e.error || "";
              const fix = e.fix || "";
              const exp = e.explain_en || e.explanation_en || "";
              return `
                <ul class="bullets bullets-errors">
                  ${err ? `<li><strong>Error:</strong> ${esc(String(err))}</li>` : ""}
                  ${fix ? `<li><strong>Fix:</strong> ${esc(String(fix))}</li>` : ""}
                  ${exp ? `<li><strong>Explanation:</strong> ${esc(String(exp))}</li>` : ""}
                </ul>
              `;
            })
            .join("")}
        </div>
      `
      : `<div class="small muted">No common errors listed.</div>`;

    const examples = (sense?.examples || []).map((ex) => renderExample(ex, mode, primaryFrame)).join("") || `<div class="small muted">No examples.</div>`;

    return {
      meaningHow: `
        <div class="sense-mini">
          <div class="sense-mini-title">${esc(title)}</div>
          ${howHtml}
        </div>
      `,
      patternsErrors: `
        <div class="sense-mini">
          ${neutralLabel ? `<div class="sense-mini-title">${esc(neutralLabel)}</div>` : ""}
          <div class="sense-grid">
            <div>
              <h5>Patterns</h5>
              ${patterns}
            </div>
            <div>
              <h5>Common Errors</h5>
              ${errors}
            </div>
          </div>
        </div>
      `,
      examples: `
        <div class="sense-mini">
          ${neutralLabel ? `<div class="sense-mini-title">${esc(neutralLabel)}</div>` : ""}
          <div class="ex-list">${examples}</div>
        </div>
      `,
    };
  }

  // --- Form & Grammar ---
  function niceFormLabel(key) {
    const map = {
      gender: "Gender",

      indef_sg: "Indefinite singular",
      def_sg: "Definite singular",
      indef_pl: "Indefinite plural",
      def_pl: "Definite plural",

      infinitive: "Infinitive",
      present: "Present",
      past: "Past",
      supine: "Supine",
      imperative: "Imperative",
      present_participle: "Present participle",
      past_participle: "Past participle",

      base: "Base form",
      comparative: "Comparative",
      superlative: "Superlative",
      neuter: "Neuter",
      plural_def: "Plural (definite)",

      note_en: "Note",
    };
    return map[key] || key.replaceAll("_", " ");
  }

  function hasValue(v) {
    if (v === null || v === undefined) return false;
    if (typeof v === "string") return v.trim().length > 0;
    if (Array.isArray(v)) return v.length > 0;
    if (typeof v === "object") return Object.keys(v).length > 0;
    return true;
  }

  function morphologyForPos(luObj) {
    const m = luObj.morphology && typeof luObj.morphology === "object" ? luObj.morphology : {};
    const pos = String(luObj.pos || "").toLowerCase();

    const preferred =
      pos.includes("noun") ? "noun" :
      pos.includes("verb") ? "verb" :
      (pos.includes("adj") || pos.includes("adjective")) ? "adjective" :
      "";

    const skip = new Set(["particle_or_reflexive"]); // always hidden

    function blockHasAnyForms(block) {
      if (!block || typeof block !== "object") return false;
      for (const [k, v] of Object.entries(block)) {
        if (skip.has(k)) continue;
        if (k === "note_en") continue;
        if (k === "alternatives" && Array.isArray(v) && v.length === 0) continue;
        if (hasValue(v)) return true;
      }
      return false;
    }

    /** @type {any} */
    let block = preferred && m[preferred] && typeof m[preferred] === "object" ? m[preferred] : null;

    if (!blockHasAnyForms(block)) {
      const order = pos.includes("multiword") ? ["verb", "noun", "adjective"] : ["noun", "verb", "adjective"];
      block = null;
      for (const k of order) {
        if (blockHasAnyForms(m[k])) {
          block = m[k];
          break;
        }
      }
    }

    if (!block) return { rowsHtml: "", noteHtml: "" };

    const entries = Object.entries(block).filter(([k, v]) => {
      if (skip.has(k)) return false;
      if (k === "alternatives" && Array.isArray(v) && v.length === 0) return false;
      if (k === "note_en") return false; // render as note below
      return hasValue(v);
    });

    const rowsHtml = entries
      .map(([k, v]) => {
        let valueHtml = "";
        if (Array.isArray(v)) valueHtml = v.map((x) => esc(String(x))).join(", ");
        else valueHtml = esc(String(v));
        return `<div class="k">${esc(niceFormLabel(k))}</div><div class="v">${valueHtml}</div>`;
      })
      .join("");

    const note =
      (hasValue(block.note_en) ? String(block.note_en).trim() : "") ||
      (hasValue(m.note_en) ? String(m.note_en).trim() : "");
    const noteHtml = note ? `<div class="small muted" style="margin-top:10px">${esc(note)}</div>` : "";

    return { rowsHtml, noteHtml };
  }

  function buildFormGrammarSection(luObj) {
    const rows = [];

    const ipa = luObj?.pronunciation?.ipa;
    const stress = luObj?.pronunciation?.stress_hint;
    if (hasValue(ipa) || hasValue(stress)) {
      const bits = [];
      if (hasValue(ipa)) bits.push(`<div><strong>IPA:</strong> <span class="mono">${esc(ipa)}</span></div>`);
      if (hasValue(stress)) bits.push(`<div><strong>Stress:</strong> ${esc(stress)}</div>`);
      rows.push(["Pronunciation", bits.join("")]);
    }

    if (hasValue(luObj.pos)) rows.push(["Part of speech", esc(luObj.pos)]);
    if (hasValue(luObj.cefr)) rows.push(["Proficiency Level", esc(luObj.cefr)]);

    const { rowsHtml: morphRows, noteHtml } = morphologyForPos(luObj);
    if (morphRows) {
      rows.push(["Forms", `<div class="kv" style="margin-top:6px">${morphRows}</div>${noteHtml}`]);
    }

    if (!rows.length) return `<div class="small muted">No form/grammar information.</div>`;

    return `
      <div class="kv">
        ${rows.map(([k, v]) => `<div class="k">${esc(k)}</div><div class="v">${v}</div>`).join("")}
      </div>
    `;
  }

  const senseParts = (lu.senses || []).map((s, i) => buildSenseParts(s, i));
  const meaningHowHtml = senseParts.map((p) => p.meaningHow).join("") || `<div class="small muted">No meaning information.</div>`;
  const patternsErrorsHtml = senseParts.map((p) => p.patternsErrors).join("") || `<div class="small muted">No patterns/errors information.</div>`;
  const examplesHtml = senseParts.map((p) => p.examples).join("") || `<div class="small muted">No examples.</div>`;

  const rightFrameHtml = primaryFrame
    ? `
      <div class="section">
        <h4>Related frame</h4>
        <div class="small"><strong>${esc(primaryFrame.name_en)}</strong></div>
        ${(() => {
          const htmlRaw = (primaryFrame.description_html ?? "").trim();
          const text = String(primaryFrame.description_en ?? "").trim();
          if (!htmlRaw && !text) return "";
          const html = htmlRaw ? decorateFeHtml(htmlRaw, primaryFrame.fe_mentions) : "";
          return `<div class="small muted" style="margin-top:6px">${html ? html : esc(text)}</div>`;
        })()}
        ${(() => {
          const els = Array.isArray(primaryFrame.elements) ? primaryFrame.elements : [];
          if (!els.length) return "";
          return `
            <div class="section" style="margin-top:12px">
              <h4>Frame elements</h4>
              <div class="kv">
                ${els
                  .map((fe) => {
                    const label = fe.name || fe.id;
                    const htmlRaw = String(fe?.description_html ?? "").trim();
                    const text = String(fe?.description_en ?? "").trim();
                    const vRaw = htmlRaw ? htmlRaw : esc(text);
                    const v = decorateFeHtml(vRaw, primaryFrame.fe_mentions);
                    return `<div class="k">${feChipHtml(label, fe.id || label)}</div><div class="v">${v || '<span class="muted">(no description)</span>'}</div>`;
                  })
                  .join("")}
              </div>
            </div>
          `;
        })()}
        <div style="margin-top:10px">
          <button class="btn" type="button" data-goto="frame:${esc(primaryFrame.id)}">Open frame</button>
        </div>
      </div>
    `
    : `<div class="section"><div class="small muted">No related frame linked.</div></div>`;

  function listBlock(title, items) {
    const arr = Array.isArray(items) ? items : [];
    if (!arr.length) return "";
    return `
      <div class="section" style="margin-top:12px">
        <h4>${esc(title)}</h4>
        <ul class="bullets">${arr.map((x) => `<li>${esc(textify(x))}</li>`).join("")}</ul>
      </div>`;
  }

  const lexicalRelHtml =
    listBlock("Derived words", lu.derived_words_sv) +
    listBlock("Synonyms", lu.synonyms_sv) +
    listBlock("Antonyms", lu.antonyms_sv);


  entry.innerHTML = `
    <div class="twocol">
      <div>
        <div class="lu-block">
          <h4>German &amp; English equivalents</h4>
          <div class="kv">
            <div class="k">German</div>
            <div class="v">${lu.lu_de_normalized ? esc(lu.lu_de_normalized) : '<span class="muted">—</span>'}</div>
            <div class="k">English</div>
            <div class="v">${lu.english_equivalent_en ? esc(lu.english_equivalent_en) : '<span class="muted">—</span>'}</div>
          </div>
        </div>

        <div class="lu-block">
          <h4>Form &amp; Grammar</h4>
          ${buildFormGrammarSection(lu)}
        </div>

        <div class="lu-block">
          <h4>Meaning &amp; How to use</h4>
          ${meaningHowHtml}
        </div>

        <div class="lu-block">
          <h4>Patterns &amp; Common Errors</h4>
          ${patternsErrorsHtml}
        </div>

        <div class="lu-block">
          <h4>Examples</h4>
          ${renderExampleToolbar(mode)}
          ${examplesHtml}
        </div>
      </div>

      <div>
        ${rightFrameHtml}
        ${lexicalRelHtml}
      </div>
    </div>
  `;

  wireExampleToolbar(entry, (nextMode) => {
    mode = /** @type {ExampleMode} */ (nextMode);
    state.ui.exampleMode = mode;
    savePrefs();
    renderLu(lu);
  });

  $$('[data-goto]', entry).forEach((btn) => {
    btn.addEventListener('click', () => {
      const to = btn.dataset.goto;
      if (to) location.hash = `#${to}`;
    });
  });
}

function renderConstruction(cx) {
  setEntryHeader(cx.name_user || cx.orig_cxn_id || cx.id, "CONSTRUCTION", "construction");
  const entry = $("#entry");
  if (!entry) return;

  let mode = state.ui.exampleMode;

  const primaryFrameId = (cx.frames || [])
    .map((f) => (typeof f === "string") ? f : (f?.frame_id || f?.id || f))
    .find(Boolean);
  const primaryFrame = primaryFrameId ? state.db.framesById.get(primaryFrameId) : null;

  const notes = Array.isArray(cx.usage_notes_en) ? cx.usage_notes_en : cx.usage_notes_en ? [cx.usage_notes_en] : [];
  const notesHtml = notes.length ? `<ul class="bullets">${notes.map((t) => `<li>${esc(textify(t))}</li>`).join("")}</ul>` : `<div class="small muted">No usage notes provided.</div>`;

  const examples = (cx.examples || []).map((ex) => renderExample(ex, mode, primaryFrame)).join("") || `<div class="small muted">No examples.</div>`;

  entry.innerHTML = `
    <div class="twocol">
      <div>
        <div class="section">
          <div class="small label">Construction form (SV)</div>
          <div class="big" style="margin-top:4px"><strong>${esc(cx.name_linguistic_sv || cx.pattern || cx.orig_cxn_id || "")}</strong></div>
          ${cx.pattern ? `<div class="small muted" style="margin-top:6px"><span class="kbd">Pattern</span> ${esc(cx.pattern)}</div>` : ""}
          ${cx.meaning_en ? `<div class="small" style="margin-top:8px"><span class="kbd">Meaning</span> ${esc(cx.meaning_en)}</div>` : ""}
        </div>

        <div class="section">
          <h4>Tips on usage</h4>
          ${notesHtml}
        </div>

        <div class="section" style="margin-top:12px">
          ${renderExampleToolbar(mode)}
          <div class="ex-list">${examples}</div>
        </div>
      </div>

      <div>
        ${primaryFrame ? `
          <div class="section">
            <h4>Related frame</h4>
            <div class="small"><strong>${esc(primaryFrame.name_en)}</strong></div>
            ${(() => {
              const htmlRaw = (primaryFrame.description_html ?? "").trim();
              const text = String(primaryFrame.description_en ?? "").trim();
              if (!htmlRaw && !text) return "";
              const html = htmlRaw ? decorateFeHtml(htmlRaw, primaryFrame.fe_mentions) : "";
              return `<div class="small muted" style="margin-top:6px">${html ? html : esc(text)}</div>`;
            })()}
            ${(() => {
              const els = Array.isArray(primaryFrame.elements) ? primaryFrame.elements : [];
              if (!els.length) return "";
              return `
                <div class="section" style="margin-top:12px">
                  <h4>Frame elements</h4>
                  <div class="kv">
                    ${els
                      .map((fe) => {
                        const label = fe.name || fe.id;
                        const htmlRaw = String(fe?.description_html ?? "").trim();
                        const text = String(fe?.description_en ?? "").trim();
                        const vRaw = htmlRaw ? htmlRaw : esc(text);
                        const v = decorateFeHtml(vRaw, primaryFrame.fe_mentions);
                        return `<div class="k">${feChipHtml(label, fe.id || label)}</div><div class="v">${v || '<span class="muted">(no description)</span>'}</div>`;
                      })
                      .join("")}
                  </div>
                </div>
              `;
            })()}
            <div style="margin-top:10px">
              <button class="btn" type="button" data-goto="frame:${esc(primaryFrame.id)}">Open frame</button>
            </div>
          </div>
        ` : `<div class="section"><div class="small muted">No related frame linked.</div></div>`}
      </div>
    </div>
  `;

  wireExampleToolbar(entry, (nextMode) => {
    mode = /** @type {ExampleMode} */ (nextMode);
    state.ui.exampleMode = mode;
    savePrefs();
    renderConstruction(cx);
  });

  $$('[data-goto]', entry).forEach((btn) => {
    btn.addEventListener('click', () => {
      const to = btn.dataset.goto;
      if (to) location.hash = `#${to}`;
    });
  });
}

function renderSearchEntry(query) {
  setEntryHeader('Search', '', '');
  const entry = $("#entry");
  if (!entry) return;

  const q = String(query || "").trim();
  state.ui.lastQuery = q;

  const rows = sortResults(runSearchIndex(q));

  entry.innerHTML = `
    <div class="hero">
      <div>
        <h3>Search</h3>
        <p>${q ? `Results for <span class="kbd">${esc(q)}</span>` : "Type a query in the search box."}</p>
      </div>
      <div>
        <button class="btn" type="button" id="openAdvancedFromEntry">Browse / Filters</button>
      </div>
    </div>

    <div class="section">
      <div class="small muted">${esc(rows.length)} match${rows.length === 1 ? "" : "es"}</div>
      <div style="margin-top:12px" id="searchEntryResults"></div>
    </div>
  `;

  renderResultsInto($("#searchEntryResults", entry), rows, { limit: 260 });

  const adv = $("#openAdvancedFromEntry", entry);
  if (adv) adv.addEventListener("click", () => openPanel("search"));
}

// Router

function parseHash() {
  const h = (location.hash || "").replace(/^#/, "").trim();
  if (!h) return { kind: "none" };
  if (h.startsWith("search:")) return { kind: "search", q: decodeURIComponent(h.slice("search:".length)) };
  const m = h.match(/^(lu|frame|construction):(.+)$/);
  if (!m) return { kind: "none" };
  return { kind: m[1], id: m[2] };
}

function route() {
  const parsed = parseHash();

  if (parsed.kind === "frame") {
    const fr = state.db.framesById.get(parsed.id);
    if (fr) return renderFrame(fr);
  }

  if (parsed.kind === "lu") {
    const lu = state.db.lusById.get(parsed.id);
    if (lu) return renderLu(lu);
  }

  if (parsed.kind === "construction") {
    const cx = state.db.constructionsById.get(parsed.id);
    if (cx) return renderConstruction(cx);
  }

  if (parsed.kind === "search") {
    return renderSearchEntry(parsed.q);
  }

  const entry = $("#entry");
  if (entry) {
    setEntryHeader('Swedish in Frames', '', '');
    entry.innerHTML = `
      <div class="hero">
        <div>
        <p>This is a frame semantics and construction based dictionary for Swedish learners. One can find here information about <span class="kbd">lexical units</span>, <span class="kbd">frames</span>, and <span class="kbd">constructions</span>. </p>  
        <p>Search from the bar above, or open <span class="kbd">Browse / Filters</span> for advanced search and A–Z browsing.</p>
        </div>
      </div>
      <div class="section">
        <h4>Deep links</h4>
        <div class="small muted">Use <span class="kbd">#lu:ID</span>, <span class="kbd">#frame:ID</span>, or <span class="kbd">#construction:ID</span></div>
      </div>
    `;
  }
}

// Browse A–Z

const AZ = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ".split(""), "Å", "Ä", "Ö"];

function firstLetterForBrowse(title) {
  const s = String(title || "").trim();
  if (!s) return "#";
  const ch = s[0].toUpperCase();
  if (AZ.includes(ch)) return ch;
  if (/^[A-Z]$/.test(ch)) return ch;
  return "#";
}

function renderBrowseBar() {
  const bar = $("#browseBar");
  if (!bar) return;

  bar.innerHTML = AZ.map((L) => {
    const on = state.ui.browse.letter === L;
    return `<button class="az ${on ? "on" : ""}" type="button" data-letter="${esc(L)}">${esc(L)}</button>`;
  }).join("");

  $$(".az[data-letter]", bar).forEach((btn) => {
    btn.addEventListener("click", () => {
      const L = btn.dataset.letter;
      if (!L) return;
      state.ui.browse.letter = L;
      savePrefs();
      renderBrowseBar();
      renderBrowseList();
    });
  });
}

function browseItemsOfType(type) {
  return state.db.allItems.filter((it) => it.type === type);
}

function renderBrowseList() {
  const out = $("#browseList");
  if (!out) return;

  const type = state.ui.browse.type;
  const letter = state.ui.browse.letter;

  const items = browseItemsOfType(type)
    .map((item) => ({ item, title: itemTitle(item) }))
    .filter(({ title }) => firstLetterForBrowse(title) === letter)
    .sort((a, b) => a.title.localeCompare(b.title, "sv"));

  if (!items.length) {
    out.innerHTML = `<div class="small muted">No ${esc(typeLabel(type))} under <span class="kbd">${esc(letter)}</span>.</div>`;
    return;
  }

  out.innerHTML = items
    .slice(0, 400)
    .map(({ item }) => {
      const title = itemTitle(item);
      const meta = itemMeta(item);
      return `
        <button class="result" type="button" data-key="${esc(item.key)}">
          <div>
            <div class="r-title">
              <strong>${esc(title)}</strong>
              ${meta ? `<span class="meta">${esc(meta)}</span>` : ""}
            </div>
            <div class="meta">${esc(item.id)}</div>
          </div>
          <div class="tags"><span class="tag ${tagClass(item.type)}">${esc(item.type)}</span></div>
        </button>
      `;
    })
    .join("");

  $$(".result", out).forEach((btn) => {
    btn.addEventListener("click", () => {
      const key = btn.dataset.key;
      if (!key) return;
      closePanel();
      location.hash = `#${key}`;
    });
  });
}

function renderBrowse() {
  renderBrowseBar();
  renderBrowseList();
}

// UI

function wirePanel() {
  const openBtn = $("#openSearch");
  const closeBtn = $("#closeSearch");
  const panel = $("#searchPanel");

  openBtn?.addEventListener("click", () => openPanel("search"));
  closeBtn?.addEventListener("click", () => closePanel());

  panel?.addEventListener("click", (e) => {
    if (e.target === panel) closePanel();
  });

  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isPanelOpen()) closePanel();
  });

  // Panel tabs
  $$(".panel-tabs .tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      const tab = btn.dataset.tab;
      if (!tab) return;

      $$(".panel-tabs .tab").forEach((b) => {
        const on = b.dataset.tab === tab;
        b.classList.toggle("on", on);
        b.setAttribute("aria-selected", on ? "true" : "false");
      });

      $$(".panel-body[data-panel]").forEach((p) => {
        const show = p.dataset.panel === tab;
        p.toggleAttribute("hidden", !show);
      });

      if (tab === "browse") {
        renderBrowse();
      } else {
        renderPanelResults(sortResults(runSearchIndex($("#q")?.value || "")));
      }
    });
  });
}

function wireBrowse() {
  $$("[data-browse-type]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const t = btn.getAttribute("data-browse-type");
      if (!t) return;
      state.ui.browse.type = t;
      savePrefs();
      $$("[data-browse-type]").forEach((b) => b.classList.toggle("on", b.getAttribute("data-browse-type") === t));
      renderBrowseList();
    });
  });
}

function wireNavPills() {
  $$("a.pill[data-nav]").forEach((a) => {
    a.addEventListener("click", (e) => {
      const nav = a.getAttribute("data-nav");
      if (!nav || nav === "about") return;
      e.preventDefault();

      openPanel("browse");

      if (nav === "lexicon") state.ui.browse.type = "lu";
      if (nav === "frames") state.ui.browse.type = "frame";
      if (nav === "constructions") state.ui.browse.type = "construction";

      applyPrefsToUI();
      renderBrowse();
    });
  });
}

function wireChips() {
  $$(".chip[data-filter]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const filter = btn.dataset.filter;
      const value = btn.dataset.value;

      if (filter === "type") {
        state.ui.filters[value] = !state.ui.filters[value];
        btn.classList.toggle("on", state.ui.filters[value]);
        savePrefs();
        const q = $("#q")?.value || "";
        state.ui.lastQuery = q;
        renderPanelResults(sortResults(runSearchIndex(q)));
        if (parseHash().kind === "search") renderSearchEntry(q);
      }

      if (filter === "sort") {
        state.ui.sort = /** @type {SortMode} */ (value);
        $$(".chip[data-filter='sort']").forEach((b) => b.classList.toggle("on", b.dataset.value === value));
        savePrefs();
        const q = $("#q")?.value || "";
        state.ui.lastQuery = q;
        renderPanelResults(sortResults(runSearchIndex(q)));
        if (parseHash().kind === "search") renderSearchEntry(q);
      }
    });
  });
}

function wireAdvancedFilters() {
  const posSel = $("#filterPos");
  const frameSel = $("#filterFrame");
  const clear = $("#clearAdv");

  posSel?.addEventListener("change", () => {
    state.ui.adv.pos = posSel.value || "";
    savePrefs();
    const q = $("#q")?.value || "";
    renderPanelResults(sortResults(runSearchIndex(q)));
    if (parseHash().kind === "search") renderSearchEntry(q);
  });

  frameSel?.addEventListener("change", () => {
    state.ui.adv.frame = frameSel.value || "";
    savePrefs();
    const q = $("#q")?.value || "";
    renderPanelResults(sortResults(runSearchIndex(q)));
    if (parseHash().kind === "search") renderSearchEntry(q);
  });

  clear?.addEventListener("click", () => {
    state.ui.adv.pos = "";
    state.ui.adv.frame = "";
    savePrefs();
    if (posSel) posSel.value = "";
    if (frameSel) frameSel.value = "";
    const q = $("#q")?.value || "";
    renderPanelResults(sortResults(runSearchIndex(q)));
    if (parseHash().kind === "search") renderSearchEntry(q);
  });
}

function wireSearchForm() {
  const form = $("#searchForm");
  const input = $("#q");

  form?.addEventListener("submit", (e) => {
    e.preventDefault();
    const query = input?.value || "";

    const exact = findExactLu(query);
    if (exact) {
      closePanel();
      location.hash = `#lu:${exact.id}`;
      return;
    }

    closePanel();
    location.hash = `#search:${encodeURIComponent(query.trim())}`;
  });

  input?.addEventListener("input", () => {
    const q = input.value || "";
    state.ui.lastQuery = q;
    if (isPanelOpen()) {
      renderPanelResults(sortResults(runSearchIndex(q)));
    }
    if (parseHash().kind === "search") renderSearchEntry(q);
  });

  window.addEventListener("keydown", (e) => {
    if (e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const tag = (document.activeElement?.tagName || "").toLowerCase();
      if (tag !== "input" && tag !== "textarea") {
        e.preventDefault();
        input?.focus();
      }
    }
  });
}

// Boot

async function boot() {
  loadPrefs();
  applyPrefsToUI();

  wirePanel();
  wireBrowse();
  wireNavPills();
  wireChips();
  wireAdvancedFilters();
  wireSearchForm();

  setStatus(`Loading <span class="kbd">${esc(MANIFEST_PATH)}</span> …`);

  const manifest = await fetchJson(MANIFEST_PATH);
  const framePaths = (manifest.frames || []).map(normalizeManifestPath);
  const luPaths = (manifest.lus || []).map(normalizeManifestPath);

  setStatus(`Loading ${framePaths.length} frames, ${luPaths.length} lexical units …`);

  const [frameDocs, luDocs] = await Promise.all([
    Promise.all(framePaths.map((p) => fetchJson(p).then((d) => ({ d, p })))),
    Promise.all(luPaths.map((p) => fetchJson(p).then((d) => ({ d, p })))),
  ]);

  state.db.frames = frameDocs.map(({ d, p }) => normalizeFrame(d, p));
  state.db.lus = luDocs.map(({ d, p }) => normalizeLu(d, p));

  const cxMap = new Map();
  for (const fr of state.db.frames) {
    for (const cxn of fr.constructions || []) {
      const norm = normalizeConstructionFromFrame(fr, cxn);
      if (!norm) continue;
      if (cxMap.has(norm.id)) {
        const existing = cxMap.get(norm.id);
        const already = (existing.frames || []).some((x) => (x.frame_id || x) === fr.id);
        if (!already) existing.frames = [...(existing.frames || []), { frame_id: fr.id }];
      } else {
        cxMap.set(norm.id, norm);
      }
    }
  }
  state.db.constructions = Array.from(cxMap.values());

  buildIndexes();
  populateAdvancedFilterOptions();
  applyPrefsToUI();

  // initial renders
  renderPanelResults(sortResults(runSearchIndex($("#q")?.value || "")));
  renderBrowse();

  window.addEventListener("hashchange", route);
  route();
}

boot().catch((err) => {
  console.error(err);
  setStatus(`<span class="kbd">ERROR</span> ${esc(err?.message || String(err))}`);
});
