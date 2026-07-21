/* ==========================================================================
   Merlin Engage — Onboarding Dashboard
   - Google sign-in (restricted to lawmatics.com) gates view + edit
   - Reads & writes the tracker sheet via the Google Sheets API
   - Inline-editable "All Firms" table; edits write back by exact row number
   - Duplicate Firm IDs are surfaced in a "Needs Review" panel
   Attribution: every write is made AS the signed-in user, so Google's built-in
   Version History records who changed what.
   ========================================================================== */

"use strict";

/* --------------------------------------------------------------------------
   CONFIG — fill CLIENT_ID with your OAuth Web-application client ID.
   (SHEET_ID / GID already point at the tracker.)
   -------------------------------------------------------------------------- */
const CONFIG = {
  CLIENT_ID: "1056458394718-fk8r113mqg2f55a9il4d4kg2a745d3ns.apps.googleusercontent.com",
  SHEET_ID: "1xWc_E48--rSjxA-3oBIKSBq1kDn-43OdbTrRsr88mYA",
  GID: 0,                              // the numeric tab id (from #gid= in the URL)
  ALLOWED_DOMAIN: "lawmatics.com",
  SCOPES: "https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/userinfo.email",
};

const MOCK = new URLSearchParams(location.search).has("mock");

/* --------------------------------------------------------------------------
   Runtime state
   -------------------------------------------------------------------------- */
const STATE = {
  token: null,
  tokenExp: 0,
  tokenClient: null,
  user: null,          // { email, name, picture }
  sheetTitle: null,    // resolved tab name for A1 ranges
  header: [],
  cols: {},
  data: [],            // normalized rows (each has ._row = absolute sheet row)
  dupIds: new Set(),
  validations: {},     // field -> { type: 'list', options: [...] } | { type: 'bool' }
};

/* --------------------------------------------------------------------------
   Column resolution — match by header name so re-ordering is safe.
   -------------------------------------------------------------------------- */
const FIELD_MATCHERS = {
  firmName:    (h) => h === "firm name",
  firmId:      (h) => h === "firm id",
  demoStatus:  (h) => h === "demo status",
  demoRep:     (h) => h === "demo rep",
  demoDate:    (h) => h === "demo date",
  demoResched: (h) => h.includes("reschedul"),
  setupStatus: (h) => (h.includes("set up") || h.includes("setup")) && h.includes("status"),
  setup1Date:  (h) => h.includes("#1"),
  setup2Date:  (h) => h.includes("#2"),
  setupClosed: (h) => h.includes("closed") && h.includes("date"),   // "Set up closed date"
  preReq:      (h) => h.includes("requirement"),
  setupRep:    (h) => (h.includes("set up") || h.includes("setup")) && h.includes("rep"),
  csat:        (h) => h.includes("csat"),
  closedLost:  (h) => h.includes("closed lost"),
  mrr:         (h) => h.includes("mrr"),
  createdAt:   (h) => h.includes("created"),
};

function resolveColumns(headerRow) {
  const map = {};
  const norm = headerRow.map((h) => (h || "").trim().toLowerCase());
  for (const [key, test] of Object.entries(FIELD_MATCHERS)) map[key] = norm.findIndex(test);
  return map;
}

/* Table column model — order + edit behaviour. `field` maps to STATE.cols[field]. */
const TABLE_COLS = [
  { field: "firmName",    label: "Firm",               type: "text",   cls: "firm" },
  { field: "firmId",      label: "ID",                 type: "text" },
  { field: "createdAt",   label: "Created",            type: "text" },
  { field: "demoStatus",  label: "Demo",               type: "status" },
  { field: "demoRep",     label: "Demo Rep",           type: "rep" },
  { field: "demoDate",    label: "Demo Date",          type: "text" },
  { field: "demoResched", label: "Demo Resched.",      type: "text" },
  { field: "setupStatus", label: "Setup",              type: "status" },
  { field: "setup1Date",  label: "Setup #1",           type: "text" },
  { field: "setup2Date",  label: "Setup #2",           type: "text" },
  { field: "setupClosed", label: "Setup Closed",       type: "text" },
  { field: "preReq",      label: "Pre-reqs",           type: "bool" },
  { field: "setupRep",    label: "Setup Rep",          type: "rep" },
  { field: "csat",        label: "CSAT",               type: "num" },
  { field: "closedLost",  label: "Closed Lost Reason", type: "text" },
  { field: "mrr",         label: "MRR",                type: "money" },
];

/* --------------------------------------------------------------------------
   Value helpers
   -------------------------------------------------------------------------- */
