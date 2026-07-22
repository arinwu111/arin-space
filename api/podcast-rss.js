import { applyCors, fetchPublicUrl, rateLimited, readTextLimited, sendHttpError } from "../lib/api-security.js";

export const config = { maxDuration: 30 };

const APPLE_HOST = "podcasts.apple.com";
const XIAOYUZHOU_HOSTS = new Set(["www.xiaoyuzhoufm.com", "xiaoyuzhoufm.com"]);

function text(value, max = 240) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function decodeHtml(value) {
  const named = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " " };
  return String(value || "").replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi, (_, entity) => {
    if (entity[0] === "#") {
      const hex = entity[1].toLowerCase() === "x";
      const code = parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : "";
    }
    return named[entity.toLowerCase()] || "";
  });
}

async function appleJson(url) {
  const response = await fetch(url, { headers: { Accept: "application/json", "User-Agent": "arinrin-space/1.0" } });
  if (!response.ok) throw new Error("苹果播客查询暂时不可用");
  return response.json();
}

function podcastResult(item) {
  return {
    podcast: text(item.collectionName),
    author: text(item.artistName),
    rss: text(item.feedUrl, 2000),
    artwork: text(item.artworkUrl600 || item.artworkUrl100, 2000),
  };
}

async function resolveApple(url) {
  const podcastId = (url.pathname.match(/\/id(\d+)/i) || [])[1];
  const episodeId = url.searchParams.get("i") || "";
  if (!podcastId) throw new Error("没有从苹果播客链接中找到节目 ID");
  const info = await appleJson(`https://itunes.apple.com/lookup?id=${encodeURIComponent(podcastId)}&entity=podcast`);
  const podcast = (info.results || []).find(item => item.feedUrl) || (info.results || [])[0];
  if (!podcast || !podcast.feedUrl) throw new Error("这个节目没有公开 RSS 地址");
  let episode = null;
  if (episodeId) {
    const episodes = await appleJson(`https://itunes.apple.com/lookup?id=${encodeURIComponent(podcastId)}&entity=podcastEpisode&limit=200`);
    episode = (episodes.results || []).find(item => String(item.trackId || "") === episodeId) || null;
  }
  return {
    source: "apple",
    exact: true,
    ...podcastResult(podcast),
    episode: episode ? text(episode.trackName) : "",
    publishedAt: episode ? text(episode.releaseDate, 40) : "",
    durationMs: episode ? Number(episode.trackTimeMillis || 0) : 0,
  };
}

function metaContent(html, property) {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const a = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']*)["']`, "i"));
  const b = html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${escaped}["']`, "i"));
  return decodeHtml((a || b || [])[1] || "");
}

function isoDurationMs(value) {
  const match = String(value || "").match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/i);
  if (!match) return 0;
  return Math.round((Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 + Number(match[3] || 0)) * 1000);
}

export function xiaoyuzhouEpisode(html) {
  const scripts = Array.from(String(html || "").matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi));
  let schema = null;
  for (const match of scripts) {
    try {
      let parsed;
      try { parsed = JSON.parse(match[1].trim()); }
      catch (_) { parsed = JSON.parse(decodeHtml(match[1]).trim()); }
      const candidates = Array.isArray(parsed) ? parsed : [parsed];
      schema = candidates.find(item => item && item["@type"] === "PodcastEpisode") || schema;
    } catch (_) {}
  }
  const episode = text((schema && schema.name) || metaContent(html, "og:title"));
  const podcast = text(schema && schema.partOfSeries && schema.partOfSeries.name);
  const audioUrl = text(
    (schema && schema.associatedMedia && (schema.associatedMedia.contentUrl || schema.associatedMedia.url)) ||
    metaContent(html, "og:audio"),
    2000
  );
  if (!episode || !podcast) throw new Error("没有从小宇宙页面识别出准确的节目与单集");
  if (!audioUrl) throw new Error("这期小宇宙单集没有公开音频，可以改用苹果播客链接");
  return {
    source: "xiaoyuzhou",
    exact: true,
    podcast,
    episode,
    audioUrl,
    publishedAt: text(schema && schema.datePublished, 40),
    durationMs: isoDurationMs(schema && schema.timeRequired),
  };
}

async function resolveXiaoyuzhou(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const { response } = await fetchPublicUrl(url.href, {
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; arinrin.space podcast resolver)", Accept: "text/html" },
    });
    if (!response.ok) throw new Error("小宇宙页面暂时无法读取");
    return xiaoyuzhouEpisode(await readTextLimited(response, 1_500_000));
  } finally {
    clearTimeout(timer);
  }
}

export default async function handler(req, res) {
  if (!applyCors(req, res, ["GET", "OPTIONS"])) return res.status(403).json({ error: "不允许从这个网站调用" });
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "只支持 GET" });
  if (await rateLimited(req, res, "podcast-rss", 15, 600)) return;
  const raw = Array.isArray(req.query.url) ? req.query.url[0] : req.query.url;
  if (!raw || String(raw).length > 2000) return res.status(400).json({ error: "请粘贴完整的苹果播客或小宇宙单集链接" });
  let url;
  try { url = new URL(String(raw)); } catch (_) { return res.status(400).json({ error: "链接格式不正确" }); }
  try {
    let result;
    if (url.hostname.toLowerCase() === APPLE_HOST) result = await resolveApple(url);
    else if (XIAOYUZHOU_HOSTS.has(url.hostname.toLowerCase())) result = await resolveXiaoyuzhou(url);
    else return res.status(400).json({ error: "目前只支持苹果播客和小宇宙单集链接" });
    res.setHeader("Cache-Control", "s-maxage=86400, stale-while-revalidate=604800");
    return res.status(200).json(result);
  } catch (error) {
    return sendHttpError(res, error, "RSS 解析失败");
  }
}
