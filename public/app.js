const MAX_FILES = 500;
const MAX_ORIGINAL_SIZE = 50 * 1024 * 1024;
const RECOGNITION_CONCURRENCY = 3;
const FREE_DAILY_IMAGES = 1000;
const ALLOWED_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp"]);

const state = {
  rootHandle: null,
  items: [],
  recognizing: false,
  renaming: false,
  completed: 0,
};

const folderPicker = document.querySelector("#folderPicker");
const unsupported = document.querySelector("#unsupported");
const workspace = document.querySelector("#workspace");
const fileList = document.querySelector("#fileList");
const fileCount = document.querySelector("#fileCount");
const folderName = document.querySelector("#folderName");
const recognizeBtn = document.querySelector("#recognizeBtn");
const renameBtn = document.querySelector("#renameBtn");
const changeFolderBtn = document.querySelector("#changeFolderBtn");
const globalMessage = document.querySelector("#globalMessage");
const progressBar = document.querySelector("#progressBar");
const progressText = document.querySelector("#progressText");
const rowTemplate = document.querySelector("#rowTemplate");
const quotaRemaining = document.querySelector("#quotaRemaining");
const quotaUsed = document.querySelector("#quotaUsed");
const quotaImages = document.querySelector("#quotaImages");
const quotaBar = document.querySelector("#quotaBar");
const quotaReset = document.querySelector("#quotaReset");
const quotaNote = document.querySelector("#quotaNote");
const nameLengthInput = document.querySelector("#nameLength");
const allowSymbolsSelect = document.querySelector("#allowSymbols");
const allowEnglishSelect = document.querySelector("#allowEnglish");

let quotaState = { day: "", limit: FREE_DAILY_IMAGES, used: 0, remaining: FREE_DAILY_IMAGES, images: 0, resetAt: "" };
renderQuota();
refreshQuota();
setInterval(refreshQuota, 60_000);

const supportsDirectRename = "showDirectoryPicker" in window;
unsupported.classList.toggle("hidden", supportsDirectRename);
folderPicker.classList.toggle("disabled", !supportsDirectRename);

folderPicker.addEventListener("click", chooseFolder);
folderPicker.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    chooseFolder();
  }
});
changeFolderBtn.addEventListener("click", chooseFolder);
recognizeBtn.addEventListener("click", recognizeAll);
renameBtn.addEventListener("click", renameOriginalFiles);
nameLengthInput.addEventListener("input", handleRuleChange);
allowSymbolsSelect.addEventListener("change", handleRuleChange);
allowEnglishSelect.addEventListener("change", handleRuleChange);
restoreRuleInputs();
normalizeRuleInputs();

function normalizeRuleInputs() {
  const value = Number(nameLengthInput.value);
  const safe = Number.isFinite(value) ? Math.max(2, Math.min(30, Math.trunc(value))) : 8;
  if (String(safe) !== nameLengthInput.value) nameLengthInput.value = String(safe);
  try {
    localStorage.setItem("ai-renamer-rules", JSON.stringify({
      nameLength: safe,
      allowSymbols: allowSymbolsSelect.value,
      allowEnglish: allowEnglishSelect.value,
    }));
  } catch {
    // 浏览器禁用本地存储时不影响使用。
  }
}

function restoreRuleInputs() {
  try {
    const saved = JSON.parse(localStorage.getItem("ai-renamer-rules") || "null");
    if (!saved) return;
    if (Number.isFinite(Number(saved.nameLength))) nameLengthInput.value = String(saved.nameLength);
    if (["yes", "no"].includes(saved.allowSymbols)) allowSymbolsSelect.value = saved.allowSymbols;
    if (["yes", "no"].includes(saved.allowEnglish)) allowEnglishSelect.value = saved.allowEnglish;
  } catch {
    // 忽略损坏的本地设置。
  }
}

function getNamingRules() {
  normalizeRuleInputs();
  return {
    nameLength: Math.max(2, Math.min(30, Math.trunc(Number(nameLengthInput.value) || 8))),
    allowSymbols: allowSymbolsSelect.value === "yes",
    allowEnglish: allowEnglishSelect.value === "yes",
  };
}

function handleRuleChange() {
  normalizeRuleInputs();
  const rules = getNamingRules();
  for (const item of state.items) {
    if (item.status === "renamed" || !item.name) continue;
    item.name = sanitizeStemByRules(item.name, rules);
  }
  if (state.items.length) render();
}

