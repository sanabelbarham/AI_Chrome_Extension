// content.js
(() => {
  'use strict';

  // ---------- Config ----------
  const DEBOUNCE_MS = 300;
  const MIN_CHARS_BEFORE_SUGGEST = 3;
  const MAX_CONTEXT_CHARS = 2000;

  // ---------- State ----------
  let currentTarget = null;
  let currentSuggestion = '';
  let debounceTimer = null;
  let activeRequestId = 0;
  let enabled = true;
  let ghostOverlayEl = null;
  let ghostInlineEl = null;

  // ---------- Load settings ----------
  chrome.storage.sync.get(['enabled'], (res) => {
    enabled = res.enabled !== false;
  });
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.enabled) {
      enabled = changes.enabled.newValue;
      if (!enabled) clearSuggestion();
    }
  });

  // ---------- Field detection ----------
  function isEditable(el) {
    if (!el || !(el instanceof Element)) return false;
    const tag = el.tagName;
    if (tag === 'TEXTAREA') return true;
    if (tag === 'INPUT') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      return ['text', 'search', 'email', 'url'].includes(type);
    }
    if (el.isContentEditable) return true;
    return false;
  }

  function resolveEditableTarget(el) {
    if (isEditable(el)) return el;
    if (el && el.closest) {
      const editableAncestor = el.closest('[contenteditable="true"], [contenteditable=""]');
      if (editableAncestor) return editableAncestor;
    }
    return null;
  }

  // ---------- Event listeners ----------
  document.addEventListener('focusin', onFocusIn, true);
  document.addEventListener('focusout', onFocusOut, true);
  document.addEventListener('input', onInput, true);
  document.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('scroll', onScrollOrResize, true);
  window.addEventListener('resize', onScrollOrResize, true);

  function onFocusIn(e) {
    const target = resolveEditableTarget(e.target);
    if (!target) return;
    currentTarget = target;
  }

  function onFocusOut(e) {
    const target = resolveEditableTarget(e.target);
    if (target && target === currentTarget) {
      clearSuggestion();
      currentTarget = null;
    }
  }

  function onInput(e) {
    if (!enabled) return;
    const target = resolveEditableTarget(e.target);
    if (!target) return;
    currentTarget = target;
    clearSuggestion();
    scheduleSuggestion(target);
  }

  function onScrollOrResize() {
    if (currentSuggestion && currentTarget && ghostOverlayEl) {
      positionOverlayGhost(currentTarget);
    }
  }

  function scheduleSuggestion(el) {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => requestSuggestion(el), DEBOUNCE_MS);
  }

  // ---------- Requesting a suggestion ----------
  function getTextAndCaret(el) {
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      const value = el.value || '';
      const caret = el.selectionStart ?? value.length;
      return { prefix: value.slice(0, caret), suffix: value.slice(caret), caret };
    }

    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return { prefix: '', suffix: '', caret: 0 };

    const range = sel.getRangeAt(0);
    const preRange = range.cloneRange();
    preRange.selectNodeContents(el);
    preRange.setEnd(range.endContainer, range.endOffset);
    const prefix = preRange.toString();

    const postRange = range.cloneRange();
    postRange.selectNodeContents(el);
    postRange.setStart(range.endContainer, range.endOffset);
    const suffix = postRange.toString();

    return { prefix, suffix, caret: prefix.length };
  }

  function requestSuggestion(el) {
    if (!enabled || el !== currentTarget) return;

    const { prefix, suffix } = getTextAndCaret(el);
    const trimmedPrefix = prefix.slice(-MAX_CONTEXT_CHARS);

    if (trimmedPrefix.trim().length < MIN_CHARS_BEFORE_SUGGEST) return;
    if (suffix.trim().length > 0) return;

    const requestId = ++activeRequestId;

    chrome.runtime.sendMessage(
      { type: 'GET_SUGGESTION', prefix: trimmedPrefix, suffix: suffix.slice(0, 200), url: location.hostname },
      (response) => {
        if (requestId !== activeRequestId) return;
        if (chrome.runtime.lastError) return;
        if (!response || !response.suggestion) return;
        if (el !== currentTarget) return;

        const { prefix: nowPrefix } = getTextAndCaret(el);
        if (nowPrefix !== trimmedPrefix) return;

        showSuggestion(el, response.suggestion);
      }
    );
  }

  // ---------- Clearing a suggestion ----------
  function clearSuggestion() {
    currentSuggestion = '';
    removeGhostOverlay();
    removeGhostInline();
  }

  // ---------- Showing a suggestion ----------
  function showSuggestion(el, suggestion) {
    if (!suggestion || !suggestion.trim()) return;
    currentSuggestion = suggestion;

    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      renderOverlayGhost(el, suggestion);
    } else {
      renderInlineGhost(el, suggestion);
    }
  }

  const FONT_STYLE_PROPS = [
    'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing',
    'lineHeight', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
    'boxSizing', 'whiteSpace', 'wordWrap'
  ];

  function renderOverlayGhost(el, suggestion) {
    removeGhostOverlay();

    const overlay = document.createElement('div');
    overlay.className = 'aic-ghost-overlay';

    const style = window.getComputedStyle(el);
    FONT_STYLE_PROPS.forEach((prop) => {
      overlay.style[prop] = style[prop];
    });
    overlay.style.whiteSpace = el.tagName === 'TEXTAREA' ? 'pre-wrap' : 'pre';

    const typedSpan = document.createElement('span');
    typedSpan.style.color = 'transparent';
    typedSpan.textContent = el.value;

    const suggestionSpan = document.createElement('span');
    suggestionSpan.textContent = suggestion;

    overlay.appendChild(typedSpan);
    overlay.appendChild(suggestionSpan);

    document.body.appendChild(overlay);
    ghostOverlayEl = overlay;

    positionOverlayGhost(el);
  }

  function positionOverlayGhost(el) {
    if (!ghostOverlayEl) return;
    const rect = el.getBoundingClientRect();
    ghostOverlayEl.style.left = `${window.scrollX + rect.left}px`;
    ghostOverlayEl.style.top = `${window.scrollY + rect.top}px`;
    ghostOverlayEl.style.width = `${rect.width}px`;
    ghostOverlayEl.style.height = `${rect.height}px`;
  }

  function removeGhostOverlay() {
    if (ghostOverlayEl) {
      ghostOverlayEl.remove();
      ghostOverlayEl = null;
    }
  }

  function renderInlineGhost(el, suggestion) {
    removeGhostInline();
    const span = document.createElement('span');
    span.className = 'aic-ghost-inline';
    span.textContent = suggestion;
    span.setAttribute('data-aic-ghost', 'true');
    span.contentEditable = 'false';
    el.appendChild(span);
    ghostInlineEl = span;
  }

  function removeGhostInline() {
    if (ghostInlineEl && ghostInlineEl.parentNode) {
      ghostInlineEl.remove();
    }
    ghostInlineEl = null;
  }

  // ---------- Keyboard handling ----------
  function onKeyDown(e) {
    if (!currentSuggestion || !currentTarget) return;
    if (e.target !== currentTarget) return;

    if (e.key === 'Tab') {
      e.preventDefault();
      acceptSuggestion(currentTarget);
      return;
    }

    if (e.key === 'Escape') {
      clearSuggestion();
      return;
    }

    clearSuggestion();
  }

  function acceptSuggestion(el) {
    const suggestion = currentSuggestion;
    clearSuggestion();

    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      const newValue = el.value + suggestion;
      el.value = newValue;
      const newCaret = newValue.length;
      el.setSelectionRange(newCaret, newCaret);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      document.execCommand('insertText', false, suggestion);
    }
  }

})();