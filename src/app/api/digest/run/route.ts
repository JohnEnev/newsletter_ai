import { NextResponse } from "next/server";
import { randomBytes, createHmac } from "crypto";
import { timingSafeEqual } from "crypto";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import { signPayload, type TokenPayload } from "@/lib/tokens";
import { extractInterestTokens } from "@/lib/interests";

type PrefRow = {
  user_id: string;
  interests: string | null;
  timeline: string | null;
  unsubscribed: boolean | null;
  send_timezone: string | null;
  send_hour: number | null;
  send_minute: number | null;
  last_digest_sent_at: string | null;
  last_digest_article_ids: string[] | null;
};

type ArticleRow = {
  id: string;
  title: string;
  url: string;
  summary: string | null;
  hook_question: string | null;
  tags: string[] | null;
  primary_tag: string | null;
  created_at: string;
};

type TopicRow = {
  id: string;
  slug: string | null;
  display_name: string | null;
};

const RESEND_ENDPOINT = "https://api.resend.com/emails";
const HOOK_MODEL = process.env.OPENAI_HOOK_MODEL || "gpt-4o-mini";

const TOKEN_SYNONYMS: Record<string, string[]> = {
  ai: [
    "ai",
    "artificial intelligence",
    "machine learning",
    "ml",
    "generative ai",
    "large language model",
    "automation",
  ],
  geopolitics: [
    "geopolitics",
    "geo-politics",
    "geopolitical",
    "geopolitical risk",
    "world politics",
    "international relations",
    "foreign policy",
    "global security",
    "geostrategy",
  ],
  politics: [
    "politics",
    "policy",
    "government",
    "public policy",
    "election",
    "political",
  ],
  history: [
    "history",
    "historical",
    "world history",
    "heritage",
    "culture history",
    "timeline",
    "past events",
  ],
  economics: [
    "economics",
    "economy",
    "macroeconomics",
    "markets",
    "economic policy",
    "inflation",
  ],
  finance: [
    "finance",
    "markets",
    "investing",
    "stocks",
    "capital",
  ],
  climate: [
    "climate",
    "environment",
    "sustainability",
    "energy",
    "carbon",
  ],
};

const FALLBACK_LIBRARY: Record<
  string,
  Array<{
    title: string;
    summary: string;
    url: string;
    label?: string;
    hookQuestion?: string;
    tags?: string[];
  }>
> = {
  ai: [
    {
      label: "AI",
      title: "A Primer on Where AI Stands Now",
      summary:
        "Researchers and companies are racing to deploy large language models, but the real breakthroughs hinge on aligning systems with human values and regulating their impact.",
      url: "https://www.technologyreview.com/2024/01/04/1086228/what-comes-after-chatgpt/",
      hookQuestion: "What risks do experts worry about as companies deploy more advanced AI systems?",
      tags: ["ai", "technology", "ethics"],
    },
    {
      label: "AI",
      title: "How Generative AI Is Rewriting Knowledge Work",
      summary:
        "Early studies show office workers are already offloading routine writing, brainstorming, and analytics to copilots—freeing time for higher-impact decisions but raising oversight questions.",
      url: "https://www.theatlantic.com/technology/archive/2024/02/generative-ai-workplace-productivity/677478/",
      hookQuestion: "Which everyday tasks are knowledge workers delegating to generative AI tools right now?",
      tags: ["ai", "work", "productivity"],
    },
  ],
  geopolitics: [
    {
      label: "Geopolitics",
      title: "How Great-Power Competition Is Shaping the World",
      summary:
        "Analysts argue that a renewed contest among the United States, China, and Russia is reshaping alliances, economic corridors, and regional flashpoints from the Indo-Pacific to Eastern Europe.",
      url: "https://www.cfr.org/backgrounder/great-power-competition-renewed",
      hookQuestion: "Which regions do analysts flag as the most volatile in the current great-power rivalry?",
      tags: ["geopolitics", "foreign policy"],
    },
    {
      label: "Geopolitics",
      title: "Why a New Nonaligned Movement Is Emerging",
      summary:
        "From India to Brazil, middle powers are leveraging U.S.-China rivalry to secure investment, technology, and political room to maneuver without picking sides outright.",
      url: "https://foreignpolicy.com/2024/03/18/nonaligned-movement-global-south-diplomacy/",
      hookQuestion: "How are middle powers using great-power rivalry to their advantage?",
      tags: ["geopolitics", "global south"],
    },
  ],
  history: [
    {
      label: "History",
      title: "Why Studying History Still Matters",
      summary:
        "Understanding how previous generations confronted upheaval helps us make sense of today’s crises, from pandemics to political polarization.",
      url: "https://www.historytoday.com/archive/feature/why-history-matters",
      hookQuestion: "How can looking at past pandemics guide public responses to new outbreaks?",
      tags: ["history", "society"],
    },
    {
      label: "History",
      title: "What the Roman Republic Teaches About Political Resilience",
      summary:
        "Historians outline the institutions that helped Rome survive repeated crises—and the warning signs when civic norms finally eroded.",
      url: "https://www.historyextra.com/period/roman/roman-republic-collapse-lessons-modern-democracy/",
      hookQuestion: "Which safeguards kept the Roman Republic functioning during repeated crises?",
      tags: ["history", "politics"],
    },
  ],
};

