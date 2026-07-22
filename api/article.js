import { applyCors, fetchPublicUrl, rateLimited, readTextLimited, sendHttpError } from "../lib/api-security.js";

export const config = { maxDuration: 30 };

function decodeEntities(text) {
  const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return String(text || "")
    .replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (_, entity) => {
      if (entity[0] === "#") {
        const hex = entity[1].toLowerCase() === "x";
        const value = parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
        return Number.isFinite(value) ? String.fromCodePoint(value) : "";
      }
      return named[entity.toLowerCase()] || "";
    });
}

function extractText(html) {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = decodeEntities((titleMatch && titleMatch[1] || "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
  let body = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|canvas|iframe)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(nav|footer|header|aside)[^>]*>[\s\S]*?<\/\1>/gi, " ");
  const article = body.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
  const main = body.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
  if (article) body = article[1];
  else if (main) body = main[1];
  body = body
    .replace(/<(h[1-6]|p|div|section|article|li|blockquote|br|tr)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  const text = decodeEntities(body)
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { title, text };
}

export default async function handler(req, res) {
  if (!applyCors(req, res, ["GET", "OPTIONS"])) return res.status(403).json({ error: "不允许从这个网站调用" });
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "只支持 GET" });
  if (await rateLimited(req, res, "article", 20, 600)) return;
  const rawUrl = Array.isArray(req.query.url) ? req.query.url[0] : req.query.url;
  if (!rawUrl) return res.status(400).json({ error: "缺少网址" });
  if (String(rawUrl).length > 2000) return res.status(400).json({ error: "网址过长" });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const { response } = await fetchPublicUrl(rawUrl, {
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; arinrin.space article reader)", Accept: "text/html,text/plain;q=0.9" }
    });
    if (!response.ok) return res.status(502).json({ error: "网页返回 " + response.status });
    const type = (response.headers.get("content-type") || "").toLowerCase();
    if (type.includes("application/pdf")) return res.status(415).json({ error: "这个网址指向 PDF，请下载后上传" });
    if (type && !type.includes("text/html") && !type.includes("text/plain") && !type.includes("application/xhtml")) {
      return res.status(415).json({ error: "这个网址不是可读取的文章页面" });
    }
    const extracted = extractText(await readTextLimited(response, 1_500_000));
    if (extracted.text.length < 120) return res.status(422).json({ error: "没有提取到足够正文" });
    const truncated = extracted.text.length > 60000;
    return res.status(200).json({ title: extracted.title, text: extracted.text.slice(0, 60000), truncated });
  } catch (e) {
    return sendHttpError(res, e, "网页读取失败");
  } finally {
    clearTimeout(timer);
  }
}
