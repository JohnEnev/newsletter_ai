#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import {
  discoverFeedsForSlug,
  loadGapSlugs,
  toSlug,
} from "../src/lib/server/feedDiscovery-core.js";

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
const perplexityApiKey = process.env.PERPLEXITY_API_KEY;
const perplexityModel = process.env.PERPLEXITY_MODEL || "sonar";

if (!supabaseUrl || !serviceRoleKey) usage("Missing Supabase env");
if (!openaiApiKey && !perplexityApiKey) usage("Need OPENAI_API_KEY or PERPLEXITY_API_KEY");

const admin = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const openai = openaiApiKey ? new OpenAI({ apiKey: openaiApiKey }) : null;

async function main() {
  let targets = Array.from(slugs.values()).filter(Boolean);
  if (targets.length === 0 && fromQueue) {
    targets = await loadGapSlugs(admin, { lookbackHours, limit: 5 });
  }
  if (targets.length === 0) usage("Provide --slug or --queue to process topics");

  for (const slug of targets) {
    console.log(`\n[info] Processing ${slug}`);
    const result = await discoverFeedsForSlug({
      slug,
      admin,
      openai,
      model: discoveryModel,
      perplexityKey: perplexityApiKey,
      perplexityModel,
      limitPerSlug,
      dryRun,
    });

    if (result.errors.length > 0) {
      result.errors.forEach((err) => console.warn(`[warn] ${slug}: ${err}`));
    }

    const providerLabel = result.provider ? ` via ${result.provider}` : "";

    if (result.added.length > 0) {
      result.added.forEach((url) => console.log(`[add${providerLabel}] ${url}`));
    } else if (result.requested === 0) {
      console.log(`[warn] Model returned no feeds for ${slug}${providerLabel}`);
    } else {
      console.log(`[info] No new feeds added for ${slug}${providerLabel}`);
    }

    result.skipped.forEach((entry) => {
      console.log(`[skip] ${entry.url} (${entry.reason})`);
    });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
