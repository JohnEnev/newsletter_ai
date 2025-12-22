import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { XMLParser } from "fast-xml-parser";

// Simplified mimic of the app's fetch logic to test connectivity and parsing
const DEFAULT_FEEDS = [
    "https://hnrss.org/frontpage",
    "https://www.theverge.com/rss/index.xml",
    "https://www.wired.com/feed/rss",
    "https://www.techmeme.com/feed.xml",
    "https://feeds.arstechnica.com/arstechnica/technology-lab",
    "https://feeds.bbci.co.uk/news/world/rss.xml", // Geography/World?
    "https://www.aljazeera.com/xml/rss/all.xml",
    "https://www.smithsonianmag.com/rss/history/", // History
    "https://www.sciencedaily.com/rss/plants_animals/biology.xml",  // Biology
];

const TOPICS_TO_CHECK = {
    biology: ["https://www.sciencedaily.com/rss/plants_animals/biology.xml"],
    history: ["https://www.smithsonianmag.com/rss/history/"],
    geopolitics: ["https://feeds.bbci.co.uk/news/world/rss.xml", "https://www.aljazeera.com/xml/rss/all.xml"]
};

const xmlParser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "",
    trimValues: true,
    cdataTagName: "__cdata",
    processEntities: true,
});

async function checkFeed(url) {
    console.log(`\nChecking: ${url}`);
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);

        const start = Date.now();
        const res = await fetch(url, {
            headers: {
                "User-Agent": "newsletter-ai-fetcher/1.0 (diagnose-script)",
                "Accept": "application/rss+xml, application/xml, text/xml, */*"
            },
            signal: controller.signal
        });
        clearTimeout(timeout);
        const duration = Date.now() - start;

        console.log(`  Status: ${res.status} ${res.statusText}`);
        console.log(`  Duration: ${duration}ms`);

        if (!res.ok) {
            console.error(`  FAIL: HTTP Error`);
            return false;
        }

        const text = await res.text();
        console.log(`  Length: ${text.length} bytes`);

        if (text.length < 100) {
            console.error(`  FAIL: Response too short`);
            return false;
        }

        let doc;
        try {
            doc = xmlParser.parse(text);
        } catch (e) {
            console.error(`  FAIL: XML Parse Error: ${e.message}`);
            return false;
        }

        const items = getItems(doc);
        console.log(`  Found ${items.length} items`);

        if (items.length === 0) {
            console.warn(`  WARN: No items found (structure might be unexpected)`);
            console.log(`  Preview: ${text.slice(0, 200).replace(/\n/g, ' ')}`);
            return false;
        }

        // Check if items have titles and links
        const validItems = items.filter(item => {
            const title = item.title;
            const link = item.link;
            return title && link;
        });

        console.log(`  Valid items (title+link): ${validItems.length}`);

        if (validItems.length === 0) {
            console.error(`  FAIL: Items found but missing title or link`);
            return false;
        }

        console.log(`  PASS`);
        return true;

    } catch (error) {
        console.error(`  FAIL: Exception: ${error.message}`);
        if (error.cause) console.error(`  Cause: ${error.cause}`);
        return false;
    }
}

function getItems(doc) {
    let entries = [];
    if (doc?.rss?.channel?.item) {
        entries = doc.rss.channel.item;
    } else if (doc?.feed?.entry) {
        entries = doc.feed.entry;
    }
    return Array.isArray(entries) ? entries : (entries ? [entries] : []);
}

async function main() {
    console.log("=== Starting Feed Diagnosis ===");

    let failureCount = 0;

    for (const [topic, urls] of Object.entries(TOPICS_TO_CHECK)) {
        console.log(`\n\n--- Topic: ${topic} ---`);
        for (const url of urls) {
            const success = await checkFeed(url);
            if (!success) failureCount++;
        }
    }

    console.log(`\n\n=== Diagnosis Complete ===`);
    if (failureCount > 0) {
        console.error(`Found ${failureCount} failing feeds.`);
        process.exit(1);
    } else {
        console.log("All checked feeds passed.");
    }
}

main();
