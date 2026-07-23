// 每天北京时间 08:00 检查昨天的 GitHub 变更，并自动写一篇公开日志。
// Vercel Cron 使用 UTC，因此 vercel.json 中配置为每天 00:00 UTC。

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_REPOSITORY = "arinwu111/arin-space";
const MAX_JOURNAL_CONTENT = 800;
const MAX_CHANGE_DETAILS = 14000;

export const config = { maxDuration: 60 };

function authorized(req) {
  const secret = process.env.CRON_SECRET || "";
  const supplied = String(req.headers.authorization || "");
  return Boolean(secret && supplied === "Bearer " + secret);
}

function windowForDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("日志日期格式不正确");
  const [year, month, day] = date.split("-").map(Number);
  const localMidnightAsUtc = Date.UTC(year, month - 1, day);
  const normalized = new Date(localMidnightAsUtc).toISOString().slice(0, 10);
  if (normalized !== date) throw new Error("日志日期不存在");
  const start = new Date(localMidnightAsUtc - SHANGHAI_OFFSET_MS);
  const end = new Date(start.getTime() + DAY_MS);
  return { date, start: start.toISOString(), end: end.toISOString() };
}

function targetWindow(now = new Date()) {
  const shanghaiToday = new Date(now.getTime() + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10);
  const [year, month, day] = shanghaiToday.split("-").map(Number);
  const yesterday = new Date(Date.UTC(year, month - 1, day) - DAY_MS).toISOString().slice(0, 10);
  return windowForDate(yesterday);
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

function usefulPatchLine(line) {
  const value = String(line || "");
  if (!/^[+-]/.test(value) || /^(?:\+\+\+|---)/.test(value)) return "";
  if (/data:image\/|base64,|^[+-]\s*[A-Za-z0-9+/=]{240,}\s*$/.test(value)) return "";
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length < 3) return "";
  return compact.length > 520 ? compact.slice(0, 520) + "…" : compact;
}

function distributedPatchSummary(file, maxLines = 80) {
  const lines = String(file.patch || "").split("\n").map(usefulPatchLine).filter(Boolean);
  if (!lines.length) return [file.status, file.filename].filter(Boolean).join("\n");
  if (lines.length <= maxLines) {
    return [file.status, file.filename, lines.join("\n")].filter(Boolean).join("\n");
  }
  const sampled = [];
  for (let index = 0; index < maxLines; index += 1) {
    sampled.push(lines[Math.floor(index * (lines.length - 1) / (maxLines - 1))]);
  }
  return [
    file.status,
    file.filename,
    "（以下为覆盖整份差异的抽样，共 " + lines.length + " 行有效变化）",
    sampled.join("\n"),
  ].filter(Boolean).join("\n");
}

