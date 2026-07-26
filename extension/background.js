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
        .executeScript({ target: { tabId: tab.id }, world: "MAIN", func: isInPip })
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
    // MAIN world so we can drive YouTube's own player API (nextVideo /
    // previousVideo), which survives SPA navigation far better than clicking
    // player buttons that may not be rendered.
    world: "MAIN",
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

  const MAX_EDGE = 480; // longest side of the floating window, in px
  const MIN_EDGE = 240;
  const SEEK_STEP = 5; // seconds for the skip buttons
  const RECONCILE_MS = 300; // how often we re-check who owns the real video
  const MAX_REGRABS = 8; // per navigation, not per session

  // Hover previews, the built-in miniplayer and ad preview players are all real
  // <video> elements — never hijack those.
  const PREVIEW_HOSTS =
    "#inline-preview-player, ytd-video-preview, ytd-miniplayer, #miniplayer, ytd-reel-video-renderer[hidden]";

  function isPreview(el) {
    return !!(el && el.closest && el.closest(PREVIEW_HOSTS));
  }

  function visibleArea(el) {
    const r = el.getBoundingClientRect();
    const h = Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0);
    const w = Math.min(r.right, window.innerWidth) - Math.max(r.left, 0);
    return Math.max(0, h) * Math.max(0, w);
  }

  // The video the page itself currently considers "the" player video. Once we
  // move a video into the PiP window it lives in another document, so it can
  // never match here — a hit therefore means YouTube stood up a replacement.
  function mainPlayerVideo() {
    const hosts = [
      document.getElementById("movie_player"),
      document.getElementById("shorts-player"),
    ].filter((h) => h && !isPreview(h));

    for (const host of hosts) {
      const v = host.querySelector("video");
      if (v && v.readyState >= 1 && v.duration > 0) return v;
    }
    // A player host exists but holds no video: that is the healthy state while
    // we own the element. Do not fall through, or a sidebar hover preview gets
    // hijacked instead.
    if (hosts.length) return null;

    const videos = Array.from(document.querySelectorAll("video")).filter(
      (v) => v.readyState >= 1 && v.duration > 0 && !isPreview(v)
    );
    if (!videos.length) return null;
    const playing = videos.filter((v) => !v.paused);
    const pool = playing.length ? playing : videos;
    return pool.reduce((best, v) => (visibleArea(v) > visibleArea(best) ? v : best), pool[0]);
  }

  function ytPlayer() {
    const candidates = [
      document.getElementById("movie_player"),
      document.getElementById("shorts-player"),
      document.querySelector("#movie_player, .html5-video-player"),
    ];
    return candidates.find((p) => p && typeof p.nextVideo === "function") || null;
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

  function pipSize(video) {
    const vw = video.videoWidth || 16;
    const vh = video.videoHeight || 9;
    const aspect = vw / vh;
    let width;
    let height;
    if (aspect >= 1) {
      width = MAX_EDGE;
      height = Math.round(MAX_EDGE / aspect);
    } else {
      height = MAX_EDGE;
      width = Math.round(MAX_EDGE * aspect);
    }
    const maxW = Math.round((window.screen.availWidth || 1280) * 0.9);
    const maxH = Math.round((window.screen.availHeight || 800) * 0.9);
    if (width > maxW) {
      width = maxW;
      height = Math.round(width / aspect);
    }
    if (height > maxH) {
      height = maxH;
      width = Math.round(height * aspect);
    }
    if (width < MIN_EDGE) {
      width = MIN_EDGE;
      height = Math.round(width / aspect);
    }
    return { width, height };
  }

  async function openDocumentPip(startVideo) {
    const size = pipSize(startVideo);

    const pipWindow = await window.documentPictureInPicture.requestWindow({
      width: size.width,
      height: size.height,
    });

    const style = pipWindow.document.createElement("style");
    style.textContent = `
      html, body { margin:0; padding:0; background:#000; height:100%; overflow:hidden; }
      #mwt-wrap { position:relative; width:100%; height:100%; background:#000; }
      #mwt-wrap video {
        position:static !important; width:100% !important; height:100% !important;
        left:0 !important; top:0 !important; max-width:none !important;
        object-fit:contain !important; background:#000; display:block;
      }
      #mwt-bar {
        position:absolute; left:0; right:0; bottom:0; display:flex; gap:2px;
        align-items:center; justify-content:center; padding:6px 4px;
        background:linear-gradient(to top, rgba(0,0,0,.75), rgba(0,0,0,0));
        opacity:0; transition:opacity .15s; font-family:system-ui, sans-serif;
      }
      #mwt-wrap:hover #mwt-bar, #mwt-bar:focus-within { opacity:1; }
      #mwt-bar button {
        border:none; background:transparent; color:#fff; cursor:pointer;
        font-size:14px; line-height:1; padding:6px 8px; border-radius:4px;
        min-width:32px;
      }
      #mwt-bar button:hover { background:rgba(255,255,255,.18); }
    `;
    pipWindow.document.head.append(style);

    const wrap = pipWindow.document.createElement("div");
    wrap.id = "mwt-wrap";
    pipWindow.document.body.append(wrap);

    let current = null;
    let regrabs = 0;
    let styleObserver = null;
    let lastAspect = "";
    let reconcileTimer = null;
    let userResized = false;
    // Our own resizeTo() calls fire resize events too; ignore those so they
    // don't look like the user grabbing the window edge.
    let suppressResizeUntil = Date.now() + 1000;

    pipWindow.addEventListener("resize", () => {
      if (Date.now() > suppressResizeUntil) userResized = true;
    });

    // YouTube writes pixel width/height straight onto the element's inline
    // style, which outranks our stylesheet. Force our own values (and re-force
    // them whenever the page overwrites them).
    function neutralizeStyle(video) {
      video.style.setProperty("position", "static", "important");
      video.style.setProperty("width", "100%", "important");
      video.style.setProperty("height", "100%", "important");
      video.style.setProperty("left", "0px", "important");
      video.style.setProperty("top", "0px", "important");
      video.style.setProperty("max-width", "none", "important");
      video.style.setProperty("object-fit", "contain", "important");
    }

    function watchStyle(video) {
      if (styleObserver) styleObserver.disconnect();
      styleObserver = new MutationObserver(() => {
        if (!wrap.contains(video)) return;
        if (video.style.getPropertyValue("width") !== "100%") neutralizeStyle(video);
      });
      styleObserver.observe(video, { attributes: true, attributeFilter: ["style"] });
    }

    function place(video) {
      video._mwtParent = video.parentNode;
      video._mwtNext = video.nextSibling;
      if (video._mwtStyle === undefined) video._mwtStyle = video.getAttribute("style");
      wrap.prepend(video);
      neutralizeStyle(video);
      watchStyle(video);
    }

    function clearBookkeeping(video) {
      delete video._mwtStyle;
      delete video._mwtParent;
      delete video._mwtNext;
    }

    function restore(video) {
      if (!video) return;
      const parent =
        video._mwtParent && video._mwtParent.isConnected
          ? video._mwtParent
          : document.querySelector("#movie_player .html5-video-container") ||
            document.getElementById("movie_player");
      if (parent) {
        const next = video._mwtNext && video._mwtNext.parentNode === parent ? video._mwtNext : null;
        parent.insertBefore(video, next);
      }
      if (video._mwtStyle === null) video.removeAttribute("style");
      else if (video._mwtStyle !== undefined) video.setAttribute("style", video._mwtStyle);
      clearBookkeeping(video);
    }

    // The page already owns a fresh video element, so the one we are holding is
    // dead weight. Putting it back would inject a stale duplicate (and possibly
    // duplicate audio) into the live player — drop it instead.
    function discard(video) {
      if (!video) return;
      try {
        video.pause();
      } catch (_) {
        /* stale element, nothing to pause */
      }
      video.remove();
      clearBookkeeping(video);
    }

    function bindMediaEvents(video) {
      video.addEventListener("play", syncPlayIcon);
      video.addEventListener("pause", syncPlayIcon);
    }

    function unbindMediaEvents(video) {
      if (!video) return;
      video.removeEventListener("play", syncPlayIcon);
      video.removeEventListener("pause", syncPlayIcon);
    }

    function maybeResize(video) {
      if (!video.videoWidth || !video.videoHeight) return;
      // Key on aspect ratio, not resolution: YouTube swaps stream resolution
      // whenever the rendered box changes size, so a resolution key would make
      // us resize the window in response to the user resizing the window.
      const aspect = (video.videoWidth / video.videoHeight).toFixed(3);
      if (aspect === lastAspect) return;
      lastAspect = aspect;
      // Once the user has sized the window themselves, that wins forever.
      if (userResized) return;
      const next = pipSize(video);
      suppressResizeUntil = Date.now() + 600;
      try {
        pipWindow.resizeTo(next.width, next.height);
      } catch (_) {
        /* PiP window resize is best-effort */
      }
    }

    // dropPrevious: true when the page replaced the element under us.
    function adopt(video, dropPrevious, autoplay) {
      if (video === current) {
        if (video.style.getPropertyValue("width") !== "100%") neutralizeStyle(video);
        maybeResize(video);
        syncPlayIcon();
        return;
      }
      const previous = current;
      current = video;
      if (previous) {
        unbindMediaEvents(previous);
        if (styleObserver) {
          styleObserver.disconnect();
          styleObserver = null;
        }
        if (dropPrevious) discard(previous);
        else restore(previous);
      }
      place(video);
      bindMediaEvents(video);
      regrabs = 0;
      maybeResize(video);
      syncPlayIcon();
      if (autoplay) video.play().catch(() => {});
    }

    // Single source of truth, run on a timer instead of only right after a
    // navigation: YouTube can swap the video element at any point during SPA
    // navigation, and a brand-new element never touches our wrap, so no
    // MutationObserver on the wrap can see it.
    function reconcile() {
      const pageVideo = mainPlayerVideo();
      if (pageVideo && pageVideo !== current) {
        adopt(pageVideo, true, true);
        return;
      }
      if (!current) return;
      if (!wrap.contains(current)) {
        // The page re-parented our element back into itself — take it back.
        if (current.isConnected && regrabs < MAX_REGRABS) {
          regrabs += 1;
          place(current);
        }
        return;
      }
      if (current.style.getPropertyValue("width") !== "100%") neutralizeStyle(current);
      maybeResize(current);
      syncPlayIcon();
    }

    const bar = pipWindow.document.createElement("div");
    bar.id = "mwt-bar";

    function button(label, title, onClick) {
      const b = pipWindow.document.createElement("button");
      b.textContent = label;
      b.title = title;
      b.addEventListener("click", (e) => {
        e.preventDefault();
        onClick();
      });
      return b;
    }

    const prevBtn = button("⏮", "Previous video", () => nav("prev"));
    const backBtn = button("⏪", `Back ${SEEK_STEP}s`, () => seek(-SEEK_STEP));
    const playBtn = button("⏸", "Play / pause", togglePlay);
    const fwdBtn = button("⏩", `Forward ${SEEK_STEP}s`, () => seek(SEEK_STEP));
    const nextBtn = button("⏭", "Next video", () => nav("next"));

    bar.append(prevBtn, backBtn, playBtn, fwdBtn, nextBtn);
    wrap.append(bar);

    function syncPlayIcon() {
      if (!current) return;
      const label = current.paused ? "▶" : "⏸";
      if (playBtn.textContent !== label) playBtn.textContent = label;
    }

    function seek(delta) {
      if (!current) return;
      const duration = Number.isFinite(current.duration) ? current.duration : Infinity;
      current.currentTime = Math.min(Math.max(0, current.currentTime + delta), duration);
    }

    function togglePlay() {
      if (!current) return;
      if (current.paused) current.play().catch(() => {});
      else current.pause();
    }

    function nav(direction) {
      const player = ytPlayer();
      let moved = false;
      if (player) {
        try {
          if (direction === "next") player.nextVideo();
          else player.previousVideo();
          moved = true;
        } catch (_) {
          moved = false;
        }
      }
      if (!moved) {
        moved =
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
      }
      if (!moved) return;

      regrabs = 0;
      // Navigation is the one moment worth polling faster than the steady
      // reconcile interval, so the swap looks instant.
      let tries = 0;
      const burst = () => {
        tries += 1;
        reconcile();
        if (tries < 25) setTimeout(burst, 120);
      };
      setTimeout(burst, 80);
    }

    // Cheap early signal for the common case (page pulls the element out of the
    // wrap); the interval covers everything else.
    const wrapObserver = new MutationObserver(() => reconcile());
    wrapObserver.observe(wrap, { childList: true });

    pipWindow.document.addEventListener("keydown", (e) => {
      switch (e.key) {
        case " ":
        case "k":
          e.preventDefault();
          togglePlay();
          break;
        case "ArrowLeft":
          e.preventDefault();
          seek(-SEEK_STEP);
          break;
        case "ArrowRight":
          e.preventDefault();
          seek(SEEK_STEP);
          break;
        case "j":
          e.preventDefault();
          seek(-10);
          break;
        case "l":
          e.preventDefault();
          seek(10);
          break;
        case "n":
          e.preventDefault();
          nav("next");
          break;
        case "p":
          e.preventDefault();
          nav("prev");
          break;
        default:
          break;
      }
    });

    adopt(startVideo, false, false);
    reconcileTimer = pipWindow.setInterval(reconcile, RECONCILE_MS);

    pipWindow.addEventListener(
      "pagehide",
      () => {
        if (reconcileTimer) pipWindow.clearInterval(reconcileTimer);
        wrapObserver.disconnect();
        if (styleObserver) styleObserver.disconnect();
        unbindMediaEvents(current);
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
