// API 呼び出しはここで行う（content script から直接 fetch すると CORS に引っかかるため）
//
// sarashina3-translate は 6 RPM・1 リクエスト 1 テキスト（最大 5,000 文字）なので、
// 複数段落を番号付きマーカーで 1 テキストにまとめて送り、結果をマーカーで分割する。
// https://docs.sarashina.ai/rate-limits
// https://docs.sarashina.ai/api-reference/translate
const API_URL = "https://api.sarashina.ai/v1/translate";
const RPM = 6;
const WINDOW_MS = 60_000;
const MAX_CHARS = 5000;
const MAX_RETRIES = 5;
const MAX_CACHE = 2000;

let running = false;
let pausedUntil = 0; // 429 を受けたらこの時刻まで止める
const sentAt = []; // 直近 1 分間の送信時刻
const queue = []; // { text, resolve, reject, solo }
const cache = new Map(); // text -> Promise<string>

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "translate") return;
  enqueue(msg.text).then(
    (text) => sendResponse({ ok: true, text }),
    (err) => sendResponse({ ok: false, error: String(err?.message || err) })
  );
  return true; // 非同期で sendResponse する
});

function enqueue(text) {
  if (cache.has(text)) return cache.get(text);
  if (cache.size >= MAX_CACHE) cache.clear();

  const p = (async () => {
    if (text.length > MAX_CHARS) throw new Error(`${MAX_CHARS} 文字を超えています`);

    // Service Worker が再起動してもブラウザを閉じるまでは訳を使い回す（RPM 節約）
    const key = "tr:" + text;
    const stored = (await chrome.storage.session.get(key))[key];
    if (stored) return stored;

    const translated = await new Promise((resolve, reject) => {
      queue.push({ text, resolve, reject, solo: false });
      run();
    });
    chrome.storage.session.set({ [key]: translated }).catch(() => {});
    return translated;
  })();
  cache.set(text, p);
  p.catch(() => cache.delete(text)); // 失敗したものはキャッシュしない
  return p;
}

// ---- バッチ処理 ----

const marker = (i) => `[[${i}]] `;

// 後から来たもの（＝今画面に見えている段落）を優先して、文字数上限まで詰める
function takeBatch() {
  const batch = [queue.pop()];
  if (batch[0].solo) return batch;

  let size = marker(1).length + batch[0].text.length;
  for (let i = queue.length - 1; i >= 0; i--) {
    const job = queue[i];
    if (job.solo) continue;
    const add = 2 + marker(batch.length + 1).length + job.text.length;
    if (size + add > MAX_CHARS) break;
    batch.push(job);
    queue.splice(i, 1);
    size += add;
  }
  return batch;
}

async function run() {
  if (running) return;
  running = true;
  try {
    while (queue.length) {
      // 送信できるようになるまで待ち、その間に溜まった段落をまとめて送る
      await acquireSlot({ consume: false });
      await new Promise((r) => setTimeout(r, 300));
      const batch = takeBatch();
      try {
        await processBatch(batch);
      } catch (err) {
        for (const job of batch) job.reject(err);
      }
    }
  } finally {
    running = false;
  }
}

async function processBatch(batch) {
  if (batch.length === 1) {
    batch[0].resolve(await callApi(batch[0].text));
    return;
  }

  const body = batch.map((job, i) => marker(i + 1) + job.text).join("\n\n");
  const parts = splitByMarkers(await callApi(body));

  for (const [i, job] of batch.entries()) {
    const t = parts.get(i + 1);
    if (t) {
      job.resolve(t);
    } else {
      // マーカーが崩れて取り出せなかったものは単独で送り直す
      job.solo = true;
      queue.push(job);
    }
  }
}

function splitByMarkers(text) {
  const parts = new Map();
  const re = /\[\[\s*(\d+)\s*\]\]/g;
  const hits = [...text.matchAll(re)];
  for (const [k, m] of hits.entries()) {
    const end = k + 1 < hits.length ? hits[k + 1].index : text.length;
    const chunk = text.slice(m.index + m[0].length, end).trim();
    if (chunk) parts.set(Number(m[1]), chunk);
  }
  return parts;
}

// ---- レート制限 ----

// 長い待機中に Service Worker が停止されないよう、20 秒ごとに拡張 API を叩く
async function sleep(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    await new Promise((r) => setTimeout(r, Math.min(end - Date.now(), 20_000)));
    chrome.runtime.getPlatformInfo();
  }
}

async function acquireSlot({ consume = true } = {}) {
  for (;;) {
    const now = Date.now();
    while (sentAt.length && sentAt[0] <= now - WINDOW_MS) sentAt.shift();

    if (now < pausedUntil) {
      await sleep(pausedUntil - now);
    } else if (sentAt.length >= RPM) {
      await sleep(sentAt[0] + WINDOW_MS - now + 100);
    } else {
      if (consume) sentAt.push(now);
      return;
    }
  }
}

async function callApi(text) {
  const { apiKey } = await chrome.storage.local.get("apiKey");
  if (!apiKey) throw new Error("API キーが未設定です（拡張機能アイコンから設定してください）");

  for (let attempt = 0; ; attempt++) {
    await acquireSlot();
    const res = await fetch(API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text, source_lang: "en", target_lang: "ja" }),
    });

    if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
      const retryAfter = Number(res.headers.get("Retry-After"));
      const wait = retryAfter > 0 ? retryAfter * 1000 + 500 : Math.min(5000 * 2 ** attempt, WINDOW_MS);
      pausedUntil = Math.max(pausedUntil, Date.now() + wait);
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();
    if (typeof data.translated_text !== "string") throw new Error("不正なレスポンス");
    return data.translated_text;
  }
}
