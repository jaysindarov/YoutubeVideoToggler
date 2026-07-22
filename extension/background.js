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
  return !!(
    document.pictureInPictureElement ||
    (window.documentPictureInPicture && window.documentPictureInPicture.window)
  );
}

function togglePip() {
  if (window.documentPictureInPicture && window.documentPictureInPicture.window) {
    window.documentPictureInPicture.window.close();
    return;
  }
  if (document.pictureInPictureElement) {
    document.exitPictureInPicture().catch(() => {});
    return;
  }

  const DEFAULT_LANDSCAPE = { width: 400, height: 225 };
  const DEFAULT_PORTRAIT = { width: 220, height: 391 };

  function visibleArea(el) {
    const r = el.getBoundingClientRect();
    const h = Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0);
    const w = Math.min(r.right, window.innerWidth) - Math.max(r.left, 0);
    return Math.max(0, h) * Math.max(0, w);
  }

  function getActiveVideo(exclude) {
    const videos = Array.from(document.querySelectorAll("video")).filter(
      (v) => v !== exclude && v.readyState >= 1 && v.duration > 0
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

  async function openDocumentPip(startVideo) {
    const isPortrait = startVideo.videoHeight > startVideo.videoWidth;
    const size = isPortrait ? DEFAULT_PORTRAIT : DEFAULT_LANDSCAPE;

    const pipWindow = await window.documentPictureInPicture.requestWindow({
      width: size.width,
      height: size.height,
    });

    const style = pipWindow.document.createElement("style");
    style.textContent = `
      html, body { margin:0; padding:0; background:#000; height:100%; overflow:hidden; }
      #mwt-wrap { position:relative; width:100%; height:100%; }
      #mwt-wrap video { width:100%; height:100%; object-fit:contain; background:#000; display:block; }
      .mwt-nav { position:absolute; top:50%; transform:translateY(-50%); width:36px; height:36px;
        border:none; border-radius:50%; background:rgba(0,0,0,0.55); color:#fff; font-size:18px;
        line-height:36px; text-align:center; cursor:pointer; opacity:0; transition:opacity .15s; }
      #mwt-wrap:hover .mwt-nav { opacity:1; }
      .mwt-prev { left:8px; }
      .mwt-next { right:8px; }
    `;
    pipWindow.document.head.append(style);

    const wrap = pipWindow.document.createElement("div");
    wrap.id = "mwt-wrap";
    pipWindow.document.body.append(wrap);

    let current = startVideo;

    function place(video) {
      video._mwtParent = video.parentNode;
      video._mwtNext = video.nextSibling;
      wrap.prepend(video);
    }

    function restore(video) {
      if (video._mwtParent) {
        video._mwtParent.insertBefore(video, video._mwtNext);
      }
    }

    place(current);

    const prevBtn = pipWindow.document.createElement("button");
    prevBtn.className = "mwt-nav mwt-prev";
    prevBtn.textContent = "‹";
    prevBtn.addEventListener("click", () => nav("prev"));

    const nextBtn = pipWindow.document.createElement("button");
    nextBtn.className = "mwt-nav mwt-next";
    nextBtn.textContent = "›";
    nextBtn.addEventListener("click", () => nav("next"));

    wrap.append(prevBtn, nextBtn);

    function nav(direction) {
      const clicked =
        direction === "next"
          ? clickFirstMatch([
              "#navigation-button-down button",
              'button[aria-label*="Next video" i]',
              ".ytp-next-button",
            ])
          : clickFirstMatch([
              "#navigation-button-up button",
              'button[aria-label*="Previous video" i]',
              ".ytp-prev-button",
            ]);
      if (!clicked) return;

      let tries = 0;
      const tick = () => {
        tries += 1;
        const next = getActiveVideo(current);
        if (next) {
          restore(current);
          place(next);
          current = next;
          current.play().catch(() => {});
          return;
        }
        if (tries < 10) setTimeout(tick, 150);
      };
      setTimeout(tick, 150);
    }

    pipWindow.addEventListener(
      "pagehide",
      () => {
        restore(current);
      },
      { once: true }
    );
  }

  const videos = Array.from(document.querySelectorAll("video"));
  const video =
    videos.find((v) => v.readyState >= 1 && v.duration > 0) ||
    document.querySelector("video.html5-main-video") ||
    videos[0];

  if (!video) return;

  const request = () => {
    if (window.documentPictureInPicture) {
      openDocumentPip(video).catch((err) => {
        console.error("YouTube Floating PiP Toggle: documentPictureInPicture failed, falling back", err);
        video.disablePictureInPicture = false;
        video.requestPictureInPicture().catch(() => {});
      });
    } else {
      video.disablePictureInPicture = false;
      video.requestPictureInPicture().catch((err) => {
        console.error("YouTube Floating PiP Toggle: failed to enter PiP", err);
      });
    }
  };

  if (video.readyState >= 1) {
    request();
  } else {
    video.addEventListener("loadedmetadata", request, { once: true });
  }
}
