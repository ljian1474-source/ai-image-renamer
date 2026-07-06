const MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";
const MAX_BODY_BYTES = 8 * 1024 * 1024;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

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

async function handleRename(request, env) {
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

    if (!/^data:image\/(jpeg|jpg|png|webp);base64,/i.test(image)) {
      return json({ ok: false, error: "只支持 JPG、PNG、WEBP 图片" }, 400);
    }

    if (image.length > MAX_BODY_BYTES * 1.34) {
      return json({ ok: false, error: "图片预览过大，请换一张较小的图片" }, 413);
    }

    const prompt = [
      "请识别这张图片，并为它生成一个适合作为文件名的简体中文名称。",
      "命名规则：",
      "1. 只输出文件名主体，不要扩展名，不要解释，不要引号。",
      "2. 优先写清楚核心物品，再补充颜色、角度、数量或使用场景。",
      "3. 长度控制在6到24个字符，简洁、准确、自然。",
      "4. 不猜测看不清的品牌、型号、材质或功能。",
      "5. 不使用斜杠、冒号、星号、问号、引号、尖括号、竖线等文件名非法字符。",
      "6. 不使用“图片”“照片”“实拍图”等空泛结尾。",
      originalName ? `原文件名仅供参考：${originalName}` : "",
    ].filter(Boolean).join("\n");

    const result = await env.AI.run(MODEL, {
      messages: [
        {
          role: "system",
          content: "你是一个严谨的电商图片文件命名助手。必须只返回一个简短文件名。",
        },
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: image } },
          ],
        },
      ],
      max_tokens: 80,
      temperature: 0.1,
    });

    const raw = extractText(result);
    const name = sanitizeStem(raw);

    if (!name) {
      return json({ ok: false, error: "AI没有返回有效名称，请重试" }, 502);
    }

    return json({ ok: true, name });
  } catch (error) {
    console.error("rename failed", error);
    const message = String(error?.message || error || "");

    if (/allocation|quota|limit|3036|429/i.test(message)) {
      return json({ ok: false, error: "今天的免费识图额度已用完，请明天再试" }, 429);
    }

    if (/capacity|3040/i.test(message)) {
      return json({ ok: false, error: "AI服务暂时繁忙，请稍后重试" }, 503);
    }

    return json({ ok: false, error: "识别失败，请重试" }, 500);
  }
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

function sanitizeStem(value) {
  return String(value || "")
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
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60) || "";
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
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type",
  };
}
