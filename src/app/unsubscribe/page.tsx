import Link from "next/link";
import { createClient } from "@supabase/supabase-js";
import {
  verifyTokenWithSecrets,
  getPayloadNonce,
  consumeNonce,
  type TokenPayload,
} from "@/lib/tokens";
import { redirect } from "next/navigation";

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

export default async function UnsubscribePage({ searchParams }: PageProps) {
  const token = (searchParams?.token as string | undefined) ?? "";
  const action = (searchParams?.action as string | undefined) ?? "unsubscribe";

  const { secret, secretAlt, supabaseUrl, serviceRoleKey } = validateEnv();

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
    const verification = verifyTokenWithSecrets<TokenPayload>(
      token,
      getSecrets(secret, secretAlt)
    );
    if (!verification.ok) {
      message = verification.error;
    } else {
      const payload = verification.payload;
      const userId = payload.user_id;
      if (!userId) {
        message = "Invalid token payload.";
      } else {
        const admin = createClient(supabaseUrl, serviceRoleKey, {
          auth: { autoRefreshToken: false, persistSession: false },
        });
        const nonceResult = await consumeNonce(admin, getPayloadNonce(payload));
        if (nonceResult.status === "used") {
          return redirect("/link/used");
        }
        if (nonceResult.status === "error") {
          if (process.env.NODE_ENV !== "production") {
            console.error("Failed to record nonce", nonceResult.error.message);
          }
          message = "Failed to validate link.";
        } else {
          const unsubscribed = action !== "subscribe";
          const { error } = await admin
            .from("user_prefs")
            .upsert({ user_id: userId, unsubscribed })
            .select()
            .single();
          if (error) {
            message = error.message;
          } else {
            ok = true;
            didUnsub = unsubscribed;
            message = unsubscribed
              ? "You have been unsubscribed."
              : "You have been resubscribed.";
          }
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
      <p className={`mt-2 text-sm ${ok ? "text-muted-foreground" : "text-destructive"}`}>
        {message}
      </p>
      <div className="mt-6 flex items-center gap-3">
        <Link
          href="/"
          className="inline-flex items-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
        >
          Go to home
        </Link>
        <Link
          href="/settings"
          className="inline-flex items-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium"
        >
          Open settings
        </Link>
      </div>
    </main>
  );
}
