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
  } catch (error) {
    console.warn("[warn] Failed to load .env.local", error instanceof Error ? error.message : error);
  }
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function titleize(value) {
  return String(value || "")
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function usage(message) {
  if (message) console.error(`Error: ${message}`);
  console.log(`\nManage topic feeds\n===================\n\nUsage:\n  node scripts/manage-topic-feeds.mjs add --topic geopolitics --display "Geopolitics" --feed https://foreignpolicy.com/feed/ [--feed https://example.com/rss]\n  node scripts/manage-topic-feeds.mjs list\n  node scripts/manage-topic-feeds.mjs deactivate --feed https://example.com/rss\n  node scripts/manage-topic-feeds.mjs activate --feed https://example.com/rss\n\nOptions:\n  --topic <slug-or-name>   Topic slug. If non-slug text is provided, it will be slugified.\n  --display <name>         Optional friendly name when creating a new topic.\n  --feed <url>             RSS/Atom feed URL. Repeat for multiple feeds.\n  --status <value>         Optional status override when adding feeds (defaults to active).\n\nNotes:\n  • Requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in environment.\n  • Existing feeds will be updated rather than duplicated.\n`);
  process.exit(message ? 1 : 0);
}

function parseArgs(argv) {
  const args = [...argv];
  const command = args.shift() || "";
  const opts = { command: command || "add", feeds: [] };

  while (args.length > 0) {
    const current = args.shift();
    switch (current) {
      case "--topic":
        opts.topic = args.shift();
        break;
      case "--display":
        opts.display = args.shift();
        break;
      case "--feed":
        opts.feeds.push(args.shift());
        break;
      case "--status":
        opts.status = args.shift();
        break;
      default:
        usage(`Unknown argument: ${current}`);
    }
  }

  return opts;
}

function ensureEnv() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    usage("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment.");
  }
  return { supabaseUrl, serviceRoleKey };
}

async function listFeeds(admin) {
  const { data: topics } = await admin
    .from("article_topics")
    .select("id, slug, display_name")
    .order("slug", { ascending: true });

  const { data: feeds } = await admin
    .from("article_topic_feeds")
    .select("feed_url, status, topic_id, last_synced_at")
    .order("feed_url", { ascending: true });

  if (!Array.isArray(topics) || !Array.isArray(feeds)) {
    console.log("No topics or feeds found.");
    return;
  }

  const topicMap = new Map(topics.map((topic) => [topic.id, topic]));
  console.log("\nTopics & feeds:\n----------------");
  for (const feed of feeds) {
    const topic = topicMap.get(feed.topic_id);
    const topicLabel = topic ? `${topic.slug} (${topic.display_name || topic.slug})` : "<unknown topic>";
    const synced = feed.last_synced_at ? new Date(feed.last_synced_at).toISOString() : "never";
    console.log(`- ${feed.feed_url}\n    topic: ${topicLabel}\n    status: ${feed.status || "unknown"}\n    last synced: ${synced}`);
  }
  console.log();
}

async function ensureTopic(admin, topicInput, displayInput) {
  const slugCandidate = slugify(topicInput);
  if (!slugCandidate) usage("Provide a topic via --topic.");
  const display = displayInput || titleize(slugCandidate);

  const { data: existing, error } = await admin
    .from("article_topics")
    .select("id, slug, display_name")
    .eq("slug", slugCandidate)
    .maybeSingle();
  if (error && error.code !== "PGRST116") throw error;
  if (existing) {
    if (displayInput && existing.display_name !== display) {
      await admin
        .from("article_topics")
        .update({ display_name: display })
        .eq("id", existing.id);
    }
    return existing;
  }

  const { data: inserted, error: insertError } = await admin
    .from("article_topics")
    .insert({ slug: slugCandidate, display_name: display })
    .select("id, slug, display_name")
    .single();
  if (insertError) throw insertError;
  return inserted;
}

async function upsertFeeds(admin, topic, feeds, statusOverride) {
  if (!Array.isArray(feeds) || feeds.length === 0) {
    usage("Provide at least one --feed when adding feeds.");
  }

  for (const raw of feeds) {
    const feedUrl = String(raw || "").trim();
    if (!feedUrl) continue;
    const record = {
      feed_url: feedUrl,
      topic_id: topic.id,
      status: statusOverride || undefined,
    };

    const { data, error } = await admin
      .from("article_topic_feeds")
      .upsert(record, { onConflict: "feed_url" })
      .select("feed_url, status, topic_id")
      .single();
    if (error) throw error;
    console.log(`Upserted feed ${data.feed_url} → topic ${topic.slug}`);
  }
}

async function setFeedStatus(admin, feeds, status) {
  if (feeds.length === 0) usage("Provide at least one --feed to change status.");
  for (const raw of feeds) {
    const feedUrl = String(raw || "").trim();
    if (!feedUrl) continue;
    const { error } = await admin
      .from("article_topic_feeds")
      .update({ status })
      .eq("feed_url", feedUrl);
    if (error) throw error;
    console.log(`Set ${feedUrl} → ${status}`);
  }
}

async function main() {
  loadDotEnvLocal();
  if (process.argv.length <= 2) usage();

  const parsed = parseArgs(process.argv.slice(2));
  const { supabaseUrl, serviceRoleKey } = ensureEnv();
  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  try {
    switch (parsed.command) {
      case "list":
        await listFeeds(admin);
        break;
      case "activate":
        await setFeedStatus(admin, parsed.feeds, "active");
        break;
      case "deactivate":
        await setFeedStatus(admin, parsed.feeds, "inactive");
        break;
      case "add":
      default: {
        if (!parsed.topic) usage("--topic is required for add command.");
        const topic = await ensureTopic(admin, parsed.topic, parsed.display);
        await upsertFeeds(admin, topic, parsed.feeds, parsed.status);
        console.log("Done.");
        break;
      }
    }
  } catch (error) {
    console.error("Operation failed:", error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

main();
