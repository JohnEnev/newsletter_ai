import fs from "fs";
import path from "path";
import { XMLParser } from "fast-xml-parser";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";

const DEFAULT_FEEDS = [
  "https://hnrss.org/frontpage",
  "https://rss.nytimes.com/services/xml/rss/nyt/Technology.xml",
  "https://www.producthunt.com/feed",
  "https://www.theverge.com/rss/index.xml",
  "https://www.technologyreview.com/feed/",
  "https://feeds.feedburner.com/TechCrunch/startups",
  "https://feeds.bbci.co.uk/news/world/rss.xml",
  "https://foreignpolicy.com/feed/",
  "https://www.historytoday.com/feed/rss.xml",
];

const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "this",
  "that",
  "your",
  "about",
  "into",
  "these",
  "those",
  "their",
  "have",
  "will",
  "what",
  "when",
  "where",
  "which",
  "using",
  "guide",
  "daily",
  "today",
  "news",
  "tech",
  "how",
]);

const SHORT_TAGS = new Set(["ai", "vr", "ml", "ux", "ios", "web3", "usa", "eu"]);

const SAMPLE_JSON = path.resolve(process.cwd(), "scripts/data/example-articles.json");
const FALLBACK_ARTICLES = [
  {
    title: "AI Strategy Briefing",
    url: "https://example.com/briefing/ai-strategy",
    summary: "Key stories across AI policy, tooling, and product launches from the last 24 hours.",
    tags: ["ai", "strategy", "product"],
    source: "example.com",
  },
  {
    title: "Design Systems That Ship",
    url: "https://example.com/design-systems",
    summary: "Tactics for keeping design systems flexible while teams iterate quickly.",
    tags: ["design", "frontend", "systems"],
    source: "example.com",
  },
  {
    title: "Climate Tech Roundup",
    url: "https://example.com/climate-tech",
    summary: "Daily highlights covering carbon removal, grid storage, and climate venture trends.",
    tags: ["climate", "energy", "startups"],
    source: "example.com",
  },
];

const HOOK_MODEL = process.env.OPENAI_HOOK_MODEL || "gpt-4o-mini";
const MAX_HOOK_LENGTH = 220;

const PAYWALL_KEYWORDS = [
  "paywall",
  "subscriber",
  "subscription",
  "premium",
  "members-only",
  "digital-only",
  "register to read",
];

const PAYWALL_URL_HINTS = ["/paywall", "/premium", "/subscribe", "?share=1"];

const PAYWALL_DOMAINS = new Set(
  (process.env.PAYWALL_DOMAIN_DENYLIST || "wsj.com,economist.com,barrons.com,theinformation.com,ft.com")
    .split(/[,\s]+/)
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean),
);

const PAYWALL_PROBE_DOMAINS = new Set(
  (process.env.PAYWALL_HTML_PROBE_DOMAINS || "ft.com,wsj.com,bloomberg.com,nytimes.com,economist.com")
    .split(/[,\s]+/)
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean),
);

const PAYWALL_HTML_KEYWORDS = (process.env.PAYWALL_HTML_KEYWORDS
  || "subscribe to continue,subscribe now,log in to continue,already a subscriber,sign in to read")
  .split(/[,|]+/)
  .map((entry) => entry.trim().toLowerCase())
  .filter(Boolean);

const PAYWALL_PROBE_TIMEOUT_MS = Number.parseInt(process.env.PAYWALL_PROBE_TIMEOUT_MS || "2500", 10);

function articleLooksPaywalled({ url, tags = [], title = "" }) {
  const normalizedTags = tags.map((tag) => String(tag ?? "").toLowerCase());
  if (normalizedTags.some((tag) => PAYWALL_KEYWORDS.some((keyword) => tag.includes(keyword)))) {
    return true;
  }
  const lowerTitle = title.toLowerCase();
  if (PAYWALL_KEYWORDS.some((keyword) => lowerTitle.includes(keyword))) {
    return true;
  }
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (PAYWALL_DOMAINS.has(host) || PAYWALL_DOMAINS.has(host.replace(/^www\./, ""))) {
      return true;
    }
    const pathAndQuery = `${parsed.pathname}${parsed.search}`.toLowerCase();
    if (PAYWALL_URL_HINTS.some((hint) => pathAndQuery.includes(hint))) {
      return true;
    }
  } catch {
    // ignore
  }
  return false;
}

