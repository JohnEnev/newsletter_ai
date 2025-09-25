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

function usage(msg) {
  if (msg) console.error("Error:", msg);
  console.log(`\nUsage:\n  node scripts/generate-digests.mjs [--out ./digests] [--limit N] [--email you@example.com | --user-id UUID] [--days 7] [--alt]\n\nNotes:\n- Reads .env.local for SUPABASE keys, UNSUBSCRIBE_SECRET(_ALT), APP_BASE_URL.\n- Produces per-user HTML files with survey/manage/unsubscribe links.\n`);
  process.exit(msg ? 1 : 0);
}

async function main() {
  loadDotEnvLocal();
  const args = process.argv.slice(2);
  let outDir = path.resolve(__dirname, "..", "digests");
  let limit = 0;
  let email = null;
  let userId = null;
  let days = 7;
  let useAlt = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--out") outDir = path.resolve(process.cwd(), args[++i]);
    else if (a === "--limit") limit = Number(args[++i]);
    else if (a === "--email") email = args[++i];
    else if (a === "--user-id") userId = args[++i];
    else if (a === "--days") days = Number(args[++i]);
    else if (a === "--alt") useAlt = true;
    else if (a === "-h" || a === "--help") usage();
    else usage(`Unknown arg: ${a}`);
  }

  const base = process.env.APP_BASE_URL || "http://localhost:3000";
  const signer = useAlt ? (process.env.UNSUBSCRIBE_SECRET_ALT || "") : (process.env.UNSUBSCRIBE_SECRET || "");
  if (!signer) usage(useAlt ? "UNSUBSCRIBE_SECRET_ALT not set" : "UNSUBSCRIBE_SECRET not set");
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) usage("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });

  // Resolve user selection
  let users = [];
  if (userId || email) {
    let query = admin.schema("auth").from("users").select("id, email");
    if (userId) query = query.eq("id", userId);
    if (email) query = query.eq("email", email);
    const { data, error } = await query;
    if (error) usage(`Supabase error: ${error.message}`);
    users = data || [];
  } else {
    const { data, error } = await admin.schema("auth").from("users").select("id, email").order("created_at", { ascending: false }).limit(limit && limit > 0 ? limit : 1000);
    if (error) usage(`Supabase error: ${error.message}`);
    users = data || [];
  }

  // Get recent articles (shared across users)
  const { data: articles, error: artErr } = await admin
    .from("articles")
    .select("id, title, url, summary")
    .order("created_at", { ascending: false })
    .limit(5);
  if (artErr) usage(`Articles error: ${artErr.message}`);

  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const exp = Math.floor(Date.now() / 1000) + days * 86400;
  const newToken = (uid) => signPayload({ user_id: uid, exp, n: randomBytes(16).toString("base64url") }, signer);

  for (const u of users) {
    const { data: prefs } = await admin
      .from("user_prefs")
      .select("interests, timeline, unsubscribed")
      .eq("user_id", u.id)
      .maybeSingle();

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

    const name = `${u.id}.html`;
    const outPath = path.join(outDir, name);
    fs.writeFileSync(outPath, html, "utf-8");
    console.log(`Wrote ${outPath} (${u.email})`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

