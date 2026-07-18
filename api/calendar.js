// Vercel Serverless Function —— 日历(iCal/ICS)中转
// 放到 api 文件夹,命名为 calendar.js,即 /api/calendar
//
// 作用:替网页去读一个 .ics 日历订阅链接(如 iCloud 公开日历),解析出近几天的事项。
// 隐私:日历链接由前端传入(存在用户自己浏览器里),服务器不存储、不记录。
//
// 用法:POST /api/calendar  body: { "url": "<你的ics链接>", "days": 7 }
// 用 POST 而不是 GET,是为了让链接不出现在服务器访问日志里(隐私考虑)。

function unfold(text) {
  // ICS 折行:以空格或制表符开头的行是上一行的延续
  return text.replace(/\r\n[ \t]/g, "").replace(/\n[ \t]/g, "");
}

function parseDT(v) {
  // 支持 20260718T093000Z / 20260718T093000 / 20260718
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
  let url = body && body.url;
  const days = body && body.days;
  if (!url) return res.status(400).json({ error: "缺少日历链接" });
  url = String(url).replace(/^webcal:\/\//i, "https://"); // webcal:// → https://
  const range = Math.min(parseInt(days, 10) || 7, 31);

  try {
    const r = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0", Accept: "text/calendar,*/*" },
    });
    if (!r.ok) return res.status(502).json({ error: "无法读取该日历链接(状态 " + r.status + ")" });
    const raw = unfold(await r.text());
    if (!raw.includes("BEGIN:VCALENDAR")) {
      return res.status(400).json({ error: "这不是一个有效的 .ics 日历链接" });
    }

    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const end = new Date(start.getTime() + range * 86400000);

    const blocks = raw.split("BEGIN:VEVENT").slice(1);
    const events = [];

    for (const b of blocks) {
      const body = b.split("END:VEVENT")[0];
      const get = (key) => {
        const m = body.match(new RegExp("^" + key + "[^:\\r\\n]*:(.*)$", "mi"));
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
            title: summary.replace(/\\,/g, ",").replace(/\\n/g, " "),
            location: location.replace(/\\,/g, ","),
            start: d.toISOString(),
            allDay: dt.allDay,
            isToday: sameDay(d, now),
          });
        }
      };

      if (!rrule) {
        push(dt.date);
      } else {
        // 简单展开重复事件(DAILY/WEEKLY/MONTHLY/YEARLY),只在查询范围内展开
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
    res.setHeader("Cache-Control", "no-store"); // 含个人日程,不缓存
    return res.status(200).json({ events: events.slice(0, 60) });
  } catch (e) {
    return res.status(502).json({ error: "读取日历失败", detail: String(e) });
  }
}
