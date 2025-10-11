"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabaseClient";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type IntlWithSupported = typeof Intl & { supportedValuesOf?: (key: string) => string[] };

type PrefRow = {
  interests: string | null;
  timeline: string | null;
  unsubscribed: boolean | null;
  send_hour: number | null;
  send_minute: number | null;
  send_timezone: string | null;
};

type LoadState =
  | { state: "loading"; message?: string }
  | { state: "authed" }
  | { state: "anon" }
  | { state: "error"; message: string };

function getDefaultTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function getTimezoneOptions(current: string) {
  const extras = [current, "UTC", "America/New_York", "Europe/London", "Asia/Tokyo"];
  const intl = Intl as IntlWithSupported;
  const supported = typeof intl.supportedValuesOf === "function" ? intl.supportedValuesOf("timeZone") : [];
  const set = new Set([...extras, ...supported]);
  return Array.from(set.values()).sort();
}

function formatTime(hour?: number | null, minute?: number | null) {
  const safeHour = typeof hour === "number" && hour >= 0 && hour <= 23 ? hour : 9;
  const safeMinute = typeof minute === "number" && minute >= 0 && minute <= 59 ? minute : 0;
  return `${String(safeHour).padStart(2, "0")}:${String(safeMinute).padStart(2, "0")}`;
}

function parseTimeInput(value: string) {
  const [hourStr = "9", minuteStr = "0"] = value.split(":");
  const hour = Number.parseInt(hourStr, 10);
  const minute = Number.parseInt(minuteStr, 10);
  if (Number.isNaN(hour) || hour < 0 || hour > 23) return { hour: 9, minute: 0 };
  if (Number.isNaN(minute) || minute < 0 || minute > 59) return { hour, minute: 0 };
  return { hour, minute };
}

function getErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error) return error.message || fallback;
  if (typeof error === "string") return error || fallback;
  return fallback;
}

