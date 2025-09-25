import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// Server-only: uses the service role key to bypass RLS for health checks.
// Set SUPABASE_SERVICE_ROLE_KEY in newsletter-ai/.env.local (do NOT expose publicly).

export async function GET() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    return NextResponse.json(
      {
        ok: false,
        error: "Missing env: ensure NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set",
      },
      { status: 500 }
    );
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { error, count } = await admin
    .from("articles")
    // head:true returns no rows, just the count header for efficiency
    .select("*", { count: "exact", head: true });

  if (error) {
    return NextResponse.json(
      { ok: false, error: error.message },
      { status: 500 }
    );
  }

  return NextResponse.json({ ok: true, articlesCount: count ?? 0 });
}

