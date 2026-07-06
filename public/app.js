const MAX_FILES = 30;
const MAX_ORIGINAL_SIZE = 25 * 1024 * 1024;
const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

const state = {
  items: [],
  recognizing: false,
};

const dropZone = document.querySelector("#dropZone");
const fileInput = document.querySelector("#fileInput");
const workspace = document.querySelector("#workspace");
const fileList = document.querySelector("#fileList");
const fileCount = document.querySelector("#fileCount");
const recognizeBtn = document.querySelector("#recognizeBtn");
const downloadBtn = document.querySelector("#downloadBtn");
const clearBtn = document.querySelector("#clearBtn");
const globalMessage = document.querySelector("#globalMessage");
const rowTemplate = document.querySelector("#rowTemplate");

dropZone.addEventListener("click", () => fileInput.click());
dropZone.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    fileInput.click();
  }
});
fileInput.addEventListener("change", () => addFiles(fileInput.files));

for (const eventName of ["dragenter", "dragover"]) {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.add("dragging");
  });
}
for (const eventName of ["dragleave", "drop"]) {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.remove("dragging");
  });
}
dropZone.addEventListener("drop", (event) => addFiles(event.dataTransfer.files));

recognizeBtn.addEventListener("click", recognizeAll);
clearBtn.addEventListener("click", clearAll);
downloadBtn.addEventListener("click", downloadAll);

function addFiles(fileCollection) {
  hideGlobalMessage();
  const incoming = Array.from(fileCollection || []);
  const available = Math.max(0, MAX_FILES - state.items.length);
  const selected = incoming.slice(0, available);
  const errors = [];

  for (const file of selected) {
    if (!ALLOWED_TYPES.has(file.type)) {
      errors.push(`${file.name}：格式不支持`);
      continue;
    }
    if (file.size > MAX_ORIGINAL_SIZE) {
      errors.push(`${file.name}：超过25MB`);
      continue;
    }

    const id = crypto.randomUUID();
    const extension = getExtension(file);
    state.items.push({
      id,
      file,
      extension,
      previewUrl: URL.createObjectURL(file),
      name: "",
      status: "idle",
      error: "",
    });
  }

  if (incoming.length > available) {
    errors.push(`一次最多保留 ${MAX_FILES} 张图片`);
  }
  if (errors.length) showGlobalMessage(errors.join("；"));

  fileInput.value = "";
  render();
}

function render() {
  fileList.innerHTML = "";
  fileCount.textContent = String(state.items.length);
  workspace.classList.toggle("hidden", state.items.length === 0);
  dropZone.classList.toggle("hidden", state.items.length > 0);

  for (const item of state.items) {
    const fragment = rowTemplate.content.cloneNode(true);
    const row = fragment.querySelector(".file-row");
    const thumb = fragment.querySelector(".thumb");
    const originalName = fragment.querySelector(".original-name");
    const fileSize = fragment.querySelector(".file-size");
    const input = fragment.querySelector(".name-input");
    const extension = fragment.querySelector(".extension");
    const status = fragment.querySelector(".row-status");
    const removeBtn = fragment.querySelector(".remove-btn");

    row.dataset.id = item.id;
    thumb.src = item.previewUrl;
    originalName.textContent = item.file.name;
    originalName.title = item.file.name;
    fileSize.textContent = formatBytes(item.file.size);
    input.value = item.name;
    input.disabled = item.status === "loading";
    extension.textContent = `.${item.extension}`;

    if (item.status === "loading") {
      status.textContent = "正在识别…";
      status.className = "row-status loading";
    } else if (item.status === "success") {
      status.textContent = "识别完成，可直接修改";
      status.className = "row-status success";
    } else if (item.status === "error") {
      status.textContent = item.error || "识别失败";
      status.className = "row-status error";
    } else {
      status.textContent = "等待识别";
      status.className = "row-status";
    }

    input.addEventListener("input", (event) => {
      item.name = sanitizeStem(event.target.value);
      if (event.target.value !== item.name) event.target.value = item.name;
      updateButtons();
    });

    removeBtn.addEventListener("click", () => removeItem(item.id));
    fileList.appendChild(fragment);
  }

  updateButtons();
}

function updateRow(item) {
  const row = fileList.querySelector(`[data-id="${CSS.escape(item.id)}"]`);
  if (!row) return;
  const input = row.querySelector(".name-input");
  const status = row.querySelector(".row-status");

  input.value = item.name;
  input.disabled = item.status === "loading";

  if (item.status === "loading") {
    status.textContent = "正在识别…";
    status.className = "row-status loading";
  } else if (item.status === "success") {
    status.textContent = "识别完成，可直接修改";
    status.className = "row-status success";
  } else if (item.status === "error") {
    status.textContent = item.error || "识别失败";
    status.className = "row-status error";
  }
  updateButtons();
}

