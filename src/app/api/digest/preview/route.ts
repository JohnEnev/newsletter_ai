import { randomBytes } from "crypto";
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { signPayload, type TokenPayload } from "@/lib/tokens";

type AdminUser = {
  email?: string | null;
  id: string;
};

type ArticleRow = {
  id: string;
  title: string;
  url: string;
  summary?: string | null;
};

type PrefsRow = {
  interests?: string | null;
  timeline?: string | null;
  unsubscribed?: boolean | null;
};

function htmlesc(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function getErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error) return error.message || fallback;
  if (typeof error === "string") return error || fallback;
  return fallback;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const previewSecret = process.env.DIGEST_PREVIEW_SECRET;
  const reqSecret = searchParams.get("secret") || "";
  if (!previewSecret || reqSecret !== previewSecret) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const signer = process.env.UNSUBSCRIBE_SECRET || process.env.UNSUBSCRIBE_SECRET_ALT || "";
  if (!supabaseUrl || !serviceRoleKey || !signer) {
    return NextResponse.json({ ok: false, error: "Server not configured" }, { status: 500 });
  }
  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  let userId = searchParams.get("user_id") || "";
  const email = searchParams.get("email") || "";
  if (!userId && !email) {
    return NextResponse.json({ ok: false, error: "Provide user_id or email" }, { status: 400 });
  }
  if (!userId && email) {
    try {
      const { data } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
      const users = (data?.users || []) as AdminUser[];
      const found = users
        .filter((candidate): candidate is AdminUser => Boolean(candidate?.id))
        .find((candidate) => candidate.email && candidate.email.toLowerCase() === email.toLowerCase());
      if (!found) {
        return NextResponse.json({ ok: false, error: "User not found" }, { status: 404 });
      }
      userId = found.id;
    } catch (error) {
      const message = getErrorMessage(error, "Admin listUsers failed");
      return NextResponse.json({ ok: false, error: message }, { status: 500 });
    }
  }

  const { data: prefs, error: prefsErr } = await admin
    .from("user_prefs")
    .select<PrefsRow>("interests, timeline, unsubscribed")
    .eq("user_id", userId)
    .maybeSingle();
  if (prefsErr) {
    return NextResponse.json({ ok: false, error: prefsErr.message }, { status: 500 });
  }

  const { data: articles, error: artErr } = await admin
    .from("articles")
    .select<ArticleRow>("id, title, url, summary")
    .order("created_at", { ascending: false })
    .limit(5);
  if (artErr) {
    return NextResponse.json({ ok: false, error: artErr.message }, { status: 500 });
  }

  const exp = Math.floor(Date.now() / 1000) + 7 * 24 * 3600;
  const newToken = () =>
    signPayload<TokenPayload>({ user_id: userId, exp, n: randomBytes(16).toString("base64url") }, signer);
  const origin = process.env.APP_BASE_URL || "http://localhost:3000";

  const manageUrl = `${origin}/manage?token=${encodeURIComponent(newToken())}`;
  const unsubUrl = `${origin}/unsubscribe?token=${encodeURIComponent(newToken())}`;
  const resubUrl = `${origin}/unsubscribe?token=${encodeURIComponent(newToken())}&action=subscribe`;

  const itemsHtml = (articles || [])
    .map((a) => {
      const yesToken = newToken();
      const noToken = newToken();
      const yes = `${origin}/api/survey?token=${encodeURIComponent(yesToken)}&article_id=${encodeURIComponent(
        a.id
      )}&q=${encodeURIComponent("Helpful?")}&a=${encodeURIComponent("yes")}&redirect=${encodeURIComponent(
        origin + "/survey/thanks"
      )}`;
      const no = `${origin}/api/survey?token=${encodeURIComponent(noToken)}&article_id=${encodeURIComponent(
        a.id
      )}&q=${encodeURIComponent("Helpful?")}&a=${encodeURIComponent("no")}&redirect=${encodeURIComponent(
        origin + "/survey/thanks"
      )}`;
      return `
        <tr>
          <td style="padding:12px 0;">
            <div style="font-size:16px;font-weight:600;line-height:1.3;">
              <a href="${a.url}" style="color:#111;text-decoration:none;">${htmlesc(a.title)}</a>
            </div>
            ${a.summary ? `<div style="color:#555;font-size:14px;margin-top:4px;">${htmlesc(a.summary)}</div>` : ""}
            <div style="margin-top:8px;">
              <a href="${yes}" style="font-size:12px;color:#2563eb;text-decoration:none;margin-right:8px;">👍 Helpful</a>
              <a href="${no}" style="font-size:12px;color:#2563eb;text-decoration:none;">👎 Not really</a>
            </div>
          </td>
        </tr>`;
    })
    .join("\n");

  const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Newsletter Preview</title>
  </head>
  <body style="font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; background:#f8fafc; padding:24px;">
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:680px;margin:0 auto;background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:24px;">
      <tr>
        <td>
          <h1 style="margin:0;font-size:22px;">Your Newsletter</h1>
          <div style="color:#555;font-size:14px;margin-top:6px;">
            ${prefs?.interests ? `Interests: ${htmlesc(prefs.interests)}` : ""}
            ${prefs?.timeline ? `<br/>Timeline: ${htmlesc(prefs.timeline)}` : ""}
            ${prefs?.unsubscribed ? `<br/><strong style="color:#b91c1c;">(Currently unsubscribed)</strong>` : ""}
          </div>
        </td>
      </tr>
      ${itemsHtml}
      <tr>
        <td style="padding-top:16px;border-top:1px solid #e5e7eb;">
          <div style="font-size:12px;color:#6b7280;">Manage Preferences: <a href="${manageUrl}" style="color:#2563eb;">link</a></div>
          <div style="font-size:12px;color:#6b7280;">Unsubscribe: <a href="${unsubUrl}" style="color:#2563eb;">link</a> | Resubscribe: <a href="${resubUrl}" style="color:#2563eb;">link</a></div>
        </td>
      </tr>
    </table>
  </body>
 </html>`;

  return new NextResponse(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
