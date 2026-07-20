// Vercel Serverless Function —— 健康数据接收/读取(配合 iPhone 快捷指令全自动同步)
// 放到 api 文件夹,命名为 health.js,即 /api/health
//
// 需要的环境变量(Vercel → Settings → Environment Variables):
//   HEALTH_TOKEN               = 你自己编的一串随机字符(快捷指令和浏览器都要用它)
//   UPSTASH_REDIS_REST_URL     = Upstash 集成自动添加
//   UPSTASH_REDIS_REST_TOKEN   = Upstash 集成自动添加
//
// 快捷指令 POST(纯文本行,一行一条):
//   POST /api/health?token=XXX&metric=steps      body: 2026-07-19,8234
//   POST /api/health?token=XXX&metric=sleep      body: 2026-07-18T23:10:00+08:00|2026-07-19T06:40:00+08:00|核心睡眠
//   POST /api/health?token=XXX&metric=workouts   body: 2026-07-19,跑步,42,6.1   (日期,类型,分钟,公里)
// 网页 GET:
//   GET /api/health?token=XXX   → { steps:{date:count}, sleep:[...], workouts:[...], updatedAt }

const KEEP_DAYS = 120;

async function redis(cmd) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error("Upstash 未配置");
  const r = await fetch(url, {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify(cmd),
  });
  const data = await r.json();
  if (data.error) throw new Error(data.error);
  return data.result;
}

const cutoff = () => {
  const d = new Date(); d.setDate(d.getDate() - KEEP_DAYS);
  return d.toISOString().slice(0, 10);
};

// 同样把超时提到 Hobby 允许的最大值,避免快捷指令一次推送较多行数据时被平台掐断。
export const config = { maxDuration: 60 };

// —— 简易限流:同一 IP 一段时间内限次数,没配置也不影响正常使用 ——
async function rateLimited(req, res, bucket, limit, windowSec) {
  try {
    const ip = ((req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "unknown") + "").split(",")[0].trim();
    const key = "rl:" + bucket + ":" + ip;
    const count = await redis(["INCR", key]);
    if (count === 1) redis(["EXPIRE", key, windowSec]).catch(() => {});
    if (count > limit) {
      res.setHeader("Retry-After", String(windowSec));
      res.status(429).json({ error: "请求太频繁,请稍后再试。" });
      return true;
    }
    return false;
  } catch (e) { return false; } // Upstash 没配好时不能因为限流本身报错就把正常请求也拦下
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (await rateLimited(req, res, "health", req.method === "GET" ? 120 : 40, 600)) return; // 10 分钟内 GET 120 次 / POST 40 次

  const token = process.env.HEALTH_TOKEN;
  const given = (req.query.token || "").toString();
  if (!token) return res.status(500).json({ error: "服务器未配置 HEALTH_TOKEN" });
  if (given !== token) return res.status(401).json({ error: "token 不对" });

  try {
    if (req.method === "GET") {
      const raw = await redis(["GET", "arinrin:health"]);
      const data = raw ? JSON.parse(raw) : { steps: {}, sleep: [], workouts: [] };
      return res.status(200).json(data);
    }

    if (req.method !== "POST") return res.status(405).json({ error: "只支持 GET / POST" });

    const metric = (req.query.metric || "").toString();
    if (["steps", "sleep", "workouts"].indexOf(metric) < 0) {
      return res.status(400).json({ error: "metric 必须是 steps | sleep | workouts" });
    }

    let body = req.body;
    if (typeof body !== "string") body = body ? String(body) : "";
    if (body.length > 200000) return res.status(413).json({ error: "内容过长" });
    const lines = body.split(/\r?\n/).map(s => s.trim()).filter(Boolean);

    const raw = await redis(["GET", "arinrin:health"]);
    const data = raw ? JSON.parse(raw) : { steps: {}, sleep: [], workouts: [] };
    const cut = cutoff();

    if (metric === "steps") {
      // 每行:日期,数值。同一天多条(碎片样本)累加;重复整推时以最后一次为准 → 用临时桶
      const bucket = {};
      lines.forEach(l => {
        const m = l.split(",");
        const date = (m[0] || "").slice(0, 10);
        const v = parseFloat(m[1]);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !isFinite(v)) return;
        bucket[date] = (bucket[date] || 0) + v;
      });
      Object.keys(bucket).forEach(d => { data.steps[d] = Math.round(bucket[d]); });
      Object.keys(data.steps).forEach(d => { if (d < cut) delete data.steps[d]; });
    }

    if (metric === "sleep") {
      // 每行:开始|结束|阶段。按 start+end 去重
      const seen = {};
      (data.sleep || []).forEach(s => { seen[s.start + "|" + s.end] = true; });
      lines.forEach(l => {
        const m = l.split("|");
        if (m.length < 2) return;
        const start = m[0].trim(), end = m[1].trim(), stage = (m[2] || "").trim();
        if (!start || !end || seen[start + "|" + end]) return;
        seen[start + "|" + end] = true;
        data.sleep.push({ start, end, stage });
      });
      data.sleep = data.sleep.filter(s => (s.end || "").slice(0, 10) >= cut).slice(-2000);
    }

    if (metric === "workouts") {
      // 每行:日期,类型,分钟,公里。按 日期+类型+分钟 去重
      const seen = {};
      (data.workouts || []).forEach(w => { seen[w.date + "|" + w.type + "|" + w.min] = true; });
      lines.forEach(l => {
        const m = l.split(",");
        const date = (m[0] || "").slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
        const type = (m[1] || "").trim() || "运动";
        const min = Math.round(parseFloat(m[2]) || 0);
        const km = Math.round((parseFloat(m[3]) || 0) * 100) / 100;
        const k = date + "|" + type + "|" + min;
        if (seen[k]) return;
        seen[k] = true;
        data.workouts.push({ date, type, min, km });
      });
      data.workouts = data.workouts.filter(w => w.date >= cut).slice(-800);
    }

    data.updatedAt = new Date().toISOString();
    await redis(["SET", "arinrin:health", JSON.stringify(data)]);
    return res.status(200).json({ ok: true, metric, added: lines.length, updatedAt: data.updatedAt });
  } catch (e) {
    return res.status(502).json({ error: "存储服务出错", detail: String(e.message || e) });
  }
}
