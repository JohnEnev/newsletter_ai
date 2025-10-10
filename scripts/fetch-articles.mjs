#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";

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
  console.log(`\nUsage:\n  node scripts/fetch-articles.mjs [--feed https://example.com/feed.json] [--source ./scripts/data/example-articles.json] [--limit 20] [--dry-run]\n\nNotes:\n- Feed/source should return/contain an array of { title, url, summary?, tags? }.\n- Falls back to scripts/data/example-articles.json if nothing provided.\n`);
  process.exit(msg ? 1 : 0);
}

async function readArticles({ feedUrl, sourceFile }) {
  if (feedUrl) {
    try {
      const res = await fetch(feedUrl);
      if (!res.ok) {
        console.warn(`[warn] Feed request failed (${res.status}). Falling back to local data.`);
      } else {
        const json = await res.json();
        if (Array.isArray(json)) return json;
        if (Array.isArray(json?.items)) return json.items;
        console.warn("[warn] Feed response was not an array. Falling back to local data.");
      }
    } catch (err) {
      console.warn(`[warn] Failed to fetch feed: ${err instanceof Error ? err.message : err}`);
    }
  }

  const candidate = sourceFile
    ? path.resolve(process.cwd(), sourceFile)
    : path.resolve(__dirname, "data", "example-articles.json");

  if (fs.existsSync(candidate)) {
    try {
      const txt = fs.readFileSync(candidate, "utf-8");
      const parsed = JSON.parse(txt);
      if (Array.isArray(parsed)) return parsed;
      if (Array.isArray(parsed?.items)) return parsed.items;
      console.warn(`[warn] ${candidate} did not contain an array`);
    } catch (err) {
      console.warn(`[warn] Could not read ${candidate}: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Final fallback
  return [
    {
      title: "AI Strategy Briefing",
      url: "https://example.com/briefing/ai-strategy",
      summary: "Key stories across AI policy, tooling, and product launches from the last 24 hours.",
      tags: ["ai", "strategy", "product"],
    },
  ];
}

function normaliseArticle(article) {
  if (!article || typeof article !== "object") return null;
  const title = String(article.title ?? "").trim();
  const url = String(article.url ?? "").trim();
  if (!title || !url) return null;
  const summary = article.summary ? String(article.summary).trim() : null;
  const tagsArray = Array.isArray(article.tags)
    ? article.tags.map((tag) => String(tag)).filter(Boolean)
    : [];
  return { title, url, summary, tags: tagsArray };
}

async function main() {
  loadDotEnvLocal();
  const args = process.argv.slice(2);
  let feedUrl = null;
  let sourceFile = null;
  let limit = 25;
  let dryRun = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--feed") feedUrl = args[++i];
    else if (a === "--source") sourceFile = args[++i];
    else if (a === "--limit") limit = Number(args[++i]);
    else if (a === "--dry-run") dryRun = true;
    else if (a === "-h" || a === "--help") usage();
    else usage(`Unknown arg: ${a}`);
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) usage("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");

  const rawArticles = await readArticles({ feedUrl, sourceFile });
  const articles = rawArticles
    .map(normaliseArticle)
    .filter((a) => a !== null)
    .slice(0, limit > 0 ? limit : rawArticles.length);

  if (articles.length === 0) {
    console.log("No articles to process.");
    return;
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  let inserted = 0;
  for (const article of articles) {
    try {
      const { data: existing } = await admin
        .from("articles")
        .select("id")
        .eq("url", article.url)
        .maybeSingle();
      if (existing) {
        console.log(`[skip] ${article.url}`);
        continue;
      }

      if (dryRun) {
        console.log(`[dry] Would insert ${article.title}`);
        inserted++; // count to show potential work
        continue;
      }

      const { error } = await admin
        .from("articles")
        .insert({
          title: article.title,
          url: article.url,
          summary: article.summary,
          tags: article.tags,
        });
      if (error) {
        console.error(`[error] Failed to insert ${article.url}: ${error.message}`);
      } else {
        console.log(`[inserted] ${article.title}`);
        inserted++;
      }
    } catch (err) {
      console.error(`[error] Unexpected issue for ${article.url}:`, err instanceof Error ? err.message : err);
    }
  }

  console.log(`Processed ${articles.length} candidates. ${dryRun ? "(dry run)" : ""}`);
  if (!dryRun) {
    console.log(`Inserted ${inserted} new articles.`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
