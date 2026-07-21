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

  const videos = Array.from(document.querySelectorAll("video"));
  const video =
    videos.find((v) => v.readyState >= 1 && v.duration > 0) ||
    document.querySelector("video.html5-main-video") ||
    videos[0];

  if (!video) return;

  video.disablePictureInPicture = false;

  const request = () => {
    video.requestPictureInPicture().catch((err) => {
      console.error("YouTube Floating PiP Toggle: failed to enter PiP", err);
    });
  };

  if (video.readyState >= 1) {
    request();
  } else {
    video.addEventListener("loadedmetadata", request, { once: true });
  }
}
