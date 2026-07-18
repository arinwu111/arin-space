// Vercel Serverless Function —— 日历(iCal/ICS)中转
// 放到 api 文件夹,命名为 calendar.js,即 /api/calendar
//
// 用法:POST /api/calendar  body: { "url": "<你的ics链接>", "days": 1 }
// 用 POST 而不是 GET,是为了让链接不出现在服务器访问日志里(隐私考虑)。
//
// 安全措施(防止被人当免费代理 / 探测内网):
//   1) 只允许 http/https,拒绝 file: ftp: 等协议
//   2) 拒绝 localhost、私有网段、云厂商元数据地址
//   3) 10 秒超时,最大 2MB,防止被拖住或塞爆内存
//   4) 响应必须看起来像日历,否则丢弃

const MAX_BYTES = 2 * 1024 * 1024;   // 2MB 上限
const TIMEOUT_MS = 10000;            // 10 秒超时

// 拒绝内网 / 本机 / 云元数据地址
function isBlockedHost(hostname) {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local")) return true;
  if (h === "metadata.google.internal") return true;
  // IPv6 本机
  if (h === "::1" || h === "[::1]") return true;
  // IPv4 字面量:检查私有段
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = +m[1], b = +m[2];
    if (a === 127 || a === 0 || a === 10) return true;              // 本机 / 私有
    if (a === 172 && b >= 16 && b <= 31) return true;               // 私有
    if (a === 192 && b === 168) return true;                        // 私有
    if (a === 169 && b === 254) return true;                        // 链路本地(含云元数据)
    if (a >= 224) return true;                                      // 组播 / 保留
  }
  return false;
}

function unfold(text) {
  return text.replace(/\r\n[ \t]/g, "").replace(/\n[ \t]/g, "");
}

function parseDT(v) {
  const m = v.match(/(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?/);
  if (!m) return null;
  const [, y, mo, d, hh, mi, ss, z] = m;
  const allDay = !hh;
  const date = z
    ? new Date(Date.UTC(+y, +mo - 1, +d, +(hh || 0), +(mi || 0), +(ss || 0)))
    : new Date(+y, +mo - 1, +d, +(hh || 0), +(mi || 0), +(ss || 0));
  return { date, allDay };
}

function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "只支持 POST" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  let raw_url = body && body.url;
  const days = body && body.days;
  if (!raw_url) return res.status(400).json({ error: "缺少日历链接" });

  raw_url = String(raw_url).trim().replace(/^webcal:\/\//i, "https://");
  if (raw_url.length > 2000) return res.status(400).json({ error: "链接过长" });

  // —— 安全校验 ——
  let target;
  try { target = new URL(raw_url); } catch (e) {
    return res.status(400).json({ error: "链接格式不正确" });
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    return res.status(400).json({ error: "只支持 http/https 链接" });
  }
  if (isBlockedHost(target.hostname)) {
    return res.status(400).json({ error: "不允许访问该地址" });
  }

  const range = Math.min(parseInt(days, 10) || 1, 31);

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    const r = await fetch(target.toString(), {
      headers: { "User-Agent": "Mozilla/5.0", Accept: "text/calendar,*/*" },
      redirect: "follow",
      signal: ctrl.signal,
    });
    clearTimeout(timer);

    if (!r.ok) return res.status(502).json({ error: "无法读取该日历链接(状态 " + r.status + ")" });

    // 大小上限:先看声明的长度,再按实际读入截断
    const declared = parseInt(r.headers.get("content-length") || "0", 10);
    if (declared && declared > MAX_BYTES) {
      return res.status(413).json({ error: "日历文件过大" });
    }
    let text = await r.text();
    if (text.length > MAX_BYTES) text = text.slice(0, MAX_BYTES);

    const raw = unfold(text);
    if (!raw.includes("BEGIN:VCALENDAR")) {
      return res.status(400).json({ error: "这不是一个有效的 .ics 日历链接" });
    }

    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const end = new Date(start.getTime() + range * 86400000);

    const blocks = raw.split("BEGIN:VEVENT").slice(1);
    const events = [];

    for (const b of blocks) {
      const bodyTxt = b.split("END:VEVENT")[0];
      const get = (key) => {
        const m = bodyTxt.match(new RegExp("^" + key + "[^:\\r\\n]*:(.*)$", "mi"));
        return m ? m[1].trim() : "";
      };
      const summary = get("SUMMARY");
      if (!summary) continue;
      const dtRaw = get("DTSTART");
      if (!dtRaw) continue;
      const dt = parseDT(dtRaw);
      if (!dt) continue;
      const location = get("LOCATION");
      const rrule = get("RRULE");

      const push = (d) => {
        if (d >= start && d < end) {
          events.push({
            title: summary.replace(/\\,/g, ",").replace(/\\n/g, " ").slice(0, 200),
            location: location.replace(/\\,/g, ",").slice(0, 200),
            start: d.toISOString(),
            allDay: dt.allDay,
            isToday: sameDay(d, now),
          });
        }
      };

      if (!rrule) {
        push(dt.date);
      } else {
        const freq = (rrule.match(/FREQ=(\w+)/) || [])[1];
        const interval = parseInt((rrule.match(/INTERVAL=(\d+)/) || [])[1] || "1", 10);
        const untilRaw = (rrule.match(/UNTIL=([\dTZ]+)/) || [])[1];
        const until = untilRaw ? parseDT(untilRaw).date : null;
        let cur = new Date(dt.date);
        let guard = 0;
        while (cur < end && guard++ < 500) {
          if (until && cur > until) break;
          push(cur);
          const n = new Date(cur);
          if (freq === "DAILY") n.setDate(n.getDate() + interval);
          else if (freq === "WEEKLY") n.setDate(n.getDate() + 7 * interval);
          else if (freq === "MONTHLY") n.setMonth(n.getMonth() + interval);
          else if (freq === "YEARLY") n.setFullYear(n.getFullYear() + interval);
          else break;
          cur = n;
        }
      }
    }

    events.sort((a, b) => new Date(a.start) - new Date(b.start));
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ events: events.slice(0, 60) });
  } catch (e) {
    const msg = (e && e.name === "AbortError") ? "读取超时" : "读取日历失败";
    return res.status(502).json({ error: msg });
  }
}
