// ==UserScript==
// @name         YouTube Secondary Subtitles No Autoclick
// @namespace    https://github.com/local/my-tampermonkey-scripts
// @version      0.3.0
// @description  Show a second translated subtitle line while YouTube's native CC is on, without auto-clicking YouTube controls.
// @match        https://www.youtube.com/watch*
// @match        https://www.youtube.com/embed/*
// @run-at       document-idle
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
  };

  const ROOT_ID = "yt-dualsub-root";
  const STYLE_ID = "yt-dualsub-style";

  const STATE = {
    videoId: "",
    translated: [],
    status: "",
    enabled: false,
    lastTranslatedText: "",
    reloadTimer: 0,
    lastProofKey: "",
  };

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
    `;
    document.documentElement.appendChild(style);
  }

  function createLine(className) {
    const node = document.createElement("div");
    node.className = `yt-dualsub-line ${className}`;
    return node;
  }

  function ensureRoot() {
    addStyle();
    let player = document.querySelector(".html5-video-player") || document.querySelector("#movie_player");
    if (!player) return null;

    let root = document.getElementById(ROOT_ID);
    if (!root) {
      root = document.createElement("div");
      root.id = ROOT_ID;
      root.append(
        createLine("yt-dualsub-translated"),
        createLine("yt-dualsub-status"),
      );
    }
    if (root.parentElement !== player) player.appendChild(root);
    return root;
  }

  function isNativeCcEnabled() {
    const button = document.querySelector(".ytp-subtitles-button");
    return button?.getAttribute("aria-pressed") === "true";
  }

  function clearSecondSubtitle() {
    STATE.translated = [];
    STATE.status = "";
    STATE.lastTranslatedText = "";
    render();
  }

  function syncWithNativeCc() {
    const enabled = isNativeCcEnabled();
    if (enabled === STATE.enabled) return;
    STATE.enabled = enabled;
    if (enabled) {
      STATE.videoId = "";
      scheduleReload();
    } else {
      clearSecondSubtitle();
    }
  }

  function getVideoId() {
    const url = new URL(location.href);
    if (url.pathname === "/watch") return url.searchParams.get("v") || "";
    if (url.pathname.startsWith("/embed/")) return url.pathname.split("/")[2] || "";
    return "";
  }

  function extractPlayerResponse() {
    if (window.ytInitialPlayerResponse) return window.ytInitialPlayerResponse;
    for (const script of document.scripts) {
      const text = script.textContent || "";
      const index = text.indexOf("ytInitialPlayerResponse");
      if (index < 0) continue;
      const start = text.indexOf("{", text.indexOf("=", index));
      const json = start >= 0 ? readBalancedJson(text, start) : "";
      if (!json) continue;
      try {
        return JSON.parse(json);
      } catch (_) {
        // Continue searching.
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
    return extractPlayerResponse()?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
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

  function withQuery(url, params) {
    const next = new URL(url, location.href);
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null || value === "") next.searchParams.delete(key);
      else next.searchParams.set(key, value);
    }
    return next.toString();
  }

  function requestText(url) {
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest === "function") {
        GM_xmlhttpRequest({
          method: "GET",
          url,
          onload: (response) => resolve(response.responseText || ""),
          onerror: reject,
          ontimeout: reject,
        });
      } else {
        fetch(url, { credentials: "include" })
          .then((response) => {
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return response.text();
          })
          .then(resolve, reject);
      }
    });
  }

  function getPlayerClientParams() {
    const cfg = window.ytcfg;
    const clientVersion = typeof cfg?.get === "function"
      ? cfg.get("INNERTUBE_CLIENT_VERSION")
      : cfg?.data_?.INNERTUBE_CLIENT_VERSION;
    const chrome = navigator.userAgent.match(/Chrome\/([0-9.]+)/)?.[1] || "";
    return {
      xorb: "2",
      xobt: "3",
      xovt: "3",
      cbrand: "apple",
      cbr: "Chrome",
      cbrver: chrome,
      c: "WEB",
      cver: clientVersion || "",
      cplayer: "UNIPLAYER",
      cos: "Macintosh",
      cosver: "10_15_7",
      cplatform: "DESKTOP",
    };
  }

  function getTimedtextProofParams() {
    const videoId = getVideoId();
    const entries = performance
      .getEntriesByType("resource")
      .map((entry) => entry.name)
      .filter((url) => url.includes("/api/timedtext") && url.includes(`v=${videoId}`))
      .reverse();
    for (const entryUrl of entries) {
      try {
        const url = new URL(entryUrl);
        const pot = url.searchParams.get("pot");
        if (pot) return { pot, potc: url.searchParams.get("potc") || "1" };
      } catch (_) {
        // Ignore malformed resource entries.
      }
    }
    return {};
  }

  function getProofKey() {
    const params = getTimedtextProofParams();
    return params.pot ? `${params.pot}:${params.potc || ""}` : "";
  }

  function buildCaptionUrl(baseUrl, translatedLang) {
    return withQuery(baseUrl, {
      fmt: "json3",
      tlang: translatedLang,
      ...getPlayerClientParams(),
      ...getTimedtextProofParams(),
    });
  }

  async function loadJson3Captions(track, translatedLang) {
    const text = await requestText(buildCaptionUrl(track.baseUrl, translatedLang));
    if (!text.trim()) throw new Error("Caption endpoint returned an empty response");
    const payload = JSON.parse(text);
    return parseJson3(payload);
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

  async function loadForCurrentVideo() {
    if (!STATE.enabled) return;
    const videoId = getVideoId();
    if (!videoId || (videoId === STATE.videoId && STATE.translated.length)) return;
    STATE.videoId = videoId;
    STATE.translated = [];
    STATE.lastTranslatedText = "";
    setStatus("第二字幕を読み込み中...");

    const track = chooseOriginalTrack(getCaptionTracks());
    if (!track?.baseUrl) {
      setStatus("この動画では取得可能な字幕トラックが見つかりません");
      return;
    }

    try {
      const translated = await loadJson3Captions(track, CONFIG.translatedLang);
      STATE.translated = translated;
      setStatus("");
    } catch (error) {
      console.error("[yt-dualsub] failed to load captions", error);
      setStatus("第二字幕の取得に失敗しました。YouTubeの字幕(CC)を手動でONにすると再試行します");
    }
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
    const root = ensureRoot();
    if (!root) return;
    if (!STATE.enabled) {
      root.style.display = "none";
      return;
    }
    const video = document.querySelector("video");
    const currentMs = video ? video.currentTime * 1000 : 0;
    const translatedText = findActive(STATE.translated, currentMs);
    const translatedNode = root.querySelector(".yt-dualsub-translated");
    const statusNode = root.querySelector(".yt-dualsub-status");

    if (translatedText !== STATE.lastTranslatedText) {
      translatedNode.textContent = translatedText;
      STATE.lastTranslatedText = translatedText;
    }

    translatedNode.style.display = translatedText ? "" : "none";
    statusNode.textContent = STATE.status;
    statusNode.style.display = STATE.status ? "" : "none";
    root.style.display = translatedText || STATE.status ? "" : "none";
  }

  function scheduleReload() {
    clearTimeout(STATE.reloadTimer);
    STATE.reloadTimer = window.setTimeout(() => {
      STATE.videoId = "";
      if (STATE.enabled) loadForCurrentVideo();
    }, 450);
  }

  function observeManualCaptionPriming() {
    document.addEventListener("click", (event) => {
      if (!event.target?.closest?.(".ytp-subtitles-button")) return;
      window.setTimeout(() => {
        syncWithNativeCc();
        if (STATE.enabled) scheduleReload();
      }, 650);
    }, true);
  }

  function start() {
    ensureRoot();
    STATE.lastProofKey = getProofKey();
    syncWithNativeCc();
    window.setInterval(() => {
      syncWithNativeCc();
      const videoId = getVideoId();
      if (videoId !== STATE.videoId) {
        STATE.videoId = videoId;
        STATE.translated = [];
        STATE.lastTranslatedText = "";
        if (STATE.enabled) scheduleReload();
      }
      const proofKey = getProofKey();
      if (STATE.enabled && proofKey && proofKey !== STATE.lastProofKey) {
        STATE.lastProofKey = proofKey;
        scheduleReload();
      }
      render();
    }, CONFIG.pollMs);
    window.addEventListener("yt-navigate-finish", scheduleReload);
    window.addEventListener("popstate", scheduleReload);
    observeManualCaptionPriming();
  }

  start();
})();
