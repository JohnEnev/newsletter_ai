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

function getDefaultTimezone() {
  if (typeof Intl === "undefined") return "UTC";
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

type IntlWithSupported = typeof Intl & { supportedValuesOf?: (input: string) => string[] };

function getTimezoneOptions(defaultTz: string) {
  const intl = Intl as IntlWithSupported;
  const extras = [defaultTz, "UTC", "America/New_York", "Europe/London", "Asia/Tokyo"];
  const supported = typeof intl.supportedValuesOf === "function" ? intl.supportedValuesOf("timeZone") : [];
  const set = new Set([...extras, ...supported]);
  return Array.from(set.values()).sort();
}

type CheckEmailResponse = {
  exists?: boolean;
  unsubscribed?: boolean;
};

const DEFAULT_SEND_TIME = "09:00";

export function InlineSignup() {
  const defaultTimezone = getDefaultTimezone();
  const [timezone, setTimezone] = useState(defaultTimezone);
  const timezoneOptions = useMemo(() => {
    const list = getTimezoneOptions(defaultTimezone);
    if (timezone && !list.includes(timezone)) {
      return Array.from(new Set([...list, timezone])).sort();
    }
    return list;
  }, [defaultTimezone, timezone]);

  const [email, setEmail] = useState("");
  const [interests, setInterests] = useState("");
  const [timeline, setTimeline] = useState("");
  const [sendTime, setSendTime] = useState(DEFAULT_SEND_TIME);
  const [submitted, setSubmitted] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exists, setExists] = useState<boolean | null>(null);
  const [unsubscribed, setUnsubscribed] = useState(false);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    // Hydration guard: if the resolved timezone changes (e.g. client vs server), sync it.
    setTimezone((prev) => prev || defaultTimezone);
  }, [defaultTimezone]);

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
        // ignore lookup errors to keep UX simple
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
      const payload = { email, interests, timeline, sendTime, timezone, ts: Date.now() };
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
      const raw = err instanceof Error ? err.message : String(err ?? "Failed to send magic link");
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
          <div className="space-y-1.5">
            <Label htmlFor="send-time">Preferred send time</Label>
            <Input
              id="send-time"
              type="time"
              value={sendTime}
              onChange={(e) => setSendTime(e.target.value || DEFAULT_SEND_TIME)}
              step={300}
            />
            <p className="text-xs text-muted-foreground">
              We’ll send each digest around this time in your timezone.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="timezone">Timezone</Label>
            <select
              id="timezone"
              name="timezone"
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              {timezoneOptions.map((tz) => (
                <option key={tz} value={tz}>
                  {tz}
                </option>
              ))}
            </select>
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