function shouldProbePaywall(hostname) {
  if (!hostname) return false;
  const bare = hostname.replace(/^www\./, "");
  return PAYWALL_PROBE_DOMAINS.has(bare);
}

async function probeHtmlPaywall(url) {
  if (!PAYWALL_HTML_KEYWORDS.length) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PAYWALL_PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent": "newsletter-ai-paywall-check",
        Accept: "text/html,application/xhtml+xml",
      },
    });
    if (!res.ok) return res.status === 402;
    const snippet = (await res.text()).slice(0, 50000).toLowerCase();
    if (!snippet) return false;
    if (snippet.includes("<meta name=\"metered_paywall\"")) return true;
    return PAYWALL_HTML_KEYWORDS.some((keyword) => snippet.includes(keyword));
  } catch (err) {
    if (process.env.NODE_ENV !== "production") {
      console.warn("[warn] Paywall probe failed", err instanceof Error ? err.message : err);
    }
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function createSupabaseAdmin() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) return null;
  try {
    return createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  } catch (error) {
    console.warn(
      "[warn] Failed to create Supabase client for topic feeds",
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

let cachedOpenAIClient = null;
function getOpenAIClient() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  if (cachedOpenAIClient) return cachedOpenAIClient;
  cachedOpenAIClient = new OpenAI({ apiKey });
  return cachedOpenAIClient;
}

async function generateHookQuestion({ title, summary, tags }) {
  const client = getOpenAIClient();
  if (!client) return null;

  const trimmedTitle = String(title ?? "").trim();
  const trimmedSummary = String(summary ?? "").trim();
  if (!trimmedTitle && !trimmedSummary) return null;

  const tagLine = Array.isArray(tags) && tags.length
    ? `Relevant tags: ${tags.slice(0, 4).join(", ")}`
    : "";

  try {
    const prompt = `Write one short question (max 25 words) that a reader could answer after reading the article described below.\n` +
      `The question should invite curiosity and use plain language.\n` +
      `Don't include explanations or extra sentences, just the question ending with a question mark.\n\n` +
      `Title: ${trimmedTitle || "(none)"}\n` +
      `Summary: ${trimmedSummary || "(none)"}\n${tagLine}`;

    const response = await client.responses.create({
      model: HOOK_MODEL,
      input: prompt,
      temperature: 0.4,
      max_output_tokens: 120,
    });

    const raw = response.output_text?.trim();
    if (!raw) return null;
    let question = raw.replace(/^Question:?\s*/i, "").replace(/\s+/g, " ").trim();
    if (!question.endsWith("?")) question = `${question}?`;
    if (question.length < 8) return null;
    if (question.length > MAX_HOOK_LENGTH) question = `${question.slice(0, MAX_HOOK_LENGTH - 1).trim()}?`;
    return question;
  } catch (error) {
    if (process.env.NODE_ENV !== "production") {
      console.warn("[warn] Failed to generate hook question", error instanceof Error ? error.message : error);
    }
    return null;
  }
}

async function loadTopicFeedMap() {
  const client = createSupabaseAdmin();
  if (!client) return new Map();

  try {
    const { data: feedRows, error: feedError } = await client
      .from("article_topic_feeds")
      .select("feed_url, topic_id, status")
      .eq("status", "active");
    if (feedError || !Array.isArray(feedRows)) {
      if (feedError && process.env.NODE_ENV !== "production") {
        console.warn("[warn] Failed to load article_topic_feeds", feedError.message);
      }
      return new Map();
    }

    const topicIds = Array.from(
      new Set(
        feedRows
          .map((row) => row?.topic_id)
          .filter((value) => typeof value === "string" && value.length > 0),
      ),
    );

    const topicMap = new Map();
    if (topicIds.length > 0) {
      const { data: topicRows, error: topicError } = await client
        .from("article_topics")
        .select("id, slug")
        .in("id", topicIds);
      if (topicError) {
        if (process.env.NODE_ENV !== "production") {
          console.warn("[warn] Failed to load article_topics", topicError.message);
        }
      } else if (Array.isArray(topicRows)) {
        for (const topic of topicRows) {
          const id = topic?.id;
          const slug = typeof topic?.slug === "string" ? topic.slug.trim().toLowerCase() : "";
          if (id && slug) topicMap.set(id, slug);
        }
      }
    }

    const feedMap = new Map();
    for (const row of feedRows) {
      const url = typeof row?.feed_url === "string" ? row.feed_url.trim() : "";
      if (!url) continue;
      if (!feedMap.has(url)) feedMap.set(url, new Set());
      const topicSlug = row?.topic_id ? topicMap.get(row.topic_id) : undefined;
      if (topicSlug) {
        feedMap.get(url).add(topicSlug);
      }
    }

    return feedMap;
  } catch (error) {
    if (process.env.NODE_ENV !== "production") {
      console.warn(
        "[warn] Unexpected error loading topic feeds",
        error instanceof Error ? error.message : error,
      );
    }
    return new Map();
  }
}

/**
 * @typedef {Object} GatherOptions
 * @property {string[]} [feedUrls]
 * @property {boolean} [noDefaultFeeds]
 * @property {string} [sourceFile]
 */

/**
 * @typedef {Object} ArticleCandidate
 * @property {string} title
 * @property {string} url
 * @property {string | null | undefined} [summary]
 * @property {string[]} tags
 * @property {string} source
 */

const NAMED_HTML_ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  rsquo: "’",
  lsquo: "‘",
  ldquo: "“",
  rdquo: "”",
  hellip: "…",
  mdash: "—",
  ndash: "–",
};

