# Vega Web — Complete Web Platform & Stream Accelerator

A universal, cross-platform web implementation of **Vega** engineered to run seamlessly in **both PC and mobile browsers without requiring any browser extensions or native apps**.

---

## 🚀 Key Features

1. **Zero-Extension Universal Web App (Mobile & Desktop)**
   - Pre-configured with the in-page `vegaPlatformHost` bridge (`kind: 'browser-extension'`).
   - Seamlessly runs in Safari (iOS/iPadOS), Chrome (Android & PC), Firefox, Edge, and Brave.
   - Completely removes the *"Install Vega extension"* dialog.

2. **Zero-Buffer Stream Acceleration (`/source`, `/playlist.m3u8`, `/segment.ts`)**
   - Matches the exact streaming protocol used by Tauri Desktop (`stream_server.rs`).
   - Forwards byte-range seeks (`Range: bytes=...`) with `206 Partial Content`.
   - Injects permissive CORS (`Access-Control-Allow-Origin: *`) and exposes media headers.
   - Rewrites HLS playlists on-the-fly so segments and decryption keys stream without CORS blocks.

3. **Mobile Cinema Gestures & Auto-Rotate Landscape**
   - **Auto-Rotate to Landscape**: Automatically enters fullscreen and locks device orientation to landscape upon playing video or tapping fullscreen on mobile.
   - **Swipe Volume (Right side)**: Swipe vertically on the right half of the screen to adjust volume (0%–100%) with real-time HUD and volume level icons.
   - **Swipe Brightness (Left side)**: Swipe vertically on the left half of the screen to adjust brightness with instant OLED glass HUD and seamless dimming overlay.
   - **Zero Interference**: Distinguishes between control button taps, scrubber scrubbing, and vertical swipe gestures.

4. **Cloudflare Edge Stream Accelerator (`cloudflare-stream-accelerator.js`)**
   - Deploy as a free Cloudflare Worker for global multi-gigabit streaming acceleration.
   - Point the web app to your worker URL via `localStorage.setItem('vegaStreamAccelerator', 'https://your-worker.workers.dev')`.

4. **Bundled Unpacked Browser Extension (`extension/`)**
   - Packaged inside the `extension/` directory with full Manifest V3 compatibility (`cookieRules.mjs`, `media.mjs`, `http.mjs`, `background.mjs`).
   - For PC Chrome/Edge users who prefer running with the browser extension:
     1. Open `chrome://extensions/` and toggle **Developer mode**.
     2. Click **Load unpacked** and select the `d:\vega-web\extension` folder.
     3. Open the extension popup, click **Allow all websites**, and reload Vega Web.

---

## 🏃 Running the Web App Locally

Double-click **`run-local.cmd`** or run:
```cmd
run-local.cmd
```
Then open:
👉 **`http://localhost:8000`**

The server automatically defaults `PROXY_ALLOWED_HOSTS=*` and `STREAM_ALLOWED_HOSTS=*`, ensuring all providers and video streams work immediately out-of-the-box.

---

## ☁️ Deploying to Cloudflare Workers (Optional Edge Accelerator)

To deploy the Cloudflare Edge Stream Accelerator:
```bash
npx wrangler deploy --config wrangler.accelerator.jsonc
```

### Connecting the Accelerator:
You can connect the accelerator in either of two ways:

1. **Automatic (Server Environment Variable)**:
   Set `STREAM_ACCELERATOR_URL` on your server (e.g. in Koyeb, Docker, or `run-local.cmd`):
   ```cmd
   set STREAM_ACCELERATOR_URL=https://your-worker.workers.dev
   ```
   All desktop and mobile clients visiting Vega Web will automatically use Cloudflare Edge acceleration with zero setup!

2. **In Browser Console or Settings**:
   Run in the browser developer console:
   ```javascript
   setStreamAccelerator('https://your-worker.workers.dev');
   ```
   (To reset back to local server, call `setStreamAccelerator(null)`).

---

## ⚡ Smooth Playback & Anti-Buffering Architecture

Videos buffer and stutter on web browsers when player buffers starve or chunk decoders fail. Vega Web solves this through a 4-layer acceleration pipeline:

1. **Patched Libmedia WASM Decoder Chunks**:
   - All 64 `@libmedia/avplayer` WASM decoder chunks (`*.avplayer.js`) are pre-installed in `/public` and `/public/assets` with Vega's official ASS subtitle parser and MKV metadata patches.
2. **16 MB Preload Buffer**:
   - Upgraded player preload chunking from 5 MB to 16 MB (`preload: 16777216`), preventing network starvation on high-bitrate 1080p/4K streams.
3. **15-Second Jitter Absorption Buffer**:
   - Libmedia AVPlayer configured with `enableJitterBuffer: true`, `jitterBufferMin: 2`, `jitterBufferMax: 10`, and `preLoadTime: 15` to smooth out network latency spikes and eliminate second-by-second micro-stutters.
4. **Optimized Socket Streaming & Edge Caching**:
   - Node relay streams with 1 MB chunk backpressure buffers (`Readable.fromWeb(r.body, { highWaterMark: 1MB })`) and `setNoDelay(true)`.
   - Cloudflare Worker accelerator provides global multi-tiered edge caching (`cacheEverything: true`, `cacheTtl: 86400`) and sub-15ms Range seek responses.
