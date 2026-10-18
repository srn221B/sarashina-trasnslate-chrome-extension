# sarashina-trasnslate-chrome-extension

A Chrome extension that translates English text on web pages into Japanese using the [Sarashina API](https://docs.sarashina.ai/), showing the translation right below the original.

```
This is a pen
┃ これはペンです
```

## Features

- **One-click translation** — click the floating button (訳) at the bottom-right of any page to translate it; click again (原) to restore the original.
- **Draggable button** — drag the button anywhere on the screen. Its position is saved and shared across tabs.
- **Optional auto-translate** — translate every page automatically when it loads.
- **Translates only what you see** — paragraphs are translated as they scroll into view, including content added dynamically (e.g. infinite timelines).
- **Rate-limit aware** — works within the API's limits (see [Rate limits](#rate-limits)).
- **Skips non-prose** — `pre`, `code`, form fields, and text that already contains Japanese are left untouched.

## Requirements

- Google Chrome (or another Chromium-based browser) with Manifest V3 support
- A Sarashina API key — issue one from the [dashboard](https://chat.sarashina.ai/dashboard/api-keys)

## Installation

1. Clone this repository.
2. Open `chrome://extensions` in Chrome.
3. Turn on **Developer mode** (top-right).
4. Click **Load unpacked** and select the cloned repository directory.
5. Click the extension icon in the toolbar, enter your API key, and press **保存** (Save).

Tabs that were already open before installation need to be reloaded.

## Usage

| Action | How |
| --- | --- |
| Translate the current page | Click the floating **訳** button, or open the popup and click **このページを翻訳** |
| Restore the original | Click the **原** button, or **原文に戻す** in the popup |
| Move the button | Drag it |
| Auto-translate on page load | Popup → check **ページを開いたら自動で翻訳する** (off by default) |
| Hide the floating button | Popup → uncheck **ページ右下に翻訳ボタンを表示する** |

## Rate limits

The Translate API (`sarashina3-translate`) allows **6 requests per minute**, one text per request, up to **5,000 characters** each ([docs](https://docs.sarashina.ai/rate-limits)). To make the most of this, the extension:

- **Batches paragraphs** — joins multiple paragraphs into a single request using numbered markers (`[[1]] … [[2]] …`) and splits the response back by marker. Any paragraph whose marker cannot be recovered is retried on its own.
- **Throttles requests** — tracks requests over a sliding one-minute window and waits before exceeding the limit.
- **Retries on `429`** — waits for the duration in the `Retry-After` header before retrying (up to 5 times).
- **Prioritizes visible text** — the most recently requested paragraphs (what's on screen) are sent first.
- **Caches results** — translations are reused until the browser is closed, so reloading a page costs no extra requests.

## Project structure

```
.
├── manifest.json   # Extension manifest (MV3)
├── background.js   # API calls, batching, rate limiting, caching
├── content.js      # Detects English blocks, renders translations, floating button
├── content.css     # Styles for the inline translations
├── popup.html      # Toolbar popup UI
├── popup.js        # Popup logic (toggle, settings, API key)
└── icons/          # Extension icons (16/32/48/128 px)
```

API requests are sent from the background service worker rather than the content script, which avoids CORS restrictions on web pages.

## Privacy

- Your API key is stored locally in `chrome.storage.local` and is sent only to `api.sarashina.ai`.
- Text from the pages you choose to translate is sent to the Sarashina API.

## Limitations

- Only English → Japanese is supported.
- When a list item contains a nested list, only the nested items are translated, not the parent item's own text.
- Translations are not updated if a page later changes the text of an already-translated element.
