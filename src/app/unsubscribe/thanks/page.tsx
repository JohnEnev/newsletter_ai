import Link from "next/link";

export default function UnsubscribeThanksPage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center px-4 text-center">
      <h1 className="text-2xl font-semibold">Sorry to see you go</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        You’ve been unsubscribed. Thanks for trying Newsletter AI.
      </p>
      <div className="mt-6 flex items-center gap-3">
        <Link
          href="/"
          className="inline-flex items-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
        >
          Back to home
        </Link>
        <Link
          href="/manage"
          className="inline-flex items-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium"
        >
          Manage preferences
        </Link>
      </div>
    </main>
  );
}
