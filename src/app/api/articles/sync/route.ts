import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { createHmac, timingSafeEqual } from "crypto";
import { gatherArticles, ingestArticles, sampleDataPath } from "@/lib/server/articles";

export const runtime = "nodejs";

function logAuthProbe({
  route,
  cronHeader,
  signature,
  requiredSecret,
  providedSecret,
  headerNames,
}: {
  route: string;
  cronHeader: string | null;
  signature: string | null;
  requiredSecret: string;
  providedSecret: string;
  headerNames: string[];
}) {
  console.log(`[${route}] auth probe`, {
    cronHeader,
    signaturePresent: Boolean(signature),
    signatureLength: signature?.length ?? 0,
    signaturePrefix: signature ? signature.slice(0, 6) : null,
    requiredSecretPresent: Boolean(requiredSecret),
    providedSecretPresent: Boolean(providedSecret),
    providedSecretLength: providedSecret ? providedSecret.length : 0,
    cronSecretPresent: Boolean(process.env.VERCEL_CRON_SECRET),
    headerNames,
  });
}

function readSecret(request: Request, url: URL) {
  const header = request.headers.get("authorization") || "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const querySecret = url.searchParams.get("secret") || "";
  return bearer || querySecret;
}

function parseLimit(raw: string | null) {
  if (!raw) return null;
  const value = Number.parseInt(raw, 10);
  if (Number.isNaN(value) || value <= 0) return null;
  return value;
}

function parseSignatureVariants(signature: string) {
  const trimmed = signature.trim();
  const candidates = [trimmed];
  if (trimmed.startsWith("sha1=")) candidates.push(trimmed.slice(5));
  if (trimmed.startsWith("sha256=")) candidates.push(trimmed.slice(7));
  return Array.from(new Set(candidates));
}

function buffersEqual(a: Buffer, b: Buffer) {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return a.toString("hex") === b.toString("hex");
  }
}

async function isValidCronRequest(request: Request, fallbackSecret: string) {
  if (!request.headers.get("x-vercel-cron")) return false;
  const secret = process.env.VERCEL_CRON_SECRET || fallbackSecret;
  if (!secret) return false;
  const signature = request.headers.get("x-vercel-signature");
  if (!signature) return false;

  const body = await request.clone().text();
  const expectedBuffer = createHmac("sha256", secret).update(body).digest();
  const variants = parseSignatureVariants(signature);

  for (const variant of variants) {
    try {
      const providedHex = Buffer.from(variant, "hex");
      if (buffersEqual(providedHex, expectedBuffer)) return true;
    } catch {}

    try {
      const providedBase64 = Buffer.from(variant, "base64");
      if (buffersEqual(providedBase64, expectedBuffer)) return true;
    } catch {}
  }

  return false;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const requiredSecret = process.env.ARTICLES_SYNC_SECRET || process.env.CRON_SECRET || "";
  const providedSecret = readSecret(request, url);
  logAuthProbe({
    route: "articles-sync",
    cronHeader: request.headers.get("x-vercel-cron"),
    signature: request.headers.get("x-vercel-signature"),
    requiredSecret,
    providedSecret,
    headerNames: Array.from(request.headers.keys()).slice(0, 20),
  });
  const authorized = (requiredSecret && providedSecret === requiredSecret)
    || (await isValidCronRequest(request, requiredSecret));
  if (!authorized) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const dryRun = url.searchParams.get("dry") === "1";
  const limit = parseLimit(url.searchParams.get("limit"));
  const noDefaultFeeds = url.searchParams.get("noDefault") === "1";
  const feeds = url
    .searchParams
    .getAll("feed")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  const sourceFile = url.searchParams.get("source") || undefined;

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    return NextResponse.json({ ok: false, error: "Missing Supabase env" }, { status: 500 });
  }

  try {
    const gathered = await gatherArticles({
      feedUrls: feeds,
      noDefaultFeeds,
      sourceFile: sourceFile ?? sampleDataPath,
    });
    const shortlisted = limit ? gathered.slice(0, limit) : gathered;

    if (shortlisted.length === 0) {
      return NextResponse.json({ ok: true, dryRun, gathered: 0, inserted: 0, feeds }, { status: 200 });
    }

    const admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const result = await ingestArticles({ supabase: admin, articles: shortlisted, dryRun });

    return NextResponse.json({
      ok: true,
      dryRun,
      feeds,
      noDefaultFeeds,
      gathered: gathered.length,
      processed: shortlisted.length,
      inserted: result.inserted,
    });
  } catch (error) {
    console.error("[articles-sync]", error);
    return NextResponse.json({ ok: false, error: "Failed to sync articles" }, { status: 500 });
  }
}
