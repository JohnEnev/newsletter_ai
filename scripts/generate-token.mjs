#!/usr/bin/env node
import { createHmac, randomBytes } from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";

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

function usage(msg) {
  if (msg) console.error("Error:", msg);
  console.log(`\nUsage:\n  node scripts/generate-token.mjs --user-id <uuid> [--days 7] [--hours 0] [--alt]\n  node scripts/generate-token.mjs --email <user@example.com> [--days 7] [--hours 0] [--alt]\n\nFlags:\n  --alt   Use UNSUBSCRIBE_SECRET_ALT to sign (for rotation).\n\nNotes:\n- Reads .env.local for UNSUBSCRIBE_SECRET, UNSUBSCRIBE_SECRET_ALT, NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, APP_BASE_URL.\n- If using --email, service role is required to look up auth.users.\n`);
  process.exit(msg ? 1 : 0);
}

async function main() {
  loadDotEnvLocal();

  const args = process.argv.slice(2);
  let userId = null;
  let email = null;
  let days = 7;
  let hours = 0;
  let useAlt = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--user-id") userId = args[++i];
    else if (a === "--email") email = args[++i];
    else if (a === "--days") days = Number(args[++i]);
    else if (a === "--hours") hours = Number(args[++i]);
    else if (a === "--alt") useAlt = true;
    else if (a === "-h" || a === "--help") usage();
    else usage(`Unknown arg: ${a}`);
  }

  if (!userId && !email) usage("Provide --user-id or --email");

  const secret = useAlt ? (process.env.UNSUBSCRIBE_SECRET_ALT || "") : (process.env.UNSUBSCRIBE_SECRET || "");
  if (!secret) usage(useAlt ? "UNSUBSCRIBE_SECRET_ALT not set" : "UNSUBSCRIBE_SECRET not set (in env or .env.local)");

  if (!userId && email) {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !serviceRoleKey) usage("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required for --email lookup");
    const admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data, error } = await admin
      .schema("auth")
      .from("users")
      .select("id")
      .eq("email", email)
      .maybeSingle();
    if (error) usage(`Supabase error: ${error.message}`);
    if (!data) usage(`No auth user found for email: ${email}`);
    userId = data.id;
  }

  const exp = Math.floor(Date.now() / 1000) + days * 86400 + hours * 3600;
  const payload = { user_id: userId, exp, n: randomNonce() };
  const payloadB64 = b64url(JSON.stringify(payload));
  const sig = createHmac("sha256", secret).update(payloadB64).digest();
  const token = payloadB64 + "." + b64url(sig);

  const base = process.env.APP_BASE_URL || "http://localhost:3000";

  console.log("\nToken:");
  console.log(token);
  console.log("\nLinks:");
  console.log("Manage:", `${base}/manage?token=${encodeURIComponent(token)}`);
  console.log("Unsubscribe:", `${base}/unsubscribe?token=${encodeURIComponent(token)}`);
  console.log("Resubscribe:", `${base}/unsubscribe?token=${encodeURIComponent(token)}&action=subscribe`);
  console.log("\nPayload:", JSON.stringify(payload));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
function b64url(buf) {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function randomNonce() {
  return b64url(randomBytes(16));
}