const cell = (row, idx) => (idx >= 0 && idx < row.length ? String(row[idx] ?? "").trim() : "");
const toNumber = (v) => { const n = parseFloat(String(v ?? "").replace(/[^0-9.\-]/g, "")); return isNaN(n) ? null : n; };
function toBool(v) {
  const s = String(v).trim().toLowerCase();
  if (["true", "yes", "y", "1", "✓", "checked"].includes(s)) return true;
  if (["false", "no", "n", "0", ""].includes(s)) return false;
  return null;
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function colLetter(n) { let s = ""; n++; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }
function quoteTitle(t) { return "'" + String(t).replace(/'/g, "''") + "'"; }   // safe A1 sheet ref (handles spaces)

function classifyStatus(raw) {
  const s = (raw || "").trim(), l = s.toLowerCase();
  if (!l) return { label: "—", cls: "neutral" };
  if (/(closed\s*)?lost|churn|declin/.test(l)) return { label: s, cls: "critical" };
  if (/complet|done|finish|live|won/.test(l))  return { label: s, cls: "good" };
  if (/no[-\s]?show|cancel|missed/.test(l))    return { label: s, cls: "serious" };
  if (/reschedul|delay|pending|hold/.test(l))  return { label: s, cls: "warn" };
  if (/schedul|book|set|progress|active/.test(l)) return { label: s, cls: "info" };
  if (/not\s*start|todo|to do|new|n\/?a/.test(l)) return { label: s, cls: "neutral" };
  return { label: s, cls: "info" };
}

/* Build a normalized row object from a raw sheet row + its absolute row number. */
function normalizeRow(r, rowNumber) {
  const c = STATE.cols;
  return {
    _row: rowNumber,
    firmName: cell(r, c.firmName),
    firmId: cell(r, c.firmId),
    demoStatus: cell(r, c.demoStatus),
    demoRep: cell(r, c.demoRep),
    demoDate: cell(r, c.demoDate),
    demoResched: cell(r, c.demoResched),
    setupStatus: cell(r, c.setupStatus),
    setup1Date: cell(r, c.setup1Date),
    setup2Date: cell(r, c.setup2Date),
    setupClosed: cell(r, c.setupClosed),
    preReq: toBool(cell(r, c.preReq)),
    setupRep: cell(r, c.setupRep),
    csat: toNumber(cell(r, c.csat)),
    closedLost: cell(r, c.closedLost),
    mrr: toNumber(cell(r, c.mrr)),
    createdAt: cell(r, c.createdAt),
  };
}

/* --------------------------------------------------------------------------
   Metrics / grouping / duplicates
   -------------------------------------------------------------------------- */
const isCompleted = (s) => /complet|done|finish|live/i.test(s || "");
const isScheduled = (s) => /schedul|book|set|progress|active/i.test(s || "");
const isWon = (d) => /won/i.test(d.demoStatus || "");                 // converted = Demo Status "Completed - Won"
const isLost = (d) => /lost/i.test(d.demoStatus || "") || !!(d.closedLost && String(d.closedLost).trim());
// A demo counts as completed when it's Completed, or resolved Won / Lost.
const isDemoDone = (d) => isCompleted(d.demoStatus) || /won|lost/i.test(d.demoStatus || "");

function computeMetrics(data) {
  const total = data.length;
  const demosCompleted = data.filter(isDemoDone).length;
  const setupScheduled = data.filter((d) => isScheduled(d.setupStatus) || isCompleted(d.setupStatus) || d.setup1Date).length;
  const setupCompleted = data.filter((d) => isCompleted(d.setupStatus)).length;
  const won = data.filter(isWon).length;
  const closedLost = data.filter((d) => d.closedLost && String(d.closedLost).trim()).length;
  const csats = data.map((d) => d.csat).filter((n) => n != null);
  const avgCsat = csats.length ? csats.reduce((a, b) => a + b, 0) / csats.length : null;
  const mrrTotal = data.reduce((a, d) => a + (d.mrr || 0), 0);
  const preReqMet = data.filter((d) => d.preReq === true).length;

  // Onboardings closed = Completed - Won AND setup completed.
  const onboardingsClosed = data.filter((d) => isWon(d) && isCompleted(d.setupStatus)).length;

  // Avg days from demo (rescheduled date if present, else demo date) to Set up closed date.
  const gaps = [];
  for (const d of data) {
    const dc = parseDate(d.demoResched) || parseDate(d.demoDate);
    const su = parseDate(d.setupClosed);
    if (dc && su) { const days = (su - dc) / 86400000; if (days >= 0 && days < 400) gaps.push(days); }
  }
  const avgDemoToClose = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : null;

  return {
    total, demosCompleted, setupScheduled, setupCompleted, won, closedLost,
    avgCsat, csatCount: csats.length, mrrTotal, preReqMet,
    onboardingsClosed, avgDemoToClose, demoToCloseCount: gaps.length,
    conversionRate: total ? won / total : 0,
    demoRate: total ? demosCompleted / total : 0,
    setupRate: demosCompleted ? setupCompleted / demosCompleted : 0,
    lostRate: total ? closedLost / total : 0,
  };
}

function computeDuplicates(data) {
  const counts = {};
  for (const d of data) if (d.firmId) counts[d.firmId] = (counts[d.firmId] || 0) + 1;
  return new Set(Object.entries(counts).filter(([, n]) => n > 1).map(([id]) => id));
}

function groupBy(data, keyFn, valFns) {
  const groups = {};
  for (const d of data) { const k = keyFn(d); if (!k) continue; (groups[k] = groups[k] || []).push(d); }
  return Object.entries(groups).map(([name, rows]) => {
    const o = { name, count: rows.length };
    for (const [label, fn] of Object.entries(valFns || {})) o[label] = fn(rows);
    return o;
  });
}

function distribution(data, field) {
  const counts = {};
  for (const d of data) { const raw = d[field] && d[field].trim() ? d[field].trim() : "—"; counts[raw] = (counts[raw] || 0) + 1; }
  return Object.entries(counts).map(([label, count]) => ({ label, count, ...classifyStatus(label) })).sort((a, b) => b.count - a.count);
}

function distinctValues(field) {
  return [...new Set(STATE.data.map((d) => d[field]).filter((v) => v && String(v).trim()))].sort();
}

/* --------------------------------------------------------------------------
   Formatting
   -------------------------------------------------------------------------- */
const fmtMoney = (n) => "$" + Math.round(n || 0).toLocaleString("en-US");
const fmtPct = (n) => (n * 100).toFixed(n >= 0.1 || n === 0 ? 0 : 1) + "%";

/* Parse sheet dates: M/D/YY, M/D/YYYY, or M/D (assumes current year). */
function parseDate(s) {
  if (!s) return null;
  s = String(s).trim();
  const m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})(?:[\/\-.](\d{2,4}))?$/);
  if (m) {
    const mo = +m[1], da = +m[2];
    const year = m[3] == null ? new Date().getFullYear() : (m[3].length <= 2 ? 2000 + +m[3] : +m[3]);
    const d = new Date(year, mo - 1, da);
    return isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}
const fmtDays = (n) => n == null ? "—" : (n < 10 ? n.toFixed(1) : Math.round(n).toString());

/* --------------------------------------------------------------------------
   Tooltip
   -------------------------------------------------------------------------- */
const tipEl = () => document.getElementById("tip");
function showTip(html, x, y) {
  const t = tipEl(); t.innerHTML = html; t.style.opacity = "1";
  const r = t.getBoundingClientRect();
  let left = x + 14, top = y + 14;
  if (left + r.width > innerWidth - 8) left = x - r.width - 14;
  if (top + r.height > innerHeight - 8) top = y - r.height - 14;
  t.style.left = left + "px"; t.style.top = top + "px";
}
const hideTip = () => (tipEl().style.opacity = "0");
function bindTip(el, html) {
  el.addEventListener("mousemove", (e) => showTip(html, e.clientX, e.clientY));
  el.addEventListener("mouseleave", hideTip);
}

/* --------------------------------------------------------------------------
   Icons
   -------------------------------------------------------------------------- */
const ICON = {
  firms: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21h18M6 21V7l6-4 6 4v14"/><path d="M10 9h.01M14 9h.01M10 13h.01M14 13h.01M10 17h.01M14 17h.01"/></svg>',
  demo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="14" rx="2"/><path d="M8 21h8M12 18v3M10 9l4 2-4 2z"/></svg>',
  setup: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 7h-9M14 17H5M17 3l3 4-3 4M7 21l-3-4 3-4"/></svg>',
  star: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l3.1 6.3 6.9 1-5 4.9 1.2 6.9L12 17.8 5.8 21l1.2-6.9-5-4.9 6.9-1z"/></svg>',
  money: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1v22M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>',
  lost: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M15 9l-6 6M9 9l6 6"/></svg>',
  conv: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 6l-9.5 9.5-5-5L1 18"/><path d="M17 6h6v6"/></svg>',
  won: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0zM7 4H4v2a3 3 0 0 0 3 3M17 4h3v2a3 3 0 0 1-3 3"/></svg>',
};
const starSvg = (f) => `<svg viewBox="0 0 24 24" fill="${f ? "var(--lm-orange)" : "none"}" stroke="${f ? "var(--lm-orange)" : "var(--text-3)"}" stroke-width="1.6" stroke-linejoin="round"><path d="M12 2l3.1 6.3 6.9 1-5 4.9 1.2 6.9L12 17.8 5.8 21l1.2-6.9-5-4.9 6.9-1z"/></svg>`;

/* --------------------------------------------------------------------------
   RENDER — summary widgets
   -------------------------------------------------------------------------- */
function renderKPIs(m) {
  const tiles = [
    { label: "Firms in Pipeline", val: m.total, icon: ICON.firms, accent: "var(--lm-blue)", soft: "rgba(6,139,255,.12)", sub: `<span class="chip neu">${m.preReqMet} pre-reqs met</span>` },
    { label: "Demos Completed", val: m.demosCompleted, icon: ICON.demo, accent: "var(--lm-cyan)", soft: "rgba(3,176,219,.12)", sub: `<span class="chip ${m.demoRate >= 0.5 ? "pos" : "neu"}">${fmtPct(m.demoRate)} of pipeline</span>` },
    { label: "Setups Completed", val: m.setupCompleted, icon: ICON.setup, accent: "#2f6db0", soft: "rgba(47,109,176,.14)", sub: `<span class="chip neu">${m.setupScheduled} scheduled</span>` },
    { label: "Conversion Rate", val: fmtPct(m.conversionRate), icon: ICON.conv, accent: "var(--st-good)", soft: "rgba(12,163,90,.13)", sub: `<span class="chip pos">${m.won} won</span> <span class="chip neu">of ${m.total}</span>` },
    { label: "Onboardings Closed", val: m.onboardingsClosed, icon: ICON.won, accent: "var(--st-good)", soft: "rgba(12,163,90,.13)", sub: `<span class="chip pos">won &amp; setup complete</span>` },
    { label: "Avg Demo → Close", val: m.avgDemoToClose != null ? fmtDays(m.avgDemoToClose) : "—", unit: m.avgDemoToClose != null ? " days" : "", icon: ICON.setup, accent: "var(--lm-cyan)", soft: "rgba(3,176,219,.12)", sub: `<span class="chip neu">${m.demoToCloseCount} measured</span>` },
    { label: "Avg Setup CSAT", val: m.avgCsat != null ? m.avgCsat.toFixed(1) : "—", unit: m.avgCsat != null ? "/5" : "", icon: ICON.star, accent: "var(--lm-orange)", soft: "rgba(247,99,0,.12)", sub: `<span class="chip neu">${m.csatCount} rated</span>` },
    { label: "MRR Added", val: fmtMoney(m.mrrTotal), icon: ICON.money, accent: "var(--lm-blue)", soft: "rgba(6,139,255,.12)", sub: `<span class="chip pos">${m.won} firm${m.won === 1 ? "" : "s"} won</span>` },
    { label: "Closed Lost", val: m.closedLost, icon: ICON.lost, accent: "var(--st-critical)", soft: "rgba(216,58,58,.12)", sub: `<span class="chip ${m.closedLost ? "neg" : "neu"}">${fmtPct(m.lostRate)} of pipeline</span>` },
  ];
  document.getElementById("kpis").innerHTML = tiles.map((t) => `
    <div class="kpi" style="--accent:${t.accent};--accent-soft:${t.soft}">
      <div class="kpi-top"><span class="kpi-label">${t.label}</span><span class="kpi-ico">${t.icon}</span></div>
      <div class="kpi-val">${t.val}${t.unit ? `<span class="unit">${t.unit}</span>` : ""}</div>
      <div class="kpi-sub">${t.sub}</div>
    </div>`).join("");
}

function renderFunnel(m) {
  const stages = [
    { name: "Firms in Pipeline", count: m.total, color: "var(--fn-1)" },
    { name: "Demos Completed", count: m.demosCompleted, color: "var(--fn-2)" },
    { name: "Setups Scheduled", count: m.setupScheduled, color: "var(--fn-3)" },
    { name: "Setups Completed", count: m.setupCompleted, color: "var(--fn-4)" },
    { name: "Won", count: m.won, color: "var(--fn-5)" },
  ];
  const top = Math.max(1, stages[0].count);
  const el = document.getElementById("funnel");
  el.innerHTML = stages.map((s, i) => {
    const pctTop = s.count / top, prev = i === 0 ? s.count : stages[i - 1].count, conv = prev ? s.count / prev : 0;
    return `<div class="fn-row" data-i="${i}">
      <div class="fn-meta"><span class="fn-name">${s.name}</span>
      <span class="fn-nums"><b>${s.count}</b><span class="pct">${fmtPct(pctTop)} of top${i ? ` · ${fmtPct(conv)} step conv.` : ""}</span></span></div>
      <div class="fn-track"><div class="fn-bar" style="width:${Math.max(2, pctTop * 100)}%;background:${s.color}"></div></div>
    </div>`;
  }).join("");
  el.querySelectorAll(".fn-row").forEach((row) => {
    const s = stages[+row.dataset.i];
    bindTip(row, `<div class="tt-t">${esc(s.name)}</div><div class="tt-r"><span>Firms</span><b>${s.count}</b></div><div class="tt-r"><span>of pipeline</span><b>${fmtPct(s.count / top)}</b></div>`);
  });
}

function renderDistribution(elId, dist, opts = {}) {
  const el = document.getElementById(elId);
  if (!dist.length) { el.innerHTML = `<div class="empty-note">${opts.empty || "No data yet."}</div>`; return; }
  const max = Math.max(...dist.map((d) => d.count));
  const total = dist.reduce((a, d) => a + d.count, 0);
  const sv = { good: "--st-good", info: "--st-info", warn: "--st-warn", serious: "--st-serious", critical: "--st-critical", neutral: "--st-neutral" };
  el.innerHTML = dist.map((d) => {
    const color = opts.color || `var(${sv[d.cls]})`;
    const pct = opts.showPct && total ? ` <span class="bl-pct">${Math.round((d.count / total) * 100)}%</span>` : "";
    return `<div class="bl-row"><span class="bl-label"><span class="swatch" style="background:${color}"></span>${esc(d.label)}</span>
      <span class="bl-track"><span class="bl-bar" style="width:${Math.max(3, (d.count / max) * 100)}%;background:${color}"></span></span>
      <span class="bl-val">${d.count}${pct}</span></div>`;
  }).join("");
}

function renderCsat(m) {
  const el = document.getElementById("csat");
  if (m.avgCsat == null) { el.innerHTML = `<div class="empty-note">No CSAT scores recorded yet.</div>`; return; }
  const stars = Array.from({ length: 5 }, (_, i) => starSvg(i < Math.round(m.avgCsat))).join("");
  el.innerHTML = `<div class="csat-wrap"><div>
    <div class="csat-num">${m.avgCsat.toFixed(1)}<span class="den"> / 5</span></div>
    <div class="stars">${stars}</div>
    <div class="csat-note">Across ${m.csatCount} rated setup${m.csatCount === 1 ? "" : "s"}</div>
  </div></div>`;
}

// Onboarding cycle: demo date (rescheduled date if present) -> Set up closed date.
// A firm counts once it has a Set up closed date. Returns {avg, n} or null.
function cycleDays(rows) {
  const gs = [];
  for (const r of rows) {
    const start = parseDate(r.demoResched) || parseDate(r.demoDate);
    const end = parseDate(r.setupClosed);
    if (start && end) { const d = (end - start) / 86400000; if (d >= 0 && d < 400) gs.push(d); }
  }
  return gs.length ? { avg: gs.reduce((a, b) => a + b, 0) / gs.length, n: gs.length } : null;
}

function renderReps(data) {
  const demoReps = groupBy(data.filter((d) => d.demoRep), (d) => d.demoRep, {
    completed: (rows) => rows.filter(isDemoDone).length,
    won: (rows) => rows.filter(isWon).length,
    cycle: cycleDays,
  }).sort((a, b) => b.count - a.count);
  const setupReps = groupBy(data.filter((d) => d.setupRep), (d) => d.setupRep, {
    completed: (rows) => rows.filter((r) => isCompleted(r.setupStatus)).length,
    won: (rows) => rows.filter(isWon).length,
    cycle: cycleDays,
    avgCsat: (rows) => { const c = rows.map((r) => r.csat).filter((n) => n != null); return c.length ? c.reduce((a, b) => a + b, 0) / c.length : null; },
  }).sort((a, b) => b.count - a.count);

  // Bar length = volume (count); headline values = conversion rate + avg cycle days.
  const repRow = (name, count, max, conv, cycle) =>
    `<div class="bl-row"><span class="bl-label">${esc(name)}</span>
     <span class="bl-track"><span class="bl-bar" style="width:${Math.max(3, (count / max) * 100)}%;background:var(--lm-blue)"></span></span>
     <span class="bl-val">${fmtPct(conv)}<span class="bl-pct">conv</span> · ${cycle ? fmtDays(cycle.avg) : "—"}<span class="bl-pct">d</span></span></div>`;

  const cycleTip = (c) => c
    ? `<div class="tt-r"><span>Cycle demo→close</span><b>${fmtDays(c.avg)} days</b></div><div class="tt-r"><span>&nbsp;based on</span><b>${c.n} closed</b></div>`
    : `<div class="tt-r"><span>Cycle demo→close</span><b>—</b></div>`;

  const dEl = document.getElementById("demoReps");
  if (!demoReps.length) dEl.innerHTML = `<div class="empty-note">No demo reps yet.</div>`;
  else {
    const max = Math.max(...demoReps.map((r) => r.count));
    dEl.innerHTML = demoReps.map((r) => repRow(r.name, r.count, max, r.count ? r.won / r.count : 0, r.cycle)).join("");
    dEl.querySelectorAll(".bl-row").forEach((row, i) => {
      const r = demoReps[i];
      bindTip(row, `<div class="tt-t">${esc(r.name)}</div><div class="tt-r"><span>Demos owned</span><b>${r.count}</b></div><div class="tt-r"><span>Completed</span><b>${r.completed}</b></div><div class="tt-r"><span>Won</span><b>${r.won}</b></div><div class="tt-r"><span>Conversion</span><b>${fmtPct(r.count ? r.won / r.count : 0)}</b></div>${cycleTip(r.cycle)}`);
    });
  }

  const sEl = document.getElementById("setupReps");
  if (!setupReps.length) sEl.innerHTML = `<div class="empty-note">No setup reps yet.</div>`;
  else {
    const max = Math.max(...setupReps.map((r) => r.count));
    sEl.innerHTML = setupReps.map((r) => repRow(r.name, r.count, max, r.count ? r.won / r.count : 0, r.cycle)).join("");
    sEl.querySelectorAll(".bl-row").forEach((row, i) => {
      const r = setupReps[i];
      const csat = r.avgCsat != null ? r.avgCsat.toFixed(1) + " / 5" : "—";
      bindTip(row, `<div class="tt-t">${esc(r.name)}</div><div class="tt-r"><span>Setups owned</span><b>${r.count}</b></div><div class="tt-r"><span>Completed</span><b>${r.completed}</b></div><div class="tt-r"><span>Won</span><b>${r.won}</b></div><div class="tt-r"><span>Conversion</span><b>${fmtPct(r.count ? r.won / r.count : 0)}</b></div>${cycleTip(r.cycle)}<div class="tt-r"><span>Avg CSAT</span><b>${csat}</b></div>`);
    });
  }
}

/* Closed Lost reasons breakdown */
function renderLostReasons(data) {
  const counts = {};
  for (const d of data) {
    const raw = d.closedLost && String(d.closedLost).trim();
    if (!raw) continue;
    counts[raw] = (counts[raw] || 0) + 1;
  }
  const dist = Object.entries(counts).map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count);
  renderDistribution("lostDist", dist, { color: "var(--st-critical)", showPct: true, empty: "No closed-lost firms yet." });
  const n = dist.reduce((a, d) => a + d.count, 0);
  const sub = document.getElementById("lostSub");
  if (sub) sub.textContent = `${n} firm${n === 1 ? "" : "s"} closed lost`;
}

