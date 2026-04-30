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
    ciphers: 'SSLv3'
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
    return { hour: h.getHours(), price: parseFloat(r.DayAheadPriceDKK ?? r.SpotPriceDKK) };
  });
}

// ─── Build email ──────────────────────────────────────────────────────────────
function buildEmail(hours, today, recipient) {
  const fmt    = (h) => `${String(h).padStart(2, "0")}:00`;
  const below  = hours.filter((h) => h.price < THRESHOLD);
  const avg    = hours.reduce((s, h) => s + h.price, 0) / hours.length;
  const minH   = hours.reduce((a, b) => (a.price < b.price ? a : b));
  const maxH   = hours.reduce((a, b) => (a.price > b.price ? a : b));

  // Extract first name from email (name.surname@... → "Name")
  const namePart = (recipient || TO_EMAIL).split('@')[0].split('.')[0];
  const firstName = namePart.charAt(0).toUpperCase() + namePart.slice(1);

  const date   = new Date(today);
  const dateStr = date.toLocaleDateString("en-DK", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });

  // Group consecutive below-threshold hours into windows
  const windows = [];
  let wStart = null;
  below.forEach((h, i) => {
    if (!wStart) wStart = h;
    const next = below[i + 1];
    if (!next || next.hour !== h.hour + 1) {
      windows.push({
        start:  wStart.hour,
        end:    h.hour + 1,
        prices: below.slice(below.indexOf(wStart), i + 1),
      });
      wStart = null;
    }
  });

  // ── No hours below threshold ──────────────────────────────────────────────
  if (below.length === 0) {
    return {
      subject: `DK1 Prices – No hours below 30.92 DKK/MWh today (${today})`,
      text: `Dear ${firstName},

This is your daily DK1 electricity price report for ${dateStr}.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SUMMARY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

No hours today are priced below the threshold of ${THRESHOLD} DKK/MWh.

DAILY STATISTICS
  • Day average:   ${avg.toFixed(2)} DKK/MWh
  • Minimum price: ${minH.price.toFixed(2)} DKK/MWh  (${fmt(minH.hour)}–${fmt(minH.hour + 1)})
  • Maximum price: ${maxH.price.toFixed(2)} DKK/MWh  (${fmt(maxH.hour)}–${fmt(maxH.hour + 1)})
  • Threshold:     30.92 DKK/MWh

ANALYSIS
Prices for DK1 on ${dateStr} remain elevated across all 24 hours.
The cheapest hour (${fmt(minH.hour)}–${fmt(minH.hour + 1)}) at ${minH.price.toFixed(2)} DKK/MWh is still ${(minH.price - THRESHOLD).toFixed(2)} DKK/MWh above the alert threshold.

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
      return `  • ${fmt(w.start)} – ${fmt(w.end)}  (${w.end - w.start}h, avg ${wAvg.toFixed(2)} DKK/MWh)`;
    })
    .join("\n");

  const hourLines = below
    .map(
      (h) =>
        `  ${fmt(h.hour)}–${fmt(h.hour + 1)}    ${h.price.toFixed(2)} DKK/MWh` +
        `    (${(THRESHOLD - h.price).toFixed(2)} below threshold)`
    )
    .join("\n");

  const windowList = windows.map((w) => `${fmt(w.start)}–${fmt(w.end)}`).join(" and ");

  return {
    subject: `⚡ DK1 Alert – ${below.length} hour${below.length > 1 ? "s" : ""} below 30.92 DKK/MWh today (${today})`,
    text: `Dear ${firstName},

This is your daily DK1 electricity price report for ${dateStr}.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⚡ ALERT: ${below.length} HOUR${below.length > 1 ? "S" : ""} BELOW THRESHOLD
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Today's DK1 spot prices are below ${THRESHOLD} DKK/MWh during the following window${windows.length > 1 ? "s" : ""}:

${windowSummary}

HOUR-BY-HOUR DETAIL
${hourLines}

DAILY STATISTICS
  • Below-threshold hours: ${below.length}/24
  • Avg price (below hrs): ${belowAvg.toFixed(2)} DKK/MWh  (${saving} DKK/MWh below threshold)
  • Day average (all hrs): ${avg.toFixed(2)} DKK/MWh
  • Minimum price:         ${minH.price.toFixed(2)} DKK/MWh  (${fmt(minH.hour)}–${fmt(minH.hour + 1)})
  • Maximum price:         ${maxH.price.toFixed(2)} DKK/MWh  (${fmt(maxH.hour)}–${fmt(maxH.hour + 1)})
  • Threshold:             30.92 DKK/MWh

ANALYSIS
On ${dateStr}, the DK1 area offers ${below.length} hour${below.length > 1 ? "s" : ""} of sub-threshold pricing.
${
  windows.length === 1
    ? `The opportunity is concentrated in a single block (${fmt(windows[0].start)}–${fmt(windows[0].end)}), making it well-suited for continuous consumption scheduling.`
    : `The below-threshold hours are spread across ${windows.length} separate windows. Consider whether partial or split scheduling is feasible for your operations.`
}
The average saving during the cheap window${windows.length > 1 ? "s" : ""} is ${saving} DKK/MWh vs. threshold.
The daily average of ${avg.toFixed(2)} DKK/MWh is ${avg < THRESHOLD ? `${(THRESHOLD - avg).toFixed(2)} DKK/MWh below` : `${(avg - THRESHOLD).toFixed(2)} DKK/MWh above`} threshold.

Recommendation: Schedule flexible loads during ${windowList} to take advantage of the price dip.

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
  const hours = await fetchPrices();

  // Split recipients and send individually (privacy + personalization)
  const recipients = TO_EMAIL.split(',').map(e => e.trim()).filter(Boolean);

  for (const recipient of recipients) {
    const { subject, text } = buildEmail(hours, today, recipient);
    const info = await transporter.sendMail({
      from: `"DK1 Price Monitor" <${process.env.SMTP_USER}>`,
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