function getTimeInTimezone(timeZone: string, reference: Date) {
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZone,
    });
    const parts = formatter.formatToParts(reference);
    const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
    const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
    if (Number.isNaN(hour) || Number.isNaN(minute)) throw new Error("Invalid time part");
    return { hour, minute };
  } catch {
    return { hour: reference.getUTCHours(), minute: reference.getUTCMinutes() };
  }
}

function minutesSinceTarget(targetHour: number, targetMinute: number, currentHour: number, currentMinute: number) {
  const targetTotal = targetHour * 60 + targetMinute;
  const currentTotal = currentHour * 60 + currentMinute;
  const diff = (currentTotal - targetTotal + 1440) % 1440;
  return diff;
}

function parseFrequencyHours(timeline: string | null | undefined) {
  if (!timeline) return 24;
  const value = timeline.toLowerCase();
  const numericMatch = value.match(/(\d+(?:\.\d+)?)\s*(day|week|month|hour)/);
  if (numericMatch) {
    const quantity = Number.parseFloat(numericMatch[1]);
    const unit = numericMatch[2];
    if (!Number.isNaN(quantity) && quantity > 0) {
      if (unit.startsWith("month")) return quantity * 24 * 30;
      if (unit.startsWith("week")) return quantity * 24 * 7;
      if (unit.startsWith("day")) return quantity * 24;
      if (unit.startsWith("hour")) return Math.max(6, quantity);
    }
  }
  if (value.includes("month")) return 24 * 30;
  if (value.includes("fortnight")) return 24 * 14;
  if (value.includes("biweek")) return 24 * 3.5;
  if (value.includes("twice") && value.includes("week")) return 24 * 3;
  if (value.includes("weekend")) return 24 * 7;
  if (value.includes("week")) return 24 * 7;
  if (value.includes("daily") || value.includes("every day")) return 24;
  if (value.includes("hour")) return 12;
  if (value.includes("morning")) return 24;
  if (value.includes("evening")) return 24;
  return 24;
}

function hoursSince(dateIso: string | null | undefined, now: Date) {
  if (!dateIso) return Infinity;
  const parsed = new Date(dateIso);
  if (Number.isNaN(parsed.getTime())) return Infinity;
  return (now.getTime() - parsed.getTime()) / (1000 * 60 * 60);
}

const ARTICLES_PER_USER = 5;
const ARTICLE_POOL_LIMIT = 80;

type PreparedArticle = ArticleRow & {
  normalizedTags: string[];
  topicSlugs: string[];
  titleLc: string;
  summaryLc: string;
  hookQuestion: string | null;
  matchedInterestToken?: string | null;
  matchedInterestLabel?: string | null;
  createdAtMs: number;
  isFallback?: boolean;
};

function normaliseArticle(row: ArticleRow): PreparedArticle {
  const normalizedTags = Array.isArray(row.tags)
    ? row.tags
        .map((tag) => String(tag ?? "").trim().toLowerCase())
        .filter((tag) => tag.length > 0)
    : [];
  const primary = typeof row.primary_tag === "string" ? row.primary_tag.trim().toLowerCase() : "";
  if (primary && !normalizedTags.includes(primary)) {
    normalizedTags.unshift(primary);
  }
  return {
    ...row,
    normalizedTags,
    topicSlugs: [],
    titleLc: row.title?.toLowerCase?.() ?? "",
    summaryLc: row.summary?.toLowerCase?.() ?? "",
    hookQuestion: row.hook_question ?? null,
    matchedInterestToken: null,
    matchedInterestLabel: null,
    createdAtMs: row.created_at ? Date.parse(row.created_at) : 0,
    isFallback: false,
  };
}