/* --------------------------------------------------------------------------
   Onboardings over time — demos by outcome (Won / Lost / Open), by demo date
   -------------------------------------------------------------------------- */
function bucketKeyFor(date, mode) {
  const d = new Date(date);
  if (mode === "month") return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
  const day = (d.getDay() + 6) % 7; d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - day); // Monday
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
function buildBuckets(min, max, mode) {
  const out = [];
  if (mode === "month") {
    let y = min.getFullYear(), m = min.getMonth();
    const ey = max.getFullYear(), em = max.getMonth();
    while ((y < ey || (y === ey && m <= em)) && out.length < 36) {
      const dt = new Date(y, m, 1);
      out.push({ key: `${y}-${String(m + 1).padStart(2, "0")}`, label: dt.toLocaleString("en-US", { month: "short" }), tip: dt.toLocaleString("en-US", { month: "long", year: "numeric" }) });
      if (++m > 11) { m = 0; y++; }
    }
  } else {
    const d = new Date(min); const day = (d.getDay() + 6) % 7; d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - day);
    const end = new Date(max);
    while (d <= end && out.length < 30) {
      out.push({ key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`,
        label: (d.getMonth() + 1) + "/" + d.getDate(),
        tip: "Week of " + d.toLocaleString("en-US", { month: "short", day: "numeric" }) });
      d.setDate(d.getDate() + 7);
    }
  }
  return out;
}
function renderTrend(data) {
  const el = document.getElementById("trend");
  if (!el) return;
  const note = document.getElementById("trendNote");
  const items = [];
  for (const d of data) {
    const dt = parseDate(d.demoResched) || parseDate(d.demoDate);
    if (dt) items.push({ dt, won: isWon(d), lost: isLost(d) });
  }
  if (!items.length) { el.innerHTML = `<div class="empty-note">No demo dates to chart yet.</div>`; if (note) note.textContent = ""; return; }

  const min = new Date(Math.min(...items.map((i) => +i.dt)));
  const max = new Date(Math.max(...items.map((i) => +i.dt)));
  const mode = (max - min) / 86400000 > 112 ? "month" : "week";
  const buckets = buildBuckets(min, max, mode);
  const map = {};
  buckets.forEach((b) => (map[b.key] = { won: 0, lost: 0, open: 0 }));
  for (const it of items) {
    const c = map[bucketKeyFor(it.dt, mode)];
    if (!c) continue;
    if (it.won) c.won++; else if (it.lost) c.lost++; else c.open++;
  }
  const totals = buckets.map((b) => map[b.key].won + map[b.key].lost + map[b.key].open);
  const maxTotal = Math.max(1, ...totals);
  const seg = (n, total, cls) => (n ? `<div class="tb-seg ${cls}" style="height:${(n / total) * 100}%"></div>` : "");

  el.innerHTML =
    `<div class="trend-plot">${buckets.map((b, i) => {
      const c = map[b.key], total = totals[i];
      return `<div class="tb-col" data-i="${i}">
        ${total ? `<div class="tb-total">${total}</div>` : ""}
        <div class="tb-stack" style="height:${total ? (total / maxTotal) * 100 : 0}%">${seg(c.lost, total, "lost")}${seg(c.open, total, "open")}${seg(c.won, total, "won")}</div>
      </div>`;
    }).join("")}</div>
     <div class="trend-x">${buckets.map((b) => `<span class="tb-xlabel">${esc(b.label)}</span>`).join("")}</div>`;

  if (note) note.textContent = mode === "month" ? "by month" : "by week";
  el.querySelectorAll(".tb-col").forEach((col, i) => {
    const b = buckets[i], c = map[b.key];
    bindTip(col, `<div class="tt-t">${esc(b.tip)}</div><div class="tt-r"><span>Won</span><b>${c.won}</b></div><div class="tt-r"><span>Lost</span><b>${c.lost}</b></div><div class="tt-r"><span>Open</span><b>${c.open}</b></div><div class="tt-r"><span>Total demos</span><b>${totals[i]}</b></div>`);
  });
}

/* --------------------------------------------------------------------------
   Needs Attention — next-action queue mapped to the onboarding flow.
   Each firm shows once, with its earliest-stage blocker (priority order).
   -------------------------------------------------------------------------- */
function computeAttention(data) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const past = (s) => { const d = parseDate(s); return d && d < today; };
  const has = (v) => v != null && String(v).trim() !== "";
  const out = [];
  for (const d of data) {
    const demoRep = d.demoRep || "Unassigned";
    const setupRep = d.setupRep || d.demoRep || "Unassigned";

    if (isScheduled(d.demoStatus) && (!has(d.firmId) || !has(d.demoDate))) {
      const need = !has(d.firmId) && !has(d.demoDate) ? "Add Firm ID & demo date" : !has(d.firmId) ? "Add Firm ID" : "Add demo date";
      out.push({ d, cls: "info", tag: "Missing info", action: need, rep: demoRep }); continue;
    }
    if (isScheduled(d.demoStatus) && !isDemoDone(d) && past(d.demoResched || d.demoDate)) {
      out.push({ d, cls: "warn", tag: "Demo overdue", action: "Demo date passed — set Won / Lost", rep: demoRep }); continue;
    }
    if (isLost(d) && !has(d.closedLost)) {
      out.push({ d, cls: "serious", tag: "No lost reason", action: "Add a closed-lost reason", rep: demoRep }); continue;
    }
    if (isWon(d) && !isScheduled(d.setupStatus) && !isCompleted(d.setupStatus) && !has(d.setup1Date)) {
      out.push({ d, cls: "serious", tag: "Setup not booked", action: "Schedule setup & set status", rep: demoRep }); continue;
    }
    if (isScheduled(d.setupStatus) && !isCompleted(d.setupStatus) && past(d.setup1Date)) {
      out.push({ d, cls: "warn", tag: "Setup #1 overdue", action: "Setup #1 date passed — update status", rep: setupRep }); continue;
    }
    if (!isCompleted(d.setupStatus) && has(d.setup1Date) && past(d.setup1Date) && !has(d.setup2Date)) {
      out.push({ d, cls: "info", tag: "No setup #2", action: "Schedule the Setup #2 call", rep: setupRep }); continue;
    }
    if (isCompleted(d.setupStatus) && !has(d.setupClosed)) {
      out.push({ d, cls: "warn", tag: "No closed date", action: "Add the set up closed date", rep: setupRep }); continue;
    }
  }
  return out;
}

function jumpToRow(row) {
  TABLE_STATE.query = "";
  const s = document.getElementById("search"); if (s) s.value = "";
  renderTable();
  const tr = document.querySelector(`tbody tr[data-row="${row}"]`);
  if (tr) { tr.scrollIntoView({ block: "center", behavior: "smooth" }); tr.classList.add("row-flash"); setTimeout(() => tr.classList.remove("row-flash"), 1600); }
}

function renderAttention(data) {
  const list = document.getElementById("attnList");
  const count = document.getElementById("attnCount");
  if (!list) return;
  const items = computeAttention(data);
  if (count) count.textContent = items.length ? String(items.length) : "";
  if (!items.length) {
    list.innerHTML = `<div class="attn-clear">✓ All caught up — nothing needs attention${filterActive() ? " in this view" : ""}.</div>`;
    return;
  }
  list.innerHTML = items.map((it) => `
    <div class="attn-row">
      <span class="pill ${it.cls}"><span class="pd"></span>${esc(it.tag)}</span>
      <span class="attn-firm">${esc(it.d.firmName)}</span>
      <span class="attn-action">${esc(it.action)}</span>
      <span class="attn-rep">${esc(it.rep)}</span>
      <button class="rr-jump" data-row="${it.d._row}">Open →</button>
    </div>`).join("");
  list.querySelectorAll(".rr-jump").forEach((b) => b.addEventListener("click", () => jumpToRow(b.dataset.row)));
}

/* --------------------------------------------------------------------------
   Needs Review (duplicate Firm IDs)
   -------------------------------------------------------------------------- */
function renderNeedsReview() {
  const sec = document.getElementById("reviewSection");
  const badge = document.getElementById("reviewBadge");
  const dups = STATE.dupIds;
  if (!dups.size) { sec.classList.add("hidden"); badge.classList.add("hidden"); return; }

  sec.classList.remove("hidden");
  badge.classList.remove("hidden");
  badge.querySelector(".txt").textContent = `${dups.size} to review`;

  const groups = [...dups].map((id) => ({ id, rows: STATE.data.filter((d) => d.firmId === id) }));
  document.getElementById("reviewBody").innerHTML = groups.map((g) => `
    <div class="review-card">
      <div class="review-head">
        <span class="pill critical"><span class="pd"></span>Duplicate Firm ID</span>
        <span class="review-id">${esc(g.id)}</span>
        <span class="review-count">${g.rows.length} rows</span>
      </div>
      <div class="review-rows">
        ${g.rows.map((r) => `<div class="review-row">
          <span class="rr-firm">${esc(r.firmName)}</span>
          <span class="rr-meta">Demo: ${esc(r.demoStatus || "—")} · ${esc(r.demoRep || "—")}</span>
          <span class="rr-meta">Setup: ${esc(r.setupStatus || "—")} · ${esc(r.setupRep || "—")}</span>
          <button class="rr-jump" data-row="${r._row}">Edit in table →</button>
        </div>`).join("")}
      </div>
      <p class="review-hint">Two rows share this Firm ID (e.g. two contacts at the same firm). Give each a distinct ID, or merge them.</p>
    </div>`).join("");

  document.querySelectorAll(".rr-jump").forEach((b) => b.addEventListener("click", () => {
    TABLE_STATE.query = "";
    document.getElementById("search").value = "";
    renderTable();
    const tr = document.querySelector(`tbody tr[data-row="${b.dataset.row}"]`);
    if (tr) { tr.scrollIntoView({ block: "center", behavior: "smooth" }); tr.classList.add("row-flash"); setTimeout(() => tr.classList.remove("row-flash"), 1600); }
  }));
}

/* --------------------------------------------------------------------------
   TABLE (searchable, sortable, inline-editable)
   -------------------------------------------------------------------------- */
let TABLE_STATE = { sortKey: "firmName", dir: 1, query: "" };
let activeEditor = null;

/* --------------------------------------------------------------------------
   Dashboard-wide filter (rep + demo/setup status) — scopes every panel & table
   -------------------------------------------------------------------------- */
let FILTER = { rep: "", demoStatus: "", setupStatus: "" };
function filterActive() { return !!(FILTER.rep || FILTER.demoStatus || FILTER.setupStatus); }
function activeData() {
  const { rep, demoStatus, setupStatus } = FILTER;
  return STATE.data.filter((d) =>
    (!rep || d.demoRep === rep || d.setupRep === rep) &&
    (!demoStatus || d.demoStatus === demoStatus) &&
    (!setupStatus || d.setupStatus === setupStatus));
}
function fillSelect(sel, options, allLabel) {
  if (!sel) return;
  const cur = sel.value;
  sel.innerHTML = `<option value="">${allLabel}</option>` + options.map((o) => `<option value="${esc(o)}">${esc(o)}</option>`).join("");
  sel.value = options.includes(cur) ? cur : "";
}
function populateFilters() {
  const repSel = document.getElementById("fltRep");
  if (!repSel) return;
  const reps = new Set();
  STATE.data.forEach((d) => { if (d.demoRep) reps.add(d.demoRep); if (d.setupRep) reps.add(d.setupRep); });
  fillSelect(repSel, [...reps].sort(), "All reps");
  fillSelect(document.getElementById("fltDemo"), distinctValues("demoStatus"), "All demo statuses");
  fillSelect(document.getElementById("fltSetup"), distinctValues("setupStatus"), "All setup statuses");
  FILTER = { rep: repSel.value, demoStatus: document.getElementById("fltDemo").value, setupStatus: document.getElementById("fltSetup").value };
}
function onFilterChange() {
  FILTER.rep = document.getElementById("fltRep").value;
  FILTER.demoStatus = document.getElementById("fltDemo").value;
  FILTER.setupStatus = document.getElementById("fltSetup").value;
  renderDerived();
  renderTable();
}
function clearFilters() {
  ["fltRep", "fltDemo", "fltSetup"].forEach((id) => { const s = document.getElementById(id); if (s) s.value = ""; });
  FILTER = { rep: "", demoStatus: "", setupStatus: "" };
  renderDerived();
  renderTable();
}

function renderTable() {
  const { sortKey, dir, query } = TABLE_STATE;
  const q = query.trim().toLowerCase();
  let rows = activeData().filter((d) => !q ||
    [d.firmName, d.firmId, d.demoRep, d.setupRep, d.demoStatus, d.setupStatus, d.closedLost].some((v) => (v || "").toLowerCase().includes(q)));
  rows = rows.slice().sort((a, b) => {
    let av = a[sortKey], bv = b[sortKey];
    if (typeof av === "number" || typeof bv === "number") return ((av || 0) - (bv || 0)) * dir;
    return String(av || "").localeCompare(String(bv || "")) * dir;
  });

  document.getElementById("rowCount").textContent = `${rows.length} firm${rows.length === 1 ? "" : "s"}`;

  const head = TABLE_COLS.map((c) =>
    `<th data-key="${c.field}" class="${c.field === sortKey ? "sorted" : ""}">${c.label}<span class="arrow">${c.field === sortKey ? (dir > 0 ? "▲" : "▼") : "↕"}</span></th>`
  ).join("");

  const body = rows.length ? rows.map((d) => {
    const dupCls = STATE.dupIds.has(d.firmId) ? " dup" : "";
    return `<tr data-row="${d._row}">${TABLE_COLS.map((c) => cellHtml(d, c, dupCls)).join("")}</tr>`;
  }).join("") : `<tr><td colspan="${TABLE_COLS.length}"><div class="empty-note">No firms match “${esc(query)}”.</div></td></tr>`;

  const wrapEl = document.getElementById("tableWrap");
  const keepScroll = wrapEl.scrollLeft;                 // preserve horizontal position across re-render (e.g. while searching)
  wrapEl.innerHTML = `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
  wrapEl.scrollLeft = keepScroll;

  document.querySelectorAll("thead th").forEach((th) => th.addEventListener("click", () => {
    const k = th.dataset.key;
    if (TABLE_STATE.sortKey === k) TABLE_STATE.dir *= -1; else { TABLE_STATE.sortKey = k; TABLE_STATE.dir = 1; }
    renderTable();
  }));
  // Cell clicks are handled by a single delegated listener on #tableWrap (see boot).
}

function displayValue(d, c) {
  const v = d[c.field];
  if (c.type === "status") { const s = classifyStatus(v); return `<span class="pill ${s.cls}"><span class="pd"></span>${esc(s.label)}</span>`; }
  if (c.type === "bool")  return v === true ? '<span class="tick">✓</span>' : '<span class="cross">—</span>';
  if (c.type === "num")   return v != null ? v : '<span class="cross">—</span>';
  if (c.type === "money") return v != null ? `<span class="${v > 0 ? "mrr-pos" : ""}">${fmtMoney(v)}</span>` : '<span class="cross">—</span>';
  return v ? esc(v) : '<span class="cross">—</span>';
}

function cellHtml(d, c, dupCls) {
  const idFlag = c.field === "firmId" && STATE.dupIds.has(d.firmId) ? ' <span class="dup-flag" title="Duplicate Firm ID">⚠</span>' : "";
  const cls = ["editable", c.cls || "", (c.type === "num" || c.type === "money") ? "num" : "", c.field === "firmId" ? dupCls : ""].filter(Boolean).join(" ");
  return `<td class="${cls}" data-row="${d._row}" data-field="${c.field}" data-type="${c.type}">${displayValue(d, c)}${idFlag}<span class="edit-hint"></span></td>`;
}

/* -------- inline editing -------- */

/* Options a cell should offer as a dropdown, or null for free text.
   Prefers the sheet's own data validation; falls back to sensible defaults so
   categorical columns always show a populated dropdown even if validation
   couldn't be read. */
function choiceOptions(field, type) {
  const rule = STATE.validations[field];
  if (rule && rule.type === "list" && rule.options.length) return rule.options.slice();
  if ((rule && rule.type === "bool") || type === "bool") return ["TRUE", "FALSE"];
  if (field === "demoStatus" || field === "setupStatus") return [...new Set(distinctValues(field).concat(STATUS_SUGGEST))];
  if (field === "csat") return ["1", "2", "3", "4", "5"];
  return null;
}

function beginEdit(td) {
  closeDropdown();
  if (activeEditor) cancelEdit();
  const row = +td.dataset.row, field = td.dataset.field, type = td.dataset.type;
  const d = STATE.data.find((x) => x._row === row);
  if (!d) return;

  const options = choiceOptions(field, type);
  if (options) { openDropdown(td, d, field, type, options); return; }   // dropdown columns

  // free-text / number / date columns
  const cur = d[field];
  td.classList.add("editing");
  const prevHtml = td.innerHTML;
  let editor;
  if (type === "rep") {
    const listId = `dl-${field}`;
    ensureDatalist(listId, distinctValues(field));
    editor = document.createElement("input");
    editor.setAttribute("list", listId);
    editor.value = cur || "";
  } else if (type === "num") {
    editor = document.createElement("input"); editor.type = "number"; editor.step = "1"; editor.value = cur ?? "";
  } else {
    editor = document.createElement("input"); editor.type = "text"; editor.value = (type === "money" && cur != null) ? cur : (cur || "");
  }
  editor.className = "cell-editor";
  td.innerHTML = "";
  td.appendChild(editor);
  editor.focus();
  if (editor.select) editor.select();

  activeEditor = { td, editor, prevHtml, row, field, type, d };
  // Ignore the focus churn caused by the opening click (esp. when focus was in
  // the search box) — otherwise the editor blurs & closes the instant it opens.
  let settling = true;
  setTimeout(() => { settling = false; }, 250);
  editor.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); commitEdit(); }
    else if (e.key === "Escape") { e.preventDefault(); cancelEdit(); }
  });
  editor.addEventListener("blur", () => {
    if (!activeEditor || activeEditor.editor !== editor) return;
    if (settling) { settling = false; editor.focus(); return; }   // re-grab focus once, right after opening
    commitEdit();
  });
}

