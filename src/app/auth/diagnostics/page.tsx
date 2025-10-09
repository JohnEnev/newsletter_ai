import { headers } from "next/headers";
import { createClient } from "@supabase/supabase-js";

function Flag({ label, value }: { label: string; value: boolean | string }) {
  const isBool = typeof value === "boolean";
  const v = isBool ? (value ? "yes" : "no") : String(value);
  const cls = isBool ? (value ? "text-emerald-600" : "text-red-600") : "text-foreground";
  return (
    <div className="flex items-center justify-between rounded-md border border-input px-3 py-2">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className={`text-sm font-medium ${cls}`}>{v}</span>
    </div>
  );
}

function describeError(error: unknown, fallback: string) {
  if (error instanceof Error) return error.message || fallback;
  if (typeof error === "string") return error || fallback;
  return fallback;
}

export default async function DiagnosticsPage() {
  const h = await headers();
  const host = h.get("x-forwarded-host") || h.get("host") || "localhost:3000";
  const proto = h.get("x-forwarded-proto") || (host.startsWith("localhost") ? "http" : "https");
  const origin = `${proto}://${host}`;
  const redirectUrl = `${origin}/auth/callback`;

  const env = {
    NEXT_PUBLIC_SUPABASE_URL: Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL),
    NEXT_PUBLIC_SUPABASE_ANON_KEY: Boolean(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY),
    SUPABASE_SERVICE_ROLE_KEY: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
    APP_BASE_URL: Boolean(process.env.APP_BASE_URL),
    UNSUBSCRIBE_SECRET: Boolean(process.env.UNSUBSCRIBE_SECRET),
    UNSUBSCRIBE_SECRET_ALT: Boolean(process.env.UNSUBSCRIBE_SECRET_ALT),
    DIGEST_PREVIEW_SECRET: Boolean(process.env.DIGEST_PREVIEW_SECRET),
  } as const;

  let serviceRoleOk: { ok: boolean; message: string } = { ok: false, message: "Skipped" };
  if (env.NEXT_PUBLIC_SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) {
    try {
      const admin = createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL as string,
        process.env.SUPABASE_SERVICE_ROLE_KEY as string,
        { auth: { autoRefreshToken: false, persistSession: false } }
      );
      const { error } = await admin.from("articles").select("id", { head: true, count: "exact" });
      if (error) throw error;
      serviceRoleOk = { ok: true, message: "Connected to Supabase (service role)" };
    } catch (error) {
      serviceRoleOk = {
        ok: false,
        message: describeError(error, "Failed to query with service role"),
      };
    }
  }

  return (
    <main className="mx-auto max-w-2xl px-4 py-10">
      <h1 className="text-2xl font-semibold">Auth Diagnostics</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Use this page to verify environment and redirect configuration for magic links.
      </p>

      <section className="mt-6 space-y-2">
        <Flag label="Origin (computed)" value={origin} />
        <Flag label="Expected redirect URL" value={redirectUrl} />
      </section>

      <section className="mt-6 space-y-2">
        <h2 className="text-base font-medium">Environment presence</h2>
        <Flag label="NEXT_PUBLIC_SUPABASE_URL" value={env.NEXT_PUBLIC_SUPABASE_URL} />
        <Flag label="NEXT_PUBLIC_SUPABASE_ANON_KEY" value={env.NEXT_PUBLIC_SUPABASE_ANON_KEY} />
        <Flag label="SUPABASE_SERVICE_ROLE_KEY (server)" value={env.SUPABASE_SERVICE_ROLE_KEY} />
        <Flag label="APP_BASE_URL" value={env.APP_BASE_URL} />
        <Flag label="UNSUBSCRIBE_SECRET" value={env.UNSUBSCRIBE_SECRET} />
        <Flag label="UNSUBSCRIBE_SECRET_ALT" value={env.UNSUBSCRIBE_SECRET_ALT} />
        <Flag label="DIGEST_PREVIEW_SECRET" value={env.DIGEST_PREVIEW_SECRET} />
      </section>

      <section className="mt-6 space-y-2">
        <h2 className="text-base font-medium">Connectivity</h2>
        <Flag label="Service role DB check" value={serviceRoleOk.ok ? true : false} />
        {!serviceRoleOk.ok && (
          <p className="text-xs text-destructive">{serviceRoleOk.message}</p>
        )}
      </section>

      <section className="mt-6 text-sm">
        <h2 className="text-base font-medium">Supabase settings to verify</h2>
        <ol className="mt-2 list-decimal pl-5 space-y-1 text-muted-foreground">
          <li>
            Auth → Providers → Email: Enabled. Configure SMTP or use Supabase default for testing.
          </li>
          <li>
            Auth → URL Configuration: set <code>Site URL</code> to {origin} and add
            <code> {redirectUrl} </code> to the Redirect URLs allowlist.
          </li>
          <li>
            Ensure your local <code>.env.local</code> keys match the same Supabase project.
          </li>
        </ol>
      </section>
    </main>
  );
}
