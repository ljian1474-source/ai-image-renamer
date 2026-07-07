import { DurableObject } from "cloudflare:workers";

const MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const FREE_DAILY_IMAGES = 1000;
const QUOTA_OBJECT_NAME = "workers-ai-daily-quota";

export class QuotaCounter extends DurableObject {
  async getUsage(day) {
    const stored = await this.ctx.storage.get(quotaKey(day));
    return quotaPayload(normalizeStoredQuota(stored, day));
  }

  async tryConsume(day, images = 1) {
    return this.ctx.storage.transaction(async (txn) => {
      const key = quotaKey(day);
      const current = normalizeStoredQuota(await txn.get(key), day);
      const count = Math.max(1, Math.trunc(Number(images) || 1));
      if (current.images + count > FREE_DAILY_IMAGES) {
        return { allowed: false, quota: quotaPayload(current) };
      }
      current.images += count;
      await txn.put(key, current);
      return { allowed: true, quota: quotaPayload(current) };
    });
  }

  async release(day, images = 1) {
    return this.ctx.storage.transaction(async (txn) => {
      const key = quotaKey(day);
      const current = normalizeStoredQuota(await txn.get(key), day);
      current.images = Math.max(0, current.images - Math.max(1, Math.trunc(Number(images) || 1)));
      await txn.put(key, current);
      return quotaPayload(current);
    });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/quota") {
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders() });
      }
      if (request.method !== "GET") {
        return json({ ok: false, error: "只支持 GET 请求" }, 405);
      }
      return handleQuota(env);
    }

    if (url.pathname === "/api/rename") {
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders() });
      }
      if (request.method !== "POST") {
        return json({ ok: false, error: "只支持 POST 请求" }, 405);
      }
      return handleRename(request, env);
    }

    return env.ASSETS.fetch(request);
  },
};

async function handleQuota(env) {
  try {
    const quota = await quotaStub(env).getUsage(utcDayKey());
    return json({ ok: true, quota });
  } catch (error) {
    console.error("quota read failed", error);
    return json({ ok: false, error: "额度同步失败，请刷新重试" }, 503);
  }
}

async function handleRename(request, env) {
  let reservationActive = false;
  let reservationDay = "";
  try {
    const contentLength = Number(request.headers.get("content-length") || 0);
    if (contentLength > MAX_BODY_BYTES) {
      return json({ ok: false, error: "图片预览过大，请换一张较小的图片" }, 413);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ ok: false, error: "请求格式不正确" }, 400);
    }

    const image = typeof body?.image === "string" ? body.image : "";
    const originalName = typeof body?.originalName === "string" ? body.originalName : "";
    const options = normalizeOptions(body?.options);

    if (!/^data:image\/(jpeg|jpg|png|webp);base64,/i.test(image)) {
      return json({ ok: false, error: "只支持 JPG、PNG、WEBP 图片" }, 400);
    }

    if (image.length > MAX_BODY_BYTES * 1.34) {
      return json({ ok: false, error: "图片预览过大，请换一张较小的图片" }, 413);
    }

    const day = utcDayKey();
    reservationDay = day;
    const reservation = await quotaStub(env).tryConsume(day, 1);
    if (!reservation.allowed) {
      return json({
        ok: false,
        code: "CUSTOM_QUOTA_EXHAUSTED",
        error: "今天的图片额度已用完，请明天再试",
        quota: reservation.quota,
      }, 429);
    }

    reservationActive = true;
    let name = "";
    let previousName = "";

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const prompt = buildPrompt(originalName, options, previousName);
      const result = await env.AI.run(MODEL, {
        messages: [
          {
            role: "system",
            content: "你是一个严谨的电商图片文件命名助手。必须只返回一个符合字数范围的文件名。",
          },
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              { type: "image_url", image_url: { url: image } },
            ],
          },
        ],
        max_tokens: 100,
        temperature: 0.1,
      });

      previousName = sanitizeStem(extractText(result), options);
      if (isNameWithinOptions(previousName, options)) {
        name = previousName;
        break;
      }
    }

    if (!name) {
      await quotaStub(env).release(day, 1);
      reservationActive = false;
      return json({
        ok: false,
        error: `AI生成的名称未达到 ${options.minLength}-${options.maxLength} 字，请重试`,
        quota: await quotaStub(env).getUsage(day),
      }, 502);
    }

    reservationActive = false;
    let quota = reservation.quota;
    try {
      quota = await quotaStub(env).getUsage(day);
    } catch (quotaError) {
      console.error("quota refresh after success failed", quotaError);
    }
    return json({ ok: true, name, quota, options });
  } catch (error) {
    console.error("rename failed", error);
    const message = String(error?.message || error || "");

    let quota = null;
    if (reservationActive && reservationDay) {
      try {
        quota = await quotaStub(env).release(reservationDay, 1);
        reservationActive = false;
      } catch (quotaError) {
        console.error("quota release after failure failed", quotaError);
      }
    }

    if (/allocation|quota|limit|3036|429/i.test(message)) {
      return json({
        ok: false,
        code: "AI_PROVIDER_QUOTA_EXHAUSTED",
        error: "Cloudflare AI 今日官方资源已用尽，请明天再试",
        quota,
      }, 429);
    }

    if (/capacity|3040/i.test(message)) {
      return json({ ok: false, error: "AI服务暂时繁忙，请稍后重试", quota }, 503);
    }

    return json({ ok: false, error: "识别失败，请重试", quota }, 500);
  }
}