function cancelEdit() {
  if (!activeEditor) return;
  const { td, prevHtml } = activeEditor;
  td.classList.remove("editing");
  td.innerHTML = prevHtml;
  rebindCell(td);
  activeEditor = null;
}

function commitEdit() {
  if (!activeEditor) return;
  const { td, field, type, d, editor } = activeEditor;
  const raw = editor.value;
  activeEditor = null;
  applyEdit(td, d, field, type, raw);
}

/* -------- floating dropdown: renders over the panel, never clipped -------- */
let ddState = null;
function openDropdown(td, d, field, type, options) {
  closeDropdown();
  td.classList.add("editing");
  const curStr = d[field] === true ? "TRUE" : d[field] === false ? "FALSE" : String(d[field] ?? "");
  const list = options.map(String);

  const pop = document.createElement("div");
  pop.className = "dd-pop";
  const items = [`<button type="button" class="dd-item dd-clear" data-v="">— clear</button>`];
  if (curStr !== "" && !list.includes(curStr))
    items.push(`<button type="button" class="dd-item dd-cur" data-v="${esc(curStr)}">${esc(curStr)}<span class="dd-tag">current · off-list</span></button>`);
  for (const o of list)
    items.push(`<button type="button" class="dd-item${o === curStr ? " sel" : ""}" data-v="${esc(o)}">${esc(o)}${o === curStr ? '<span class="dd-check">✓</span>' : ""}</button>`);
  pop.innerHTML = `<div class="dd-scroll">${items.join("")}</div>`;
  document.body.appendChild(pop);
  positionDropdown(pop, td);

  ddState = { pop, td, d, field, type };
  pop.querySelectorAll(".dd-item").forEach((btn) => btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const ctx = ddState, v = btn.dataset.v;
    closeDropdown();
    applyEdit(ctx.td, ctx.d, ctx.field, ctx.type, v);
  }));
  const sel = pop.querySelector(".dd-item.sel");
  if (sel) sel.scrollIntoView({ block: "nearest" });

  // Opened from a 'click' handler — the opening mousedown already fired, so we can
  // attach the outside-close listener synchronously (no fragile setTimeout race).
  document.addEventListener("mousedown", ddOutside, true);
  document.addEventListener("keydown", ddKey, true);
  window.addEventListener("scroll", ddScroll, true);
  window.addEventListener("resize", closeDropdown, true);
}
function positionDropdown(pop, td) {
  const r = td.getBoundingClientRect();
  const w = Math.max(r.width, 190);
  pop.style.width = w + "px";
  pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8)) + "px";

  // Size the list to the space actually available so it always fits and scrolls.
  const margin = 10, gap = 6;
  const spaceBelow = window.innerHeight - r.bottom - margin;
  const spaceAbove = r.top - margin;
  const openUp = spaceBelow < 200 && spaceAbove > spaceBelow;
  const avail = Math.max(120, openUp ? spaceAbove : spaceBelow);
  const scroll = pop.querySelector(".dd-scroll");
  if (scroll) scroll.style.maxHeight = Math.min(300, avail - 12) + "px";
  const popH = pop.offsetHeight;
  pop.style.top = (openUp ? (r.top - popH - gap) : (r.bottom + gap)) + "px";
}
// Close on page/table scroll, but NOT when scrolling inside the dropdown itself.
function ddScroll(e) { if (ddState && ddState.pop.contains(e.target)) return; closeDropdown(); }
function ddOutside(e) { if (ddState && !ddState.pop.contains(e.target)) closeDropdown(); }
function ddKey(e) { if (e.key === "Escape") { e.preventDefault(); closeDropdown(); } }
function closeDropdown() {
  if (!ddState) return;
  const { pop, td } = ddState;
  ddState = null;
  pop.remove();
  if (!td.classList.contains("saving") && !td.classList.contains("saved")) td.classList.remove("editing");
  document.removeEventListener("mousedown", ddOutside, true);
  document.removeEventListener("keydown", ddKey, true);
  window.removeEventListener("scroll", ddScroll, true);
  window.removeEventListener("resize", closeDropdown, true);
}