async function chooseFolder() {
  if (!supportsDirectRename || state.recognizing || state.renaming) return;
  hideGlobalMessage();

  try {
    const handle = await window.showDirectoryPicker({
      id: "ai-image-renamer",
      mode: "readwrite",
      startIn: "pictures",
    });

    const permission = await verifyPermission(handle, true);
    if (!permission) {
      showGlobalMessage("没有获得文件夹修改权限，请重新选择并允许访问。");
      return;
    }

    clearState();
    state.rootHandle = handle;
    folderName.textContent = `文件夹：${handle.name}`;
    progressText.textContent = "正在读取文件夹…";
    workspace.classList.remove("hidden");
    folderPicker.classList.add("hidden");

    const found = [];
    await scanDirectory(handle, "", found);
    state.items = found;

    if (found.length === 0) {
      showGlobalMessage("这个文件夹里没有读取到 JPG、PNG 或 WEBP 图片。");
      progressText.textContent = "未找到图片";
    } else {
      progressText.textContent = `已读取 ${found.length} 张，等待识别`;
      if (found.length >= MAX_FILES) {
        showGlobalMessage(`已读取前 ${MAX_FILES} 张图片；超过部分没有加入。`);
      }
    }
    render();
  } catch (error) {
    if (error?.name !== "AbortError") {
      showGlobalMessage(`读取文件夹失败：${friendlyError(error)}`);
    }
  }
}

async function scanDirectory(directoryHandle, relativePath, output) {
  for await (const [name, handle] of directoryHandle.entries()) {
    if (output.length >= MAX_FILES) return;

    if (handle.kind === "directory") {
      await scanDirectory(handle, joinPath(relativePath, name), output);
      continue;
    }

    const extension = getExtensionFromName(name);
    if (!ALLOWED_EXTENSIONS.has(extension)) continue;

    try {
      const file = await handle.getFile();
      if (file.size > MAX_ORIGINAL_SIZE) continue;

      output.push({
        id: crypto.randomUUID(),
        file,
        fileHandle: handle,
        parentHandle: directoryHandle,
        relativePath,
        originalName: name,
        extension: extension === "jpeg" ? "jpg" : extension,
        previewUrl: URL.createObjectURL(file),
        name: "",
        status: "idle",
        error: "",
        renamedName: "",
      });
    } catch {
      // 单个文件读取失败不影响其余文件。
    }
  }
}

