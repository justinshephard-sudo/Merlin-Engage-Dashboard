/* ==========================================================================
   Merlin Engage — Onboarding Dashboard
   Reads the tracker sheet live (published CSV via Google visualization API)
   and renders KPIs, funnel, status breakdowns, rep performance & a data table.
   ========================================================================== */

"use strict";

/* --------------------------------------------------------------------------
   CONFIG — the only thing you edit to point at a different sheet/tab.
   The sheet must be shared "Anyone with the link: Viewer" (see README).
   -------------------------------------------------------------------------- */
const CONFIG = {
  SHEET_ID: "1xWc_E48--rSjxA-3oBIKSBq1kDn-43OdbTrRsr88mYA",
  GID: "0",
  REFRESH_MS: 5 * 60 * 1000, // auto-refresh every 5 minutes
};

const csvUrl = () =>
  `https://docs.google.com/spreadsheets/d/${CONFIG.SHEET_ID}/gviz/tq` +
  `?tqx=out:csv&gid=${CONFIG.GID}&_cb=${Date.now()}`;

/* --------------------------------------------------------------------------
   CSV parsing (RFC-4180-ish: quoted fields, escaped quotes, newlines)
   -------------------------------------------------------------------------- */
function parseCSV(text) {
  const rows = [];
  let row = [], field = "", i = 0, inQ = false;
  while (i < text.length) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQ = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQ = true; i++; continue; }
    if (c === ",") { row.push(field); field = ""; i++; continue; }
    if (c === "\r") { i++; continue; }
    if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; i++; continue; }
    field += c; i++;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/* --------------------------------------------------------------------------
   Column resolution — match by header name so re-ordering columns is safe.
   -------------------------------------------------------------------------- */
const FIELD_MATCHERS = {
  firmName:        (h) => h === "firm name",
  firmId:          (h) => h === "firm id",
  demoStatus:      (h) => h === "demo status",
  demoRep:         (h) => h === "demo rep",
  demoDate:        (h) => h === "demo date",
  demoResched:     (h) => h.includes("reschedul"),
  setupStatus:     (h) => (h.includes("set up") || h.includes("setup")) && h.includes("status"),
  setup1Date:      (h) => h.includes("#1"),
  setup2Date:      (h) => h.includes("#2"),
  preReq:          (h) => h.includes("requirement"),
  setupRep:        (h) => (h.includes("set up") || h.includes("setup")) && h.includes("rep"),
  csat:            (h) => h.includes("csat"),
  closedLost:      (h) => h.includes("closed lost"),
  mrr:             (h) => h.includes("mrr"),
};

function resolveColumns(headerRow) {
  const map = {};
  const norm = headerRow.map((h) => (h || "").trim().toLowerCase());
  for (const [key, test] of Object.entries(FIELD_MATCHERS)) {
    map[key] = norm.findIndex(test);
  }
  return map;
}

/* --------------------------------------------------------------------------
   Normalization helpers
   -------------------------------------------------------------------------- */
const cell = (row, idx) => (idx >= 0 && idx < row.length ? (row[idx] || "").trim() : "");

function toNumber(v) {
  if (v == null) return null;
  const n = parseFloat(String(v).replace(/[^0-9.\-]/g, ""));
  return isNaN(n) ? null : n;
}
function toBool(v) {
  const s = String(v).trim().toLowerCase();
  if (["true", "yes", "y", "1", "✓", "checked"].includes(s)) return true;
  if (["false", "no", "n", "0", ""].includes(s)) return false;
  return null;
}

/* Map any raw status string to a { label, cls } used for pills & colors. */
function classifyStatus(raw) {
  const s = (raw || "").trim();
  const l = s.toLowerCase();
  if (!l) return { label: "—", cls: "neutral" };
  if (/(closed\s*)?lost|churn|declin/.test(l)) return { label: s, cls: "critical" };
  if (/complet|done|finish|live|won/.test(l))  return { label: s, cls: "good" };
  if (/no[-\s]?show|cancel|missed/.test(l))     return { label: s, cls: "serious" };
  if (/reschedul|delay|pending|hold/.test(l))   return { label: s, cls: "warn" };
  if (/schedul|book|set|progress|active/.test(l)) return { label: s, cls: "info" };
  if (/not\s*start|todo|to do|new|n\/?a/.test(l)) return { label: s, cls: "neutral" };
  return { label: s, cls: "info" };
}

