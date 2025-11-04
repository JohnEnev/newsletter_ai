"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabaseClient";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";

type PrefRow = {
  interests: string | null;
  timeline: string | null;
  unsubscribed: boolean | null;
  send_hour: number | null;
  send_minute: number | null;
  send_timezone: string | null;
};

type Schedule = {
  hour: number;
  minute: number;
  timezone: string;
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

function normaliseHour(value: number | null | undefined, fallback = 9) {
  if (typeof value === "number" && value >= 0 && value <= 23) return value;
  return fallback;
}

function normaliseMinute(value: number | null | undefined, fallback = 0) {
  if (typeof value === "number" && value >= 0 && value <= 59) return value;
  return fallback;
}

function isValidTimezone(zone: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

const TIME_REGEX = /(?:(?:around|at|@)\s*)?(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?/i;
const TIMEZONE_REGEX = /\b([A-Za-z]+\/[A-Za-z_]+)\b/;

const TIMEZONE_KEYWORDS: Array<{ regex: RegExp; zone: string }> = [
  { regex: /\beurope\b/i, zone: "Europe/Berlin" },
  { regex: /\bberlin|germany|cet|cest\b/i, zone: "Europe/Berlin" },
  { regex: /\blondon|uk|britain|gmt|bst\b/i, zone: "Europe/London" },
  { regex: /\bnew\s*york|eastern|est|edt|nyc\b/i, zone: "America/New_York" },
  { regex: /\bpacific|pst|pdt|los\s*angeles|sf|san\s*francisco|seattle\b/i, zone: "America/Los_Angeles" },
  { regex: /\bchicago|central|cst|cdt\b/i, zone: "America/Chicago" },
  { regex: /\baustin|texas\b/i, zone: "America/Chicago" },
  { regex: /\bdenver|mountain|mst|mdt\b/i, zone: "America/Denver" },
  { regex: /\bsingapore|sgt\b/i, zone: "Asia/Singapore" },
  { regex: /\bdelhi|india|ist\b/i, zone: "Asia/Kolkata" },
  { regex: /\btokyo|japan|jst\b/i, zone: "Asia/Tokyo" },
  { regex: /\bsydney|melbourne|australia|aest|aedt\b/i, zone: "Australia/Sydney" },
];

function interpretTimeline(timeline: string, fallback: Schedule) {
  const cleaned = (timeline || "").trim();
  let hour = fallback.hour;
  let minute = fallback.minute;
  let timezone = fallback.timezone;
  let matchedTime = false;
  let matchedZone = false;

  const lower = cleaned.toLowerCase();
  if (lower.includes("midnight")) {
    hour = 0;
    minute = 0;
    matchedTime = true;
  } else if (lower.includes("noon")) {
    hour = 12;
    minute = 0;
    matchedTime = true;
  } else {
    const match = cleaned.match(TIME_REGEX);
    if (match) {
      const rawHour = Number.parseInt(match[1], 10);
      const rawMinute = match[2] ? Number.parseInt(match[2], 10) : 0;
      const suffix = match[3]?.toLowerCase() ?? "";
      if (!Number.isNaN(rawHour) && rawHour >= 0 && rawHour <= 23 && rawMinute >= 0 && rawMinute <= 59) {
        if (suffix.startsWith("a")) {
          hour = rawHour % 12;
        } else if (suffix.startsWith("p")) {
          hour = rawHour % 12 + 12;
        } else if (rawHour === 12 && suffix.startsWith("a")) {
          hour = 0;
        } else if (!suffix && rawHour <= 23) {
          hour = rawHour === 24 ? 0 : rawHour;
        }
        minute = rawMinute;
        matchedTime = true;
      }
    }
  }

  const timezoneMatch = cleaned.match(TIMEZONE_REGEX);
  if (timezoneMatch) {
    const candidate = timezoneMatch[1];
    if (candidate && isValidTimezone(candidate)) {
      timezone = candidate;
      matchedZone = true;
    }
  }

  if (!matchedZone) {
    for (const entry of TIMEZONE_KEYWORDS) {
      if (entry.regex.test(lower) && isValidTimezone(entry.zone)) {
        timezone = entry.zone;
        matchedZone = true;
        break;
      }
    }
  }

  const summary = buildScheduleSummary({ hour, minute, timezone }, {
    matchedTime,
    matchedZone,
    hasInput: cleaned.length > 0,
  });

  return {
    schedule: { hour, minute, timezone } satisfies Schedule,
    matchedTime,
    matchedZone,
    summary,
  };
}

function buildScheduleSummary(
  schedule: Schedule,
  {
    matchedTime,
    matchedZone,
    hasInput,
  }: { matchedTime: boolean; matchedZone: boolean; hasInput: boolean },
) {
  const timeLabel = formatTimeLabel(schedule);
  const offsetLabel = formatOffsetLabel(schedule.timezone);
  const base = `We'll send each digest around ${timeLabel} in ${schedule.timezone}${offsetLabel ? ` (${offsetLabel})` : ""}.`;

  const notes: string[] = [];
  if (!hasInput) {
    notes.push("Update the timeline text above if you'd like to change this.");
  } else {
    if (!matchedTime) notes.push("We didn't spot a new time, so we're keeping your saved send time.");
    if (!matchedZone) notes.push("Timezone stayed the same. Mention one (e.g. 'Europe/Berlin') to change it.");
  }

  return [base, ...notes].join(" ").trim();
}

function formatTimeLabel(schedule: Schedule) {
  try {
    const now = new Date();
    const reference = new Date(Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      schedule.hour,
      schedule.minute,
    ));
    return new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit",
      timeZone: schedule.timezone,
    }).format(reference);
  } catch {
    return `${String(schedule.hour).padStart(2, "0")}:${String(schedule.minute).padStart(2, "0")}`;
  }
}

