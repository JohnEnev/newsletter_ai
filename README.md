This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.

## Newsletter AI: Testing & Tokens

Environment
- Copy `.env.local.example` to `.env.local` and fill in:
  - `NEXT_PUBLIC_SUPABASE_URL`
  - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
  - `SUPABASE_SERVICE_ROLE_KEY` (server-only)
  - `UNSUBSCRIBE_SECRET` (random, strong string)
  - `UNSUBSCRIBE_SECRET_ALT` (optional, for rotation)
  - `APP_BASE_URL` (e.g., `http://localhost:3000`)
  - `DIGEST_PREVIEW_SECRET` (protects preview API)

Database
- Run `supabase/schema.sql` in the Supabase SQL editor to create `public.user_prefs` and RLS policies.

Magic-link signup flow
1. Start dev: `npm run dev` and open `http://localhost:3000`.
2. Enter email on the homepage. Add interests/timeline when prompted and hit Continue.
3. Click the magic link in your inbox; the callback page saves preferences to `user_prefs`.

Where data lands
- Auth user: `auth.users` (email, id).
- Preferences: `public.user_prefs` (user_id, interests, timeline, unsubscribed).

One-click links (no login)
- Unsubscribe: `/unsubscribe?token=...` (or `&action=subscribe` to resubscribe).
- Manage preferences: `/manage?token=...` (edit interests/timeline/unsubscribe).
- Quick survey feedback: `/api/survey?token=...&article_id=<uuid>&q=Helpful%3F&a=yes`
  - Supports GET (good for email links) and POST (JSON body).
  - Optional redirect param for GET: `&redirect=${APP_BASE_URL}/survey/thanks`

Generate tokens for testing
- Script: `node scripts/generate-token.mjs --user-id <uuid> [--days 7] [--alt]` or `--email <address>`
- Prints Manage/Unsubscribe/Resubscribe links using `APP_BASE_URL`.
- Example:
  ```bash
  node scripts/generate-token.mjs --email you@example.com --days 3
  ```

Token secrets and rotation
- Primary: `UNSUBSCRIBE_SECRET` (required). Optional alternate: `UNSUBSCRIBE_SECRET_ALT`.
- Verification accepts either secret to allow seamless rotation.
- Recommended rotation steps:
  1) Add `UNSUBSCRIBE_SECRET_ALT` with a new strong value and deploy.
  2) Start signing new links using `--alt` (script uses ALT for signing).
  3) After old links age out (based on `exp`), move ALT to primary, clear ALT, redeploy.

Troubleshooting
- 403 or RLS errors after magic-link:
  - Ensure `supabase/schema.sql` was applied (table + RLS policies).
  - Confirm env vars are set and the magic-link redirect origin matches your dev URL.
- Not seeing email in `user_prefs`:
  - Email is stored in `auth.users`. `user_prefs` stores `user_id` and preference fields.
  - To view together:
    ```sql
    select u.email, p.*
    from auth.users u
    left join public.user_prefs p on p.user_id = u.id
    where u.email = 'you@example.com';
    ```

Schema overview
- user_prefs: user-level interests/timeline/unsubscribed (RLS: user may read/update own).
- articles: content items (open read policy).
- surveys: feedback events (RLS: user may read/insert own; server routes use service role).

Seeding articles
- Run: `node scripts/seed-articles.mjs`
- Inserts a few example articles if they don’t exist (by URL).

Digest preview (HTML)
- Endpoint: `/api/digest/preview?secret=${DIGEST_PREVIEW_SECRET}&user_id=<uuid>`
  - Or: `/api/digest/preview?secret=${DIGEST_PREVIEW_SECRET}&email=<address>`
- Returns HTML with recent articles, per-article survey links, and manage/unsubscribe links.

Generate digest files (batch)
- Script: `node scripts/generate-digests.mjs --out ./digests [--limit 100] [--email you@example.com | --user-id UUID] [--days 7] [--alt]`
- Produces one HTML file per user with single-use tokenized links.
- Example:
  ```bash
  node scripts/generate-digests.mjs --out ./digests --limit 50
  ```

Send digests via Resend (batch)
- Set in `.env.local`: `RESEND_API_KEY`, `EMAIL_FROM`, `EMAIL_SUBJECT`, `APP_BASE_URL`, `UNSUBSCRIBE_SECRET` (and optionally ALT), Supabase keys.
- Script: `node scripts/send-digests.mjs [--limit 50] [--email you@example.com | --user-id UUID] [--days 7] [--alt] [--include-unsubscribed] [--dry-run]`
- Examples:
  ```bash
  # Dry run first
  node scripts/send-digests.mjs --limit 5 --dry-run

  # Send to a single user by email
  node scripts/send-digests.mjs --email you@example.com

  # Send to recent 50 users, skipping unsubscribed
  node scripts/send-digests.mjs --limit 50
  ```

Used/expired link UX
- Friendly page at `/link/used` for consumed or expired tokens.
- Survey GET redirects there when a `redirect` was provided and the link was already used.
- Unsubscribe also redirects there if the token was already consumed.
