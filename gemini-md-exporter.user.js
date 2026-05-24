// ==UserScript==
// @name         Gemini Markdown Exporter
// @namespace    https://gemini.google.com/
// @version      1.0.0
// @description  gemini.google.com の会話を Markdown ファイルとしてエクスポートするボタンを追加します
// @author       seijiro
// @match        https://gemini.google.com/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  // ─── 定数 ────────────────────────────────────────────────────────────────────

  const BUTTON_ID       = 'gemini-md-export-btn';
  const STYLE_ID        = 'gemini-md-export-style';
  const BATCHEXEC_PATH  = '/_/BardChatUi/data/batchexecute';
  const RPC_TAG         = 'wrb.fr';
  const RPCID           = 'hNvQHb';
  const PAGE_SIZE       = 100;

  // ─── XHR フック (document-start で仕掛け、リクエストIDと拡張ヘッダーを捕捉) ────

  const intercepted = {
    reqId:      null,
    extHeaders: {},   // x-goog-ext-* ヘッダー
  };

  (function hookXHR() {
    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      this._gem_url = url;
      this._gem_headers = {};

      // setRequestHeader をフックして x-goog-ext-* を収集
      const origSetHeader = this.setRequestHeader.bind(this);
      this.setRequestHeader = function (name, value) {
        if (name.toLowerCase().startsWith('x-goog-ext-')) {
          this._gem_headers[name] = value;
        }
        origSetHeader(name, value);
      };

      return originalOpen.call(this, method, url, ...rest);
    };

    XMLHttpRequest.prototype.send = function (body) {
      try {
        const url = this._gem_url;
        if (url && url.includes(BATCHEXEC_PATH)) {
          // _reqid を URL から取得
          const parsed = new URL(url, window.location.origin);
          const reqId  = parsed.searchParams.get('_reqid');
          if (reqId) intercepted.reqId = reqId;

          // rpcids=hNvQHb のリクエストなら拡張ヘッダーも保存
          if (parsed.searchParams.get('rpcids') === RPCID) {
            const hdrs = this._gem_headers || {};
            if (Object.keys(hdrs).length > 0) {
              intercepted.extHeaders = { ...intercepted.extHeaders, ...hdrs };
            }
          }
        }
      } catch { /* ignore */ }
      return originalSend.call(this, body);
    };
  })();

  // ─── スタイル注入 ─────────────────────────────────────────────────────────────

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      #${BUTTON_ID} {
        position: fixed;
        bottom: 80px;
        right: 20px;
        z-index: 2147483647;
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 8px 14px;
        background: #1a73e8;
        color: #fff;
        border: none;
        border-radius: 8px;
        font-size: 13px;
        font-weight: 600;
        cursor: pointer;
        box-shadow: 0 2px 8px rgba(0,0,0,0.25);
        transition: background 0.15s, opacity 0.15s;
        font-family: "Google Sans", -apple-system, sans-serif;
      }
      #${BUTTON_ID}:hover    { background: #1558b0; }
      #${BUTTON_ID}:active   { background: #104693; }
      #${BUTTON_ID}:disabled { opacity: 0.6; cursor: not-allowed; }
      #${BUTTON_ID} .icon    { font-size: 15px; line-height: 1; }
      #gemini-md-toast {
        position: fixed;
        bottom: 140px;
        right: 20px;
        z-index: 2147483647;
        padding: 8px 16px;
        border-radius: 8px;
        font-size: 13px;
        font-weight: 500;
        color: #fff;
        box-shadow: 0 2px 8px rgba(0,0,0,0.25);
        font-family: "Google Sans", -apple-system, sans-serif;
        animation: geminiMdFadeIn 0.2s ease;
      }
      #gemini-md-toast.success { background: #137333; }
      #gemini-md-toast.error   { background: #c5221f; }
      @keyframes geminiMdFadeIn {
        from { opacity: 0; transform: translateY(6px); }
        to   { opacity: 1; transform: translateY(0); }
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  // ─── WIZ_global_data から API パラメータを抽出 ──────────────────────────────

  function getGeminiParams() {
    const wiz = window.WIZ_global_data || {};
    const fSid    = wiz.FdrFJe || '';
    const bl      = wiz.cfb2h  || '';
    const at      = wiz.SNlM0e || '';
    const basePath = wiz.Im6cmf || '/_/BardChatUi';
    return { fSid, bl, at, basePath };
  }

  // 会話ID は URL の末尾パス要素
  function extractConversationId() {
    return new URL(document.URL).pathname.split('/').pop() || '';
  }

  // _reqid: 捕捉済みがあれば +100000、なければランダム 7 桁
  function makeReqId() {
    if (intercepted.reqId) {
      const n = parseInt(intercepted.reqId, 10);
      if (!isNaN(n)) return String(n + 100000);
    }
    return String(Math.floor(Math.random() * 9e6) + 1e6);
  }

  // ─── BrowserRPC リクエスト送信 ───────────────────────────────────────────────

  async function fetchGeminiPage(convId, cursor, params) {
    const { fSid, bl, at, basePath } = params;
    const path   = new URL(document.URL).pathname;
    const reqId  = makeReqId();

    const endpoint = `https://gemini.google.com${basePath}/data/batchexecute`
      + `?rpcids=${RPCID}`
      + `&source-path=${encodeURIComponent(path)}`
      + `&bl=${encodeURIComponent(bl)}`
      + `&f.sid=${encodeURIComponent(fSid)}`
      + `&hl=en`
      + `&_reqid=${reqId}`
      + `&rt=c`;

    // f.req の inner JSON: [conversationId, pageSize, cursor, 1, [0], [4], null, 1]
    const innerJson = JSON.stringify([`c_${convId}`, PAGE_SIZE, cursor ?? null, 1, [0], [4], null, 1]);
    const body = new URLSearchParams();
    body.append('f.req', JSON.stringify([[[ RPCID, innerJson, null, 'generic' ]]]));
    body.append('at', at);

    const headers = {
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      ...intercepted.extHeaders,
    };

    const res = await fetch(endpoint, {
      method:      'POST',
      headers,
      body:        body.toString(),
      credentials: 'include',
    });

    if (!res.ok) throw new Error(`API エラー: ${res.status} ${res.statusText}`);
    return res.text();
  }

  // ─── BrowserRPC レスポンス解析 ───────────────────────────────────────────────

  function parseResponse(rawText) {
    let text = rawText;
    if (text.startsWith(")]}'\n") || text.startsWith(")]}' \n")) {
      text = text.replace(/^\)\]\}'\s*\n/, '');
    }

    const lines = text.split('\n').filter(l => l.trim() !== '');

    // 数字のみの行を見つけてその次から JSON 配列を探す
    let start = 0;
    for (let i = 0; i < lines.length; i++) {
      if (/^\d+$/.test(lines[i].trim())) { start = i + 1; break; }
    }

    const allArrays = [];
    for (let i = start; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!/^\d+$/.test(line) && line.startsWith('[') && line.endsWith(']')) {
        try { allArrays.push(JSON.parse(line)); } catch { /* ignore */ }
      }
    }
    return allArrays;
  }

  function extractChatsData(allArrays) {
    try {
      const head = allArrays[0]?.[0];
      if (!head || head[0] !== RPC_TAG || head[1] !== RPCID || !head[2]) return null;
      const r    = JSON.parse(head[2]);
      const items = Array.isArray(r[0]) ? [...r[0]].reverse() : [];
      return {
        continueCursor: r[1] || null,
        items,
      };
    } catch { return null; }
  }

  // ─── 安全な深いアクセス ───────────────────────────────────────────────────────

  function safeGet(obj, path, fallback = null) {
    try {
      let cur = obj;
      for (const key of path) {
        if (cur == null || (typeof cur !== 'object' && !Array.isArray(cur))) return fallback;
        cur = cur[key];
      }
      return cur !== undefined ? cur : fallback;
    } catch { return fallback; }
  }

  // ─── テキスト配列の再帰的抽出 ────────────────────────────────────────────────

  function extractTextArray(val) {
    if (!val) return [];
    if (Array.isArray(val) && val.every(v => typeof v === 'string')) {
      return val.filter(v => v.trim() !== '');
    }
    if (Array.isArray(val)) {
      const result = [];
      for (const item of val) {
        if (typeof item === 'string' && item.trim()) result.push(item);
        else if (Array.isArray(item)) result.push(...extractTextArray(item));
        else if (item && typeof item === 'object') {
          result.push(...Object.values(item).filter(v => typeof v === 'string' && v.trim()));
        }
      }
      return result;
    }
    if (typeof val === 'string' && val.trim()) return [val];
    return [];
  }

  // ─── 引用テキストのクリーニング ──────────────────────────────────────────────

  function cleanCitationText(text) {
    if (!text.includes('[cite_start]') && !text.includes('[cite:')) return text;
    return text
      .replace(/\[cite_start\]/g, '')
      .replace(/\[cite:\s*[^\]]+\]/g, '');
  }

  function cleanCitationContents(contents) {
    return contents.map(c =>
      (c.type === 'text' || c.type === 'markdown') && c.content
        ? { ...c, content: cleanCitationText(c.content) }
        : c
    );
  }

  // ─── チャットアイテム → { ask, answer } 変換 ─────────────────────────────────

  function extractChatItem(e) {
    try {
      if (!Array.isArray(e) || e.length === 0) return null;

      // ─ ユーザー質問 ─
      const askText = safeGet(e, [2, 0, 0], '');

      // ─ AI 回答テキスト ─
      const answerTextArr = extractTextArray(safeGet(e, [3, 0, 0, 1], []));
      let answerContents  = [];

      if (answerTextArr.length > 0) {
        answerContents = [{ type: 'text', content: answerTextArr.join('\n') }];
      }

      // Thinking ブロック (e[3][0][0][37][0][0])
      const thinkingArr = extractTextArray(safeGet(e, [3, 0, 0, 37, 0, 0], []));
      if (thinkingArr.length > 0) {
        const t = thinkingArr.join('\n').trim();
        if (t) answerContents = [{ type: 'thinking', content: t }, ...answerContents];
      }

      // 引用クリーニング
      answerContents = cleanCitationContents(answerContents);

      // 空コンテンツ除去
      answerContents = answerContents.filter(c =>
        c.type === 'thinking' ||
        ((c.type === 'text' || c.type === 'markdown') && c.content !== '')
      );

      const renderId = safeGet(e, [0, 1], '');
      const modelId  = safeGet(e, [3, 21], 'Gemini');

      // 有効なアイテムかチェック
      if (!renderId && !askText && answerContents.length === 0) return null;

      return {
        renderId,
        askText,
        answerContents,
        modelId,
      };
    } catch { return null; }
  }

  // ─── チャットアイテム配列 → メッセージ配列 ──────────────────────────────────

  function itemsToMessages(items, convId) {
    const messages = [];
    const now      = Date.now();

    for (const item of items) {
      if (!item) continue;

      // ユーザーメッセージ
      if (item.askText && item.askText.trim()) {
        messages.push({
          id:           `${item.renderId}_user`,
          chatGroupId:  convId,
          role:         'user',
          model:        'gemini',
          displayModel: 'Gemini',
          contents:     [{ type: 'text', content: item.askText }],
          created_at:   null,
          updated_at:   now,
        });
      }

      // AI 応答メッセージ
      if (item.answerContents.length > 0) {
        messages.push({
          id:           `${item.renderId}_assistant`,
          chatGroupId:  convId,
          role:         'assistant',
          model:        'gemini',
          displayModel: 'Gemini',
          modelId:      item.modelId,
          contents:     item.answerContents,
          created_at:   null,
          updated_at:   now,
        });
      }
    }

    return messages;
  }

  // ─── ページネーション付き全会話取得 ─────────────────────────────────────────

  async function fetchAllMessages(convId) {
    const params = getGeminiParams();
    if (!params.fSid || !params.bl || !params.at) {
      throw new Error(
        '認証パラメータが見つかりません。\n'
        + 'Gemini のページを一度操作（送信など）してからお試しください。'
      );
    }

    const allItems = [];
    let cursor     = null;

    for (;;) {
      const rawText  = await fetchGeminiPage(convId, cursor, params);
      const arrays   = parseResponse(rawText);
      const chatData = extractChatsData(arrays);

      if (!chatData?.items || chatData.items.length === 0) break;

      allItems.unshift(...chatData.items);  // 古い順に先頭へ積む

      if (chatData.items.length < PAGE_SIZE || !chatData.continueCursor) break;
      cursor = chatData.continueCursor;
    }

    return allItems.map(extractChatItem).filter(Boolean);
  }

  // ─── メッセージ配列 → Markdown 文字列 ───────────────────────────────────────

  function messagesToMarkdown(messages, opts = {}) {
    const { enableThinking = false, sourceUrl = null } = opts;
    if (messages.length === 0) return '';

    const blocks = [];
    if (sourceUrl) blocks.push(`> From: ${sourceUrl}`);

    messages.forEach((msg, idx) => {
      const header = msg.role === 'user'
        ? '# you asked'
        : `# ${msg.model} response`;

      const parts = [header];

      const contentLines = msg.contents
        .filter(c => {
          if (c.type === 'thinking' && !enableThinking) return false;
          return (c.type === 'text' || c.type === 'markdown' || c.type === 'thinking')
              && c.content;
        })
        .map(c => {
          const text = c.content.trim();
          return c.type === 'thinking' ? `Thinking\n\n${text}` : text;
        })
        .filter(Boolean);

      parts.push(contentLines.length > 0 ? contentLines.join('\n\n') : '*(No content)*');

      blocks.push(parts.join('\n\n'));
      if (idx < messages.length - 1) blocks.push('---');
    });

    return blocks.join('\n\n');
  }

  // ─── ファイルダウンロード ─────────────────────────────────────────────────────

  function downloadMarkdown(content, filename) {
    const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function sanitizeFilename(name) {
    return (name || 'gemini-conversation')
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
      .trim()
      .slice(0, 100);
  }

  // ─── トースト通知 ─────────────────────────────────────────────────────────────

  function showToast(message, type = 'success') {
    document.getElementById('gemini-md-toast')?.remove();
    const toast       = document.createElement('div');
    toast.id          = 'gemini-md-toast';
    toast.className   = type;
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 4000);
  }

  // ─── エクスポート本体 ─────────────────────────────────────────────────────────

  async function exportMarkdown() {
    const btn    = document.getElementById(BUTTON_ID);
    const convId = extractConversationId();

    if (!convId) {
      showToast('会話ページで実行してください', 'error');
      return;
    }

    btn.disabled = true;
    btn.querySelector('.label').textContent = '取得中...';

    try {
      const items    = await fetchAllMessages(convId);
      const messages = itemsToMessages(items, convId);

      if (messages.length === 0) {
        showToast('エクスポートするメッセージがありません', 'error');
        return;
      }

      const markdown = messagesToMarkdown(messages, {
        enableThinking: false,
        sourceUrl:      window.location.href,
      });

      downloadMarkdown(markdown, sanitizeFilename(`gemini-${convId}`) + '.md');
      showToast(`Markdown をエクスポートしました (${messages.length} メッセージ)`, 'success');
    } catch (err) {
      console.error('[Gemini MD Exporter]', err);
      showToast(`エクスポート失敗: ${err.message}`, 'error');
    } finally {
      btn.disabled = false;
      btn.querySelector('.label').textContent = 'MD Export';
    }
  }

  // ─── ボタンの設置 / 削除 ──────────────────────────────────────────────────────

  function isConversationPage() {
    // /app/{conversationId} または /chat/{conversationId} の形式
    return /\/(app|chat)\/[a-zA-Z0-9_-]+/.test(window.location.pathname)
      || /\/[a-zA-Z0-9_]{20,}$/.test(window.location.pathname);
  }

  function insertButton() {
    if (document.getElementById(BUTTON_ID)) return;
    if (!isConversationPage()) return;

    const mount = document.body || document.documentElement;
    if (!mount) return;

    const btn       = document.createElement('button');
    btn.id          = BUTTON_ID;
    btn.type        = 'button';

    const icon = document.createElement('span');
    icon.className = 'icon';
    icon.textContent = '⬇';

    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = 'MD Export';

    btn.append(icon, label);
    btn.addEventListener('click', exportMarkdown);
    mount.appendChild(btn);
  }

  function removeButton() {
    document.getElementById(BUTTON_ID)?.remove();
  }

  // ─── URL 変化の監視 (SPA 対応) ───────────────────────────────────────────────

  let lastPathname = location.pathname;

  function onNavigate() {
    if (location.pathname === lastPathname) return;
    lastPathname = location.pathname;
    removeButton();
    scheduleButtonRefresh();
  }

  function scheduleButtonRefresh() {
    [0, 500, 1500, 3500].forEach(delay => setTimeout(insertButton, delay));
  }

  function startButtonWatcher() {
    const root = document.documentElement;
    if (!root) return;

    const observer = new MutationObserver(() => {
      if (isConversationPage() && !document.getElementById(BUTTON_ID)) {
        insertButton();
      } else if (!isConversationPage()) {
        removeButton();
      }
    });

    observer.observe(root, { childList: true, subtree: true });
    setInterval(() => {
      if (isConversationPage()) insertButton();
    }, 3000);
  }

  ['pushState', 'replaceState'].forEach(method => {
    const original = history[method];
    history[method] = function (...args) {
      const ret = original.apply(this, args);
      onNavigate();
      return ret;
    };
  });
  window.addEventListener('popstate', onNavigate);

  // ─── 初期化 ───────────────────────────────────────────────────────────────────

  function init() {
    injectStyle();
    scheduleButtonRefresh();
    startButtonWatcher();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(init, 1000));
  } else {
    setTimeout(init, 1000);
  }

})();
