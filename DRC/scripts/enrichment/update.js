const axios = require("axios");
const fs = require("fs");
const path = require("path");

const API_KEY = process.env.APISPORTS_KEY || "7f7700a471beeeb52aecde406a3870ba";
const SEASON = 2025;

const LEAGUES = [
  { id: 39, name: "Premier League" }, { id: 61, name: "Ligue 1" }, { id: 140, name: "La Liga" },
  { id: 78, name: "Bundesliga" }, { id: 135, name: "Serie A" }, { id: 94, name: "Liga Portugal" },
  { id: 88, name: "Eredivisie" }, { id: 144, name: "Jupiler Pro" }, { id: 179, name: "Premiership" },
  { id: 203, name: "Süper Lig" }, { id: 197, name: "Super League (GRE)" }, { id: 119, name: "Superliga (DAN)" },
  { id: 207, name: "Super League (SUI)" }, { id: 218, name: "Bundesliga (AUT)" }, { id: 40, name: "Championship" },
  { id: 62, name: "Ligue 2" }, { id: 136, name: "Serie B" }, { id: 79, name: "2. Bundesliga" },
  { id: 141, name: "La Liga 2" }, { id: 106, name: "Ekstraklasa" }, { id: 210, name: "HNL" },
  { id: 209, name: "Czech Liga" }, { id: 283, name: "Liga I" }, { id: 253, name: "MLS" },
  { id: 71, name: "Brasileiro A" }, { id: 128, name: "Liga Prof" }, { id: 262, name: "Liga MX" },
  { id: 307, name: "Saudi Pro" }, { id: 98, name: "J1 League" }, { id: 188, name: "A-League" }
];

const DATA_DIR = "./data/history"; // adapte si tu veux la racine
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function fmtDateUTC(d) {
  // API-FOOTBALL attend souvent YYYY-MM-DD
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function loadHistory(filePath) {
  if (!fs.existsSync(filePath)) return [];
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return [];
  }
}

function mergeByFixtureId(oldArr, newArr) {
  const map = new Map();
  for (const m of oldArr) {
    const id = m?.fixture?.id;
    if (id != null) map.set(id, m);
  }
  for (const m of newArr) {
    const id = m?.fixture?.id;
    if (id != null) map.set(id, m);
  }
  return Array.from(map.values()).sort((a, b) => new Date(a.fixture.date) - new Date(b.fixture.date));
}

async function fetchFixturesFT(leagueId, season, fromStr, toStr) {
  const res = await axios.get("https://v3.football.api-sports.io/fixtures", {
    headers: { "x-apisports-key": API_KEY },
    params: {
      league: leagueId,
      season,
      status: "FT",
      from: fromStr,
      to: toStr
    }
  });
  return res.data?.response || [];
}

async function updateLastDays(days = 7) {
  const now = new Date();
  const from = new Date(now.getTime() - days * 24 * 3600 * 1000);

  const fromStr = fmtDateUTC(from);
  const toStr = fmtDateUTC(now);

  console.log(`📥 UPDATE FT (last ${days} days) — season ${SEASON}`);
  console.log(`🗓️ from=${fromStr} to=${toStr}\n`);

  for (const league of LEAGUES) {
    const filePath = path.join(DATA_DIR, `history_${league.id}.json`);
    const existing = loadHistory(filePath);

    process.stdout.write(`⏳ ${league.name} (${league.id})... `);

    try {
      const fresh = await fetchFixturesFT(league.id, SEASON, fromStr, toStr);

      const merged = mergeByFixtureId(existing, fresh);
      const added = merged.length - existing.length;

      fs.writeFileSync(filePath, JSON.stringify(merged, null, 2));
      console.log(`OK (+${added}, window=${fresh.length}, total=${merged.length})`);

      await delay(1200); // anti-ban / rate safety
    } catch (e) {
      console.log(`ERREUR: ${e.message}`);
      await delay(1500);
    }
  }

  console.log("\n✅ Update terminé.");
}

updateLastDays(10);
