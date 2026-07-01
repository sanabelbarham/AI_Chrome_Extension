// popup.js

const enabledToggle = document.getElementById('enabledToggle');
const apiKeyInput = document.getElementById('apiKeyInput');
const saveBtn = document.getElementById('saveBtn');
const statusEl = document.getElementById('status');

chrome.storage.sync.get(['enabled', 'apiKey'], (res) => {
  enabledToggle.checked = res.enabled !== false;
  apiKeyInput.value = res.apiKey || '';
});

saveBtn.addEventListener('click', () => {
  const enabled = enabledToggle.checked;
  const apiKey = apiKeyInput.value.trim();

  chrome.storage.sync.set({ enabled, apiKey }, () => {
    statusEl.textContent = 'Saved!';
    setTimeout(() => { statusEl.textContent = ''; }, 1500);
  });
});