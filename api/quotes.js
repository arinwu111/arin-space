// Vercel Serverless Function —— 行情中转"跑腿小哥"(v2)
// 作用:替网页去 Yahoo Finance 取行情/搜索,绕开浏览器 CORS。
// v2 改动:报价改用更稳的 /v8/finance/chart 端点(逐个代码并发查),
//          解决旧的 /v7/quote 返回空数组的问题。
// 你不用改这个文件,直接连同 index.html 一起传到 GitHub 即可。
//
// 用法(网页自动调用):
//   /api/quotes?symbols=AAPL,NVDA,0700.HK,600519.SS   → 批量行情
//   /api/quotes?search=英伟达                          → 搜索股票代码

import { applyCors, rateLimited } from "../lib/api-security.js";

const YH_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "application/json",
};

// 取单个代码的行情(用 chart 端点)
async function fetchOne(symbol) {
  const url =
    "https://query1.finance.yahoo.com/v8/finance/chart/" +
    encodeURIComponent(symbol) +
    "?range=1d&interval=1d";
  try {
    const r = await fetch(url, { headers: YH_HEADERS });
    const data = await r.json();
    const res = data && data.chart && data.chart.result && data.chart.result[0];
    if (!res || !res.meta) return null;
    const m = res.meta;
    const price = m.regularMarketPrice;
    const prev = m.chartPreviousClose != null ? m.chartPreviousClose : m.previousClose;
    let change = null, changePercent = null;
    if (price != null && prev != null && prev !== 0) {
      change = price - prev;
      changePercent = (change / prev) * 100;
    }
    return {
      symbol: m.symbol || symbol,
      name: m.shortName || m.longName || m.symbol || symbol,
      price,
      change,
      changePercent,
      currency: m.currency || "",
    };
  } catch (e) {
    return null;
  }
}

export default async function handler(req, res) {
  if (!applyCors(req, res, ["GET", "OPTIONS"])) return res.status(403).json({ error: "不允许从这个网站调用" });
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "只支持 GET" });
  if (await rateLimited(req, res, "quotes", 100, 600)) return;

  const { symbols, search } = req.query;

  try {
    // ===== 搜索模式 =====
    if (search) {
      const query = String(search).trim().slice(0, 80);
      if (!query) return res.status(400).json({ error: "搜索内容不能为空" });
      const url =
        "https://query1.finance.yahoo.com/v1/finance/search?quotesCount=10&newsCount=0&q=" +
        encodeURIComponent(query);
      const r = await fetch(url, { headers: YH_HEADERS });
      const data = await r.json();
      const quotes = (data.quotes || [])
        .filter((q) => q.symbol)
        .map((q) => ({
          symbol: q.symbol,
          name: q.shortname || q.longname || q.symbol,
          exchange: q.exchDisp || q.exchange || "",
          type: q.quoteType || "",
        }));
      res.setHeader("Cache-Control", "s-maxage=60");
      return res.status(200).json({ quotes });
    }

    // ===== 批量行情模式(并发逐个查 chart) =====
    if (symbols) {
      const list = String(symbols).split(",").map((s) => s.trim()).filter((s) => /^[A-Za-z0-9.^=_-]{1,32}$/.test(s)).slice(0, 40);
      if (!list.length) return res.status(400).json({ error: "没有有效的股票代码" });
      const settled = await Promise.all(list.map((s) => fetchOne(s)));
      const quotes = settled.filter(Boolean);
      res.setHeader("Cache-Control", "s-maxage=15");
      return res.status(200).json({ quotes });
    }

    return res.status(400).json({ error: "缺少 symbols 或 search 参数" });
  } catch (e) {
    return res.status(502).json({ error: "行情源暂时不可用", detail: String(e) });
  }
}
