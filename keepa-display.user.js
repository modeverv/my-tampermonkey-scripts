// ==UserScript==
// @name         Keepa Price Tracker (Display Only)
// @namespace    https://keepa.com/
// @version      1.0.0
// @description  Amazon商品ページにKeepaの価格履歴グラフを表示します（データ送信なし・表示のみ）
// @match        *://*.amazon.com/*
// @match        *://*.amazon.co.jp/*
// @match        *://*.amazon.de/*
// @match        *://*.amazon.co.uk/*
// @match        *://*.amazon.fr/*
// @match        *://*.amazon.it/*
// @match        *://*.amazon.es/*
// @match        *://*.amazon.ca/*
// @match        *://*.amazon.com.mx/*
// @match        *://*.amazon.in/*
// @match        *://*.amazon.com.br/*
// @match        *://*.amazon.nl/*
// @match        *://*.amazon.com.au/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    // --- 設定 ---
    const GRAPH_RANGE = 365;          // 表示期間（日）
    const HOVER_PREVIEW = true;       // リンクホバー時にプレビューを表示するか

    // --- ドメイン解決 ---
    const TLD_TO_ID = {
        'com': 1, 'co.uk': 2, 'de': 3, 'fr': 4,
        'co.jp': 5, 'jp': 5, 'ca': 6, 'it': 8,
        'es': 9, 'in': 10, 'com.mx': 11, 'com.br': 12,
        'com.au': 13, 'nl': 14,
    };

    function getTLD() {
        const m = location.hostname.match(/amazon\.(.+)$/);
        return m ? m[1] : null;
    }

    function getDomainId(tld) {
        return TLD_TO_ID[tld] ?? 1;
    }

    // --- ASIN 抽出 ---
    const ASIN_RE = /(?:\/dp\/|\/gp\/product\/|[?&]ASIN=)([BC][A-Z0-9]{9}|\d{9}(?:X|\d))/i;

    function getASIN(url) {
        const m = (url || location.href).match(ASIN_RE);
        return m ? m[1].toUpperCase() : null;
    }

    // --- 商品ページ判定 ---
    function isProductPage() {
        const url = location.href;
        if (/\/(images|review|customer-reviews|ask\/questions|product-reviews)/.test(url)) return false;
        if (/\/e\/([BC][A-Z0-9]{9}|\d{9}(?:X|\d))/.test(url)) return false;
        return ASIN_RE.test(url);
    }

    // --- グラフ URL 構築 ---
    // graph.keepa.com は認証不要・読み取り専用の PNG エンドポイント
    function buildGraphUrl(asin, tld, w, h) {
        const type = (w < 300 || h < 150) ? 1 : 2;
        return `https://graph.keepa.com/pricehistory.png` +
            `?type=${type}&asin=${asin}&domain=${tld}` +
            `&width=${w}&height=${h}` +
            `&amazon=1&new=1&used=1&salesrank=1&range=${GRAPH_RANGE}`;
    }

    function buildKeepaLink(domainId, asin) {
        return `https://keepa.com/#!product/${domainId}/${asin}`;
    }

    // --- 商品ページへのグラフ埋め込み ---
    function insertPanel(asin, tld, domainId) {
        if (document.getElementById('keepa-tm-panel')) return;

        const w = Math.min(920, window.innerWidth - 40);
        const h = Math.round(w * 0.42);
        const graphUrl = buildGraphUrl(asin, tld, w, h);
        const keepaUrl = buildKeepaLink(domainId, asin);

        const panel = document.createElement('div');
        panel.id = 'keepa-tm-panel';
        panel.style.cssText = [
            'margin:10px 0',
            'padding:8px',
            'border:1px solid #d5d9d9',
            'border-radius:4px',
            'background:#fff',
            'box-sizing:border-box',
        ].join(';');

        panel.innerHTML = `
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
                <span style="font-weight:bold;font-size:13px;color:#444;">Keepa – 価格履歴</span>
                <a href="${keepaUrl}" target="_blank" rel="noopener noreferrer"
                   style="font-size:12px;color:#e47911;text-decoration:none;">
                    Keepa で詳細を見る →
                </a>
            </div>
            <img id="keepa-tm-graph" src="${graphUrl}"
                 style="width:100%;height:auto;display:block;border-top:2px solid #ff9f29;"
                 alt="Keepa price history">
            <div id="keepa-tm-err"
                 style="display:none;padding:12px;text-align:center;color:#999;font-size:12px;">
                グラフを読み込めませんでした。
                <a href="${keepaUrl}" target="_blank" rel="noopener noreferrer">Keepaで確認</a>
            </div>
        `;

        panel.querySelector('#keepa-tm-graph').onerror = function () {
            this.style.display = 'none';
            panel.querySelector('#keepa-tm-err').style.display = 'block';
        };

        // 挿入位置: 元の拡張と同じ優先順位
        const PLACEHOLDERS = [
            '#bottomRow',
            '#feature-bullets',
            '#productDescription_feature_div',
            '#averageCustomerReviews',
            '#titleSection',
            '#title',
        ];

        let anchor = null;
        for (const sel of PLACEHOLDERS) {
            anchor = document.querySelector(sel);
            if (anchor) break;
        }

        if (anchor) {
            anchor.parentNode.insertBefore(panel, anchor);
        } else {
            (document.getElementById('centerCol') || document.body).prepend(panel);
        }
    }

    // 挿入位置がまだ DOM に存在しない場合のリトライ
    function tryInsertPanel(asin, tld, domainId, attempts = 0) {
        if (document.getElementById('keepa-tm-panel')) return;
        const ok = document.querySelector('#bottomRow,#feature-bullets,#title');
        if (ok) {
            insertPanel(asin, tld, domainId);
        } else if (attempts < 20) {
            setTimeout(() => tryInsertPanel(asin, tld, domainId, attempts + 1), 300);
        }
    }

    // --- ホバープレビュー（リンク一覧ページ用） ---
    const LINK_ASIN_RE =
        /^https?:\/\/(?:[^/]+\.)?amazon\.([^./]+\.[^./]+|[^./]+)\/[^.]*?(?:\/|\?ASIN=)([BC][A-Z0-9]{9}|\d{9}(?:X|\d))/i;

    function setupHoverPreview() {
        let tip = null;
        let hideTimer = null;

        function getTooltip() {
            if (tip) return tip;
            tip = document.createElement('div');
            tip.style.cssText = [
                'position:fixed', 'z-index:10000000',
                'background:#fff', 'box-shadow:0 1px 7px -2px #444',
                'border-top:2px solid #ff9f29',
                'display:none', 'pointer-events:none',
            ].join(';');
            document.body.appendChild(tip);
            return tip;
        }

        function showTip(event, asin, tld) {
            clearTimeout(hideTimer);
            const t = getTooltip();
            const w = Math.min(320, Math.floor(window.innerWidth * 0.28));
            const h = Math.round(w * 0.55);
            const graphUrl = buildGraphUrl(asin, tld, w, h);

            t.innerHTML = '';
            const img = document.createElement('img');
            img.src = graphUrl;
            img.style.cssText = `width:${w}px;height:${h}px;display:block;`;
            img.onerror = () => { t.style.display = 'none'; };
            t.appendChild(img);

            const vw = window.innerWidth, vh = window.innerHeight;
            const cx = event.clientX, cy = event.clientY;
            t.style.left  = (vw - cx > w * 1.1) ? `${cx + 12}px` : '';
            t.style.right = (vw - cx > w * 1.1) ? '' : `${vw - cx + 12}px`;
            t.style.top   = (vh - cy > h * 1.1) ? `${cy + 12}px` : '';
            t.style.bottom = (vh - cy > h * 1.1) ? '' : `${vh - cy + 12}px`;
            t.style.display = 'block';
        }

        function hideTip() {
            hideTimer = setTimeout(() => { if (tip) tip.style.display = 'none'; }, 120);
        }

        const seen = new WeakSet();

        function attachLinks(root) {
            root.querySelectorAll('a[href]').forEach(a => {
                if (seen.has(a)) return;
                const m = a.href.match(LINK_ASIN_RE);
                if (!m || a.href.includes('offer-listing')) return;
                seen.add(a);
                const linkTld = m[1], asin = m[2].toUpperCase();
                a.addEventListener('pointerenter', e => showTip(e, asin, linkTld));
                a.addEventListener('pointerleave', hideTip);
            });
        }

        attachLinks(document);
        new MutationObserver(muts => {
            muts.forEach(m => m.addedNodes.forEach(n => {
                if (n.nodeType === 1) attachLinks(n);
            }));
        }).observe(document.documentElement, { childList: true, subtree: true });
    }

    // --- エントリーポイント ---
    function init() {
        const tld = getTLD();
        if (!tld) return;
        const domainId = getDomainId(tld);

        if (isProductPage()) {
            const asin = getASIN();
            if (asin) tryInsertPanel(asin, tld, domainId);
        }

        if (HOVER_PREVIEW) setupHoverPreview();
    }

    init();
})();
