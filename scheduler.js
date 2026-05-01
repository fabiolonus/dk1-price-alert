// DK1 Price Alert Scheduler
// Runs daily at 08:00 — fetches day-ahead prices and emails if any hour < 30.92 DKK/MWh
//
// Setup:
//   1. cp .env.example .env  and fill in your SMTP credentials
//   2. npm install
//   3. node scheduler.js          (keeps running, fires at 08:00 every day)
//      node scheduler.js --test   (fires immediately for testing)

import cron from "node-cron";
import nodemailer from "nodemailer";
import fetch from "node-fetch";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

// ─── Load .env manually (no extra dep) ───────────────────────────────────────
const __dir = dirname(fileURLToPath(import.meta.url));
try {
  const env = readFileSync(resolve(__dir, ".env"), "utf8");
  env.split("\n").forEach((line) => {
    const [k, ...v] = line.split("=");
    if (k && !k.startsWith("#")) process.env[k.trim()] = v.join("=").trim();
  });
} catch {
  console.warn("⚠  No .env file found — using environment variables directly.");
}

// ─── Config ──────────────────────────────────────────────────────────────────
const THRESHOLD = parseFloat(process.env.THRESHOLD) || 30.92;  // override via GitHub Variable
const TO_EMAIL  = process.env.TO_EMAIL || "fabio.barboni@stern-energy.com"; // override via GitHub Variable
const AREA      = "DK1";

// ─── SMTP transporter ────────────────────────────────────────────────────────
const transporter = nodemailer.createTransport({
  host:   process.env.SMTP_HOST || "smtp.office365.com",
  port:   parseInt(process.env.SMTP_PORT || "587"),
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
  tls: {
    rejectUnauthorized: false
  }
});

// ─── Fetch prices ─────────────────────────────────────────────────────────────
async function fetchPrices() {
  const now      = new Date();
  const today    = now.toISOString().slice(0, 10);
  const tomorrow = new Date(now.getTime() + 86_400_000).toISOString().slice(0, 10);

  const url =
    `https://api.energidataservice.dk/dataset/DayAheadPrices` +
    `?start=${today}&end=${tomorrow}` +
    `&filter=${encodeURIComponent(`{"PriceArea":["${AREA}"]}`)}` +
    `&sort=TimeDK%20ASC&limit=0`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`API error ${res.status}`);
  const data = await res.json();
  const records = data.records || [];
  if (!records.length) throw new Error("API returned no records");

  return records.map((r) => {
    const h = new Date(r.TimeDK || r.HourDK || r.HourUTC);
    const hh = h.getHours();
    const mm = h.getMinutes();
    const endMin = mm + 15;
    const endHH = endMin >= 60 ? hh + 1 : hh;
    const endMM = endMin >= 60 ? endMin - 60 : endMin;
    const pad = n => String(n).padStart(2, '0');
    return {
      hour: hh,
      minute: mm,
      label: `${pad(hh)}:${pad(mm)}`,
      endLabel: `${pad(endHH)}:${pad(endMM)}`,
      price: parseFloat(r.DayAheadPriceDKK ?? r.SpotPriceDKK)
    };
  });
}

