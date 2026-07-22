// Vercel Serverless Function —— Unsplash 随机背景图
// 放到 api 文件夹,命名为 unsplash.js,即 /api/unsplash
//
// 环境变量(任填其一,兼容你原来用的名字):
//   UNSPLASH_ACCESS_KEY / UNSPLASH_KEY / UNSPLASH_CLIENT_ID
//
// 返回:{ url, author, authorLink, unsplashLink }
//   unsplashLink = 这张照片自己的页面(不是 unsplash.com 首页)

import { applyCors, rateLimited } from "../lib/api-security.js";

const APP_NAME = "arinrin_space";
const UTM = `utm_source=${APP_NAME}&utm_medium=referral`;

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  if (!applyCors(req, res, ["GET", "OPTIONS"])) return res.status(403).json({ error: "不允许从这个网站调用" });
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "只支持 GET" });
  if (await rateLimited(req, res, "unsplash", 40, 600)) return; // 10 分钟内 40 次

  const key =
    process.env.UNSPLASH_ACCESS_KEY ||
    process.env.UNSPLASH_KEY ||
    process.env.UNSPLASH_CLIENT_ID;
  if (!key) return res.status(200).json({ error: "未配置 Unsplash key" });

  const query = (req.query.query || "sky").toString().slice(0, 60);

  try {
    const api =
      "https://api.unsplash.com/photos/random" +
      `?query=${encodeURIComponent(query)}` +
      "&orientation=landscape&content_filter=high";

    const r = await fetch(api, {
      headers: {
        Authorization: "Client-ID " + key,
        "Accept-Version": "v1",
      },
    });
    if (!r.ok) return res.status(200).json({ error: "Unsplash 返回 " + r.status });

    const p = await r.json();
    const photo = Array.isArray(p) ? p[0] : p;
    if (!photo || !photo.urls) return res.status(200).json({ error: "无可用图片" });

    // 照片自己的页面。带 utm 是 Unsplash API 规范要求(署名回链)
    const photoPage = (photo.links && photo.links.html) || "https://unsplash.com";
    const userPage =
      (photo.user && photo.user.links && photo.user.links.html) || "https://unsplash.com";

    // 触发下载统计(Unsplash API 条款要求,不下载图片本身,只打一个点)
    if (photo.links && photo.links.download_location) {
      fetch(photo.links.download_location, {
        headers: { Authorization: "Client-ID " + key },
      }).catch(() => {});
    }

    res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=7200");
    return res.status(200).json({
      url: photo.urls.regular || photo.urls.full,
      author: (photo.user && photo.user.name) || "Unsplash",
      authorLink: userPage + (userPage.includes("?") ? "&" : "?") + UTM,
      unsplashLink: photoPage + (photoPage.includes("?") ? "&" : "?") + UTM,
      id: photo.id || "",
    });
  } catch (e) {
    return res.status(200).json({ error: "取图失败", detail: String(e.message || e) });
  }
}
