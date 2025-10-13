import { NextResponse } from "next/server";
import { randomBytes, createHmac } from "crypto";
import { timingSafeEqual } from "crypto";
import { createClient } from "@supabase/supabase-js";
import { signPayload, type TokenPayload } from "@/lib/tokens";

type PrefRow = {
  user_id: string;
  interests: string | null;
  timeline: string | null;
  unsubscribed: boolean | null;
  send_timezone: string | null;
  send_hour: number | null;
  send_minute: number | null;
};

type ArticleRow = {
  id: string;
  title: string;
  url: string;
  summary: string | null;
};

const RESEND_ENDPOINT = "https://api.resend.com/emails";

function logAuthProbe({
  route,
  cronHeader,
  signature,
  requiredSecret,
  providedSecret,
  bearerToken,
}: {
  route: string;
  cronHeader: string | null;
  signature: string | null;
  requiredSecret: string;
  providedSecret: string;
  bearerToken: string;
}) {
  console.log(`[${route}] auth probe`, {
    cronHeader,
    signaturePresent: Boolean(signature),
    signatureLength: signature?.length ?? 0,
    signaturePrefix: signature ? signature.slice(0, 6) : null,
    requiredSecretPresent: Boolean(requiredSecret),
    providedSecretPresent: Boolean(providedSecret),
    providedSecretLength: providedSecret ? providedSecret.length : 0,
    bearerTokenPresent: Boolean(bearerToken),
    bearerTokenLength: bearerToken ? bearerToken.length : 0,
    cronSecretPresent: Boolean(process.env.VERCEL_CRON_SECRET),
  });
}

function getTimeInTimezone(timeZone: string, reference: Date) {
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZone,
    });
    const parts = formatter.formatToParts(reference);
    const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
    const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
    if (Number.isNaN(hour) || Number.isNaN(minute)) throw new Error("Invalid time part");
    return { hour, minute };
  } catch {
    return { hour: reference.getUTCHours(), minute: reference.getUTCMinutes() };
  }
}

function minutesBetween(targetHour: number, targetMinute: number, currentHour: number, currentMinute: number) {
  const targetTotal = targetHour * 60 + targetMinute;
  const currentTotal = currentHour * 60 + currentMinute;
  const diff = Math.abs(targetTotal - currentTotal);
  return Math.min(diff, 1440 - diff);
}

