const archiveSelect = document.querySelector("#archive-select");
const textProfileSelect = document.querySelector("#text-profile-select");
const archiveStatus = document.querySelector("#archive-status");
const treeRoot = document.querySelector("#tree-root");
const filePath = document.querySelector("#file-path");
const fileContent = document.querySelector("#file-content");
const fileEditor = document.querySelector("#file-editor");
const editorMode = document.querySelector("#editor-mode");
const saveButton = document.querySelector("#save-button");
const resetButton = document.querySelector("#reset-button");

const textProfileLabels = {
  simplified: "简体",
  traditional: "繁体",
};

const state = {
  activeArchive: "",
  activeTextProfile: textProfileSelect.value,
  activeFileButton: null,
  activeFilePath: "",
  activeSessionId: null,
  activeSessionVersion: 0,
  originalContent: "",
  editable: false,
  saving: false,
};

async function fetchJson(url, options = undefined) {
  const response = await fetch(url, options);
  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error ?? "Request failed.");
  }

  return data;
}

async function postJson(url, payload) {
  return fetchJson(url, {
    method: "POST",
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(payload),
  });
}

function setStatus(text) {
  archiveStatus.textContent = text;
}

function clearTree() {
  treeRoot.innerHTML = "";
}

function hasUnsavedChanges() {
  return state.editable && fileEditor.value !== state.originalContent;
}

function updateActionState() {
  const dirty = hasUnsavedChanges();
  saveButton.disabled = !state.editable || state.saving || !dirty;
  resetButton.disabled = !state.editable || state.saving || !dirty;
  fileEditor.readOnly = !state.editable || state.saving;
}

function setEditableMode(editable) {
  state.editable = editable;
  editorMode.textContent = editable ? "脚本会话已打开" : "只读预览";
  fileContent.classList.toggle("is-hidden", editable);
  fileEditor.classList.toggle("is-hidden", !editable);
  updateActionState();
}

function setSelectedButton(button) {
  if (state.activeFileButton) {
    state.activeFileButton.classList.remove("is-active");
  }

  state.activeFileButton = button;

  if (button) {
    button.classList.add("is-active");
  }
}

function clearSessionState() {
  state.activeSessionId = null;
  state.activeSessionVersion = 0;
}

function resetPreviewPane() {
  setSelectedButton(null);
  state.activeFilePath = "";
  state.originalContent = "";
  state.saving = false;
  clearSessionState();
  filePath.textContent = "选择左侧文件查看内容";
  filePath.title = "";
  fileContent.textContent = "# PVF Explorer";
  fileEditor.value = "";
  setEditableMode(false);
}

function confirmDiscardChanges() {
  if (!hasUnsavedChanges()) {
    return true;
  }

  return window.confirm("当前文件有未保存修改，是否放弃这些修改？");
}

async function closeActiveSession() {
  const sessionId = state.activeSessionId;

  clearSessionState();

  if (!sessionId || !state.activeArchive) {
    return;
  }

  try {
    await postJson(
      `/api/file/close?archive=${encodeURIComponent(state.activeArchive)}`,
      { sessionId },
    );
  } catch {
    // Best effort.
  }
}

function closeActiveSessionWithBeacon() {
  if (
    !state.activeSessionId || !state.activeArchive || typeof navigator.sendBeacon !== "function"
  ) {
    return;
  }

  const payload = JSON.stringify({ sessionId: state.activeSessionId });
  const blob = new Blob([payload], { type: "application/json; charset=utf-8" });
  navigator.sendBeacon(
    `/api/file/close?archive=${encodeURIComponent(state.activeArchive)}`,
    blob,
  );
  clearSessionState();
}

function applyOpenedFile(payload) {
  state.activeFilePath = payload.path;
  state.originalContent = payload.content;
  state.activeSessionId = payload.session?.id ?? null;
  state.activeSessionVersion = payload.session?.version ?? 0;
  filePath.textContent = payload.path;
  filePath.title = payload.path;

  if (payload.editable) {
    fileEditor.value = payload.content;
    fileContent.textContent = "";
  } else {
    fileContent.textContent = payload.content;
    fileEditor.value = "";
  }

  setEditableMode(payload.editable);
}

function renderChildren(container, children) {
  for (const child of children) {
    if (child.kind === "directory") {
      const details = document.createElement("details");
      details.dataset.path = child.path;

      const summary = document.createElement("summary");
      summary.textContent = child.name;
      summary.title = child.name;
      details.append(summary);

      const childContainer = document.createElement("div");
      childContainer.className = "tree__children";
      details.append(childContainer);

      details.addEventListener("toggle", () => {
        if (details.open && childContainer.childElementCount === 0) {
          void loadDirectory(details, child.path);
        }
      });

      container.append(details);
      continue;
    }

    const button = document.createElement("button");
    button.type = "button";
    button.textContent = child.name;
    button.title = child.name;
    button.dataset.path = child.path;
    button.addEventListener("click", () => {
      void openFile(button, child.path);
    });
    container.append(button);
  }
}

async function loadDirectory(details, treePath) {
  const childContainer = details.querySelector(".tree__children");
  childContainer.textContent = "正在读取...";

  try {
    const { children } = await fetchJson(
      `/api/tree?archive=${encodeURIComponent(state.activeArchive)}&path=${
        encodeURIComponent(treePath)
      }`,
    );

    childContainer.textContent = "";
    renderChildren(childContainer, children);
  } catch (error) {
    childContainer.textContent = error instanceof Error ? error.message : "读取失败";
  }
}

