import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

type AdminUser = {
  email?: string | null;
  id: string;
};

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

  try {
    const { data } = await admin.auth.admin.listUsers({ page: 1, perPage: 2000 });
    const users = (data?.users || []) as AdminUser[];
    const found = users
      .filter((candidate): candidate is AdminUser => Boolean(candidate?.id))
      .find((candidate) => candidate.email && candidate.email.toLowerCase() === email.toLowerCase());

    if (!found) {
      return NextResponse.json({ ok: true, exists: false });
    }

    const { data: prefs } = await admin
      .from("user_prefs")
      .select("unsubscribed")
      .eq("user_id", found.id)
      .maybeSingle();

    return NextResponse.json({ ok: true, exists: true, unsubscribed: Boolean(prefs?.unsubscribed) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Admin lookup failed";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
