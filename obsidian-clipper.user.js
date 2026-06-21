/* global GM_setClipboard */
// ==UserScript==
// @name         Obsidian Web Clipper
// @namespace    obsidian-web-clipper-tampermonkey
// @version      1.0.0
// @description  現在のページを Obsidian にクリップします (Alt+Shift+O またはボタン)
// @match        *://*/*
// @require      https://cdn.jsdelivr.net/npm/@mozilla/readability@0.5.0/Readability.js
// @require      https://cdn.jsdelivr.net/npm/turndown@7.1.2/dist/turndown.js
// @require      https://cdn.jsdelivr.net/npm/turndown-plugin-gfm@1.0.2/dist/turndown-plugin-gfm.js
// @grant        GM_setClipboard
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    // ==========================================================================
    // 固定設定
    // ==========================================================================

    const CONFIG = {
        vault:  '',                         // 空 = Obsidian の「最後に使用した保管庫」
        folder: '000_org/clippings',
        noteNameTemplate:    '{{title|slice: 0,40}}-{{date|date:"YYYY-MM-DD"}}',
        noteContentTemplate: '{{content}}',
        properties: [
            { name: 'title',       value: '{{title}}' },
            { name: 'id',          value: 'id-{{url}}' },
            { name: 'source',      value: '{{url}}' },
            { name: 'author',      value: '{{author|split:", "|wikilink|join}}' },
            { name: 'published',   value: '{{published}}' },
            { name: 'created',     value: '{{date}}' },
            { name: 'description', value: '{{description}}' },
            { name: 'tags',        value: 'clippings' },
        ],
        propertyTypes: {
            title:       'text',
            id:          'text',
            source:      'text',
            author:      'multitext',
            published:   'date',
            created:     'date',
            description: 'text',
            tags:        'multitext',
        },
    };

    // ==========================================================================
    // ユーティリティ
    // ==========================================================================

    const pad2 = n => String(n).padStart(2, '0');

    function formatDate(date, fmt) {
        return fmt
            .replace('YYYY', date.getFullYear())
            .replace('MM',   pad2(date.getMonth() + 1))
            .replace('DD',   pad2(date.getDate()))
            .replace('HH',   pad2(date.getHours()))
            .replace('mm',   pad2(date.getMinutes()))
            .replace('ss',   pad2(date.getSeconds()));
    }

    function escapeDoubleQuotes(str) {
        return str.replace(/"/g, '\\"');
    }

    function sanitizeFileName(name) {
        return name
            .replace(/[/\\:*?"<>|]/g, '')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 200);
    }

    function needsKeyQuoting(name) {
        return /[:\s{}[\],&*#?|<>=!%@\\]/.test(name) ||
               /^\d/.test(name) ||
               /^(true|false|null|yes|no|on|off)$/i.test(name);
    }

    function quoteKey(name) {
        return name.includes('"')
            ? `'${name.replace(/'/g, "''")}'`
            : `"${name}"`;
    }

    // ==========================================================================
    // メタデータ抽出
    // ==========================================================================

    function queryMeta(...selectors) {
        for (const sel of selectors) {
            const el = document.querySelector(sel);
            if (!el) continue;
            const val = el.getAttribute('content') || el.textContent?.trim();
            if (val) return val;
        }
        return '';
    }

    function getJsonLd() {
        for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
            try {
                const data  = JSON.parse(s.textContent);
                const items = Array.isArray(data) ? data : [data];
                for (const item of items) {
                    if (typeof item?.['@type'] === 'string' &&
                        /Article|BlogPosting|NewsArticle|WebPage/.test(item['@type'])) {
                        return item;
                    }
                }
            } catch {}
        }
        return null;
    }

    function extractMetadata() {
        const jsonLd = getJsonLd();

        // title
        const title =
            document.title ||
            queryMeta('meta[property="og:title"]', 'meta[name="twitter:title"]') ||
            document.querySelector('h1')?.textContent?.trim() || '';

        // url
        const url = location.href;

        // author
        let author = queryMeta('meta[name="author"]', 'meta[property="article:author"]');
        if (!author && jsonLd?.author) {
            const a = jsonLd.author;
            author = Array.isArray(a)
                ? a.map(x => x?.name || String(x)).filter(Boolean).join(', ')
                : a?.name || String(a) || '';
        }
        if (!author) {
            author =
                document.querySelector('[itemprop="author"] [itemprop="name"]')?.textContent?.trim() ||
                document.querySelector('[rel="author"]')?.textContent?.trim() || '';
        }

        // published
        let published = queryMeta(
            'meta[property="article:published_time"]',
            'meta[name="date"]',
            'meta[name="pubdate"]',
            'meta[property="og:article:published_time"]',
        );
        if (!published && jsonLd?.datePublished) published = jsonLd.datePublished;
        if (!published) {
            published =
                document.querySelector('time[itemprop="datePublished"]')?.getAttribute('datetime') ||
                document.querySelector('time[datetime]')?.getAttribute('datetime') || '';
        }
        if (published) {
            const m = published.match(/^(\d{4})-(\d{2})-(\d{2})/);
            published = m ? `${m[1]}-${m[2]}-${m[3]}` : '';
        }

        // description
        const description =
            queryMeta(
                'meta[name="description"]',
                'meta[property="og:description"]',
                'meta[name="twitter:description"]',
            ) || (typeof jsonLd?.description === 'string' ? jsonLd.description : '') || '';

        return { title, url, author, published, description };
    }

    // ==========================================================================
    // コンテンツ抽出 (Readability + Turndown)
    // ==========================================================================

    // HTML 文字列 → DOM ノード（DOMParser 経由 = TrustedTypes 安全）
    function htmlToNode(html) {
        try { return new DOMParser().parseFromString(html, 'text/html').body; }
        catch { return null; }
    }

    // Turndown インスタンス生成（ノイズ除去ルール付き）
    function createTurndown() {
        const td = new TurndownService({
            headingStyle:     'atx',
            hr:               '---',
            bulletListMarker: '-',
            codeBlockStyle:   'fenced',
            emDelimiter:      '*',
        });

        if (typeof turndownPluginGfm !== 'undefined') td.use(turndownPluginGfm.gfm);

        // 変換対象から除外する要素
        const SKIP_TAGS = new Set([
            'script', 'style', 'noscript', 'iframe', 'canvas',
            'form', 'button', 'input', 'select', 'textarea', 'svg',
        ]);
        const SKIP_ROLES = new Set([
            'navigation', 'banner', 'contentinfo', 'search',
            'complementary', 'toolbar', 'dialog', 'alert',
        ]);
        td.addRule('skipNoise', {
            filter: node => {
                const tag = (node.nodeName || '').toLowerCase();
                if (SKIP_TAGS.has(tag)) return true;
                const role = node.getAttribute?.('role') || '';
                if (SKIP_ROLES.has(role)) return true;
                return false;
            },
            replacement: () => '',
        });

        return td;
    }

    // Markdown を人間が読める形に整形
    function cleanMarkdown(md) {
        return md
            .replace(/\n{3,}/g, '\n\n')          // 3連続改行 → 2つに圧縮
            .replace(/^[ \t]+$/gm, '')             // 空白のみの行を除去
            .replace(/\[([^\]]*)\]\(\s*\)/g, '$1') // 空URLリンク → テキストのみ
            .replace(/!\[\]\([^)]*\)\n?/g, '')     // alt空の画像を除去
            .replace(/\\\./g, '.')                 // 不要なエスケープを除去
            .trim() + '\n';
    }

    // ノイズ要素を除去した DOMParser 製ドキュメントを返す
    function buildCleanDoc() {
        const docClone = new DOMParser().parseFromString(
            document.documentElement.outerHTML, 'text/html'
        );
        // Readability に渡す前にノイズを削除（精度向上）
        const noiseSelectors = [
            'script', 'style', 'noscript', 'iframe',
            'nav', 'header', 'footer', 'aside',
            '[role="navigation"]', '[role="banner"]',
            '[role="contentinfo"]', '[role="complementary"]',
            '[role="search"]', '[role="toolbar"]',
        ];
        for (const sel of noiseSelectors) {
            try { docClone.querySelectorAll(sel).forEach(el => el.remove()); } catch {}
        }
        return docClone;
    }

    // メインコンテンツ要素を DOM から探す（Readability 失敗時フォールバック）
    function findMainElement() {
        const candidates = [
            'main', '[role="main"]', 'article',
            '#content', '.content', '.post-content',
            '.article-content', '.entry-content', '.article-body',
            '.post-body', '#main', '.main',
        ];
        for (const sel of candidates) {
            const el = document.querySelector(sel);
            if (el) return el;
        }
        return document.body;
    }

    function extractContent() {
        const td = createTurndown();

        // --- Readability による本文抽出 ---
        try {
            const docClone = buildCleanDoc();
            const reader   = new Readability(docClone, { charThreshold: 20 });
            const article  = reader.parse();
            if (article?.content && article.content.length > 300) {
                const node = htmlToNode(article.content);
                if (node) return cleanMarkdown(td.turndown(node));
            }
        } catch (e) {
            console.warn('[Obsidian Clipper] Readability failed:', e);
        }

        // --- フォールバック: セマンティック要素を探して変換 ---
        return cleanMarkdown(td.turndown(findMainElement()));
    }

    // ==========================================================================
    // テンプレートエンジン
    // ==========================================================================

    // | で分割（クォート内の | は無視する）
    function splitOnPipes(str) {
        const parts = [];
        let buf = '';
        let inQ = false, qc = '';
        for (const c of str) {
            if (inQ) {
                buf += c;
                if (c === qc) inQ = false;
            } else if (c === '"' || c === "'") {
                inQ = true; qc = c; buf += c;
            } else if (c === '|') {
                parts.push(buf.trim()); buf = '';
            } else {
                buf += c;
            }
        }
        if (buf.trim()) parts.push(buf.trim());
        return parts;
    }

    // --- フィルタ実装 ---

    function filterSlice(str, param) {
        if (!param || str === '') return str;
        const [a, b] = param.split(',').map(p => p.trim());
        const start  = a !== '' ? parseInt(a, 10) : undefined;
        const end    = b !== undefined && b !== '' ? parseInt(b, 10) : undefined;
        try {
            const arr = JSON.parse(str);
            if (Array.isArray(arr)) {
                const s = arr.slice(start, end);
                return s.length === 1 ? String(s[0]) : JSON.stringify(s);
            }
        } catch {}
        return str.slice(start, end);
    }

    function filterDate(str, param) {
        if (str === '') return str;
        let date;
        if (str === 'now') {
            date = new Date();
        } else {
            // YYYY-MM-DD はローカル時刻として解釈（UTC ズレ防止）
            const m = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
            date = m
                ? new Date(parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3]))
                : new Date(str);
        }
        if (isNaN(date.getTime())) return str;
        const fmt = param ? param.replace(/^['"](.*)['"]$/, '$1') : 'YYYY-MM-DD';
        return formatDate(date, fmt);
    }

    function filterSplit(str, param) {
        const sep = param ? param.replace(/^['"](.*)['"]$/, '$1') : '';
        return JSON.stringify(sep ? str.split(sep) : [...str]);
    }

    function filterWikilink(str) {
        if (!str.trim()) return str;
        try {
            const arr = JSON.parse(str);
            if (Array.isArray(arr)) {
                return JSON.stringify(arr.map(item => (item ? `[[${item}]]` : '')));
            }
        } catch {}
        return str ? `[[${str}]]` : str;
    }

    function filterJoin(str, param) {
        if (!str || str === 'undefined' || str === 'null') return '';
        try {
            const arr = JSON.parse(str);
            if (!Array.isArray(arr)) return str;
            const sep = param ? param.replace(/^['"](.*)['"]$/, '$1') : ',';
            return arr.join(sep);
        } catch { return str; }
    }

    const FILTERS = { slice: filterSlice, date: filterDate, split: filterSplit, wikilink: filterWikilink, join: filterJoin };

    function applyFilter(value, name, param) {
        return FILTERS[name] ? FILTERS[name](String(value), param) : value;
    }

    // {{variable|filter1: param|filter2}} を解決
    function resolveTemplate(template, vars) {
        return template.replace(/\{\{([^}]+)\}\}/g, (_, expr) => {
            const parts    = splitOnPipes(expr.trim());
            const varName  = parts[0];
            let value      = Object.prototype.hasOwnProperty.call(vars, varName)
                ? String(vars[varName] ?? '')
                : '';

            for (let i = 1; i < parts.length; i++) {
                const part       = parts[i];
                const colonIdx   = part.indexOf(':');
                const filterName = colonIdx === -1 ? part.trim() : part.slice(0, colonIdx).trim();
                const param      = colonIdx === -1 ? '' : part.slice(colonIdx + 1).trim();
                value = applyFilter(value, filterName, param);
            }
            return value;
        });
    }

    // ==========================================================================
    // YAML frontmatter 生成
    // ==========================================================================

    function generateFrontmatter(properties, typeMap) {
        let fm = '---\n';

        for (const prop of properties) {
            const name = prop.name.trim();
            const key  = needsKeyQuoting(name) ? quoteKey(name) : name;
            const type = typeMap[prop.name] || 'text';
            const val  = prop.value;

            fm += `${key}:`;

            switch (type) {
                case 'multitext': {
                    const trimmed = val.trim();
                    let items;
                    // JSON 配列形式 ["...","..."] を優先パース
                    if (trimmed.startsWith('["') && trimmed.endsWith('"]')) {
                        try { items = JSON.parse(trimmed); }
                        catch { items = trimmed.split(',').map(s => s.trim()); }
                    } else {
                        // [[...]] 内のカンマを壊さないよう分割
                        items = trimmed.split(/,(?![^\[]*\]\])/).map(s => s.trim());
                    }
                    items = items.filter(s => s !== '');
                    if (items.length > 0) {
                        fm += '\n';
                        for (const item of items) fm += `  - "${escapeDoubleQuotes(item)}"\n`;
                    } else {
                        fm += '\n';
                    }
                    break;
                }
                case 'date':
                case 'datetime':
                    fm += val.trim() ? ` ${val.trim()}\n` : '\n';
                    break;
                default: // text
                    fm += val.trim() ? ` "${escapeDoubleQuotes(val)}"\n` : '\n';
            }
        }

        fm += '---\n';
        return fm === '---\n---\n' ? '' : fm;
    }

    // ==========================================================================
    // メインクリップ処理
    // ==========================================================================

    async function clip() {
        setButtonState('loading');

        try {
            const meta    = extractMetadata();
            const content = extractContent();
            const now     = new Date();
            const dateStr = formatDate(now, 'YYYY-MM-DD');

            const vars = {
                title:       meta.title,
                url:         meta.url,
                author:      meta.author,
                published:   meta.published,
                description: meta.description,
                date:        dateStr,
                content,
            };

            // プロパティ値を解決
            const resolvedProps = CONFIG.properties.map(p => ({
                name:  p.name,
                value: resolveTemplate(p.value, vars),
            }));

            const frontmatter = generateFrontmatter(resolvedProps, CONFIG.propertyTypes);
            const noteBody    = resolveTemplate(CONFIG.noteContentTemplate, vars);
            const noteContent = frontmatter + noteBody;

            // ノート名（ファイルパス）
            const rawName  = resolveTemplate(CONFIG.noteNameTemplate, vars);
            const noteName = sanitizeFileName(rawName);
            const filePath = CONFIG.folder
                ? CONFIG.folder.replace(/\/$/, '') + '/' + noteName
                : noteName;

            // Obsidian URI 構築
            const vaultParam     = CONFIG.vault ? `&vault=${encodeURIComponent(CONFIG.vault)}` : '';
            const encodedContent = encodeURIComponent(noteContent);

            let obsidianUrl;
            let usedClipboard = false;

            if (encodedContent.length > 1_800_000) {
                // URL 制限超過 → クリップボード経由
                // GM_setClipboard は Tampermonkey が @grant で注入するグローバル関数
                const gmCopy = /** @type {Function|undefined} */ (
                    // eslint-disable-next-line no-new-func
                    (() => { try { return Function('return typeof GM_setClipboard!=="undefined"?GM_setClipboard:void 0')(); } catch { return undefined; } })()
                );
                if (gmCopy) {
                    gmCopy(noteContent, 'text');
                } else {
                    await navigator.clipboard.writeText(noteContent);
                }
                obsidianUrl   = `obsidian://new?file=${encodeURIComponent(filePath)}${vaultParam}&clipboard`;
                usedClipboard = true;
            } else {
                obsidianUrl = `obsidian://new?file=${encodeURIComponent(filePath)}&content=${encodedContent}${vaultParam}`;
            }

            // Obsidian を開く（カスタムプロトコル → ページ遷移は起きない）
            window.location.href = obsidianUrl;

            setButtonState('success');
            showToast(
                usedClipboard
                    ? 'コンテンツをクリップボードにコピーしました。\nObsidian でペーストしてください。'
                    : 'Obsidian に送信しました ✓',
                usedClipboard ? 'warning' : 'success',
            );
        } catch (err) {
            console.error('[Obsidian Clipper]', err);
            showToast('エラー: ' + err.message, 'error');
            setButtonState('idle');
        }
    }

    // ==========================================================================
    // UI
    // ==========================================================================

    let clipBtn = null;

    // innerHTML を使わず DOM API で SVG 生成（TrustedTypes 対応）
    function makeSVG(paths, extraStyle) {
        const NS  = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(NS, 'svg');
        const attrs = { width:'20', height:'20', viewBox:'0 0 24 24', fill:'none',
                        stroke:'currentColor', 'stroke-width':'2.5',
                        'stroke-linecap':'round', 'stroke-linejoin':'round' };
        for (const [k, v] of Object.entries(attrs)) svg.setAttribute(k, v);
        if (extraStyle) svg.style.cssText = extraStyle;
        for (const d of paths) {
            const p = document.createElementNS(NS, 'path');
            p.setAttribute('d', d);
            svg.appendChild(p);
        }
        return svg;
    }

    function makeIconClip() {
        return makeSVG([
            'M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48'
        ]);
    }

    function makeIconSpin() {
        // CSS border-spinner（SVG アニメーション不要で TrustedTypes 完全安全）
        const span = document.createElement('span');
        span.style.cssText = [
            'display:inline-block', 'width:18px', 'height:18px',
            'border:2.5px solid rgba(255,255,255,.35)',
            'border-top-color:#fff', 'border-radius:50%',
            'animation:_obs_spin .8s linear infinite',
        ].join(';');
        return span;
    }

    // ボタン内を安全にクリア
    function clearBtn() {
        while (clipBtn.firstChild) clipBtn.removeChild(clipBtn.firstChild);
    }

    function injectStyles() {
        const s = document.createElement('style');
        s.textContent = `
            @keyframes _obs_spin { to { transform: rotate(360deg); } }
            @keyframes _obs_fadein { from { opacity:0; transform:translateY(6px); } }
            #_obs_btn {
                position: fixed; bottom: 24px; right: 24px;
                width: 48px; height: 48px; border-radius: 50%;
                background: #7c5cbf; color: #fff; border: none;
                cursor: pointer; display: flex; align-items: center;
                justify-content: center; z-index: 2147483647;
                box-shadow: 0 2px 14px rgba(0,0,0,.35);
                transition: background .2s, transform .1s;
                padding: 0; outline: none;
            }
            #_obs_btn:hover  { background: #9370d8; }
            #_obs_btn:active { transform: scale(.92); }
            #_obs_btn:disabled { background: #aaa; cursor: default; }
            ._obs_toast {
                position: fixed; bottom: 84px; right: 24px;
                max-width: 300px; padding: 10px 14px;
                border-radius: 6px; font: 13px/1.5 -apple-system, BlinkMacSystemFont, sans-serif;
                z-index: 2147483646; box-shadow: 0 2px 12px rgba(0,0,0,.25);
                pointer-events: none; white-space: pre-wrap;
                animation: _obs_fadein .2s ease;
            }
        `;
        document.head.appendChild(s);
    }

    function injectButton() {
        clipBtn = document.createElement('button');
        clipBtn.id    = '_obs_btn';
        clipBtn.title = 'Obsidian にクリップ (Alt+Shift+O)';
        clipBtn.appendChild(makeIconClip());   // innerHTML 不使用
        clipBtn.addEventListener('click', clip);
        document.body.appendChild(clipBtn);
    }

    function setButtonState(state) {
        if (!clipBtn) return;
        clearBtn();
        if (state === 'loading') {
            clipBtn.appendChild(makeIconSpin());
            clipBtn.disabled = true;
        } else if (state === 'success') {
            clipBtn.textContent = '✓';         // textContent は TrustedTypes 安全
            clipBtn.style.background = '#27ae60';
            clipBtn.disabled = false;
            setTimeout(() => {
                if (!clipBtn) return;
                clearBtn();
                clipBtn.appendChild(makeIconClip());
                clipBtn.style.background = '';
            }, 2500);
        } else {
            clipBtn.appendChild(makeIconClip());
            clipBtn.style.background = '';
            clipBtn.disabled = false;
        }
    }

    function showToast(message, type = 'info') {
        document.querySelectorAll('._obs_toast').forEach(e => e.remove());
        const colors = {
            success: ['#27ae60', '#fff'],
            error:   ['#e74c3c', '#fff'],
            warning: ['#e67e22', '#fff'],
            info:    ['#2980b9', '#fff'],
        };
        const [bg, fg] = colors[type] ?? colors.info;
        const t = document.createElement('div');
        t.className = '_obs_toast';
        Object.assign(t.style, { background: bg, color: fg });
        t.textContent = message;
        document.body.appendChild(t);
        setTimeout(() => t.remove(), type === 'error' ? 8000 : type === 'warning' ? 6000 : 3500);
    }

    // キーボードショートカット (Alt+Shift+O)
    document.addEventListener('keydown', e => {
        if (e.altKey && e.shiftKey && e.code === 'KeyO') {
            e.preventDefault();
            clip();
        }
    });

    // ==========================================================================
    // 初期化
    // ==========================================================================

    function init() {
        injectStyles();
        injectButton();
    }

    document.body ? init() : document.addEventListener('DOMContentLoaded', init);

})();