/* -------- apply an edit + optimistic write-back (shared by input & dropdown) -------- */
async function applyEdit(td, d, field, type, raw) {
  raw = (raw ?? "").toString().trim();
  let newVal;
  if (type === "bool") newVal = raw === "TRUE" ? true : raw === "FALSE" ? false : null;
  else if (type === "num" || type === "money") newVal = raw === "" ? null : toNumber(raw);
  else newVal = raw;

  const oldVal = d[field];
  const unchanged = (type === "num" || type === "money")
    ? (toNumber(oldVal) === toNumber(raw) || (oldVal == null && raw === ""))
    : String(oldVal ?? "") === String(newVal ?? "");
  if (unchanged) { td.classList.remove("editing"); td.innerHTML = displayValueWrap(d, field); rebindCell(td); return; }

  td.classList.remove("editing");
  td.classList.add("saving");
  td.innerHTML = `<span class="cell-spinner"></span>`;
  try {
    await writeCell(d._row, field, raw);
    const justCompletedSetup = field === "setupStatus" && isCompleted(newVal) && !isCompleted(oldVal);
    d[field] = newVal;
    STATE.dupIds = computeDuplicates(STATE.data);
    td.classList.remove("saving");
    td.classList.add("saved");
    renderDerived();
    refreshCell(td, d, field);
    setTimeout(() => td.classList.remove("saved"), 1200);
    if (justCompletedSetup) celebrate();               // 🎉 setup complete!
  } catch (err) {
    td.classList.remove("saving");
    td.classList.add("save-err");
    td.innerHTML = displayValueWrap(d, field);
    rebindCell(td);
    toast(`Couldn't save ${field}: ${err.message}`, "err");
    setTimeout(() => td.classList.remove("save-err"), 2000);
  }
}
function rebindCell(td) { /* no-op: clicks handled by the delegated #tableWrap listener */ }

