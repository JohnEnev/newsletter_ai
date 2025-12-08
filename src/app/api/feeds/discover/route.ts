import { createHmac, timingSafeEqual } from "crypto";
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import {
  discoverFeedsForSlug,
  loadGapSlugs,
  toSlug,
} from "@/lib/server/feedDiscovery-core.js";

function parseNumber(value: string | null, fallback: number, { min, max }: { min: number; max: number }) {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function buildInternalBaseUrl() {
  const envBase = process.env.APP_BASE_URL?.trim();
  if (envBase) return envBase.replace(/\/$/, "");
  const vercel = process.env.VERCEL_URL?.trim();
  if (vercel) return `https://${vercel.replace(/^https?:\/\//, "")}`;
  return "http://localhost:3000";
}

async function triggerArticleSync(feeds: string[]) {
  const uniqueFeeds = Array.from(new Set(feeds.filter((value) => value && value.trim().length > 0)));
  if (uniqueFeeds.length === 0) return null;

  const secret = process.env.ARTICLES_SYNC_SECRET || process.env.CRON_SECRET || process.env.DIGEST_RUN_SECRET || "";
  if (!secret) return null;

  const base = buildInternalBaseUrl();
  const syncUrl = new URL(`${base}/api/articles/sync`);
  syncUrl.searchParams.set("noDefault", "1");
  for (const feed of uniqueFeeds) {
    syncUrl.searchParams.append("feed", feed);
  }

  try {
    const res = await fetch(syncUrl.toString(), {
      method: "GET",
      headers: { Authorization: `Bearer ${secret}` },
    });
    const data = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    if (process.env.NODE_ENV !== "production") {
      console.warn("[feeds] Auto article sync failed", err instanceof Error ? err.message : err);
    }
    return null;
  }
}

async function verifyCronSignature(request: Request, secret: string, allowUnsigned: boolean) {
  const cronHeader = request.headers.get("x-vercel-cron");
  const vercelId = request.headers.get("x-vercel-id");
  if (!secret) {
    return Boolean(allowUnsigned && cronHeader && vercelId);
  }
  const signature = request.headers.get("x-vercel-signature");
  if (allowUnsigned && vercelId && !signature && cronHeader) return true;
  if (!signature) return false;
  const body = await request.clone().text();
  const digest = createHmac("sha256", secret).update(body).digest();

  const candidates = [signature.trim()];
  if (signature.startsWith("sha256=")) candidates.push(signature.slice(7));
  if (signature.startsWith("sha1=")) candidates.push(signature.slice(5));

  for (const candidate of candidates) {
    try {
      const provided = Buffer.from(candidate, "hex");
      if (provided.length === digest.length && timingSafeEqual(provided, digest)) return true;
    } catch {}

    try {
      const provided = Buffer.from(candidate, "base64");
      if (provided.length === digest.length && timingSafeEqual(provided, digest)) return true;
    } catch {}
  }
  return false;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const runSecret = process.env.FEED_DISCOVERY_SECRET || process.env.DIGEST_RUN_SECRET || process.env.CRON_SECRET || "";
  const providedSecret = url.searchParams.get("secret") || "";
  const authHeader = request.headers.get("authorization") || "";
  const bearerToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  const manualMatch = runSecret && (providedSecret === runSecret || bearerToken === runSecret);

  const cronSecret = process.env.VERCEL_CRON_SECRET || runSecret;
  const hasCronHeader = Boolean(request.headers.get("x-vercel-cron"));
  const hasVercelId = Boolean(request.headers.get("x-vercel-id"));
  const allowUnsigned = Boolean(
    process.env.ALLOW_VERCEL_INTERNAL_CRON === "1" || (!cronSecret && hasCronHeader && hasVercelId),
  );
  const cronMatch = await verifyCronSignature(request, cronSecret, allowUnsigned);

  if (!manualMatch && !cronMatch) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const dryRun = url.searchParams.get("dry") === "1";
  const limitPerSlug = parseNumber(url.searchParams.get("feeds"), 10, { min: 1, max: 12 });
  const maxTopics = parseNumber(url.searchParams.get("topics"), 4, { min: 1, max: 8 });
  const lookbackHours = parseNumber(url.searchParams.get("hours"), 168, { min: 1, max: 720 });
  const fromQueue = url.searchParams.get("queue") !== "0";

  const rawSlugs = url.searchParams.getAll("slug");
  const explicitSlugs = rawSlugs
    .flatMap((value) => value.split(","))
    .map((value) => toSlug(value))
    .filter((value) => value.length > 0);

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const openaiApiKey = process.env.OPENAI_API_KEY;
  const discoveryModel = process.env.OPENAI_DISCOVERY_MODEL || process.env.OPENAI_HOOK_MODEL || "gpt-4o-mini";
  const perplexityKey = process.env.PERPLEXITY_API_KEY;
  const perplexityModel = process.env.PERPLEXITY_MODEL || "sonar";

  if (!supabaseUrl || !serviceRoleKey) {
    return NextResponse.json({ ok: false, error: "Missing Supabase env" }, { status: 500 });
  }
  if (!openaiApiKey && !perplexityKey) {
    return NextResponse.json({ ok: false, error: "No discovery model configured" }, { status: 500 });
  }
  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const openai = openaiApiKey ? new OpenAI({ apiKey: openaiApiKey }) : null;

  const targets = explicitSlugs.slice(0, maxTopics);
  if ((fromQueue && targets.length < maxTopics) || targets.length === 0) {
    const queueLimit = Math.max(maxTopics - targets.length, targets.length === 0 ? maxTopics : 1);
    try {
      const queued = await loadGapSlugs(admin, { lookbackHours, limit: queueLimit });
      for (const slug of queued) {
        if (targets.includes(slug)) continue;
        targets.push(slug);
        if (targets.length >= maxTopics) break;
      }
    } catch (err) {
      return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
    }
  }

  if (targets.length === 0) {
    return NextResponse.json({ ok: true, message: "No topics to process", dryRun, discovered: [] });
  }

  const results = [];
  for (const slug of targets) {
    const outcome = await discoverFeedsForSlug({
      slug,
      admin,
      openai,
      model: discoveryModel,
      perplexityKey,
      perplexityModel,
      limitPerSlug,
      dryRun,
    });
    results.push(outcome);
  }

  const totalAdded = results.reduce((sum, entry) => sum + entry.added.length, 0);
  let syncResult: { ok: boolean; status: number; data: unknown } | null = null;
  if (!dryRun && totalAdded > 0) {
    const feedsToSync = results.flatMap((entry) => entry.added || []);
    syncResult = await triggerArticleSync(feedsToSync);
  }

  return NextResponse.json({
    ok: true,
    dryRun,
    topics: targets,
    added: totalAdded,
    results,
    sync: syncResult,
  });
}
