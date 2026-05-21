// ==UserScript==
// @name         Terminal Green Theme
// @namespace    http://tampermonkey.net/
// @version      1.0.0
// @description  全サイトをターミナル風グリーン・オン・ブラックに統一する
// @author       seijiro
// @match        *://*/*
// @grant        GM_addStyle
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  // ========== 除外サイト ==========
  // ここに除外したいドメインを追加
  const EXCLUDED_DOMAINS = [
//    'youtube.com',
    'netflix.com',
    'figma.com',
    // 'example.com',
  ];

  const hostname = location.hostname.replace(/^www\./, '');
  if (EXCLUDED_DOMAINS.some(d => hostname.includes(d))) return;

  // ========== カラー定義 ==========
  const GREEN       = '#00ff41';   // メインテキスト（マトリックスグリーン）
  const GREEN_DIM   = '#00cc33';   // リンク・サブテキスト
  const GREEN_DARK  = '#005514';   // ボーダー
  const GREEN_HOVER = '#ffffff';   // ホバー時テキスト
  const BG_BASE     = '#0a0a0a';   // メイン背景
  const BG_SURFACE  = '#0f1a0f';   // カード・ボックス背景
  const BG_HOVER    = '#0d2b0d';   // ホバー背景

  GM_addStyle(`
    /* ==============================
       ベースリセット
    ============================== */
    *,
    *::before,
    *::after {
      background-color: transparent !important;
      color: ${GREEN} !important;
      border-color: ${GREEN_DARK} !important;
      font-family: 'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'Source Code Pro', 'Menlo', 'Monaco', monospace !important;
      text-shadow: none !important;
      box-shadow: none !important;
      outline-color: ${GREEN_DIM} !important;
    }

    /* ==============================
       背景
    ============================== */
    html,
    body {
      background-color: ${BG_BASE} !important;
    }

    /* ブロック要素の背景 */
    div, section, article, aside, nav, header, footer,
    main, form, fieldset, figure, details, summary,
    table, thead, tbody, tfoot, tr, th, td,
    ul, ol, li, dl, dt, dd,
    blockquote, pre, code, kbd, samp {
      background-color: transparent !important;
    }

    /* カード・パネル系（影・border あるもの） */
    [class*="card"],
    [class*="panel"],
    [class*="modal"],
    [class*="dialog"],
    [class*="popup"],
    [class*="dropdown"],
    [class*="tooltip"],
    [class*="sidebar"],
    [class*="drawer"],
    [role="dialog"],
    [role="tooltip"],
    [role="listbox"],
    [role="menu"] {
      background-color: ${BG_SURFACE} !important;
      border: 1px solid ${GREEN_DARK} !important;
    }

    /* ==============================
       テキスト
    ============================== */
    p, span, div, li, td, th, label,
    h1, h2, h3, h4, h5, h6,
    strong, em, small, cite, q,
    time, address, figcaption {
      color: ${GREEN} !important;
    }

    h1, h2, h3 {
      color: ${GREEN} !important;
      border-bottom: 1px solid ${GREEN_DARK} !important;
      padding-bottom: 4px !important;
    }

    /* ==============================
       リンク
    ============================== */
    a,
    a:visited {
      color: ${GREEN_DIM} !important;
      text-decoration: underline !important;
      text-decoration-color: ${GREEN_DARK} !important;
    }

    a:hover {
      color: ${GREEN_HOVER} !important;
      text-decoration-color: ${GREEN} !important;
    }

    /* ==============================
       フォーム要素
    ============================== */
    input,
    textarea,
    select,
    button,
    [role="button"],
    [type="submit"],
    [type="button"],
    [type="reset"] {
      background-color: ${BG_SURFACE} !important;
      color: ${GREEN} !important;
      border: 1px solid ${GREEN_DARK} !important;
      caret-color: ${GREEN} !important;
    }

    input::placeholder,
    textarea::placeholder {
      color: ${GREEN_DARK} !important;
      opacity: 1 !important;
    }

    input:focus,
    textarea:focus,
    select:focus,
    button:focus {
      border-color: ${GREEN} !important;
      outline: 1px solid ${GREEN} !important;
    }

    button:hover,
    [role="button"]:hover {
      background-color: ${BG_HOVER} !important;
      color: ${GREEN_HOVER} !important;
    }

    /* ==============================
       画像・メディア
    ============================== */
/*
img,
    video,
    canvas,
    svg image {
      filter: grayscale(100%) brightness(0.7) sepia(20%) hue-rotate(90deg) !important;
      opacity: 0.75 !important;
    }

    /* SVG 自体はフィルターしない（アイコン等） */
    svg {
      filter: none !important;
      color: ${GREEN} !important;
      fill: ${GREEN} !important;
      stroke: ${GREEN} !important;
    }

    svg path,
    svg circle,
    svg rect,
    svg polygon,
    svg line {
      fill: ${GREEN} !important;
      stroke: ${GREEN} !important;
    }
*/
    /* ==============================
       スクロールバー（webkit）
    ============================== */
    ::-webkit-scrollbar {
      width: 8px !important;
      height: 8px !important;
      background-color: ${BG_BASE} !important;
    }

    ::-webkit-scrollbar-thumb {
      background-color: ${GREEN_DARK} !important;
      border-radius: 0 !important;
    }

    ::-webkit-scrollbar-track {
      background-color: ${BG_BASE} !important;
    }

    /* ==============================
       選択テキスト
    ============================== */
    ::selection {
      background-color: ${GREEN_DARK} !important;
      color: ${GREEN_HOVER} !important;
    }

    /* ==============================
       コードブロック
    ============================== */
    pre,
    code,
    kbd,
    samp {
      background-color: ${BG_SURFACE} !important;
      color: ${GREEN} !important;
      border: 1px solid ${GREEN_DARK} !important;
      border-radius: 0 !important;
    }

    /* ==============================
       テーブル
    ============================== */
    table {
      border-collapse: collapse !important;
      border: 1px solid ${GREEN_DARK} !important;
    }

    th {
      background-color: ${BG_SURFACE} !important;
      border-bottom: 2px solid ${GREEN} !important;
    }

    tr:nth-child(even) td {
      background-color: ${BG_SURFACE} !important;
    }

    tr:hover td {
      background-color: ${BG_HOVER} !important;
    }

    /* ==============================
       水平線
    ============================== */
    hr {
      border: none !important;
      border-top: 1px solid ${GREEN_DARK} !important;
    }


  `);

})();