function normalizeOptions(options) {
  let minLength = clampLength(options?.minLength, 4);
  let maxLength = clampLength(options?.maxLength ?? options?.nameLength, 8);
  if (minLength > maxLength) maxLength = minLength;
  return {
    minLength,
    maxLength,
    allowSymbols: Boolean(options?.allowSymbols),
    allowEnglish: Boolean(options?.allowEnglish),
  };
}

function clampLength(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(2, Math.min(30, Math.trunc(number))) : fallback;
}

function buildPrompt(originalName, options, previousName = "") {
  const lines = [
    "请识别这张图片，并为它生成一个适合作为文件名的名称。",
    "命名规则：",
    "1. 只输出文件名主体，不要扩展名，不要解释，不要引号。",
    "2. 优先写清楚核心物品，再补充颜色、角度、数量或使用场景。",
    `3. 文件名主体必须不少于 ${options.minLength} 个字或字符，并且不得超过 ${options.maxLength} 个字或字符；扩展名不计算在内。`,
    `4. 必须严格控制在 ${options.minLength}-${options.maxLength} 字之间，少于最低字数时补充颜色、外形、用途、角度或场景等真实可见信息。`,
    "5. 不猜测看不清的品牌、型号、材质或功能。",
    "6. 不使用斜杠、冒号、星号、问号、引号、尖括号、竖线等文件名非法字符。",
    "7. 不使用‘图片’‘照片’‘实拍图’等空泛结尾。",
  ];

  if (options.allowEnglish) {
    lines.push("8. 允许使用英文；当产品本身以英文更自然时，可以保留少量英文或字母。");
  } else {
    lines.push("8. 不要输出英文、拼音或纯字母缩写，优先使用简体中文。");
  }

  if (options.allowSymbols) {
    lines.push("9. 允许在必要时使用少量普通符号，例如短横线或下划线；但仍不要使用 Windows 非法字符。");
  } else {
    lines.push("9. 不要使用任何符号，只保留中文、英文或数字本身。空格也尽量不要出现。");
  }

  if (previousName) {
    lines.push(`上一次名称“${previousName}”没有达到字数范围，请在不捏造信息的前提下重新生成。`);
  }
  if (originalName) lines.push(`原文件名仅供参考：${originalName}`);
  return lines.join("\n");
}

function quotaStub(env) {
  if (!env.QUOTA_COUNTER) throw new Error("QUOTA_COUNTER binding is missing");
  return env.QUOTA_COUNTER.getByName(QUOTA_OBJECT_NAME);
}

function quotaKey(day) {
  return `quota:${day}`;
}

function utcDayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function normalizeStoredQuota(value, day) {
  return {
    day,
    images: Math.max(0, Math.trunc(Number(value?.images) || 0)),
  };
}

function quotaPayload(value) {
  const used = Math.max(0, Math.trunc(Number(value.images) || 0));
  return {
    day: value.day,
    limit: FREE_DAILY_IMAGES,
    used,
    remaining: Math.max(0, FREE_DAILY_IMAGES - used),
    images: used,
    resetAt: `${nextUtcDay(value.day)}T00:00:00.000Z`,
    source: "image-count",
  };
}

function nextUtcDay(day) {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function extractText(result) {
  if (typeof result === "string") return result;
  if (typeof result?.response === "string") return result.response;
  if (typeof result?.result?.response === "string") return result.result.response;
  if (typeof result?.choices?.[0]?.message?.content === "string") {
    return result.choices[0].message.content;
  }
  return "";
}

function sanitizeStem(value, options = {}) {
  let text = String(value || "")
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/```\w*/g, "").replace(/```/g, ""))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean)
    ?.replace(/^\s*(文件名|名称|命名)\s*[:：]\s*/i, "")
    .replace(/^[-–—•\d.、\s]+/, "")
    .replace(/["'“”‘’`]/g, "")
    .replace(/\.(jpe?g|png|webp|gif|bmp|avif|heic)$/i, "")
    .replace(/[\\/:*?<>|]/g, "")
    .replace(/[。！!，,；;：:]+$/g, "")
    .replace(/\s+/g, "")
    .trim() || "";

  if (!options.allowEnglish) {
    text = text.replace(/[A-Za-z]+/g, "");
  }

  if (!options.allowSymbols) {
    text = text.replace(/[^\u3400-\u9fffA-Za-z0-9]/g, "");
  } else {
    text = text.replace(/[^\u3400-\u9fffA-Za-z0-9_\-+&]/g, "");
  }

  const chars = Array.from(text);
  if (chars.length > options.maxLength) {
    text = chars.slice(0, options.maxLength).join("");
  }

  return text.slice(0, 60);
}

function isNameWithinOptions(value, options) {
  const length = Array.from(String(value || "")).length;
  return length >= options.minLength && length <= options.maxLength;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...corsHeaders(),
    },
  });
}

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
  };
}
