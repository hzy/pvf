const archiveSelect = document.querySelector("#archive-select");
const textProfileSelect = document.querySelector("#text-profile-select");
const archiveStatus = document.querySelector("#archive-status");
const treeRoot = document.querySelector("#tree-root");
const filePath = document.querySelector("#file-path");
const fileContent = document.querySelector("#file-content");

const textProfileLabels = {
  simplified: "简体",
  traditional: "繁体",
};

let activeArchive = "";
let activeTextProfile = textProfileSelect.value;
let activeFileButton = null;

async function fetchJson(url) {
  const response = await fetch(url);
  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error ?? "Request failed.");
  }

  return data;
}

function setStatus(text) {
  archiveStatus.textContent = text;
}

function clearTree() {
  treeRoot.innerHTML = "";
}

function createFileRequestUrl(selectedPath) {
  return (
    `/api/file?archive=${encodeURIComponent(activeArchive)}` +
    `&path=${encodeURIComponent(selectedPath)}` +
    `&textProfile=${encodeURIComponent(activeTextProfile)}`
  );
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
      void loadFile(button, child.path);
    });
    container.append(button);
  }
}

async function loadDirectory(details, treePath) {
  const childContainer = details.querySelector(".tree__children");
  childContainer.textContent = "读取中...";

  try {
    const { children } = await fetchJson(
      `/api/tree?archive=${encodeURIComponent(activeArchive)}&path=${encodeURIComponent(treePath)}`,
    );

    childContainer.textContent = "";
    renderChildren(childContainer, children);
  } catch (error) {
    childContainer.textContent = error instanceof Error ? error.message : "读取失败";
  }
}

async function loadFile(button, selectedPath) {
  if (activeFileButton) {
    activeFileButton.classList.remove("is-active");
  }

  activeFileButton = button;
  activeFileButton.classList.add("is-active");
  filePath.textContent = selectedPath;
  filePath.title = selectedPath;
  fileContent.textContent = "读取文件内容...";

  try {
    const { content } = await fetchJson(createFileRequestUrl(selectedPath));
    fileContent.textContent = content;
  } catch (error) {
    fileContent.textContent = error instanceof Error ? error.message : "读取失败";
  }
}

async function openDefaultPreview() {
  const equipmentNode = treeRoot.querySelector('details[data-path="equipment"]');

  if (!equipmentNode) {
    return;
  }

  equipmentNode.open = true;
  await loadDirectory(equipmentNode, "equipment");

  const defaultFileButton = equipmentNode.querySelector('button[data-path="equipment/equipment.lst"]');

  if (defaultFileButton) {
    await loadFile(defaultFileButton, "equipment/equipment.lst");
  }
}

async function loadArchive(archiveId) {
  activeArchive = archiveId;
  clearTree();
  filePath.textContent = "选择左侧文件查看内容";
  filePath.title = "";
  fileContent.textContent = "# PVF Explorer";
  setStatus(`解析 ${archiveId} 的目录树...`);

  const { children, fileCount } = await fetchJson(
    `/api/tree?archive=${encodeURIComponent(archiveId)}&path=`,
  );

  renderChildren(treeRoot, children);
  setStatus(
    `${archiveId} 已加载，共 ${fileCount.toLocaleString("zh-CN")} 个文件，文本：${textProfileLabels[activeTextProfile]}`,
  );
  await openDefaultPreview();
}

async function reloadActivePreview() {
  const selectedPath = activeFileButton?.dataset.path;

  if (!selectedPath) {
    setStatus(`文本已切换为${textProfileLabels[activeTextProfile]}`);
    return;
  }

  await loadFile(activeFileButton, selectedPath);
  setStatus(
    `${activeArchive} 已加载，文本：${textProfileLabels[activeTextProfile]}`,
  );
}

async function loadArchives() {
  setStatus("扫描 fixtures...");
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
    filePath.textContent = "没有可浏览的 PVF";
    filePath.title = "";
    fileContent.textContent = "";
    return;
  }

  activeArchive = archives[0].id;
  archiveSelect.value = activeArchive;
  await loadArchive(activeArchive);
}

archiveSelect.addEventListener("change", () => {
  void loadArchive(archiveSelect.value);
});

textProfileSelect.addEventListener("change", () => {
  activeTextProfile = textProfileSelect.value;
  void reloadActivePreview();
});

void loadArchives();