/* Page-wide confetti burst — fired when a setup is marked Completed. */
function celebrate() {
  const c = document.createElement("canvas");
  c.style.cssText = "position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:9999";
  document.body.appendChild(c);
  const ctx = c.getContext("2d");
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  c.width = innerWidth * dpr; c.height = innerHeight * dpr; ctx.scale(dpr, dpr);
  const colors = ["#068bff", "#03b0db", "#a2daf3", "#f76300", "#0ca35a", "#4a3aa7", "#eda100"];
  const parts = Array.from({ length: 180 }, (_, i) => ({
    x: Math.random() * innerWidth,
    y: -20 - Math.random() * innerHeight * 0.4,
    vx: (Math.random() - 0.5) * 7,
    vy: 3 + Math.random() * 6,
    w: 6 + Math.random() * 7, h: 8 + Math.random() * 9,
    rot: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.35,
    color: colors[i % colors.length], shape: Math.random() < 0.5 ? 0 : 1,
  }));
  const dur = 2800; let start = null;
  function frame(t) {
    if (start == null) start = t;
    const el = t - start;
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    const fade = el > dur - 700 ? Math.max(0, (dur - el) / 700) : 1;
    for (const p of parts) {
      p.x += p.vx; p.y += p.vy; p.vy += 0.13; p.vx *= 0.99; p.rot += p.vr;
      ctx.save(); ctx.globalAlpha = fade; ctx.translate(p.x, p.y); ctx.rotate(p.rot); ctx.fillStyle = p.color;
      if (p.shape === 0) ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      else { ctx.beginPath(); ctx.ellipse(0, 0, p.w / 2, p.h / 2, 0, 0, 7); ctx.fill(); }
      ctx.restore();
    }
    if (el < dur) requestAnimationFrame(frame); else c.remove();
  }
  requestAnimationFrame(frame);
}

function displayValueWrap(d, field) {
  const c = TABLE_COLS.find((x) => x.field === field);
  const idFlag = field === "firmId" && STATE.dupIds.has(d.firmId) ? ' <span class="dup-flag" title="Duplicate Firm ID">⚠</span>' : "";
  return displayValue(d, c) + idFlag + '<span class="edit-hint"></span>';
}
function refreshCell(td, d, field) {
  td.innerHTML = displayValueWrap(d, field);
  // dup highlight can change for the firmId column
  if (field === "firmId") td.classList.toggle("dup", STATE.dupIds.has(d.firmId));
  // (clicks handled by the delegated #tableWrap listener — no per-cell rebind)
  // if IDs changed, other rows' dup state may change → cheap: mark all firmId cells
  document.querySelectorAll('td[data-field="firmId"]').forEach((cellTd) => {
    const r = +cellTd.dataset.row, rd = STATE.data.find((x) => x._row === r);
    if (rd) cellTd.classList.toggle("dup", STATE.dupIds.has(rd.firmId));
  });
}

const STATUS_SUGGEST = ["Scheduled", "Completed", "Completed - Won", "Completed - Lost", "Rescheduled", "No Show", "Cancelled", "In Progress", "Not Started"];
function ensureDatalist(id, values) {
  let dl = document.getElementById(id);
  if (!dl) { dl = document.createElement("datalist"); dl.id = id; document.body.appendChild(dl); }
  dl.innerHTML = [...new Set(values)].map((v) => `<option value="${esc(v)}"></option>`).join("");
}

