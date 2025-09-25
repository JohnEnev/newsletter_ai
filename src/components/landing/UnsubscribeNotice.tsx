"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabaseClient";

export function UnsubscribeNotice() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    const run = async () => {
      try {
        const {
          data: { user },
        } = await supabase.auth.getUser();
        if (!user) return;
        const { data, error } = await supabase
          .from("user_prefs")
          .select("unsubscribed")
          .eq("user_id", user.id)
          .maybeSingle();
        if (error) return;
        setShow(Boolean(data?.unsubscribed));
      } catch {
        // ignore
      }
    };
    run();
  }, []);

  if (!show) return null;

  return (
    <div className="mx-auto w-full max-w-5xl px-4 pt-4">
      <div className="rounded-lg border border-border bg-secondary px-4 py-2 text-sm text-secondary-foreground">
        You’re currently unsubscribed. Manage your preferences on the
        {" "}
        <a href="/settings" className="underline underline-offset-2 hover:no-underline">
          Settings
        </a>
        {" "}
        page.
      </div>
    </div>
  );
}

