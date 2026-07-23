import { randomUUID, timingSafeEqual } from "node:crypto";
import OSS from "ali-oss";
import TingwuModule, {
  CreateTaskRequest,
  CreateTaskRequestInput,
  CreateTaskRequestParameters,
  CreateTaskRequestParametersTranscription,
  CreateTaskRequestParametersTranscriptionDiarization,
} from "@alicloud/tingwu20230930";
import {
  HttpError,
  applyCors,
  assertPublicHttpUrl,
  fetchPublicUrl,
  rateLimited,
  readTextLimited,
  sendHttpError,
} from "../lib/api-security.js";

export const config = { maxDuration: 60 };

const TEMP_PREFIX = "tingwu-temp/";
const MAX_VIDEO_BYTES = 6 * 1024 * 1024 * 1024;
const SUPPORTED_VIDEO = new Set(["mp4", "mov", "mkv", "webm", "m4v", "avi", "mpeg", "mpg", "3gp", "ogg"]);
const TingwuClient = typeof TingwuModule === "function" ? TingwuModule : TingwuModule.default;

const ENV_ALIASES = {
  ALIYUN_ACCESS_KEY_ID: ["ALIYUN_ACCESS_KEY_ID", "ALIBABA_CLOUD_ACCESS_KEY_ID"],
  ALIYUN_ACCESS_KEY_SECRET: ["ALIYUN_ACCESS_KEY_SECRET", "ALIBABA_CLOUD_ACCESS_KEY_SECRET"],
};

const ENV_ERRORS = {
  OWNER_TOKEN: "Vercel 尚未配置 OWNER_TOKEN",
  ALIYUN_ACCESS_KEY_ID: "Vercel 的阿里云 AccessKey ID 尚未配置",
  ALIYUN_ACCESS_KEY_SECRET: "Vercel 的阿里云 AccessKey Secret 尚未配置",
  ALIYUN_OSS_BUCKET: "Vercel 尚未配置 ALIYUN_OSS_BUCKET",
  ALIYUN_OSS_REGION: "Vercel 尚未配置 ALIYUN_OSS_REGION",
  TINGWU_APP_KEY: "Vercel 尚未配置 TINGWU_APP_KEY",
};

function env(name) {
  const names = ENV_ALIASES[name] || [name];
  const value = names.map(key => String(process.env[key] || "").trim()).find(Boolean) || "";
  if (!value) throw new HttpError(503, ENV_ERRORS[name] || `Vercel 缺少 ${name}`);
  return value;
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  return left.length === right.length && timingSafeEqual(left, right);
}

function requireOwner(req) {
  const expected = env("OWNER_TOKEN");
  const given = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!safeEqual(given, expected)) throw new HttpError(401, "主人口令不正确");
}

function bodyOf(req) {
  if (!req.body) return {};
  if (typeof req.body === "object") return req.body;
  try { return JSON.parse(req.body); } catch (_) { throw new HttpError(400, "请求内容格式不正确"); }
}

function ossClient() {
  let region = env("ALIYUN_OSS_REGION");
  if (/^cn-[a-z0-9-]+$/i.test(region)) region = `oss-${region}`;
  return new OSS({
    accessKeyId: env("ALIYUN_ACCESS_KEY_ID"),
    accessKeySecret: env("ALIYUN_ACCESS_KEY_SECRET"),
    bucket: env("ALIYUN_OSS_BUCKET"),
    region,
    authorizationV4: true,
    secure: true,
  });
}

function tingwuClient() {
  if (typeof TingwuClient !== "function") throw new HttpError(503, "听悟 SDK 加载失败");
  return new TingwuClient({
    accessKeyId: env("ALIYUN_ACCESS_KEY_ID"),
    accessKeySecret: env("ALIYUN_ACCESS_KEY_SECRET"),
    endpoint: "tingwu.cn-beijing.aliyuncs.com",
    regionId: "cn-beijing",
    protocol: "https",
    connectTimeout: 10000,
    readTimeout: 30000,
  });
}

function cleanName(value, fallback = "untitled") {
  return String(value || fallback)
    .normalize("NFKC")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120) || fallback;
}

function videoExtension(filename) {
  const match = String(filename || "").toLowerCase().match(/\.([a-z0-9]{2,5})$/);
  const ext = match && match[1];
  if (!ext || !SUPPORTED_VIDEO.has(ext)) throw new HttpError(400, "这个视频格式暂不支持");
  return ext;
}

async function createUpload(body) {
  const filename = cleanName(body.filename, "video.mp4");
  const size = Number(body.size || 0);
  if (!Number.isFinite(size) || size <= 0 || size > MAX_VIDEO_BYTES) throw new HttpError(400, "视频大小不正确或超过 6 GB");
  const ext = videoExtension(filename);
  const requestedType = String(body.type || "").trim().toLowerCase();
  const contentType = /^video\/[a-z0-9.+-]+$/.test(requestedType) ? requestedType : "application/octet-stream";
  const date = new Date().toISOString().slice(0, 10);
  const objectKey = `${TEMP_PREFIX}${date}/${randomUUID()}.${ext}`;
  const client = ossClient();
  const uploadUrl = await client.signatureUrlV4("PUT", 15 * 60, { headers: { "Content-Type": contentType } }, objectKey);
  const sourceUrl = await client.signatureUrlV4("GET", 6 * 60 * 60, { headers: {} }, objectKey);
  return { uploadUrl, sourceUrl, objectKey, expiresIn: 900, uploadHeaders: { "Content-Type": contentType } };
}