/* --------------------------------------------------------------------------
   Derived re-render (everything except rebuilding the whole table)
   -------------------------------------------------------------------------- */
function renderDerived() {
  const data = activeData();
  const m = computeMetrics(data);
  renderKPIs(m); renderFunnel(m); renderCsat(m);
  renderDistribution("demoDist", distribution(data, "demoStatus"));
  renderDistribution("setupDist", distribution(data, "setupStatus"));
  renderLostReasons(data);
  renderReps(data);
  renderTrend(data);
  renderAttention(data);
  renderNeedsReview();                                   // always across the full sheet
  document.getElementById("firmTotal").textContent = STATE.data.length;
  const cnt = document.getElementById("fltCount");
  if (cnt) cnt.textContent = filterActive() ? `Showing ${data.length} of ${STATE.data.length}` : `${STATE.data.length} firms`;
  const clr = document.getElementById("fltClear");
  if (clr) clr.classList.toggle("hidden", !filterActive());
}
function renderAll() { populateFilters(); renderDerived(); renderTable(); stampUpdated(); }
function stampUpdated() {
  document.getElementById("updated").textContent = new Date().toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/* --------------------------------------------------------------------------
   Toast
   -------------------------------------------------------------------------- */
function toast(msg, kind) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.className = "toast show " + (kind || "");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.className = "toast"), 3800);
}

/* --------------------------------------------------------------------------
   GOOGLE SHEETS API
   -------------------------------------------------------------------------- */
async function apiFetch(url, opts = {}) {
  await ensureToken();
  const res = await fetch(url, { ...opts, headers: { Authorization: `Bearer ${STATE.token}`, "Content-Type": "application/json", ...(opts.headers || {}) } });
  if (res.status === 401) { STATE.token = null; await ensureToken(); return apiFetch(url, opts); }
  if (!res.ok) { const t = await res.text(); throw new Error(`${res.status} ${t.slice(0, 120)}`); }
  return res.json();
}

async function resolveSheetTitle() {
  const meta = await apiFetch(`https://sheets.googleapis.com/v4/spreadsheets/${CONFIG.SHEET_ID}?fields=sheets(properties(sheetId,title))`);
  const match = (meta.sheets || []).find((s) => s.properties.sheetId === CONFIG.GID);
  STATE.sheetTitle = (match || meta.sheets[0]).properties.title;
}

async function loadData() {
  if (MOCK) return loadMock();
  if (!STATE.sheetTitle) await resolveSheetTitle();
  const range = encodeURIComponent(quoteTitle(STATE.sheetTitle));
  const json = await apiFetch(`https://sheets.googleapis.com/v4/spreadsheets/${CONFIG.SHEET_ID}/values/${range}?majorDimension=ROWS`);
  const values = json.values || [];
  STATE.header = values[0] || [];
  STATE.cols = resolveColumns(STATE.header);
  STATE.data = values.slice(1)
    .map((r, i) => normalizeRow(r, i + 2))         // sheet row = index + 2 (header is row 1)
    .filter((d) => d.firmName || d.firmId);
  STATE.dupIds = computeDuplicates(STATE.data);
  await loadValidations();
}

/* Read the sheet's data-validation (dropdown) rules so the inline editors
   offer exactly the same options the sheet does. Non-fatal on failure. */
async function loadValidations() {
  STATE.validations = {};
  try {
    const lastCol = colLetter(Math.max(0, (STATE.header.length || 14) - 1));
    const range = `${quoteTitle(STATE.sheetTitle)}!A2:${lastCol}200`;
    const fields = "sheets(data(rowData(values(dataValidation))))";
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${CONFIG.SHEET_ID}?ranges=${encodeURIComponent(range)}&includeGridData=true&fields=${encodeURIComponent(fields)}`;
    const json = await apiFetch(url);
    const rowData = json.sheets?.[0]?.data?.[0]?.rowData || [];

    const pendingRanges = {};       // field -> A1 range ref (ONE_OF_RANGE)
    const refSet = new Set();
    for (const [field, colIdx] of Object.entries(STATE.cols)) {
      if (colIdx == null || colIdx < 0) continue;
      for (const rd of rowData) {
        const dv = rd.values?.[colIdx]?.dataValidation;
        if (!dv || !dv.condition) continue;
        const t = dv.condition.type;
        if (t === "ONE_OF_LIST") {
          STATE.validations[field] = { type: "list", options: (dv.condition.values || []).map((v) => v.userEnteredValue).filter((x) => x != null && x !== "") };
        } else if (t === "ONE_OF_RANGE") {
          const ref = (dv.condition.values?.[0]?.userEnteredValue || "").replace(/^=/, "");
          if (ref) { pendingRanges[field] = ref; refSet.add(ref); }
        } else if (t === "BOOLEAN") {
          STATE.validations[field] = { type: "bool" };
        }
        break; // first row carrying a rule for this column is enough
      }
    }

    // Resolve dropdowns backed by a range (ONE_OF_RANGE).
    if (refSet.size) {
      const refs = [...refSet];
      const qs = refs.map((r) => `ranges=${encodeURIComponent(r)}`).join("&");
      const b = await apiFetch(`https://sheets.googleapis.com/v4/spreadsheets/${CONFIG.SHEET_ID}/values:batchGet?${qs}&majorDimension=COLUMNS`);
      const byRef = {};
      (b.valueRanges || []).forEach((vr, i) => { byRef[refs[i]] = (vr.values?.[0] || []).filter((x) => x !== ""); });
      for (const [field, ref] of Object.entries(pendingRanges)) {
        if (byRef[ref] && byRef[ref].length) STATE.validations[field] = { type: "list", options: byRef[ref] };
      }
    }
  } catch (e) {
    console.warn("Couldn't read sheet dropdowns; falling back to suggestions.", e);
  }
}

