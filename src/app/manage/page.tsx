import { redirect } from "next/navigation";
import { createClient } from "@supabase/supabase-js";
import {
  verifyTokenWithSecrets,
  getPayloadNonce,
  consumeNonce,
  type TokenPayload,
} from "@/lib/tokens";

type PageProps = {
  searchParams?: Record<string, string | string[] | undefined>;
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

  const verification = verifyTokenWithSecrets<TokenPayload>(
    token,
    getSecrets(secret, secretAlt)
  );
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

  const { data: prefs } = await admin
    .from("user_prefs")
    .select("interests, timeline, unsubscribed")
    .eq("user_id", user_id)
    .maybeSingle();

  const initialInterests = prefs?.interests ?? "";
  const initialTimeline = prefs?.timeline ?? "";
  const initialUnsub = Boolean(prefs?.unsubscribed);

  async function updatePrefs(formData: FormData) {
    "use server";
    const tokenValue = String(formData.get("token") || "");
    const interests = String(formData.get("interests") || "");
    const timeline = String(formData.get("timeline") || "");
    const forceResub = String(formData.get("forceResubscribe") || "") === "1";
    const unsub = forceResub ? false : String(formData.get("unsubscribed") || "false") === "true";

    const { secret, secretAlt, supabaseUrl, serviceRoleKey } = validateEnv();
    const failureUrl = `/manage?token=${encodeURIComponent(tokenValue)}&ok=0`;

    if ((!secret && !secretAlt) || !supabaseUrl || !serviceRoleKey) {
      redirect(failureUrl);
    }

    const verification = verifyTokenWithSecrets<TokenPayload>(
      tokenValue,
      getSecrets(secret, secretAlt)
    );
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

    await adminClient
      .from("user_prefs")
      .upsert({ user_id: userId, interests, timeline, unsubscribed: unsub })
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
                  const { secret, secretAlt, supabaseUrl, serviceRoleKey } = validateEnv();
                  const failureUrl = `/manage?token=${encodeURIComponent(tokenValue)}&ok=0`;

                  if ((!secret && !secretAlt) || !supabaseUrl || !serviceRoleKey) {
                    redirect(failureUrl);
                  }

                  const verification = verifyTokenWithSecrets<TokenPayload>(
                    tokenValue,
                    getSecrets(secret, secretAlt)
                  );
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

                  await adminClient
                    .from("user_prefs")
                    .upsert({ user_id: userId!, unsubscribed: true })
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