function normalizeRows(rows, cols) {
  const out = [];
  for (const r of rows) {
    const firmName = cell(r, cols.firmName);
    const firmId = cell(r, cols.firmId);
    if (!firmName && !firmId) continue; // skip blank rows
    out.push({
      firmName: firmName || "(unnamed)",
      firmId,
      demoStatus: cell(r, cols.demoStatus),
      demoRep: cell(r, cols.demoRep),
      demoDate: cell(r, cols.demoDate),
      demoResched: cell(r, cols.demoResched),
      setupStatus: cell(r, cols.setupStatus),
      setup1Date: cell(r, cols.setup1Date),
      setup2Date: cell(r, cols.setup2Date),
      preReq: toBool(cell(r, cols.preReq)),
      setupRep: cell(r, cols.setupRep),
      csat: toNumber(cell(r, cols.csat)),
      closedLost: cell(r, cols.closedLost),
      mrr: toNumber(cell(r, cols.mrr)),
    });
  }
  return out;
}

/* --------------------------------------------------------------------------
   Metrics
   -------------------------------------------------------------------------- */
const isCompleted = (s) => /complet|done|finish|live|won/i.test(s || "");
const isScheduled = (s) => /schedul|book|set|progress|active/i.test(s || "");

function computeMetrics(data) {
  const total = data.length;
  const demosCompleted = data.filter((d) => isCompleted(d.demoStatus)).length;
  const setupScheduled = data.filter(
    (d) => isScheduled(d.setupStatus) || isCompleted(d.setupStatus) || d.setup1Date
  ).length;
  const setupCompleted = data.filter((d) => isCompleted(d.setupStatus)).length;
  const won = data.filter((d) => (d.mrr || 0) > 0).length;
  const closedLost = data.filter((d) => d.closedLost && d.closedLost !== "").length;

  const csats = data.map((d) => d.csat).filter((n) => n != null);
  const avgCsat = csats.length ? csats.reduce((a, b) => a + b, 0) / csats.length : null;

  const mrrTotal = data.reduce((a, d) => a + (d.mrr || 0), 0);
  const preReqMet = data.filter((d) => d.preReq === true).length;

  return {
    total, demosCompleted, setupScheduled, setupCompleted, won, closedLost,
    avgCsat, csatCount: csats.length, mrrTotal, preReqMet,
    demoRate: total ? demosCompleted / total : 0,
    setupRate: demosCompleted ? setupCompleted / demosCompleted : 0,
    lostRate: total ? closedLost / total : 0,
  };
}

function groupBy(data, keyFn, valFns) {
  const groups = {};
  for (const d of data) {
    const k = keyFn(d);
    if (!k) continue;
    (groups[k] = groups[k] || []).push(d);
  }
  return Object.entries(groups).map(([name, rows]) => {
    const o = { name, count: rows.length };
    for (const [label, fn] of Object.entries(valFns || {})) o[label] = fn(rows);
    return o;
  });
}

function distribution(data, field) {
  const counts = {};
  for (const d of data) {
    const raw = d[field] && d[field].trim() ? d[field].trim() : "—";
    counts[raw] = (counts[raw] || 0) + 1;
  }
  return Object.entries(counts)
    .map(([label, count]) => ({ label, count, ...classifyStatus(label) }))
    .sort((a, b) => b.count - a.count);
}

/* --------------------------------------------------------------------------
   Formatting
   -------------------------------------------------------------------------- */
const fmtMoney = (n) =>
  "$" + Math.round(n || 0).toLocaleString("en-US");
const fmtPct = (n) => (n * 100).toFixed(n >= 0.1 || n === 0 ? 0 : 1) + "%";
const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/* --------------------------------------------------------------------------
   Tooltip
   -------------------------------------------------------------------------- */
