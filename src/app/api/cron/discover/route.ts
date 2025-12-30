import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
import {
  discoverFeedsForSlug,
  loadGapSlugs,
} from '@/lib/server/feedDiscovery-core';

export const maxDuration = 300; // 5 minutes

export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response('Unauthorized', {
      status: 401,
    });
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const openaiApiKey = process.env.OPENAI_API_KEY;
  const discoveryModel = process.env.OPENAI_DISCOVERY_MODEL || process.env.OPENAI_HOOK_MODEL || "gpt-4o-mini";
  const perplexityApiKey = process.env.PERPLEXITY_API_KEY;
  const perplexityModel = process.env.PERPLEXITY_MODEL || "sonar";

  if (!supabaseUrl || !serviceRoleKey) {
    return NextResponse.json({ error: 'Missing Supabase configuration' }, { status: 500 });
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const openai = openaiApiKey ? new OpenAI({ apiKey: openaiApiKey }) : undefined;

  // Logic from discover-feeds.mjs
  // Default to processing gaps if no specific slug is provided via query param?
  // For cron, let's just process gaps or a round-robin of topics.
  // The existing script prioritizes gaps.

  try {
    // Check for "slug" query param if we want to trigger manually
    const { searchParams } = new URL(request.url);
    const slugParam = searchParams.get('slug');
    let targets: string[] = [];

    if (slugParam) {
      targets = [slugParam];
    } else {
      // Load all topics to perform a nightly sweep
      const { data: allTopics } = await admin.from("article_topics").select("slug");
      const allSlugs = (allTopics || []).map((t) => t.slug).filter(Boolean);

      // Shuffle and pick up to 10 to process per run (to avoid Vercel timeouts)
      // This promotes "eventual consistency" where all topics get refreshed over a few days
      // regardless of whether they have "gaps".
      const shuffled = allSlugs.sort(() => 0.5 - Math.random());
      targets = shuffled.slice(0, 10);

      // Note: The prompt inside feedDiscovery-core is now tuned for "Worldwide, No Paywall"
      // and Perplexity is the exclusive provider if configured.

      if (targets.length === 0) {
        // Only if NO topics exist at all, try gaps as a fallback, or just exit
        targets = await loadGapSlugs(admin, { lookbackHours: 168, limit: 5 });
      }
      slug,
        admin,
        openai,
        model: discoveryModel,
          perplexityKey: perplexityApiKey,
            perplexityModel,
            limitPerSlug: 2, // Keep it conservative for cron
      });
    results.push(result);
  }

    return NextResponse.json({ success: true, results });
} catch (error) {
  console.error('Discovery cron failed:', error);
  return NextResponse.json({ error: String(error) }, { status: 500 });
}
}
