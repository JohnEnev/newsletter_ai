"use client";

import { useEffect, useMemo, useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { supabase } from "@/lib/supabaseClient";

function isValidEmail(email: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function getErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error) return error.message || fallback;
  if (typeof error === "string") return error || fallback;
  return fallback;
}

type CheckEmailResponse = {
  exists?: boolean;
  unsubscribed?: boolean;
};

export function InlineSignup() {
  const [email, setEmail] = useState("");
  const [interests, setInterests] = useState("");
  const [timeline, setTimeline] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exists, setExists] = useState<boolean | null>(null);
  const [unsubscribed, setUnsubscribed] = useState(false);
  const [checking, setChecking] = useState(false);

  const emailValid = useMemo(() => isValidEmail(email), [email]);
  const showPrefs = emailValid && !submitted;

  useEffect(() => {
    let active = true;
    async function check() {
      setExists(null);
      setChecking(false);
      if (!emailValid) return;
      setChecking(true);
      try {
        const res = await fetch(`/api/check-email?email=${encodeURIComponent(email)}`);
        if (!active) return;
        if (!res.ok) throw new Error("Failed to check email");
        const body = (await res.json()) as CheckEmailResponse;
        setExists(Boolean(body?.exists));
        setUnsubscribed(Boolean(body?.unsubscribed));
      } catch {
        // ignore check errors; keep UX simple
      } finally {
        if (active) setChecking(false);
      }
    }
    check();
    return () => {
      active = false;
    };
  }, [email, emailValid]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!emailValid) return;
    setError(null);
    setSending(true);
    try {
      const payload = { email, interests, timeline, ts: Date.now() };
      localStorage.setItem("pendingSignupPrefs", JSON.stringify(payload));

      const redirectTo = `${window.location.origin}/auth/callback`;
      const { error } = await supabase.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: redirectTo },
      });
      if (error) throw error;
      setSubmitted(true);
    } catch (err) {
      if (process.env.NODE_ENV !== "production") {
        console.error("signInWithOtp error:", err);
      }
      const raw = getErrorMessage(err, "Failed to send magic link");
      let friendly = raw;
      if (/invalid/i.test(raw)) {
        friendly = exists
          ? "Couldn’t send email. Check your inbox filter or try again."
          : "Email looks invalid or email auth isn’t configured.";
      } else if (/smtp|mail/i.test(raw)) {
        friendly = "Email delivery issue. Please try again shortly.";
      }
      setError(friendly);
    } finally {
      setSending(false);
    }
  }

  if (submitted) {
    return (
      <div className="mx-auto mt-8 w-full max-w-xl rounded-lg border border-border bg-card p-4 text-sm text-foreground">
        Thanks! We captured your preferences. Check your email soon.
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="mx-auto mt-8 w-full max-w-xl space-y-3">
      <div className="flex w-full items-end gap-2">
        <div className="flex-1">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            type="email"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            aria-invalid={email.length > 0 && !emailValid}
          />
        </div>
        <Button type="submit" disabled={!emailValid || sending}>
          {sending ? "Sending…" : exists ? "Send login link" : "Continue"}
        </Button>
      </div>

      {emailValid && (
        <p className="text-xs text-muted-foreground">
          {checking
            ? "Checking…"
            : exists
            ? unsubscribed
              ? "Account found — we’ll email you a login link to resubscribe or update preferences."
              : "Account found — we’ll email you a login link to update preferences."
            : "We’ll send a magic link to confirm your email."}
        </p>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}

      {showPrefs && (
        <div className="space-y-3 animate-fadeIn">
          <div className="space-y-1.5">
            <Label htmlFor="interests">Interests</Label>
            <Textarea
              id="interests"
              placeholder="e.g., AI, climate tech, product strategy"
              value={interests}
              onChange={(e) => setInterests(e.target.value)}
              rows={3}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="timeline">Timeline</Label>
            <Textarea
              id="timeline"
              placeholder="e.g., daily at 8am, weekly on Mondays, flexible"
              value={timeline}
              onChange={(e) => setTimeline(e.target.value)}
              rows={2}
            />
          </div>
          <div>
            <Button type="submit" className="w-full sm:w-auto" disabled={sending}>
              {sending ? "Sending…" : "Save preferences"}
            </Button>
          </div>
        </div>
      )}
    </form>
  );
}
