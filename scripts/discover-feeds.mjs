#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import { XMLParser } from "fast-xml-parser";

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
      const valRaw = line.slice(eq + 1);
      const val = valRaw.replace(/^"|"$/g, "").replace(/^'|'$/g, "");
      if (!(key in process.env)) process.env[key] = val;
    }
  } catch {
    // ignore
  }
}

function usage(msg) {
  if (msg) console.error("Error:", msg);
  console.log(`\nUsage:\n  node scripts/discover-feeds.mjs [--slug topic] [--queue] [--limit 2] [--hours 168] [--dry]\n\nExamples:\n  node scripts/discover-feeds.mjs --slug biology\n  node scripts/discover-feeds.mjs --queue --limit 3 --hours 72\n`);
  process.exit(msg ? 1 : 0);
}

function toDisplayLabel(slug) {
  return slug
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

const parser = new XMLParser({
  ignoreAttributes: false,
  trimValues: true,
});

function summariseFeed(xml) {
  try {
    const doc = parser.parse(xml);
    if (doc?.rss?.channel) {
      const channel = Array.isArray(doc.rss.channel) ? doc.rss.channel[0] : doc.rss.channel;
      const items = channel?.item;
      return Array.isArray(items) ? items.length : items ? 1 : 0;
    }
    if (doc?.feed) {
      const feed = Array.isArray(doc.feed) ? doc.feed[0] : doc.feed;
      const entries = feed?.entry;
      return Array.isArray(entries) ? entries.length : entries ? 1 : 0;
    }
    return 0;
  } catch {
    return 0;
  }
}

async function validateFeed(url) {
  try {
    const res = await fetch(url, { headers: { "User-Agent": "newsletter-ai-feed-discovery" } });
    if (!res.ok) {
      return { ok: false, reason: `HTTP ${res.status}` };
    }
    const xml = await res.text();
    const entries = summariseFeed(xml);
    if (entries < 3) {
      return { ok: false, reason: "Too few entries" };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

function parseJsonFromResponse(text) {
  if (!text) return null;
  const match = text.match(/```json\s*([\s\S]*?)```/i);
  const candidate = match ? match[1] : text;
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

async function askForFeeds(slug, openai, model) {
  const prompt =
    `Suggest up to 3 high-quality RSS or Atom feeds focused on ${slug}. ` +
    `Respond ONLY with a JSON array where each item has feed_url, source, and reason fields.`;
  const response = await openai.responses.create({
    model,
    input: prompt,
    temperature: 0,
    max_output_tokens: 400,
  });
  const raw = response.output_text?.trim();
  const parsed = parseJsonFromResponse(raw || "");
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map((entry) => ({
      feed_url: entry.feed_url || entry.url,
      source: entry.source || entry.title || "unknown",
      reason: entry.reason || entry.summary || "",
    }))
    .filter((entry) => typeof entry.feed_url === "string" && entry.feed_url.startsWith("http"));
}

async function ensureTopic(admin, slug) {
  const display = toDisplayLabel(slug);
  const { data, error } = await admin
    .from("article_topics")
    .upsert({ slug, display_name: display }, { onConflict: "slug" })
    .select("id, slug")
    .single();
  if (error) throw new Error(error.message);
  return data?.id;
}

async function insertFeed(admin, topicId, slug, feed, dryRun) {
  if (dryRun) {
    console.log(`[dry] Would add feed ${feed.feed_url} for ${slug}`);
    return true;
  }
  const { error } = await admin
    .from("article_topic_feeds")
    .insert({
      topic_id: topicId,
      feed_url: feed.feed_url,
      status: "pending",
      metadata: { auto_discovered: true, source: feed.source, note: feed.reason },
    });
  if (error) {
    if (error.code === "23505") {
      console.log(`[skip] Feed already exists: ${feed.feed_url}`);
      return false;
    }
    throw new Error(error.message);
  }
  return true;
}

function aggregateGaps(rows) {
  const map = new Map();
  for (const row of rows || []) {
    const slug = (row.slug || "").trim().toLowerCase();
    if (!slug) continue;
    const current = map.get(slug) || { slug, count: 0, last: 0 };
    current.count += 1;
    const ts = row.reported_at ? Date.parse(row.reported_at) : Date.now();
    if (ts > current.last) current.last = ts;
    map.set(slug, current);
  }
  return Array.from(map.values())
    .sort((a, b) => b.count - a.count || b.last - a.last)
    .map((entry) => entry.slug);
}

function toSlug(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

loadDotEnvLocal();

const args = process.argv.slice(2);
const slugs = new Set();
let fromQueue = false;
let limitPerSlug = 2;
let lookbackHours = 168;
let dryRun = false;

for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === "--slug") {
    const value = args[++i];
    if (!value) usage("--slug requires a value");
    slugs.add(toSlug(value));
  } else if (arg === "--queue") {
    fromQueue = true;
  } else if (arg === "--limit") {
    limitPerSlug = Number.parseInt(args[++i] || "2", 10);
  } else if (arg === "--hours") {
    lookbackHours = Number.parseInt(args[++i] || "168", 10);
  } else if (arg === "--dry") {
    dryRun = true;
  } else if (arg === "-h" || arg === "--help") {
    usage();
  } else {
    usage(`Unknown arg: ${arg}`);
  }
}

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const openaiApiKey = process.env.OPENAI_API_KEY;
const discoveryModel = process.env.OPENAI_DISCOVERY_MODEL || process.env.OPENAI_HOOK_MODEL || "gpt-4o-mini";

if (!supabaseUrl || !serviceRoleKey) usage("Missing Supabase env");
if (!openaiApiKey) usage("OPENAI_API_KEY required");

const admin = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const openai = new OpenAI({ apiKey: openaiApiKey });

async function slugListFromQueue() {
  const since = new Date(Date.now() - lookbackHours * 3600 * 1000).toISOString();
  const { data, error } = await admin
    .from("interest_gap_reports")
    .select("slug, reported_at")
    .gte("reported_at", since)
    .limit(1000);
  if (error) {
    throw new Error(error.message);
  }
  return aggregateGaps(data).slice(0, 5);
}

async function main() {
  let targets = Array.from(slugs.values()).filter(Boolean);
  if (targets.length === 0 && fromQueue) {
    targets = await slugListFromQueue();
  }
  if (targets.length === 0) usage("Provide --slug or --queue to process topics");

  for (const slug of targets) {
    console.log(`\n[info] Processing ${slug}`);
    const topicId = await ensureTopic(admin, slug);
    if (!topicId) {
      console.warn(`[warn] Could not ensure topic for ${slug}`);
      continue;
    }

    let feeds = [];
    try {
      feeds = await askForFeeds(slug, openai, discoveryModel);
    } catch (err) {
      console.warn(`[warn] Model call failed for ${slug}:`, err instanceof Error ? err.message : err);
      continue;
    }

    if (feeds.length === 0) {
      console.log(`[warn] Model returned no feeds for ${slug}`);
      continue;
    }

    let added = 0;
    for (const candidate of feeds) {
      if (added >= limitPerSlug) break;
      const url = String(candidate.feed_url || "").trim();
      if (!url) continue;
      try {
        new URL(url);
      } catch {
        console.log(`[skip] Invalid URL: ${url}`);
        continue;
      }

      const validation = await validateFeed(url);
      if (!validation.ok) {
        console.log(`[skip] ${url} (${validation.reason || 'invalid feed'})`);
        continue;
      }

      try {
        const inserted = await insertFeed(admin, topicId, slug, candidate, dryRun);
        if (inserted) {
          added += 1;
          console.log(`[add] ${url} (${candidate.source || 'unknown source'})`);
        }
      } catch (err) {
        console.warn(`[warn] Failed to insert ${url}:`, err instanceof Error ? err.message : err);
      }
    }

    if (added > 0 && !dryRun) {
      await admin.from("interest_gap_reports").delete().eq("slug", slug);
    }

    if (added === 0) {
      console.log(`[info] No new feeds added for ${slug}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
