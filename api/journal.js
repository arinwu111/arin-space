// Vercel Serverless Function —— 公开日志
// 所有人可以读取；发布、修改和删除沿用信箱管理员口令。

const JOURNAL_KEY = "arinrin:journal:entries";
const MAX_ENTRIES = 100;

const STARTER_ENTRIES = [
  {
    id: "site-2026-07-17",
    date: "2026-07-17",
    title: "小世界亮灯",
    content: "今天给自己的小世界点了一盏灯。放进喜欢的颜色、句子和一间冥想小屋，希望以后每次回来，都能稍微松一口气。",
  },
  {
    id: "site-2026-07-18",
    date: "2026-07-18",
    title: "开始记录生活",
    content: "房间里渐渐有了晨间准备、晚间复盘和安静阅读的角落。原来做网站不只是搭建页面，也是在练习怎样好好度过一天。",
  },
  {
    id: "site-2026-07-19",
    date: "2026-07-19",
    title: "给犹豫留一点时间",
    content: "今天为那些拿不定主意的时刻，做了一个“慢想”的地方。答案不必马上出现，愿意停下来听听自己，或许就已经在靠近答案。",
  },
  {
    id: "site-2026-07-20",
    date: "2026-07-20",
    title: "装进更多真实的自己",
    content: "健康、书影音、口语练习，还有三种可能的人生，都慢慢住了进来。这个网站不再只是展示我，也开始接住正在生活的我。",
  },
  {
    id: "site-2026-07-21",
    date: "2026-07-21",
    title: "门外有人经过",
    content: "今天在小屋旁放了一只信箱，也为播客和论文腾出了书架。愿这里既能收藏独处的时光，也能接住远方来的一张小小便签。",
  },
];

export const config = { maxDuration: 30 };

function redisConfig() {
  return {
    url: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN,
  };
}

async function redis(command) {
  const { url, token } = redisConfig();
  if (!url || !token) throw new Error("日志存储尚未配置");
  const response = await fetch(url, {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify(command),
  });
  if (!response.ok) throw new Error("日志存储暂时不可用");
  const data = await response.json();
  if (data.error) throw new Error(data.error);
  return data.result;
}

function getBody(req) {
  if (!req.body) return {};
  if (typeof req.body === "object") return req.body;
  try { return JSON.parse(req.body); } catch (_) { return {}; }
}

function cleanText(value, maxLength, multiline) {
  let text = String(value || "").normalize("NFC");
  text = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
  text = multiline
    ? text.replace(/\r\n?/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n")
    : text.replace(/\s+/g, " ");
  return text.trim().slice(0, maxLength);
}

function adminToken(req) {
  const header = String(req.headers.authorization || "");
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

function isAdmin(req) {
  const expected = process.env.MAILBOX_ADMIN_TOKEN || "";
  const supplied = adminToken(req);
  if (!expected || expected.length !== supplied.length) return false;
  let different = 0;
  for (let i = 0; i < expected.length; i += 1) {
    different |= expected.charCodeAt(i) ^ supplied.charCodeAt(i);
  }
  return different === 0;
}

function sortEntries(entries) {
  return entries.sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.createdAt || "").localeCompare(String(b.createdAt || "")));
}

async function readEntries() {
  const { url, token } = redisConfig();
  if (!url || !token) return STARTER_ENTRIES.map((entry) => ({ ...entry }));
  const raw = await redis(["GET", JOURNAL_KEY]);
  if (!raw) return STARTER_ENTRIES.map((entry) => ({ ...entry }));
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? sortEntries(parsed) : [];
  } catch (_) {
    throw new Error("日志数据损坏");
  }
}

function newId() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") return globalThis.crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    if (req.method === "GET") {
      if (adminToken(req)) {
        if (!process.env.MAILBOX_ADMIN_TOKEN) return res.status(503).json({ error: "服务器尚未配置管理员口令" });
        if (!isAdmin(req)) return res.status(401).json({ error: "管理员口令不正确" });
      }
      return res.status(200).json({ entries: await readEntries(), admin: Boolean(adminToken(req)) });
    }

    if (req.method !== "POST") return res.status(405).json({ error: "只支持 GET / POST" });
    if (!process.env.MAILBOX_ADMIN_TOKEN) return res.status(503).json({ error: "服务器尚未配置管理员口令" });
    if (!isAdmin(req)) return res.status(401).json({ error: "管理员口令不正确" });

    const { url, token } = redisConfig();
    if (!url || !token) return res.status(503).json({ error: "日志存储尚未配置" });

    const body = getBody(req);
    const action = cleanText(body.action, 20, false);
    const entries = await readEntries();

    if (action === "delete") {
      const id = cleanText(body.id, 80, false);
      const next = entries.filter((entry) => entry.id !== id);
      if (next.length === entries.length) return res.status(404).json({ error: "没有找到这篇日志" });
      await redis(["SET", JOURNAL_KEY, JSON.stringify(next)]);
      return res.status(200).json({ ok: true, entries: sortEntries(next) });
    }

    if (action !== "upsert") return res.status(400).json({ error: "日志操作无效" });
    const id = cleanText(body.id, 80, false) || newId();
    const date = cleanText(body.date, 10, false);
    const title = cleanText(body.title, 60, false);
    const content = cleanText(body.content, 100, true);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: "请选择正确的日期" });
    if (!title) return res.status(400).json({ error: "请写下日志标题" });
    if (!content) return res.status(400).json({ error: "请写下日志内容" });

    const existing = entries.find((entry) => entry.id === id);
    const now = new Date().toISOString();
    const entry = { id, date, title, content, createdAt: existing?.createdAt || now, updatedAt: now };
    const next = entries.filter((item) => item.id !== id);
    next.push(entry);
    sortEntries(next);
    const storedEntries = next.slice(-MAX_ENTRIES);
    await redis(["SET", JOURNAL_KEY, JSON.stringify(storedEntries)]);
    return res.status(existing ? 200 : 201).json({ ok: true, entry, entries: storedEntries });
  } catch (error) {
    return res.status(503).json({ error: String(error.message || error) });
  }
}
