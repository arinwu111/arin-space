// 每日「与你有关」：合并 AI HOT 日报与精选，仅分析标题、摘要和标签。
// AI 每天最多生成一份结果并写入 Redis；访客和五个分类共用同一份缓存。

const AIHOT_BASE = "https://aihot.virxact.com/api/public";
const AIHOT_UA = "arinrin-space/1.0 (+https://arinrin.space)";
const CACHE_PREFIX = "arinrin:ai-useful:";
const DAY_MS = 24 * 60 * 60 * 1000;

export const config = { maxDuration: 60 };

function redisConfig() {
  return {
    url: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN,
  };
}

async function redis(command) {
  const { url, token } = redisConfig();
  if (!url || !token) throw new Error("每日分析缓存尚未配置");
  const response = await fetch(url, {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify(command),
  });
  if (!response.ok) throw new Error("每日分析缓存暂时不可用");
  const data = await response.json();
  if (data.error) throw new Error(data.error);
  return data.result;
}

function expectedDailyDate(now = new Date()) {
  const shanghai = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  if (shanghai.getUTCHours() < 8) shanghai.setTime(shanghai.getTime() - DAY_MS);
  return shanghai.toISOString().slice(0, 10);
}

function siteBase(req) {
  if (process.env.SITE_URL) return process.env.SITE_URL.replace(/\/$/, "");
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "www.arinrin.space");
  return (host.includes("localhost") ? "http" : "https") + "://" + host;
}

function isAdmin(req) {
  const expected = process.env.MAILBOX_ADMIN_TOKEN || "";
  const supplied = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  if (!expected || expected.length !== supplied.length) return false;
  let different = 0;
  for (let index = 0; index < expected.length; index += 1) {
    different |= expected.charCodeAt(index) ^ supplied.charCodeAt(index);
  }
  return different === 0;
}