function render() {
  fileList.innerHTML = "";
  fileCount.textContent = String(state.items.length);
  workspace.classList.toggle("hidden", state.items.length === 0 && !state.rootHandle);
  folderPicker.classList.toggle("hidden", Boolean(state.rootHandle));

  for (const item of state.items) {
    const fragment = rowTemplate.content.cloneNode(true);
    const row = fragment.querySelector(".file-row");
    const thumb = fragment.querySelector(".thumb");
    const originalName = fragment.querySelector(".original-name");
    const filePath = fragment.querySelector(".file-path");
    const fileSize = fragment.querySelector(".file-size");
    const input = fragment.querySelector(".name-input");
    const extension = fragment.querySelector(".extension");
    const status = fragment.querySelector(".row-status");
    const removeBtn = fragment.querySelector(".remove-btn");

    row.dataset.id = item.id;
    thumb.src = item.previewUrl;
    originalName.textContent = item.originalName;
    originalName.title = item.originalName;
    filePath.textContent = item.relativePath || "当前文件夹";
    fileSize.textContent = formatBytes(item.file.size);
    input.value = item.name;
    input.maxLength = getNamingRules().nameLength;
    input.disabled = item.status === "loading" || state.renaming || item.status === "renamed";
    extension.textContent = `.${item.extension}`;
    applyStatus(status, item);

    input.addEventListener("input", (event) => {
      item.name = sanitizeStemByRules(event.target.value, getNamingRules());
      if (event.target.value !== item.name) event.target.value = item.name;
      updateButtons();
    });

    removeBtn.disabled = state.recognizing || state.renaming;
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
  const originalName = row.querySelector(".original-name");

  input.value = item.name;
  input.maxLength = getNamingRules().nameLength;
  input.disabled = item.status === "loading" || state.renaming || item.status === "renamed";
  originalName.textContent = item.originalName;
  originalName.title = item.originalName;
  applyStatus(status, item);
  updateButtons();
}

function applyStatus(element, item) {
  if (item.status === "loading") {
    element.textContent = "正在识别…";
    element.className = "row-status loading";
  } else if (item.status === "success") {
    element.textContent = "识别完成，可手动修改";
    element.className = "row-status success";
  } else if (item.status === "renaming") {
    element.textContent = "正在直接改名…";
    element.className = "row-status loading";
  } else if (item.status === "renamed") {
    element.textContent = `已改名：${item.renamedName}`;
    element.className = "row-status success";
  } else if (item.status === "error") {
    element.textContent = item.error || "处理失败";
    element.className = "row-status error";
  } else {
    element.textContent = "等待识别";
    element.className = "row-status";
  }
}

function updateButtons() {
  const hasItems = state.items.length > 0;
  const activeRules = getNamingRules();
  const readyToRename = state.items.some(
    (item) => sanitizeStemByRules(item.name, activeRules) && item.status !== "renamed" && item.status !== "loading",
  );

  recognizeBtn.disabled = !hasItems || state.recognizing || state.renaming;
  renameBtn.disabled = !readyToRename || state.recognizing || state.renaming;
  changeFolderBtn.disabled = state.recognizing || state.renaming;
  recognizeBtn.textContent = state.recognizing ? "正在识别…" : "开始识图改名";
  renameBtn.textContent = state.renaming ? "正在直接改名…" : "直接改名原文件";
}

async function recognizeAll() {
  if (state.recognizing || state.renaming || state.items.length === 0) return;
  hideGlobalMessage();
  const rules = getNamingRules();

  if (quotaState.remaining <= 0) {
    showGlobalMessage("今天的图片额度已用完，请明天再试。");
    return;
  }

  state.recognizing = true;

  const queue = state.items.filter(
    (item) => item.status !== "renamed" && (item.status === "idle" || item.status === "error" || !sanitizeStemByRules(item.name, rules)),
  );
  if (queue.length === 0) {
    state.recognizing = false;
    updateButtons();
    showGlobalMessage("当前图片都已经生成文件名，可以直接改名原文件。", "success");
    return;
  }
  state.completed = 0;
  updateProgress(0, queue.length, "开始识别");
  updateButtons();

  let successCount = 0;
  let failureCount = 0;
  let nextIndex = 0;
  let quotaStopped = false;

  async function worker() {
    while (true) {
      if (quotaStopped) return;
      const index = nextIndex;
      nextIndex += 1;
      if (index >= queue.length) return;

      const item = queue[index];
      item.status = "loading";
      item.error = "";
      updateRow(item);

      try {
        const image = await makeAiPreview(item.file);
        const response = await fetchWithRetry("/api/rename", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            image,
            originalName: item.originalName,
            options: rules,
          }),
        });
        const data = await response.json().catch(() => ({}));

        if (data.quota) applyQuotaData(data.quota);

        if (!response.ok || !data.ok) {
          const error = new Error(data.error || "识别失败");
          error.status = response.status;
          error.code = data.code || "";
          throw error;
        }

        item.name = sanitizeStemByRules(data.name, rules) || fallbackStem(rules);
        item.status = "success";
        successCount += 1;
      } catch (error) {
        item.status = "error";
        item.error = friendlyError(error);
        failureCount += 1;
        if (error?.code === "CUSTOM_QUOTA_EXHAUSTED") {
          quotaStopped = true;
          markQuotaExhausted();
        }
      }

      state.completed += 1;
      updateRow(item);
      updateProgress(state.completed, queue.length, "识别中");
    }
  }

  try {
    const workerCount = Math.min(RECOGNITION_CONCURRENCY, queue.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
  } finally {
    state.recognizing = false;
    updateButtons();
  }

  if (quotaStopped) {
    showGlobalMessage(`已成功识别 ${successCount} 张，今天的图片额度已用完。`, successCount > 0 ? "success" : undefined);
    updateProgress(state.completed, queue.length, "额度已用完");
    return;
  }

  if (failureCount > 0) {
    showGlobalMessage(`识别完成：成功 ${successCount} 张，失败 ${failureCount} 张。失败项可以重新识别。`);
  } else {
    showGlobalMessage(`识别完成：已成功生成 ${successCount} 个文件名。`, "success");
  }
  updateProgress(queue.length, queue.length, "识别完成");
}

function renderQuota() {
  quotaRemaining.textContent = formatCount(quotaState.remaining);
  quotaUsed.textContent = formatCount(quotaState.used);
  quotaImages.textContent = formatCount(quotaState.images);
  const percentage = quotaState.limit > 0 ? Math.min(100, Math.max(0, Math.round((quotaState.used / quotaState.limit) * 100))) : 0;
  quotaBar.style.width = `${percentage}%`;
  quotaReset.textContent = quotaState.resetAt ? `UTC ${formatUtcReset(quotaState.resetAt)} 重置` : "每日 UTC 00:00 重置";
  quotaNote.textContent = quotaState.remaining <= 0
    ? "今天的图片额度已经用完，请明天再试。"
    : "每成功识别 1 张图片扣 1 个额度；失败不扣。数据由服务器统一累计。";
}

