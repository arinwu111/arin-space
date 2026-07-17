// Vercel Serverless Function —— 行情中转"跑腿小哥"
// 作用:替网页去 Yahoo Finance 取行情/搜索,绕开浏览器的 CORS 限制。
// 你不用改这个文件,直接连同 index.html 一起传到 GitHub 即可。
//
// 用法(网页会自动调用,你不用手动调):
//   /api/quotes?symbols=AAPL,NVDA,0700.HK,600519.SS   → 批量行情
//   /api/quotes?search=英伟达                          → 搜索股票代码

const YH_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "application/json",
};

export default async function handler(req, res) {
  // 允许你的网页跨域调用这个函数
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { symbols, search } = req.query;

  try {
    // ===== 模式一:搜索股票(返回代码候选) =====
    if (search) {
      const url =
        "https://query1.finance.yahoo.com/v1/finance/search?quotesCount=10&newsCount=0&q=" +
        encodeURIComponent(search);
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

    // ===== 模式二:批量取行情 =====
    if (symbols) {
      const list = symbols.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 40);
      const url =
        "https://query1.finance.yahoo.com/v7/finance/quote?symbols=" +
        encodeURIComponent(list.join(","));
      const r = await fetch(url, { headers: YH_HEADERS });
      const data = await r.json();
      const result = (data.quoteResponse && data.quoteResponse.result) || [];
      const quotes = result.map((q) => ({
        symbol: q.symbol,
        name: q.shortName || q.longName || q.symbol,
        price: q.regularMarketPrice,
        change: q.regularMarketChange,
        changePercent: q.regularMarketChangePercent,
        currency: q.currency || "",
        marketState: q.marketState || "",
      }));
      res.setHeader("Cache-Control", "s-maxage=15"); // 15秒缓存,减少请求
      return res.status(200).json({ quotes });
    }

    return res.status(400).json({ error: "缺少 symbols 或 search 参数" });
  } catch (e) {
    return res.status(502).json({ error: "行情源暂时不可用", detail: String(e) });
  }
}