export default function SettingsPage() {
  const defaultTimezone = useMemo(getDefaultTimezone, []);
  const [status, setStatus] = useState<LoadState>({ state: "loading" });
  const [interests, setInterests] = useState("");
  const [timeline, setTimeline] = useState("");
  const [sendTime, setSendTime] = useState(formatTime());
  const [timezone, setTimezone] = useState(defaultTimezone);
  const timezoneOptions = useMemo(() => {
    const list = getTimezoneOptions(defaultTimezone);
    if (timezone && !list.includes(timezone)) {
      return Array.from(new Set([...list, timezone])).sort();
    }
    return list;
  }, [defaultTimezone, timezone]);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [unsubscribed, setUnsubscribed] = useState(false);

  useEffect(() => {
    const run = async () => {
      try {
        const {
          data: { user },
          error: userError,
        } = await supabase.auth.getUser();
        if (userError) throw userError;
        if (!user) {
          setStatus({ state: "anon" });
          return;
        }

        const { data, error } = await supabase
          .from("user_prefs")
          .select("interests, timeline, unsubscribed, send_hour, send_minute, send_timezone")
          .eq("user_id", user.id)
          .maybeSingle();
        if (error) throw error;

        const prefs = (data ?? {}) as PrefRow | null;
        setInterests(prefs?.interests ?? "");
        setTimeline(prefs?.timeline ?? "");
        setUnsubscribed(Boolean(prefs?.unsubscribed));
        setSendTime(formatTime(prefs?.send_hour, prefs?.send_minute));
        setTimezone(prefs?.send_timezone || defaultTimezone);
        setStatus({ state: "authed" });
      } catch (error) {
        setStatus({ state: "error", message: getErrorMessage(error, "Failed to load") });
      }
    };
    run();
  }, [defaultTimezone]);

  async function onSave(e: React.FormEvent) {
    e.preventDefault();
    setSaveMsg(null);
    setSaving(true);
    try {
      const {
        data: { user },
        error: userError,
      } = await supabase.auth.getUser();
      if (userError) throw userError;
      if (!user) throw new Error("Not signed in");

      const { hour, minute } = parseTimeInput(sendTime);

      const { error } = await supabase
        .from("user_prefs")
        .upsert({
          user_id: user.id,
          interests,
          timeline,
          unsubscribed,
          send_hour: hour,
          send_minute: minute,
          send_timezone: timezone,
        })
        .select()
        .single();
      if (error) throw error;
      setSaveMsg("Preferences saved");
    } catch (error) {
      setSaveMsg(getErrorMessage(error, "Failed to save preferences"));
    } finally {
      setSaving(false);
    }
  }

  async function onSignOut() {
    await supabase.auth.signOut();
    window.location.href = "/";
  }

  async function onToggleSubscription(next: boolean) {
    setSaving(true);
    setSaveMsg(null);
    try {
      const {
        data: { user },
        error: userError,
      } = await supabase.auth.getUser();
      if (userError) throw userError;
      if (!user) throw new Error("Not signed in");

      const { hour, minute } = parseTimeInput(sendTime);

      const { error } = await supabase
        .from("user_prefs")
        .upsert({
          user_id: user.id,
          interests,
          timeline,
          unsubscribed: next,
          send_hour: hour,
          send_minute: minute,
          send_timezone: timezone,
        })
        .select()
        .single();
      if (error) throw error;
      setUnsubscribed(next);
      setSaveMsg(next ? "Unsubscribed" : "Resubscribed");
    } catch (error) {
      setSaveMsg(getErrorMessage(error, "Failed to update subscription"));
    } finally {
      setSaving(false);
    }
  }

  if (status.state === "loading") {
    return (
      <main className="mx-auto flex min-h-dvh max-w-xl items-center justify-center px-4">
        <p className="text-sm text-muted-foreground">Loading…</p>
      </main>
    );
  }

  if (status.state === "anon") {
    return (
      <main className="mx-auto flex min-h-dvh max-w-xl flex-col items-center justify-center px-4 text-center">
        <h1 className="text-2xl font-semibold">Sign in required</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Please return to the home page and sign in via magic link.
        </p>
        <Link
          href="/"
          className="mt-6 inline-flex items-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
        >
          Go to home
        </Link>
      </main>
    );
  }

  if (status.state === "error") {
    return (
      <main className="mx-auto flex min-h-dvh max-w-xl items-center justify-center px-4">
        <p className="text-sm text-destructive">{status.message}</p>
      </main>
    );
  }

  return (
    <main className="mx-auto min-h-dvh max-w-2xl px-4 py-10">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Settings</h1>
        <Button variant="outline" onClick={onSignOut}>
          Sign out
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Preferences</CardTitle>
          <CardDescription>Update your interests and delivery timeline.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSave} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="interests">Interests</Label>
              <Textarea
                id="interests"
                value={interests}
                onChange={(e) => setInterests(e.target.value)}
                placeholder="e.g., AI, climate tech, product strategy"
                rows={4}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="timeline">Timeline</Label>
              <Textarea
                id="timeline"
                value={timeline}
                onChange={(e) => setTimeline(e.target.value)}
                placeholder="e.g., daily at 8am, weekly on Mondays, flexible"
                rows={3}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="send-time">Preferred send time</Label>
              <Input
                id="send-time"
                type="time"
                value={sendTime}
                onChange={(e) => setSendTime(e.target.value || formatTime())}
                step={300}
              />
              <p className="text-xs text-muted-foreground">
                We’ll send each digest around this time in your selected timezone.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="timezone">Timezone</Label>
              <select
                id="timezone"
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
            <div className="flex items-center gap-3">
              <Button type="submit" disabled={saving}>
                {saving ? "Saving…" : "Save"}
              </Button>
              {saveMsg && <span className="text-sm text-muted-foreground">{saveMsg}</span>}
            </div>
            <div className="pt-2">
              {unsubscribed ? (
                <Button
                  type="button"
                  variant="outline"
                  disabled={saving}
                  onClick={() => onToggleSubscription(false)}
                >
                  Resubscribe
                </Button>
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  disabled={saving}
                  onClick={() => onToggleSubscription(true)}
                >
                  Unsubscribe
                </Button>
              )}
            </div>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
