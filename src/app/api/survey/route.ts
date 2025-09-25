import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { verifyTokenWithSecrets, getPayloadNonce } from "@/lib/tokens";

function getSecrets() {
  const a = process.env.UNSUBSCRIBE_SECRET || "";
  const b = process.env.UNSUBSCRIBE_SECRET_ALT || "";
  return [a, b].filter(Boolean) as string[];
}

function getAdmin() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) return null;
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function insertSurvey({
  article_id,
  user_id,
  question,
  answer,
  meta,
}: {
  article_id?: string | null;
  user_id?: string | null;
  question?: string | null;
  answer?: string | null;
  meta?: any;
}) {
  const admin = getAdmin();
  if (!admin) {
    return { ok: false, status: 500, error: "Server not configured" };
  }
  const payload: any = { question: question ?? null, answer: answer ?? null, meta: meta ?? null };
  if (article_id) payload.article_id = article_id;
  if (user_id) payload.user_id = user_id;
  const { error } = await admin.from("surveys").insert(payload);
  if (error) return { ok: false, status: 500, error: error.message };
  return { ok: true, status: 200 };
}

export async function GET(request: Request) {
  const secrets = getSecrets();
  const { searchParams } = new URL(request.url);
  const token = searchParams.get("token") || "";
  const article_id = searchParams.get("article_id");
  const question = searchParams.get("q");
  const answer = searchParams.get("a");
  const redirectTo = searchParams.get("redirect");
  const metaRaw = searchParams.get("meta");
  let meta: any = null;
  try { if (metaRaw) meta = JSON.parse(metaRaw); } catch {}

  const ver = verifyTokenWithSecrets(token, secrets);
  if (!ver.ok) {
    return NextResponse.json({ ok: false, error: ver.error }, { status: 400 });
  }
  const user_id = ver.payload?.user_id ?? null;
  // One-time nonce: consume if present
  const nonce = getPayloadNonce(ver.payload);
  if (nonce) {
    const admin = getAdmin();
    if (!admin) return NextResponse.json({ ok: false, error: "Server not configured" }, { status: 500 });
    const { data: seen } = await admin.from("used_nonces").select("nonce").eq("nonce", nonce).maybeSingle();
    if (seen) {
      if (redirectTo) return NextResponse.redirect(`${process.env.APP_BASE_URL || ''}/link/used`);
      return NextResponse.json({ ok: false, error: "Link already used" }, { status: 410 });
    }
    await admin.from("used_nonces").insert({ nonce });
  }
  const ins = await insertSurvey({ article_id, user_id, question, answer, meta });
  if (!ins.ok) {
    return NextResponse.json({ ok: false, error: ins.error }, { status: ins.status });
  }
  if (redirectTo) {
    return NextResponse.redirect(redirectTo);
  }
  return NextResponse.json({ ok: true });
}

export async function POST(request: Request) {
  const secrets = getSecrets();
  const body = await request.json().catch(() => ({}));
  const token = String(body?.token || "");
  const article_id = body?.article_id ? String(body.article_id) : undefined;
  const question = body?.question ? String(body.question) : undefined;
  const answer = body?.answer ? String(body.answer) : undefined;
  const meta = body?.meta ?? undefined;

  const ver = verifyTokenWithSecrets(token, secrets);
  if (!ver.ok) {
    return NextResponse.json({ ok: false, error: ver.error }, { status: 400 });
  }
  const user_id = ver.payload?.user_id ?? null;
  const nonce = getPayloadNonce(ver.payload);
  if (nonce) {
    const admin = getAdmin();
    if (!admin) return NextResponse.json({ ok: false, error: "Server not configured" }, { status: 500 });
    const { data: seen } = await admin.from("used_nonces").select("nonce").eq("nonce", nonce).maybeSingle();
    if (seen) return NextResponse.json({ ok: false, error: "Link already used" }, { status: 410 });
    await admin.from("used_nonces").insert({ nonce });
  }
  const ins = await insertSurvey({ article_id, user_id, question, answer, meta });
  if (!ins.ok) {
    return NextResponse.json({ ok: false, error: ins.error }, { status: ins.status });
  }
  return NextResponse.json({ ok: true });
}
