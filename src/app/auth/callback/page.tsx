"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabaseClient";

export default function AuthCallbackPage() {
  const [status, setStatus] = useState<
    | { state: "working"; message: string }
    | { state: "success"; message: string }
    | { state: "error"; message: string }
  >({ state: "working", message: "Signing you in…" });

  useEffect(() => {
    const run = async () => {
      try {
        // 1) Handle both possible link shapes:
        //    - code + code_verifier (PKCE) → exchangeCodeForSession
        //    - token_hash + type (magiclink/recovery/etc.) → verifyOtp
        //    - access_token + refresh_token in URL hash → setSession
        const url = new URL(window.location.href);
        const code = url.searchParams.get("code");
        const tokenHash = url.searchParams.get("token_hash");
        const type = (url.searchParams.get("type") || "").toLowerCase();
        const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ""));
        const accessToken = hashParams.get("access_token");
        const refreshToken = hashParams.get("refresh_token");

        if (code) {
          const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(
            window.location.href
          );
          if (exchangeError) throw exchangeError;
        } else if (tokenHash) {
          // Map known types to supabase-js values; default to 'magiclink'
          const known = ["magiclink", "recovery", "signup", "email_change", "invitation"] as const;
          const t = (known as readonly string[]).includes(type) ? (type as any) : ("magiclink" as const);
          const { error: verifyError } = await supabase.auth.verifyOtp({
            token_hash: tokenHash,
            type: t,
          } as any);
          if (verifyError) throw verifyError;
        } else if (accessToken && refreshToken) {
          const { error: setErr } = await supabase.auth.setSession({
            access_token: accessToken,
            refresh_token: refreshToken,
          });
          if (setErr) throw setErr;
          // Clean up hash in URL to avoid reprocessing on refresh
          history.replaceState(null, "", url.pathname + url.search);
        } else {
          throw new Error("Invalid auth callback URL: missing code or token_hash");
        }

        // 2) Get the user
        const {
          data: { user },
          error: userError,
        } = await supabase.auth.getUser();
        if (userError) throw userError;
        if (!user) throw new Error("No user after sign-in");

        setStatus({ state: "working", message: "Saving your preferences…" });

        // 3) Read locally-stashed prefs
        const raw = localStorage.getItem("pendingSignupPrefs");
        let interests = "";
        let timeline = "";
        try {
          if (raw) {
            const parsed = JSON.parse(raw);
            interests = parsed?.interests ?? "";
            timeline = parsed?.timeline ?? "";
          }
        } catch {
          // ignore parse errors
        }

        // 4) Persist to RLS-protected table
        const { error: upsertError } = await supabase
          .from("user_prefs")
          .upsert({ user_id: user.id, interests, timeline })
          .select()
          .single();
        if (upsertError) throw upsertError;

        // cleanup local storage
        localStorage.removeItem("pendingSignupPrefs");

        setStatus({ state: "success", message: "You're all set! Redirecting…" });
        // Nudge to settings so users can edit further
        setTimeout(() => {
          window.location.href = "/settings";
        }, 800);
      } catch (err: any) {
        const msg = String(err?.message || "Something went wrong during sign-in");
        const hint = msg.toLowerCase().includes("row-level security") || msg.toLowerCase().includes("permission") || msg.includes("403")
          ? " Hint: ensure supabase/schema.sql is applied and RLS policies exist for user_prefs."
          : "";
        setStatus({
          state: "error",
          message: msg + hint,
        });
      }
    };
    run();
  }, []);

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center px-4 text-center">
      <h1 className="text-2xl font-semibold">Authentication</h1>
      <p className="mt-2 text-sm text-muted-foreground">{status.message}</p>
      {status.state === "success" && (
        <a
          href="/"
          className="mt-6 inline-flex items-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
        >
          Go to home
        </a>
      )}
      {status.state === "error" && (
        <a
          href="/"
          className="mt-6 inline-flex items-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium"
        >
          Try again
        </a>
      )}
    </main>
  );
}
