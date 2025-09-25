import { Hero } from "@/components/landing/Hero";
import { Features } from "@/components/landing/Features";
import { UnsubscribeNotice } from "@/components/landing/UnsubscribeNotice";

export default function Home() {
  return (
    <main className="min-h-dvh w-full">
      <UnsubscribeNotice />
      <Hero />
      <Features />
    </main>
  );
}