function decodeXml(value) {
  const named = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " " };
  return String(value || "")
    .replace(/^<!\[CDATA\[|\]\]>$/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi, (_, entity) => {
      if (entity[0] !== "#") return named[entity.toLowerCase()] || "";
      const hex = entity[1].toLowerCase() === "x";
      const code = parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : "";
    })
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function xmlValue(block, tag) {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = block.match(new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escaped}>`, "i"));
  return decodeXml(match ? match[1] : "");
}

function xmlAttr(block, tag, attr) {
  const escapedTag = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const element = block.match(new RegExp(`<${escapedTag}\\b[^>]*>`, "i"));
  if (!element) return "";
  const escapedAttr = attr.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const value = element[0].match(new RegExp(`\\b${escapedAttr}\\s*=\\s*["']([^"']+)["']`, "i"));
  return decodeXml(value ? value[1] : "");
}

function comparable(value) {
  return String(value || "").toLowerCase().replace(/[\s·・\-—–_|｜:：,，.。'"“”‘’()[\]【】]/g, "");
}

function podcastEpisodeFromRss(xml, wantedTitle) {
  const items = String(xml || "").match(/<item\b[\s\S]*?<\/item>/gi) || [];
  if (!items.length) throw new HttpError(422, "这个 RSS 中没有找到播客单集");
  const wanted = comparable(wantedTitle);
  const episodes = items.map(item => ({
    title: xmlValue(item, "title"),
    publishedAt: xmlValue(item, "pubDate"),
    duration: xmlValue(item, "itunes:duration"),
    audioUrl: xmlAttr(item, "enclosure", "url") || xmlAttr(item, "media:content", "url"),
  })).filter(item => item.audioUrl);
  if (!episodes.length) throw new HttpError(422, "这个 RSS 中没有可转写的音频地址");
  if (!wanted) return episodes[0];
  const exact = episodes.find(item => comparable(item.title) === wanted);
  const partial = episodes.find(item => {
    const title = comparable(item.title);
    return title && (title.includes(wanted) || wanted.includes(title));
  });
  const matched = exact || partial;
  if (!matched) throw new HttpError(422, "RSS 中没有找到这期播客，请检查单集链接");
  return matched;
}

async function resolvePodcastAudio(rssUrl, episodeTitle) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 18000);
  try {
    const { response } = await fetchPublicUrl(rssUrl, {
      signal: controller.signal,
      headers: { Accept: "application/rss+xml, application/xml, text/xml", "User-Agent": "arinrin-space/1.0" },
    });
    if (!response.ok) throw new HttpError(422, "播客 RSS 暂时无法读取");
    const episode = podcastEpisodeFromRss(await readTextLimited(response, 5_000_000), episodeTitle);
    await assertPublicHttpUrl(episode.audioUrl);
    return episode;
  } finally {
    clearTimeout(timer);
  }
}

async function createTask(body) {
  const kind = body.kind === "video" ? "video" : body.kind === "podcast" ? "podcast" : "";
  if (!kind) throw new HttpError(400, "转写类型不正确");
  let sourceUrl = String(body.sourceUrl || "").trim();
  let title = cleanName(body.title, kind === "podcast" ? "播客" : "视频");
  let episode = null;
  if (kind === "podcast") {
    const rssUrl = String(body.rssUrl || "").trim();
    if (sourceUrl) {
      if (sourceUrl.length > 5000) throw new HttpError(400, "播客音频地址过长");
      await assertPublicHttpUrl(sourceUrl);
      episode = {
        title: cleanName(body.episodeTitle, title),
        publishedAt: String(body.publishedAt || "").slice(0, 80),
        duration: Number(body.durationMs || 0),
      };
    } else {
      if (!rssUrl) throw new HttpError(400, "缺少播客 RSS 或音频地址");
      episode = await resolvePodcastAudio(rssUrl, body.episodeTitle);
      sourceUrl = episode.audioUrl;
    }
    title = cleanName(episode.title || title, title);
  } else {
    if (!sourceUrl || sourceUrl.length > 5000) throw new HttpError(400, "缺少视频地址");
    await assertPublicHttpUrl(sourceUrl);
  }

  const input = new CreateTaskRequestInput({
    sourceLanguage: "fspk",
    fileUrl: sourceUrl,
    taskKey: `arin-space-${kind}-${Date.now()}`,
  });
  const transcription = new CreateTaskRequestParametersTranscription({
    diarizationEnabled: true,
    diarization: new CreateTaskRequestParametersTranscriptionDiarization({ speakerCount: kind === "podcast" ? 2 : 0 }),
  });
  const request = new CreateTaskRequest({
    type: "offline",
    operation: "start",
    appKey: env("TINGWU_APP_KEY"),
    input,
    parameters: new CreateTaskRequestParameters({ transcription }),
  });
  const response = await tingwuClient().createTask(request);
  const result = response && response.body;
  if (!result || String(result.code) !== "0" || !result.data || !result.data.taskId) {
    throw new HttpError(502, (result && result.message) || "听悟没有成功创建任务");
  }
  return {
    taskId: result.data.taskId,
    status: result.data.taskStatus || "ONGOING",
    title,
    duration: episode && episode.duration,
    publishedAt: episode && episode.publishedAt,
  };
}

function clock(ms) {
  const seconds = Math.max(0, Math.floor(Number(ms || 0) / 1000));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return [h, m, s].map(value => String(value).padStart(2, "0")).join(":");
}

function transcriptText(payload) {
  const transcription = payload && (payload.Transcription || payload.transcription);
  const paragraphs = transcription && (transcription.Paragraphs || transcription.paragraphs);
  if (!Array.isArray(paragraphs) || !paragraphs.length) throw new HttpError(502, "听悟返回的转写文稿为空");
  const lines = paragraphs.map(paragraph => {
    const words = paragraph.Words || paragraph.words || [];
    const text = words.map(word => word.Text || word.text || "").join("").trim();
    if (!text) return "";
    const start = words.length ? (words[0].Start ?? words[0].start ?? 0) : 0;
    const speaker = paragraph.SpeakerId ?? paragraph.speakerId;
    return `[${clock(start)}]${speaker !== undefined && speaker !== "" ? ` 说话人 ${speaker}：` : " "}${text}`;
  }).filter(Boolean);
  if (!lines.length) throw new HttpError(502, "听悟返回的转写文稿为空");
  const audioInfo = transcription.AudioInfo || transcription.audioInfo || {};
  return { transcript: lines.join("\n\n"), durationMs: Number(audioInfo.Duration || audioInfo.duration || 0), language: audioInfo.Language || audioInfo.language || "" };
}

async function fetchTranscript(url) {
  const safeUrl = String(url || "").replace(/&amp;/g, "&");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  try {
    const { response } = await fetchPublicUrl(safeUrl, { signal: controller.signal, headers: { Accept: "application/json" } });
    if (!response.ok) throw new HttpError(502, "听悟转写结果暂时无法下载");
    const text = await readTextLimited(response, 20_000_000);
    try { return transcriptText(JSON.parse(text)); }
    catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(502, "听悟转写结果格式无法识别"); }
  } finally {
    clearTimeout(timer);
  }
}

function validObjectKey(value) {
  const key = String(value || "");
  return key.startsWith(TEMP_PREFIX) && key.length < 300 && !key.includes("..") && /^[a-zA-Z0-9_./-]+$/.test(key) ? key : "";
}

async function taskStatus(taskId, objectKey) {
  if (!/^[a-zA-Z0-9_-]{8,100}$/.test(taskId)) throw new HttpError(400, "任务编号不正确");
  const response = await tingwuClient().getTaskInfo(taskId);
  const result = response && response.body;
  if (!result || String(result.code) !== "0" || !result.data) throw new HttpError(502, (result && result.message) || "听悟任务查询失败");
  const data = result.data;
  const status = String(data.taskStatus || "ONGOING").toUpperCase();
  if (status === "FAILED" || status === "INVALID") throw new HttpError(422, data.errorMessage || "听悟没有完成这次转写");
  const transcriptionUrl = data.result && data.result.transcription;
  if (!["COMPLETE", "COMPLETED"].includes(status) || !transcriptionUrl) return { taskId, status: "ONGOING" };
  const transcript = await fetchTranscript(transcriptionUrl);
  const key = validObjectKey(objectKey);
  if (key) await ossClient().delete(key).catch(() => {});
  return { taskId, status: "COMPLETED", ...transcript };
}

export default async function handler(req, res) {
  if (!applyCors(req, res, ["GET", "POST", "OPTIONS"])) return res.status(403).json({ error: "不允许从这个网站调用" });
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(204).end();
  try {
    requireOwner(req);
    if (req.method === "POST") {
      if (await rateLimited(req, res, "transcribe-write", 20, 3600)) return;
      const body = bodyOf(req);
      if (body.action === "upload") return res.status(200).json(await createUpload(body));
      if (body.action === "start") return res.status(200).json(await createTask(body));
      throw new HttpError(400, "不支持的转写操作");
    }
    if (req.method === "GET") {
      if (await rateLimited(req, res, "transcribe-status", 180, 600)) return;
      const taskId = Array.isArray(req.query.taskId) ? req.query.taskId[0] : String(req.query.taskId || "");
      const objectKey = Array.isArray(req.query.objectKey) ? req.query.objectKey[0] : String(req.query.objectKey || "");
      return res.status(200).json(await taskStatus(taskId, objectKey));
    }
    return res.status(405).json({ error: "只支持 GET / POST" });
  } catch (error) {
    return sendHttpError(res, error, "转写服务暂时不可用");
  }
}
