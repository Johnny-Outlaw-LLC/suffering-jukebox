const { Client } = require("pg");
const fs = require("fs");
const path = require("path");

function loadEnv() {
  const raw = fs.readFileSync("C:/AI Projects/env.local", "utf8");
  const out = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (!m) continue;
    out[m[1]] = m[2].replace(/^["']|["']$/g, "").trim();
  }
  return out;
}

(async () => {
  const env = loadEnv();
  const pass = env.SUPABASE_DATABASE_PASSWORD;
  if (!pass) throw new Error("SUPABASE_DATABASE_PASSWORD missing");
  const ref = "ntyvtpimesfoesuykuyi";
  const sql = fs.readFileSync(
    path.join(__dirname, "../supabase/migrations/20260915180000_track_spotify_matches.sql"),
    "utf8",
  );
  const c = new Client({
    connectionString: `postgresql://postgres.${ref}:${encodeURIComponent(pass)}@aws-1-us-east-1.pooler.supabase.com:5432/postgres`,
    ssl: { rejectUnauthorized: false },
  });
  await c.connect();
  await c.query(sql);
  console.log("migration ok");
  await c.end();
})().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
