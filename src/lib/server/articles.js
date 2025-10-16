import fs from "fs";
import path from "path";
import { XMLParser } from "fast-xml-parser";

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
    const entries = parseFeedEntries(xml, feedUrl);
    if (entries.length === 0) return [];

    return entries
      .map(({ entry }) => {
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
        const tags = keywordTags(title, summary ?? "");
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
    if (parsed.length === 0) {
      console.warn(`[warn] Parsed 0 articles from ${feed}`);
    }
    articles.push(...parsed);
  }

  if (articles.length === 0) {
    console.warn("[warn] Using fallback articles (no feeds returned entries)");
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
