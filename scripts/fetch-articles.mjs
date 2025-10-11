#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";
import { gatherArticles, ingestArticles, sampleDataPath } from "../src/lib/server/articles.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function loadDotEnvLocal() {
  try {
    const envPath = path.resolve(__dirname, "..", ".env.local");
    if (!fs.existsSync(envPath)) return;
    const txt = fs.readFileSync(envPath, "utf-8");
    for (const line of txt.split(/\r?\n/)) {
      if (!line || line.trim().startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      const raw = line.slice(eq + 1);
      const val = raw.replace(/^"|"$/g, "").replace(/^'|'$/g, "");
      if (!(key in process.env)) process.env[key] = val;
    }
  } catch {}
}

function usage(msg) {
  if (msg) console.error("Error:", msg);
  console.log(`\nUsage:\n  node scripts/fetch-articles.mjs [--feed https://example.com/rss.xml --feed https://another.com/feed] [--limit 20] [--dry-run] [--no-default] [--source ./path/to/fallback.json]\n\nNotes:\n- Shares logic with the serverless ingest endpoint.\n- Falls back to scripts/data/example-articles.json when feeds fail.\n`);
  process.exit(msg ? 1 : 0);
}

async function main() {
  loadDotEnvLocal();
  const args = process.argv.slice(2);
  const feedUrls = [];
  let sourceFile = null;
  let limit = 25;
  let dryRun = false;
  let noDefaultFeeds = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--feed") feedUrls.push(args[++i]);
    else if (a === "--source") sourceFile = args[++i];
    else if (a === "--limit") limit = Number(args[++i]);
    else if (a === "--dry-run") dryRun = true;
    else if (a === "--no-default") noDefaultFeeds = true;
    else if (a === "-h" || a === "--help") usage();
    else usage(`Unknown arg: ${a}`);
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) usage("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");

  const fallback = sourceFile ? path.resolve(process.cwd(), sourceFile) : sampleDataPath;
  const fetched = await gatherArticles({ feedUrls, noDefaultFeeds, sourceFile: fallback });
  const limited = fetched.filter((entry) => entry.title && entry.url).slice(0, limit > 0 ? limit : fetched.length);

  if (limited.length === 0) {
    console.log("No articles to process.");
    return;
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const result = await ingestArticles({ supabase: admin, articles: limited, dryRun });

  console.log(`Processed ${result.processed} candidates. ${dryRun ? "(dry run)" : ""}`);
  if (!dryRun) {
    console.log(`Inserted ${result.inserted} new articles.`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
