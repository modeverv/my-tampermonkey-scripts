// ==UserScript==
// @name         DeepSeek Markdown Exporter
// @namespace    https://chat.deepseek.com/
// @version      1.0.0
// @description  chat.deepseek.com の会話を Markdown ファイルとしてエクスポートするボタンを追加します
// @author       seijiro
// @match        https://chat.deepseek.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ─── 定数 ────────────────────────────────────────────────────────────────────

  const BUTTON_ID = 'deepseek-md-export-btn';
  const STYLE_ID  = 'deepseek-md-export-style';

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
        z-index: 9999;
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 8px 14px;
        background: #4d6bfe;
        color: #fff;
        border: none;
        border-radius: 8px;
        font-size: 13px;
        font-weight: 600;
        cursor: pointer;
        box-shadow: 0 2px 8px rgba(0,0,0,0.25);
        transition: background 0.15s, opacity 0.15s;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      #${BUTTON_ID}:hover { background: #3a56e8; }
      #${BUTTON_ID}:active { background: #2a44d0; }
      #${BUTTON_ID}:disabled { opacity: 0.6; cursor: not-allowed; }
      #${BUTTON_ID} .icon { font-size: 15px; line-height: 1; }
      #deepseek-md-toast {
        position: fixed;
        bottom: 140px;
        right: 20px;
        z-index: 10000;
        padding: 8px 16px;
        border-radius: 8px;
        font-size: 13px;
        font-weight: 500;
        color: #fff;
        box-shadow: 0 2px 8px rgba(0,0,0,0.25);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        animation: deepseekMdFadeIn 0.2s ease;
      }
      #deepseek-md-toast.success { background: #059669; }
      #deepseek-md-toast.error   { background: #dc2626; }
      @keyframes deepseekMdFadeIn {
        from { opacity: 0; transform: translateY(6px); }
        to   { opacity: 1; transform: translateY(0); }
      }
    `;
    document.head.appendChild(style);
  }

  // ─── 認証トークンの取得 ──────────────────────────────────────────────────────

  function getUserToken() {
    try {
      const raw = localStorage.getItem('userToken');
      return raw ? JSON.parse(raw)?.value ?? null : null;
    } catch {
      return null;
    }
  }

  // ─── 会話ID の抽出 ────────────────────────────────────────────────────────────

  function extractConversationId() {
    const m = window.location.href.match(/\/a\/chat\/s\/([a-f0-9-]+)/);
    return m ? m[1] : null;
  }

  // ─── LaTeX 記法の正規化 ──────────────────────────────────────────────────────
  // DeepSeek API は \[...\] / \(...\) 形式で数式を返す。
  // 標準 Markdown の $$...$$ / $...$ に変換する。

  function normalizeLatex(text) {
    if (!text) return text;
    return text
      .replace(/\\\[([\s\S]*?)\\\]/g,  '$$$$\n$1\n$$$$')  // \[...\] → $$\n...\n$$
      .replace(/\\\(([\s\S]*?)\\\)/g,  '$$$1$$');          // \(...\) → $...$
  }

  // ─── Unix 秒タイムスタンプ → "YYYY-MM-DD HH:mm:ss" ──────────────────────────

  function formatTimestamp(ts) {
    if (ts == null) return null;
    try {
      // DeepSeek の inserted_at は Unix 秒 (数値) または ISO 文字列
      const d = typeof ts === 'number' ? new Date(ts * 1000) : new Date(ts);
      if (isNaN(d.getTime())) return null;
      const p = n => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} `
           + `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    } catch { return null; }
  }

  // ─── DeepSeek API からデータ取得 ─────────────────────────────────────────────

  async function fetchDeepSeekData(convId) {
    const token = getUserToken();
    if (!token) throw new Error('userToken が見つかりません。ログイン後にリロードしてください');

    const url = `https://chat.deepseek.com/api/v0/chat/history_messages?chat_session_id=${convId}&cache_version=0`;
    const res = await fetch(url, {
      method: 'GET',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
    });
    if (!res.ok) throw new Error(`API エラー: ${res.status} ${res.statusText}`);
    return res.json();
  }

  // ─── API レスポンスをメッセージ配列に変換 ────────────────────────────────────
  //
  // レスポンス構造:
  //   data.biz_data.chat_session  → { current_message_id, title, ... }
  //   data.biz_data.chat_messages → Message[]
  //
  // メッセージは親子リンクリスト。current_message_id から parent_id を辿って
  // 最新ブランチのみを逆順に並べる (元コードと同じアルゴリズム)。

  function convertResponseToMessages(data, convId) {
    const messages = [];
    const rawMsgs   = data?.data?.biz_data?.chat_messages ?? [];
    const session   = data?.data?.biz_data?.chat_session  ?? {};

    // message_id → message のマップ
    const idMap = new Map();
    for (const msg of rawMsgs) idMap.set(msg.message_id, msg);

    // current_message_id から parent_id を辿って最新ブランチを収集
    const chain = [];
    let cur = session.current_message_id ?? null;
    while (cur !== null && cur !== undefined) {
      const msg = idMap.get(cur);
      if (!msg) break;
      chain.push(msg);
      cur = msg.parent_id ?? null;
    }
    chain.reverse(); // 古い順に並べ直す

    for (const msg of chain) {
      // 未完了メッセージはスキップ
      if (msg.status !== 'FINISHED') continue;

      const role     = msg.role === 'USER' ? 'user' : 'assistant';
      const contents = [];

      // Thinking ブロック
      const thinking = (msg.thinking_content ?? '').trim();
      if (thinking) {
        contents.push({ type: 'thinking', content: thinking });
      }

      // メインコンテンツ
      let text = msg.content ?? '';

      // 添付ファイルがあればコンテンツ先頭にリスト
      if (msg.files?.length > 0) {
        const fileLines = msg.files.map(f => `[ファイル: ${f.file_name}]`).join('\n');
        text = text ? `${fileLines}\n\n${text}` : fileLines;
      }

      if (text) {
        contents.push({ type: 'text', content: normalizeLatex(text) });
      }

      if (contents.length === 0) {
        contents.push({ type: 'text', content: '' });
      }

      messages.push({
        id:           `${convId}_${msg.message_id}`,
        chatGroupId:  convId,
        role,
        model:        'deepseek',
        displayModel: 'DeepSeek',
        contents,
        created_at:   msg.inserted_at ?? null,
        updated_at:   Date.now(),
      });
    }

    return messages;
  }

  // ─── メッセージ配列 → Markdown 文字列 ───────────────────────────────────────

  function messagesToMarkdown(messages, opts = {}) {
    const { enableThinking = false, sourceUrl = null, showTimestamp = true } = opts;
    if (messages.length === 0) return '';

    const blocks = [];

    if (sourceUrl) blocks.push(`> From: ${sourceUrl}`);

    messages.forEach((msg, idx) => {
      const header = msg.role === 'user'
        ? '# you asked'
        : `# ${msg.model} response`;

      const parts = [header];

      // タイムスタンプ (user のみ)
      if (showTimestamp && msg.role === 'user') {
        const ts = formatTimestamp(msg.created_at);
        if (ts) parts.push(`message time: ${ts}`);
      }

      // コンテンツブロック
      const contentLines = msg.contents
        .filter(c => {
          if (c.type === 'thinking' && !enableThinking) return false;
          return (c.type === 'text' || c.type === 'markdown' || c.type === 'thinking')
              && c.content;
        })
        .map(c => {
          const text = c.content.trim();
          if (c.type === 'thinking') return `Thinking\n\n${text}`;
          return text;
        })
        .filter(Boolean);

      if (contentLines.length > 0) {
        parts.push(...contentLines);
      } else {
        parts.push('*(No content)*');
      }

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
    return (name || 'deepseek-conversation')
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
      .trim()
      .slice(0, 100);
  }

  // ─── トースト通知 ─────────────────────────────────────────────────────────────

  function showToast(message, type = 'success') {
    const existing = document.getElementById('deepseek-md-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.id        = 'deepseek-md-toast';
    toast.className = type;
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
  }

  // ─── エクスポート本体 ─────────────────────────────────────────────────────────

  async function exportMarkdown() {
    const btn = document.getElementById(BUTTON_ID);

    const convId = extractConversationId();
    if (!convId) {
      showToast('チャットページで実行してください', 'error');
      return;
    }

    btn.disabled = true;
    btn.querySelector('.label').textContent = '取得中...';

    try {
      const data     = await fetchDeepSeekData(convId);
      const messages = convertResponseToMessages(data, convId);

      if (messages.length === 0) {
        showToast('エクスポートするメッセージがありません', 'error');
        return;
      }

      const markdown = messagesToMarkdown(messages, {
        enableThinking: false,
        sourceUrl:      window.location.href,
        showTimestamp:  true,
      });

      const title = sanitizeFilename(
        data?.data?.biz_data?.chat_session?.title || 'deepseek-conversation'
      );
      downloadMarkdown(markdown, `${title}.md`);
      showToast('Markdown をエクスポートしました', 'success');
    } catch (err) {
      console.error('[DeepSeek MD Exporter]', err);
      showToast(`エクスポート失敗: ${err.message}`, 'error');
    } finally {
      btn.disabled = false;
      btn.querySelector('.label').textContent = 'MD Export';
    }
  }

  // ─── ボタンの設置 / 削除 ──────────────────────────────────────────────────────

  function insertButton() {
    if (document.getElementById(BUTTON_ID)) return;
    if (!extractConversationId()) return; // チャットページ以外は表示しない

    const btn = document.createElement('button');
    btn.id        = BUTTON_ID;
    btn.innerHTML = '<span class="icon">⬇</span><span class="label">MD Export</span>';
    btn.addEventListener('click', exportMarkdown);
    document.body.appendChild(btn);
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
    setTimeout(insertButton, 600);
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

  injectStyle();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(insertButton, 800));
  } else {
    setTimeout(insertButton, 800);
  }

})();