async function loadFile(button, selectedPath) {
  setSelectedButton(button);
  filePath.textContent = selectedPath;
  filePath.title = selectedPath;
  fileContent.textContent = "正在读取文件内容...";
  fileEditor.value = "";
  state.originalContent = "";
  clearSessionState();
  setEditableMode(false);

  const payload = await postJson(
    `/api/file/open?archive=${encodeURIComponent(state.activeArchive)}`,
    {
      path: selectedPath,
      textProfile: state.activeTextProfile,
    },
  );

  applyOpenedFile(payload);
}

async function openFile(button, selectedPath) {
  if (!confirmDiscardChanges()) {
    return;
  }

  await closeActiveSession();

  try {
    await loadFile(button, selectedPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : "读取失败";
    fileContent.textContent = message;
    fileEditor.value = message;
    setEditableMode(false);
  }
}

async function openDefaultPreview() {
  const equipmentNode = treeRoot.querySelector("details[data-path=\"equipment\"]");

  if (!equipmentNode) {
    return;
  }

  equipmentNode.open = true;
  await loadDirectory(equipmentNode, "equipment");

  const defaultFileButton = equipmentNode.querySelector(
    "button[data-path=\"equipment/equipment.lst\"]",
  );

  if (defaultFileButton) {
    await openFile(defaultFileButton, "equipment/equipment.lst");
  }
}

async function loadArchive(archiveId) {
  await closeActiveSession();
  state.activeArchive = archiveId;
  clearTree();
  resetPreviewPane();
  setStatus(`正在解析 ${archiveId} 的目录树...`);

  const { children, fileCount } = await fetchJson(
    `/api/tree?archive=${encodeURIComponent(archiveId)}&path=`,
  );

  renderChildren(treeRoot, children);
  setStatus(
    `${archiveId} 已加载，共 ${fileCount.toLocaleString("zh-CN")} 个文件，文本：${
      textProfileLabels[state.activeTextProfile]
    }`,
  );
  await openDefaultPreview();
}

async function reloadActivePreview() {
  const selectedPath = state.activeFileButton?.dataset.path;

  await closeActiveSession();

  if (!selectedPath) {
    resetPreviewPane();
    setStatus(`文本已切换为${textProfileLabels[state.activeTextProfile]}`);
    return;
  }

  await loadFile(state.activeFileButton, selectedPath);
  setStatus(
    `${state.activeArchive} 已加载，文本：${textProfileLabels[state.activeTextProfile]}`,
  );
}

async function saveActiveFile() {
  if (!state.editable || !state.activeSessionId || !hasUnsavedChanges()) {
    return;
  }

  state.saving = true;
  updateActionState();
  setStatus(`正在保存 ${state.activeFilePath}...`);

  try {
    const payload = await postJson(
      `/api/file/save?archive=${encodeURIComponent(state.activeArchive)}`,
      {
        sessionId: state.activeSessionId,
        version: state.activeSessionVersion,
        content: fileEditor.value,
      },
    );

    applyOpenedFile(payload);
    setStatus(`已保存 ${state.activeFilePath}，会话版本 ${state.activeSessionVersion}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "保存失败";
    setStatus(
      /stale|version mismatch/i.test(message)
        ? `编辑会话已过期，请重新打开 ${state.activeFilePath}`
        : message,
    );
  } finally {
    state.saving = false;
    updateActionState();
  }
}

function resetActiveFile() {
  if (!state.editable) {
    return;
  }

  fileEditor.value = state.originalContent;
  updateActionState();
  setStatus(`已还原 ${state.activeFilePath} 的未保存修改`);
}

async function loadArchives() {
  setStatus("正在扫描 fixtures...");
  const { archives } = await fetchJson("/api/archives");
  archiveSelect.innerHTML = "";

  for (const archive of archives) {
    const option = document.createElement("option");
    option.value = archive.id;
    option.textContent = archive.relativePath;
    archiveSelect.append(option);
  }

  if (archives.length === 0) {
    setStatus("fixtures 中没有找到 .pvf 文件");
    clearTree();
    resetPreviewPane();
    filePath.textContent = "没有可浏览的 PVF";
    fileContent.textContent = "";
    return;
  }

  state.activeArchive = archives[0].id;
  archiveSelect.value = state.activeArchive;
  await loadArchive(state.activeArchive);
}

archiveSelect.addEventListener("change", () => {
  const nextArchive = archiveSelect.value;

  if (nextArchive === state.activeArchive) {
    return;
  }

  if (!confirmDiscardChanges()) {
    archiveSelect.value = state.activeArchive;
    return;
  }

  void loadArchive(nextArchive);
});

textProfileSelect.addEventListener("change", () => {
  const nextProfile = textProfileSelect.value;

  if (nextProfile === state.activeTextProfile) {
    return;
  }

  if (!confirmDiscardChanges()) {
    textProfileSelect.value = state.activeTextProfile;
    return;
  }

  state.activeTextProfile = nextProfile;
  void reloadActivePreview();
});

fileEditor.addEventListener("input", () => {
  updateActionState();
});

saveButton.addEventListener("click", () => {
  void saveActiveFile();
});

resetButton.addEventListener("click", () => {
  resetActiveFile();
});

window.addEventListener("beforeunload", (event) => {
  if (!hasUnsavedChanges()) {
    return;
  }

  event.preventDefault();
  event.returnValue = "";
});

window.addEventListener("pagehide", () => {
  closeActiveSessionWithBeacon();
});

void loadArchives();
