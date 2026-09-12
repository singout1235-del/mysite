# NIM Studio — NVIDIA AI Playground 🚀

A single-page site that turns your **NVIDIA API key** (from [build.nvidia.com](https://build.nvidia.com)) into a full AI studio:

| Feature | What it does |
|---|---|
| 🔑 **API key setup** | Enter your `nvapi-…` key once — stored only in your browser (localStorage) |
| 🧩 **All models** | Loads every model available on your key, live, with search + category filters |
| 💬 **Chat** | Streaming chat with any model, system prompt, temperature & max-token controls |
| 📎 **File attachments** | Attach **images** (for vision models), and **text/code files** (`.txt`, `.md`, `.py`, `.json`, `.csv`, …) — drag & drop or paste supported |
| 🎨 **Image generation** | Pick an image model (FLUX, SDXL, …), write a prompt, get the image + download button |

No build step, no dependencies — just HTML/CSS/JS.

## Quick start

### Option A — local (recommended, works on Android/Termux too)
```bash
python3 server.py          # then open http://localhost:8000
```
`server.py` serves the site **and** proxies requests to `https://integrate.api.nvidia.com`
(needed if your browser blocks the direct call via CORS). The app auto-detects the proxy.

### Option B — any static host / GitHub Pages
Upload the files and open the page. The site first tries calling NVIDIA directly;
if the browser blocks it (CORS), switch connection mode to *Local proxy* and run
`server.py` instead.

## Using it
1. Click **Connect** → paste your NVIDIA API key → **Connect**.
2. All models on your key appear under **🧩 Models** — tap **Use** on any chat or image model.
3. **💬 Chat**: type a message, attach files with 📎 (images go to vision models), Enter to send.
4. **🎨 Image**: choose an image model, describe what you want, hit **✨ Generate**.

> ℹ️ Some models on build.nvidia.com require you to open their page once and accept the
> terms before they work via API. If a model errors, the exact API message is shown.

## Files
- `index.html` — app UI
- `styles.css` — dark NVIDIA-green theme (mobile-first)
- `app.js` — all logic (models, streaming chat, attachments, image gen)
- `server.py` — optional zero-dependency local server + NVIDIA proxy