function formatOffsetLabel(timezone: string) {
  try {
    const reference = new Date();
    const utcDate = new Date(reference.toLocaleString("en-US", { timeZone: "UTC" }));
    const tzDate = new Date(reference.toLocaleString("en-US", { timeZone: timezone }));
    const diffMinutes = Math.round((tzDate.getTime() - utcDate.getTime()) / 60000);
    if (!Number.isFinite(diffMinutes)) return "";
    const sign = diffMinutes >= 0 ? "+" : "-";
    const abs = Math.abs(diffMinutes);
    const hours = Math.floor(abs / 60);
    const minutes = abs % 60;
    return `UTC${sign}${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
  } catch {
    return "";
  }
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
  const [storedSchedule, setStoredSchedule] = useState<Schedule>({
    hour: 9,
    minute: 0,
    timezone: defaultTimezone,
  });
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [unsubscribed, setUnsubscribed] = useState(false);

  async function syncTopicsToServer(interestText: string, timelineText: string) {
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) return;
      await fetch("/api/topics/sync", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ interests: interestText, timeline: timelineText }),
      });
    } catch (err) {
      if (process.env.NODE_ENV !== "production") {
        console.warn("Failed to sync topics", err);
      }
    }
  }

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
        setStoredSchedule({
          hour: normaliseHour(prefs?.send_hour),
          minute: normaliseMinute(prefs?.send_minute),
          timezone: prefs?.send_timezone && isValidTimezone(prefs.send_timezone)
            ? prefs.send_timezone
            : defaultTimezone,
        });
        setStatus({ state: "authed" });
      } catch (error) {
        setStatus({ state: "error", message: getErrorMessage(error, "Failed to load") });
      }
    };
    run();
  }, [defaultTimezone]);

  const interpretation = useMemo(() => interpretTimeline(timeline, storedSchedule), [timeline, storedSchedule]);

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

      const interestText = interests.trim();
      const timelineText = timeline.trim();
      const currentInterpretation = interpretTimeline(timelineText, storedSchedule);
      const { hour, minute, timezone } = currentInterpretation.schedule;

      const { error } = await supabase
        .from("user_prefs")
        .upsert({
          user_id: user.id,
          interests: interestText,
          timeline: timelineText,
          unsubscribed,
          send_hour: hour,
          send_minute: minute,
          send_timezone: timezone,
        })
        .select()
        .single();
      if (error) throw error;
      await syncTopicsToServer(interestText, timelineText);
      setStoredSchedule(currentInterpretation.schedule);
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

      const interestText = interests.trim();
      const timelineText = timeline.trim();
      const currentInterpretation = interpretTimeline(timelineText, storedSchedule);
      const { hour, minute, timezone } = currentInterpretation.schedule;

      const { error } = await supabase
        .from("user_prefs")
        .upsert({
          user_id: user.id,
          interests: interestText,
          timeline: timelineText,
          unsubscribed: next,
          send_hour: hour,
          send_minute: minute,
          send_timezone: timezone,
        })
        .select()
        .single();
      if (error) throw error;
      setUnsubscribed(next);
      setStoredSchedule(currentInterpretation.schedule);
      await syncTopicsToServer(interestText, timelineText);
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
                placeholder="e.g., daily at 8am Pacific, every weekday at 7:30am Europe/Berlin"
                rows={3}
              />
              <p className="rounded-md bg-muted/60 px-3 py-2 text-sm text-muted-foreground">
                {interpretation.summary}
              </p>
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
