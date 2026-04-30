# DK1 Price Alert — Setup Guide

## How it works
Every day at **08:00 Copenhagen time**, GitHub Actions:
1. Fetches DK1 day-ahead spot prices from Energi Data Service
2. Checks for 15-minute slots below your threshold (default **30.92 DKK/MWh**)
3. Sends a detailed email report to your recipients

No server needed. Runs entirely on GitHub's free infrastructure.

---

## Setup (15 minutes)

### Step 1 — Create a GitHub repository
1. Go to [github.com](https://github.com) and sign in (or create a free account)
2. Click **New repository** → name it e.g. `dk1-price-alert` → **Create repository**

### Step 2 — Upload the scheduler folder
Upload the contents of the `scheduler/` folder to your repo:
- `scheduler.js`
- `package.json`
- `.github/workflows/dk1-alert.yml`

You can drag-and-drop files directly in the GitHub web UI.

### Step 3 — Add SMTP Secrets (passwords — hidden)
Go to your repo → **Settings** → **Secrets and variables** → **Actions** → **Secrets** tab → **New repository secret**

Add these 4 secrets:

| Secret name | Value |
|---|---|
| `SMTP_HOST` | `smtp.gmail.com` |
| `SMTP_PORT` | `587` |
| `SMTP_USER` | your Gmail address |
| `SMTP_PASS` | your Gmail App Password ¹ |

> ¹ **Gmail App Password**: go to [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords), create a password for "Mail". Use this, not your regular Gmail password.

### Step 4 — Add Variables (settings — visible & editable anytime)
Same page → **Variables** tab → **New repository variable**

Add these 2 variables:

| Variable name | Value | Example |
|---|---|---|
| `TO_EMAIL` | Recipient(s), comma-separated | `fabio.barboni@stern-energy.com, other@company.com` |
| `THRESHOLD` | Alert threshold in DKK/MWh | `30.92` |

**You can edit these anytime** without touching any code — just go to Settings → Variables.

### Step 5 — Test it
Go to your repo → **Actions** tab → **DK1 Daily Price Alert** → **Run workflow** (button on the right).

Check your inbox within a minute. If it arrives, you're done! ✓

---

## Changing recipients later
1. Go to your repo on GitHub
2. **Settings** → **Secrets and variables** → **Actions** → **Variables** tab
3. Click the pencil ✏ next to `TO_EMAIL`
4. Update the value (comma-separated for multiple)
5. Save — takes effect on the next run

## Changing the threshold later
Same as above — edit the `THRESHOLD` variable.

---

## Timing note
The cron runs at **06:00 UTC** which covers both:
- Winter (CET = UTC+1) → email at 07:00 local ⚠ one hour early
- Summer (CEST = UTC+2) → email at 08:00 local ✓

To fix the winter offset, you can manually trigger the workflow at 08:00 from the Actions tab, or adjust the cron to `0 7 * * *` in winter.

---

## Files
| File | Purpose |
|---|---|
| `scheduler.js` | Main script — fetches prices + builds + sends email |
| `package.json` | Node.js dependencies |
| `.github/workflows/dk1-alert.yml` | GitHub Actions schedule |
| `.env.example` | Template for local testing |
