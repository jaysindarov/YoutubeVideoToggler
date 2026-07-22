const YOUTUBE_MATCH = "*://*.youtube.com/*";

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "toggle-pip") return;

  const tabs = await chrome.tabs.query({ url: YOUTUBE_MATCH });
  if (!tabs.length) return;

  // Prefer a tab that already has PiP active (so the hotkey can close it),
  // then a tab that's audible, then just the first YouTube tab found.
  const results = await Promise.all(
    tabs.map((tab) =>
      chrome.scripting
        .executeScript({ target: { tabId: tab.id }, func: isInPip })
        .then((r) => ({ tab, inPip: r[0]?.result === true }))
        .catch(() => ({ tab, inPip: false }))
    )
  );

  const target =
    results.find((r) => r.inPip)?.tab ||
    tabs.find((t) => t.audible) ||
    tabs[0];

  chrome.scripting.executeScript({
    target: { tabId: target.id },
    func: togglePip,
  });
});

function isInPip() {
  return !!document.pictureInPictureElement;
}

function togglePip() {
  if (document.pictureInPictureElement) {
    document.exitPictureInPicture().catch(() => {});
    return;
  }

  function visibleArea(el) {
    const r = el.getBoundingClientRect();
    const h = Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0);
    const w = Math.min(r.right, window.innerWidth) - Math.max(r.left, 0);
    return Math.max(0, h) * Math.max(0, w);
  }

  function getActiveVideo() {
    const videos = Array.from(document.querySelectorAll("video")).filter(
      (v) => v.readyState >= 1 && v.duration > 0
    );
    if (!videos.length) return null;
    const playing = videos.filter((v) => !v.paused);
    const pool = playing.length ? playing : videos;
    return pool.reduce((best, v) => (visibleArea(v) > visibleArea(best) ? v : best), pool[0]);
  }

  function clickFirstMatch(selectors) {
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) {
        el.click();
        return true;
      }
    }
    return false;
  }

  function switchPipAfterNav(previousEl) {
    let tries = 0;
    const tick = () => {
      tries += 1;
      const next = getActiveVideo();
      if (next && next !== previousEl) {
        next.disablePictureInPicture = false;
        next.requestPictureInPicture().catch(() => {});
        return;
      }
      if (tries < 10) setTimeout(tick, 150);
    };
    setTimeout(tick, 150);
  }

  function goNext() {
    const previousEl = document.pictureInPictureElement;
    const clicked = clickFirstMatch([
      "#navigation-button-down button",
      'button[aria-label*="Next video" i]',
      ".ytp-next-button",
    ]);
    if (clicked) switchPipAfterNav(previousEl);
  }

  function goPrev() {
    const previousEl = document.pictureInPictureElement;
    const clicked = clickFirstMatch([
      "#navigation-button-up button",
      'button[aria-label*="Previous video" i]',
      ".ytp-prev-button",
    ]);
    if (clicked) switchPipAfterNav(previousEl);
  }

  function bindMediaSessionControls() {
    if (!("mediaSession" in navigator)) return;
    try {
      navigator.mediaSession.setActionHandler("nexttrack", goNext);
    } catch (e) {}
    try {
      navigator.mediaSession.setActionHandler("previoustrack", goPrev);
    } catch (e) {}
  }

  const videos = Array.from(document.querySelectorAll("video"));
  const video =
    videos.find((v) => v.readyState >= 1 && v.duration > 0) ||
    document.querySelector("video.html5-main-video") ||
    videos[0];

  if (!video) return;

  video.disablePictureInPicture = false;

  const request = () => {
    video
      .requestPictureInPicture()
      .then(() => bindMediaSessionControls())
      .catch((err) => {
        console.error("YouTube Floating PiP Toggle: failed to enter PiP", err);
      });
  };

  if (video.readyState >= 1) {
    request();
  } else {
    video.addEventListener("loadedmetadata", request, { once: true });
  }
}
