// 每天北京时间 08:00 检查昨天的 GitHub 变更，并自动写一篇公开日志。
// Vercel Cron 使用 UTC，因此 vercel.json 中配置为每天 00:00 UTC。

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_REPOSITORY = "arinwu111/arin-space";

export const config = { maxDuration: 60 };

function authorized(req) {
  const secret = process.env.CRON_SECRET || "";
  const supplied = String(req.headers.authorization || "");
  return Boolean(secret && supplied === "Bearer " + secret);
}

function targetWindow(now = new Date()) {
  const shanghaiToday = new Date(now.getTime() + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10);
  const [year, month, day] = shanghaiToday.split("-").map(Number);
  const targetLocalMidnightAsUtc = Date.UTC(year, month - 1, day) - DAY_MS;
  const date = new Date(targetLocalMidnightAsUtc).toISOString().slice(0, 10);
  const start = new Date(targetLocalMidnightAsUtc - SHANGHAI_OFFSET_MS);
  const end = new Date(start.getTime() + DAY_MS);
  return { date, start: start.toISOString(), end: end.toISOString() };
}

function siteBase(req) {
  if (process.env.SITE_URL) return process.env.SITE_URL.replace(/\/$/, "");
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "www.arinrin.space");
  const protocol = host.includes("localhost") ? "http" : "https";
  return protocol + "://" + host;
}

function githubHeaders() {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "arinrin-space-journal/1.0",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (process.env.GITHUB_READ_TOKEN) headers.Authorization = "Bearer " + process.env.GITHUB_READ_TOKEN;
  return headers;
}

async function githubJSON(url) {
  const response = await fetch(url, { headers: githubHeaders() });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || "GitHub 暂时没有回应");
  return data;
}

function meaningfulFile(file) {
  const name = String(file.filename || "").toLowerCase();
  return name && !/(^|\/)(readme(?:\.[^/]*)?|\.gitignore|\.ds_store)$/.test(name);
}

async function changesForDay(window) {
  const repository = process.env.JOURNAL_GITHUB_REPO || DEFAULT_REPOSITORY;
  const listURL = new URL("https://api.github.com/repos/" + repository + "/commits");
  listURL.searchParams.set("sha", process.env.JOURNAL_GITHUB_BRANCH || "main");
  listURL.searchParams.set("since", window.start);
  listURL.searchParams.set("until", window.end);
  listURL.searchParams.set("per_page", "100");
  const commits = await githubJSON(listURL.toString());
  if (!Array.isArray(commits) || !commits.length) return null;

  const newest = commits[0];
  const oldest = commits[commits.length - 1];
  const base = oldest.parents && oldest.parents[0] && oldest.parents[0].sha;
  let files = [];
  if (base && newest.sha) {
    const compare = await githubJSON("https://api.github.com/repos/" + repository + "/compare/" + base + "..." + newest.sha);
    files = (compare.files || []).filter(meaningfulFile);
  } else if (newest.sha) {
    const detail = await githubJSON("https://api.github.com/repos/" + repository + "/commits/" + newest.sha);
    files = (detail.files || []).filter(meaningfulFile);
  }
  if (!files.length) return null;

  const messages = commits.map(item => String(item.commit && item.commit.message || "").split("\n")[0]).filter(Boolean);
  const fileSummary = files.slice(0, 20).map(file => {
    const patch = String(file.patch || "").replace(/@@[^@]*@@/g, "").slice(0, 900);
    return [file.status, file.filename, patch].filter(Boolean).join("\n");
  }).join("\n\n");
  return {
    count: commits.length,
    messages,
    files: files.map(file => file.filename),
    details: fileSummary.slice(0, 12000),
  };
}

