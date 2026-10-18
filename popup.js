const toggleEl = document.getElementById("toggle");
const autoEl = document.getElementById("autoTranslate");
const showButtonEl = document.getElementById("showButton");
const apiKeyEl = document.getElementById("apiKey");
const statusEl = document.getElementById("status");

chrome.storage.local
  .get(["autoTranslate", "showButton", "apiKey"])
  .then(({ autoTranslate = false, showButton = true, apiKey = "" }) => {
    autoEl.checked = autoTranslate;
    showButtonEl.checked = showButton;
    apiKeyEl.value = apiKey;
  });

autoEl.addEventListener("change", () => chrome.storage.local.set({ autoTranslate: autoEl.checked }));
showButtonEl.addEventListener("change", () => chrome.storage.local.set({ showButton: showButtonEl.checked }));

document.getElementById("save").addEventListener("click", async () => {
  await chrome.storage.local.set({ apiKey: apiKeyEl.value.trim() });
  statusEl.textContent = "保存しました";
  setTimeout(() => (statusEl.textContent = ""), 1500);
});

// ---- 現在のタブの翻訳 ON/OFF ----

function render(state) {
  toggleEl.disabled = false;
  toggleEl.textContent = state.enabled ? "原文に戻す" : "このページを翻訳";
}

async function sendToTab(type) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return chrome.tabs.sendMessage(tab.id, { type });
}

sendToTab("getState").then(render, () => {
  // chrome:// のページや、拡張を入れる前から開いていたタブ
  toggleEl.textContent = "このページでは使えません（再読み込みで有効）";
});

toggleEl.addEventListener("click", async () => {
  render(await sendToTab("toggle"));
});
