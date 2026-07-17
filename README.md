# Merlin Engage — Onboarding Dashboard

A live, Lawmatics-branded dashboard for the **Merlin Engage** onboarding pipeline.
It reads the tracker Google Sheet directly (no build step, no backend) and shows
demo/setup funnel, status breakdowns, CSAT, MRR added, and rep performance.

![Static site · vanilla JS · GitHub Pages]()

---

## How it works

- `index.html` + `assets/styles.css` + `assets/app.js` — a fully static site.
- On load it fetches the sheet as CSV via Google's visualization endpoint:
  `https://docs.google.com/spreadsheets/d/<ID>/gviz/tq?tqx=out:csv&gid=<GID>`
- Columns are matched **by header name**, so re-ordering columns in the sheet
  won't break the dashboard.
- Auto-refreshes every 5 minutes; there's also a manual refresh button.

---

## One-time setup

### 1. Make the sheet readable

The dashboard runs in the visitor's browser, so the sheet must be readable
without a login:

> In the sheet: **Share → General access → Anyone with the link → Viewer**

(Read-only. No one can edit through the link.) The current sheet is already
wired up in `assets/app.js`:

```js
const CONFIG = {
  SHEET_ID: "1xWc_E48--rSjxA-3oBIKSBq1kDn-43OdbTrRsr88mYA",
  GID: "0",
};
```

To point at a different sheet/tab, change `SHEET_ID` and `GID` (the `gid` is the
number in the sheet URL after `#gid=`).

### 2. Publish to GitHub Pages

```bash
cd merlin-engage-dashboard
git add -A
git commit -m "Merlin Engage onboarding dashboard"

# create the repo on github.com (private is fine — Pages works on private repos
# for org/enterprise plans; use public if unsure), then:
git remote add origin git@github.com:<you>/merlin-engage-dashboard.git
git push -u origin main
```

Then in the repo on GitHub: **Settings → Pages → Build and deployment →
Source: Deploy from a branch → `main` / `root` → Save.**

Your dashboard will be live at
`https://<you>.github.io/merlin-engage-dashboard/` within a minute.

---

## Local preview

Any static server works, e.g.:

```bash
cd merlin-engage-dashboard
python3 -m http.server 8080
# open http://localhost:8080
```

Opening `index.html` directly via `file://` also works, but a server avoids
browser fetch quirks.

---

## The sheet columns it expects

| Column | Used for |
|---|---|
| Firm Name, Firm ID | Identity / table |
| Demo Status, Demo Rep, Demo Date | Funnel, demo breakdown, rep stats |
| Set up Status, Set up #1/#2 date, Set up Rep | Funnel, setup breakdown, rep stats |
| Pre-set up requirements met? | KPI (pre-reqs met) |
| Set up CSAT | Avg CSAT, rep CSAT |
| Closed lost reason | Closed-lost KPI |
| MRR increase | MRR added KPI, "won" funnel stage |

Missing or renamed columns degrade gracefully — the matcher looks for keywords,
and anything it can't find just shows as `—`.
