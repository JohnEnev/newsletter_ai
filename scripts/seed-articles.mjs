#!/usr/bin/env node
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

loadDotEnvLocal();

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !serviceRoleKey) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in env.");
  process.exit(1);
}

const admin = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const samples = [
  {
    title: "AI Product Strategy in 2025",
    url: "https://example.com/ai-product-strategy-2025",
    summary: "How teams integrate LLMs responsibly into core product workflows.",
    tags: ["ai", "product", "strategy"],
  },
  {
    title: "Climate Tech: The Next Wave",
    url: "https://example.com/climate-tech-next-wave",
    summary: "Emerging startups tackling carbon removal, grid storage, and materials.",
    tags: ["climate", "startups", "energy"],
  },
  {
    title: "Shipping Design Systems Faster",
    url: "https://example.com/shipping-design-systems-faster",
    summary: "Practical tips for scaling UI systems with small teams.",
    tags: ["design", "frontend", "systems"],
  },
];

function toPgTextArrayLiteral(arr) {
  const esc = (s) => '"' + String(s).replace(/"/g, '\\"') + '"';
  return `{${arr.map(esc).join(",")}}`;
}

async function main() {
  // Avoid duplicates by URL
  for (const a of samples) {
    const { data: existing, error: selError } = await admin
      .from("articles")
      .select("id")
      .eq("url", a.url)
      .maybeSingle();
    if (selError) {
      console.error("Select error:", selError.message);
      process.exit(1);
    }
    if (existing) {
      console.log("Exists:", a.url);
      continue;
    }
    // Insert first without tags for maximum compatibility
    const base = { title: a.title, url: a.url, summary: a.summary ?? null };
    const { data: inserted, error: insError } = await admin
      .from("articles")
      .insert(base)
      .select("id")
      .single();
    if (insError) {
      console.error("Insert error:", insError.message);
      process.exit(1);
    }
    console.log("Inserted:", a.title);

    // Try to set tags if supported
    if (a.tags && a.tags.length) {
      // First, try JSON/JSONB style
      let updated = false;
      let lastErr = null;
      try {
        const { error } = await admin
          .from("articles")
          .update({ tags: a.tags })
          .eq("id", inserted.id);
        if (!error) {
          updated = true;
        } else {
          lastErr = error;
        }
      } catch (e) {
        lastErr = e;
      }
      if (!updated) {
        // Fall back to Postgres text[] array literal
        const literal = toPgTextArrayLiteral(a.tags);
        const { error } = await admin
          .from("articles")
          .update({ tags: literal })
          .eq("id", inserted.id);
        if (error) {
          console.warn(
            `Warning: could not set tags for ${a.title}. Column type may differ. Skipping. Detail:`,
            (lastErr && lastErr.message) || error.message
          );
        } else {
          console.log("Set tags for:", a.title);
        }
      } else {
        console.log("Set tags for:", a.title);
      }
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
