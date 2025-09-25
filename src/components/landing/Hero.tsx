"use client";

import { Button } from "@/components/ui/button";
import Link from "next/link";
import { InlineSignup } from "@/components/landing/InlineSignup";

export function Hero() {
  return (
    <section className="w-full py-16 sm:py-24">
      <div className="mx-auto max-w-5xl px-4">
        <div className="text-center">
          <h1 className="mt-6 text-4xl font-bold tracking-tight sm:text-6xl">
            Newsletter AI
          </h1>
          <p className="mt-4 text-base text-muted-foreground sm:text-lg">
            Get handpicked articles that match your interests. Tune frequency,
            delivery time, and give feedback with quick surveys.
          </p>
          <InlineSignup />
        </div>
      </div>
    </section>
  );
}