const tip = () => document.getElementById("tip");
function showTip(html, x, y) {
  const t = tip();
  t.innerHTML = html;
  t.style.opacity = "1";
  const r = t.getBoundingClientRect();
  let left = x + 14, top = y + 14;
  if (left + r.width > window.innerWidth - 8) left = x - r.width - 14;
  if (top + r.height > window.innerHeight - 8) top = y - r.height - 14;
  t.style.left = left + "px";
  t.style.top = top + "px";
}
function hideTip() { tip().style.opacity = "0"; }
function bindTip(el, html) {
  el.addEventListener("mousemove", (e) => showTip(html, e.clientX, e.clientY));
  el.addEventListener("mouseleave", hideTip);
}

/* --------------------------------------------------------------------------
   Icons (inline SVG)
   -------------------------------------------------------------------------- */
const ICON = {
  firms: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21h18M6 21V7l6-4 6 4v14"/><path d="M10 9h.01M14 9h.01M10 13h.01M14 13h.01M10 17h.01M14 17h.01"/></svg>',
  demo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="14" rx="2"/><path d="M8 21h8M12 18v3M10 9l4 2-4 2z"/></svg>',
  setup: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 7h-9M14 17H5M17 3l3 4-3 4M7 21l-3-4 3-4"/></svg>',
  star: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l3.1 6.3 6.9 1-5 4.9 1.2 6.9L12 17.8 5.8 21l1.2-6.9-5-4.9 6.9-1z"/></svg>',
  money: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1v22M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>',
  lost: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M15 9l-6 6M9 9l6 6"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>',
};

function starSvg(filled) {
  return `<svg viewBox="0 0 24 24" fill="${filled ? "var(--lm-orange)" : "none"}" stroke="${filled ? "var(--lm-orange)" : "var(--text-3)"}" stroke-width="1.6" stroke-linejoin="round"><path d="M12 2l3.1 6.3 6.9 1-5 4.9 1.2 6.9L12 17.8 5.8 21l1.2-6.9-5-4.9 6.9-1z"/></svg>`;
}

/* --------------------------------------------------------------------------
   RENDER
   -------------------------------------------------------------------------- */
