chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('[background] message received:', message);
  sendResponse({ ok: true });
});