function createFallbackArticle({ token, label }: { token: string; label: string }, data: {
  title: string;
  summary: string;
  url: string;
  hookQuestion?: string;
  tags?: string[];
}): PreparedArticle {
  const normalizedTags = Array.isArray(data.tags)
    ? data.tags.map((tag) => String(tag ?? "").trim().toLowerCase()).filter(Boolean)
    : [];
  const nowIso = new Date().toISOString();
  const titleLc = data.title.toLowerCase();
  const summaryLc = data.summary.toLowerCase();

  return {
    id: `fallback-${token}-${Date.now()}`,
    title: data.title,
    url: data.url,
    summary: data.summary,
    hook_question: data.hookQuestion ?? null,
    tags: normalizedTags,
    primary_tag: token,
    created_at: nowIso,
    normalizedTags,
    topicSlugs: [token],
    titleLc,
    summaryLc,
    hookQuestion: data.hookQuestion ?? null,
    matchedInterestToken: token,
    matchedInterestLabel: label,
    createdAtMs: Date.now(),
    isFallback: true,
  };
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function containsWholeWord(text: string, token: string) {
  if (!text || !token) return false;
  const pattern = new RegExp(`(^|[^a-z0-9])${escapeRegExp(token)}([^a-z0-9]|$)`, "i");
  return pattern.test(text);
}

function articleMatchesToken(article: PreparedArticle, token: string) {
  if (!token) return false;
  const tokenLc = token.toLowerCase();
  if (article.normalizedTags.some((tag) => tag === tokenLc)) {
    return true;
  }
  if (article.topicSlugs?.includes(tokenLc)) return true;

  const isShort = tokenLc.length <= 3;
  if (!isShort) {
    if (article.normalizedTags.some((tag) => tag.includes(tokenLc))) return true;
    if (article.titleLc.includes(tokenLc)) return true;
    if (article.summaryLc.includes(tokenLc)) return true;
    return false;
  }

  if (containsWholeWord(article.titleLc, tokenLc)) return true;
  if (containsWholeWord(article.summaryLc, tokenLc)) return true;
  return false;
}

function expandTokenVariants(
  token: string,
  topicLookup: Map<string, { id: string; slug: string; display_name: string | null }>,
): string[] {
  const base = token.trim().toLowerCase();
  if (!base) return [];

  const variants = new Set<string>();
  variants.add(base);

  const canonical = topicLookup.get(base)?.slug;
  if (canonical) variants.add(canonical.toLowerCase());

  const synonymList = TOKEN_SYNONYMS[base] || TOKEN_SYNONYMS[canonical ?? ""];
  if (Array.isArray(synonymList)) {
    synonymList.forEach((entry) => {
      const value = entry.trim().toLowerCase();
      if (value) variants.add(value);
    });
  }

  if (base.includes("-")) variants.add(base.replace(/-/g, " "));
  if (base.includes("_")) variants.add(base.replace(/_/g, " "));
  if (base.endsWith("s") && base.length > 3) variants.add(base.slice(0, -1));

  return Array.from(variants.values());
}

function normaliseInterestLabel(label: string | null | undefined, fallback: string) {
  const source = (label ?? fallback ?? "").trim();
  if (!source) return "";
  return source
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => {
      if (/^[a-z]{1,3}$/i.test(word)) return word.toUpperCase();
      if (/^[A-Z0-9]{2,}$/.test(word)) return word;
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(" ");
}

function labelInterest(
  canonical: string,
  original: string,
  topicLookup: Map<string, { id: string; slug: string; display_name: string | null }>,
) {
  const canonicalEntry = topicLookup.get(canonical);
  if (canonicalEntry?.display_name) return normaliseInterestLabel(canonicalEntry.display_name, canonical);
  const originalEntry = topicLookup.get(original);
  if (originalEntry?.display_name) return normaliseInterestLabel(originalEntry.display_name, original);
  return normaliseInterestLabel(toDisplayLabel(canonical || original), canonical || original);
}

function cleanHookQuestion(raw: string | null | undefined) {
  if (!raw) return null;
  let question = raw.replace(/^Question:?\s*/i, "").replace(/\s+/g, " ").trim();
  if (!question) return null;
  if (!question.endsWith("?")) question = `${question}?`;
  if (question.length < 8) return null;
  if (question.length > 220) {
    question = `${question.slice(0, 219).trim()}?`;
  }
  return question;
}

type SupabaseWriter = Pick<ReturnType<typeof createClient>, "from">;

let cachedOpenAIClient: OpenAI | null = null;
function getOpenAIClient() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  if (cachedOpenAIClient) return cachedOpenAIClient;
  cachedOpenAIClient = new OpenAI({ apiKey });
  return cachedOpenAIClient;
}

async function ensureHookQuestionForArticle(
  article: PreparedArticle,
  supabase: SupabaseWriter,
  cache: Map<string, string | null>,
) {
  if (article.hookQuestion) return article.hookQuestion;
  if (!article.title && !article.summary) return null;
  if (!article.id || article.id.startsWith("fallback-")) return article.hookQuestion ?? null;

  const cached = cache.get(article.id);
  if (cached !== undefined) {
    if (cached) article.hookQuestion = cached;
    return cached;
  }

  const client = getOpenAIClient();
  if (!client) {
    cache.set(article.id, null);
    return null;
  }

  const prompt =
    "Write one short question (max 25 words) that a reader could answer after reading the article described below.\n" +
    "The question should invite curiosity and use plain language.\n" +
    "Don't include explanations or extra sentences, just the question ending with a question mark.\n\n" +
    `Title: ${article.title || "(none)"}\n` +
    `Summary: ${article.summary || "(none)"}\n` +
    (article.matchedInterestLabel ? `Focus: ${article.matchedInterestLabel}` : "");

  try {
    const response = await client.responses.create({
      model: HOOK_MODEL,
      input: prompt,
      temperature: 0.4,
      max_output_tokens: 120,
    });
    const question = cleanHookQuestion(response.output_text?.trim());
    if (question) {
      article.hookQuestion = question;
      cache.set(article.id, question);
      try {
        await supabase
          .from("articles")
          .update({ hook_question: question } as never)
          .eq("id", article.id);
      } catch (err) {
        if (process.env.NODE_ENV !== "production") {
          console.warn("[warn] Failed to persist hook question", err instanceof Error ? err.message : err);
        }
      }
      return question;
    }
  } catch (err) {
    if (process.env.NODE_ENV !== "production") {
      console.warn("[warn] Hook question generation failed", err instanceof Error ? err.message : err);
    }
  }

  cache.set(article.id, null);
  return null;
}

async function recordInterestGaps(
  admin: ReturnType<typeof createClient>,
  slugs: string[],
  userId: string,
) {
  if (!Array.isArray(slugs) || slugs.length === 0) return;
  const rows = slugs.map((slug) => ({ slug, user_id: userId }));
  const { error } = await admin.from("interest_gap_reports").insert(rows as never[]);
  if (error && process.env.NODE_ENV !== "production") {
    console.warn("[warn] Failed to log interest gaps", error.message);
  }
}

type TokenEntry = {
  token: string;
  canonical: string;
  canonicalLc: string;
  label: string;
  queue: PreparedArticle[];
  index: number;
};

function selectArticlesForPref(
  pref: PrefRow,
  pool: PreparedArticle[],
  topicLookup: Map<string, { id: string; slug: string; display_name: string | null }>,
) {
  const tokens = extractInterestTokens(pref.interests, { maxTokens: 12 });
  const uniqueTokens = Array.from(new Set(tokens));

  const previouslySent = new Set(
    Array.isArray(pref.last_digest_article_ids)
      ? pref.last_digest_article_ids.filter((value): value is string => typeof value === "string" && value.length > 0)
      : [],
  );

  const unseenPool = pool.filter((article) => !previouslySent.has(article.id));
  const poolForSelection = unseenPool.length > 0 ? unseenPool : pool;

  const lastSentMs = pref.last_digest_sent_at ? Date.parse(pref.last_digest_sent_at) : null;
  const freshPool = lastSentMs
    ? poolForSelection.filter((article) => Number.isFinite(article.createdAtMs) && article.createdAtMs > lastSentMs)
    : poolForSelection;

  const candidatePool = freshPool.length > 0 ? freshPool : poolForSelection;

  if (uniqueTokens.length === 0) {
    const slice = candidatePool.slice(0, ARTICLES_PER_USER);
    return {
      articles: slice,
      tokens: uniqueTokens,
      unmatchedTokens: [],
      hasRealArticle: slice.some((article) => !article.isFallback),
    };
  }

  const entries = uniqueTokens.map<TokenEntry>((token) => {
    const canonical = topicLookup.get(token)?.slug ?? token;
    const canonicalLc = canonical.toLowerCase();
    const label = labelInterest(canonical, token, topicLookup);
    const variants = expandTokenVariants(token, topicLookup);
    const queue = candidatePool.filter((article) =>
      variants.some((variant) => articleMatchesToken(article, variant)),
    );
    return { token, canonical, canonicalLc, label, queue, index: 0 };
  });

  const used = new Set<string>();
  const selection: PreparedArticle[] = [];
  const matchedTokens = new Set<string>();
  const fallbackUsage = new Map<string, number>();

  const takeNext = (entry: TokenEntry) => {
    while (entry.index < entry.queue.length) {
      const article = entry.queue[entry.index++];
      if (used.has(article.id)) continue;
      const enriched: PreparedArticle = {
        ...article,
        matchedInterestToken: entry.canonicalLc,
        matchedInterestLabel: entry.label,
        isFallback: article.isFallback ?? false,
      };
      selection.push(enriched);
      used.add(article.id);
      matchedTokens.add(entry.canonicalLc);
      return true;
    }
    return false;
  };

  const insertFallback = (entry: TokenEntry) => {
    const list = FALLBACK_LIBRARY[entry.canonicalLc] ?? [];
    const usage = fallbackUsage.get(entry.canonicalLc) ?? 0;
    const fallback = list[usage];
    if (!fallback) return false;
    fallbackUsage.set(entry.canonicalLc, usage + 1);
    const label = normaliseInterestLabel(fallback.label ?? entry.label, entry.canonicalLc);
    const fallbackArticle = createFallbackArticle({ token: entry.canonicalLc, label }, fallback);
    selection.push(fallbackArticle);
    matchedTokens.add(entry.canonicalLc);
    return true;
  };

  for (const entry of entries) {
    takeNext(entry);
  }

  for (const entry of entries) {
    if (matchedTokens.has(entry.canonicalLc)) continue;
    insertFallback(entry);
  }

  const targetCount = uniqueTokens.length > 1 ? uniqueTokens.length : Math.min(2, Math.max(1, ARTICLES_PER_USER));

  if (uniqueTokens.length === 1) {
    const entry = entries[0];
    while (selection.length < targetCount) {
      if (!takeNext(entry)) {
        if (!insertFallback(entry)) break;
      }
    }
  }

  const unmatchedTokens = entries
    .filter((entry) => !matchedTokens.has(entry.canonicalLc))
    .map((entry) => entry.canonicalLc);

  const hasRealArticle = selection.some((article) => !article.isFallback);

  if (uniqueTokens.length > 1 && selection.length > targetCount) {
    selection.splice(targetCount);
  }

  return {
    articles: selection,
    tokens: uniqueTokens,
    unmatchedTokens,
    hasRealArticle,
  };
}

function toDisplayLabel(token: string) {
  return token
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => {
      if (/^[a-z]{1,3}$/.test(word)) return word.toUpperCase();
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(" ");
}

function formatInterestSummary(tokens: string[], topicLookup: Map<string, { id: string; slug: string; display_name: string | null }>, raw: string | null | undefined) {
  const labels = Array.from(
    new Set(
      tokens
        .map((token) => {
          const entry = topicLookup.get(token);
          if (entry?.display_name) return normaliseInterestLabel(entry.display_name, token);
          return normaliseInterestLabel(toDisplayLabel(token), token);
        })
        .filter((label): label is string => Boolean(label))
    )
  );
  if (labels.length > 0) return labels.join(" · ");
  return (raw || "").trim();
}


function formatHeaderDate(date: Date, timeZone: string) {
  try {
    return new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', timeZone }).format(date);
  } catch {
    return new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric' }).format(date);
  }
}

function formatTimelineSummary(timeline: string | null | undefined) {
  if (!timeline) return "";
  const value = timeline.trim();
  if (!value) return "";
  const lower = value.toLowerCase();
  if (lower.includes("daily")) return "Daily";
  if (lower.includes("bi") && lower.includes("week")) return "Twice Weekly";
  if (lower.includes("weekly")) return "Weekly";
  if (lower.includes("fortnight")) return "Every Two Weeks";
  if (lower.includes("monthly")) return "Monthly";
  if (lower.includes("weekday")) return "Weekdays";
  if (lower.includes("weekend")) return "Weekend";
  if (lower.includes("morning")) return "Morning";
  if (lower.includes("evening")) return "Evening";
  if (lower.includes("hour")) return "Hourly";
  return value;
}

function buildDigestHtml({
  prefs,
  articles,
  manageUrl,
  unsubscribeUrl,
  resubscribeUrl,
  yesNoLinks,
  headerDate,
  interestSummary,
  timelineSummary,
  unmatchedLabels,
}: {
  prefs: { interests?: string | null; timeline?: string | null; unsubscribed?: boolean | null };
  articles: {
    id: string;
    title: string;
    url: string;
    summary?: string | null;
    hookQuestion?: string | null;
    matchedInterestLabel?: string | null;
    isFallback?: boolean;
  }[];
  manageUrl: string;
  unsubscribeUrl: string;
  resubscribeUrl: string;
  yesNoLinks: Record<string, { yes: string; no: string }>;
  headerDate?: string | null;
  interestSummary?: string | null;
  timelineSummary?: string | null;
  unmatchedLabels?: string[];
}) {
  const esc = (value: string | null | undefined) =>
    String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const friendlyDate = headerDate || formatHeaderDate(new Date(), "UTC");

  const itemsHtml = (articles || [])
    .map((article, index) => {
      const links = yesNoLinks[article.id];
      const number = String(index + 1).padStart(2, "0");
      const interestCell = article.matchedInterestLabel
        ? `<td style="padding-right:12px;vertical-align:middle;">
              <span style="display:inline-block;padding:0 10px;height:24px;line-height:24px;border-radius:999px;background:#d1fae5;color:#047857;font-size:12px;font-weight:600;">${esc(article.matchedInterestLabel)}</span>
            </td>`
        : "";
      const titleTable = `
        <table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:8px;">
          <tr>
            ${interestCell}
            <td style="vertical-align:middle;font-size:20px;font-weight:600;line-height:1.4;">
              <a href="${article.url}" style="color:#102a26;text-decoration:none;">${esc(article.title)}</a>
            </td>
          </tr>
        </table>`;
      const hookHtml = article.hookQuestion
        ? `<div style="margin-top:12px;font-size:14px;line-height:1.5;color:#124036;"><strong style=\"color:#0f5132;\">Question to explore:</strong> ${esc(article.hookQuestion)}</div>`
        : "";
      const summaryMargin = article.hookQuestion ? 8 : 12;
      const summaryHtml = article.summary
        ? `<div style=\"margin-top:${summaryMargin}px;font-size:15px;line-height:1.6;color:#374151;\">${esc(article.summary)}</div>`
        : "";
      const feedbackHtml = links
        ? `<span style="display:inline-block;font-size:13px;color:#1f2937;margin-right:12px;">Was this helpful?</span>
                    <a href="${links.yes}" style="display:inline-block;font-size:13px;color:#166534;text-decoration:none;margin-right:12px;white-space:nowrap;">Yes</a>
                    <a href="${links.no}" style="display:inline-block;font-size:13px;color:#166534;text-decoration:none;white-space:nowrap;">No</a>`
        : "";

      return `
        <tr>
          <td style="padding:0 32px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-bottom:1px solid #e2e8f0;">
              <tr>
                <td style="padding:28px 0;">
                  <div style="font-size:12px;letter-spacing:0.2em;text-transform:uppercase;color:#94a3b8;font-weight:600;">${number}</div>
                  ${titleTable}
                  ${hookHtml}${summaryHtml}
                  <div style="margin-top:18px;">
                    <a href="${article.url}" style="display:inline-block;padding:10px 18px;background:#166534;color:#f8fafc;font-size:14px;font-weight:600;text-decoration:none;border-radius:999px;">Read article →</a>
                    <span style="display:inline-block;height:0;width:16px;"></span>
                    ${feedbackHtml}
                  </div>
                </td>
              </tr>
            </table>
          </td>
        </tr>`;
    })
    .join("\n");

  const articleRows =
    itemsHtml ||
    `<tr>
          <td style="padding:40px 32px;color:#4b5563;font-size:15px;line-height:1.6;">
            We didn’t find fresh articles that match your interests today, but we’ll keep looking.
          </td>
        </tr>`;

  const interestValue = interestSummary || prefs?.interests;
  const cadenceValue = timelineSummary || prefs?.timeline;
  const detailBlocks = [
    interestValue ? `<strong style="color:#bbf7d0;">Interests</strong><br/><span style="color:#ecfdf5;opacity:0.9;">${esc(interestValue)}</span>` : "",
    cadenceValue ? `<strong style="color:#bbf7d0;">Cadence</strong><br/><span style="color:#ecfdf5;opacity:0.85;">${esc(cadenceValue)}</span>` : "",
  ].filter(Boolean);
  const detailLines =
    detailBlocks.length > 0
      ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:18px;">
          <tr>
            ${detailBlocks
              .map(
                (block) =>
                  `<td style="padding-right:24px;font-size:14px;line-height:1.5;min-width:160px;">${block}</td>`,
              )
              .join("")}
          </tr>
        </table>`
      : "";

  const unmatchedList = Array.isArray(unmatchedLabels)
    ? unmatchedLabels.filter((label) => typeof label === "string" && label.trim().length > 0)
    : [];
  const unmatchedNote = unmatchedList.length > 0
    ? `<div style="margin-top:16px;font-size:13px;line-height:1.5;color:#1f2937;background:#e8f3ec;padding:10px 14px;border-radius:10px;display:inline-block;">No fresh matches for ${esc(
        unmatchedList.join(" or "),
      )} today — we’ll keep looking.</div>`
    : "";

  const unsubLine = prefs?.unsubscribed
    ? `<div style="margin-top:18px;font-size:13px;color:#fef3c7;background:rgba(10,45,28,0.25);padding:10px 14px;border-radius:10px;display:inline-block;">Currently unsubscribed — resubscribe below to start receiving issues again.</div>`
    : "";

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Your Newsletter</title>
  </head>
  <body style="margin:0;padding:0;background:#eef2ef;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#0f172a;">
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:640px;background:#ffffff;border-radius:18px;border:1px solid #d9e2db;overflow:hidden;box-shadow:0 20px 45px -32px rgba(12,53,36,0.4);">
            <tr>
              <td style="background:linear-gradient(135deg,#0b3d2e,#14532d);padding:36px 32px 32px;color:#f8fafc;">
                <div style="font-size:12px;text-transform:uppercase;letter-spacing:0.28em;font-weight:600;opacity:0.8;">Newsletter AI</div>
                <h1 style="margin:12px 0 0;font-size:28px;line-height:1.2;font-weight:700;color:#f8fafc;">Daily brief for ${esc(friendlyDate)}</h1>
                ${detailLines}
                ${unmatchedNote}
                ${unsubLine}
              </td>
            </tr>
            ${articleRows}
            <tr>
              <td style="padding:28px 32px 36px;background:#f8fafc;border-top:1px solid #e2e8f0;text-align:center;">
                <a href="${manageUrl}" style="display:inline-block;margin:4px 6px;padding:12px 20px;border-radius:999px;background:#14532d;color:#f4fdf7;font-size:14px;font-weight:600;text-decoration:none;">Manage preferences</a>
                <a href="${unsubscribeUrl}" style="display:inline-block;margin:4px 6px;padding:12px 20px;border-radius:999px;background:#d9e2d1;color:#1f2c20;font-size:14px;font-weight:600;text-decoration:none;">Unsubscribe</a>
                <a href="${resubscribeUrl}" style="display:inline-block;margin:4px 6px;padding:12px 20px;border-radius:999px;background:#166534;color:#f8fafc;font-size:14px;font-weight:600;text-decoration:none;">Resubscribe</a>
              </td>
            </tr>
          </table>
          <div style="margin-top:18px;font-size:12px;color:#6b7280;">You received this email because you signed up for Newsletter AI.</div>
        </td>
      </tr>
    </table>
  </body>
 </html>`;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const runSecret = process.env.DIGEST_RUN_SECRET || process.env.CRON_SECRET || "";
  const providedSecret = url.searchParams.get("secret") || "";
  const authHeader = request.headers.get("authorization") || "";
  const bearerToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  const manualMatch = runSecret && (providedSecret === runSecret || bearerToken === runSecret);

  const cronSecret = process.env.VERCEL_CRON_SECRET || runSecret;
  const signature = request.headers.get("x-vercel-signature");
  const cronHeader = request.headers.get("x-vercel-cron");
  const allowUnsigned = process.env.ALLOW_VERCEL_INTERNAL_CRON === "1";
  const vercelId = request.headers.get("x-vercel-id");

  const cronMatch = await (async () => {
    if (!cronSecret) return false;
    if (allowUnsigned && vercelId && !signature) return true;
    if (!signature || !cronHeader) return false;
    const body = await request.clone().text();
    const digest = createHmac("sha256", cronSecret).update(body).digest();

    const signatures = [signature.trim()];
    if (signature.startsWith("sha256=")) signatures.push(signature.slice(7));
    if (signature.startsWith("sha1=")) signatures.push(signature.slice(5));

    for (const candidate of signatures) {
      try {
        const provided = Buffer.from(candidate, "hex");
        if (provided.length === digest.length && timingSafeEqual(provided, digest)) return true;
      } catch {}

      try {
        const provided = Buffer.from(candidate, "base64");
        if (provided.length === digest.length && timingSafeEqual(provided, digest)) return true;
      } catch {}
    }

    return false;
  })();

  const hasValidSecret = manualMatch || cronMatch;
  if (!hasValidSecret) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const windowMinutes = (() => {
    const raw = Number.parseInt(url.searchParams.get("window") || "15", 10);
    if (Number.isNaN(raw)) return 15;
    return Math.min(Math.max(raw, 1), 60);
  })();
  const dryRun = url.searchParams.get("dry") === "1";

  const resendApiKey = process.env.RESEND_API_KEY;
  const fromEnv = process.env.EMAIL_FROM || "Newsletter AI <onboarding@resend.dev>";
  const subject = process.env.EMAIL_SUBJECT || "Your Newsletter";
  const base = process.env.APP_BASE_URL || "http://localhost:3000";
  const signer = process.env.UNSUBSCRIBE_SECRET || process.env.UNSUBSCRIBE_SECRET_ALT || "";
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    return NextResponse.json({ ok: false, error: "Missing Supabase env" }, { status: 500 });
  }
  if (!signer) {
    return NextResponse.json({ ok: false, error: "Missing unsubscribe secret" }, { status: 500 });
  }
  if (!resendApiKey && !dryRun) {
    return NextResponse.json({ ok: false, error: "RESEND_API_KEY not configured" }, { status: 500 });
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: rawPrefs, error: prefsError } = await admin
    .from("user_prefs")
    .select("user_id, interests, timeline, unsubscribed, send_timezone, send_hour, send_minute, last_digest_sent_at, last_digest_article_ids");
  if (prefsError) {
    return NextResponse.json({ ok: false, error: prefsError.message }, { status: 500 });
  }
  const prefs = (rawPrefs ?? []) as PrefRow[];
  const activePrefs = prefs.filter((pref) => !pref.unsubscribed);
  if (activePrefs.length === 0) {
    return NextResponse.json({ ok: true, sent: 0, message: "No active users" });
  }

  const now = new Date();
  const duePrefs = activePrefs.filter((pref) => {
    const timezone = pref.send_timezone || "UTC";
    const targetHour = typeof pref.send_hour === "number" ? pref.send_hour : 9;
    const targetMinute = typeof pref.send_minute === "number" ? pref.send_minute : 0;
    const current = getTimeInTimezone(timezone, now);
    const minutesElapsed = minutesSinceTarget(targetHour, targetMinute, current.hour, current.minute);
    if (minutesElapsed >= windowMinutes) return false;
    const frequencyHours = parseFrequencyHours(pref.timeline);
    const elapsedHours = hoursSince(pref.last_digest_sent_at, now);
    return elapsedHours >= frequencyHours;
  });

  if (duePrefs.length === 0) {
    return NextResponse.json({ ok: true, sent: 0, message: "No users within window" });
  }

  const { data: rawArticles, error: artErr } = await admin
    .from("articles")
    .select("id, title, url, summary, hook_question, tags, primary_tag, created_at")
    .order("created_at", { ascending: false })
    .limit(ARTICLE_POOL_LIMIT);
  if (artErr) {
    return NextResponse.json({ ok: false, error: artErr.message }, { status: 500 });
  }
  const articles = (rawArticles ?? []) as ArticleRow[];
  const preparedArticles = articles.map(normaliseArticle);

  const articleIds = preparedArticles.map((article) => article.id);
  const { data: topicData } = await admin
    .from("article_topics")
    .select("id, slug, display_name");
  const topicRows = (topicData ?? []) as TopicRow[];
  const topicById = new Map<string, { slug: string; display_name: string | null }>();
  const topicLookup = new Map<string, { id: string; slug: string; display_name: string | null }>();
  for (const topic of topicRows) {
    const slug = (topic.slug ?? "").toLowerCase();
    if (!slug) continue;
    const display = topic.display_name ?? null;
    topicById.set(topic.id, { slug, display_name: display });
    topicLookup.set(slug, { id: topic.id, slug, display_name: display });
  }
  if (articleIds.length > 0) {
    const { data: linkRows } = await admin
      .from("article_topic_links")
      .select("article_id, topic_id")
      .in("article_id", articleIds);
    if (Array.isArray(linkRows)) {
      const articleMap = new Map(preparedArticles.map((article) => [article.id, article]));
      for (const link of linkRows) {
        const topic = link?.topic_id ? topicById.get(link.topic_id) : undefined;
        const article = link?.article_id ? articleMap.get(link.article_id) : undefined;
        if (!topic || !article) continue;
        if (!article.topicSlugs.includes(topic.slug)) {
          article.topicSlugs.push(topic.slug);
        }
      }
    }
  }

  const { data: userList } = await admin.auth.admin.listUsers({ page: 1, perPage: 2000 });
  const emailLookup = new Map<string, string>();
  for (const user of userList?.users || []) {
    if (user.id && user.email) {
      emailLookup.set(user.id, user.email);
    }
  }

  const results: Array<{
    userId: string;
    email?: string;
    status: "sent" | "skipped" | "dry";
    error?: string;
    matched?: boolean;
    articleCount?: number;
    tokens?: string[];
  }> = [];

  const hookCache = new Map<string, string | null>();

  for (const pref of duePrefs) {
    const email = emailLookup.get(pref.user_id);
    if (!email) {
      results.push({ userId: pref.user_id, status: "skipped", error: "No email" });
      continue;
    }

    const timezone = pref.send_timezone || "UTC";
    const headerDate = formatHeaderDate(now, timezone);

    const selectionResult = selectArticlesForPref(pref, preparedArticles, topicLookup);
    const { articles: selectedArticles, tokens, unmatchedTokens, hasRealArticle } = selectionResult;
    const interestSummary = formatInterestSummary(tokens, topicLookup, pref.interests);
    const timelineSummary = formatTimelineSummary(pref.timeline);
    const articleCount = selectedArticles.length;

    const unmatchedLabels = unmatchedTokens
      .map((token) => {
        const entry = topicLookup.get(token);
        if (entry?.display_name) return normaliseInterestLabel(entry.display_name, token);
        return normaliseInterestLabel(toDisplayLabel(token), token);
      })
      .filter((label): label is string => Boolean(label));

    await recordInterestGaps(admin, unmatchedTokens, pref.user_id);

    if (articleCount === 0) {
      results.push({ userId: pref.user_id, email, status: "skipped", error: "No matching articles", matched: false, articleCount, tokens });
      continue;
    }

    const matched = hasRealArticle || articleCount > 0;

    const manageToken = signPayload<TokenPayload>({
      user_id: pref.user_id,
      exp: Math.floor(Date.now() / 1000) + 7 * 24 * 3600,
      n: randomBytes(16).toString("base64url"),
    }, signer);

    const makeLink = (path: string, token: string, extra: string = "") =>
      `${base}${path}?token=${encodeURIComponent(token)}${extra}`;

    const unsubscribeToken = signPayload<TokenPayload>({
      user_id: pref.user_id,
      exp: Math.floor(Date.now() / 1000) + 7 * 24 * 3600,
      n: randomBytes(16).toString("base64url"),
    }, signer);
    const resubscribeToken = signPayload<TokenPayload>({
      user_id: pref.user_id,
      exp: Math.floor(Date.now() / 1000) + 7 * 24 * 3600,
      n: randomBytes(16).toString("base64url"),
    }, signer);

    const manageUrl = makeLink("/manage", manageToken);
    const unsubscribeUrl = makeLink("/unsubscribe", unsubscribeToken);
    const resubscribeUrl = makeLink("/unsubscribe", resubscribeToken, "&action=subscribe");

    for (const article of selectedArticles) {
      await ensureHookQuestionForArticle(article, admin, hookCache);
    }

    const yesNoLinks: Record<string, { yes: string; no: string }> = {};
    for (const article of selectedArticles) {
      if (article.isFallback) continue;
      const yesToken = signPayload<TokenPayload>({
        user_id: pref.user_id,
        exp: Math.floor(Date.now() / 1000) + 7 * 24 * 3600,
        n: randomBytes(16).toString("base64url"),
      }, signer);
      const noToken = signPayload<TokenPayload>({
        user_id: pref.user_id,
        exp: Math.floor(Date.now() / 1000) + 7 * 24 * 3600,
        n: randomBytes(16).toString("base64url"),
      }, signer);

      yesNoLinks[article.id] = {
        yes: `${base}/api/survey?token=${encodeURIComponent(yesToken)}&article_id=${encodeURIComponent(article.id)}&q=${encodeURIComponent("Helpful?")}&a=${encodeURIComponent("yes")}&redirect=${encodeURIComponent(base + "/survey/thanks")}`,
        no: `${base}/api/survey?token=${encodeURIComponent(noToken)}&article_id=${encodeURIComponent(article.id)}&q=${encodeURIComponent("Helpful?")}&a=${encodeURIComponent("no")}&redirect=${encodeURIComponent(base + "/survey/thanks")}`,
      };
    }

    if (dryRun) {
      results.push({ userId: pref.user_id, email, status: "dry", matched, articleCount, tokens });
      continue;
    }

    const html = buildDigestHtml({
      prefs: pref,
      articles: selectedArticles,
      manageUrl,
      unsubscribeUrl,
      resubscribeUrl,
      yesNoLinks,
      headerDate,
      interestSummary,
      timelineSummary,
      unmatchedLabels,
    });

    const res = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from: fromEnv, to: email, subject, html }),
    });

    if (!res.ok) {
      const msg = await res.text().catch(() => res.statusText);
      results.push({ userId: pref.user_id, email, status: "skipped", error: msg, matched, articleCount, tokens });
    } else {
      const articleIdsToStore = selectedArticles
        .filter((article) => !article.isFallback)
        .map((article) => article.id);
      const { error: updateErr } = await admin
        .from("user_prefs")
        .update({
          last_digest_sent_at: new Date().toISOString(),
          last_digest_article_ids: articleIdsToStore,
        })
        .eq("user_id", pref.user_id);
      if (updateErr && process.env.NODE_ENV !== "production") {
        console.warn(`Failed to stamp last_digest_sent_at for ${pref.user_id}:`, updateErr.message);
      }
      results.push({ userId: pref.user_id, email, status: "sent", matched, articleCount, tokens });
    }
  }

  const sent = results.filter((r) => r.status === "sent").length;
  const skipped = results.filter((r) => r.status === "skipped");
  const matchedUsers = results.filter((r) => r.matched).length;

  return NextResponse.json({
    ok: true,
    sent,
    dryRun,
    windowMinutes,
    matchedUsers,
    totalDue: duePrefs.length,
    skipped,
  });
}