function decodeHtml(value = "") {
  const decodedCdata = value.replace(/<!\[CDATA\[(.*?)\]\]>/gs, "$1");
  return decodedCdata.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (match, entity) => {
    const lower = entity.toLowerCase();
    if (lower.startsWith("#x")) {
      const codePoint = Number.parseInt(lower.slice(2), 16);
      if (!Number.isNaN(codePoint)) return String.fromCodePoint(codePoint);
      return match;
    }
    if (lower.startsWith("#")) {
      const codePoint = Number.parseInt(lower.slice(1), 10);
      if (!Number.isNaN(codePoint)) return String.fromCodePoint(codePoint);
      return match;
    }
    return NAMED_HTML_ENTITIES[lower] ?? match;
  });
}

function stripHtml(value = "") {
  return decodeHtml(value)
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function summarise(text) {
  if (!text) return null;
  const clean = stripHtml(text);
  if (!clean) return null;
  return clean.length > 280 ? `${clean.slice(0, 277)}…` : clean;
}

function keywordTags(title = "", summary = "") {
  const text = `${title} ${summary}`.toLowerCase();
  const terms = text
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => (word.length >= 4 || SHORT_TAGS.has(word)) && !STOP_WORDS.has(word));

  const counts = new Map();
  for (const term of terms) {
    counts.set(term, (counts.get(term) || 0) + 1);
  }

  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([term]) => term);
}

