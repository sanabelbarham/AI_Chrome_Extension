// background.js

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== 'GET_SUGGESTION') return;

  getSuggestionFromGemini(message.prefix)
    .then((suggestion) => sendResponse({ suggestion }))
    .catch((err) => {
      console.error('[AI Autocomplete] Error:', err);
      sendResponse({ suggestion: null });
    });

  return true;
});

async function getSuggestionFromGemini(prefix) {
  const { apiKey } = await chrome.storage.sync.get(['apiKey']);
  if (!apiKey) {
    console.warn('[AI Autocomplete] No API key set yet. Open the extension popup to add one.');
    return null;
  }

const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prefix }] }],
      systemInstruction: {
        parts: [{ text: 'You complete the user\'s sentence. Reply with ONLY the continuation text — a few words that naturally follow. No quotes, no explanation, no repeating their text back.' }]
      },
      generationConfig: { maxOutputTokens: 30 }
    })
  });

  if (!response.ok) {
    console.error('[AI Autocomplete] API error:', response.status, await response.text());
    return null;
  }

  const data = await response.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  return text.trim();
}