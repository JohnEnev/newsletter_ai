import { redirect } from "next/navigation";
import { createClient } from "@supabase/supabase-js";
import { verifyTokenWithSecrets, getPayloadNonce } from "@/lib/tokens";

type PageProps = {
  searchParams?: Record<string, string | string[] | undefined>;
};


export default async function ManagePage({ searchParams }: PageProps) {
  const token = (searchParams?.token as string | undefined) ?? "";
  const okParam = (searchParams?.ok as string | undefined) ?? "";

  const secret = process.env.UNSUBSCRIBE_SECRET;
  const secretAlt = process.env.UNSUBSCRIBE_SECRET_ALT;
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

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

  const verify = verifyTokenWithSecrets(token, [secret!, secretAlt!].filter(Boolean));
  if (!verify.ok) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center px-4 text-center">
        <h1 className="text-2xl font-semibold">Manage Preferences</h1>
        <p className="mt-2 text-sm text-destructive">{verify.error}</p>
      </main>
    );
  }

  const { user_id } = verify.payload || {};
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

  const { data, error } = await admin
    .from("user_prefs")
    .select("interests, timeline, unsubscribed")
    .eq("user_id", user_id)
    .maybeSingle();

  const initialInterests = data?.interests ?? "";
  const initialTimeline = data?.timeline ?? "";
  const initialUnsub = Boolean(data?.unsubscribed);

  async function updatePrefs(formData: FormData) {
    "use server";
    const token = String(formData.get("token") || "");
    const interests = String(formData.get("interests") || "");
    const timeline = String(formData.get("timeline") || "");
    const unsub = String(formData.get("unsubscribed") || "false") === "true";

    const secret = process.env.UNSUBSCRIBE_SECRET!;
    const secretAlt = process.env.UNSUBSCRIBE_SECRET_ALT;
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

    const verify = verifyTokenWithSecrets(token, [secret!, secretAlt!].filter(Boolean));
    if (!verify.ok) {
      redirect(`/manage?token=${encodeURIComponent(token)}&ok=0`);
    }
    const { user_id } = (verify as any).payload;
    const nonce = getPayloadNonce((verify as any).payload);

    const admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    if (nonce) {
      const { data: seen } = await admin.from("used_nonces").select("nonce").eq("nonce", nonce).maybeSingle();
      if (seen) redirect(`/manage?token=${encodeURIComponent(token)}&ok=0`);
      await admin.from("used_nonces").insert({ nonce });
    }

    await admin
      .from("user_prefs")
      .upsert({ user_id, interests, timeline, unsubscribed: unsub })
      .select()
      .single();

    redirect(`/manage?token=${encodeURIComponent(token)}&ok=1`);
  }

  return (
    <main className="mx-auto min-h-dvh max-w-xl px-4 py-10">
      <h1 className="text-2xl font-semibold">Manage Preferences</h1>
      {okParam && (
        <p className={`mt-2 text-sm ${okParam === "1" ? "text-muted-foreground" : "text-destructive"}`}>
          {okParam === "1" ? "Preferences saved." : "Failed to save preferences."}
        </p>
      )}
      <form action={updatePrefs} className="mt-6 space-y-4">
        <input type="hidden" name="token" value={token} />
        <div className="space-y-1.5">
          <label htmlFor="interests" className="text-sm font-medium">Interests</label>
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
          <label htmlFor="timeline" className="text-sm font-medium">Timeline</label>
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
          <label className="text-sm font-medium">Subscription</label>
          <input type="hidden" name="unsubscribed" value={initialUnsub ? "true" : "false"} />
          <div className="flex items-center gap-3 text-sm">
            <button
              formAction={async (formData) => {
                "use server";
                // Toggle unsubscribe flag and save immediately
                const token = String(formData.get("token") || "");
                const secret = process.env.UNSUBSCRIBE_SECRET!;
                const secretAlt = process.env.UNSUBSCRIBE_SECRET_ALT;
                const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
                const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
                const verify = verifyTokenWithSecrets(token, [secret!, secretAlt!].filter(Boolean));
                if (!verify.ok) {
                  redirect(`/manage?token=${encodeURIComponent(token)}&ok=0`);
                }
                const { user_id } = (verify as any).payload;
                const nonce = getPayloadNonce((verify as any).payload);
                const admin = createClient(supabaseUrl, serviceRoleKey, {
                  auth: { autoRefreshToken: false, persistSession: false },
                });
                if (nonce) {
                  const { data: seen } = await admin.from("used_nonces").select("nonce").eq("nonce", nonce).maybeSingle();
                  if (seen) redirect(`/manage?token=${encodeURIComponent(token)}&ok=0`);
                  await admin.from("used_nonces").insert({ nonce });
                }
                await admin
                  .from("user_prefs")
                  .upsert({ user_id, unsubscribed: !initialUnsub })
                  .select()
                  .single();
                redirect(`/manage?token=${encodeURIComponent(token)}&ok=1`);
              }}
              className="inline-flex items-center rounded-md border border-input bg-background px-3 py-1.5"
            >
              {initialUnsub ? "Resubscribe" : "Unsubscribe"}
            </button>
            <span className="text-muted-foreground">
              Status: {initialUnsub ? "Unsubscribed" : "Subscribed"}
            </span>
          </div>
        </div>
        <div>
          <button
            type="submit"
            className="inline-flex items-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
          >
            Save preferences
          </button>
        </div>
      </form>
    </main>
  );
}