function splitTagString(value = "") {
  return value
    .split(/[,/;|>#]+/)
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
}

function extractExplicitTags(entry) {
  const rawTags = new Set();
  const candidates = [
    entry?.category,
    entry?.categories,
    entry?.Category,
    entry?.tags,
    entry?.Topics,
    entry?.keywords,
    entry?.Keywords,
    entry?.topics,
    entry?.subject,
    entry?.subjects,
    entry?.['media:keywords'],
    entry?.['media:category'],
    entry?.['dc:subject'],
    entry?.['dc:terms'],
  ];

  for (const candidate of candidates) {
    for (const item of toArray(candidate)) {
      if (typeof item === 'string') {
        for (const part of splitTagString(item)) rawTags.add(part);
        continue;
      }
      const text = extractText(item);
      if (text) {
        for (const part of splitTagString(text)) rawTags.add(part);
      }
      if (item && typeof item.term === 'string') {
        for (const part of splitTagString(item.term)) rawTags.add(part);
      }
      if (item && typeof item.label === 'string') {
        for (const part of splitTagString(item.label)) rawTags.add(part);
      }
    }
  }

  return Array.from(rawTags.values()).slice(0, 12);
}

function derivePrimaryTag(tags) {
  if (!Array.isArray(tags)) return null;
  for (const tag of tags) {
    const clean = String(tag ?? "").trim().toLowerCase();
    if (clean) return clean;
  }
  return null;
}

function titleize(slug = "") {
  return slug
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

async function ensureTopics({ supabase, articleId, tags }) {
  if (!supabase || !articleId || !Array.isArray(tags) || tags.length === 0) return;
  const uniqueSlugs = Array.from(new Set(tags.map((tag) => String(tag ?? "").trim().toLowerCase()).filter(Boolean)));
  if (uniqueSlugs.length === 0) return;

  const topicRows = uniqueSlugs.map((slug) => ({ slug, display_name: titleize(slug) }));
  const { data: topics, error: topicErr } = await supabase
    .from("article_topics")
    .upsert(topicRows, { onConflict: "slug" })
    .select("id, slug");
  if (topicErr) {
    console.warn("[warn] Failed to upsert topics", topicErr.message);
    return;
  }

  if (!Array.isArray(topics) || topics.length === 0) return;
  const links = topics.map((topic) => ({
    article_id: articleId,
    topic_id: topic.id,
    confidence: 1,
  }));

  const { error: linkErr } = await supabase
    .from("article_topic_links")
    .upsert(links, { onConflict: "article_id,topic_id" });
  if (linkErr) {
    console.warn("[warn] Failed to upsert article-topic links", linkErr.message);
  }
}

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  trimValues: true,
  cdataTagName: "__cdata",
  processEntities: true,
});

function toArray(value) {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined) return [];
  return [value];
}

function extractText(node) {
  if (node === null || node === undefined) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) {
    for (const part of node) {
      const val = extractText(part);
      if (val) return val;
    }
    return "";
  }
  if (typeof node === "object") {
    if (typeof node.__cdata === "string") return node.__cdata;
    if (typeof node["#text"] === "string") return node["#text"];
    if (typeof node["$text"] === "string") return node["$text"];
  }
  return "";
}

function extractLinkValue(node) {
  if (!node) return "";
  const candidates = toArray(node);
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (typeof candidate === "string") {
      const trimmed = candidate.trim();
      if (trimmed) return trimmed;
      continue;
    }
    if (typeof candidate === "object") {
      const href = typeof candidate.href === "string" ? candidate.href.trim() : "";
      const rel = typeof candidate.rel === "string" ? candidate.rel.toLowerCase() : "";
      if (href && (!rel || rel === "alternate" || rel === "self")) return href;
      const text = extractText(candidate).trim();
      if (text) return text;
      if (href) return href;
    }
  }
  return "";
}

function parseFeedEntries(xml, feedUrl) {
  try {
    const doc = xmlParser.parse(xml);
    const entries = [];

    if (doc?.rss?.channel) {
      for (const channel of toArray(doc.rss.channel)) {
        entries.push(...toArray(channel?.item).map((entry) => ({ type: "rss", entry })));
      }
    }

    if (doc?.channel) {
      for (const channel of toArray(doc.channel)) {
        entries.push(...toArray(channel?.item).map((entry) => ({ type: "rss", entry })));
      }
    }

    if (doc?.feed) {
      for (const feed of toArray(doc.feed)) {
        entries.push(...toArray(feed?.entry).map((entry) => ({ type: "atom", entry })));
      }
    }

    if (entries.length === 0) {
      const snippet = String(xml).slice(0, 400).replace(/\s+/g, ' ');
      console.warn(`[warn] No entries found in feed ${feedUrl}. Snippet: ${snippet}`);
    }

    return entries;
  } catch (err) {
    console.warn(`[warn] Failed to parse feed ${feedUrl}: ${err instanceof Error ? err.message : err}`);
    return [];
  }
}


