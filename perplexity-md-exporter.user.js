// ==UserScript==
// @name         Perplexity Markdown Exporter
// @namespace    https://www.perplexity.ai/
// @version      1.0.0
// @description  perplexity.ai の会話を Markdown ファイルとしてエクスポートするボタンを追加します
// @author       seijiro
// @match        https://www.perplexity.ai/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ─── 定数 ────────────────────────────────────────────────────────────────────

  const BUTTON_ID  = 'perplexity-md-export-btn';
  const STYLE_ID   = 'perplexity-md-export-style';
  const API_BASE   = 'https://www.perplexity.ai';
  const API_VER    = '2.18';
  const PAGE_LIMIT = 50;   // 1リクエストで取得する最大エントリ数

  // Perplexity が返すブロック種別一覧 (supported_block_use_cases)
  const BLOCK_USE_CASES = [
    'answer_modes', 'media_items', 'knowledge_cards', 'inline_entity_cards',
    'place_widgets', 'finance_widgets', 'sports_widgets', 'flight_status_widgets',
    'shopping_widgets', 'jobs_widgets', 'search_result_widgets',
    'clarification_responses', 'inline_images', 'inline_assets',
    'placeholder_cards', 'diff_blocks', 'inline_knowledge_cards',
    'entity_group_v2', 'refinement_filters', 'canvas_mode', 'maps_preview',
    'answer_tabs', 'price_comparison_widgets',
  ];

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
        background: #20808d;
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
      #${BUTTON_ID}:hover    { background: #196b76; }
      #${BUTTON_ID}:active   { background: #135760; }
      #${BUTTON_ID}:disabled { opacity: 0.6; cursor: not-allowed; }
      #${BUTTON_ID} .icon    { font-size: 15px; line-height: 1; }
      #perplexity-md-toast {
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
        animation: perplexityMdFadeIn 0.2s ease;
      }
      #perplexity-md-toast.success { background: #059669; }
      #perplexity-md-toast.error   { background: #dc2626; }
      @keyframes perplexityMdFadeIn {
        from { opacity: 0; transform: translateY(6px); }
        to   { opacity: 1; transform: translateY(0); }
      }
    `;
    document.head.appendChild(style);
  }

  // ─── 会話ID の抽出 ────────────────────────────────────────────────────────────
  // URL 形式: /search/{threadId}

  function extractConversationId() {
    const m = window.location.href.match(/\/search\/([^/?#]+)/);
    return m ? m[1] : null;
  }

  // ─── タイムスタンプ変換 ──────────────────────────────────────────────────────
  // entry_updated_datetime は ISO 8601 文字列

  function formatTimestamp(ts) {
    if (!ts) return null;
    try {
      const d = new Date(ts);
      if (isNaN(d.getTime())) return null;
      const p = n => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} `
           + `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    } catch { return null; }
  }

  // ─── Perplexity REST API からスレッドデータ取得 ──────────────────────────────

  async function fetchThreadPage(threadId, offset = 0) {
    const params = new URLSearchParams({
      with_parent_info:         'true',
      with_schematized_response: 'true',
      version:                  API_VER,
      source:                   'default',
      limit:                    String(PAGE_LIMIT),
      offset:                   String(offset),
      from_first:               'true',
    });
    BLOCK_USE_CASES.forEach(u => params.append('supported_block_use_cases', u));

    const url = `${API_BASE}/rest/thread/${threadId}?${params.toString()}`;
    const res = await fetch(url, {
      method:      'GET',
      credentials: 'include',
      headers: {
        'Accept':           '*/*',
        'Content-Type':     'application/json',
        'x-app-apiclient':  'default',
        'x-app-apiversion': API_VER,
      },
    });
    if (!res.ok) throw new Error(`API エラー: ${res.status} ${res.statusText}`);
    return res.json();
  }

  // ─── 全エントリを取得 (ページネーション対応) ─────────────────────────────────

  async function fetchAllEntries(threadId) {
    const allEntries = [];
    let offset = 0;

    for (;;) {
      const data = await fetchThreadPage(threadId, offset);
      const entries = data?.entries ?? [];
      if (entries.length === 0) break;

      allEntries.push(...entries);

      // PAGE_LIMIT 未満なら最終ページ
      if (entries.length < PAGE_LIMIT) break;
      offset += PAGE_LIMIT;
    }

    return allEntries;
  }

  // ─── 引用番号の解決 ──────────────────────────────────────────────────────────
  // Perplexity は [1], [2] という形式で引用番号を埋め込む。
  // web_results の URL 配列を使って [[0]](url) 形式に変換する。

  function buildCitationReplacer(webResults) {
    return (text) =>
      text.replace(/\[(\d+)\]/g, (match, numStr) => {
        const idx    = parseInt(numStr, 10) - 1; // 1-based → 0-based
        const result = webResults[idx];
        if (!result?.url) return match;

        // ドメイン名を短縮ラベルとして使う
        let label = result.meta_data?.citation_domain_name
          || result.meta_data?.domain_name;
        if (!label) {
          try {
            const hostname = new URL(result.url).hostname.replace(/^www\./, '');
            label = hostname.split('.')[0] || hostname;
          } catch { label = null; }
        }
        return label ? `[[${label}]](${result.url})` : match;
      });
  }

  // ─── ブロック配列 → Contents 配列 ────────────────────────────────────────────

  function extractAssistantContents(blocks) {
    const contents  = [];
    const webResults = [];

    // 第1パス: web_results を収集して引用解決マップを構築
    for (const block of blocks) {
      if (block.intended_usage === 'web_results') {
        const results = block.web_result_block?.web_results ?? [];
        webResults.push(...results);
      }
    }

    const replaceCitations = buildCitationReplacer(webResults);

    // 第2パス: 表示コンテンツを抽出
    for (const block of blocks) {
      switch (block.intended_usage) {
        case 'media_items': {
          const items = block.media_block?.media_items ?? [];
          for (const item of items) {
            if (item.medium === 'image' && item.image) {
              contents.push({ type: 'image', imageUrl: item.image });
            }
          }
          break;
        }
        case 'ask_text': {
          const answer = block.markdown_block?.answer;
          if (answer?.trim()) {
            contents.push({ type: 'markdown', content: replaceCitations(answer) });
          }
          // インライン画像
          const inlineImages = block.markdown_block?.media_items ?? [];
          for (const item of inlineImages) {
            if (item.medium === 'image' && item.image) {
              contents.push({ type: 'image', imageUrl: item.image });
            }
          }
          break;
        }
        default:
          break;
      }
    }

    return contents;
  }

  // ─── エントリ配列 → メッセージ配列 ─────────────────────────────────────────

  function entriesToMessages(entries, threadId) {
    const messages = [];

    for (const entry of entries) {
      const ts      = entry.entry_updated_datetime ?? entry.updated_datetime ?? null;
      const created = formatTimestamp(ts);
      const model   = entry.user_selected_model || 'perplexity';

      // ユーザーメッセージ
      if (entry.query_str?.trim()) {
        messages.push({
          id:           `${entry.uuid}_user`,
          chatGroupId:  threadId,
          role:         'user',
          model:        'perplexity',
          displayModel: 'Perplexity',
          modelId:      model,
          contents:     [{ type: 'text', content: entry.query_str }],
          created_at:   created,
          updated_at:   Date.now(),
        });
      }

      // AI 応答メッセージ
      const assistantContents = extractAssistantContents(entry.blocks ?? []);
      if (assistantContents.length > 0) {
        messages.push({
          id:           `${entry.uuid}_assistant`,
          chatGroupId:  threadId,
          role:         'assistant',
          model:        'perplexity',
          displayModel: 'Perplexity',
          modelId:      model,
          contents:     assistantContents,
          created_at:   created,
          updated_at:   Date.now(),
        });
      }
    }

    return messages;
  }

  // ─── メッセージ配列 → Markdown 文字列 ───────────────────────────────────────

  function messagesToMarkdown(messages, opts = {}) {
    const { sourceUrl = null, showTimestamp = true } = opts;
    if (messages.length === 0) return '';

    const blocks = [];
    if (sourceUrl) blocks.push(`> From: ${sourceUrl}`);

    messages.forEach((msg, idx) => {
      const header = msg.role === 'user'
        ? '# you asked'
        : `# ${msg.model} response`;

      const parts = [header];

      // タイムスタンプ (user のみ)
      if (showTimestamp && msg.role === 'user' && msg.created_at) {
        parts.push(`message time: ${msg.created_at}`);
      }

      // コンテンツ本文 (text / markdown のみ出力、image はスキップ)
      const textLines = msg.contents
        .filter(c => (c.type === 'text' || c.type === 'markdown') && c.content)
        .map(c => c.content.trim())
        .filter(Boolean);

      parts.push(textLines.length > 0 ? textLines.join('\n\n') : '*(No content)*');

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
    return (name || 'perplexity-conversation')
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
      .trim()
      .slice(0, 100);
  }

  // ─── トースト通知 ─────────────────────────────────────────────────────────────

  function showToast(message, type = 'success') {
    document.getElementById('perplexity-md-toast')?.remove();
    const toast       = document.createElement('div');
    toast.id          = 'perplexity-md-toast';
    toast.className   = type;
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
  }

  // ─── エクスポート本体 ─────────────────────────────────────────────────────────

  async function exportMarkdown() {
    const btn      = document.getElementById(BUTTON_ID);
    const threadId = extractConversationId();

    if (!threadId) {
      showToast('検索ページで実行してください', 'error');
      return;
    }

    btn.disabled = true;
    btn.querySelector('.label').textContent = '取得中...';

    try {
      const entries  = await fetchAllEntries(threadId);

      if (entries.length === 0) {
        showToast('エクスポートするメッセージがありません', 'error');
        return;
      }

      const messages = entriesToMessages(entries, threadId);

      // スレッドタイトルを取得 (thread_title を持つ最初のエントリから)
      const titleEntry = entries.find(e => e.thread_title);
      const title      = sanitizeFilename(titleEntry?.thread_title || `perplexity-${threadId}`);

      const markdown = messagesToMarkdown(messages, {
        sourceUrl:     window.location.href,
        showTimestamp: true,
      });

      downloadMarkdown(markdown, `${title}.md`);
      showToast(`Markdown をエクスポートしました (${messages.length} メッセージ)`, 'success');
    } catch (err) {
      console.error('[Perplexity MD Exporter]', err);
      showToast(`エクスポート失敗: ${err.message}`, 'error');
    } finally {
      btn.disabled = false;
      btn.querySelector('.label').textContent = 'MD Export';
    }
  }

  // ─── ボタンの設置 / 削除 ──────────────────────────────────────────────────────

  function insertButton() {
    if (document.getElementById(BUTTON_ID)) return;
    if (!extractConversationId()) return;

    const btn       = document.createElement('button');
    btn.id          = BUTTON_ID;
    btn.innerHTML   = '<span class="icon">⬇</span><span class="label">MD Export</span>';
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

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(insertButton, 800));
  } else {
    setTimeout(insertButton, 800);
  }

  injectStyle();

})();