async function writeCell(rowNumber, field, value) {
  const colIdx = STATE.cols[field];
  if (colIdx == null || colIdx < 0) throw new Error(`column "${field}" not found in sheet`);
  const a1 = `${quoteTitle(STATE.sheetTitle)}!${colLetter(colIdx)}${rowNumber}`;
  if (MOCK) { await new Promise((r) => setTimeout(r, 350)); return; }   // simulate latency
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${CONFIG.SHEET_ID}/values/${encodeURIComponent(a1)}?valueInputOption=USER_ENTERED`;
  await apiFetch(url, { method: "PUT", body: JSON.stringify({ range: a1, majorDimension: "ROWS", values: [[value]] }) });
}

/* --------------------------------------------------------------------------
   AUTH (Google Identity Services, token model)
   -------------------------------------------------------------------------- */
function ensureToken() {
  return new Promise((resolve, reject) => {
    if (MOCK) return resolve();
    if (STATE.token && Date.now() < STATE.tokenExp - 60000) return resolve();
    STATE.tokenClient.callback = (resp) => {
      if (resp.error) return reject(new Error(resp.error));
      STATE.token = resp.access_token;
      STATE.tokenExp = Date.now() + (resp.expires_in || 3600) * 1000;
      resolve();
    };
    try { STATE.tokenClient.requestAccessToken({ prompt: STATE.token ? "" : "" }); }
    catch (e) { reject(e); }
  });
}

async function fetchUserInfo() {
  const res = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", { headers: { Authorization: `Bearer ${STATE.token}` } });
  if (!res.ok) throw new Error("Couldn't read your Google profile");
  return res.json();
}

async function signIn() {
  if (MOCK) { STATE.user = { email: "you@lawmatics.com", name: "Mock User", picture: "" }; return afterSignIn(); }
  if (!CONFIG.CLIENT_ID) { showGate("config"); return; }
  setGateBusy(true);
  try {
    await ensureToken();
    const info = await fetchUserInfo();
    if (!info.email || !info.email.toLowerCase().endsWith("@" + CONFIG.ALLOWED_DOMAIN)) {
      revokeToken();
      showGate("denied", info.email || "");
      return;
    }
    STATE.user = { email: info.email, name: info.name || info.email, picture: info.picture || "" };
    await afterSignIn();
  } catch (err) {
    setGateBusy(false);
    showGate("error", err.message);
  }
}

function revokeToken() {
  try { if (STATE.token && google?.accounts?.oauth2) google.accounts.oauth2.revoke(STATE.token, () => {}); } catch {}
  STATE.token = null; STATE.tokenExp = 0;
}
function signOut() {
  revokeToken(); STATE.user = null; STATE.data = [];
  document.getElementById("app").classList.add("hidden");
  document.getElementById("metaLine").classList.add("hidden");
  showGate("signin");
}

async function afterSignIn() {
  document.getElementById("gate").classList.add("hidden");
  document.getElementById("app").classList.remove("hidden");
  document.getElementById("metaLine").classList.remove("hidden");
  renderUserChip();
  await refresh();
}

function renderUserChip() {
  const chip = document.getElementById("userChip");
  if (!STATE.user) { chip.classList.add("hidden"); return; }
  chip.classList.remove("hidden");
  chip.innerHTML = `
    ${STATE.user.picture ? `<img src="${esc(STATE.user.picture)}" alt="" referrerpolicy="no-referrer">` : `<span class="avatar-fallback">${esc((STATE.user.name || "?")[0].toUpperCase())}</span>`}
    <span class="uc-name">${esc(STATE.user.name)}</span>
    <button class="uc-signout" id="signOutBtn" title="Sign out">Sign out</button>`;
  document.getElementById("signOutBtn").addEventListener("click", signOut);
}

/* --------------------------------------------------------------------------
   Gate (sign-in / errors)
   -------------------------------------------------------------------------- */
function showGate(kind, detail) {
  const gate = document.getElementById("gate");
  gate.classList.remove("hidden");
  document.getElementById("app").classList.add("hidden");
  document.getElementById("metaLine").classList.add("hidden");
  const body = document.getElementById("gateBody");
  const btn = `<button class="g-signin" id="gateSignIn"><svg viewBox="0 0 24 24" width="18" height="18"><path fill="#4285F4" d="M22.5 12.2c0-.7-.1-1.4-.2-2H12v3.9h5.9a5 5 0 0 1-2.2 3.3v2.7h3.6c2.1-2 3.2-4.9 3.2-7.9z"/><path fill="#34A853" d="M12 23c2.9 0 5.4-1 7.2-2.7l-3.6-2.7c-1 .7-2.3 1.1-3.6 1.1-2.8 0-5.1-1.9-6-4.4H2.3v2.8A11 11 0 0 0 12 23z"/><path fill="#FBBC05" d="M6 14.3a6.6 6.6 0 0 1 0-4.2V7.3H2.3a11 11 0 0 0 0 9.8L6 14.3z"/><path fill="#EA4335" d="M12 5.4c1.6 0 3 .5 4.1 1.6l3.1-3.1A11 11 0 0 0 2.3 7.3L6 10.1c.9-2.6 3.2-4.5 6-4.5z"/></svg>Sign in with Google</button>`;
  const content = {
    signin: `<h2>Sign in to continue</h2><p>This dashboard contains internal firm data. Sign in with your <b>@${CONFIG.ALLOWED_DOMAIN}</b> Google account to view and edit.</p>${btn}`,
    denied: `<h2>Access restricted</h2><p><code>${esc(detail)}</code> isn't a <b>${CONFIG.ALLOWED_DOMAIN}</b> account. This dashboard is limited to Lawmatics team members.</p>${btn}`,
    error: `<h2>Sign-in problem</h2><p>${esc(detail || "Something went wrong.")}</p>${btn}`,
    config: `<h2>Almost there</h2><p>No OAuth <code>CLIENT_ID</code> is configured yet. Add your client ID to <code>CONFIG.CLIENT_ID</code> in <code>assets/app.js</code>, then reload.</p>
      <p class="g-hint">Tip: append <code>?mock=1</code> to the URL to preview the dashboard with sample data (no sign-in).</p>`,
  }[kind] || "";
  body.innerHTML = content;
  const s = document.getElementById("gateSignIn");
  if (s) s.addEventListener("click", signIn);
}
function setGateBusy(b) {
  const s = document.getElementById("gateSignIn");
  if (s) { s.disabled = b; s.classList.toggle("busy", b); }
}

/* --------------------------------------------------------------------------
   Refresh
   -------------------------------------------------------------------------- */
async function refresh() {
  const btn = document.getElementById("refreshBtn");
  btn.classList.add("spin");
  setBadge("", "Loading…");
  try {
    await loadData();
    renderAll();
    setBadge("", MOCK ? "Mock data" : "Live");
    if (MOCK) setBadge("stale", "Mock data");
  } catch (err) {
    setBadge("err", "Error");
    toast(`Load failed: ${err.message}`, "err");
  } finally {
    btn.classList.remove("spin");
  }
}
function setBadge(cls, text) {
  const b = document.getElementById("liveBadge");
  b.className = "live-badge " + cls;
  b.querySelector(".txt").textContent = text;
}

/* --------------------------------------------------------------------------
   Mock data (?mock=1) — includes a duplicate Firm ID to exercise Needs Review
   -------------------------------------------------------------------------- */
function loadMock() {
  STATE.sheetTitle = "Sheet1";
  STATE.header = ["Firm Name","Firm ID","Demo Status","Demo Rep","Demo Date","Demo Rescheduled Date","Set up Status","Set up #1 date","Set up #2 date","Set up closed date","Pre-set up requirements met?","Set up Rep","Set up CSAT","Closed lost reason","MRR increase","Created at"];
  STATE.cols = resolveColumns(STATE.header);
  const raw = [
    ["VIP Law","2365","Completed - Won","Justin","7/16/26","","Completed","7/17/26","7/20/26","7/20/26","TRUE","Rosa","5","","$150","7/14/26"],
    ["Harbor & Vance","2410","Completed","Priya","7/14/26","","Completed","7/15/26","","7/16/26","TRUE","Rosa","4","","$220","7/12/26"],
    ["Cedar Legal","2410","Scheduled","Marcus","7/18/26","","Not Started","","","","FALSE","","","","","7/17/26"],
    ["Alderman LLP","2501","Completed - Lost","Priya","7/10/26","7/19/26","Not Started","","","","FALSE","","","Price","","7/09/26"],
    ["Brightwater Firm","2555","Completed - Won","Justin","7/09/26","","Completed","7/11/26","7/13/26","7/13/26","TRUE","Dev","5","","$300","7/07/26"],
    ["Pinnacle Counsel","2560","Completed - Lost","Marcus","7/08/26","","Not Started","","","","FALSE","","","Chose competitor","","7/06/26"],
  ];
  STATE.data = raw.map((r, i) => normalizeRow(r, i + 2));
  STATE.dupIds = computeDuplicates(STATE.data);
  // Stand-in for the sheet's real data-validation dropdowns (fetched live in prod).
  STATE.validations = {
    demoStatus:  { type: "list", options: ["Scheduled", "Completed", "Completed - Won", "Completed - Lost", "Rescheduled", "No Show", "Cancelled"] },
    setupStatus: { type: "list", options: ["Not Started", "Scheduled", "In Progress", "Completed"] },
    csat:        { type: "list", options: ["1", "2", "3", "4", "5"] },
    preReq:      { type: "bool" },
    closedLost:  { type: "list", options: ["Chose competitor", "Price", "No response", "Not a fit", "Timing", "Went in-house"] },
  };
}

/* --------------------------------------------------------------------------
   Theme
   -------------------------------------------------------------------------- */
function initTheme() {
  const saved = localStorage.getItem("me-theme");
  if (saved) document.documentElement.setAttribute("data-theme", saved);
  document.getElementById("themeBtn").addEventListener("click", () => {
    const cur = document.documentElement.getAttribute("data-theme");
    const next = cur === "dark" ? "light" : cur === "light" ? "dark" : (matchMedia("(prefers-color-scheme: dark)").matches ? "light" : "dark");
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem("me-theme", next);
  });
}

/* --------------------------------------------------------------------------
   Boot
   -------------------------------------------------------------------------- */
function boot() {
  initTheme();
  document.getElementById("refreshBtn").addEventListener("click", () => refresh());
  document.getElementById("search").addEventListener("input", (e) => { TABLE_STATE.query = e.target.value; renderTable(); });
  // One delegated listener on the persistent table container: a click anywhere in
  // an editable cell opens its editor. Survives table re-renders; no per-cell or
  // duplicate handlers (which caused the flaky "click around till it works" bug).
  document.getElementById("tableWrap").addEventListener("click", (e) => {
    const td = e.target.closest("td.editable");
    if (td && !td.classList.contains("editing") && !td.classList.contains("saving")) beginEdit(td);
  });
  document.getElementById("reviewJump").addEventListener("click", () => document.getElementById("reviewSection").scrollIntoView({ behavior: "smooth", block: "start" }));
  ["fltRep", "fltDemo", "fltSetup"].forEach((id) => { const s = document.getElementById(id); if (s) s.addEventListener("change", onFilterChange); });
  const clr = document.getElementById("fltClear"); if (clr) clr.addEventListener("click", clearFilters);

  if (MOCK) { signIn(); return; }              // mock bypasses auth
  if (!CONFIG.CLIENT_ID) { showGate("config"); return; }

  // Init the GIS token client once the library is present.
  const start = () => {
    if (!(window.google && google.accounts && google.accounts.oauth2)) return setTimeout(start, 120);
    STATE.tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: CONFIG.CLIENT_ID,
      scope: CONFIG.SCOPES,
      hd: CONFIG.ALLOWED_DOMAIN,
      callback: () => {},
    });
    showGate("signin");
  };
  start();
}

document.addEventListener("DOMContentLoaded", boot);
