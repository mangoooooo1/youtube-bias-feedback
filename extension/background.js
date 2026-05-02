import { addVideo } from './storage.js';

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message).then(sendResponse);
  return true;
});

async function handleMessage(message) {
  if (message.type === 'VIDEO_DETECTED') {
    const { videoId, title } = message;
    await addVideo(videoId, title);
    console.log('[background] saved:', { videoId, title });
    return { ok: true };
  }

  return { ok: false, reason: 'unknown message type' };
}