async function refreshQuota() {
  try {
    const response = await fetch("/api/quota", { cache: "no-store" });
    const data = await response.json().catch(() => ({}));
    if (response.ok && data.ok && data.quota) {
      applyQuotaData(data.quota);
      return;
    }
    quotaNote.textContent = data.error || "额度同步失败，请稍后刷新。";
  } catch {
    quotaNote.textContent = "额度同步失败，请检查网络后刷新。";
  }
}

function applyQuotaData(quota) {
  quotaState = {
    day: quota.day || "",
    limit: Number(quota.limit) || FREE_DAILY_IMAGES,
    used: Math.max(0, Number(quota.used) || 0),
    remaining: Math.max(0, Number(quota.remaining) || 0),
    images: Math.max(0, Number(quota.images) || 0),
    resetAt: quota.resetAt || "",
  };
  renderQuota();
}

function markQuotaExhausted() {
  quotaState.used = quotaState.limit;
  quotaState.remaining = 0;
  renderQuota();
}

function formatUtcReset(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "00:00";
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const hours = String(date.getUTCHours()).padStart(2, "0");
  const minutes = String(date.getUTCMinutes()).padStart(2, "0");
  return `${month}/${day} ${hours}:${minutes}`;
}

function formatCount(value) {
  return new Intl.NumberFormat("zh-CN").format(Math.max(0, Math.round(Number(value) || 0)));
}

function friendlyError(error) {
  const text = String(error?.message || error || "").trim();
  if (!text) return "未知错误";
  return text;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function joinPath(base, name) {
  return base ? `${base}/${name}` : name;
}

function pathKey(relativePath) {
  return relativePath || "/";
}

async function makeAiPreview(file) {
  const bitmap = await createImageBitmap(file);
  const maxSide = 1600;
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
  return canvas.toDataURL("image/jpeg", 0.72);
}

async function fetchWithRetry(url, options) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url, options);
      if (response.status < 500 || attempt === 2) return response;
      lastError = new Error(`服务暂时不可用（${response.status}）`);
    } catch (error) {
      lastError = error;
    }
    await sleep(900 * (attempt + 1));
  }
  throw lastError || new Error("网络请求失败");
}

async function renameOriginalFiles() {
  if (state.renaming || state.recognizing) return;

  const activeRules = getNamingRules();
  const candidates = state.items.filter(
    (item) => sanitizeStemByRules(item.name, activeRules) && item.status !== "renamed",
  );
  if (!candidates.length) return;

  const confirmed = window.confirm(
    `将直接修改所选文件夹里的 ${candidates.length} 张原图片文件名。

改名前请确保这些图片没有被 Photoshop、资源管理器预览或其他软件占用。是否继续？`,
  );
  if (!confirmed) return;

  hideGlobalMessage();
  state.renaming = true;
  updateButtons();
  updateProgress(0, candidates.length, "准备直接改名");

  let successCount = 0;
  let failureCount = 0;
  const usedByDirectory = new Map();

  try {
    for (const item of candidates) {
      const directoryKey = pathKey(item.relativePath);
      if (!usedByDirectory.has(directoryKey)) {
        usedByDirectory.set(directoryKey, await listNames(item.parentHandle));
      }
    }

    for (let index = 0; index < candidates.length; index += 1) {
      const item = candidates[index];
      item.status = "renaming";
      item.error = "";
      updateRow(item);

      try {
        const permission = await verifyPermission(item.parentHandle, true);
        if (!permission) throw new Error("文件夹写入权限已失效，请重新选择文件夹");

        const usedNames = usedByDirectory.get(pathKey(item.relativePath));
        const stem = sanitizeStemByRules(item.name, activeRules) || fallbackStem(activeRules);
        const desired = `${stem}.${item.extension}`;
        const finalName = chooseUniqueFilename(desired, item.originalName, usedNames);

        if (finalName.toLowerCase() === item.originalName.toLowerCase()) {
          item.status = "renamed";
          item.renamedName = item.originalName;
          successCount += 1;
          updateRow(item);
          updateProgress(index + 1, candidates.length, "直接改名中");
          continue;
        }

        const freshFile = await item.fileHandle.getFile();
        const targetHandle = await item.parentHandle.getFileHandle(finalName, { create: true });
        const writable = await targetHandle.createWritable();
        await writable.write(freshFile);
        await writable.close();

        const writtenFile = await targetHandle.getFile();
        if (writtenFile.size !== freshFile.size) {
          throw new Error("新文件写入不完整，旧文件已保留");
        }

        await item.parentHandle.removeEntry(item.originalName);
        usedNames.delete(item.originalName.toLowerCase());
        usedNames.add(finalName.toLowerCase());

        item.fileHandle = targetHandle;
        item.file = writtenFile;
        item.originalName = finalName;
        item.status = "renamed";
        item.renamedName = finalName;
        successCount += 1;
      } catch (error) {
        item.status = "error";
        item.error = `直接改名失败：${friendlyError(error)}`;
        failureCount += 1;
      }

      updateRow(item);
      updateProgress(index + 1, candidates.length, "直接改名中");
    }
  } finally {
    state.renaming = false;
    updateButtons();
    updateProgress(candidates.length, candidates.length, "直接改名完成");
  }

  if (failureCount > 0) {
    showGlobalMessage(`已直接改名 ${successCount} 张，失败 ${failureCount} 张。失败项会保留原文件，处理成功后才会删除旧文件名。`);
  } else {
    showGlobalMessage(`完成：${successCount} 张原图片已直接改名，不需要下载。`, "success");
  }
}

