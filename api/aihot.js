// Vercel Serverless Function —— AIHOT 每日动态中转
// 作用:替网页去 AIHOT 取每日 AI 动态,绕开浏览器 CORS。
// 放到 api 文件夹,命名为 aihot.js,即 /api/aihot
// 你不用改这个文件,和 index.html 一起传到 GitHub 即可。

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const r = await fetch("https://aihot.virxact.com/api/public/daily", {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Accept: "application/json",
      },
    });
    const data = await r.json();
    res.setHeader("Cache-Control", "s-maxage=600"); // 缓存10分钟
    return res.status(200).json(data);
  } catch (e) {
    return res.status(502).json({ error: "AIHOT 暂时不可用", detail: String(e) });
  }
}
