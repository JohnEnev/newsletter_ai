import { redirect } from "next/navigation";
import { createClient } from "@supabase/supabase-js";
import { verifyTokenWithSecrets, getPayloadNonce, consumeNonce, type TokenPayload } from "@/lib/tokens";

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

type IntlWithSupported = typeof Intl & { supportedValuesOf?: (key: string) => string[] };

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

function formatTime(hour: number | null | undefined, minute: number | null | undefined) {
  const safeHour = typeof hour === "number" && hour >= 0 && hour <= 23 ? hour : 9;
  const safeMinute = typeof minute === "number" && minute >= 0 && minute <= 59 ? minute : 0;
  return `${String(safeHour).padStart(2, "0")}:${String(safeMinute).padStart(2, "0")}`;
}

function parseTimeInput(value: string | null | undefined) {
  if (!value) return { hour: 9, minute: 0 };
  const [hourStr = "9", minuteStr = "0"] = value.split(":");
  const hour = Number.parseInt(hourStr, 10);
  const minute = Number.parseInt(minuteStr, 10);
  if (Number.isNaN(hour) || hour < 0 || hour > 23) return { hour: 9, minute: 0 };
  if (Number.isNaN(minute) || minute < 0 || minute > 59) return { hour, minute: 0 };
  return { hour, minute };
}

function getTimezoneOptions(current: string) {
  const extras = [current, "UTC", "America/New_York", "Europe/London", "Asia/Tokyo"];
  const intl = Intl as IntlWithSupported;
  const supported = typeof intl.supportedValuesOf === "function" ? intl.supportedValuesOf("timeZone") : [];
  const set = new Set([...extras, ...supported]);
  return Array.from(set.values()).sort();
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
    .from<PrefRow>("user_prefs")
    .select("interests, timeline, unsubscribed, send_timezone, send_hour, send_minute")
    .eq("user_id", user_id)
    .maybeSingle();

  const initialInterests = data?.interests ?? "";
  const initialTimeline = data?.timeline ?? "";
  const initialUnsub = Boolean(data?.unsubscribed);
  const initialTimezone = data?.send_timezone || "UTC";
  const initialSendTime = formatTime(data?.send_hour, data?.send_minute);
  const timezoneOptions = getTimezoneOptions(initialTimezone);

  async function updatePrefs(formData: FormData) {
    "use server";
    const tokenValue = String(formData.get("token") || "");
    const interests = String(formData.get("interests") || "");
    const timeline = String(formData.get("timeline") || "");
    const forceResub = String(formData.get("forceResubscribe") || "") === "1";
    const unsub = forceResub ? false : String(formData.get("unsubscribed") || "false") === "true";
    const sendTimeRaw = String(formData.get("sendTime") || "");
    const sendTimezone = String(formData.get("sendTimezone") || "UTC");

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

    const { hour: sendHour, minute: sendMinute } = parseTimeInput(sendTimeRaw);

    await adminClient
      .from("user_prefs")
      .upsert({
        user_id: userId,
        interests,
        timeline,
        unsubscribed: unsub,
        send_hour: sendHour,
        send_minute: sendMinute,
        send_timezone: sendTimezone || "UTC",
      })
      .select()
      .single();

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
        </div>
        <div className="space-y-1.5">
          <label htmlFor="sendTime" className="text-sm font-medium">
            Preferred send time
          </label>
          <input
            id="sendTime"
            name="sendTime"
            type="time"
            defaultValue={initialSendTime}
            step={300}
            className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          />
          <p className="text-xs text-muted-foreground">
            Digests will send around this time in your selected timezone.
          </p>
        </div>
        <div className="space-y-1.5">
          <label htmlFor="sendTimezone" className="text-sm font-medium">
            Timezone
          </label>
          <select
            id="sendTimezone"
            name="sendTimezone"
            defaultValue={initialTimezone}
            className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            {timezoneOptions.map((tz) => (
              <option key={tz} value={tz}>
                {tz}
              </option>
            ))}
          </select>
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
                  const sendTimeRaw = String(formData.get("sendTime") || "");
                  const sendTimezone = String(formData.get("sendTimezone") || "UTC");

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

                  const { hour: sendHour, minute: sendMinute } = parseTimeInput(sendTimeRaw);

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