async function verifyPermission(handle, readWrite) {
  const options = readWrite ? { mode: "readwrite" } : {};
  if ((await handle.queryPermission(options)) === "granted") return true;
  return (await handle.requestPermission(options)) === "granted";
}

async function listNames(directoryHandle) {
  const names = new Set();
  for await (const name of directoryHandle.keys()) names.add(name.toLowerCase());
  return names;
}

function chooseUniqueFilename(desired, originalName, usedNames) {
  const desiredLower = desired.toLowerCase();
  if (desiredLower === originalName.toLowerCase()) return originalName;
  if (!usedNames.has(desiredLower)) {
    usedNames.add(desiredLower);
    return desired;
  }

  const dot = desired.lastIndexOf(".");
  const stem = dot > 0 ? desired.slice(0, dot) : desired;
  const extension = dot > 0 ? desired.slice(dot) : "";
  let index = 2;
  while (usedNames.has(`${stem}-${index}${extension}`.toLowerCase())) index += 1;
  const finalName = `${stem}-${index}${extension}`;
  usedNames.add(finalName.toLowerCase());
  return finalName;
}

function updateProgress(done, total, label) {
  const percentage = total > 0 ? Math.round((done / total) * 100) : 0;
  progressBar.style.width = `${percentage}%`;
  progressText.textContent = total > 0 ? `${label}：${done} / ${total}` : label;
}

function removeItem(id) {
  if (state.recognizing || state.renaming) return;
  const index = state.items.findIndex((item) => item.id === id);
  if (index === -1) return;
  URL.revokeObjectURL(state.items[index].previewUrl);
  state.items.splice(index, 1);
  render();
}

function clearState() {
  for (const item of state.items) URL.revokeObjectURL(item.previewUrl);
  state.items = [];
  state.rootHandle = null;
  state.completed = 0;
  progressBar.style.width = "0%";
  progressText.textContent = "等待开始";
  hideGlobalMessage();
}

function sanitizeStem(value) {
  return String(value || "")
    .replace(/[\/:*?"<>|]/g, "")
    .replace(/\.(jpe?g|png|webp)$/i, "")
    .replace(/[.\s]+$/g, "")
    .replace(/^\s+/g, "")
    .slice(0, 60);
}

function sanitizeStemByRules(value, rules = getNamingRules()) {
  let text = sanitizeStem(value).replace(/\s+/g, "");
  if (!rules.allowEnglish) text = text.replace(/[A-Za-z]+/g, "");
  if (rules.allowSymbols) {
    text = text.replace(/[^\u3400-\u9fffA-Za-z0-9_\-+&]/g, "");
  } else {
    text = text.replace(/[^\u3400-\u9fffA-Za-z0-9]/g, "");
  }
  return Array.from(text).slice(0, rules.nameLength).join("");
}

function fallbackStem(rules = getNamingRules()) {
  return sanitizeStemByRules("未命名图片", rules) || "图片";
}

function getExtensionFromName(name) {
  return name.match(/\.([a-zA-Z0-9]+)$/)?.[1]?.toLowerCase() || "";
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

function showGlobalMessage(message, type = "error") {
  globalMessage.textContent = message;
  globalMessage.className = `global-message ${type}`;
  globalMessage.classList.remove("hidden");
}

function hideGlobalMessage() {
  globalMessage.className = "global-message hidden";
  globalMessage.textContent = "";
}
