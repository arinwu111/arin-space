// Vercel Serverless Function —— 信箱留言与审核
//
// 需要的环境变量：
//   UPSTASH_REDIS_REST_URL
//   UPSTASH_REDIS_REST_TOKEN
//   MAILBOX_ADMIN_TOKEN       站长开箱审核时使用的口令

const MESSAGE_HASH = "arinrin:mailbox:messages";
const PENDING_ZSET = "arinrin:mailbox:pending";
const APPROVED_ZSET = "arinrin:mailbox:approved";
const MAX_PUBLIC = 60;
const MAX_ADMIN = 100;

export const config = { maxDuration: 30 };

async function redis(command) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error("留言存储尚未配置");
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(command),
  });
  if (!response.ok) throw new Error("存储服务暂时不可用");
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

function newId() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
}

async function messagesFor(key, limit) {
  const ids = await redis(["ZREVRANGE", key, 0, limit - 1]);
  if (!Array.isArray(ids) || !ids.length) return [];
  const raw = await redis(["HMGET", MESSAGE_HASH, ...ids]);
  return (raw || []).map((item) => {
    try { return item ? JSON.parse(item) : null; } catch (_) { return null; }
  }).filter(Boolean);
}

async function rateLimited(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "unknown");
  const ip = forwarded.split(",")[0].trim().slice(0, 80);
  const key = "rl:mailbox:" + ip;
  const count = Number(await redis(["INCR", key]));
  if (count === 1) await redis(["EXPIRE", key, 600]);
  return count > 5;
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
        if (!process.env.MAILBOX_ADMIN_TOKEN) {
          return res.status(503).json({ error: "服务器尚未配置管理员口令" });
        }
        if (!isAdmin(req)) return res.status(401).json({ error: "管理员口令不正确" });
        const [pending, approved] = await Promise.all([
          messagesFor(PENDING_ZSET, MAX_ADMIN),
          messagesFor(APPROVED_ZSET, MAX_ADMIN),
        ]);
        return res.status(200).json({ pending, approved });
      }
      const messages = await messagesFor(APPROVED_ZSET, MAX_PUBLIC);
      return res.status(200).json({ messages });
    }

    if (req.method !== "POST") return res.status(405).json({ error: "只支持 GET / POST" });
    const body = getBody(req);

    if (body.action) {
      if (!process.env.MAILBOX_ADMIN_TOKEN) {
        return res.status(503).json({ error: "服务器尚未配置管理员口令" });
      }
      if (!isAdmin(req)) return res.status(401).json({ error: "管理员口令不正确" });
      const id = cleanText(body.id, 80, false);
      const action = cleanText(body.action, 20, false);
      if (!id || !["approve", "reject", "delete"].includes(action)) {
        return res.status(400).json({ error: "审核操作无效" });
      }
      const raw = await redis(["HGET", MESSAGE_HASH, id]);
      if (!raw) return res.status(404).json({ error: "没有找到这条留言" });
      let message;
      try { message = JSON.parse(raw); } catch (_) { return res.status(500).json({ error: "留言数据损坏" }); }

      await redis(["ZREM", PENDING_ZSET, id]);
      if (action === "approve") {
        message.status = "approved";
        message.approvedAt = new Date().toISOString();
        await redis(["HSET", MESSAGE_HASH, id, JSON.stringify(message)]);
        await redis(["ZADD", APPROVED_ZSET, Date.now(), id]);
      } else {
        await redis(["ZREM", APPROVED_ZSET, id]);
        await redis(["HDEL", MESSAGE_HASH, id]);
      }
      return res.status(200).json({ ok: true, action, id });
    }

    if (body.website) return res.status(200).json({ ok: true, pending: true });
    if (await rateLimited(req)) {
      res.setHeader("Retry-After", "600");
      return res.status(429).json({ error: "投递有点频繁，请稍后再试。" });
    }

    const nickname = cleanText(body.nickname, 24, false) || "一位路过的人";
    const content = cleanText(body.message, 280, true);
    if (content.length < 2) return res.status(400).json({ error: "留言至少写两个字。" });

    const now = new Date();
    const message = {
      id: newId(),
      nickname,
      message: content,
      status: "pending",
      createdAt: now.toISOString(),
    };
    await redis(["HSET", MESSAGE_HASH, message.id, JSON.stringify(message)]);
    await redis(["ZADD", PENDING_ZSET, now.getTime(), message.id]);
    return res.status(201).json({ ok: true, pending: true });
  } catch (error) {
    return res.status(503).json({ error: String(error.message || error) });
  }
}