// ─── Build email ──────────────────────────────────────────────────────────────
function buildEmail(slots, today, recipient) {
  const below  = slots.filter((s) => s.price < THRESHOLD);
  const avg    = slots.reduce((s, h) => s + h.price, 0) / slots.length;
  const minH   = slots.reduce((a, b) => (a.price < b.price ? a : b));
  const maxH   = slots.reduce((a, b) => (a.price > b.price ? a : b));
  const belowHours = (below.length * 15 / 60).toFixed(1);

  // Extract first name  email (name.surname@... → "Name")
  const namePart = (recipient || TO_EMAIL).split('@')[0].split('.')[0];
  const firstName = namePart.charAt(0).toUpperCase() + namePart.slice(1);

  const date   = new Date(today);
  const dateStr = date.toLocaleDateString("en-DK", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });

  // Group consecutive 15-min slots into windows
  const windows = [];
  let wStart = null;
  below.forEach((s, i) => {
    if (!wStart) wStart = s;
    const next = below[i + 1];
    const consecutive = next && (
      (next.hour === s.hour && next.minute === s.minute + 15) ||
      (next.hour === s.hour + 1 && s.minute === 45 && next.minute === 0)
    );
    if (!consecutive) {
      windows.push({ startLabel: wStart.label, endLabel: s.endLabel, prices: below.slice(below.indexOf(wStart), i + 1) });
      wStart = null;
    }
  });

  // ── No hours below threshold ──────────────────────────────────────────────
  if (below.length === 0) {
    return {
      subject: `DK1 Prices – No slots below ${THRESHOLD} DKK/MWh today (${today})`,
      text: `Dear ${firstName},

This is your daily DK1 electricity price report for ${dateStr}.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SUMMARY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

No 15-minute slots today are priced below the threshold of ${THRESHOLD} DKK/MWh.

DAILY STATISTICS
  • Day average:   ${avg.toFixed(2)} DKK/MWh
  • Minimum price: ${minH.price.toFixed(2)} DKK/MWh  (${minH.label}–${minH.endLabel})
  • Maximum price: ${maxH.price.toFixed(2)} DKK/MWh  (${maxH.label}–${maxH.endLabel})
  • Threshold:     ${THRESHOLD} DKK/MWh

ANALYSIS
Prices for DK1 on ${dateStr} remain elevated across all 96 quarter-hour slots.
The cheapest slot (${minH.label}–${minH.endLabel}) at ${minH.price.toFixed(2)} DKK/MWh is still ${(minH.price - THRESHOLD).toFixed(2)} DKK/MWh above the alert threshold.

No action recommended today based on the price threshold criteria.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Data source: Energi Data Service – DayAheadPrices
Generated: ${new Date().toLocaleString("en-DK")}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    };
  }

  // ── Some hours below threshold ────────────────────────────────────────────
  const belowAvg = below.reduce((s, h) => s + h.price, 0) / below.length;
  const saving   = (THRESHOLD - belowAvg).toFixed(2);

  const windowSummary = windows
    .map((w) => {
      const wAvg = w.prices.reduce((s, h) => s + h.price, 0) / w.prices.length;
      return `  • ${w.startLabel} – ${w.endLabel}  (${w.prices.length * 15} min, avg ${wAvg.toFixed(2)} DKK/MWh)`;
    })
    .join("\n");

  const slotLines = below
    .map((s) => `  ${s.label}–${s.endLabel}    ${s.price.toFixed(2)} DKK/MWh    (${(THRESHOLD - s.price).toFixed(2)} below threshold)`)
    .join("\n");

  const windowList = windows.map((w) => `${w.startLabel}–${w.endLabel}`).join(" and ");

  return {
    subject: `⚡ DK1 Alert – ${belowHours}h below ${THRESHOLD} DKK/MWh today (${today})`,
    text: `Dear ${firstName},

This is your daily DK1 electricity price report for ${dateStr}.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⚡ ALERT: ${below.length} SLOTS (${belowHours}h) BELOW THRESHOLD 
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Today's DK1 spot prices are below ${THRESHOLD} DKK/MWh during the following window${windows.length > 1 ? "s" : ""}:

${windowSummary}

SLOT-BY-SLOT DETAIL
${slotLines}

DAILY STATISTICS
  • Below-threshold slots: ${below.length}/96  (${belowHours}h)
  • Avg price (below):     ${belowAvg.toFixed(2)} DKK/MWh  (${saving} DKK/MWh below threshold)
  • Day average (all):     ${avg.toFixed(2)} DKK/MWh
  • Minimum price:         ${minH.price.toFixed(2)} DKK/MWh  (${minH.label}–${minH.endLabel})
  • Maximum price:         ${maxH.price.toFixed(2)} DKK/MWh  (${maxH.label}–${maxH.endLabel})
  • Threshold:             ${THRESHOLD} DKK/MWh

ANALYSIS
On ${dateStr}, the DK1 area offers ${belowHours} hours of sub-threshold pricing across ${below.length} quarter-hour slots.
${
  windows.length === 1
    ? `Expect the disconnection of the plant during ${windows[0].startLabel}–${windows[0].endLabel} due to low electricity prices.`
    : `Expect the disconnection of the plant during ${windows.length} separate windows due to low electricity prices:\n${windows.map(w => `  ${w.startLabel}–${w.endLabel}`).join('\n')}`
}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Data source: Energi Data Service – DayAheadPrices
Generated: ${new Date().toLocaleString("en-DK")}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
  };
}

// ─── Send email ───────────────────────────────────────────────────────────────
async function sendDailyAlert() {
  console.log(`[${new Date().toISOString()}] Running daily price check…`);

  const today = new Date().toISOString().slice(0, 10);

  // Split recipients and send individually (privacy + personalization)
  const recipients = TO_EMAIL.split(',').map(e => e.trim()).filter(Boolean);
  const hours = await fetchPrices();
  const below = hours.filter(h => h.price < THRESHOLD);

  if (below.length === 0) {
    console.log(`[${new Date().toISOString()}] No slots below ${THRESHOLD} DKK/MWh today — no email sent.`);
    return;
  }

  for (const recipient of recipients) {
    const { subject, text } = buildEmail(hours, today, recipient);
    const info = await transporter.sendMail({
      from: `"DK1 Price Monitor" <fabio.barboni@stern-energy.com>`,
      to:   recipient,
      subject,
      text,
    });
    console.log(`[${new Date().toISOString()}] ✓ Sent to ${recipient} — ${info.messageId}`);
  }
}

// ─── Entry point ──────────────────────────────────────────────────────────────
const isTest = process.argv.includes("--test");

if (isTest) {
  console.log("🧪 Test mode — sending email immediately…");
  sendDailyAlert().catch((e) => { console.error("✗ Failed:", e.message); process.exit(1); });
} else {
  // Every day at 08:00 local time
  cron.schedule("0 8 * * *", () => {
    sendDailyAlert().catch((e) => console.error("✗ Failed:", e.message));
  }, { timezone: "Europe/Copenhagen" });

  console.log("✓ Scheduler started — will send email daily at 08:00 Copenhagen time.");
  console.log("  Run with --test to fire immediately.");
}
