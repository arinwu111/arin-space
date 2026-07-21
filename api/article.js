import { lookup } from "node:dns/promises";
import net from "node:net";

export const config = { maxDuration: 30 };

function privateAddress(address) {
  if (!address) return true;
  if (net.isIPv4(address)) {
    const parts = address.split(".").map(Number);
    return parts[0] === 10 || parts[0] === 127 || parts[0] === 0 ||
      (parts[0] === 169 && parts[1] === 254) ||
      (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
      (parts[0] === 192 && parts[1] === 168) ||
      (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) ||
      parts[0] >= 224;
  }
  const normalized = address.toLowerCase().split("%")[0];
  return normalized === "::" || normalized === "::1" || normalized.startsWith("fc") ||
    normalized.startsWith("fd") || normalized.startsWith("fe8") || normalized.startsWith("fe9") ||
    normalized.startsWith("fea") || normalized.startsWith("feb") || normalized.startsWith("::ffff:127.") ||
    normalized.startsWith("::ffff:10.") || normalized.startsWith("::ffff:192.168.");
}

async function assertPublicUrl(input) {
  let url;
  try { url = new URL(input); } catch (e) { throw new Error("网址格式不正确"); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("只支持 http 或 https 网页");
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) throw new Error("不能读取本机或内网页面");
  if (net.isIP(host)) {
    if (privateAddress(host)) throw new Error("不能读取本机或内网页面");
  } else {
    const addresses = await lookup(host, { all: true, verbatim: true });
    if (!addresses.length || addresses.some(item => privateAddress(item.address))) throw new Error("不能读取本机或内网页面");
  }
  return url;
}

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
  if (req.method !== "GET") return res.status(405).json({ error: "只支持 GET" });
  const rawUrl = Array.isArray(req.query.url) ? req.query.url[0] : req.query.url;
  if (!rawUrl) return res.status(400).json({ error: "缺少网址" });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    let current = await assertPublicUrl(rawUrl);
    let response;
    for (let redirects = 0; redirects < 5; redirects++) {
      response = await fetch(current, {
        redirect: "manual",
        signal: controller.signal,
        headers: { "User-Agent": "Mozilla/5.0 (compatible; arinrin.space article reader)", Accept: "text/html,text/plain;q=0.9" }
      });
      if (response.status < 300 || response.status >= 400) break;
      const location = response.headers.get("location");
      if (!location) break;
      current = await assertPublicUrl(new URL(location, current).href);
    }
    if (!response || !response.ok) throw new Error("网页返回 " + (response ? response.status : "错误"));
    const type = (response.headers.get("content-type") || "").toLowerCase();
    if (type.includes("application/pdf")) return res.status(415).json({ error: "这个网址指向 PDF，请下载后上传" });
    if (type && !type.includes("text/html") && !type.includes("text/plain") && !type.includes("application/xhtml")) {
      return res.status(415).json({ error: "这个网址不是可读取的文章页面" });
    }
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > 1_500_000) return res.status(413).json({ error: "网页内容过大，请粘贴正文" });
    const extracted = extractText(new TextDecoder().decode(buffer));
    if (extracted.text.length < 120) return res.status(422).json({ error: "没有提取到足够正文" });
    const truncated = extracted.text.length > 60000;
    return res.status(200).json({ title: extracted.title, text: extracted.text.slice(0, 60000), truncated });
  } catch (e) {
    const message = e && e.name === "AbortError" ? "网页读取超时" : (e.message || "网页读取失败");
    return res.status(400).json({ error: message });
  } finally {
    clearTimeout(timer);
  }
}
