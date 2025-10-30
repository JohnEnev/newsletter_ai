import { createClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

type PageProps = {
  searchParams?: Record<string, string | string[] | undefined>;
};

type FeedRow = {
  id: string;
  feed_url: string;
  status: string | null;
  last_synced_at: string | null;
  topic: { slug: string | null; display_name: string | null } | null;
};

type TopicCountRow = {
  topic_id: string | null;
  count: number | null;
  topic: { slug: string | null; display_name: string | null } | null;
};

type RecentArticle = {
  id: string;
  title: string;
  created_at: string | null;
  source: string | null;
  primary_tag: string | null;
  tags: string[] | null;
};

function validateSecret(searchParams?: Record<string, string | string[] | undefined>) {
  const secret = process.env.ADMIN_DASHBOARD_SECRET || process.env.DIGEST_PREVIEW_SECRET || "";
  const provided = typeof searchParams?.secret === "string" ? searchParams.secret : "";
  if (!secret) {
    return { ok: false, reason: "ADMIN_DASHBOARD_SECRET (or DIGEST_PREVIEW_SECRET) is not configured." } as const;
  }
  if (provided !== secret) {
    return { ok: false, reason: "Unauthorized. Append ?secret=... with the configured secret." } as const;
  }
  return { ok: true } as const;
}

function ensureEnv() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    return {
      ok: false,
      reason: "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables.",
    } as const;
  }
  return { ok: true, supabaseUrl, serviceRoleKey } as const;
}

function formatDate(value: string | null | undefined) {
  if (!value) return "Never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatTagList(tags: string[] | null | undefined) {
  if (!Array.isArray(tags) || tags.length === 0) return "—";
  return tags.map((tag) => tag.trim()).filter(Boolean).slice(0, 6).join(" · ");
}

