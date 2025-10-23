const SEGMENT_SPLIT = /[\n,;]+/;
const WORD_CHARS = /[a-z0-9]+/gi;

function sanitiseWord(word: string) {
  return word.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export function extractInterestTokens(
  interests: string | null | undefined,
  { maxTokens = 20 }: { maxTokens?: number } = {},
): string[] {
  if (!interests) return [];

  const seen = new Set<string>();
  const tokens: string[] = [];

  function addToken(raw: string | null | undefined) {
    const token = (raw ?? "").trim().toLowerCase();
    if (!token) return;
    if (token.length < 2) return;
    if (token.includes(" ")) return;
    if (seen.has(token)) return;
    seen.add(token);
    tokens.push(token);
  }

  const segments = interests.split(SEGMENT_SPLIT).map((segment) => segment.trim()).filter(Boolean);
  for (const segment of segments) {
    addToken(segment.replace(/\s+/g, " "));

    const cleaned = segment.toLowerCase();
    const words = cleaned.match(WORD_CHARS) || [];
    for (const word of words) {
      const slug = sanitiseWord(word);
      if (slug.length >= 2) addToken(slug);
      if (tokens.length >= maxTokens) return tokens;
    }

    if (tokens.length >= maxTokens) return tokens;
  }

  return tokens.slice(0, maxTokens);
}
