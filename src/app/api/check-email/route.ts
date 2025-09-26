import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const email = searchParams.get("email");

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ ok: false, error: "Invalid email" }, { status: 400 });
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    return NextResponse.json(
      { ok: false, error: "Server not configured" },
      { status: 500 }
    );
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Query auth schema for user by email using service role
  try {
    // Use GoTrue Admin API (service role) to look up the user
    const { data } = await admin.auth.admin.listUsers({ page: 1, perPage: 2000 });
    const found = (data?.users || []).find(
      (u) => u.email && u.email.toLowerCase() === email.toLowerCase()
    );
    if (!found) return NextResponse.json({ ok: true, exists: false });

    // Check unsubscribe status in user_prefs
    const { data: prefs } = await admin
      .from("user_prefs")
      .select("unsubscribed")
      .eq("user_id", found.id)
      .maybeSingle();

    return NextResponse.json({ ok: true, exists: true, unsubscribed: Boolean(prefs?.unsubscribed) });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || "Admin lookup failed" }, { status: 500 });
  }
}
