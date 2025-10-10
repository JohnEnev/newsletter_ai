#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";
import { createHmac, randomBytes } from "crypto";

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
  } catch {}
}

function b64url(buf) {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function signPayload(payload, secret) {
  const payloadB64 = b64url(JSON.stringify(payload));
  const sig = createHmac("sha256", secret).update(payloadB64).digest();
  return `${payloadB64}.${b64url(sig)}`;
}

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function usage(msg) {
  if (msg) console.error("Error:", msg);
  console.log(`\nUsage:\n  node scripts/send-digests.mjs [--email you@example.com | --user-id UUID | --limit 50] [--days 7] [--alt] [--include-unsubscribed] [--dry-run] [--base https://your.app]\n\nNotes:\n- Requires RESEND_API_KEY, EMAIL_FROM, EMAIL_SUBJECT, APP_BASE_URL, UNSUBSCRIBE_SECRET(_ALT), NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.\n- Sends per-user HTML emails via Resend.\n`);
  process.exit(msg ? 1 : 0);
}

async function main() {
  loadDotEnvLocal();
  const args = process.argv.slice(2);
  let email = null;
  let userId = null;
  let limit = 50;
  let days = 7;
  let useAlt = false;
  let includeUnsub = false;
  let dryRun = false;
  let baseOverride = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--email") email = args[++i];
    else if (a === "--user-id") userId = args[++i];
    else if (a === "--limit") limit = Number(args[++i]);
    else if (a === "--days") days = Number(args[++i]);
    else if (a === "--alt") useAlt = true;
    else if (a === "--include-unsubscribed") includeUnsub = true;
    else if (a === "--dry-run") dryRun = true;
    else if (a === "--base") baseOverride = args[++i];
    else if (a === "-h" || a === "--help") usage();
    else usage(`Unknown arg: ${a}`);
  }

  const resendApiKey = process.env.RESEND_API_KEY;
  const fromEnv = process.env.EMAIL_FROM || "Newsletter AI <onboarding@resend.dev>";
  const from = fromEnv;
  const fromValid = /.+<[^<>@\s]+@[^<>@\s]+\.[^<>@\s]+>/.test(from) || /^[^<>@\s]+@[^<>@\s]+\.[^<>@\s]+$/.test(from);
  const subject = process.env.EMAIL_SUBJECT || "Your Newsletter";
  const envBase = process.env.APP_BASE_URL;
  const base = baseOverride || envBase || "http://localhost:3000";
  const signer = useAlt ? (process.env.UNSUBSCRIBE_SECRET_ALT || "") : (process.env.UNSUBSCRIBE_SECRET || "");
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) usage("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  if (!signer) usage(useAlt ? "UNSUBSCRIBE_SECRET_ALT not set" : "UNSUBSCRIBE_SECRET not set");
  if (!resendApiKey && !dryRun) usage("RESEND_API_KEY not set (or pass --dry-run)");
  if (!fromValid) usage("EMAIL_FROM invalid. Use 'you@example.com' or 'Name <you@example.com>' (e.g., 'Newsletter AI <onboarding@resend.dev>')");
  if (!envBase && !baseOverride) {
    console.warn("[warn] APP_BASE_URL not set; using http://localhost:3000. Provide --base or set APP_BASE_URL for production links.");
  }
  console.log(`[info] Using base URL: ${base}`);

  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });

  // Select users
  let users = [];
  try {
    if (userId || email) {
      const { data } = await admin.auth.admin.listUsers({ page: 1, perPage: 2000 });
      let list = data?.users || [];
      if (userId) list = list.filter((u) => u.id === userId);
      if (email) list = list.filter((u) => u.email && u.email.toLowerCase() === email.toLowerCase());
      users = list.map((u) => ({ id: u.id, email: u.email }));
    } else {
      const perPage = limit && limit > 0 ? limit : 50;
      const { data } = await admin.auth.admin.listUsers({ page: 1, perPage });
      users = (data?.users || []).map((u) => ({ id: u.id, email: u.email }));
    }
  } catch (e) {
    usage(`Supabase Admin listUsers error: ${e.message || e}`);
  }

  // Articles
  const { data: articles, error: artErr } = await admin
    .from("articles")
    .select("id, title, url, summary")
    .order("created_at", { ascending: false })
    .limit(5);
  if (artErr) usage(`Articles error: ${artErr.message}`);

  const exp = Math.floor(Date.now() / 1000) + days * 86400;
  const newToken = (uid) => signPayload({ user_id: uid, exp, n: randomBytes(16).toString("base64url") }, signer);

  for (const u of users) {
    const { data: prefs } = await admin
      .from("user_prefs")
      .select("interests, timeline, unsubscribed")
      .eq("user_id", u.id)
      .maybeSingle();

    if (prefs?.unsubscribed && !includeUnsub) {
      console.log(`Skipping unsubscribed: ${u.email}`);
      continue;
    }

    const manageUrl = `${base}/manage?token=${encodeURIComponent(newToken(u.id))}`;
    const unsubUrl = `${base}/unsubscribe?token=${encodeURIComponent(newToken(u.id))}`;
    const resubUrl = `${base}/unsubscribe?token=${encodeURIComponent(newToken(u.id))}&action=subscribe`;

    const itemsHtml = (articles || [])
      .map((a) => {
        const yes = `${base}/api/survey?token=${encodeURIComponent(newToken(u.id))}&article_id=${encodeURIComponent(a.id)}&q=${encodeURIComponent("Helpful?")}&a=${encodeURIComponent("yes")}&redirect=${encodeURIComponent(base + "/survey/thanks")}`;
        const no = `${base}/api/survey?token=${encodeURIComponent(newToken(u.id))}&article_id=${encodeURIComponent(a.id)}&q=${encodeURIComponent("Helpful?")}&a=${encodeURIComponent("no")}&redirect=${encodeURIComponent(base + "/survey/thanks")}`;
        return `
          <tr>
            <td style="padding:12px 0;">
              <div style="font-size:16px;font-weight:600;line-height:1.3;">
                <a href="${a.url}" style="color:#111;text-decoration:none;">${esc(a.title)}</a>
              </div>
              ${a.summary ? `<div style=\"color:#555;font-size:14px;margin-top:4px;\">${esc(a.summary)}</div>` : ""}
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
          <div style="font-size:12px;color:#6b7280;">Unsubscribe: <a href="${unsubUrl}" style="color:#2563eb;">link</a> | Resubscribe: <a href="${resubUrl}" style="color:#2563eb;">link</a></div>
        </td>
      </tr>
    </table>
  </body>
 </html>`;

    if (dryRun) {
      console.log(`[DRY] Would send to ${u.email}`);
      continue;
    }

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from, to: u.email, subject, html }),
    });
    if (!res.ok) {
      const txt = await res.text();
      console.error(`Send failed for ${u.email}:`, res.status, txt);
      if (res.status === 422 && /Invalid `from` field/i.test(txt)) {
        console.error("Hint: Set EMAIL_FROM to a verified sender on Resend, or use 'onboarding@resend.dev' (e.g., 'Newsletter AI <onboarding@resend.dev>').");
      }
    } else {
      console.log(`Sent to ${u.email}`);
    }
    // gentle pacing
    await sleep(250);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