async function aihot(path) {
  const response = await fetch(AIHOT_BASE + path, {
    headers: { "User-Agent": AIHOT_UA, Accept: "application/json" },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error("今日要闻暂时没有回应");
  return data;
}

function tagNames(item) {
  return (item.tags || item.topics || []).map(tag =>
    typeof tag === "string" ? tag : String(tag && tag.name || "")
  ).filter(Boolean);
}

function itemLink(item) {
  return item.sourceUrl || item.url || item.originalUrl || item.link || item.permalink || "";
}

function compactItem(item, section, origin) {
  return {
    title: String(item.title || "").replace(/\s+/g, " ").trim().slice(0, 180),
    summary: String(item.summary || item.description || "").replace(/\s+/g, " ").trim().slice(0, 300),
    source: String(item.sourceName || item.source || "AI HOT").replace(/\s+/g, " ").trim().slice(0, 80),
    link: itemLink(item),
    tags: tagNames(item).slice(0, 4),
    section: String(section || "").slice(0, 60),
    origin,
  };
}

const PREFILTER_TERMS = [
  "工具", "模型", "开源", "api", "插件", "agent", "智能体", "应用",
  "投资", "融资", "估值", "财报", "营收", "收入", "利润", "成本", "订单",
  "芯片", "gpu", "算力", "数据中心", "能源", "监管", "收购", "并购", "资本",
  "产品", "功能", "交互", "设计", "网站", "开发", "代码", "自动化", "工作流", "用户",
  "创作", "内容", "视频", "音频", "播客", "写作", "图像", "音乐", "剪辑", "知识库", "转写",
  "职业", "岗位", "招聘", "就业", "求职", "工作", "技能", "教育", "团队", "员工", "工程师", "人才",
];

function relevanceScore(item) {
  const text = [item.title, item.summary, item.section, item.tags.join(" ")].join(" ").toLowerCase();
  return PREFILTER_TERMS.reduce((score, term) => score + (text.includes(term) ? 1 : 0), 0);
}

function collectCandidates(daily, selected) {
  const all = [];
  (daily.sections || []).forEach(section => {
    (section.items || []).forEach(item => all.push(compactItem(item, section.label, "日报")));
  });
  const selectedItems = selected.items || selected.data || (Array.isArray(selected) ? selected : []);
  selectedItems.forEach(item => all.push(compactItem(item, "精选", "精选")));

  const seen = new Set();
  return all.filter(item => {
    const key = item.link || item.title;
    if (!item.title || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map(item => ({ ...item, score: relevanceScore(item) }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 24)
    .map((item, index) => ({ ...item, id: "n" + (index + 1) }));
}

function parseAIJSON(text) {
  const cleaned = String(text || "").replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("AI 没有返回可读取的分析");
  return JSON.parse(match[0]);
}

function normalizeResult(raw, candidates, date) {
  const byId = new Map(candidates.map(item => [item.id, item]));
  const categories = {};
  ["tool", "invest", "product", "create", "career"].forEach(key => {
    const seen = new Set();
    categories[key] = (raw.categories && Array.isArray(raw.categories[key]) ? raw.categories[key] : [])
      .map(result => {
        const original = byId.get(String(result && result.id || ""));
        const relation = String(result && result.relation || "").replace(/\s+/g, " ").trim().slice(0, 180);
        if (!original || !relation || seen.has(original.id)) return null;
        seen.add(original.id);
        return {
          id: original.id,
          title: original.title,
          summary: original.summary,
          source: original.source,
          link: original.link,
          tags: original.tags,
          origin: original.origin,
          relation,
        };
      })
      .filter(Boolean)
      .slice(0, 6);
  });
  return { date, generatedAt: new Date().toISOString(), sources: ["日报", "精选"], categories };
}

async function generateAnalysis(req, date, candidates) {
  if (!process.env.OWNER_TOKEN && !process.env.AI_USEFUL_API_KEY && !process.env.JOURNAL_AI_API_KEY) {
    throw new Error("每日 AI 分析尚未配置");
  }
  const prompt = `从下面的 AI 日报与精选条目中，筛出真正与 Arin 有关的内容。

Arin 当前关注：AI 工具与效率、个人网站和产品设计、内容创作与知识管理、求职与职业发展、AI/科技产业投资。

“有用”的定义：可能改变她近期的行动、判断或资源分配，而不只是有趣。

分类：
- tool：可以直接试用或接入工作流的工具、模型、插件、开源项目
- invest：可能影响公司收入、成本、订单、供需、监管或竞争格局的投资信号
- product：可借鉴的网站功能、产品结构、交互和自动化方法
- create：视频、播客、写作、视觉表达和知识管理方法
- career：岗位变化、能力要求、招聘趋势与工作方式

要求：
1. 只依据标题、摘要、来源和标签，不臆测全文。
2. 每类最多 6 条；同一条可以进入多个分类，但 relation 必须针对该分类重写。
3. relation 要具体说明“这件事为什么与她有关、值得观察什么或能做什么”，35—100 个汉字。
4. 禁止使用“可评估是否加入工作流”“值得继续关注”“可能带来启发”等放在任何新闻上都成立的空话。
5. 投资类写清影响链条和不确定性，不做买卖建议。
6. 没有足够相关内容的分类可以返回空数组。
7. 只返回合法 JSON，格式：
{"categories":{"tool":[{"id":"n1","relation":"..."}],"invest":[],"product":[],"create":[],"career":[]}}

候选条目：
${JSON.stringify(candidates.map(({ score, ...item }) => item))}`;

  if (prompt.length > 19500) throw new Error("今日候选内容过多");
  const response = await fetch(siteBase(req) + "/api/ai", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      provider: process.env.AI_USEFUL_PROVIDER || process.env.JOURNAL_AI_PROVIDER || "deepseek",
      apiKey: process.env.AI_USEFUL_API_KEY || process.env.JOURNAL_AI_API_KEY || "",
      ownerToken: process.env.OWNER_TOKEN || "",
      system: "你是克制、具体的信息分析编辑。只根据给定材料判断，不使用空泛套话。",
      prompt,
      maxTokens: 4000,
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.text) throw new Error(data.error || "AI 分析暂时失败");
  return normalizeResult(parseAIJSON(data.text), candidates, date);
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") return res.status(405).json({ error: "只支持 GET" });
  if (!isAdmin(req)) return res.status(401).json({ error: "这部分内容仅主人可见" });

  const date = expectedDailyDate();
  const cacheKey = CACHE_PREFIX + date;
  const force = String(req.query && req.query.force || "") === "1";
  try {
    if (!force) {
      const cached = await redis(["GET", cacheKey]);
      if (cached) return res.status(200).json(JSON.parse(cached));
    }

    const lockKey = cacheKey + ":lock";
    const lock = await redis(["SET", lockKey, String(Date.now()), "NX", "EX", 90]);
    if (lock !== "OK") {
      const cached = await redis(["GET", cacheKey]);
      if (cached) return res.status(200).json(JSON.parse(cached));
      return res.status(202).json({ generating: true, date });
    }

    try {
      const [daily, selected] = await Promise.all([
        aihot("/daily"),
        aihot("/items?mode=selected&take=20"),
      ]);
      const resultDate = String(daily.date || date);
      const candidates = collectCandidates(daily, selected);
      if (!candidates.length) throw new Error("今天没有足够相关的候选内容");
      const result = await generateAnalysis(req, resultDate, candidates);
      await redis(["SET", CACHE_PREFIX + resultDate, JSON.stringify(result), "EX", 172800]);
      if (resultDate !== date) await redis(["SET", cacheKey, JSON.stringify(result), "EX", 172800]);
      return res.status(200).json(result);
    } finally {
      await redis(["DEL", lockKey]).catch(() => {});
    }
  } catch (error) {
    return res.status(503).json({ error: String(error.message || error) });
  }
}
