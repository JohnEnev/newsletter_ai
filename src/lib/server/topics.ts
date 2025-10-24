import OpenAI from "openai";
import type { SupabaseClient } from "@supabase/supabase-js";

import { extractInterestTokens } from "@/lib/interests";

type TopicSuggestion = {
  slug: string;
  display_name: string;
  weight?: number;
};

const OPENAI_MODEL = process.env.OPENAI_TOPIC_MODEL || "gpt-4o-mini";

function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function titleize(value: string) {
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function safeParseTopics(raw: string | null | undefined): TopicSuggestion[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed
        .map((item) => {
          if (!item) return null;
          if (typeof item.slug !== "string" && typeof item.display_name !== "string") return null;
          const display = typeof item.display_name === "string" ? item.display_name.trim() : "";
          const base = display || String(item.slug ?? "");
          const slug = slugify(base);
          if (!slug) return null;
          return {
            slug,
            display_name: display || titleize(slug),
            weight: typeof item.weight === "number" ? item.weight : undefined,
          } satisfies TopicSuggestion;
        })
        .filter((item): item is TopicSuggestion => Boolean(item));
    }

    if (parsed && typeof parsed === "object" && Array.isArray(parsed.topics)) {
      return safeParseTopics(JSON.stringify(parsed.topics));
    }
  } catch {}
  return [];
}

async function callOpenAIForTopics({
  interests,
  timeline,
  fallbackTokens,
}: {
  interests: string;
  timeline?: string;
  fallbackTokens: string[];
}): Promise<TopicSuggestion[]> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return [];

  try {
    const client = new OpenAI({ apiKey });
    const prompt = `Extract up to 5 distinct topics relevant to the following user interests. Respond ONLY with a JSON array of objects {"slug": string, "display_name": string}. Avoid duplicates.\n\nInterests: ${interests || "(none)"}\nTimeline: ${timeline || "(none)"}\nFallback tokens: ${fallbackTokens.join(", ") || "(none)"}`;

    const response = await client.responses.create({
      model: OPENAI_MODEL,
      input: prompt,
      temperature: 0.2,
      max_output_tokens: 400,
    });

    const text = response.output_text?.trim();
    const suggestions = safeParseTopics(text);
    return suggestions;
  } catch (error) {
    if (process.env.NODE_ENV !== "production") {
      console.warn("[topics] OpenAI error", error instanceof Error ? error.message : error);
    }
    return [];
  }
}

export async function syncUserTopics({
  supabase,
  userId,
  interests,
  timeline,
}: {
  supabase: SupabaseClient;
  userId: string;
  interests: string;
  timeline?: string;
}) {
  if (!userId) return;
  const rawTokens = extractInterestTokens(interests, { maxTokens: 8 });

  const suggestions = await callOpenAIForTopics({
    interests,
    timeline,
    fallbackTokens: rawTokens,
  });

  const fallbackTopics: TopicSuggestion[] = rawTokens.map((token) => ({
    slug: slugify(token),
    display_name: titleize(token),
  }));

  const merged = new Map<string, TopicSuggestion>();
  [...suggestions, ...fallbackTopics]
    .filter((item) => item.slug)
    .forEach((item) => {
      if (!merged.has(item.slug)) {
        merged.set(item.slug, {
          slug: item.slug,
          display_name: item.display_name || titleize(item.slug),
          weight: item.weight,
        });
      }
    });

  const topics = Array.from(merged.values()).slice(0, 8);
  if (topics.length === 0) {
    await supabase.from("user_interest_topics").delete().eq("user_id", userId);
    return;
  }

  const upsertPayload = topics.map((topic) => ({
    slug: topic.slug,
    display_name: topic.display_name || titleize(topic.slug),
  }));
  const { data: topicRows, error: topicErr } = await supabase
    .from("article_topics")
    .upsert(upsertPayload, { onConflict: "slug" })
    .select("id, slug");
  if (topicErr) {
    if (process.env.NODE_ENV !== "production") {
      console.warn("[topics] Failed to upsert article_topics", topicErr.message);
    }
    return;
  }

  const topicMap = new Map(topicRows?.map((row) => [row.slug, row.id]));
  const linkValues = topics
    .map((topic, index) => {
      const id = topicMap.get(topic.slug);
      if (!id) return null;
      return {
        user_id: userId,
        topic_id: id,
        weight: topic.weight ?? Math.max(0.5, 1 - index * 0.1),
        source: suggestions.find((s) => s.slug === topic.slug) ? "llm" : "keyword",
        inferred: !suggestions.find((s) => s.slug === topic.slug),
      };
    })
    .filter(Boolean) as Array<{
      user_id: string;
      topic_id: string;
      weight: number;
      source: string;
      inferred: boolean;
    }>;

  await supabase.from("user_interest_topics").delete().eq("user_id", userId);
  if (linkValues.length > 0) {
    const { error: insertErr } = await supabase
      .from("user_interest_topics")
      .insert(linkValues);
    if (insertErr && process.env.NODE_ENV !== "production") {
      console.warn("[topics] Failed to insert user_interest_topics", insertErr.message);
    }
  }
}
