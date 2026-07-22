import { lookup } from "node:dns/promises";
import net from "node:net";

const DEFAULT_ORIGINS = new Set([
  "https://www.arinrin.space",
  "https://arinrin.space",
]);

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function allowedOrigin(origin) {
  if (!origin) return true;
  if (DEFAULT_ORIGINS.has(origin)) return true;
  if (process.env.PUBLIC_SITE_ORIGIN && origin === process.env.PUBLIC_SITE_ORIGIN.replace(/\/$/, "")) return true;
  if (/^https:\/\/arin-space(?:-[a-z0-9-]+)?\.vercel\.app$/i.test(origin)) return true;
  return /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/i.test(origin);
}

export function applyCors(req, res, methods) {
  const origin = String(req.headers.origin || "");
  res.setHeader("Vary", "Origin");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Access-Control-Allow-Methods", methods.join(", "));
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (!allowedOrigin(origin)) return false;
  if (origin) res.setHeader("Access-Control-Allow-Origin", origin);
  return true;
}

function redisConfig() {
  return {
    url: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN,
  };
}

async function redis(command) {
  const { url, token } = redisConfig();
  if (!url || !token) return null;
  const response = await fetch(url, {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify(command),
  });
  if (!response.ok) throw new Error("rate limit storage unavailable");
  const data = await response.json();
  if (data.error) throw new Error(data.error);
  return data.result;
}

export async function rateLimited(req, res, bucket, limit, windowSec) {
  if (!redisConfig().url || !redisConfig().token) return false;
  try {
    const forwarded = String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "unknown");
    const ip = forwarded.split(",")[0].trim().slice(0, 80);
    const key = `rl:${bucket}:${ip}`;
    const count = Number(await redis(["INCR", key]));
    if (count === 1) await redis(["EXPIRE", key, windowSec]);
    if (count <= limit) return false;
    res.setHeader("Retry-After", String(windowSec));
    res.setHeader("Cache-Control", "no-store");
    res.status(429).json({ error: "请求有点频繁，请稍后再试。" });
    return true;
  } catch (_) {
    return false;
  }
}

function privateAddress(address) {
  if (!address) return true;
  if (net.isIPv4(address)) {
    const p = address.split(".").map(Number);
    return p[0] === 0 || p[0] === 10 || p[0] === 127 ||
      (p[0] === 100 && p[1] >= 64 && p[1] <= 127) ||
      (p[0] === 169 && p[1] === 254) ||
      (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
      (p[0] === 192 && p[1] === 168) ||
      (p[0] === 198 && p[1] >= 18 && p[1] <= 19) ||
      p[0] >= 224;
  }
  const value = address.toLowerCase().split("%")[0];
  if (value.startsWith("::ffff:")) return privateAddress(value.slice(7));
  return value === "::" || value === "::1" || value.startsWith("fc") ||
    value.startsWith("fd") || value.startsWith("fe8") || value.startsWith("fe9") ||
    value.startsWith("fea") || value.startsWith("feb") || value.startsWith("ff");
}

export async function assertPublicHttpUrl(input) {
  let url;
  try { url = new URL(input); } catch (_) { throw new HttpError(400, "网址格式不正确"); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new HttpError(400, "只支持 http 或 https 地址");
  if (url.username || url.password) throw new HttpError(400, "网址不能包含账号或密码");
  if (url.port && url.port !== "80" && url.port !== "443") throw new HttpError(400, "网址端口不受支持");
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") ||
      host.endsWith(".internal") || host.endsWith(".home") || host.endsWith(".lan") ||
      host === "metadata.google.internal") {
    throw new HttpError(400, "不能读取本机或内网页面");
  }
  if (net.isIP(host)) {
    if (privateAddress(host)) throw new HttpError(400, "不能读取本机或内网页面");
  } else {
    let addresses;
    try { addresses = await lookup(host, { all: true, verbatim: true }); }
    catch (_) { throw new HttpError(400, "网址无法解析"); }
    if (!addresses.length || addresses.some(item => privateAddress(item.address))) {
      throw new HttpError(400, "不能读取本机或内网页面");
    }
  }
  return url;
}

export async function fetchPublicUrl(input, options = {}) {
  let current = await assertPublicHttpUrl(input);
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    const response = await fetch(current, { ...options, redirect: "manual" });
    if (response.status < 300 || response.status >= 400) return { response, url: current };
    if (redirects === 5) throw new HttpError(400, "网址跳转次数过多");
    const location = response.headers.get("location");
    if (!location) throw new HttpError(400, "网址跳转无效");
    current = await assertPublicHttpUrl(new URL(location, current).href);
  }
  throw new HttpError(400, "网址跳转无效");
}

export async function readTextLimited(response, maxBytes) {
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > maxBytes) throw new HttpError(413, "远程内容过大");
  if (!response.body || typeof response.body.getReader !== "function") {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > maxBytes) throw new HttpError(413, "远程内容过大");
    return new TextDecoder().decode(buffer);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new HttpError(413, "远程内容过大");
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    if (total > maxBytes) await reader.cancel().catch(() => {});
  }
}

export function sendHttpError(res, error, fallback) {
  const status = Number(error && error.status) || (error && error.name === "AbortError" ? 504 : 502);
  return res.status(status).json({ error: error && error.message ? error.message : fallback });
}
