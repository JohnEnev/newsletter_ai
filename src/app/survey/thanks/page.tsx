export default function SurveyThanksPage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center px-4 text-center">
      <h1 className="text-2xl font-semibold">Thanks for the feedback!</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Your response helps improve future recommendations.
      </p>
      <a
        href="/"
        className="mt-6 inline-flex items-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
      >
        Back to home
      </a>
    </main>
  );
}