function fallbackEntry(changes) {
  const joined = (changes.files.join(" ") + " " + changes.details).toLowerCase();
  const themes = [];
  if (/journal|message|mailbox|日志|信箱|留言/.test(joined)) themes.push("可以被看见和回应的角落");
  if (/podcast|paper|article|study|书房|播客|论文/.test(joined)) themes.push("书房里的收藏与阅读");
  if (/health|fitness|zen|meditat|健康|冥想|呼吸/.test(joined)) themes.push("照顾身体和安静下来的方式");
  if (/daily|morning|evening|explore|slow|theme|晨间|晚间|慢想/.test(joined)) themes.push("记录生活与整理思绪的路径");
  if (/aihot|api\/ai|\bai\b|快讯|日报/.test(joined)) themes.push("与 AI 相处的小工具");
  if (/invest|quote|stock|投资|行情/.test(joined)) themes.push("观察市场的窗口");
  const subject = themes.length ? themes.slice(0, 2).join("，也整理了") : "一些不起眼的细节";
  return {
    title: "小世界又长大一点",
    content: "今天继续整理这个小世界，照看了" + subject + "。变化也许很小，但这里正一点点长成我想住进去的样子。",
  };
}

function parseAIEntry(text) {
  const cleaned = String(text || "").replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("AI 没有返回日志格式");
  const parsed = JSON.parse(match[0]);
  const title = String(parsed.title || "").replace(/\s+/g, " ").trim().slice(0, 60);
  const content = String(parsed.content || "").replace(/\r\n?/g, "\n").trim().slice(0, 100);
  if (!title || !content) throw new Error("AI 返回了空日志");
  return { title, content };
}

async function generateEntry(req, date, changes) {
  const fallback = fallbackEntry(changes);
  const hasDirectKey = Boolean(process.env.JOURNAL_AI_API_KEY);
  const hasOwnerAI = Boolean(process.env.OWNER_TOKEN);
  if (!hasDirectKey && !hasOwnerAI) return { ...fallback, generatedBy: "template" };

  const prompt = `根据下面的网站代码变更，写一篇发布在个人网站上的温情短日志。
日期：${date}
提交说明：${changes.messages.join("；") || "未填写"}
变更文件：${changes.files.join("、")}
部分代码差异：
${changes.details}

要求：
1. 像一个人在记录自己慢慢搭建小世界，不要写成产品更新公告或技术周报。
2. 正文使用简体中文，2—3 句话，总计不超过 100 个汉字。
3. 只写能从变更中确认的事情，不夸大，不出现 commit、API、代码、部署等技术词。
4. 给出一个温柔、简短的标题。
5. 只返回 JSON：{"title":"...","content":"..."}`;

  try {
    const response = await fetch(siteBase(req) + "/api/ai", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: process.env.JOURNAL_AI_PROVIDER || "deepseek",
        apiKey: process.env.JOURNAL_AI_API_KEY || "",
        ownerToken: process.env.OWNER_TOKEN || "",
        system: "你是克制、温柔的中文日记编辑。忠于提供的事实，不使用客套话。",
        prompt,
        maxTokens: 500,
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.text) throw new Error(data.error || "AI 生成失败");
    return { ...parseAIEntry(data.text), generatedBy: "ai" };
  } catch (_) {
    return { ...fallback, generatedBy: "template" };
  }
}

async function journalRequest(req, path, options) {
  const response = await fetch(siteBase(req) + path, options || {});
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "日志服务暂时没有回应");
  return data;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") return res.status(405).json({ error: "只支持 GET" });
  if (!authorized(req)) return res.status(401).json({ error: "定时任务验证失败" });

  try {
    const window = targetWindow();
    const publicJournal = await journalRequest(req, "/api/journal");
    if ((publicJournal.entries || []).some(entry => entry.date === window.date)) {
      return res.status(200).json({ ok: true, skipped: "date-exists", date: window.date });
    }

    const changes = await changesForDay(window);
    if (!changes) return res.status(200).json({ ok: true, skipped: "no-changes", date: window.date });

    const entry = await generateEntry(req, window.date, changes);
    const saved = await journalRequest(req, "/api/journal", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + (process.env.MAILBOX_ADMIN_TOKEN || ""),
      },
      body: JSON.stringify({
        action: "upsert",
        id: "auto-" + window.date,
        date: window.date,
        title: entry.title,
        content: entry.content,
      }),
    });
    return res.status(201).json({
      ok: true,
      date: window.date,
      commits: changes.count,
      generatedBy: entry.generatedBy,
      entry: saved.entry,
    });
  } catch (error) {
    return res.status(500).json({ error: String(error.message || error) });
  }
}