function buildDigestHtml({
  prefs,
  articles,
  manageUrl,
  unsubscribeUrl,
  resubscribeUrl,
  yesNoLinks,
}: {
  prefs: { interests?: string | null; timeline?: string | null; unsubscribed?: boolean | null };
  articles: { id: string; title: string; url: string; summary?: string | null }[];
  manageUrl: string;
  unsubscribeUrl: string;
  resubscribeUrl: string;
  yesNoLinks: Record<string, { yes: string; no: string }>;
}) {
  const esc = (value: string | null | undefined) =>
    String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const itemsHtml = (articles || [])
    .map((article) => {
      const links = yesNoLinks[article.id];
      return `
        <tr>
          <td style="padding:12px 0;">
            <div style="font-size:16px;font-weight:600;line-height:1.3;">
              <a href="${article.url}" style="color:#111;text-decoration:none;">${esc(article.title)}</a>
            </div>
            ${article.summary ? `<div style=\"color:#555;font-size:14px;margin-top:4px;\">${esc(article.summary)}</div>` : ""}
            <div style="margin-top:8px;">
              <a href="${links.yes}" style="font-size:12px;color:#2563eb;text-decoration:none;margin-right:8px;">👍 Helpful</a>
              <a href="${links.no}" style="font-size:12px;color:#2563eb;text-decoration:none;">👎 Not really</a>
            </div>
          </td>
        </tr>`;
    })
    .join("\n");

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Newsletter</title>
  </head>
  <body style="font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; background:#f8fafc; padding:24px;">
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:680px;margin:0 auto;background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:24px;">
      <tr>
        <td>
          <h1 style="margin:0;font-size:22px;">Your Newsletter</h1>
          <div style="color:#555;font-size:14px;margin-top:6px;">
            ${prefs?.interests ? `Interests: ${esc(prefs.interests)}` : ""}
            ${prefs?.timeline ? `<br/>Timeline: ${esc(prefs.timeline)}` : ""}
            ${prefs?.unsubscribed ? `<br/><strong style=\"color:#b91c1c;\">(Currently unsubscribed)</strong>` : ""}
          </div>
        </td>
      </tr>
      ${itemsHtml}
      <tr>
        <td style="padding-top:16px;border-top:1px solid #e5e7eb;">
          <div style="font-size:12px;color:#6b7280;">Manage Preferences: <a href="${manageUrl}" style="color:#2563eb;">link</a></div>
          <div style="font-size:12px;color:#6b7280;">Unsubscribe: <a href="${unsubscribeUrl}" style="color:#2563eb;">link</a> | Resubscribe: <a href="${resubscribeUrl}" style="color:#2563eb;">link</a></div>
        </td>
      </tr>
    </table>
  </body>
 </html>`;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const runSecret = process.env.DIGEST_RUN_SECRET || process.env.CRON_SECRET || "";
  const providedSecret = url.searchParams.get("secret") || "";
  const authHeader = request.headers.get("authorization") || "";
  const bearerToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  const manualMatch = runSecret && (providedSecret === runSecret || bearerToken === runSecret);

  const cronSecret = process.env.VERCEL_CRON_SECRET || runSecret;
  const signature = request.headers.get("x-vercel-signature");
  const cronHeader = request.headers.get("x-vercel-cron");

  logAuthProbe({
    route: "digest-run",
    cronHeader,
    signature,
    requiredSecret: runSecret,
    providedSecret,
    bearerToken,
  });

  const cronMatch = await (async () => {
    if (!cronSecret || !signature || !cronHeader) return false;
    const body = await request.clone().text();
    const digest = createHmac("sha256", cronSecret).update(body).digest();

    const signatures = [signature.trim()];
    if (signature.startsWith("sha256=")) signatures.push(signature.slice(7));
    if (signature.startsWith("sha1=")) signatures.push(signature.slice(5));

    for (const candidate of signatures) {
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
  })();

  const hasValidSecret = manualMatch || cronMatch;
  if (!hasValidSecret) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const windowMinutes = (() => {
    const raw = Number.parseInt(url.searchParams.get("window") || "15", 10);
    if (Number.isNaN(raw)) return 15;
    return Math.min(Math.max(raw, 1), 60);
  })();
  const dryRun = url.searchParams.get("dry") === "1";

  const resendApiKey = process.env.RESEND_API_KEY;
  const fromEnv = process.env.EMAIL_FROM || "Newsletter AI <onboarding@resend.dev>";
  const subject = process.env.EMAIL_SUBJECT || "Your Newsletter";
  const base = process.env.APP_BASE_URL || "http://localhost:3000";
  const signer = process.env.UNSUBSCRIBE_SECRET || process.env.UNSUBSCRIBE_SECRET_ALT || "";
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    return NextResponse.json({ ok: false, error: "Missing Supabase env" }, { status: 500 });
  }
  if (!signer) {
    return NextResponse.json({ ok: false, error: "Missing unsubscribe secret" }, { status: 500 });
  }
  if (!resendApiKey && !dryRun) {
    return NextResponse.json({ ok: false, error: "RESEND_API_KEY not configured" }, { status: 500 });
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: rawPrefs, error: prefsError } = await admin
    .from("user_prefs")
    .select("user_id, interests, timeline, unsubscribed, send_timezone, send_hour, send_minute");
  if (prefsError) {
    return NextResponse.json({ ok: false, error: prefsError.message }, { status: 500 });
  }
  const prefs = (rawPrefs ?? []) as PrefRow[];
  const activePrefs = prefs.filter((pref) => !pref.unsubscribed);
  if (activePrefs.length === 0) {
    return NextResponse.json({ ok: true, sent: 0, message: "No active users" });
  }

  const now = new Date();
  const duePrefs = activePrefs.filter((pref) => {
    const timezone = pref.send_timezone || "UTC";
    const targetHour = typeof pref.send_hour === "number" ? pref.send_hour : 9;
    const targetMinute = typeof pref.send_minute === "number" ? pref.send_minute : 0;
    const current = getTimeInTimezone(timezone, now);
    const diff = minutesBetween(targetHour, targetMinute, current.hour, current.minute);
    return diff <= windowMinutes;
  });

  if (duePrefs.length === 0) {
    return NextResponse.json({ ok: true, sent: 0, message: "No users within window" });
  }

  const { data: rawArticles, error: artErr } = await admin
    .from("articles")
    .select("id, title, url, summary")
    .order("created_at", { ascending: false })
    .limit(5);
  if (artErr) {
    return NextResponse.json({ ok: false, error: artErr.message }, { status: 500 });
  }
  const articles = (rawArticles ?? []) as ArticleRow[];

  const { data: userList } = await admin.auth.admin.listUsers({ page: 1, perPage: 2000 });
  const emailLookup = new Map<string, string>();
  for (const user of userList?.users || []) {
    if (user.id && user.email) {
      emailLookup.set(user.id, user.email);
    }
  }

  const results: Array<{ userId: string; email?: string; status: "sent" | "skipped" | "dry"; error?: string }> = [];

  for (const pref of duePrefs) {
    const email = emailLookup.get(pref.user_id);
    if (!email) {
      results.push({ userId: pref.user_id, status: "skipped", error: "No email" });
      continue;
    }

    const manageToken = signPayload<TokenPayload>({
      user_id: pref.user_id,
      exp: Math.floor(Date.now() / 1000) + 7 * 24 * 3600,
      n: randomBytes(16).toString("base64url"),
    }, signer);

    const makeLink = (path: string, token: string, extra: string = "") =>
      `${base}${path}?token=${encodeURIComponent(token)}${extra}`;

    const unsubscribeToken = signPayload<TokenPayload>({
      user_id: pref.user_id,
      exp: Math.floor(Date.now() / 1000) + 7 * 24 * 3600,
      n: randomBytes(16).toString("base64url"),
    }, signer);
    const resubscribeToken = signPayload<TokenPayload>({
      user_id: pref.user_id,
      exp: Math.floor(Date.now() / 1000) + 7 * 24 * 3600,
      n: randomBytes(16).toString("base64url"),
    }, signer);

    const manageUrl = makeLink("/manage", manageToken);
    const unsubscribeUrl = makeLink("/unsubscribe", unsubscribeToken);
    const resubscribeUrl = makeLink("/unsubscribe", resubscribeToken, "&action=subscribe");

    const yesNoLinks: Record<string, { yes: string; no: string }> = {};
    for (const article of articles) {
      const yesToken = signPayload<TokenPayload>({
        user_id: pref.user_id,
        exp: Math.floor(Date.now() / 1000) + 7 * 24 * 3600,
        n: randomBytes(16).toString("base64url"),
      }, signer);
      const noToken = signPayload<TokenPayload>({
        user_id: pref.user_id,
        exp: Math.floor(Date.now() / 1000) + 7 * 24 * 3600,
        n: randomBytes(16).toString("base64url"),
      }, signer);

      yesNoLinks[article.id] = {
        yes: `${base}/api/survey?token=${encodeURIComponent(yesToken)}&article_id=${encodeURIComponent(article.id)}&q=${encodeURIComponent("Helpful?")}&a=${encodeURIComponent("yes")}&redirect=${encodeURIComponent(base + "/survey/thanks")}`,
        no: `${base}/api/survey?token=${encodeURIComponent(noToken)}&article_id=${encodeURIComponent(article.id)}&q=${encodeURIComponent("Helpful?")}&a=${encodeURIComponent("no")}&redirect=${encodeURIComponent(base + "/survey/thanks")}`,
      };
    }

    if (dryRun) {
      results.push({ userId: pref.user_id, email, status: "dry" });
      continue;
    }

    const html = buildDigestHtml({
      prefs: pref,
      articles,
      manageUrl,
      unsubscribeUrl,
      resubscribeUrl,
      yesNoLinks,
    });

    const res = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from: fromEnv, to: email, subject, html }),
    });

    if (!res.ok) {
      const msg = await res.text().catch(() => res.statusText);
      results.push({ userId: pref.user_id, email, status: "skipped", error: msg });
    } else {
      results.push({ userId: pref.user_id, email, status: "sent" });
    }
  }

  const sent = results.filter((r) => r.status === "sent").length;
  const skipped = results.filter((r) => r.status === "skipped");

  return NextResponse.json({ ok: true, sent, dryRun, windowMinutes, skipped });
}
