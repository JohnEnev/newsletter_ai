#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_FEEDS = [
  "https://hnrss.org/frontpage",
  "https://rss.nytimes.com/services/xml/rss/nyt/Technology.xml",
  "https://www.producthunt.com/feed",
];

const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "this",
  "that",
  "your",
  "about",
  "into",
  "these",
  "those",
  "their",
  "have",
  "will",
  "what",
  "when",
  "where",
  "which",
  "using",
  "guide",
  "daily",
  "today",
  "news",
  "tech",
  "how",
]);

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
  console.log(`\nUsage:\n  node scripts/fetch-articles.mjs [--feed https://example.com/rss.xml --feed https://another.com/feed] [--source ./scripts/data/example-articles.json] [--limit 20] [--dry-run] [--no-default]\n\nNotes:\n- Fetches RSS feeds (defaults include Hacker News, NYT Tech, Product Hunt).\n- Falls back to scripts/data/example-articles.json when feeds fail.\n`);
  process.exit(msg ? 1 : 0);
}

function decodeHtml(value = "") {
  return value
    .replace(/<!\[CDATA\[(.*?)\]\]>/gs, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function stripHtml(value = "") {
  return decodeHtml(value)
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function summarise(text) {
  if (!text) return null;
  const clean = stripHtml(text);
  if (!clean) return null;
  return clean.length > 280 ? `${clean.slice(0, 277)}…` : clean;
}

function keywordTags(title = "", summary = "") {
  const text = `${title} ${summary}`.toLowerCase();
  const terms = text
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length >= 4 && !STOP_WORDS.has(word));

  const counts = new Map();
  for (const term of terms) {
    counts.set(term, (counts.get(term) || 0) + 1);
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([term]) => term);
}

function parseRssItems(xml) {
  const items = [];
  const itemRegex = /<item[\s\S]*?<\/item>/gi;
  let match;
  while ((match = itemRegex.exec(xml))) {
    items.push(match[0]);
  }
  return items;
}

function extractTag(xml, tag) {
  const regex = new RegExp(`<${tag}[^>]*>([\s\S]*?)<\/${tag}>`, "i");
  const match = xml.match(regex);
  if (!match) return "";
  return decodeHtml(match[1]);
}

async function fetchRss(feedUrl) {
  try {
    const res = await fetch(feedUrl, { headers: { "User-Agent": "newsletter-ai-fetcher" } });
    if (!res.ok) {
      console.warn(`[warn] Failed to fetch ${feedUrl}: ${res.status}`);
      return [];
    }
    const xml = await res.text();
    const items = parseRssItems(xml);
    return items
      .map((item) => {
        const title = extractTag(item, "title").trim();
        const link = extractTag(item, "link").trim();
        const description = extractTag(item, "description") || extractTag(item, "content:encoded");
        const summary = summarise(description);
        const url = link || extractTag(item, "guid");
        if (!title || !url) return null;
        const tags = keywordTags(title, summary ?? "");
        const source = (() => {
          try {
            return new URL(url).hostname;
          } catch {
            return new URL(feedUrl).hostname;
          }
        })();
        return { title, url, summary, tags, source };
      })
      .filter(Boolean);
  } catch (err) {
    console.warn(`[warn] Exception fetching ${feedUrl}: ${err instanceof Error ? err.message : err}`);
    return [];
  }
}

function loadLocalArticles(sourceFile) {
  const candidate = sourceFile
    ? path.resolve(process.cwd(), sourceFile)
    : path.resolve(__dirname, "data", "example-articles.json");

  if (!fs.existsSync(candidate)) return [];

  try {
    const txt = fs.readFileSync(candidate, "utf-8");
    const parsed = JSON.parse(txt);
    const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.items) ? parsed.items : [];
    return list
      .map((item) => {
        const title = String(item.title ?? "").trim();
        const url = String(item.url ?? "").trim();
        if (!title || !url) return null;
        const summary = summarise(item.summary || item.description || "");
        const tags = Array.isArray(item.tags) ? item.tags.map((t) => String(t)) : keywordTags(title, summary ?? "");
        const source = (() => {
          try {
            return new URL(url).hostname;
          } catch {
            return "local";
          }
        })();
        return { title, url, summary, tags, source };
      })
      .filter(Boolean);
  } catch (err) {
    console.warn(`[warn] Could not parse ${candidate}: ${err instanceof Error ? err.message : err}`);
    return [];
  }
}

async function collectArticles(options) {
  const feeds = [];
  if (!options.noDefaultFeeds) feeds.push(...DEFAULT_FEEDS);
  feeds.push(...options.feedUrls);

  const articles = [];
  for (const feed of feeds) {
    const parsed = await fetchRss(feed);
    articles.push(...parsed);
  }

  if (articles.length < 5) {
    articles.push(...loadLocalArticles(options.sourceFile));
  }

  return articles;
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

  const fetched = await collectArticles({ feedUrls, sourceFile, noDefaultFeeds });
  const normalised = fetched
    .filter((item) => item && typeof item === "object")
    .map((item) => ({
      title: item.title,
      url: item.url,
      summary: item.summary || null,
      tags: Array.from(new Set((item.tags || []).map((tag) => String(tag)))).slice(0, 5),
      source: item.source || "unknown",
    }))
    .filter((entry) => entry.title && entry.url)
    .slice(0, limit > 0 ? limit : fetched.length);

  if (normalised.length === 0) {
    console.log("No articles to process.");
    return;
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  let inserted = 0;
  for (const article of normalised) {
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
        inserted++;
        continue;
      }

      const { error } = await admin
        .from("articles")
        .insert({
          title: article.title,
          url: article.url,
          summary: article.summary,
          tags: article.tags,
          source: article.source,
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

  console.log(`Processed ${normalised.length} candidates. ${dryRun ? "(dry run)" : ""}`);
  if (!dryRun) {
    console.log(`Inserted ${inserted} new articles.`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
