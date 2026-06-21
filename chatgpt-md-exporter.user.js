// ==UserScript==
// @name         ChatGPT Markdown Exporter
// @namespace    https://chatgpt.com/
// @version      1.0.0
// @description  chatgpt.com の会話を Markdown ファイルとしてエクスポートするボタンを追加します
// @author       seijiro
// @match        https://chatgpt.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ─── 定数 ────────────────────────────────────────────────────────────────────

  const BUTTON_ID = 'chatgpt-md-export-btn';
  const STYLE_ID  = 'chatgpt-md-export-style';

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
        background: #10a37f;
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
      #${BUTTON_ID}:hover    { background: #0d8f6f; }
      #${BUTTON_ID}:active   { background: #0a7a5e; }
      #${BUTTON_ID}:disabled { opacity: 0.6; cursor: not-allowed; }
      #${BUTTON_ID} .icon    { font-size: 15px; line-height: 1; }
      #chatgpt-md-toast {
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
        animation: chatgptMdFadeIn 0.2s ease;
      }
      #chatgpt-md-toast.success { background: #059669; }
      #chatgpt-md-toast.error   { background: #dc2626; }
      @keyframes chatgptMdFadeIn {
        from { opacity: 0; transform: translateY(6px); }
        to   { opacity: 1; transform: translateY(0); }
      }
    `;
    document.head.appendChild(style);
  }

  // ─── 認証情報の取得 ──────────────────────────────────────────────────────────

  function getOaiDeviceId() {
    const m = document.cookie.match(/oai-did=([^;]+)/);
    return m ? m[1] : null;
  }

  async function getAccessToken() {
    try {
      const res  = await fetch('/api/auth/session?unstable_client=true', { credentials: 'include' });
      const json = await res.json();
      if (json?.accessToken) return `Bearer ${json.accessToken}`;
    } catch { /* fall through */ }
    throw new Error('Access Token を取得できません。ログイン状態を確認してください');
  }

  // ─── 会話ID の抽出 ────────────────────────────────────────────────────────────
  // /c/{uuid}, /g/{uuid}, /gg/{uuid}, /share/{uuid} をサポート

  function extractConversationId() {
    const url = window.location.href;
    const m = url.match(/\/(?:c|g|gg|share)\/([a-f0-9-]+)/);
    return m ? m[1] : null;
  }

  // ─── ChatGPT API からデータ取得 ──────────────────────────────────────────────

  async function fetchConversationData(convId) {
    const deviceId = getOaiDeviceId();
    if (!deviceId) throw new Error('oai-device-id が見つかりません。ページをリロードしてください');

    const token   = await getAccessToken();
    const headers = {
      'Accept':        'application/json',
      'Authorization': token,
      'oai-device-id': deviceId,
    };

    const res = await fetch(`/backend-api/conversation/${convId}`, {
      method: 'GET',
      credentials: 'include',
      headers,
    });
    if (!res.ok) throw new Error(`API エラー: ${res.status} ${res.statusText}`);
    return res.json();
  }

  // ─── テキスト変換ユーティリティ ──────────────────────────────────────────────

  // LaTeX: \[...\] → $$...$$ / \(...\) → $...$
  function normalizeLatex(text) {
    if (!text) return text;
    return text
      .replace(/\\\[([\s\S]*?)\\\]/g, '$$$$\n$1\n$$$$')
      .replace(/\\\(([\s\S]*?)\\\)/g, '$$$1$$');
  }

  // :::writing{variant="...", subject="..."}...:::  を見出し付き本文に変換
  function replaceWritingBlock(text) {
    if (!text) return text;
    return text.replace(
      /:::writing\{([^}]+)\}([\s\S]*?):::/g,
      (_, attrs, body) => {
        const variant = (attrs.match(/variant="([^"]+)"/) || [])[1] || '';
        const subject = (attrs.match(/subject="([^"]+)"/) || [])[1] || '';
        const label   = variant
          ? `**${variant.charAt(0).toUpperCase() + variant.slice(1)} Title: ${subject}**`
          : subject;
        return `${label}\n\n${body.trim()}`;
      }
    );
  }

  // Unix 秒タイムスタンプ（数値）または ISO 文字列 → "YYYY-MM-DD HH:mm:ss"
  function formatTimestamp(ts) {
    if (ts == null) return null;
    try {
      const d = typeof ts === 'number' ? new Date(Math.floor(ts) * 1000) : new Date(ts);
      if (isNaN(d.getTime())) return null;
      const p = n => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} `
           + `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    } catch { return null; }
  }

  // ─── ノードコンテンツ抽出 ────────────────────────────────────────────────────

  function extractMessageContents(msgContent, role) {
    const contents = [];
    if (!msgContent) return contents;

    const contentType = msgContent.content_type;

    if (contentType === 'text') {
      const parts = Array.isArray(msgContent.parts) ? msgContent.parts : [];
      for (const part of parts) {
        if (typeof part === 'string' && part.trim()) {
          contents.push({
            type:    'text',
            content: normalizeLatex(replaceWritingBlock(part)),
          });
        }
      }
    } else if (contentType === 'multimodal_text') {
      const parts = Array.isArray(msgContent.parts) ? msgContent.parts : [];
      for (const part of parts) {
        // ユーザーのテキスト部分のみ取り出す（画像ポインターはスキップ）
        if (role === 'user' && typeof part === 'string' && part.trim()) {
          contents.push({
            type:    'text',
            content: normalizeLatex(replaceWritingBlock(part)),
          });
        }
      }
    }

    return contents.length > 0 ? contents : [{ type: 'text', content: '' }];
  }

  // ノードから表示コンテンツを取得
  // ・user → 常に抽出
  // ・assistant (recipient === "all") → 抽出
  // ・tool (multimodal_text) → 抽出
  // ・その他 (system, function etc.) → [] を返す
  function getNodeContents(message) {
    if (!message) return [];
    const role        = message.author?.role;
    const contentType = message.content?.content_type;
    const recipient   = message.recipient;

    if (role === 'user') {
      return extractMessageContents(message.content, 'user');
    }
    if (role === 'assistant' && recipient === 'all') {
      return extractMessageContents(message.content, 'assistant');
    }
    if (role === 'tool' && contentType === 'multimodal_text') {
      return extractMessageContents(message.content, 'tool');
    }
    return [];
  }

  function hasValidMessageContent(contents) {
    return contents.length > 0 && contents.some(c =>
      (c.type === 'text' || c.type === 'markdown') && c.content?.trim()
    );
  }

  // メッセージのターン境界判定
  // end_turn === true, 次が user メッセージ、または次ノードが存在しない場合に true
  function isMessageEnded(message, nextMessage, nextNode) {
    if (message?.author?.role === 'user') return true;
    const endTurn = typeof message?.end_turn === 'boolean' && message.end_turn;
    const nextIsUser = nextMessage?.author?.role === 'user';
    return endTurn || nextIsUser || !nextNode;
  }

  // ─── ツリートラバーサル ───────────────────────────────────────────────────────

  function findRootNode(mapping) {
    // まず "client-created-root" を探す
    const special = mapping['client-created-root'];
    if (special) return special;
    // 次に parent === null のノードを探す
    for (const node of Object.values(mapping)) {
      if (node && node.parent === null) return node;
    }
    return null;
  }

  function getNodeCreateTime(node) {
    return node?.message?.create_time || 0;
  }

  // root から到達可能な全ノードIDを収集
  function collectReachableNodeIds(mapping, root) {
    const reachable = new Set();
    const stack     = [root.id];
    while (stack.length > 0) {
      const id   = stack.pop();
      if (!id || reachable.has(id)) continue;
      reachable.add(id);
      const node     = mapping[id];
      const children = Array.isArray(node?.children) ? node.children : [];
      stack.push(...children);
    }
    return reachable;
  }

  // 子を持たないノード（葉）を見つける
  function findLeafNodes(mapping, reachable) {
    const leaves = [];
    for (const id of reachable) {
      const node     = mapping[id];
      if (!node?.message) continue;
      const children = (Array.isArray(node.children) ? node.children : [])
        .filter(cid => reachable.has(cid));
      if (children.length === 0) leaves.push(node);
    }
    return leaves;
  }

  // 葉から root へ遡ってパスを構築（root 側が先頭）
  function buildPathFromLeaf(mapping, root, leafNode) {
    const path    = [];
    const visited = new Set();
    let cur       = leafNode.id;
    while (cur && !visited.has(cur)) {
      const node = mapping[cur];
      if (!node) break;
      visited.add(cur);
      path.push(cur);
      if (cur === root.id) break;
      cur = node.parent;
    }
    return path.reverse();
  }

  // パスから「次ノード」マップを構築
  function buildNextNodeMap(pathIds) {
    const map = new Map();
    for (let i = 0; i < pathIds.length - 1; i++) {
      map.set(pathIds[i], pathIds[i + 1]);
    }
    return map;
  }

  function getNextNodeId(nextNodeMap, currentId, children) {
    if (nextNodeMap) return nextNodeMap.get(currentId) ?? null;
    return children[0] ?? null;
  }

  // 再帰トラバーサル
  // - 複数ノードが連続して「1 ターン」を構成する場合（ツール呼び出し後の応答など）に対応
  function traversePath({ mapping, conversationId, nextNodeMap, messageArray,
                           nodeId, preContents = [], ids = [], defaultModelSlug }) {
    const node = mapping[nodeId];
    if (!node) return;

    const message  = node.message;
    if (!message) return;

    const children   = Array.isArray(node.children) ? node.children : [];
    const nextId     = getNextNodeId(nextNodeMap, node.id, children);
    const nextNode   = nextId ? mapping[nextId] : undefined;
    const nextMsg    = nextNode?.message;

    const curContents   = getNodeContents(message);
    const accumulated   = preContents.length > 0
      ? [...preContents, ...curContents]
      : curContents;
    const accumulatedIds = [...ids, node.id];

    if (hasValidMessageContent(accumulated) && isMessageEnded(message, nextMsg, nextNode)) {
      // ターン確定: メッセージを登録して次ターンへ
      const role = message.author?.role === 'user' ? 'user' : 'assistant';
      const modelId = message.metadata?.model_slug
        || message.metadata?.default_model_slug
        || defaultModelSlug
        || '';

      messageArray.push({
        id:           node.id,
        ids:          accumulatedIds,
        chatGroupId:  conversationId,
        role,
        model:        'chatgpt',
        displayModel: 'ChatGPT',
        modelId,
        contents:     accumulated,
        created_at:   message.create_time ?? null,
        updated_at:   message.update_time ?? 0,
      });

      // 次ノードへ（蓄積をリセット）
      if (nextId) {
        traversePath({ mapping, conversationId, nextNodeMap, messageArray,
                       nodeId: nextId, preContents: [], ids: [],
                       defaultModelSlug });
      }
    } else {
      // まだターン未確定: 蓄積して続行
      if (nextId) {
        traversePath({ mapping, conversationId, nextNodeMap, messageArray,
                       nodeId: nextId, preContents: accumulated, ids: accumulatedIds,
                       defaultModelSlug });
      }
    }
  }

  // ─── API レスポンスをメッセージ配列に変換 ────────────────────────────────────

  function convertToMessages(data, convId) {
    const mapping        = data.mapping || {};
    const defaultModelId = data.default_model_slug || '';
    const root           = findRootNode(mapping);
    if (!root) return [];

    const reachable   = collectReachableNodeIds(mapping, root);
    const leaves      = findLeafNodes(mapping, reachable);
    // 最新の葉（最後に更新されたブランチ）を選択
    const latestLeaf  = leaves.reduce(
      (best, node) => !best || getNodeCreateTime(node) > getNodeCreateTime(best) ? node : best,
      null
    );
    if (!latestLeaf) return [];

    const pathIds     = buildPathFromLeaf(mapping, root, latestLeaf);
    // フォーク（枝分かれ）があるときのみ nextNodeMap を使う
    const hasForked   = Object.values(mapping).some(n => (n?.children?.length || 0) > 1);
    const nextNodeMap = (hasForked && pathIds[0] === root.id)
      ? buildNextNodeMap(pathIds)
      : null;

    const messages = [];

    // ルートの直接の子から走査開始
    if (nextNodeMap) {
      const startId = nextNodeMap.get(root.id);
      if (startId) {
        traversePath({ mapping, conversationId: convId, nextNodeMap, messageArray: messages,
                       nodeId: startId, defaultModelSlug: defaultModelId });
      }
    } else {
      const rootChildren = Array.isArray(root.children) ? root.children : [];
      for (const childId of rootChildren) {
        traversePath({ mapping, conversationId: convId, nextNodeMap: null,
                       messageArray: messages, nodeId: childId,
                       defaultModelSlug: defaultModelId });
      }
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

      if (showTimestamp && msg.role === 'user') {
        const ts = formatTimestamp(msg.created_at);
        if (ts) parts.push(`message time: ${ts}`);
      }

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
    return (name || 'chatgpt-conversation')
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
      .trim()
      .slice(0, 100);
  }

  // ─── トースト通知 ─────────────────────────────────────────────────────────────

  function showToast(message, type = 'success') {
    document.getElementById('chatgpt-md-toast')?.remove();
    const toast       = document.createElement('div');
    toast.id          = 'chatgpt-md-toast';
    toast.className   = type;
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
  }

  // ─── エクスポート本体 ─────────────────────────────────────────────────────────

  async function exportMarkdown() {
    const btn    = document.getElementById(BUTTON_ID);
    const convId = extractConversationId();

    if (!convId) {
      showToast('チャットページで実行してください', 'error');
      return;
    }

    btn.disabled = true;
    btn.querySelector('.label').textContent = '取得中...';

    try {
      const data     = await fetchConversationData(convId);
      const messages = convertToMessages(data, convId);

      if (messages.length === 0) {
        showToast('エクスポートするメッセージがありません', 'error');
        return;
      }

      const markdown = messagesToMarkdown(messages, {
        enableThinking: false,
        sourceUrl:      window.location.href,
        showTimestamp:  true,
      });

      const title = sanitizeFilename(data.title || 'chatgpt-conversation');
      downloadMarkdown(markdown, `${title}.md`);
      showToast('Markdown をエクスポートしました', 'success');
    } catch (err) {
      console.error('[ChatGPT MD Exporter]', err);
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

  injectStyle();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(insertButton, 800));
  } else {
    setTimeout(insertButton, 800);
  }

})();
