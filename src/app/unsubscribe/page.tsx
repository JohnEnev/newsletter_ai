import { createClient } from "@supabase/supabase-js";
import { verifyTokenWithSecrets, getPayloadNonce } from "@/lib/tokens";
import { redirect } from "next/navigation";

type PageProps = {
  searchParams?: Record<string, string | string[] | undefined>;
};


export default async function UnsubscribePage({ searchParams }: PageProps) {
  const token = (searchParams?.token as string | undefined) ?? "";
  const action = (searchParams?.action as string | undefined) ?? "unsubscribe"; // optional: "subscribe"

  const secret = process.env.UNSUBSCRIBE_SECRET;
  const secretAlt = process.env.UNSUBSCRIBE_SECRET_ALT;
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if ((!secret && !secretAlt) || !supabaseUrl || !serviceRoleKey) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center px-4 text-center">
        <h1 className="text-2xl font-semibold">Unsubscribe</h1>
        <p className="mt-2 text-sm text-destructive">Server misconfigured. Missing env vars.</p>
      </main>
    );
  }

  let message = "";
  let ok = false;
  let didUnsub = false;
  if (!token) {
    message = "Missing token.";
  } else {
    const res = verifyTokenWithSecrets(token, [secret!, secretAlt!].filter(Boolean));
    if (!res.ok) {
      message = res.error;
    } else {
      const { user_id } = res.payload || {};
      if (!user_id) {
        message = "Invalid token payload.";
      } else {
        const admin = createClient(supabaseUrl, serviceRoleKey, {
          auth: { autoRefreshToken: false, persistSession: false },
        });
        // Enforce one-time nonce if present
        const nonce = getPayloadNonce(res.payload);
        if (nonce) {
          const { data: seen } = await admin
            .from("used_nonces")
            .select("nonce")
            .eq("nonce", nonce)
            .maybeSingle();
          if (seen) {
            return redirect("/link/used");
          }
          await admin.from("used_nonces").insert({ nonce });
        }
        const unsubscribed = action !== "subscribe";
        const { error } = await admin
          .from("user_prefs")
          .upsert({ user_id, unsubscribed })
          .select()
          .single();
        if (error) {
          message = error.message;
        } else {
          ok = true;
          didUnsub = unsubscribed;
          message = unsubscribed ? "You have been unsubscribed." : "You have been resubscribed.";
        }
      }
    }
  }

  if (ok && didUnsub) {
    redirect("/unsubscribe/thanks");
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center px-4 text-center">
      <h1 className="text-2xl font-semibold">Unsubscribe</h1>
      <p className={`mt-2 text-sm ${ok ? "text-muted-foreground" : "text-destructive"}`}>{message}</p>
      <div className="mt-6 flex items-center gap-3">
        <a
          href="/"
          className="inline-flex items-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
        >
          Go to home
        </a>
        <a
          href="/settings"
          className="inline-flex items-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium"
        >
          Open settings
        </a>
      </div>
    </main>
  );
}
