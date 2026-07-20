// Vercel Serverless Function —— 通用 AI 中转(多家 + 双密钥来源)
// 放到 api 文件夹,命名为 ai.js,即 /api/ai
//
// 两种用 key 的方式:
//   1) 你自己用:在 Vercel 环境变量里配好 key,前端不传 key 即走这个
//   2) 访客用:前端在请求里带上自己的 provider + apiKey,用访客自己的额度,服务器不存储
//
// 支持的 provider:deepseek / openai / claude / qwen / zhipu
//
// ⚠️ 安全:服务器端 key 默认【不启用】。
//   如果你想让自己用服务器上的 key(省得每台设备都填),必须同时配置:
//     OWNER_TOKEN = 一串你自己编的随机字符
//     以及对应的  DEEPSEEK_API_KEY / OPENAI_API_KEY / ANTHROPIC_API_KEY / ...
//   然后在自己浏览器里存下同一个 OWNER_TOKEN。没有它,别人调不到你的 key。
//   最省心的做法:干脆不配环境变量,你自己也用页面上的 ⚙️AI 填 key。
//
// 前端请求 body:
//   { "prompt":"...", "system":"...", "provider":"openai", "apiKey":"访客的key"(可选) }

const PROVIDERS = {
  deepseek: { url: "https://api.deepseek.com/v1/chat/completions", model: "deepseek-chat", env: "DEEPSEEK_API_KEY", style: "openai" },
  openai:   { url: "https://api.openai.com/v1/chat/completions", model: "gpt-4o-mini", env: "OPENAI_API_KEY", style: "openai" },
  claude:   { url: "https://api.anthropic.com/v1/messages", model: "claude-3-5-sonnet-20241022", env: "ANTHROPIC_API_KEY", style: "claude" },
  qwen:     { url: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions", model: "qwen-plus", env: "QWEN_API_KEY", style: "openai" },
  zhipu:    { url: "https://open.bigmodel.cn/api/paas/v4/chat/completions", model: "glm-4-flash", env: "ZHIPU_API_KEY", style: "openai" },
  // 硅基流动:OpenAI 兼容格式
  siliconflow: { url: "https://api.siliconflow.cn/v1/chat/completions", model: "deepseek-ai/DeepSeek-V3", env: "SILICONFLOW_API_KEY", style: "openai" },
  // Gemini:自成一套格式
  gemini:   { url: "https://generativelanguage.googleapis.com/v1beta/models", model: "gemini-2.0-flash", env: "GEMINI_API_KEY", style: "gemini" },
};

// 带图/带 PDF 时切换到各家的视觉模型;不在表里的服务商不支持看图
const VISION_MODEL = {
  openai: "gpt-4o-mini",
  claude: "claude-3-5-sonnet-20241022",
  gemini: "gemini-2.0-flash",
  qwen:   "qwen-vl-plus",
  zhipu:  "glm-4v-flash",
};

// Hobby 版函数默认超时只有 10 秒,AI 回话(尤其带图/PDF 时)经常超过这个数;
// 把上限提到 Hobby 允许的最大值 60 秒,避免正常请求被平台掐断。
export const config = { maxDuration: 60 };

// —— 简易限流(基于 Upstash Redis,和 health.js 共用同一个数据库,同一 IP 同一时间窗内限次数)——
// 没配 Upstash 环境变量时自动放行,不影响正常使用;限流服务本身出错也放行,不能因为它挂了误伤正常用户
async function redisCmd(cmd) {
  const url = process.env.UPSTASH_REDIS_REST_URL, token = process.env.UPSTASH_REDIS_REST_TOKEN;
  const r = await fetch(url, { method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" }, body: JSON.stringify(cmd) });
  return (await r.json()).result;
}
async function rateLimited(req, res, bucket, limit, windowSec) {
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) return false;
  try {
    const ip = ((req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "unknown") + "").split(",")[0].trim();
    const key = "rl:" + bucket + ":" + ip;
    const count = await redisCmd(["INCR", key]);
    if (count === 1) redisCmd(["EXPIRE", key, windowSec]).catch(() => {});
    if (count > limit) {
      res.setHeader("Retry-After", String(windowSec));
      res.status(429).json({ error: "请求太频繁,请 " + Math.ceil(windowSec / 60) + " 分钟后再试。" });
      return true;
    }
    return false;
  } catch (e) { return false; }
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "只支持 POST" });
  if (await rateLimited(req, res, "ai", 30, 600)) return; // 每 IP 10 分钟 30 次

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const prompt = (body && body.prompt) || "";
  const system = (body && body.system) || "你是一位专业、亲和、诚实的助手。";
  const providerName = (body && body.provider) || "deepseek";
  const visitorKey = (body && body.apiKey) || "";
  // 可选:图片(数组,base64)与 PDF(单个,base64,仅 Claude 支持)
  //   images: [{ media_type:"image/jpeg", data:"..." }]
  //   pdf:    { data:"..." }
  const images = Array.isArray(body && body.images) ? body.images.slice(0, 4) : [];
  const pdf = (body && body.pdf && body.pdf.data) ? body.pdf : null;

  const p = PROVIDERS[providerName];
  if (!p) return res.status(400).json({ error: "不支持的 provider:" + providerName });
  if (!prompt) return res.status(400).json({ error: "缺少 prompt" });

  const hasMedia = images.length > 0 || !!pdf;
  if (hasMedia && !VISION_MODEL[providerName]) {
    return res.status(400).json({ error: "该服务商不支持识别图片,请在 ⚙️AI 里换成 OpenAI / Claude / Gemini / 通义 / 智谱。" });
  }
  if (pdf && providerName !== "claude") {
    return res.status(400).json({ error: "PDF 识别目前只有 Claude 支持,可换 Claude,或把报告截图后按图片上传。" });
  }
  const mediaBytes = images.reduce((n, im) => n + ((im && im.data) ? im.data.length : 0), 0) + (pdf ? pdf.data.length : 0);
  if (mediaBytes > 6000000) {
    return res.status(413).json({ error: "图片/PDF 太大,请压缩后再试。" });
  }

  // —— 谁的 key,花谁的钱 ——
  // 默认只用访客自己填的 key。服务器上的 key(环境变量)必须同时带上 OWNER_TOKEN
  // 才会启用,否则任何人都能 POST 这个接口刷爆站长的额度。
  const ownerToken = process.env.OWNER_TOKEN;
  const claimsOwner = body && body.ownerToken;
  const isOwner = !!(ownerToken && claimsOwner && claimsOwner === ownerToken);

  const key = visitorKey || (isOwner ? process.env[p.env] : "");
  if (!key) {
    return res.status(401).json({
      error: "请先在页面右下角「⚙️ AI」填入你自己的 API key(用你自己的额度)。",
    });
  }

  // 简单的输入上限,避免有人塞超长内容拉高单次费用
  if (prompt.length > 20000) {
    return res.status(413).json({ error: "内容过长,请精简后再试。" });
  }

  try {
    let url = p.url, headers = { "Content-Type": "application/json" }, payload;
    const model = hasMedia ? VISION_MODEL[providerName] : p.model;
    if (p.style === "gemini") {
      url = `${p.url}/${model}:generateContent?key=${encodeURIComponent(key)}`;
      const parts = images.map(im => ({ inline_data: { mime_type: im.media_type || "image/jpeg", data: im.data } }));
      parts.push({ text: prompt });
      payload = {
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: parts }],
        generationConfig: { temperature: 0.7, maxOutputTokens: 2000 },
      };
    } else if (p.style === "claude") {
      headers["x-api-key"] = key;
      headers["anthropic-version"] = "2023-06-01";
      let content = prompt;
      if (hasMedia) {
        content = [];
        images.forEach(im => content.push({ type: "image", source: { type: "base64", media_type: im.media_type || "image/jpeg", data: im.data } }));
        if (pdf) content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: pdf.data } });
        content.push({ type: "text", text: prompt });
      }
      payload = { model: model, max_tokens: 2000, system: system, messages: [{ role: "user", content: content }] };
    } else {
      headers["Authorization"] = "Bearer " + key;
      let userContent = prompt;
      if (hasMedia) {
        userContent = images.map(im => ({
          type: "image_url",
          image_url: { url: "data:" + (im.media_type || "image/jpeg") + ";base64," + im.data }
        }));
        userContent.push({ type: "text", text: prompt });
      }
      payload = { model: model, messages: [{ role: "system", content: system }, { role: "user", content: userContent }], temperature: 0.7, max_tokens: 2000 };
    }

    const r = await fetch(url, { method: "POST", headers, body: JSON.stringify(payload) });
    const data = await r.json();

    let text = "";
    if (p.style === "gemini") {
      if (data.error) return res.status(502).json({ error: data.error.message || "AI 调用失败" });
      const c = data.candidates && data.candidates[0];
      text = c && c.content && c.content.parts ? c.content.parts.map(x => x.text || "").join("") : "";
    } else if (p.style === "claude") {
      if (data.error) return res.status(502).json({ error: data.error.message || "AI 调用失败" });
      text = data.content && data.content[0] && data.content[0].text ? data.content[0].text : "";
    } else {
      if (data.error) return res.status(502).json({ error: (data.error.message) || "AI 调用失败" });
      text = data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content : "";
    }
    return res.status(200).json({ text });
  } catch (e) {
    return res.status(502).json({ error: "AI 服务暂时不可用", detail: String(e) });
  }
}
