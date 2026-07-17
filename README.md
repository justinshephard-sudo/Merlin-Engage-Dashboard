# Merlin Engage — Onboarding Dashboard

A Lawmatics-branded dashboard for the **Merlin Engage** onboarding pipeline. It
reads **and writes** the tracker Google Sheet directly from the browser — no
backend. Access is restricted to `@lawmatics.com` Google accounts, and every edit
is made *as the signed-in user*, so Google's built-in **Version History** records
who changed what.

- **View + edit both require a `lawmatics.com` Google sign-in.**
- **All Firms** table is fully inline-editable; edits save straight to the sheet.
- Duplicate Firm IDs are surfaced in a **Needs Review** panel.
- Static site → deploys to **GitHub Pages**.

---

## Architecture

- `index.html` + `assets/styles.css` + `assets/app.js` — static, no build step.
- Auth: **Google Identity Services** (token model). The page requests a Sheets API
  access token scoped to the signed-in user.
- Data: **Google Sheets API v4** — `values.get` to read, `values.update` to write a
  single cell by its exact A1 range (e.g. `Sheet1!D5`). Rows are addressed by their
  **real sheet row number**, so duplicate Firm IDs never cause a mis-targeted write.
- Columns are matched **by header name**, so re-ordering columns won't break it.

---

## One-time setup

### 1. Create the OAuth client (Google Cloud Console)

1. **console.cloud.google.com** → create or select a project.
2. **APIs & Services → Library** → enable **Google Sheets API**.
3. **APIs & Services → OAuth consent screen** → **User type: Internal**
   (restricts to your Workspace domain automatically) → add app name + support
   email → add scopes:
   - `https://www.googleapis.com/auth/spreadsheets`
   - `https://www.googleapis.com/auth/userinfo.email`
4. **APIs & Services → Credentials → Create credentials → OAuth client ID** →
   **Web application**. Under **Authorized JavaScript origins** add:
   - `https://<your-github-username>.github.io`  (your Pages origin — scheme + host only, no path)
   - `http://localhost:8137`  (for local testing)
5. Copy the **Client ID** (it's public — safe to commit; there is **no** client secret).

### 2. Add the Client ID to the app

In `assets/app.js`:

```js
const CONFIG = {
  CLIENT_ID: "XXXXXXXX.apps.googleusercontent.com",   // <-- paste it here
  SHEET_ID: "1xWc_E48--rSjxA-3oBIKSBq1kDn-43OdbTrRsr88mYA",
  GID: 0,
  ALLOWED_DOMAIN: "lawmatics.com",
};
```

`GID` is the numeric tab id from the sheet URL after `#gid=`.

### 3. Lock down the sheet's sharing

Because the dashboard now reads via the authenticated Sheets API, the sheet no
longer needs to be public — and shouldn't be:

> **Share** → remove "Anyone with the link" → share with **your `lawmatics.com`
> domain** (or the specific team). Anyone who should **edit** needs **Editor**
> access; view-only users can have Viewer.

The API respects these permissions, so someone signed in without edit access can
view but their writes will be rejected.

### 4. Deploy to GitHub Pages

```bash
cd merlin-engage-dashboard
git add -A && git commit -m "Configure OAuth client ID"
gh repo create merlin-engage-dashboard --private --source=. --push
```

Then **Settings → Pages → Deploy from a branch → `main` / root**. Live at
`https://<you>.github.io/merlin-engage-dashboard/`. Make sure that exact origin is
in the OAuth client's Authorized JavaScript origins (step 1.4).

---

## Local preview & mock mode

```bash
cd merlin-engage-dashboard
python3 -m http.server 8137
```

- `http://localhost:8137/` — real flow (needs a Client ID + `localhost:8137` in the
  OAuth origins).
- `http://localhost:8137/?mock=1` — **preview with sample data, no sign-in.**
  Includes a duplicate Firm ID so you can see the Needs Review panel and try inline
  editing (writes are simulated, nothing hits the sheet).

---

## How editing works

- Click any cell in **All Firms** → it becomes an editor (dropdown-suggested for
  status/rep fields, TRUE/FALSE for pre-reqs, number for CSAT, text otherwise).
- **Enter** saves, **Esc** cancels. The cell shows a spinner, then flashes green on
  success (or red + a toast on failure, leaving the old value intact).
- Values are written with `USER_ENTERED`, so dates like `7/16/26` and amounts like
  `$150` are parsed just as if typed into the sheet.
- Every write is attributed to the signed-in user in **File → Version history**.

---

## The sheet columns it expects

| Column | Used for |
|---|---|
| Firm Name, Firm ID | Identity / table · duplicate detection on Firm ID |
| Demo Status, Demo Rep, Demo Date, Demo Rescheduled Date | Funnel, demo breakdown, rep stats |
| Set up Status, Set up #1/#2 date, Set up Rep | Funnel, setup breakdown, rep stats |
| Pre-set up requirements met? | KPI (pre-reqs met) |
| Set up CSAT | Avg CSAT, rep CSAT |
| Closed lost reason | Closed-lost KPI |
| MRR increase | MRR added KPI, "won" funnel stage |

Missing or renamed columns degrade gracefully — the matcher looks for keywords and
anything it can't find shows as `—`.
