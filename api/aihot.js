// /api/aihot.js — AI HOT (aihot.virxact.com) 中转代理
// 修复要点:
// 1. AI HOT 的 /api/public/* 有 UA 黑名单,不带可识别 UA 的请求会被 403,
//    这就是「精选」和「往期」拉不到内容的原因。这里统一带上自报家门的 UA。
// 2. 精选的正确接口是 /api/public/items?mode=selected(不是独立的 selected 端点)。
// 3. 往期的正确接口是 /api/public/dailies?take=N,每条字段是 { date, leadTitle }。

const BASE = "https://aihot.virxact.com/api/public";
const UA = "arinrin-space/1.0 (+https://arinrin.space)"; // 可识别、非浏览器 UA(官方要求)

module.exports = async function handler(req, res) {
  const type = (req.query.type || "daily").toString();
  const take = Math.min(parseInt(req.query.take, 10) || 25, 100);

  let url;
  if (type === "selected") {
    url = `${BASE}/items?mode=selected&take=${take}`;
  } else if (type === "dailies") {
    url = `${BASE}/dailies?take=${take}`;
  } else if (type === "daily") {
    url = `${BASE}/daily`;
  } else {
    res.status(400).json({ error: "type must be daily | selected | dailies" });
    return;
  }

  try {
    const upstream = await fetch(url, {
      headers: { "User-Agent": UA, "Accept": "application/json" },
    });

    if (!upstream.ok) {
      // 日报早八点前可能 404,原样透传状态码让前端处理
      res.status(upstream.status).json({ error: "upstream " + upstream.status });
      return;
    }

    const data = await upstream.json();
    // items 端点 5 分钟服务端缓存,这里也缓 5 分钟,别高频打上游
    res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");
    res.status(200).json(data);
  } catch (e) {
    res.status(502).json({ error: "fetch failed: " + (e && e.message) });
  }
};
