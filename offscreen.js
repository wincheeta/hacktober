// Offscreen audio player for jumpscare sounds (exempt from user gesture autoplay restrictions).
const SOUND_URL = chrome.runtime.getURL("audio/five-nights-at-freddys-full-scream-sound_2.mp3");

// Preload and decode audio into memory immediately on offscreen load
const screamAudio = new Audio(SOUND_URL);
screamAudio.preload = "auto";
screamAudio.volume = 1.0;
screamAudio.load();

let stopTimer = null;

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "play-offscreen-audio") {
    clearTimeout(stopTimer);
    try {
      screamAudio.pause();
      screamAudio.currentTime = 0;
      screamAudio.volume = typeof msg.volume === "number" ? msg.volume : 1.0;
      screamAudio.play().catch((err) => {
        console.warn("Spookify: offscreen audio play failed:", err);
      });

      if (msg.durationMs) {
        stopTimer = setTimeout(() => {
          screamAudio.pause();
          screamAudio.currentTime = 0;
        }, msg.durationMs);
      }
    } catch (e) {
      console.warn("Spookify: offscreen audio error:", e);
    }
  } else if (msg && msg.type === "stop-offscreen-audio") {
    clearTimeout(stopTimer);
    try {
      screamAudio.pause();
      screamAudio.currentTime = 0;
    } catch {}
  }
});
