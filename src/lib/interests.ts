const SEGMENT_SPLIT = /[\n,;]+/;
const WORD_CHARS = /[a-z0-9]+/gi;
const MAX_PHRASE_WORDS = 4;

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "at",
  "about",
  "around",
  "by",
  "daily",
  "day",
  "each",
  "every",
  "for",
  "from",
  "hour",
  "hours",
  "in",
  "minute",
  "minutes",
  "month",
  "months",
  "news",
  "of",
  "or",
  "per",
  "send",
  "time",
  "timeline",
  "to",
  "week",
  "weekly",
  "with",
  "year",
  "years",
  "am",
  "pm",
  "utc",
  "gmt",
  "europe",
  "america",
  "asia",
]);

function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
}

function sanitiseWord(word: string) {
  return slugify(word).replace(/-/g, "");
}

export function extractInterestTokens(
  interests: string | null | undefined,
  { maxTokens = 20 }: { maxTokens?: number } = {},
): string[] {
  if (!interests) return [];

  const seen = new Set<string>();
  const tokens: string[] = [];

  function addToken(raw: string | null | undefined) {
    const token = slugify(raw ?? "");
    if (!token) return false;
    if (token.length < 2) return false;
    if (!token.includes("-") && STOP_WORDS.has(token)) return false;
    if (/\d/.test(token) && token !== "web3" && !token.includes("-")) return false;
    if (seen.has(token)) return false;
    seen.add(token);
    tokens.push(token);
    return true;
  }

  const segments = interests.split(SEGMENT_SPLIT).map((segment) => segment.trim()).filter(Boolean);
  for (const segment of segments) {
    if (tokens.length >= maxTokens) return tokens;

    const normalised = segment.replace(/\s+/g, " ").trim();
    const wordsInSegment = normalised.split(/\s+/).filter(Boolean);
    const multiWord = wordsInSegment.length > 1 && wordsInSegment.length <= MAX_PHRASE_WORDS;
    const listy = wordsInSegment.length > MAX_PHRASE_WORDS || ((segment.match(/\band\b/gi) || []).length >= 2);

    if (listy) {
      const parts = normalised.split(/\s*(?:,|&|and)\s+/i).map((p) => p.trim()).filter(Boolean);
      for (const part of parts) {
        if (tokens.length >= maxTokens) return tokens;
        const added = addToken(part);
        const subWords = part.toLowerCase().match(WORD_CHARS) || [];
        if (!added) {
          for (const word of subWords) {
            if (tokens.length >= maxTokens) return tokens;
            const slug = sanitiseWord(word);
            if (slug.length >= 2 && !STOP_WORDS.has(slug)) addToken(slug);
          }
        }
      }
      continue;
    }

    const phraseAdded = addToken(normalised);

    const cleaned = segment.toLowerCase();
    const words = cleaned.match(WORD_CHARS) || [];
    for (const word of words) {
      if (tokens.length >= maxTokens) return tokens;
      if (multiWord && phraseAdded) continue;
      const slug = sanitiseWord(word);
      if (slug.length >= 2 && !STOP_WORDS.has(slug)) addToken(slug);
    }
  }

  return tokens.slice(0, maxTokens);
}
