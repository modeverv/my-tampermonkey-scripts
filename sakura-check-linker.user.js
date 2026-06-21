// ==UserScript==
// @name         Sakura Check Linker
// @namespace    https://sakura-checker.jp/
// @version      1.0.1
// @description  Amazon.co.jpの商品ページのレビューの右にサクラチェッカーへのリンクを埋め込みます
// @author       tampermonkey port
// @match        https://www.amazon.co.jp/*
// @match        https://amazon.co.jp/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    const SAKURA_CHECK_URL = 'https://sakura-checker.jp/search/';
    const SAKURA_CHECK_TEXT = 'サクラチェッカー';

    function getASIN() {
        const asinPtn = /(?<=\/)[A-Z\d]{10}(?=[/?])/;
        const match = document.location.href.match(asinPtn);
        return match ? match[0] : null;
    }

    function buildLinkUrl(asin) {
        return asin ? SAKURA_CHECK_URL + asin : null;
    }

    function buildLinkElement(linkUrl) {
        if (!linkUrl) return null;
        const span = document.createElement('span');
        const a = document.createElement('a');
        a.href = linkUrl;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.innerText = SAKURA_CHECK_TEXT;
        span.appendChild(a);
        return span;
    }

    function injectLink(linkElm) {
        const target = document.getElementById('averageCustomerReviews');
        if (!linkElm || !target) return;
        const spacer = document.createElement('span');
        spacer.className = 'a-letter-space';
        target.appendChild(spacer);
        target.appendChild(linkElm);
    }

    injectLink(buildLinkElement(buildLinkUrl(getASIN())));
})();
