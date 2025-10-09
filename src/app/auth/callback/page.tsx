"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabaseClient";

type StatusState =
  | { state: "working"; message: string }
  | { state: "success"; message: string }
  | { state: "error"; message: string };

const emailOtpTypes = [
  "magiclink",
  "recovery",
  "signup",
  "email_change",
  "invitation",
] as const;
type EmailOtpType = (typeof emailOtpTypes)[number];

function deriveErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error) return error.message || fallback;
  if (typeof error === "string") return error || fallback;
  return fallback;
}

export default function AuthCallbackPage() {
  const [status, setStatus] = useState<StatusState>({
    state: "working",
    message: "Signing you in…",
  });

  useEffect(() => {
    const run = async () => {
      try {
        const url = new URL(window.location.href);
        const code = url.searchParams.get("code");
        const tokenHash = url.searchParams.get("token_hash");
        const typeParam = (url.searchParams.get("type") || "").toLowerCase();
        const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ""));
        const accessToken = hashParams.get("access_token");
        const refreshToken = hashParams.get("refresh_token");

        if (code) {
          const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(
            window.location.href
          );
          if (exchangeError) throw exchangeError;
        } else if (tokenHash) {
          const mappedType: EmailOtpType = emailOtpTypes.includes(typeParam as EmailOtpType)
            ? (typeParam as EmailOtpType)
            : "magiclink";
          const { error: verifyError } = await supabase.auth.verifyOtp({
            token_hash: tokenHash,
            type: mappedType,
          });
          if (verifyError) throw verifyError;
        } else if (accessToken && refreshToken) {
          const { error: setErr } = await supabase.auth.setSession({
            access_token: accessToken,
            refresh_token: refreshToken,
          });
          if (setErr) throw setErr;
          history.replaceState(null, "", url.pathname + url.search);
        } else {
          throw new Error("Invalid auth callback URL: missing code or token_hash");
        }

        const {
          data: { user },
          error: userError,
        } = await supabase.auth.getUser();
        if (userError) throw userError;
        if (!user) throw new Error("No user after sign-in");

        setStatus({ state: "working", message: "Saving your preferences…" });

        const raw = localStorage.getItem("pendingSignupPrefs");
        let interests = "";
        let timeline = "";
        if (raw) {
          try {
            const parsed = JSON.parse(raw) as Record<string, unknown>;
            if (typeof parsed.interests === "string") {
              interests = parsed.interests;
            }
            if (typeof parsed.timeline === "string") {
              timeline = parsed.timeline;
            }
          } catch {
            // ignore parse errors
          }
        }

        const { error: upsertError } = await supabase
          .from("user_prefs")
          .upsert({ user_id: user.id, interests, timeline })
          .select()
          .single();
        if (upsertError) throw upsertError;

        localStorage.removeItem("pendingSignupPrefs");

        setStatus({ state: "success", message: "You're all set! Redirecting…" });
        setTimeout(() => {
          window.location.href = "/settings";
        }, 800);
      } catch (error) {
        const msg = deriveErrorMessage(error, "Something went wrong during sign-in");
        const lower = msg.toLowerCase();
        const hint =
          lower.includes("row-level security") ||
          lower.includes("permission") ||
          msg.includes("403")
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
        <Link
          href="/"
          className="mt-6 inline-flex items-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
        >
          Go to home
        </Link>
      )}
      {status.state === "error" && (
        <Link
          href="/"
          className="mt-6 inline-flex items-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium"
        >
          Try again
        </Link>
      )}
    </main>
  );
}
