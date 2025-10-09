import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import {
  verifyTokenWithSecrets,
  getPayloadNonce,
  consumeNonce,
  type TokenPayload,
} from "@/lib/tokens";

function getSecrets() {
  const primary = process.env.UNSUBSCRIBE_SECRET || "";
  const secondary = process.env.UNSUBSCRIBE_SECRET_ALT || "";
  return [primary, secondary].filter(Boolean) as string[];
}

function getAdmin() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) return null;
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

type AdminClient = ReturnType<typeof getAdmin>;

type SurveyInsert = {
  article_id?: string | null;
  user_id?: string | null;
  question?: string | null;
  answer?: string | null;
  meta?: unknown;
};

async function insertSurvey(admin: AdminClient, input: SurveyInsert) {
  const client = admin ?? getAdmin();
  if (!client) {
    return { ok: false, status: 500, error: "Server not configured" as const };
  }
  const payload: Record<string, unknown> = {
    question: input.question ?? null,
    answer: input.answer ?? null,
    meta: input.meta ?? null,
  };
  if (input.article_id) payload.article_id = input.article_id;
  if (input.user_id) payload.user_id = input.user_id;
  const { error } = await client.from("surveys").insert(payload);
  if (error) return { ok: false, status: 500 as const, error: error.message };
  return { ok: true, status: 200 as const };
}

function parseMetaParam(metaRaw: string | null) {
  if (!metaRaw) return null;
  try {
    return JSON.parse(metaRaw) as unknown;
  } catch {
    return null;
  }
}

export async function GET(request: Request) {
  const secrets = getSecrets();
  const { searchParams } = new URL(request.url);
  const token = searchParams.get("token") || "";
  const article_id = searchParams.get("article_id") ?? undefined;
  const question = searchParams.get("q") ?? undefined;
  const answer = searchParams.get("a") ?? undefined;
  const redirectTo = searchParams.get("redirect") ?? undefined;
  const meta = parseMetaParam(searchParams.get("meta"));

  const verification = verifyTokenWithSecrets<TokenPayload>(token, secrets);
  if (!verification.ok) {
    return NextResponse.json({ ok: false, error: verification.error }, { status: 400 });
  }

  const payload = verification.payload;
  const user_id = payload.user_id ?? null;
  const nonce = getPayloadNonce(payload);
  let admin: AdminClient = null;

  if (nonce) {
    admin = getAdmin();
    if (!admin) {
      return NextResponse.json({ ok: false, error: "Server not configured" }, { status: 500 });
    }
    const nonceResult = await consumeNonce(admin, nonce);
    if (nonceResult.status === "used") {
      if (redirectTo) {
        return NextResponse.redirect(`${process.env.APP_BASE_URL || ""}/link/used`);
      }
      return NextResponse.json({ ok: false, error: "Link already used" }, { status: 410 });
    }
    if (nonceResult.status === "error") {
      if (process.env.NODE_ENV !== "production") {
        console.error("Failed to record nonce", nonceResult.error.message);
      }
      return NextResponse.json({ ok: false, error: "Failed to validate link" }, { status: 500 });
    }
  }

  const insertResult = await insertSurvey(admin, {
    article_id,
    user_id,
    question,
    answer,
    meta,
  });
  if (!insertResult.ok) {
    return NextResponse.json({ ok: false, error: insertResult.error }, { status: insertResult.status });
  }
  if (redirectTo) {
    return NextResponse.redirect(redirectTo);
  }
  return NextResponse.json({ ok: true });
}

export async function POST(request: Request) {
  const secrets = getSecrets();
  const bodyRaw = await request.json().catch(() => null);
  const body = (bodyRaw && typeof bodyRaw === "object" ? bodyRaw : {}) as Record<string, unknown>;

  const token = typeof body.token === "string" ? body.token : "";
  const article_id = typeof body.article_id === "string" ? body.article_id : undefined;
  const question = typeof body.question === "string" ? body.question : undefined;
  const answer = typeof body.answer === "string" ? body.answer : undefined;
  const meta = body.meta ?? undefined;

  const verification = verifyTokenWithSecrets<TokenPayload>(token, secrets);
  if (!verification.ok) {
    return NextResponse.json({ ok: false, error: verification.error }, { status: 400 });
  }

  const payload = verification.payload;
  const user_id = payload.user_id ?? null;
  const nonce = getPayloadNonce(payload);
  let admin: AdminClient = null;

  if (nonce) {
    admin = getAdmin();
    if (!admin) {
      return NextResponse.json({ ok: false, error: "Server not configured" }, { status: 500 });
    }
    const nonceResult = await consumeNonce(admin, nonce);
    if (nonceResult.status === "used") {
      return NextResponse.json({ ok: false, error: "Link already used" }, { status: 410 });
    }
    if (nonceResult.status === "error") {
      if (process.env.NODE_ENV !== "production") {
        console.error("Failed to record nonce", nonceResult.error.message);
      }
      return NextResponse.json({ ok: false, error: "Failed to validate link" }, { status: 500 });
    }
  }

  const insertResult = await insertSurvey(admin, {
    article_id,
    user_id,
    question,
    answer,
    meta,
  });
  if (!insertResult.ok) {
    return NextResponse.json({ ok: false, error: insertResult.error }, { status: insertResult.status });
  }
  return NextResponse.json({ ok: true });
}
