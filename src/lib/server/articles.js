import fs from "fs";
import path from "path";

const DEFAULT_FEEDS = [
  "https://hnrss.org/frontpage",
  "https://rss.nytimes.com/services/xml/rss/nyt/Technology.xml", 
  "https://www.producthunt.com/feed",
  "https://www.theverge.com/rss/index.xml",
  "https://www.technologyreview.com/feed/",
  "https://feeds.feedburner.com/TechCrunch/startups",
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

function decodeHtml(value = "") {
  return value
    .replace(/<!\[CDATA\[(.*?)\]\]>/gs, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
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
    .filter((word) => word.length >= 4 && !STOP_WORDS.has(word));

  const counts = new Map();
  for (const term of terms) {
    counts.set(term, (counts.get(term) || 0) + 1);
  }

  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([term]) => term);
}

function parseFeedEntries(xml) {
  const items = [];
  const rssRegex = /<item[\s\S]*?<\/item>/gi;
  const atomRegex = /<entry[\s\S]*?<\/entry>/gi;
  let match;
  while ((match = rssRegex.exec(xml))) {
    items.push(match[0]);
  }
  while ((match = atomRegex.exec(xml))) {
    items.push(match[0]);
  }
  return items;
}

function extractTag(xml, tag) {
  const regex = new RegExp(`<${tag}[^>]*>([\s\S]*?)<\/${tag}>`, "i");
  const match = xml.match(regex);
  if (!match) return "";
  return decodeHtml(match[1]);
}

function extractLinkFromSelfClosingTag(xml) {
  const match = xml.match(/<link\b([^>]*)\/?>(?:\s*<\/link>)?/i);
  if (!match) return "";
  const attrs = match[1] || "";
  const hrefMatch = attrs.match(/href=["']([^"']+)["']/i);
  if (!hrefMatch) return "";
  return decodeHtml(hrefMatch[1]);
}

function extractLink(xml) {
  const direct = extractTag(xml, "link").trim();
  if (direct) return direct;

  const candidates = xml.matchAll(/<link\b([^>]*)\/?>(?:\s*<\/link>)?/gi);
  for (const candidate of candidates) {
    const attrs = candidate[1] || "";
    const relMatch = attrs.match(/rel=["']([^"']+)["']/i);
    if (relMatch && relMatch[1].toLowerCase() !== "alternate") continue;
    const hrefMatch = attrs.match(/href=["']([^"']+)["']/i);
    if (hrefMatch) return decodeHtml(hrefMatch[1]);
  }

  return extractLinkFromSelfClosingTag(xml);
}

async function fetchRss(feedUrl) {
  try {
    const res = await fetch(feedUrl, {
      headers: { "User-Agent": "newsletter-ai-fetcher" },
      next: { revalidate: 0 },
    });
    if (!res.ok) {
      console.warn(`[warn] Failed to fetch ${feedUrl}: ${res.status}`);
      return [];
    }
    const xml = await res.text();
    const items = parseFeedEntries(xml);
    return items
      .map((item) => {
        const title = extractTag(item, "title").trim();
        const link = extractLink(item).trim();
        const description =
          extractTag(item, "description")
          || extractTag(item, "content:encoded")
          || extractTag(item, "summary")
          || extractTag(item, "content");
        const summary = summarise(description);
        const url = link || extractTag(item, "guid") || extractTag(item, "id");
        if (!title || !url) return null;
        const tags = keywordTags(title, summary ?? "");
        const hostname = (() => {
          try {
            return new URL(url).hostname;
          } catch {
            return new URL(feedUrl).hostname;
          }
        })();
        return {
          title,
          url,
          summary,
          tags,
          source: hostname,
        };
      })
      .filter(Boolean);
  } catch (err) {
    console.warn(`[warn] Exception fetching ${feedUrl}: ${err instanceof Error ? err.message : err}`);
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
        const tags = Array.isArray(item.tags) ? item.tags.map((t) => String(t)) : keywordTags(title, summary ?? "");
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
  /** @type {string[]} */
  const feeds = [];
  if (!noDefaultFeeds) feeds.push(...DEFAULT_FEEDS);
  feeds.push(...feedUrls);

  const articles = [];
  for (const feed of feeds) {
    const parsed = await fetchRss(feed);
    articles.push(...parsed);
  }

  if (articles.length < 5) {
    articles.push(...loadLocalArticles(sourceFile));
  }

  const deduped = [];
  const seen = new Set();
  for (const article of articles) {
    if (!article || seen.has(article.url)) continue;
    seen.add(article.url);
    deduped.push(article);
  }

  return deduped;
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

      const { error } = await supabase
        .from("articles")
        .insert({
          title: article.title,
          url: article.url,
          summary: article.summary,
          tags: article.tags,
          source: article.source,
        });
      if (error) {
        console.error(`[error] Failed to insert ${article.url}: ${error.message}`);
      } else {
        console.log(`[inserted] ${article.title}`);
        inserted++;
      }
    } catch (err) {
      console.error(`[error] Unexpected issue for ${article?.url}:`, err instanceof Error ? err.message : err);
    }
  }

  return { processed: articles.length, inserted };
}

export { SAMPLE_JSON as sampleDataPath };
