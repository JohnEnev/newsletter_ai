import { createHmac, timingSafeEqual } from "crypto";
import type { PostgrestError, SupabaseClient } from "@supabase/supabase-js";

function b64urlEncode(buf: Buffer | string) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  return b
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function b64urlDecode(input: string) {
  const norm = input.replace(/-/g, "+").replace(/_/g, "/");
  const pad = 4 - (norm.length % 4);
  const padded = pad < 4 ? norm + "=".repeat(pad) : norm;
  return Buffer.from(padded, "base64");
}

export type TokenPayload = {
  exp?: number;
  n?: string;
  user_id?: string;
  [key: string]: unknown;
};

export type TokenVerificationSuccess<TPayload extends Record<string, unknown>> = {
  ok: true;
  payload: TPayload;
};

export type TokenVerificationFailure = {
  ok: false;
  error: string;
};

export type TokenVerificationResult<TPayload extends Record<string, unknown>> =
  | TokenVerificationSuccess<TPayload>
  | TokenVerificationFailure;

export function verifyTokenWithSecrets<
  TPayload extends Record<string, unknown> = TokenPayload
>(token: string, secrets: string[]): TokenVerificationResult<TPayload> {
  const parts = token.split(".");
  if (parts.length !== 2) return { ok: false as const, error: "Bad token format" };
  const [payloadB64, sigB64] = parts;
  for (const secret of secrets) {
    if (!secret) continue;
    try {
      const expected = createHmac("sha256", secret).update(payloadB64).digest();
      const got = b64urlDecode(sigB64);
      if (expected.length !== got.length || !timingSafeEqual(expected, got)) {
        continue;
      }
      const rawPayload = JSON.parse(
        b64urlDecode(payloadB64).toString("utf-8")
      ) as TokenPayload & TPayload;
      if (typeof rawPayload.exp === "number" && Date.now() / 1000 > rawPayload.exp) {
        return { ok: false as const, error: "Token expired" };
      }
      return { ok: true as const, payload: rawPayload };
    } catch {
      continue;
    }
  }
  return { ok: false as const, error: "Invalid token or signature" };
}

export function defaultTokenSecrets() {
  const a = process.env.UNSUBSCRIBE_SECRET || "";
  const b = process.env.UNSUBSCRIBE_SECRET_ALT || "";
  return [a, b].filter(Boolean) as string[];
}

export function signPayload<TPayload extends Record<string, unknown>>(
  payload: TPayload,
  secret: string
) {
  const payloadB64 = b64urlEncode(JSON.stringify(payload));
  const sig = createHmac("sha256", secret).update(payloadB64).digest();
  return `${payloadB64}.${b64urlEncode(sig)}`;
}

export function getPayloadNonce(payload: TokenPayload | undefined): string | null {
  const n = payload?.n;
  if (!n) return null;
  if (typeof n !== "string") return null;
  return n;
}

type ConsumeNonceResult =
  | { status: "skip" }
  | { status: "ok" }
  | { status: "used" }
  | { status: "error"; error: PostgrestError };

export async function consumeNonce(
  admin: SupabaseClient,
  nonce?: string | null
): Promise<ConsumeNonceResult> {
  if (!nonce) return { status: "skip" };
  const { error } = await admin.from("used_nonces").insert({ nonce });
  if (!error) return { status: "ok" };
  if (error.code === "23505") {
    return { status: "used" };
  }
  return { status: "error", error };
}
