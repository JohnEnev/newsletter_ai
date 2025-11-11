import { redirect } from "next/navigation";
import { createClient } from "@supabase/supabase-js";
import { verifyTokenWithSecrets, getPayloadNonce, consumeNonce, type TokenPayload } from "@/lib/tokens";
import { syncUserTopics } from "@/lib/server/topics";

type PageProps = {
  searchParams?: Record<string, string | string[] | undefined>;
};

type PrefRow = {
  interests: string | null;
  timeline: string | null;
  unsubscribed: boolean | null;
  send_timezone: string | null;
  send_hour: number | null;
  send_minute: number | null;
};

type Schedule = {
  hour: number;
  minute: number;
  timezone: string;
};

function validateEnv() {
  const secret = process.env.UNSUBSCRIBE_SECRET;
  const secretAlt = process.env.UNSUBSCRIBE_SECRET_ALT;
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return { secret, secretAlt, supabaseUrl, serviceRoleKey };
}

function getSecrets(secret?: string | null, secretAlt?: string | null) {
  return [secret, secretAlt].filter(Boolean) as string[];
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

  const summary = buildScheduleSummary(
    { hour, minute, timezone },
    {
      matchedTime,
      matchedZone,
      hasInput: cleaned.length > 0,
    },
  );

  return {
    schedule: { hour, minute, timezone },
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
    const reference = new Date(Date.UTC(2020, 0, 1, schedule.hour, schedule.minute));
    return new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit",
      timeZone: "UTC",
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

export default async function ManagePage({ searchParams }: PageProps) {
  const token = (searchParams?.token as string | undefined) ?? "";
  const okParam = (searchParams?.ok as string | undefined) ?? "";
  const resubParam = (searchParams?.resub as string | undefined) ?? "";

  const { secret, secretAlt, supabaseUrl, serviceRoleKey } = validateEnv();

  if ((!secret && !secretAlt) || !supabaseUrl || !serviceRoleKey) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center px-4 text-center">
        <h1 className="text-2xl font-semibold">Manage Preferences</h1>
        <p className="mt-2 text-sm text-destructive">Server misconfigured. Missing env vars.</p>
      </main>
    );
  }

  if (!token) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center px-4 text-center">
        <h1 className="text-2xl font-semibold">Manage Preferences</h1>
        <p className="mt-2 text-sm text-destructive">Missing token.</p>
      </main>
    );
  }

  const verification = verifyTokenWithSecrets<TokenPayload>(token, getSecrets(secret, secretAlt));
  if (!verification.ok) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center px-4 text-center">
        <h1 className="text-2xl font-semibold">Manage Preferences</h1>
        <p className="mt-2 text-sm text-destructive">{verification.error}</p>
      </main>
    );
  }

  const { user_id } = verification.payload;
  if (!user_id) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center px-4 text-center">
        <h1 className="text-2xl font-semibold">Manage Preferences</h1>
        <p className="mt-2 text-sm text-destructive">Invalid token payload.</p>
      </main>
    );
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data } = await admin
    .from("user_prefs")
    .select("interests, timeline, unsubscribed, send_timezone, send_hour, send_minute")
    .eq("user_id", user_id)
    .maybeSingle();

  const prefs = (data ?? {}) as PrefRow | null;

  const initialInterests = prefs?.interests ?? "";
  const initialTimeline = prefs?.timeline ?? "";
  const initialUnsub = Boolean(prefs?.unsubscribed);
  const storedSchedule: Schedule = {
    hour: normaliseHour(prefs?.send_hour),
    minute: normaliseMinute(prefs?.send_minute),
    timezone: prefs?.send_timezone && isValidTimezone(prefs.send_timezone)
      ? prefs.send_timezone
      : "UTC",
  };

  const interpretation = interpretTimeline(initialTimeline, storedSchedule);

  async function updatePrefs(formData: FormData) {
    "use server";
    const tokenValue = String(formData.get("token") || "");
    const interests = String(formData.get("interests") || "");
    const timeline = String(formData.get("timeline") || "");
    const forceResub = String(formData.get("forceResubscribe") || "") === "1";
    const unsub = forceResub ? false : String(formData.get("unsubscribed") || "false") === "true";
    const storedHour = Number(formData.get("storedHour"));
    const storedMinute = Number(formData.get("storedMinute"));
    const storedTimezone = String(formData.get("storedTimezone") || "UTC");

    const { secret, secretAlt, supabaseUrl, serviceRoleKey } = validateEnv();
    const failureUrl = `/manage?token=${encodeURIComponent(tokenValue)}&ok=0`;

    if ((!secret && !secretAlt) || !supabaseUrl || !serviceRoleKey) {
      redirect(failureUrl);
    }

    const verification = verifyTokenWithSecrets<TokenPayload>(tokenValue, getSecrets(secret, secretAlt));
    if (!verification.ok) {
      redirect(failureUrl);
    }

    const payload = verification.payload;
    const userId = payload.user_id;
    const nonce = getPayloadNonce(payload);
    if (!userId) {
      redirect(failureUrl);
    }

    const adminClient = createClient(supabaseUrl!, serviceRoleKey!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const nonceResult = await consumeNonce(adminClient, nonce);
    if (nonceResult.status === "used") {
      redirect(failureUrl);
    }
    if (nonceResult.status === "error") {
      if (process.env.NODE_ENV !== "production") {
        console.error("Failed to record nonce", nonceResult.error.message);
      }
      redirect(failureUrl);
    }

    const interestText = interests.trim();
    const timelineText = timeline.trim();
    const fallbackSchedule: Schedule = {
      hour: normaliseHour(Number.isFinite(storedHour) ? storedHour : 9),
      minute: normaliseMinute(Number.isFinite(storedMinute) ? storedMinute : 0),
      timezone: isValidTimezone(storedTimezone) ? storedTimezone : "UTC",
    };
    const currentInterpretation = interpretTimeline(timelineText, fallbackSchedule);
    const { hour: sendHour, minute: sendMinute, timezone: sendTimezone } = currentInterpretation.schedule;

    const { error: upsertError } = await adminClient
      .from("user_prefs")
      .upsert({
        user_id: userId,
        interests: interestText,
        timeline: timelineText,
        unsubscribed: unsub,
        send_hour: sendHour,
        send_minute: sendMinute,
        send_timezone: sendTimezone || "UTC",
      })
      .select()
      .single();

    if (upsertError) {
      redirect(failureUrl);
    }

    await syncUserTopics({
      supabase: adminClient,
      userId,
      interests: interestText,
      timeline: timelineText,
    });

    redirect(`/manage?token=${encodeURIComponent(tokenValue)}&ok=1${forceResub ? "&resub=1" : ""}`);
  }

  return (
    <main className="mx-auto min-h-dvh max-w-xl px-4 py-10">
      <h1 className="text-2xl font-semibold">Manage Preferences</h1>
      {okParam && (
        <p className={`mt-2 text-sm ${okParam === "1" ? "text-muted-foreground" : "text-destructive"}`}>
          {okParam === "1"
            ? resubParam === "1"
              ? "Thanks for resubscribing. Preferences saved."
              : "Preferences saved."
            : "Failed to save preferences."}
        </p>
      )}
      <form action={updatePrefs} className="mt-6 space-y-4">
        <input type="hidden" name="token" value={token} />
        {initialUnsub && <input type="hidden" name="forceResubscribe" value="1" />}
        <input type="hidden" name="storedHour" value={storedSchedule.hour} />
        <input type="hidden" name="storedMinute" value={storedSchedule.minute} />
        <input type="hidden" name="storedTimezone" value={storedSchedule.timezone} />
        <div className="space-y-1.5">
          <label htmlFor="interests" className="text-sm font-medium">
            Interests
          </label>
          <textarea
            id="interests"
            name="interests"
            defaultValue={initialInterests}
            placeholder="e.g., AI, climate tech, product strategy"
            rows={4}
            className="flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          />
        </div>
        <div className="space-y-1.5">
          <label htmlFor="timeline" className="text-sm font-medium">
            Timeline
          </label>
          <textarea
            id="timeline"
            name="timeline"
            defaultValue={initialTimeline}
            placeholder="e.g., daily at 8am, weekly on Mondays, flexible"
            rows={3}
            className="flex min-h-[60px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          />
          <p className="rounded-md bg-muted/60 px-3 py-2 text-sm text-muted-foreground">
            {interpretation.summary}
          </p>
          <p className="text-xs text-muted-foreground">
            Describe when you&rsquo;d like your digest (&ldquo;weekdays at 7am London time&rdquo;). We&rsquo;ll infer the schedule for you.
          </p>
        </div>
        {initialUnsub ? (
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Subscription</label>
            <div className="text-sm text-muted-foreground">Status: Unsubscribed</div>
          </div>
        ) : (
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Subscription</label>
            <input type="hidden" name="unsubscribed" value="false" />
            <div className="flex items-center gap-3 text-sm">
              <button
                formAction={async (formData) => {
                  "use server";
                  const tokenValue = String(formData.get("token") || "");
                  const timelineText = String(formData.get("timeline") || "");
                  const storedHour = Number(formData.get("storedHour"));
                  const storedMinute = Number(formData.get("storedMinute"));
                  const storedTimezone = String(formData.get("storedTimezone") || "UTC");

                  const { secret, secretAlt, supabaseUrl, serviceRoleKey } = validateEnv();
                  const failureUrl = `/manage?token=${encodeURIComponent(tokenValue)}&ok=0`;

                  if ((!secret && !secretAlt) || !supabaseUrl || !serviceRoleKey) {
                    redirect(failureUrl);
                  }

                  const verification = verifyTokenWithSecrets<TokenPayload>(tokenValue, getSecrets(secret, secretAlt));
                  if (!verification.ok) {
                    redirect(failureUrl);
                  }

                  const payload = verification.payload;
                  const userId = payload.user_id;
                  const nonce = getPayloadNonce(payload);
                  if (!userId) {
                    redirect(failureUrl);
                  }

                  const adminClient = createClient(supabaseUrl!, serviceRoleKey!, {
                    auth: { autoRefreshToken: false, persistSession: false },
                  });

                  const nonceResult = await consumeNonce(adminClient, nonce);
                  if (nonceResult.status === "used") {
                    redirect(failureUrl);
                  }
                  if (nonceResult.status === "error") {
                    if (process.env.NODE_ENV !== "production") {
                      console.error("Failed to record nonce", nonceResult.error.message);
                    }
                    redirect(failureUrl);
                  }

                  const fallbackSchedule: Schedule = {
                    hour: normaliseHour(Number.isFinite(storedHour) ? storedHour : 9),
                    minute: normaliseMinute(Number.isFinite(storedMinute) ? storedMinute : 0),
                    timezone: isValidTimezone(storedTimezone) ? storedTimezone : "UTC",
                  };
                  const interpreted = interpretTimeline(timelineText, fallbackSchedule);
                  const { hour: sendHour, minute: sendMinute, timezone: sendTimezone } = interpreted.schedule;

                  await adminClient
                    .from("user_prefs")
                    .upsert({
                      user_id: userId,
                      unsubscribed: true,
                      send_hour: sendHour,
                      send_minute: sendMinute,
                      send_timezone: sendTimezone || "UTC",
                    })
                    .select()
                    .single();

                  redirect(`/manage?token=${encodeURIComponent(tokenValue)}&ok=1`);
                }}
                className="inline-flex items-center rounded-md border border-input bg-background px-3 py-1.5"
              >
                Unsubscribe
              </button>
              <span className="text-muted-foreground">Status: Subscribed</span>
            </div>
          </div>
        )}
        <div>
          <button
            type="submit"
            className="inline-flex items-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
          >
            {initialUnsub ? "Save and resubscribe" : "Save preferences"}
          </button>
        </div>
      </form>
    </main>
  );
}
