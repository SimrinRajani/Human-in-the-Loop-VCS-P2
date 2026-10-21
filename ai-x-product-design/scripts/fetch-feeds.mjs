// Fetches the newest posts from every source in site/data/sources.json
// and writes them to site/data/feed.json.
//
// How a source's feed is found, in order:
//   1. Apple Podcasts id  -> iTunes lookup API -> the podcast's RSS feed
//   2. The feed URLs listed in sources.json
//   3. Autodiscovery: the <link rel="alternate" type="application/rss+xml"> tag on the source's homepage
//
// If a source can't be reached today, its posts from the last run are kept,
// so the site never goes blank because one website is down.

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { XMLParser } from "fast-xml-parser";

const ROOT = new URL("../site/data/", import.meta.url);
const PER_SOURCE = 4;          // newest posts kept per source
const MAX_AGE_DAYS = 120;      // ignore posts older than this
const UA = "ai-x-product-design-guide/1.0 (+https://github.com)";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  htmlEntities: true,
  processEntities: true,
  trimValues: true,
});

/* ---------- small helpers ---------- */

const text = (v) => {
  if (v == null) return "";
  if (typeof v === "string" || typeof v === "number") return String(v);
  if (Array.isArray(v)) return text(v[0]);
  return text(v["#text"] ?? v["@href"] ?? "");
};

const clean = (s) =>
  text(s)
    .replace(/<!\[CDATA\[|\]\]>/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "’")
    .replace(/\s+/g, " ")
    .trim();

const isoDay = (v) => {
  const d = new Date(text(v));
  return isNaN(d) ? null : d.toISOString().slice(0, 10);
};

async function get(url) {
  const res = await fetch(url, {
    headers: { "user-agent": UA, accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, text/html, */*" },
    redirect: "follow",
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/* ---------- feed parsing (RSS 2.0 and Atom) ---------- */

export function parseFeed(xml) {
  const doc = parser.parse(xml);
  const asArray = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);

  if (doc.rss?.channel) {
    return asArray(doc.rss.channel.item).map((it) => ({
      title: clean(it.title),
      url: text(it.link) || text(it.guid),
      date: isoDay(it.pubDate ?? it["dc:date"]),
    }));
  }
  if (doc.feed) {
    return asArray(doc.feed.entry).map((it) => {
      const links = asArray(it.link);
      const alt = links.find((l) => !l["@rel"] || l["@rel"] === "alternate") ?? links[0];
      return {
        title: clean(it.title),
        url: alt?.["@href"] ?? text(alt),
        date: isoDay(it.published ?? it.updated),
      };
    });
  }
  if (doc["rdf:RDF"]) {
    return asArray(doc["rdf:RDF"].item).map((it) => ({
      title: clean(it.title),
      url: text(it.link),
      date: isoDay(it["dc:date"]),
    }));
  }
  throw new Error("not an RSS or Atom feed");
}

export function discoverFeed(html, baseUrl) {
  const tags = html.match(/<link\b[^>]*>/gi) ?? [];
  for (const tag of tags) {
    if (!/rel=["']?alternate/i.test(tag)) continue;
    if (!/type=["']?application\/(rss|atom)\+xml/i.test(tag)) continue;
    const href = tag.match(/href=["']([^"']+)["']/i)?.[1];
    if (href) return new URL(href.replace(/&amp;/g, "&"), baseUrl).href;
  }
  return null;
}

/* ---------- per-source fetching ---------- */

async function candidateFeeds(src) {
  const urls = [];
  if (src.apple) {
    try {
      const data = JSON.parse(await get(`https://itunes.apple.com/lookup?id=${src.apple}`));
      if (data.results?.[0]?.feedUrl) urls.push(data.results[0].feedUrl);
    } catch {}
  }
  urls.push(...(src.feeds ?? []));
  return urls;
}

function relevant(src, item) {
  if (!src.match?.length) return true;
  return src.match.some((word) =>
    new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, word === word.toUpperCase() ? "" : "i").test(item.title)
  );
}

async function fetchSource(src) {
  const tried = new Set();
  const attempt = async (url) => {
    if (!url || tried.has(url)) return null;
    tried.add(url);
    const items = parseFeed(await get(url));
    return { url, items };
  };

  let lastError = "no feed configured";
  for (const url of await candidateFeeds(src)) {
    try { const r = await attempt(url); if (r) return r; } catch (e) { lastError = `${url}: ${e.message}`; }
  }
  if (src.home) {
    try {
      const found = discoverFeed(await get(src.home), src.home);
      const r = await attempt(found);
      if (r) return r;
      lastError = `${src.home}: no feed link found`;
    } catch (e) { lastError = `${src.home}: ${e.message}`; }
  }
  throw new Error(lastError);
}

/* ---------- main ---------- */

async function main() {
  const { sources } = JSON.parse(await readFile(new URL("sources.json", ROOT), "utf8"));
  let previous = { items: [] };
  try { previous = JSON.parse(await readFile(new URL("feed.json", ROOT), "utf8")); } catch {}

  const cutoff = new Date(Date.now() - MAX_AGE_DAYS * 864e5).toISOString().slice(0, 10);
  const items = [];
  const status = {};

  await Promise.all(
    sources.map(async (src) => {
      if (src.social) { status[src.id] = { state: "social" }; return; }
      try {
        const { url, items: raw } = await fetchSource(src);
        const fresh = raw
          .filter((it) => it.title && it.url && it.date && it.date >= cutoff && relevant(src, it))
          .sort((a, b) => b.date.localeCompare(a.date))
          .slice(0, PER_SOURCE)
          .map((it) => ({ src: src.id, date: it.date, title: it.title, url: it.url, kind: src.kind ?? "Post" }));
        if (fresh.length) {
          items.push(...fresh);
          status[src.id] = { state: "ok", feed: url, count: fresh.length };
          return;
        }
        throw new Error("feed had no recent matching posts");
      } catch (e) {
        const kept = previous.items.filter((it) => it.src === src.id);
        items.push(...kept);
        status[src.id] = { state: kept.length ? "kept" : "none", error: e.message, count: kept.length };
      }
    })
  );

  // newest first, de-duplicated by URL
  const seen = new Set();
  const out = items
    .sort((a, b) => b.date.localeCompare(a.date))
    .filter((it) => (seen.has(it.url) ? false : seen.add(it.url)));

  const updated = new Date().toISOString();
  await writeFile(new URL("feed.json", ROOT), JSON.stringify({ updated, items: out, status }, null, 2) + "\n");

  const pad = (s, n) => String(s).padEnd(n);
  console.log(`Feed updated ${updated} — ${out.length} posts\n`);
  for (const src of sources) {
    const st = status[src.id];
    console.log(`${pad(src.name, 22)} ${pad(st.state, 7)} ${st.count ?? ""} ${st.error ? "· " + st.error : ""}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
