// ==UserScript==
// @name         YouTube Dual Subtitles
// @namespace    https://github.com/local/my-tampermonkey-scripts
// @version      0.2.0
// @description  Show an original YouTube caption track and its auto-translation at the same time.
// @match        https://www.youtube.com/watch*
// @match        https://www.youtube.com/embed/*
// @run-at       document-idle
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      youtube.com
// @connect      www.youtube.com
// @connect      *.youtube.com
// ==/UserScript==

(function () {
  "use strict";

  const CONFIG = {
    originalLang: "en",
    translatedLang: "ja",
    preferManualCaptions: true,
    bottomOffsetPercent: 13,
    pollMs: 120,
    playerReadyTimeoutMs: 6000,
    proofTokenTimeoutMs: 3500,
  };

  // Current yt-dlp Android client values (2026-07/08). This is only a fallback;
  // the live WEB player path is always tried first.
  const ANDROID_CLIENT = {
    clientName: "ANDROID",
    clientVersion: "21.26.364",
    androidSdkVersion: 30,
    osName: "Android",
    osVersion: "11",
    userAgent: "com.google.android.youtube/21.26.364 (Linux; U; Android 11) gzip",
    hl: "en",
    gl: "US",
  };

  const ROOT_ID = "yt-dualsub-root";
  const BUTTON_ID = "yt-dualsub-toggle";
  const STYLE_ID = "yt-dualsub-style";
  const STORAGE_KEY = "yt-dualsub-enabled";

  const STATE = {
    videoId: "",
    original: [],
    translated: [],
    status: "loading",
    enabled: loadEnabled(),
    lastOriginalText: "",
    lastTranslatedText: "",
    reloadTimer: 0,
    loadSerial: 0,
  };

  const PAGE = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
  const sleep = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));

  function addStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      #${ROOT_ID} {
        position: absolute;
        left: 50%;
        bottom: ${CONFIG.bottomOffsetPercent}%;
        transform: translateX(-50%);
        z-index: 2147483647;
        width: min(92%, 980px);
        pointer-events: none;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 6px;
        font-family: "Helvetica Neue", Arial, sans-serif;
        text-align: center;
      }
      #${ROOT_ID} .yt-dualsub-line {
        box-sizing: border-box;
        max-width: 100%;
        padding: 4px 10px;
        border-radius: 4px;
        background: rgba(0, 0, 0, 0.72);
        color: #fff;
        text-shadow: 0 1px 2px rgba(0, 0, 0, 0.9);
        line-height: 1.32;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
      }
      #${ROOT_ID} .yt-dualsub-original {
        font-size: clamp(17px, 2.2vw, 27px);
        font-weight: 650;
      }
      #${ROOT_ID} .yt-dualsub-translated {
        font-size: clamp(15px, 1.85vw, 23px);
        color: #f6f1bd;
        font-weight: 600;
      }
      #${ROOT_ID} .yt-dualsub-status {
        font-size: 13px;
        color: #ddd;
        background: rgba(0, 0, 0, 0.62);
      }
      #${BUTTON_ID} {
        position: absolute;
        top: 12px;
        right: 12px;
        z-index: 2147483647;
        box-sizing: border-box;
        min-width: 74px;
        height: 32px;
        padding: 0 10px;
        border: 1px solid rgba(255, 255, 255, 0.34);
        border-radius: 16px;
        background: rgba(0, 0, 0, 0.72);
        color: #fff;
        font: 700 12px/30px "Helvetica Neue", Arial, sans-serif;
        text-align: center;
        cursor: pointer;
        opacity: 0.32;
        transition: opacity 120ms ease, background 120ms ease, border-color 120ms ease;
      }
      .html5-video-player:hover #${BUTTON_ID},
      #movie_player:hover #${BUTTON_ID},
      #${BUTTON_ID}:focus-visible {
        opacity: 1;
      }
      #${BUTTON_ID}[aria-pressed="false"] {
        background: rgba(38, 38, 38, 0.78);
        border-color: rgba(255, 255, 255, 0.24);
        color: #ddd;
      }
    `;
    document.documentElement.appendChild(style);
  }

  function loadEnabled() {
    return localStorage.getItem(STORAGE_KEY) !== "false";
  }

  function saveEnabled(enabled) {
    localStorage.setItem(STORAGE_KEY, enabled ? "true" : "false");
  }

  function createLine(className) {
    const node = document.createElement("div");
    node.className = `yt-dualsub-line ${className}`;
    return node;
  }

  function ensureRoot() {
    addStyle();
    const player = document.querySelector(".html5-video-player") || document.querySelector("#movie_player");
    if (!player) return null;

    let root = document.getElementById(ROOT_ID);
    if (!root) {
      root = document.createElement("div");
      root.id = ROOT_ID;
      root.append(
        createLine("yt-dualsub-original"),
        createLine("yt-dualsub-translated"),
        createLine("yt-dualsub-status"),
      );
    }
    if (root.parentElement !== player) player.appendChild(root);
    return root;
  }

  function ensureToggleButton() {
    addStyle();
    const player = document.querySelector(".html5-video-player") || document.querySelector("#movie_player");
    if (!player) return null;

    let button = document.getElementById(BUTTON_ID);
    if (!button) {
      button = document.createElement("button");
      button.id = BUTTON_ID;
      button.type = "button";
      button.addEventListener("click", toggleEnabled);
    }
    if (button.parentElement !== player) player.appendChild(button);
    updateToggleButton(button);
    return button;
  }

  function updateToggleButton(button = document.getElementById(BUTTON_ID)) {
    if (!button) return;
    button.textContent = STATE.enabled ? "Dual Sub ON" : "Dual Sub OFF";
    button.title = STATE.enabled ? "二重字幕をOFFにする" : "二重字幕をONにする";
    button.setAttribute("aria-label", button.title);
    button.setAttribute("aria-pressed", STATE.enabled ? "true" : "false");
  }

  function toggleEnabled() {
    STATE.enabled = !STATE.enabled;
    saveEnabled(STATE.enabled);
    updateToggleButton();
    if (STATE.enabled) {
      STATE.videoId = "";
      loadForCurrentVideo();
    } else {
      STATE.loadSerial += 1;
      STATE.status = "";
      STATE.original = [];
      STATE.translated = [];
      STATE.lastOriginalText = "";
      STATE.lastTranslatedText = "";
      render();
    }
  }

  function getVideoId() {
    const url = new URL(location.href);
    if (url.pathname === "/watch") return url.searchParams.get("v") || "";
    if (url.pathname.startsWith("/embed/")) return url.pathname.split("/")[2] || "";
    return "";
  }

  function getMoviePlayer() {
    try {
      const doc = PAGE.document || document;
      return doc.getElementById("movie_player") || document.getElementById("movie_player");
    } catch (_) {
      return document.getElementById("movie_player");
    }
  }

  function normalizeTrack(track, source = "web") {
    if (!track) return null;
    return {
      languageCode: String(track.languageCode || track.lang_code || ""),
      kind: String(track.kind || ""),
      baseUrl: String(track.baseUrl || track.url || ""),
      isTranslatable: Boolean(track.isTranslatable),
      source,
    };
  }

  function normalizeTracks(tracks, source = "web") {
    return Array.from(tracks || [])
      .map((track) => normalizeTrack(track, source))
      .filter((track) => track?.baseUrl);
  }

  function getRuntimeCaptionTracks() {
    const player = getMoviePlayer();
    if (!player) return [];

    try {
      if (typeof player.getAudioTrack === "function") {
        const audioTrack = player.getAudioTrack();
        const tracks = normalizeTracks(audioTrack?.captionTracks);
        if (tracks.length) return tracks;
      }
    } catch (error) {
      console.debug("[yt-dualsub] getAudioTrack() unavailable", error);
    }

    try {
      if (typeof player.getPlayerResponse === "function") {
        const response = player.getPlayerResponse();
        if (response?.videoDetails?.videoId && response.videoDetails.videoId !== getVideoId()) return [];
        const tracks = normalizeTracks(
          response?.captions?.playerCaptionsTracklistRenderer?.captionTracks,
        );
        if (tracks.length) return tracks;
      }
    } catch (error) {
      console.debug("[yt-dualsub] getPlayerResponse() unavailable", error);
    }

    return [];
  }

  function extractPlayerResponse() {
    const videoId = getVideoId();
    const player = getMoviePlayer();

    try {
      if (player && typeof player.getPlayerResponse === "function") {
        const response = player.getPlayerResponse();
        if (!response?.videoDetails?.videoId || response.videoDetails.videoId === videoId) return response;
      }
    } catch (_) {
      // Fall through.
    }

    try {
      const response = PAGE.ytInitialPlayerResponse;
      if (response && (!response?.videoDetails?.videoId || response.videoDetails.videoId === videoId)) {
        return response;
      }
    } catch (_) {
      // Fall through.
    }

    for (const script of document.scripts) {
      const text = script.textContent || "";
      let fromIndex = 0;
      while (fromIndex < text.length) {
        const index = text.indexOf("ytInitialPlayerResponse", fromIndex);
        if (index < 0) break;
        const equalIndex = text.indexOf("=", index);
        const start = equalIndex >= 0 ? text.indexOf("{", equalIndex) : -1;
        const json = start >= 0 ? readBalancedJson(text, start) : "";
        fromIndex = index + 1;
        if (!json) continue;
        try {
          const response = JSON.parse(json);
          if (!response?.videoDetails?.videoId || response.videoDetails.videoId === videoId) return response;
        } catch (_) {
          // Continue searching.
        }
      }
    }
    return null;
  }

  function readBalancedJson(text, start) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i += 1) {
      const ch = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "{") depth += 1;
      else if (ch === "}") depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
    return "";
  }

  function getCaptionTracks() {
    const runtime = getRuntimeCaptionTracks();
    if (runtime.length) return runtime;
    return normalizeTracks(
      extractPlayerResponse()?.captions?.playerCaptionsTracklistRenderer?.captionTracks,
    );
  }

  async function waitForCaptionTracks(timeoutMs = CONFIG.playerReadyTimeoutMs) {
    const startedAt = Date.now();
    let tracks = getCaptionTracks();
    while (!tracks.length && Date.now() - startedAt < timeoutMs) {
      await sleep(200);
      tracks = getCaptionTracks();
    }
    return tracks;
  }

  function chooseOriginalTrack(tracks) {
    const lang = CONFIG.originalLang.toLowerCase();
    const candidates = tracks.filter((track) => {
      const code = String(track.languageCode || "").toLowerCase();
      return code === lang || code.startsWith(`${lang}-`);
    });
    const usable = candidates.length ? candidates : tracks;
    return (CONFIG.preferManualCaptions && usable.find((track) => track.kind !== "asr")) || usable[0] || null;
  }

  function withQuery(url, params, { overwrite = true } = {}) {
    const next = new URL(url, location.href);
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null || value === "") {
        if (overwrite) next.searchParams.delete(key);
      } else if (overwrite || !next.searchParams.has(key)) {
        next.searchParams.set(key, value);
      }
    }
    return next.toString();
  }

  async function requestText(url, { credentials = "include", allowGM = true } = {}) {
    let firstError = null;

    // Same-origin fetch is preferable now that subtitle PO tokens can be tied to
    // the live browser session/video. WEB requests include normal YouTube cookies;
    // Android fallback requests deliberately omit them to stay in that client context.
    try {
      const response = await fetch(url, { credentials });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await response.text();
      if (text.trim()) return text;
      firstError = new Error("Caption endpoint returned an empty response");
    } catch (error) {
      firstError = error;
    }

    if (!allowGM || typeof GM_xmlhttpRequest !== "function") throw firstError;

    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "GET",
        url,
        timeout: 6000,
        onload: (response) => {
          const text = response.responseText || "";
          if (response.status >= 200 && response.status < 300 && text.trim()) resolve(text);
          else reject(firstError || new Error(`GM request failed: HTTP ${response.status}, empty=${!text.trim()}`));
        },
        onerror: () => reject(firstError || new Error("GM request failed")),
        ontimeout: () => reject(firstError || new Error("GM request timed out")),
      });
    });
  }

  function getYtCfgValue(key) {
    try {
      const cfg = PAGE.ytcfg;
      if (typeof cfg?.get === "function") {
        const value = cfg.get(key);
        if (value !== undefined && value !== null) return value;
      }
      if (cfg?.data_ && cfg.data_[key] !== undefined) return cfg.data_[key];
    } catch (_) {
      // Fall through to script lookup where useful.
    }
    return undefined;
  }

  function getPlayerClientParams() {
    const clientVersion = getYtCfgValue("INNERTUBE_CLIENT_VERSION") || "";
    const ua = navigator.userAgent;
    const chrome = ua.match(/Chrome\/([0-9.]+)/)?.[1];
    const firefox = ua.match(/Firefox\/([0-9.]+)/)?.[1];
    const safari = !chrome && ua.match(/Version\/([0-9.]+).*Safari/)?.[1];
    const browserName = chrome ? "Chrome" : firefox ? "Firefox" : safari ? "Safari" : "";
    const browserVersion = chrome || firefox || safari || "";
    const isMac = /Macintosh/.test(ua);
    const isWindows = /Windows/.test(ua);

    return {
      xorb: "2",
      xobt: "3",
      xovt: "3",
      cbr: browserName,
      cbrver: browserVersion,
      c: "WEB",
      cver: clientVersion,
      cplayer: "UNIPLAYER",
      cos: isMac ? "Macintosh" : isWindows ? "Windows" : "",
      cosver: isMac ? (ua.match(/Mac OS X ([0-9_]+)/)?.[1] || "").replaceAll("_", ".") : "",
      cplatform: "DESKTOP",
    };
  }

  const TIMEDTEXT_CONTEXT_KEYS = [
    "pot", "potc", "xorb", "xobt", "xovt", "xowf", "cbrand", "cbr", "cbrver",
    "c", "cver", "cplayer", "cos", "cosver", "cplatform",
  ];

  function pickTimedtextContext(urlString) {
    try {
      const url = new URL(urlString, location.href);
      const result = {};
      for (const key of TIMEDTEXT_CONTEXT_KEYS) {
        const value = url.searchParams.get(key);
        if (value) result[key] = value;
      }
      return result;
    } catch (_) {
      return {};
    }
  }

  function getTimedtextContextParams() {
    const videoId = getVideoId();

    // The live movie_player often exposes a caption URL that already has the
    // fresh per-video PO token. Prefer that over the initial page response.
    for (const track of getRuntimeCaptionTracks()) {
      const params = pickTimedtextContext(track.baseUrl);
      if (params.pot) return params;
    }

    const entries = performance
      .getEntriesByType("resource")
      .map((entry) => entry.name)
      .filter((url) => {
        if (!url.includes("/api/timedtext")) return false;
        try {
          return new URL(url).searchParams.get("v") === videoId;
        } catch (_) {
          return false;
        }
      })
      .reverse();

    let best = {};
    for (const entryUrl of entries) {
      const params = pickTimedtextContext(entryUrl);
      if (!Object.keys(best).length) best = params;
      if (params.pot) return params;
    }
    return best;
  }

  async function waitForProofToken(timeoutMs = CONFIG.proofTokenTimeoutMs) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const params = getTimedtextContextParams();
      if (params.pot) return params;
      await sleep(100);
    }
    return getTimedtextContextParams();
  }

  async function primeProofParamsIfNeeded() {
    if (getTimedtextContextParams().pot) return;

    const button = document.querySelector(".ytp-subtitles-button");
    if (!button) return;

    const wasPressed = button.getAttribute("aria-pressed") === "true";

    // If captions were already ON, toggling only once turns them OFF and does
    // not generate a fresh timedtext request. Force OFF -> ON in that case.
    if (wasPressed) {
      button.click();
      await sleep(120);
      button.click();
    } else {
      button.click();
    }

    await waitForProofToken();

    // Restore the user's original native-caption state.
    if (!wasPressed && button.getAttribute("aria-pressed") === "true") {
      button.click();
    }
  }

  function buildCaptionUrl(track, translatedLang) {
    let url = withQuery(track.baseUrl, {
      fmt: "json3",
      tlang: translatedLang,
    });

    // Android is deliberately a separate fallback path. Do not contaminate an
    // Android signed caption URL with WEB client metadata or a WEB PO token.
    if (track.source === "android") return url;

    // Preserve values already supplied by YouTube's live caption URL. Only add
    // missing WEB client metadata, then inject the freshest observed PO token.
    url = withQuery(url, getPlayerClientParams(), { overwrite: false });
    url = withQuery(url, getTimedtextContextParams(), { overwrite: false });
    return url;
  }

  async function loadJson3Captions(track, translatedLang) {
    const url = buildCaptionUrl(track, translatedLang);
    const text = await requestText(url, {
      credentials: track.source === "android" ? "omit" : "include",
      allowGM: track.source !== "android",
    });
    if (!text.trim()) throw new Error("Caption endpoint returned an empty response");
    const payload = JSON.parse(text);
    const rows = parseJson3(payload);
    if (!rows.length) throw new Error("Caption endpoint returned no cue events");
    return rows;
  }

  function parseJson3(payload) {
    const rows = [];
    for (const event of payload.events || []) {
      if (!event.segs || event.tStartMs === undefined) continue;
      const text = event.segs
        .map((segment) => segment.utf8 || "")
        .join("")
        .replace(/\s+\n/g, "\n")
        .replace(/\n\s+/g, "\n")
        .trim();
      if (!text) continue;
      const startMs = Number(event.tStartMs);
      const durationMs = Number(event.dDurationMs || 1400);
      rows.push({ startMs, endMs: startMs + Math.max(durationMs, 600), text });
    }
    return rows.sort((a, b) => a.startMs - b.startMs);
  }

  function getInnertubeApiKey() {
    const configured = getYtCfgValue("INNERTUBE_API_KEY");
    if (configured) return String(configured);

    for (const script of document.scripts) {
      const match = (script.textContent || "").match(/"INNERTUBE_API_KEY"\s*:\s*"([^"]+)"/);
      if (match) return match[1];
    }
    return "";
  }

  async function fetchAndroidCaptionTracks(videoId) {
    const apiKey = getInnertubeApiKey();
    if (!apiKey) return [];

    try {
      const response = await fetch(
        `https://www.youtube.com/youtubei/v1/player?key=${encodeURIComponent(apiKey)}&prettyPrint=false`,
        {
          method: "POST",
          credentials: "omit",
          headers: {
            "Content-Type": "application/json",
            "X-YouTube-Client-Name": "3",
            "X-YouTube-Client-Version": ANDROID_CLIENT.clientVersion,
          },
          body: JSON.stringify({
            context: { client: ANDROID_CLIENT },
            videoId,
            contentCheckOk: true,
            racyCheckOk: true,
          }),
        },
      );
      if (!response.ok) throw new Error(`Android player API HTTP ${response.status}`);
      const payload = await response.json();
      return normalizeTracks(
        payload?.captions?.playerCaptionsTracklistRenderer?.captionTracks,
        "android",
      );
    } catch (error) {
      console.warn("[yt-dualsub] Android Innertube fallback failed", error);
      return [];
    }
  }

  async function loadPair(track) {
    return Promise.all([
      loadJson3Captions(track, ""),
      loadJson3Captions(track, CONFIG.translatedLang),
    ]);
  }

  async function loadForCurrentVideo() {
    if (!STATE.enabled) return;
    const videoId = getVideoId();
    if (!videoId || (videoId === STATE.videoId && STATE.original.length)) return;

    const serial = ++STATE.loadSerial;
    STATE.videoId = videoId;
    STATE.original = [];
    STATE.translated = [];
    STATE.lastOriginalText = "";
    STATE.lastTranslatedText = "";
    setStatus("字幕を読み込み中...");

    let tracks = await waitForCaptionTracks();
    if (serial !== STATE.loadSerial || getVideoId() !== videoId || !STATE.enabled) return;

    let track = chooseOriginalTrack(tracks);
    if (!track?.baseUrl) {
      // The WEB player occasionally exposes no captions yet even though the
      // Android player response does. Try that path before giving up.
      tracks = await fetchAndroidCaptionTracks(videoId);
      track = chooseOriginalTrack(tracks);
      if (!track?.baseUrl) {
        setStatus("この動画では取得可能な字幕トラックが見つかりません");
        return;
      }
    }

    const failures = [];

    try {
      const [original, translated] = await loadPair(track);
      if (serial !== STATE.loadSerial || getVideoId() !== videoId || !STATE.enabled) return;
      STATE.original = original;
      STATE.translated = translated;
      setStatus("");
      return;
    } catch (error) {
      failures.push(error);
    }

    // Refresh the live WEB caption URL and obtain the per-video PO token.
    try {
      await primeProofParamsIfNeeded();
      if (serial !== STATE.loadSerial || getVideoId() !== videoId || !STATE.enabled) return;
      track = chooseOriginalTrack(getCaptionTracks()) || track;
      const [original, translated] = await loadPair(track);
      if (serial !== STATE.loadSerial || getVideoId() !== videoId || !STATE.enabled) return;
      STATE.original = original;
      STATE.translated = translated;
      setStatus("");
      console.info("[yt-dualsub] caption load succeeded after live PO-token refresh", failures[0]);
      return;
    } catch (error) {
      failures.push(error);
    }

    // WEB subtitles are currently subject to rolling PO-token enforcement.
    // Android caption URLs are a useful fallback because Subs PO-token policy is
    // not currently enforced for this client in yt-dlp's client matrix.
    try {
      const androidTracks = await fetchAndroidCaptionTracks(videoId);
      const androidTrack = chooseOriginalTrack(androidTracks);
      if (!androidTrack?.baseUrl) throw new Error("Android player response had no usable caption track");
      const [original, translated] = await loadPair(androidTrack);
      if (serial !== STATE.loadSerial || getVideoId() !== videoId || !STATE.enabled) return;
      STATE.original = original;
      STATE.translated = translated;
      setStatus("");
      console.info("[yt-dualsub] caption load succeeded via Android Innertube fallback", failures);
      return;
    } catch (error) {
      failures.push(error);
    }

    console.error("[yt-dualsub] failed to load captions", failures);
    setStatus("字幕の取得に失敗しました。F12 Console の [yt-dualsub] を確認してください");
  }

  function findActive(rows, currentMs) {
    let low = 0;
    let high = rows.length - 1;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const row = rows[mid];
      if (currentMs < row.startMs) high = mid - 1;
      else if (currentMs > row.endMs + 220) low = mid + 1;
      else return row.text;
    }
    return "";
  }

  function setStatus(message) {
    STATE.status = message;
    render();
  }

  function render() {
    ensureToggleButton();
    const root = ensureRoot();
    if (!root) return;
    if (!STATE.enabled) {
      root.style.display = "none";
      return;
    }

    const video = document.querySelector("video");
    const currentMs = video ? video.currentTime * 1000 : 0;
    const originalText = findActive(STATE.original, currentMs);
    const translatedText = findActive(STATE.translated, currentMs);
    const originalNode = root.querySelector(".yt-dualsub-original");
    const translatedNode = root.querySelector(".yt-dualsub-translated");
    const statusNode = root.querySelector(".yt-dualsub-status");

    if (originalText !== STATE.lastOriginalText) {
      originalNode.textContent = originalText;
      STATE.lastOriginalText = originalText;
    }
    if (translatedText !== STATE.lastTranslatedText) {
      translatedNode.textContent = translatedText;
      STATE.lastTranslatedText = translatedText;
    }

    originalNode.style.display = originalText ? "" : "none";
    translatedNode.style.display = translatedText ? "" : "none";
    statusNode.textContent = STATE.status;
    statusNode.style.display = STATE.status ? "" : "none";
    root.style.display = originalText || translatedText || STATE.status ? "" : "none";
  }

  function scheduleReload() {
    clearTimeout(STATE.reloadTimer);
    STATE.loadSerial += 1;
    STATE.reloadTimer = window.setTimeout(() => {
      STATE.videoId = "";
      if (STATE.enabled) loadForCurrentVideo();
    }, 500);
  }

  function start() {
    ensureToggleButton();
    ensureRoot();
    if (STATE.enabled) loadForCurrentVideo();

    window.setInterval(() => {
      const videoId = getVideoId();
      if (videoId !== STATE.videoId) {
        if (STATE.enabled) scheduleReload();
        else STATE.videoId = videoId;
      }
      render();
    }, CONFIG.pollMs);

    window.addEventListener("yt-navigate-finish", scheduleReload);
    document.addEventListener("yt-navigate-finish", scheduleReload);
    window.addEventListener("popstate", scheduleReload);
  }

  start();
})();