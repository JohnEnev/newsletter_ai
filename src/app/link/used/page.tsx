export default function LinkUsedPage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center px-4 text-center">
      <h1 className="text-2xl font-semibold">This link is no longer valid</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        It may have already been used or expired. If you need a fresh link,
        use the email in your latest newsletter or request a new one.
      </p>
      <div className="mt-6 flex items-center gap-3">
        <a
          href="/"
          className="inline-flex items-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
        >
          Back to home
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

