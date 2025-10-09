"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabaseClient";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";

type LoadState =
  | { state: "loading"; message?: string }
  | { state: "authed" }
  | { state: "anon" }
  | { state: "error"; message: string };

type PrefsRow = {
  interests?: string | null;
  timeline?: string | null;
  unsubscribed?: boolean | null;
};

function getErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error) return error.message || fallback;
  if (typeof error === "string") return error || fallback;
  return fallback;
}

export default function SettingsPage() {
  const [status, setStatus] = useState<LoadState>({ state: "loading" });
  const [interests, setInterests] = useState("");
  const [timeline, setTimeline] = useState("");
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
          .select<PrefsRow>("interests, timeline, unsubscribed")
          .eq("user_id", user.id)
          .maybeSingle();
        if (error) throw error;

        setInterests(data?.interests ?? "");
        setTimeline(data?.timeline ?? "");
        setUnsubscribed(Boolean(data?.unsubscribed));
        setStatus({ state: "authed" });
      } catch (error) {
        setStatus({ state: "error", message: getErrorMessage(error, "Failed to load") });
      }
    };
    run();
  }, []);

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

      const { error } = await supabase
        .from("user_prefs")
        .upsert({ user_id: user.id, interests, timeline, unsubscribed })
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

      const { error } = await supabase
        .from("user_prefs")
        .upsert({ user_id: user.id, interests, timeline, unsubscribed: next })
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
