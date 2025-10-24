import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

import { syncUserTopics } from "@/lib/server/topics";

export async function POST(request: Request) {
  try {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !serviceRoleKey) {
      return NextResponse.json({ ok: false, error: "Supabase env missing" }, { status: 500 });
    }

    const authHeader = request.headers.get("authorization") || "";
    const accessToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
    if (!accessToken) {
      return NextResponse.json({ ok: false, error: "Missing bearer token" }, { status: 401 });
    }

    const admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const {
      data: { user },
      error: userError,
    } = await admin.auth.getUser(accessToken);
    if (userError || !user) {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json().catch(() => ({}));
    const interests = typeof body?.interests === "string" ? body.interests : "";
    const timeline = typeof body?.timeline === "string" ? body.timeline : "";

    await syncUserTopics({
      supabase: admin,
      userId: user.id,
      interests,
      timeline,
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    if (process.env.NODE_ENV !== "production") {
      console.error("[topics/sync]", error);
    }
    return NextResponse.json({ ok: false, error: "Failed to sync topics" }, { status: 500 });
  }
}