async function fetchRss({ url: feedUrl, topics = [] }) {
  const topicTags = Array.isArray(topics)
    ? topics
        .map((topic) => String(topic ?? "").trim().toLowerCase())
        .filter((value) => value.length > 0)
    : [];
  try {
    const res = await fetch(feedUrl, {
      headers: { "User-Agent": "newsletter-ai-fetcher" },
      cache: 'no-store',
    });
    if (!res.ok) {
      console.warn(`[warn] Failed to fetch ${feedUrl}: ${res.status}`);
      return [];
    }
    const xml = await res.text();
    const entries = parseFeedEntries(xml, feedUrl);
    if (entries.length === 0) return [];

    const processed = await Promise.all(
      entries.map(async ({ entry }) => {
        const rawTitle = extractText(entry?.title);
        const rawLink = extractLinkValue(entry?.link);
        const rawGuid = extractText(entry?.guid);
        const rawId = extractText(entry?.id);
        const title = decodeHtml(rawTitle).trim();
        const link = decodeHtml(rawLink).trim();
        const fallbackUrl = decodeHtml(rawGuid || rawId).trim();
        const url = link || fallbackUrl;
        const description =
          extractText(entry?.description)
          || extractText(entry?.summary)
          || extractText(entry?.content)
          || extractText(entry?.subtitle)
          || extractText(entry && entry["content:encoded"])
          || extractText(entry && entry.encoded);
        const summary = summarise(description);
        if (!title || !url) {
          const snippet = JSON.stringify(entry).slice(0, 200);
          const reason = !title ? "title" : "url";
          console.warn(`[warn] Entry missing ${reason} in ${feedUrl}: ${snippet}`);
          return null;
        }
        const explicit = extractExplicitTags(entry);
        const generated = keywordTags(title, summary ?? "");
        const tags = Array.from(new Set([...explicit, ...generated, ...topicTags]));
        const hostname = (() => {
          try {
            return new URL(url).hostname;
          } catch {
            try {
              return new URL(feedUrl).hostname;
            } catch {
              return "unknown";
            }
          }
        })();

        if (articleLooksPaywalled({ url, tags, title })) {
          if (process.env.NODE_ENV !== "production") {
            console.log(`[skip] Paywalled article filtered: ${url}`);
          }
          return null;
        }

        if (shouldProbePaywall(hostname)) {
          const htmlBlocked = await probeHtmlPaywall(url);
          if (htmlBlocked) {
            if (process.env.NODE_ENV !== "production") {
              console.log(`[skip] HTML paywall detected: ${url}`);
            }
            return null;
          }
        }
        return {
          title,
          url,
          summary,
          tags,
          source: hostname,
        };
      })
    );

    return processed.filter(Boolean);
  } catch (err) {
    console.warn(`[warn] Exception fetching ${feedUrl}: ${err instanceof Error ? err.message : err}`);
    if (err instanceof Error && err.cause) {
      console.warn(`[warn]   cause: ${String(err.cause)}`);
    }
    return [];
  }
}

function loadLocalArticles(sourceFile) {
  const candidate = sourceFile
    ? (path.isAbsolute(sourceFile) ? sourceFile : path.resolve(process.cwd(), sourceFile))
    : SAMPLE_JSON;
  if (!fs.existsSync(candidate)) return FALLBACK_ARTICLES;
  try {
    const txt = fs.readFileSync(candidate, "utf-8");
    const parsed = JSON.parse(txt);
    const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.items) ? parsed.items : [];
        const hydrated = list
          .map((item) => {
            const title = String(item.title ?? "").trim();
            const url = String(item.url ?? "").trim();
            if (!title || !url) return null;
            const summary = summarise(item.summary || item.description || "");
            const fallbackTags = Array.isArray(item.tags) ? item.tags.map((t) => String(t)) : [];
            const generated = keywordTags(title, summary ?? "");
            const tags = Array.from(new Set([...fallbackTags.map((t) => t.toLowerCase()), ...generated]));
        const source = (() => {
          try {
            return new URL(url).hostname;
          } catch {
            return "local";
          }
        })();
        return { title, url, summary, tags, source };
      })
      .filter(Boolean);
    if (hydrated.length === 0) return FALLBACK_ARTICLES;
    return hydrated;
  } catch (err) {
    console.warn(`[warn] Could not parse ${candidate}: ${err instanceof Error ? err.message : err}`);
    return FALLBACK_ARTICLES;
  }
}

/**
 * @param {GatherOptions} [options]
 * @returns {Promise<ArticleCandidate[]>}
 */
