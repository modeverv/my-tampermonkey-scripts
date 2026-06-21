// ==UserScript==
// @name         Chrome Emacs (Tampermonkey port)
// @namespace    chrome-emacs-tampermonkey
// @version      1.0.0
// @description  Cmd+. でフォーカス中の編集要素を ws://localhost:64292 のエディタ(Emacs等)で編集します
// @match        *://*/*
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function () {
    'use strict';

    // --- 設定 ---
    const WS_URL      = 'ws://localhost:64292';
    const HINT_CHARS  = 'ASDFGQWERTZXCVB';
    const isMac       = /Mac/.test(navigator.userAgent);

    // --- 状態 ---
    let activeWS      = null;
    let hintState     = null; // { hints: Element[], elems: Element[], typed: string, listener: fn }

    // ==========================================================================
    // 1. 要素ハンドラ
    // ==========================================================================

    /** textarea / input の共通ハンドラ */
    function textareaHandler(elem) {
        return {
            name: elem.tagName.toLowerCase(),
            extension: null,
            getRect: () => elem.getBoundingClientRect(),
            getValue() {
                const start = elem.selectionStart ?? 0;
                const end   = elem.selectionEnd   ?? start;
                const lines = elem.value.substring(0, start).split('\n');
                return {
                    text: elem.value,
                    lineNumber: lines.length,
                    column: lines[lines.length - 1].length + 1,
                    selections: [{ start, end }],
                };
            },
            setValue(text, opts) {
                elem.focus();
                elem.value = text;
                for (const ev of ['input', 'change']) {
                    elem.dispatchEvent(new Event(ev, { bubbles: true }));
                }
                if (opts?.selections?.[0]) {
                    try {
                        const { start, end } = opts.selections[0];
                        elem.setSelectionRange(start, end);
                    } catch (_) {}
                }
            },
        };
    }

    /** contenteditable ハンドラ */
    function contentEditableHandler(elem) {
        return {
            name: 'content-editable',
            extension: ['.html'],
            getRect: () => elem.getBoundingClientRect(),
            getValue: () => ({ text: elem.innerHTML, lineNumber: 1, column: 1 }),
            setValue(text) {
                elem.focus();
                elem.innerHTML = text;
                for (const ev of ['input', 'change']) {
                    elem.dispatchEvent(new Event(ev, { bubbles: true }));
                }
            },
        };
    }

    /** Monaco editor ハンドラ */
    function monacoHandler(elem) {
        const monaco = window.monaco?.editor;
        if (!monaco) return null;

        const editors = (typeof monaco.getEditors === 'function' ? monaco.getEditors() : []);
        const editor  = editors.find(e => e.hasTextFocus?.()) || editors[0];
        if (!editor) return null;

        const model = editor.getModel?.();
        const container = elem.closest('.monaco-editor');

        const getLangExt = () => {
            // monaco.languages.getLanguages() で拡張子を探す
            try {
                const langId = model?.getLanguageId?.() || model?.getLanguageIdentifier?.()?.language;
                if (!langId) return null;
                const langs = typeof window.monaco?.languages?.getLanguages === 'function'
                    ? window.monaco.languages.getLanguages() : [];
                const lang = langs.find(l => l.id === langId);
                return lang?.extensions || null;
            } catch (_) { return null; }
        };

        return {
            name: 'monaco',
            extension: getLangExt(),
            getRect: () => (container || elem).getBoundingClientRect(),
            getValue() {
                const text = editor.getValue?.() || '';
                const pos  = editor.getPosition?.() || { lineNumber: 1, column: 1 };
                return { text, lineNumber: pos.lineNumber, column: pos.column };
            },
            setValue(text, opts) {
                editor.setValue?.(text);
                if (opts?.lineNumber && opts?.column) {
                    const pos = { lineNumber: opts.lineNumber, column: opts.column };
                    editor.setPosition?.(pos);
                    editor.revealPosition?.(pos);
                }
            },
        };
    }

    /** CodeMirror 5 ハンドラ */
    function cm5Handler(cm5Elem) {
        const cm = cm5Elem.CodeMirror;
        if (!cm) return null;
        return {
            name: 'codemirror5',
            extension: null,
            getRect: () => cm5Elem.getBoundingClientRect(),
            getValue() {
                const pos = cm.getCursor();
                return { text: cm.getValue(), lineNumber: pos.line + 1, column: pos.ch + 1 };
            },
            setValue(text, opts) {
                cm.setValue(text);
                if (opts?.lineNumber) {
                    cm.setCursor({ line: opts.lineNumber - 1, ch: (opts.column || 1) - 1 });
                }
            },
        };
    }

    /** CodeMirror 6 ハンドラ (best-effort: DOM + property scan) */
    function cm6Handler(cmEditorElem) {
        // EditorView はいくつかの既知プロパティ名で保持されることが多い
        let view = null;
        for (const key of ['view', 'editorView', 'codemirror', '_view', '__view', 'cmView']) {
            const v = cmEditorElem[key];
            if (v?.state?.doc && v.dispatch) { view = v; break; }
        }
        if (!view) {
            // プロパティスキャン
            for (const key of Object.getOwnPropertyNames(cmEditorElem)) {
                const v = cmEditorElem[key];
                if (v && typeof v === 'object' && v.state?.doc && typeof v.dispatch === 'function') {
                    view = v; break;
                }
            }
        }

        return {
            name: 'codemirror6',
            extension: null,
            getRect: () => cmEditorElem.getBoundingClientRect(),
            getValue() {
                if (view) {
                    const doc = view.state.doc;
                    const pos = view.state.selection.main.head;
                    const line = doc.lineAt(pos);
                    return { text: doc.toString(), lineNumber: line.number, column: pos - line.from + 1 };
                }
                // フォールバック: テキストコンテンツ読み取り
                const content = cmEditorElem.querySelector('.cm-content');
                return { text: content?.innerText || '', lineNumber: 1, column: 1 };
            },
            setValue(text) {
                if (view) {
                    view.dispatch({
                        changes: { from: 0, to: view.state.doc.length, insert: text },
                    });
                }
            },
        };
    }

    /** Ace editor ハンドラ */
    function aceHandler(aceInputElem) {
        // ace.edit() はコンテナを引数に取る
        const container = aceInputElem.parentElement?.parentElement;
        let editor = null;
        try {
            editor = window.ace?.edit?.(container) || container?.env?.editor;
        } catch (_) {}
        if (!editor) return null;
        return {
            name: 'ace',
            extension: null,
            getRect: () => aceInputElem.getBoundingClientRect(),
            getValue() {
                const pos = editor.getCursorPosition();
                return { text: editor.getValue(), lineNumber: pos.row + 1, column: pos.column + 1 };
            },
            setValue(text, opts) {
                editor.setValue(text, -1);
                if (opts?.lineNumber) editor.gotoLine(opts.lineNumber, (opts.column || 1) - 1);
            },
        };
    }

    /** 要素からハンドラを決定 */
    function handlerFor(elem) {
        if (!elem) return null;

        // Monaco
        if (elem.closest('.monaco-editor')) return monacoHandler(elem);

        // CodeMirror 6: cm-content の祖先
        let e = elem;
        while (e) {
            if (e.classList?.contains('cm-content')) {
                const cmEditor = e.closest('.cm-editor');
                return cmEditor ? cm6Handler(cmEditor) : null;
            }
            e = e.parentElement;
        }

        // CodeMirror 5
        const cm5 = elem.closest('.CodeMirror');
        if (cm5) return cm5Handler(cm5);

        // Ace
        if (elem.classList?.contains('ace_text-input')) return aceHandler(elem);

        // textarea
        if (elem.tagName === 'TEXTAREA') return textareaHandler(elem);

        // input (text 系)
        if (elem instanceof HTMLInputElement) {
            const type  = (elem.type || 'text').toLowerCase();
            const valid = new Set(['', 'email', 'number', 'password', 'search', 'tel', 'text', 'url']);
            if (valid.has(type) && !elem.disabled && !elem.readOnly) return textareaHandler(elem);
        }

        // contenteditable
        if (elem.isContentEditable) return contentEditableHandler(elem);

        return null;
    }

    // ==========================================================================
    // 2. WebSocket / プロトコル
    // ==========================================================================

    function openEditor(handler) {
        // 既存接続を閉じる
        if (activeWS) {
            activeWS.close();
            activeWS = null;
        }

        const ws = new WebSocket(WS_URL);

        ws.onopen = () => {
            const data = handler.getValue();
            const rect = handler.getRect();
            const ext  = handler.extension;

            const payload = {
                text:       data.text,
                url:        location.href,
                title:      document.title,
                lineNumber: data.lineNumber || 1,
                column:     data.column     || 1,
                selections: data.selections,
                rect: rect ? {
                    top:    Math.trunc(rect.top),
                    left:   Math.trunc(rect.left),
                    width:  Math.trunc(rect.width),
                    height: Math.trunc(rect.height),
                    x:      Math.trunc(rect.x + window.screenX),
                    y:      Math.trunc(rect.y + window.screenY),
                } : undefined,
            };

            if (ext) payload.extension = Array.isArray(ext) ? ext : [ext];

            ws.send(JSON.stringify({ type: 'register', payload }));
        };

        ws.onmessage = (event) => {
            try {
                const msg = JSON.parse(event.data);
                if (msg.type === 'updateText' && typeof msg.payload?.text === 'string') {
                    handler.setValue(msg.payload.text, msg.payload);
                }
            } catch (err) {
                console.error('[Chrome Emacs TM] message error:', err);
            }
        };

        ws.onerror = () => {
            showToast(`エディタへの接続失敗: ${WS_URL}`, 'error');
        };

        ws.onclose = (ev) => {
            if (ev.code === 1006) {
                showToast(`接続できません: ${WS_URL} — Emacs の atomic-chrome が起動しているか確認してください`, 'error');
            }
            if (activeWS === ws) activeWS = null;
        };

        // Keepalive (10秒ごと)
        const ka = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'keepalive' }));
            } else {
                clearInterval(ka);
            }
        }, 10_000);

        activeWS = ws;
    }

    // ==========================================================================
    // 3. アクティブ要素の編集
    // ==========================================================================

    function editActive() {
        const elem = document.activeElement;
        if (!elem || elem.tagName === 'BODY' || elem.tagName === 'HTML') {
            showToast('編集可能な要素にフォーカスしてから Cmd+. を押してください', 'info');
            return;
        }
        const handler = handlerFor(elem);
        if (!handler) {
            showToast('この要素は未対応です。Cmd+Shift+. でヒントモードを使ってください', 'info');
            return;
        }
        openEditor(handler);
    }

    // ==========================================================================
    // 4. ヒントモード
    // ==========================================================================

    /** 表示中の編集可能要素を収集 */
    function collectEditableElems() {
        const SELS = [
            'textarea',
            '[contenteditable]',
            '*[role=textbox]',
            'div.ace_cursor',
            '.CodeMirror',
            '.cm-content',
            '.monaco-editor textarea',
            'input[type="text"], input[type="email"], input[type="search"], input[type="url"], input[type="number"], input[type="password"], input[type="tel"], input:not([type])',
        ];

        const elems = Array.from(new Set(
            SELS.flatMap(s => Array.from(document.querySelectorAll(s)))
        )).filter(e => {
            if (e.disabled || e.readOnly) return false;
            if (e.getAttribute('contenteditable') === 'false') return false;
            const r = e.getBoundingClientRect();
            return r.width > 0 && r.height > 0 &&
                r.top < window.innerHeight && r.bottom > 0 &&
                getComputedStyle(e).visibility !== 'hidden';
        }).filter(e => handlerFor(e) !== null);

        return elems;
    }

    /** ラベル生成 */
    function genLabels(count) {
        const chars = HINT_CHARS;
        const len   = count <= 1 ? 1 : Math.ceil(Math.log(count) / Math.log(chars.length));
        const labels = [];
        const gen = (prefix, depth) => {
            if (labels.length >= count) return;
            if (depth === 0) { labels.push(prefix); return; }
            for (const c of chars) {
                if (labels.length >= count) break;
                gen(prefix + c, depth - 1);
            }
        };
        gen('', len);
        return labels;
    }

    function cancelHints() {
        if (!hintState) return;
        hintState.hints.forEach(h => h.remove());
        window.removeEventListener('keydown', hintState.listener, true);
        hintState = null;
    }

    function startHintMode() {
        if (hintState) { cancelHints(); return; }

        const elems = collectEditableElems();
        if (elems.length === 0) {
            showToast('編集可能な要素が見つかりません', 'info');
            return;
        }

        const labels = genLabels(elems.length);
        const hints  = elems.map((elem, i) => {
            const label = labels[i];
            const rect  = elem.getBoundingClientRect();
            const hint  = document.createElement('div');

            hint.setAttribute('data-ce-hint', label);
            hint.style.cssText = [
                'position:fixed',
                `top:${rect.top + 2}px`,
                `left:${rect.left + 2}px`,
                'background:#000',
                'color:#ff1493',
                'border:2px solid #ff1493',
                'border-radius:4px',
                'padding:2px 6px',
                'font:bold 16px/1.2 monospace',
                'z-index:10000000',
                'cursor:pointer',
                'pointer-events:auto',
            ].join(';');
            hint.textContent = label;

            hint.addEventListener('click', () => {
                cancelHints();
                const handler = handlerFor(elem);
                if (handler) openEditor(handler);
            });

            document.body.appendChild(hint);
            return hint;
        });

        let typed = '';

        const listener = (e) => {
            // Escape / Ctrl-g でキャンセル
            if (e.key === 'Escape' || (e.ctrlKey && e.key === 'g')) {
                e.preventDefault();
                cancelHints();
                return;
            }

            const ch = e.key.toUpperCase();
            if (!HINT_CHARS.includes(ch)) return;
            e.preventDefault();

            typed += ch;

            // ヒント更新
            hints.forEach(hint => {
                const hLabel = hint.getAttribute('data-ce-hint');
                if (hLabel.startsWith(typed)) {
                    hint.style.opacity  = '1';
                    const matched = document.createElement('span');
                    matched.style.color = '#555';
                    matched.textContent = typed;
                    const rest = document.createElement('span');
                    rest.textContent = hLabel.slice(typed.length);
                    hint.replaceChildren(matched, rest);
                } else {
                    hint.style.opacity = '0.25';
                }
            });

            // 完全一致 → 選択
            const match = hints.find(h => h.getAttribute('data-ce-hint') === typed);
            if (match) { match.click(); return; }

            // 候補なし → キャンセル
            if (!hints.some(h => h.getAttribute('data-ce-hint').startsWith(typed))) {
                cancelHints();
            }
        };

        window.addEventListener('keydown', listener, true);
        hintState = { hints, elems, typed: '', listener };
    }

    // ==========================================================================
    // 5. トースト通知
    // ==========================================================================

    function showToast(message, type = 'info') {
        document.querySelectorAll('[data-ce-toast]').forEach(e => e.remove());

        const STYLES = {
            error:   { background: 'rgb(253,237,237)', color: 'rgb(95,33,32)',   borderLeft: '.375rem solid #fa8072' },
            success: { background: '#ddffdd',          color: 'rgb(30,70,32)',   borderLeft: '.375rem solid #04AA6D' },
            info:    { background: 'rgb(229,246,253)', color: 'rgb(1,67,97)',    borderLeft: '.375rem solid #039be5' },
        };

        const toast = document.createElement('div');
        toast.setAttribute('data-ce-toast', '');
        Object.assign(toast.style, {
            position:    'fixed',
            top:         '16px',
            left:        '50%',
            transform:   'translateX(-50%)',
            padding:     '8px 20px',
            borderRadius: '4px',
            zIndex:      '99999999',
            fontSize:    '14px',
            minWidth:    '300px',
            maxWidth:    '420px',
            boxShadow:   '0 2px 10px rgba(0,0,0,.25)',
            overflowWrap: 'break-word',
            ...STYLES[type],
        });
        toast.textContent = message;

        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), type === 'error' ? 9000 : 4000);
    }

    // ==========================================================================
    // 6. キーボードショートカット
    // ==========================================================================

    document.addEventListener('keydown', (e) => {
        const mod = isMac ? e.metaKey : e.ctrlKey;
        if (!mod || e.code !== 'Period') return;

        if (e.shiftKey) {
            // Cmd+Shift+. / Ctrl+Shift+.  → ヒントモード
            e.preventDefault();
            startHintMode();
        } else {
            // Cmd+. / Ctrl+.  → アクティブ要素を編集
            e.preventDefault();
            editActive();
        }
    }, true);

})();
