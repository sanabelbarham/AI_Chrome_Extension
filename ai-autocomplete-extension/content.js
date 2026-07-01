// content.js
(() => {
  'use strict';

  // ---------- Config ----------
  const DEBOUNCE_MS = 300;          // wait after typing stops before requesting a suggestion
  const MIN_CHARS_BEFORE_SUGGEST = 3; // don't bother suggesting on 1-2 characters
  const MAX_CONTEXT_CHARS = 2000;   // cap how much text we send to the AI, for latency/cost

  // ---------- State ----------
  let currentTarget = null;   // the field currently focused
  let currentSuggestion = ''; // the ghost text currently shown
  let debounceTimer = null;
  let activeRequestId = 0;    // used to ignore stale/late API responses
  let enabled = true;

  // ---------- Load settings ----------
  chrome.storage.sync.get(['enabled'], (res) => {
    enabled = res.enabled !== false; // default: on
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
      // only plain text-like inputs — never passwords, numbers, dates, etc.
      return ['text', 'search', 'email', 'url'].includes(type);
    }

    if (el.isContentEditable) return true;

    return false;
  }

  // Some sites (Slack, Notion, Gmail) fire focus on a wrapper div, not the
  // actual contenteditable node. Walk up/down a little to find the real one.
  function resolveEditableTarget(el) {
    if (isEditable(el)) return el;
    if (el && el.closest) {
      const editableAncestor = el.closest('[contenteditable="true"], [contenteditable=""]');
      if (editableAncestor) return editableAncestor;
    }
    return null;
  }

  // ---------- Event listeners ----------
  // Capture phase (`true`) so we see events even if the page stops propagation.
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
    clearSuggestion(); // typing invalidates whatever ghost text was showing
    scheduleSuggestion(target);
  }

  function onScrollOrResize() {
    // Ghost overlay position is pixel-based, so it must be re-synced
    // whenever the page or field scrolls/resizes.
    if (currentSuggestion && currentTarget) {
      repositionGhost(currentTarget);
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
      return {
        prefix: value.slice(0, caret),
        suffix: value.slice(caret),
        caret
      };
    }

    // contenteditable: use the Selection API to split text at the caret
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

    // Don't bother the API for trivial/empty input, or if caret isn't at
    // the end of a "word" (avoids weird mid-word suggestions on every field).
    const trimmedPrefix = prefix.slice(-MAX_CONTEXT_CHARS);
    if (trimmedPrefix.trim().length < MIN_CHARS_BEFORE_SUGGEST) return;
if (suffix.trim().length > 0) return; // only suggest when cursor is at the very end

    const requestId = ++activeRequestId;

    chrome.runtime.sendMessage(
      {
        type: 'GET_SUGGESTION',
        prefix: trimmedPrefix,
        suffix: suffix.slice(0, 200),
        url: location.hostname
      },
      (response) => {
        // Ignore replies for requests that are no longer the latest one —
        // this is what keeps fast typers from seeing stale suggestions.
        if (requestId !== activeRequestId) return;
        if (chrome.runtime.lastError) return; // extension context gone, etc.
        if (!response || !response.suggestion) return;
        if (el !== currentTarget) return;

        // Re-check the field hasn't changed underneath us while we waited.
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
    hideHintChip();
  }

  let ghostOverlayEl = null;   // for textarea/input
  let ghostInlineEl = null;    // for contenteditable

  function showSuggestion(el, suggestion) {
    if (!suggestion || !suggestion.trim()) return;
    currentSuggestion = suggestion;

    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      renderOverlayGhost(el, suggestion);
    } else {
      renderInlineGhost(el, suggestion);
    }
  }

  // Copies just the styles that affect how text looks/wraps,
  // so the overlay's text lines up with the real field's text.
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

    // Typed text stays invisible (just a spacer), suggestion shows in gray.
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


  // --- contenteditable: insert a real ghost <span> after your text ---
  function renderInlineGhost(el, suggestion) {
    removeGhostInline();

    const span = document.createElement('span');
    span.className = 'aic-ghost-inline';
    span.textContent = suggestion;
    span.setAttribute('data-aic-ghost', 'true');
    span.contentEditable = 'false'; // stops you from typing directly into it

    // Since we only suggest at the very end of your text (our simplified
    // rule), we can just append the ghost span to the end of the element.
    el.appendChild(span);
    ghostInlineEl = span;
  }

  function removeGhostInline() {
    if (ghostInlineEl && ghostInlineEl.parentNode) {
      ghostInlineEl.remove();
    }
    ghostInlineEl = null;
  }

})();