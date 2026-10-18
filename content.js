(() => {
  const BLOCK_SELECTOR =
    "p, li, h1, h2, h3, h4, h5, h6, td, th, dt, dd, blockquote, figcaption, caption, summary";
  const CANDIDATE_SELECTOR = BLOCK_SELECTOR + ", div";
  const SKIP_ANCESTOR =
    "pre, code, script, style, noscript, textarea, select, svg, [contenteditable=''], [contenteditable='true'], .sarashina-tr";
  const INLINE_TAGS = new Set([
    "A", "SPAN", "B", "I", "EM", "STRONG", "SMALL", "SUB", "SUP", "BR", "ABBR",
    "MARK", "U", "S", "TIME", "IMG", "CODE", "KBD", "Q", "CITE", "LABEL", "WBR",
  ]);
  const JA = /[぀-ヿ㐀-鿿ｦ-ﾟ]/;
  const MARK = "data-sarashina";
  const MAX_LEN = 5000;

  let enabled = false;

  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        io.unobserve(e.target);
        translateElement(e.target);
      }
    },
    { rootMargin: "300px 0px" }
  );

  // ---- 判定 ----

  function isEnglish(text) {
    if (JA.test(text)) return false;
    const letters = (text.match(/[A-Za-z]/g) || []).length;
    if (letters < 4) return false;
    const nonSpace = text.replace(/\s/g, "").length;
    return letters / nonSpace >= 0.5;
  }

  // div はインライン要素とテキストだけを持つもの（=実質的な段落）だけ対象にする
  function isInlineOnlyDiv(el) {
    let hasText = false;
    for (const node of el.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        if (node.nodeValue.trim()) hasText = true;
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        if (!INLINE_TAGS.has(node.tagName)) return false;
      }
    }
    return hasText;
  }

  function consider(el) {
    if (el.hasAttribute(MARK)) return;
    if (el.closest(SKIP_ANCESTOR)) return;
    if (el.tagName === "DIV") {
      if (!isInlineOnlyDiv(el)) return;
    } else if (el.querySelector(CANDIDATE_SELECTOR)) {
      return; // 内側のブロックを個別に翻訳する
    }
    const text = el.textContent.trim();
    if (!text || text.length > MAX_LEN || !isEnglish(text)) return;

    el.setAttribute(MARK, "pending");
    io.observe(el);
  }

  function scan(root) {
    if (!enabled || root.nodeType !== Node.ELEMENT_NODE) return;
    if (root.matches(CANDIDATE_SELECTOR)) consider(root);
    for (const el of root.querySelectorAll(CANDIDATE_SELECTOR)) consider(el);
  }

  // ---- 翻訳 ----

  async function translateElement(el) {
    if (!enabled || !el.isConnected) return;
    const text = el.innerText.trim();
    if (!text) return;

    const box = document.createElement("span");
    box.className = "sarashina-tr sarashina-loading";
    box.textContent = "翻訳中…";
    el.appendChild(box);

    let res;
    try {
      res = await chrome.runtime.sendMessage({ type: "translate", text });
    } catch (err) {
      res = { ok: false, error: String(err?.message || err) };
    }

    if (!box.isConnected) return; // 待っている間に「原文に戻す」された
    box.classList.remove("sarashina-loading");
    if (res?.ok) {
      box.textContent = res.text;
      el.setAttribute(MARK, "done");
    } else {
      box.classList.add("sarashina-error");
      box.textContent = `翻訳エラー: ${res?.error ?? "unknown"}`;
      el.setAttribute(MARK, "error");
    }
  }

  function clearAll() {
    io.disconnect();
    for (const box of document.querySelectorAll(".sarashina-tr")) box.remove();
    for (const el of document.querySelectorAll(`[${MARK}]`)) el.removeAttribute(MARK);
  }

  // ---- 動的に追加されるコンテンツ ----

  const pending = new Set();
  let timer = null;

  const mo = new MutationObserver((mutations) => {
    if (!enabled) return;
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        if (node.classList.contains("sarashina-tr")) continue;
        pending.add(node);
      }
    }
    if (pending.size && !timer) {
      timer = setTimeout(() => {
        timer = null;
        for (const node of pending) if (node.isConnected) scan(node);
        pending.clear();
      }, 300);
    }
  });

  // ---- ON/OFF ----

  function setEnabled(value) {
    if (value === enabled) return;
    enabled = value;
    if (enabled) {
      scan(document.body);
      mo.observe(document.body, { childList: true, subtree: true });
    } else {
      mo.disconnect();
      clearAll();
    }
    updateButton();
  }

  // ---- ページ右下の翻訳ボタン ----

  const BUTTON_SIZE = 44;
  const DRAG_THRESHOLD = 4; // これ以上動いたらクリックではなくドラッグとみなす

  let buttonHost = null;
  let button = null;
  let buttonPos = { right: 20, bottom: 20 }; // 画面右下からの距離（px）

  function createButton() {
    if (buttonHost) return;
    buttonHost = document.createElement("sarashina-translate-button");
    // ページの CSS の影響を受けないよう Shadow DOM に閉じ込める
    const shadow = buttonHost.attachShadow({ mode: "closed" });
    shadow.innerHTML = `
      <style>
        button {
          position: fixed; z-index: 2147483647;
          width: ${BUTTON_SIZE}px; height: ${BUTTON_SIZE}px; border-radius: 50%;
          border: 2px solid #1a73e8; background: #1a73e8; color: #fff;
          font: bold 15px system-ui, sans-serif; cursor: pointer;
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25); opacity: 0.85;
          touch-action: none; user-select: none;
        }
        button:hover { opacity: 1; }
        button.on { background: #fff; color: #1a73e8; }
        button.dragging { cursor: grabbing; opacity: 1; }
      </style>
      <button type="button"></button>`;
    button = shadow.querySelector("button");
    setupDrag(button);
    // body の外に置くことで翻訳対象のスキャンに含まれないようにする
    document.documentElement.appendChild(buttonHost);
    applyButtonPos();
    updateButton();
  }

  function removeButton() {
    buttonHost?.remove();
    buttonHost = button = null;
  }

  // 画面外にはみ出さないように補正して反映する
  function applyButtonPos() {
    if (!button) return;
    const clamp = (v, max) => Math.min(Math.max(v, 0), Math.max(max, 0));
    button.style.right = clamp(buttonPos.right, innerWidth - BUTTON_SIZE) + "px";
    button.style.bottom = clamp(buttonPos.bottom, innerHeight - BUTTON_SIZE) + "px";
  }

  function setupDrag(btn) {
    let start = null;
    let dragged = false;

    btn.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      start = { x: e.clientX, y: e.clientY, ...buttonPos };
      dragged = false;
      btn.setPointerCapture(e.pointerId);
    });

    btn.addEventListener("pointermove", (e) => {
      if (!start) return;
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      if (!dragged && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      dragged = true;
      btn.classList.add("dragging");
      buttonPos = { right: start.right - dx, bottom: start.bottom - dy };
      applyButtonPos();
    });

    const end = () => {
      if (!start) return;
      start = null;
      btn.classList.remove("dragging");
      if (dragged) {
        // 補正後の位置を保存（他のタブ・次回以降も同じ位置に出る）
        buttonPos = { right: parseFloat(btn.style.right), bottom: parseFloat(btn.style.bottom) };
        chrome.storage.local.set({ buttonPos });
      }
    };
    btn.addEventListener("pointerup", end);
    btn.addEventListener("pointercancel", end);

    btn.addEventListener("click", () => {
      if (dragged) {
        dragged = false; // ドラッグ直後の click は無視
        return;
      }
      setEnabled(!enabled);
    });
  }

  addEventListener("resize", applyButtonPos);

  function updateButton() {
    if (!button) return;
    button.textContent = enabled ? "訳" : "訳";
    button.title = enabled ? "原文に戻す" : "このページの英語を翻訳";
    button.classList.toggle("on", enabled);
  }

  // ---- 設定・ポップアップとの連携 ----

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "toggle") setEnabled(!enabled);
    if (msg?.type === "toggle" || msg?.type === "getState") sendResponse({ enabled });
  });

  chrome.storage.local
    .get(["autoTranslate", "showButton", "buttonPos"])
    .then(({ autoTranslate = false, showButton = true, buttonPos: pos }) => {
      if (pos) buttonPos = pos;
      if (showButton) createButton();
      if (autoTranslate) setEnabled(true);
    });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if ("showButton" in changes) {
      changes.showButton.newValue === false ? removeButton() : createButton();
    }
    if ("buttonPos" in changes && changes.buttonPos.newValue) {
      buttonPos = changes.buttonPos.newValue;
      applyButtonPos();
    }
  });
})();