export async function gatherArticles({ feedUrls = [], noDefaultFeeds = false, sourceFile } = {}) {
  const dynamicFeedMap = await loadTopicFeedMap();
  const feedTopicMap = new Map();

  const addFeed = (url, topics = []) => {
    if (typeof url !== "string") return;
    const cleanUrl = url.trim();
    if (!cleanUrl) return;
    const entry = feedTopicMap.get(cleanUrl) ?? { url: cleanUrl, topics: new Set() };
    for (const topic of topics) {
      if (!topic) continue;
      const slug = String(topic).trim().toLowerCase();
      if (slug) entry.topics.add(slug);
    }
    feedTopicMap.set(cleanUrl, entry);
  };

  if (!noDefaultFeeds) {
    DEFAULT_FEEDS.forEach((url) => addFeed(url));
  }

  feedUrls.forEach((url) => addFeed(url));

  for (const [url, topicSet] of dynamicFeedMap.entries()) {
    addFeed(url, topicSet);
  }

  const feedSources = Array.from(feedTopicMap.values()).map(({ url, topics }) => ({
    url,
    topics: Array.from(topics.values()),
  }));

  const articles = [];
  for (const source of feedSources) {
    const parsed = await fetchRss(source);
    if (parsed.length === 0) {
      console.warn(`[warn] Parsed 0 articles from ${source.url}`);
    }
    articles.push(...parsed);
  }

  if (articles.length === 0) {
    console.warn("[warn] Using fallback articles (no feeds returned entries)");
    articles.push(...loadLocalArticles(sourceFile));
  }

  const merged = new Map();
  for (const article of articles) {
    if (!article || typeof article.url !== "string") continue;
    const key = article.url;
    const existing = merged.get(key);
    if (existing) {
      const combinedTags = new Set([...(existing.tags || []), ...(article.tags || [])]);
      existing.tags = Array.from(combinedTags.values());
      if (!existing.summary && article.summary) existing.summary = article.summary;
      if (!existing.source && article.source) existing.source = article.source;
      continue;
    }
    const uniqueTags = Array.isArray(article.tags)
      ? Array.from(new Set(article.tags.map((tag) => String(tag ?? "").trim().toLowerCase()).filter(Boolean)))
      : [];
    merged.set(key, { ...article, tags: uniqueTags });
  }

  return Array.from(merged.values());
}

export async function ingestArticles({ supabase, articles, dryRun = false }) {
  let inserted = 0;
  for (const article of articles) {
    try {
      const { data: existing, error: selectError } = await supabase
        .from("articles")
        .select("id")
        .eq("url", article.url)
        .maybeSingle();
      if (selectError) {
        console.error(`[error] Failed to check ${article.url}: ${selectError.message}`);
        continue;
      }
      if (existing) {
        console.log(`[skip] ${article.url}`);
        continue;
      }

      if (dryRun) {
        console.log(`[dry] Would insert ${article.title}`);
        inserted++;
        continue;
      }

      const tags = Array.isArray(article.tags)
        ? article.tags
            .map((tag) => String(tag ?? "").trim().toLowerCase())
            .filter((tag) => tag.length > 0)
        : [];

      let hookQuestion = null;
      if (!dryRun) {
        hookQuestion = await generateHookQuestion({
          title: article.title,
          summary: article.summary,
          tags,
        });
      }
      const { data: insertedRow, error } = await supabase
        .from("articles")
        .insert({
          title: article.title,
          url: article.url,
          summary: article.summary,
          hook_question: hookQuestion,
          tags,
          primary_tag: derivePrimaryTag(tags),
          source: article.source,
        })
        .select("id")
        .single();
      if (error) {
        console.error(`[error] Failed to insert ${article.url}: ${error.message}`);
      } else {
        console.log(`[inserted] ${article.title}`);
        inserted++;
        await ensureTopics({ supabase, articleId: insertedRow?.id, tags });
      }
    } catch (err) {
      console.error(`[error] Unexpected issue for ${article?.url}:`, err instanceof Error ? err.message : err);
    }
  }

  return { processed: articles.length, inserted };
}

export { SAMPLE_JSON as sampleDataPath };