function renderKPIs(m) {
  const tiles = [
    { label: "Firms in Pipeline", val: m.total, icon: ICON.firms, accent: "var(--lm-blue)", soft: "rgba(6,139,255,.12)",
      sub: `<span class="chip neu">${m.preReqMet} pre-reqs met</span>` },
    { label: "Demos Completed", val: m.demosCompleted, icon: ICON.demo, accent: "var(--lm-cyan)", soft: "rgba(3,176,219,.12)",
      sub: `<span class="chip ${m.demoRate >= 0.5 ? "pos" : "neu"}">${fmtPct(m.demoRate)} of pipeline</span>` },
    { label: "Setups Completed", val: m.setupCompleted, icon: ICON.setup, accent: "#2f6db0", soft: "rgba(47,109,176,.14)",
      sub: `<span class="chip neu">${m.setupScheduled} scheduled</span>` },
    { label: "Avg Setup CSAT", val: m.avgCsat != null ? m.avgCsat.toFixed(1) : "—", unit: m.avgCsat != null ? "/5" : "", icon: ICON.star, accent: "var(--lm-orange)", soft: "rgba(247,99,0,.12)",
      sub: `<span class="chip neu">${m.csatCount} rated</span>` },
    { label: "MRR Added", val: fmtMoney(m.mrrTotal), icon: ICON.money, accent: "var(--st-good)", soft: "rgba(12,163,90,.13)",
      sub: `<span class="chip pos">${m.won} firm${m.won === 1 ? "" : "s"} won</span>` },
    { label: "Closed Lost", val: m.closedLost, icon: ICON.lost, accent: "var(--st-critical)", soft: "rgba(216,58,58,.12)",
      sub: `<span class="chip ${m.closedLost ? "neg" : "neu"}">${fmtPct(m.lostRate)} of pipeline</span>` },
  ];
  document.getElementById("kpis").innerHTML = tiles.map((t) => `
    <div class="kpi" style="--accent:${t.accent};--accent-soft:${t.soft}">
      <div class="kpi-top">
        <span class="kpi-label">${t.label}</span>
        <span class="kpi-ico">${t.icon}</span>
      </div>
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
    { name: "Won (MRR added)", count: m.won, color: "var(--fn-5)" },
  ];
  const top = Math.max(1, stages[0].count);
  const el = document.getElementById("funnel");
  el.innerHTML = stages.map((s, i) => {
    const pctTop = s.count / top;
    const prev = i === 0 ? s.count : stages[i - 1].count;
    const conv = prev ? s.count / prev : 0;
    const w = Math.max(2, pctTop * 100);
    return `<div class="fn-row" data-i="${i}">
      <div class="fn-meta">
        <span class="fn-name">${s.name}</span>
        <span class="fn-nums"><b>${s.count}</b><span class="pct">${fmtPct(pctTop)} of top${i ? ` · ${fmtPct(conv)} step conv.` : ""}</span></span>
      </div>
      <div class="fn-track"><div class="fn-bar" style="width:${w}%;background:${s.color}"></div></div>
    </div>`;
  }).join("");
  el.querySelectorAll(".fn-row").forEach((row) => {
    const s = stages[+row.dataset.i];
    bindTip(row, `<div class="tt-t">${esc(s.name)}</div><div class="tt-r"><span>Firms</span><b>${s.count}</b></div><div class="tt-r"><span>of pipeline</span><b>${fmtPct(s.count / top)}</b></div>`);
  });
}

function renderDistribution(elId, dist, useStatusColor) {
  const el = document.getElementById(elId);
  if (!dist.length) { el.innerHTML = `<div class="empty-note">No data yet.</div>`; return; }
  const max = Math.max(...dist.map((d) => d.count));
  const statusVar = { good: "--st-good", info: "--st-info", warn: "--st-warn", serious: "--st-serious", critical: "--st-critical", neutral: "--st-neutral" };
  el.innerHTML = dist.map((d) => {
    const color = useStatusColor ? `var(${statusVar[d.cls]})` : "var(--lm-blue)";
    const w = Math.max(3, (d.count / max) * 100);
    return `<div class="bl-row">
      <span class="bl-label"><span class="swatch" style="background:${color}"></span>${esc(d.label)}</span>
      <span class="bl-track"><span class="bl-bar" style="width:${w}%;background:${color}"></span></span>
      <span class="bl-val">${d.count}</span>
    </div>`;
  }).join("");
  el.querySelectorAll(".bl-row").forEach((row, i) => {
    const d = dist[i];
    bindTip(row, `<div class="tt-t">${esc(d.label)}</div><div class="tt-r"><span>Firms</span><b>${d.count}</b></div>`);
  });
}

function renderCsat(m, data) {
  const el = document.getElementById("csat");
  if (m.avgCsat == null) { el.innerHTML = `<div class="empty-note">No CSAT scores recorded yet.</div>`; return; }
  const rounded = Math.round(m.avgCsat);
  const stars = Array.from({ length: 5 }, (_, i) => starSvg(i < rounded)).join("");
  el.innerHTML = `
    <div class="csat-wrap">
      <div>
        <div class="csat-num">${m.avgCsat.toFixed(1)}<span class="den"> / 5</span></div>
        <div class="stars">${stars}</div>
        <div class="csat-note">Across ${m.csatCount} rated setup${m.csatCount === 1 ? "" : "s"}</div>
      </div>
    </div>`;
}

function renderReps(data) {
  const demoReps = groupBy(data.filter((d) => d.demoRep), (d) => d.demoRep, {
    completed: (rows) => rows.filter((r) => isCompleted(r.demoStatus)).length,
  }).sort((a, b) => b.count - a.count);

  const setupReps = groupBy(data.filter((d) => d.setupRep), (d) => d.setupRep, {
    completed: (rows) => rows.filter((r) => isCompleted(r.setupStatus)).length,
    avgCsat: (rows) => {
      const c = rows.map((r) => r.csat).filter((n) => n != null);
      return c.length ? c.reduce((a, b) => a + b, 0) / c.length : null;
    },
  }).sort((a, b) => b.count - a.count);

  const repRow = (name, primary, secondary, max) => {
    const w = Math.max(3, (primary / max) * 100);
    return `<div class="bl-row">
      <span class="bl-label">${esc(name)}</span>
      <span class="bl-track"><span class="bl-bar" style="width:${w}%;background:var(--lm-blue)"></span></span>
      <span class="bl-val">${secondary}</span>
    </div>`;
  };

  const demoEl = document.getElementById("demoReps");
  if (!demoReps.length) demoEl.innerHTML = `<div class="empty-note">No demo reps yet.</div>`;
  else {
    const max = Math.max(...demoReps.map((r) => r.count));
    demoEl.innerHTML = demoReps.map((r) => repRow(r.name, r.count, `${r.completed}/${r.count}`, max)).join("");
    demoEl.querySelectorAll(".bl-row").forEach((row, i) => {
      const r = demoReps[i];
      bindTip(row, `<div class="tt-t">${esc(r.name)}</div><div class="tt-r"><span>Demos</span><b>${r.count}</b></div><div class="tt-r"><span>Completed</span><b>${r.completed}</b></div>`);
    });
  }

  const setupEl = document.getElementById("setupReps");
  if (!setupReps.length) setupEl.innerHTML = `<div class="empty-note">No setup reps yet.</div>`;
  else {
    const max = Math.max(...setupReps.map((r) => r.count));
    setupEl.innerHTML = setupReps.map((r) =>
      repRow(r.name, r.count, r.avgCsat != null ? `${r.count} · ${r.avgCsat.toFixed(1)}★` : `${r.count}`, max)
    ).join("");
    setupEl.querySelectorAll(".bl-row").forEach((row, i) => {
      const r = setupReps[i];
      const csat = r.avgCsat != null ? r.avgCsat.toFixed(1) + " / 5" : "—";
      bindTip(row, `<div class="tt-t">${esc(r.name)}</div><div class="tt-r"><span>Setups</span><b>${r.count}</b></div><div class="tt-r"><span>Completed</span><b>${r.completed}</b></div><div class="tt-r"><span>Avg CSAT</span><b>${csat}</b></div>`);
    });
  }
}

/* -------- Table (searchable + sortable) -------- */
const TABLE_COLS = [
  { key: "firmName", label: "Firm", cls: "firm" },
  { key: "firmId", label: "ID" },
  { key: "demoStatus", label: "Demo", type: "status" },
  { key: "demoRep", label: "Demo Rep" },
  { key: "demoDate", label: "Demo Date" },
  { key: "setupStatus", label: "Setup", type: "status" },
  { key: "setup1Date", label: "Setup #1" },
  { key: "setup2Date", label: "Setup #2" },
  { key: "preReq", label: "Pre-reqs", type: "bool" },
  { key: "setupRep", label: "Setup Rep" },
  { key: "csat", label: "CSAT", type: "num" },
  { key: "closedLost", label: "Closed Lost Reason" },
  { key: "mrr", label: "MRR", type: "money" },
];

let TABLE_STATE = { sortKey: "firmName", dir: 1, query: "", data: [] };

function renderTable() {
  const { data, sortKey, dir, query } = TABLE_STATE;
  const q = query.trim().toLowerCase();
  let rows = data.filter((d) =>
    !q || [d.firmName, d.firmId, d.demoRep, d.setupRep, d.demoStatus, d.setupStatus, d.closedLost]
      .some((v) => (v || "").toLowerCase().includes(q))
  );
  rows = rows.slice().sort((a, b) => {
    let av = a[sortKey], bv = b[sortKey];
    if (typeof av === "number" || typeof bv === "number") { av = av || 0; bv = bv || 0; return (av - bv) * dir; }
    return String(av || "").localeCompare(String(bv || "")) * dir;
  });

  document.getElementById("rowCount").textContent =
    `${rows.length} firm${rows.length === 1 ? "" : "s"}`;

  const head = TABLE_COLS.map((c) =>
    `<th data-key="${c.key}" class="${c.key === sortKey ? "sorted" : ""}">${c.label}<span class="arrow">${c.key === sortKey ? (dir > 0 ? "▲" : "▼") : "↕"}</span></th>`
  ).join("");

  const body = rows.length ? rows.map((d) => `<tr>${TABLE_COLS.map((c) => {
    const v = d[c.key];
    if (c.type === "status") { const s = classifyStatus(v); return `<td><span class="pill ${s.cls}"><span class="pd"></span>${esc(s.label)}</span></td>`; }
    if (c.type === "bool") return `<td>${v === true ? '<span class="tick">✓</span>' : v === false ? '<span class="cross">—</span>' : '<span class="cross">—</span>'}</td>`;
    if (c.type === "num") return `<td class="num">${v != null ? v : "—"}</td>`;
    if (c.type === "money") return `<td class="num ${v > 0 ? "mrr-pos" : ""}">${v != null ? fmtMoney(v) : "—"}</td>`;
    return `<td class="${c.cls || ""}">${v ? esc(v) : "—"}</td>`;
  }).join("")}</tr>`).join("")
    : `<tr><td colspan="${TABLE_COLS.length}"><div class="empty-note">No firms match “${esc(query)}”.</div></td></tr>`;

  document.getElementById("tableWrap").innerHTML =
    `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;

  document.querySelectorAll("thead th").forEach((th) => {
    th.addEventListener("click", () => {
      const k = th.dataset.key;
      if (TABLE_STATE.sortKey === k) TABLE_STATE.dir *= -1;
      else { TABLE_STATE.sortKey = k; TABLE_STATE.dir = 1; }
      renderTable();
    });
  });
}

/* --------------------------------------------------------------------------
   States
   -------------------------------------------------------------------------- */
function setBadge(cls, text) {
  const b = document.getElementById("liveBadge");
  b.className = "live-badge " + cls;
  b.querySelector(".txt").textContent = text;
}
function showError(msg) {
  setBadge("err", "Error");
  document.getElementById("content").classList.add("hidden");
  const e = document.getElementById("errState");
  e.classList.remove("hidden");
  document.getElementById("errMsg").innerHTML = msg;
}

/* --------------------------------------------------------------------------
   Load & orchestrate
   -------------------------------------------------------------------------- */
let refreshTimer = null;

async function load(isManual) {
  const btn = document.getElementById("refreshBtn");
  btn.classList.add("spin");
  if (!isManual) setBadge("", "Loading…");
  try {
    const res = await fetch(csvUrl(), { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (text.trim().startsWith("<") || text.includes("google-site-verification") || text.includes("<!DOCTYPE"))
      throw new Error("private");

    const rows = parseCSV(text);
    if (rows.length < 1) throw new Error("empty");
    const cols = resolveColumns(rows[0]);
    const data = normalizeRows(rows.slice(1), cols);

    document.getElementById("errState").classList.add("hidden");
    document.getElementById("content").classList.remove("hidden");

    const m = computeMetrics(data);
    renderKPIs(m);
    renderFunnel(m);
    renderDistribution("demoDist", distribution(data, "demoStatus"), true);
    renderDistribution("setupDist", distribution(data, "setupStatus"), true);
    renderCsat(m, data);
    renderReps(data);
    TABLE_STATE.data = data;
    renderTable();

    const now = new Date();
    document.getElementById("updated").textContent = now.toLocaleString("en-US",
      { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    document.getElementById("firmTotal").textContent = m.total;
    setBadge("", "Live");
  } catch (err) {
    if (err.message === "private") {
      showError(`This sheet isn't publicly readable yet. Open it in Google Sheets →
        <b>Share</b> → <b>General access</b> → set to <code>Anyone with the link · Viewer</code>,
        then hit refresh.`);
    } else {
      showError(`Couldn't load the sheet (<code>${esc(err.message)}</code>).
        Check the <code>SHEET_ID</code>/<code>GID</code> in <code>assets/app.js</code> and that the sheet is link-shared.`);
    }
  } finally {
    btn.classList.remove("spin");
  }
}

function initTheme() {
  const saved = localStorage.getItem("me-theme");
  if (saved) document.documentElement.setAttribute("data-theme", saved);
  document.getElementById("themeBtn").addEventListener("click", () => {
    const cur = document.documentElement.getAttribute("data-theme");
    const next = cur === "dark" ? "light" : (cur === "light" ? "dark" :
      (matchMedia("(prefers-color-scheme: dark)").matches ? "light" : "dark"));
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem("me-theme", next);
  });
}

document.addEventListener("DOMContentLoaded", () => {
  initTheme();
  document.getElementById("refreshBtn").addEventListener("click", () => load(true));
  document.getElementById("search").addEventListener("input", (e) => {
    TABLE_STATE.query = e.target.value; renderTable();
  });
  load(false);
  refreshTimer = setInterval(() => load(false), CONFIG.REFRESH_MS);
});