function updateButtons() {
  const hasItems = state.items.length > 0;
  const downloadable = state.items.some((item) => sanitizeStem(item.name));
  recognizeBtn.disabled = !hasItems || state.recognizing;
  clearBtn.disabled = !hasItems || state.recognizing;
  downloadBtn.disabled = !downloadable || state.recognizing;
  recognizeBtn.textContent = state.recognizing ? "正在识别…" : "开始识图改名";
}

async function recognizeAll() {
  if (state.recognizing || state.items.length === 0) return;
  hideGlobalMessage();
  state.recognizing = true;
  updateButtons();

  let successCount = 0;
  let failureCount = 0;

  for (const item of state.items) {
    item.status = "loading";
    item.error = "";
    updateRow(item);

    try {
      const image = await makeAiPreview(item.file);
      const response = await fetch("/api/rename", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ image, originalName: item.file.name }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) {
        throw new Error(data.error || "识别失败");
      }

      item.name = sanitizeStem(data.name) || fallbackStem(item.file.name);
      item.status = "success";
      successCount += 1;
    } catch (error) {
      item.status = "error";
      item.error = String(error?.message || "识别失败");
      failureCount += 1;
    }
    updateRow(item);
  }

  state.recognizing = false;
  updateButtons();

  if (failureCount > 0) {
    showGlobalMessage(`已完成 ${successCount} 张，失败 ${failureCount} 张。失败图片可以再次点击“开始识图改名”重试。`);
  }
}

async function makeAiPreview(file) {
  const bitmap = await createImageBitmap(file);
  const maxSide = 1024;
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { alpha: false });
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  return canvas.toDataURL("image/jpeg", 0.82);
}

async function downloadAll() {
  const validItems = state.items.filter((item) => sanitizeStem(item.name));
  if (!validItems.length) return;

  if (!window.JSZip) {
    showGlobalMessage("压缩组件加载失败，请刷新页面后重试");
    return;
  }

  downloadBtn.disabled = true;
  downloadBtn.textContent = "正在打包…";

  try {
    const zip = new window.JSZip();
    const usedNames = new Set();

    for (const item of validItems) {
      const stem = uniqueStem(sanitizeStem(item.name), usedNames);
      const filename = `${stem}.${item.extension}`;
      usedNames.add(filename.toLowerCase());
      zip.file(filename, item.file);
    }

    const blob = await zip.generateAsync({ type: "blob", compression: "STORE" });
    triggerDownload(blob, `识图改名_${dateStamp()}.zip`);
  } catch (error) {
    showGlobalMessage(`打包失败：${String(error?.message || error)}`);
  } finally {
    downloadBtn.textContent = "下载全部";
    updateButtons();
  }
}

function uniqueStem(stem, usedNames) {
  let candidate = stem || "未命名图片";
  let index = 2;
  const extensionPattern = /\.[^.]+$/;

  while ([...usedNames].some((name) => name.replace(extensionPattern, "") === candidate.toLowerCase())) {
    candidate = `${stem}-${index}`;
    index += 1;
  }
  return candidate;
}

function removeItem(id) {
  if (state.recognizing) return;
  const index = state.items.findIndex((item) => item.id === id);
  if (index === -1) return;
  URL.revokeObjectURL(state.items[index].previewUrl);
  state.items.splice(index, 1);
  render();
}

function clearAll() {
  if (state.recognizing) return;
  for (const item of state.items) URL.revokeObjectURL(item.previewUrl);
  state.items = [];
  hideGlobalMessage();
  render();
}

function sanitizeStem(value) {
  return String(value || "")
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\.(jpe?g|png|webp)$/i, "")
    .replace(/[.\s]+$/g, "")
    .replace(/^\s+/g, "")
    .slice(0, 60);
}

function fallbackStem(filename) {
  return sanitizeStem(filename.replace(/\.[^.]+$/, "")) || "未命名图片";
}

function getExtension(file) {
  const ext = file.name.match(/\.([a-zA-Z0-9]+)$/)?.[1]?.toLowerCase();
  if (ext && ["jpg", "jpeg", "png", "webp"].includes(ext)) return ext === "jpeg" ? "jpg" : ext;
  if (file.type === "image/png") return "png";
  if (file.type === "image/webp") return "webp";
  return "jpg";
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function dateStamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}`;
}

function showGlobalMessage(message) {
  globalMessage.textContent = message;
  globalMessage.classList.remove("hidden");
}

function hideGlobalMessage() {
  globalMessage.textContent = "";
  globalMessage.classList.add("hidden");
}
