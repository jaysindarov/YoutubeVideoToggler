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
      #mwt-wrap video { width:100%; height:100%; object-fit:cover; background:#000; display:block; }
      .mwt-nav { position:absolute; top:50%; transform:translateY(-50%); width:36px; height:36px;
        border:none; border-radius:50%; background:rgba(0,0,0,0.55); color:#fff; font-size:18px;
        line-height:36px; text-align:center; cursor:pointer; opacity:0; transition:opacity .15s; z-index:2; }
      #mwt-wrap:hover .mwt-nav, #mwt-wrap:hover .mwt-bar { opacity:1; }
      .mwt-prev { left:8px; }
      .mwt-next { right:8px; }
      .mwt-bar { position:absolute; left:0; right:0; bottom:0; z-index:2; display:flex; align-items:center;
        gap:8px; padding:6px 10px 8px; background:linear-gradient(transparent, rgba(0,0,0,.8));
        opacity:0; transition:opacity .15s; font-family:sans-serif; }
      .mwt-btn { background:transparent; border:none; color:#fff; cursor:pointer; padding:2px 4px;
        font-size:15px; line-height:1; }
      .mwt-seek { position:relative; flex:1; height:10px; display:flex; align-items:center; cursor:pointer; }
      .mwt-seek-track { position:relative; width:100%; height:4px; background:rgba(255,255,255,.35); border-radius:2px; }
      .mwt-seek-fill { position:absolute; left:0; top:0; height:100%; width:0%; background:#f00; border-radius:2px; }
      .mwt-seek-thumb { position:absolute; top:50%; width:10px; height:10px; margin-left:-5px;
        background:#f00; border-radius:50%; transform:translateY(-50%); left:0%; }
    `;
    pipWindow.document.head.append(style);

    const wrap = pipWindow.document.createElement("div");
    wrap.id = "mwt-wrap";
    pipWindow.document.body.append(wrap);

    let current = startVideo;
    let unbindVideoEvents = null;

    function place(video) {
      video._mwtParent = video.parentNode;
      video._mwtNext = video.nextSibling;
      video._mwtControls = video.controls;
      video.controls = false;
      video.removeAttribute("controls");
      video.disablePictureInPicture = true;
      wrap.prepend(video);
    }

    function restore(video) {
      video.controls = video._mwtControls;
      video.disablePictureInPicture = false;
      if (video._mwtParent) {
        video._mwtParent.insertBefore(video, video._mwtNext);
      }
    }

    function bindVideoEvents(video) {
      const onPlayPause = () => {
        playBtn.textContent = video.paused ? "▶" : "⏸";
      };
      const onTimeUpdate = () => {
        if (video.duration) {
          const pct = (video.currentTime / video.duration) * 100;
          seekFill.style.width = pct + "%";
          seekThumb.style.left = pct + "%";
        }
      };
      video.addEventListener("play", onPlayPause);
      video.addEventListener("pause", onPlayPause);
      video.addEventListener("timeupdate", onTimeUpdate);
      onPlayPause();
      onTimeUpdate();
      return () => {
        video.removeEventListener("play", onPlayPause);
        video.removeEventListener("pause", onPlayPause);
        video.removeEventListener("timeupdate", onTimeUpdate);
      };
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

    const bar = pipWindow.document.createElement("div");
    bar.className = "mwt-bar";

    const playBtn = pipWindow.document.createElement("button");
    playBtn.className = "mwt-btn";
    playBtn.addEventListener("click", () => {
      if (current.paused) current.play().catch(() => {});
      else current.pause();
    });

    const back5Btn = pipWindow.document.createElement("button");
    back5Btn.className = "mwt-btn";
    back5Btn.textContent = "↺5";
    back5Btn.title = "Back 5s";
    back5Btn.addEventListener("click", () => {
      current.currentTime = Math.max(0, current.currentTime - 5);
    });

    const fwd5Btn = pipWindow.document.createElement("button");
    fwd5Btn.className = "mwt-btn";
    fwd5Btn.textContent = "5↻";
    fwd5Btn.title = "Forward 5s";
    fwd5Btn.addEventListener("click", () => {
      current.currentTime = Math.min(current.duration || Infinity, current.currentTime + 5);
    });

    const seek = pipWindow.document.createElement("div");
    seek.className = "mwt-seek";
    const seekTrack = pipWindow.document.createElement("div");
    seekTrack.className = "mwt-seek-track";
    const seekFill = pipWindow.document.createElement("div");
    seekFill.className = "mwt-seek-fill";
    const seekThumb = pipWindow.document.createElement("div");
    seekThumb.className = "mwt-seek-thumb";
    seekTrack.append(seekFill, seekThumb);
    seek.append(seekTrack);

    let seeking = false;
    function seekTo(clientX) {
      const rect = seek.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      if (current.duration) current.currentTime = ratio * current.duration;
    }
    seek.addEventListener("mousedown", (e) => {
      seeking = true;
      seekTo(e.clientX);
    });
    pipWindow.addEventListener("mousemove", (e) => {
      if (seeking) seekTo(e.clientX);
    });
    pipWindow.addEventListener("mouseup", () => {
      seeking = false;
    });

    bar.append(playBtn, back5Btn, seek, fwd5Btn);
    wrap.append(prevBtn, nextBtn, bar);

    unbindVideoEvents = bindVideoEvents(current);

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
          if (unbindVideoEvents) unbindVideoEvents();
          place(next);
          current = next;
          unbindVideoEvents = bindVideoEvents(current);
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
        if (unbindVideoEvents) unbindVideoEvents();
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
