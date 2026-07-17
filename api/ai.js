// Vercel Serverless Function —— 通用 AI 中转(多家 + 双密钥来源)
// 放到 api 文件夹,命名为 ai.js,即 /api/ai
//
// 两种用 key 的方式:
//   1) 你自己用:在 Vercel 环境变量里配好 key,前端不传 key 即走这个
//   2) 访客用:前端在请求里带上自己的 provider + apiKey,用访客自己的额度,服务器不存储
//
// 支持的 provider:deepseek / openai / claude / qwen / zhipu
//
// 你自己要用的话,在 Vercel Settings → Environment Variables 里按你选的那家配一个:
//   DEEPSEEK_API_KEY / OPENAI_API_KEY / ANTHROPIC_API_KEY / QWEN_API_KEY / ZHIPU_API_KEY
//
// 前端请求 body:
//   { "prompt":"...", "system":"...", "provider":"openai", "apiKey":"访客的key"(可选) }

const PROVIDERS = {
  deepseek: { url: "https://api.deepseek.com/v1/chat/completions", model: "deepseek-chat", env: "DEEPSEEK_API_KEY", style: "openai" },
  openai:   { url: "https://api.openai.com/v1/chat/completions", model: "gpt-4o-mini", env: "OPENAI_API_KEY", style: "openai" },
  claude:   { url: "https://api.anthropic.com/v1/messages", model: "claude-3-5-sonnet-20241022", env: "ANTHROPIC_API_KEY", style: "claude" },
  qwen:     { url: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions", model: "qwen-plus", env: "QWEN_API_KEY", style: "openai" },
  zhipu:    { url: "https://open.bigmodel.cn/api/paas/v4/chat/completions", model: "glm-4-flash", env: "ZHIPU_API_KEY", style: "openai" },
};

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "只支持 POST" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const prompt = (body && body.prompt) || "";
  const system = (body && body.system) || "你是一位专业、亲和、诚实的助手。";
  const providerName = (body && body.provider) || "deepseek";
  const visitorKey = (body && body.apiKey) || "";

  const p = PROVIDERS[providerName];
  if (!p) return res.status(400).json({ error: "不支持的 provider:" + providerName });
  if (!prompt) return res.status(400).json({ error: "缺少 prompt" });

  const key = visitorKey || process.env[p.env];
  if (!key) {
    return res.status(401).json({ error: "缺少 API key。访客请在页面填写自己的 key;站长请在 Vercel 环境变量配置 " + p.env + "。" });
  }

  try {
    let url = p.url, headers = { "Content-Type": "application/json" }, payload;
    if (p.style === "claude") {
      headers["x-api-key"] = key;
      headers["anthropic-version"] = "2023-06-01";
      payload = { model: p.model, max_tokens: 2000, system: system, messages: [{ role: "user", content: prompt }] };
    } else {
      headers["Authorization"] = "Bearer " + key;
      payload = { model: p.model, messages: [{ role: "system", content: system }, { role: "user", content: prompt }], temperature: 0.7, max_tokens: 2000 };
    }

    const r = await fetch(url, { method: "POST", headers, body: JSON.stringify(payload) });
    const data = await r.json();

    let text = "";
    if (p.style === "claude") {
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
