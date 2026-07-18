// Vercel Serverless Function —— Unsplash 随机配图
// 放到 api 文件夹,命名为 unsplash.js,即 /api/unsplash
//
// 需要在 Vercel 环境变量里配置(免费注册 unsplash.com/developers 拿 Access Key):
//   UNSPLASH_ACCESS_KEY = 你的 Access Key
//
// 用法:/api/unsplash?query=sunset%20sky
// 返回:{ url, thumb, author, authorLink, unsplashLink }
//
// ⚠️ Unsplash API 条款要求:
//   1) 图片必须热链接(用返回的 url 直接显示,不能下载转存)
//   2) 必须署名摄影师 + Unsplash,并带可点击链接(前端已实现)
//   3) 展示时需触发 download_location 埋点(本函数已代为触发)

const APP = "arinrin_space"; // UTM 用,便于 Unsplash 识别来源

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const key = process.env.UNSPLASH_ACCESS_KEY;
  if (!key) return res.status(200).json({ error: "no_key" }); // 前端会自动降级,不报错

  // 只允许本站用到的这几个关键词,防止被人当免费 Unsplash 搜索代理刷掉额度
  const ALLOWED = [
    "sunrise sky dawn", "blue sky clouds morning", "bright blue sky",
    "golden hour sky", "sunset sky dusk clouds", "night sky stars", "sky",
  ];
  const asked = (req.query.query || "sky").toString().slice(0, 60);
  const query = ALLOWED.indexOf(asked) !== -1 ? asked : "sky";
  const orientation = "landscape";

  try {
    const r = await fetch(
      `https://api.unsplash.com/photos/random?query=${encodeURIComponent(query)}` +
      `&orientation=${orientation}&content_filter=high`,
      { headers: { Authorization: "Client-ID " + key, "Accept-Version": "v1" } }
    );
    if (!r.ok) return res.status(200).json({ error: "unsplash_" + r.status });
    const p = await r.json();
    const photo = Array.isArray(p) ? p[0] : p;
    if (!photo || !photo.urls) return res.status(200).json({ error: "empty" });

    // 按条款触发下载埋点(不阻塞返回)
    if (photo.links && photo.links.download_location) {
      fetch(photo.links.download_location, {
        headers: { Authorization: "Client-ID " + key },
      }).catch(() => {});
    }

    const utm = `?utm_source=${APP}&utm_medium=referral`;
    res.setHeader("Cache-Control", "s-maxage=3600"); // 1小时,省额度
    return res.status(200).json({
      url: photo.urls.regular,          // 热链接使用
      thumb: photo.urls.small,
      color: photo.color || "#222",
      author: (photo.user && photo.user.name) || "Unsplash",
      authorLink: (photo.user && photo.user.links && photo.user.links.html
        ? photo.user.links.html : "https://unsplash.com") + utm,
      unsplashLink: "https://unsplash.com" + utm,
    });
  } catch (e) {
    return res.status(200).json({ error: "fetch_failed" });
  }
}