function toTitle(value: string | null | undefined) {
  if (!value) return "Unknown";
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export default async function AdminFeedsPage({ searchParams }: PageProps) {
  const auth = validateSecret(searchParams);
  if (!auth.ok) {
    return (
      <main className="mx-auto max-w-xl px-4 py-12 text-center">
        <h1 className="text-2xl font-semibold">Feeds Dashboard</h1>
        <p className="mt-4 text-sm text-destructive">{auth.reason}</p>
      </main>
    );
  }

  const env = ensureEnv();
  if (!env.ok) {
    return (
      <main className="mx-auto max-w-xl px-4 py-12 text-center">
        <h1 className="text-2xl font-semibold">Feeds Dashboard</h1>
        <p className="mt-4 text-sm text-destructive">{env.reason}</p>
      </main>
    );
  }

  const admin = createClient(env.supabaseUrl, env.serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const [articleCountRes, feedRes, topicCountRes, articleRes] = await Promise.all([
    admin
      .from("articles")
      .select("id", { count: "exact", head: true }),
    admin
      .from("article_topic_feeds")
      .select("id, feed_url, status, last_synced_at, topic:article_topics (slug, display_name)")
      .order("feed_url", { ascending: true }),
    admin
      .from("article_topic_links")
      .select("topic_id, count:article_id, topic:article_topics (slug, display_name)")
      .order("count", { ascending: false }),
    admin
      .from("articles")
      .select("id, title, created_at, tags, source, primary_tag")
      .order("created_at", { ascending: false })
      .limit(10),
  ]);

  const issues: string[] = [];
  if (articleCountRes.error) issues.push(`Articles query failed: ${articleCountRes.error.message}`);
  if (feedRes.error) issues.push(`Feeds query failed: ${feedRes.error.message}`);
  if (topicCountRes.error) issues.push(`Topic counts failed: ${topicCountRes.error.message}`);
  if (articleRes.error) issues.push(`Recent articles failed: ${articleRes.error.message}`);

  const totalArticles = articleCountRes.count ?? 0;
  const feeds = (feedRes.data ?? []) as FeedRow[];
  const topicCounts = (topicCountRes.data ?? []) as TopicCountRow[];
  const recentArticles = (articleRes.data ?? []) as RecentArticle[];

  const activeFeeds = feeds.filter((feed) => (feed.status || "active").toLowerCase() === "active");

  const topicStats = new Map<
    string,
    {
      slug: string;
      name: string;
      feedCount: number;
      articleCount: number;
    }
  >();

  for (const feed of feeds) {
    const slug = feed.topic?.slug?.toLowerCase() || "unknown";
    const name = feed.topic?.display_name || toTitle(slug);
    if (!topicStats.has(slug)) {
      topicStats.set(slug, { slug, name, feedCount: 0, articleCount: 0 });
    }
    topicStats.get(slug)!.feedCount += 1;
  }

  for (const row of topicCounts) {
    const slug = row.topic?.slug?.toLowerCase() || "unknown";
    const name = row.topic?.display_name || toTitle(slug);
    if (!topicStats.has(slug)) {
      topicStats.set(slug, { slug, name, feedCount: 0, articleCount: 0 });
    }
    const value = Number(row.count ?? 0);
    topicStats.get(slug)!.articleCount = Number.isNaN(value) ? 0 : value;
  }

  const sortedTopics = Array.from(topicStats.values()).sort((a, b) => b.articleCount - a.articleCount);

  const uncoveredTopics = sortedTopics.filter((topic) => topic.articleCount === 0 || topic.feedCount === 0);

  return (
    <main className="mx-auto max-w-5xl px-4 py-10">
      <h1 className="text-3xl font-semibold">Feeds & Coverage</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Requires secret access. Use the CLI helper to register new feeds, then rerun the article sync job to pull them in.
      </p>

      {issues.length > 0 && (
        <div className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          <p className="font-medium">Warnings</p>
          <ul className="mt-1 list-disc pl-5">
            {issues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        </div>
      )}

      <section className="mt-6 grid gap-4 sm:grid-cols-3">
        <div className="rounded-lg border border-border bg-card p-4">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Total articles</p>
          <p className="mt-2 text-3xl font-semibold">{totalArticles}</p>
        </div>
        <div className="rounded-lg border border-border bg-card p-4">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Active feeds</p>
          <p className="mt-2 text-3xl font-semibold">{activeFeeds.length}</p>
          <p className="text-xs text-muted-foreground">of {feeds.length} registered feeds</p>
        </div>
        <div className="rounded-lg border border-border bg-card p-4">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Topics with coverage</p>
          <p className="mt-2 text-3xl font-semibold">{sortedTopics.filter((topic) => topic.articleCount > 0).length}</p>
          <p className="text-xs text-muted-foreground">{sortedTopics.length} total topics tracked</p>
        </div>
      </section>

      <section className="mt-10">
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-semibold">Topic coverage</h2>
          <span className="text-xs text-muted-foreground">article count · feed count</span>
        </div>
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          {sortedTopics.slice(0, 8).map((topic) => (
            <div key={topic.slug} className="rounded-lg border border-border bg-card p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium">{topic.name}</p>
                  <p className="text-xs text-muted-foreground">{topic.slug}</p>
                </div>
                <div className="text-right">
                  <p className="text-lg font-semibold">{topic.articleCount}</p>
                  <p className="text-xs text-muted-foreground">articles · {topic.feedCount} feeds</p>
                </div>
              </div>
            </div>
          ))}
          {sortedTopics.length === 0 && (
            <p className="text-sm text-muted-foreground">No topic data yet. Ingest articles to populate coverage.</p>
          )}
        </div>
      </section>

      {uncoveredTopics.length > 0 && (
        <section className="mt-10">
          <h2 className="text-xl font-semibold">Topics needing attention</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Add feeds or review tagging to cover these interests.
          </p>
          <ul className="mt-3 space-y-2 text-sm">
            {uncoveredTopics.map((topic) => (
              <li key={topic.slug} className="rounded-md border border-border/60 bg-muted/40 px-3 py-2">
                <span className="font-medium">{topic.name}</span>
                <span className="ml-2 text-muted-foreground">• feeds: {topic.feedCount} • articles: {topic.articleCount}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="mt-10">
        <h2 className="text-xl font-semibold">Registered feeds</h2>
        <div className="mt-4 overflow-hidden rounded-lg border border-border">
          <table className="min-w-full divide-y divide-border text-sm">
            <thead className="bg-muted/40">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Feed URL</th>
                <th className="px-3 py-2 text-left font-medium">Topic</th>
                <th className="px-3 py-2 text-left font-medium">Status</th>
                <th className="px-3 py-2 text-left font-medium">Last synced</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border bg-card">
              {feeds.map((feed) => {
                const status = (feed.status || "active").toLowerCase();
                const statusCls = status === "active" ? "text-emerald-600" : "text-orange-500";
                const topicName = feed.topic?.display_name || feed.topic?.slug || "—";
                return (
                  <tr key={feed.id}>
                    <td className="px-3 py-2 align-top text-xs sm:text-sm">
                      <a href={feed.feed_url} className="text-primary hover:underline" target="_blank" rel="noreferrer">
                        {feed.feed_url}
                      </a>
                    </td>
                    <td className="px-3 py-2 align-top text-xs sm:text-sm">{topicName}</td>
                    <td className={`px-3 py-2 align-top text-xs font-medium sm:text-sm ${statusCls}`}>{status}</td>
                    <td className="px-3 py-2 align-top text-xs text-muted-foreground sm:text-sm">{formatDate(feed.last_synced_at)}</td>
                  </tr>
                );
              })}
              {feeds.length === 0 && (
                <tr>
                  <td className="px-3 py-3 text-sm text-muted-foreground" colSpan={4}>
                    No feeds configured yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="mt-10">
        <h2 className="text-xl font-semibold">Recent articles</h2>
        <div className="mt-4 space-y-3">
          {recentArticles.map((article) => (
            <div key={article.id} className="rounded-lg border border-border bg-card p-4">
              <div className="flex flex-col gap-1 md:flex-row md:items-center md:justify-between">
                <div>
                  <p className="text-sm font-medium">{article.title}</p>
                  <p className="text-xs text-muted-foreground">
                    {article.source || "unknown source"} • {formatDate(article.created_at)}
                  </p>
                </div>
                <p className="text-xs text-muted-foreground md:text-right">{formatTagList(article.tags)}</p>
              </div>
            </div>
          ))}
          {recentArticles.length === 0 && (
            <p className="text-sm text-muted-foreground">No articles yet. Run the article sync job to import content.</p>
          )}
        </div>
      </section>

      <section className="mt-12 rounded-lg border border-border bg-muted/30 p-4 text-sm">
        <h2 className="text-base font-semibold">Next steps</h2>
        <ol className="mt-2 list-decimal space-y-2 pl-5 text-muted-foreground">
          <li>
            Use <code>node scripts/manage-topic-feeds.mjs add --topic geopolitics --feed https://…</code> to register additional feeds.
          </li>
          <li>
            Run <code>npm run articles:sync</code> (optionally pass <code>-- --limit 40</code>) to pull fresh stories from the new feeds.
          </li>
          <li>Refresh this dashboard to confirm coverage increases for the targeted interests.</li>
        </ol>
      </section>
    </main>
  );
}
