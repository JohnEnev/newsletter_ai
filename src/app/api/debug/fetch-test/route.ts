export async function GET() {
    try {
      const res = await fetch("https://hnrss.org/frontpage", {
        headers: { "User-Agent": "newsletter-ai-fetcher" },
      });
      const body = await res.text();
      return Response.json({ status: res.status, length: body.length });
    } catch (error) {
      return Response.json({ error: String(error) }, { status: 500 });
    }
  }