function detectChangeThemes(files) {
  const joined = files.map(file => [file.filename, file.patch].join("\n")).join("\n").toLowerCase();
  const themes = [];
  const add = (pattern, label) => {
    if (pattern.test(joined) && !themes.includes(label)) themes.push(label);
  };
  add(/podcast|rss|播客|小宇宙|apple podcast/, "播客获取、转写或阅读体验");
  add(/video|tutorial|transcrib|tingwu|oss|视频|教程|听悟|转写/, "视频教程与转写整理体验");
  add(/journal|日志|cron/, "网站日志与自动记录");
  add(/message|mailbox|信箱|留言/, "信箱与留言阅读体验");
  add(/security|rate.?limit|owner.?token|admin.?token|sanitize|安全|权限|口令|限流/, "访问权限与隐私保护");
  add(/aihot|快讯|日报|精选|往期/, "AI 资讯阅读");
  add(/meditat|zen|冥想|呼吸|白噪音/, "冥想小屋");
  add(/paper|article|study|论文|书房/, "书房与资料阅读");
  add(/morning|evening|daily|晨间|晚间|复盘|日记/, "晨间准备与晚间复盘");
  add(/invest|stock|quote|投资|行情|自选股/, "投资与行情");
  return themes;
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
  const includedFiles = files.slice(0, 30);
  const perFileBudget = Math.max(500, Math.floor(MAX_CHANGE_DETAILS / Math.max(1, includedFiles.length)) - 2);
  const fileSummary = includedFiles
    .map(file => distributedPatchSummary(file).slice(0, perFileBudget))
    .join("\n\n");
  return {
    count: commits.length,
    messages,
    files: files.map(file => file.filename),
    themes: detectChangeThemes(files),
    details: fileSummary.slice(0, MAX_CHANGE_DETAILS),
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
  const subject = themes.length ? themes.join("、") : "一些不起眼的细节";
  return {
    title: "小世界又长大一点",
    content: "今天继续整理这个小世界，主要照看了" + subject + "。做的多是一些细小调整，但它们让这里用起来更顺手，也留下了慢慢变好的痕迹。",
  };
}

function parseAIEntry(text) {
  const cleaned = String(text || "").replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("AI 没有返回日志格式");
  const parsed = JSON.parse(match[0]);
  const title = String(parsed.title || "").replace(/\s+/g, " ").trim().slice(0, 60);
  const content = String(parsed.content || "").replace(/\r\n?/g, "\n").trim().slice(0, MAX_JOURNAL_CONTENT);
  if (!title || !content) throw new Error("AI 返回了空日志");
  return { title, content };
}

async function generateEntry(req, date, changes) {
  const fallback = fallbackEntry(changes);
  const hasDirectKey = Boolean(process.env.JOURNAL_AI_API_KEY);
  const hasOwnerAI = Boolean(process.env.OWNER_TOKEN);
  if (!hasDirectKey && !hasOwnerAI) return { ...fallback, generatedBy: "template" };

  const prompt = `根据下面这一天的网站代码变更，写一篇发布在个人网站上的温情开发日志。
日期：${date}
提交说明：${changes.messages.join("；").slice(0, 2400) || "未填写"}
变更文件：${changes.files.join("、").slice(0, 2000)}
从完整差异中识别出的主要方向：${(changes.themes || []).join("、") || "请根据差异判断"}
当天累计代码差异：
${changes.details}

要求：
1. 先通读全部差异，找出当天几个主要改进方向。重复修改同一功能时合并描述，尤其不要遗漏“主要方向”中有明确差异支撑的内容。
2. 正文使用简体中文，只写一个自然连贯的小段落，共 2—3 句话；不要分点、不要编号，也不要逐项罗列功能清单。
3. 第一部分自然带过当天做了哪些主要改进，以及使用体验发生了什么变化；相关方向可以合并在一句话里。最后一句写这一天的感受或这些变化对小世界的意义。
4. 保持个人搭建网站的温情口吻，但事实优先。直接使用“播客、视频、信箱、日志”等清楚的名称，不要用门窗、砖块、花园等比喻代替具体内容。
5. 只写能从差异中确认的事情，不夸大，不出现 commit、API、代码、部署、接口、数据库等技术词。技术性调整可表达为“使用更稳定”“访问更安全”，但不要写得神秘。
6. 正文通常 120—260 个汉字，最多 350 字；变化很多时概括主要方向，不写流水账。
7. 给出一个温柔、简短、能概括当天变化的标题。
8. 只返回合法 JSON：{"title":"...","content":"..."}。`;

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
        maxTokens: 1200,
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
    const requestedDate = String(req.query && req.query.date || "").trim();
    const window = requestedDate ? windowForDate(requestedDate) : targetWindow();
    const force = String(req.query && req.query.force || "") === "1";
    const publicJournal = await journalRequest(req, "/api/journal");
    const existingEntry = (publicJournal.entries || []).find(entry => entry.date === window.date);
    if (!force && existingEntry) {
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
        id: force && existingEntry ? existingEntry.id : "auto-" + window.date,
        date: window.date,
        title: entry.title,
        content: entry.content,
      }),
    });
    return res.status(201).json({
      ok: true,
      date: window.date,
      commits: changes.count,
      regenerated: force,
      generatedBy: entry.generatedBy,
      entry: saved.entry,
    });
  } catch (error) {
    return res.status(500).json({ error: String(error.message || error) });
  }
}
