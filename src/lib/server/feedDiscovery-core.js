import { XMLParser } from "fast-xml-parser";

const parser = new XMLParser({
  ignoreAttributes: false,
  trimValues: true,
});

function summariseFeed(xml) {
  try {
    const doc = parser.parse(xml);
    if (doc?.rss?.channel) {
      const channel = Array.isArray(doc.rss.channel) ? doc.rss.channel[0] : doc.rss.channel;
      const items = channel?.item;
      return Array.isArray(items) ? items.length : items ? 1 : 0;
    }
    if (doc?.feed) {
      const feed = Array.isArray(doc.feed) ? doc.feed[0] : doc.feed;
      const entries = feed?.entry;
      return Array.isArray(entries) ? entries.length : entries ? 1 : 0;
    }
    return 0;
  } catch {
    return 0;
  }
}

export async function validateFeed(url, fetchImpl = fetch) {
  if (!fetchImpl) throw new Error("fetch not available in this runtime");
  try {
    const res = await fetchImpl(url, { headers: { "User-Agent": "newsletter-ai-feed-discovery" } });
    if (!res.ok) {
      return { ok: false, reason: `HTTP ${res.status}` };
    }
    const xml = await res.text();
    const entries = summariseFeed(xml);
    if (entries < 3) {
      return { ok: false, reason: "Too few entries" };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

function parseJsonFromResponse(text) {
  if (!text) return null;
  const match = text.match(/```json\s*([\s\S]*?)```/i);
  const candidate = match ? match[1] : text;
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

export async function askForFeeds(slug, openai, model) {
  if (!openai) return [];
  const prompt =
    `Suggest up to 3 high-quality RSS or Atom feeds focused on ${slug}. ` +
    `Respond ONLY with a JSON array where each item has feed_url, source, and reason fields.`;
  const response = await openai.responses.create({
    model,
    input: prompt,
    temperature: 0,
    max_output_tokens: 400,
  });
  const raw = response.output_text?.trim();
  const parsed = parseJsonFromResponse(raw || "");
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map((entry) => ({
      feed_url: entry.feed_url || entry.url,
      source: entry.source || entry.title || "unknown",
      reason: entry.reason || entry.summary || "",
    }))
    .filter((entry) => typeof entry.feed_url === "string" && entry.feed_url.startsWith("http"));
}

export async function ensureTopic(admin, slug, displayName) {
  const label = displayName || toDisplayLabel(slug);
  const { data, error } = await admin
    .from("article_topics")
    .upsert({ slug, display_name: label }, { onConflict: "slug" })
    .select("id, slug")
    .single();
  if (error) throw new Error(error.message);
  return data?.id;
}

export async function insertFeed(admin, topicId, slug, feed, dryRun) {
  if (dryRun) return { inserted: true, dryRun: true };
  const { error } = await admin
    .from("article_topic_feeds")
    .insert({
      topic_id: topicId,
      feed_url: feed.feed_url,
      status: "pending",
      metadata: { auto_discovered: true, source: feed.source, note: feed.reason },
    });
  if (error) {
    if (error.code === "23505") {
      return { inserted: false, duplicate: true };
    }
    throw new Error(error.message);
  }
  return { inserted: true };
}

export function aggregateGaps(rows) {
  const map = new Map();
  for (const row of rows || []) {
    const slug = (row.slug || "").trim().toLowerCase();
    if (!slug) continue;
    const current = map.get(slug) || { slug, count: 0, last: 0 };
    current.count += 1;
    const ts = row.reported_at ? Date.parse(row.reported_at) : Date.now();
    if (ts > current.last) current.last = ts;
    map.set(slug, current);
  }
  return Array.from(map.values())
    .sort((a, b) => b.count - a.count || b.last - a.last)
    .map((entry) => entry.slug);
}

export async function loadGapSlugs(admin, { lookbackHours = 168, limit = 5 } = {}) {
  const since = new Date(Date.now() - lookbackHours * 3600 * 1000).toISOString();
  const { data, error } = await admin
    .from("interest_gap_reports")
    .select("slug, reported_at")
    .gte("reported_at", since)
    .limit(1000);
  if (error) throw new Error(error.message);
  return aggregateGaps(data).slice(0, limit);
}

export function toSlug(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function toDisplayLabel(slug) {
  return slug
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

export async function discoverFeedsForSlug({
  slug,
  admin,
  openai,
  model,
  limitPerSlug = 2,
  dryRun = false,
  fetchImpl = fetch,
  clearGapOnSuccess = true,
}) {
  const normalized = toSlug(slug);
  if (!normalized) {
    return { slug: slug || "", added: [], skipped: [], errors: ["Invalid slug"], requested: 0 };
  }

  const result = {
    slug: normalized,
    requested: 0,
    added: [],
    skipped: [],
    errors: [],
  };

  let topicId;
  try {
    topicId = await ensureTopic(admin, normalized);
  } catch (err) {
    result.errors.push(err instanceof Error ? err.message : String(err));
    return result;
  }
  if (!topicId) {
    result.errors.push("Unable to create topic");
    return result;
  }

  let feeds = [];
  try {
    feeds = await askForFeeds(normalized, openai, model);
  } catch (err) {
    result.errors.push(err instanceof Error ? err.message : String(err));
    return result;
  }

  result.requested = feeds.length;
  if (feeds.length === 0) {
    return result;
  }

  let addedCount = 0;
  for (const candidate of feeds) {
    if (addedCount >= limitPerSlug) break;
    const url = String(candidate.feed_url || "").trim();
    if (!url) {
      result.skipped.push({ url: candidate.feed_url || "", reason: "Empty URL" });
      continue;
    }
    try {
      new URL(url);
    } catch {
      result.skipped.push({ url, reason: "Invalid URL" });
      continue;
    }

    const validation = await validateFeed(url, fetchImpl);
    if (!validation.ok) {
      result.skipped.push({ url, reason: validation.reason || "Invalid feed" });
      continue;
    }

    try {
      const inserted = await insertFeed(admin, topicId, normalized, candidate, dryRun);
      if (inserted.inserted) {
        addedCount += 1;
        result.added.push(url);
      } else if (inserted.duplicate) {
        result.skipped.push({ url, reason: "Already exists" });
      }
    } catch (err) {
      result.skipped.push({ url, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  if (addedCount > 0 && clearGapOnSuccess && !dryRun) {
    await admin.from("interest_gap_reports").delete().eq("slug", normalized);
  }

  return result;
}
