// Runs in the page, in the src's isolated world.
//
// The whole reason this file exists: both PiP entry points demand transient
// user activation, and the activation Chrome grants to a command-triggered
// executeScript is fragile — other extensions on the page (ad blockers on
// YouTube in particular) can leave it unavailable, and then requestWindow()
// throws NotAllowedError and the float never opens. A real keydown handled
// here carries its own activation that nothing else can spend, so the hotkey
// works regardless of what else is installed.
//
// Chrome injects this file more than once per document in some navigation
// paths; without this guard we would stack duplicate key handlers and every
// press would toggle twice, cancelling itself out.
if (!window.__mwtInstalled) {
  window.__mwtInstalled = true;

  // While the float is up, the tab is still rendering the same video full size
  // right behind it — two copies of the same frame competing for attention. The
  // page copy gets blacked out so the float reads as the one to watch.
  //
  // Presentation only: a CSS filter on the page's element plus an opaque cover
  // over the player. captureStream() takes frames from the media pipeline,
  // before compositing, so the mirror in the float stays sharp, and the element
  // keeps decoding and playing audio exactly as before. Nothing here pauses,
  // hides or detaches anything — display:none would risk Chrome throttling the
  // very element the float is mirroring.
  const BLUR_CLASS = "mwt-blurred";
  const BLUR_STYLE_ID = "mwt-blur-style";
  const BLUR_NOTE_CLASS = "mwt-blur-note";

  function ensureBlurStyle() {
    if (document.getElementById(BLUR_STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = BLUR_STYLE_ID;
    style.textContent = `
      .${BLUR_CLASS} video {
        filter: brightness(0) !important;
        transition: filter .2s ease;
      }
      .${BLUR_NOTE_CLASS} {
        position:absolute; inset:0; z-index:59; display:flex;
        align-items:center; justify-content:center; pointer-events:none;
        background:#000;
        font-family:"YouTube Sans", Roboto, system-ui, sans-serif;
        font-size:15px; letter-spacing:.02em; color:rgba(255,255,255,.72);
      }
    `;
    (document.head || document.documentElement).append(style);
  }

  function playerHosts() {
    return [
      document.getElementById("movie_player"),
      document.getElementById("shorts-player"),
    ].filter(Boolean);
  }

  // Idempotent, and called again on every reconcile tick: YouTube rebuilds the
  // player host on navigation, and a rebuilt host comes back unblurred.
  function setPageBlur(on) {
    if (on) ensureBlurStyle();
    for (const host of playerHosts()) {
      host.classList.toggle(BLUR_CLASS, on);
      const note = host.querySelector(`:scope > .${BLUR_NOTE_CLASS}`);
      if (on && !note) {
        const el = document.createElement("div");
        el.className = BLUR_NOTE_CLASS;
        const label = document.createElement("span");
        label.textContent = "Playing in floating window";
        el.append(label);
        host.append(el);
      } else if (!on && note) {
        note.remove();
      }
    }
  }

  function togglePip() {
    if (window.documentPictureInPicture && window.documentPictureInPicture.window) {
      console.log("YouTube Floating PiP Toggle: closing existing float");
      // Marks this close as ours, so the watchdog does not mistake it for the
      // float being killed and bounce straight into native PiP.
      window.__mwtIntentionalClose = Date.now();
      setPageBlur(false);
      window.documentPictureInPicture.window.close();
      return;
    }
    if (document.pictureInPictureElement) {
      console.log("YouTube Floating PiP Toggle: exiting existing PiP");
      setPageBlur(false);
      document.exitPictureInPicture().catch(() => {});
      return;
    }
    console.log("YouTube Floating PiP Toggle: opening float");
  
    const MAX_EDGE = 480; // longest side of the floating window, in px
    const MIN_EDGE = 240;
    const SEEK_STEP = 5; // seconds for the skip buttons
    const RECONCILE_MS = 300; // how often we re-check which video to mirror
  
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
  
    // A float that dies this fast was not closed by the user.
    const EARLY_CLOSE_MS = 2500;

    // Transient user activation is spent by the first API that demands it, not
    // held for five seconds — requestWindow() consumes it outright. So once the
    // rich float has been opened there is no activation left to open the native
    // window instead, and failing over after the fact is impossible. The choice
    // has to be made before we spend it, which means remembering that the rich
    // float gets killed on this site and going straight to native next time.
    const HOSTILE_KEY = "__mwtDocPipHostile";
    // "auto" (default) picks the rich float and remembers if it gets killed.
    // "native" and "rich" pin one kind, which is how to make two profiles match
    // when only one of them can keep a rich float alive. Read synchronously —
    // the choice has to be made inside the keypress that carries the activation,
    // so chrome.storage is not an option here.
    const MODE_KEY = "__mwtPipMode";

    function pipMode() {
      try {
        const m = localStorage.getItem(MODE_KEY);
        return m === "native" || m === "rich" ? m : "auto";
      } catch (_) {
        return "auto";
      }
    }

    function docPipIsHostile() {
      if (window.__mwtDocPipHostile) return true;
      try {
        return localStorage.getItem(HOSTILE_KEY) === "1";
      } catch (_) {
        return false;
      }
    }

    function markDocPipHostile() {
      window.__mwtDocPipHostile = true;
      try {
        localStorage.setItem(HOSTILE_KEY, "1");
      } catch (_) {
        /* in-memory flag still covers this page */
      }
    }

    function clearDocPipHostile() {
      window.__mwtDocPipHostile = false;
      try {
        localStorage.removeItem(HOSTILE_KEY);
      } catch (_) {
        /* nothing to clear */
      }
    }

    // Native Picture-in-Picture: a browser-managed window with no document of
    // its own, so page scripts and other extensions have nothing to reach into
    // and close. It costs the custom control bar, but Chrome draws its own
    // play/pause and seek controls, and the Media Session handlers below put
    // next/previous in there too. This is the float that survives an ad blocker.
    function enterNativePip(video, reason) {
      console.warn(`YouTube Floating PiP Toggle: falling back to native PiP (${reason})`);
      try {
        video.disablePictureInPicture = false;
      } catch (_) {
        /* property is not always writable; the request below still works */
      }
      try {
        if (navigator.mediaSession) {
          navigator.mediaSession.setActionHandler("nexttrack", () =>
            clickFirstMatch([
              "#navigation-button-down button",
              'button[aria-label*="Next video" i]',
              ".ytp-next-button",
            ])
          );
          navigator.mediaSession.setActionHandler("previoustrack", () =>
            clickFirstMatch([
              "#navigation-button-up button",
              'button[aria-label*="Previous video" i]',
              ".ytp-prev-button",
            ])
          );
        }
      } catch (_) {
        /* Media Session controls are a bonus, not a requirement */
      }
      return video
        .requestPictureInPicture()
        .then(() => {
          console.log("YouTube Floating PiP Toggle: native PiP open");
          setPageBlur(true);
          // Chrome's own close button and the OS both bypass togglePip, so the
          // blur has to come off wherever PiP actually ends.
          video.addEventListener("leavepictureinpicture", () => setPageBlur(false), {
            once: true,
          });
        })
        .catch((err) => {
          console.error("YouTube Floating PiP Toggle: native PiP failed", err);
          setPageBlur(false);
        });
    }

    // Mirror the video into the float; never move the element.
    //
    // YouTube's <video> is MediaSource-backed through a blob: URL scoped to the
    // page's own document. Re-parenting that element into the PiP document
    // leaves the blob unresolvable — blob:...ERR_FILE_NOT_FOUND — so playback
    // dies, YouTube's player tears itself down, and the PiP window closes with
    // it within a frame or two. captureStream() gives a MediaStream that is
    // valid in any document, so the page keeps its own element intact and the
    // float renders a live copy of it.
    async function openDocumentPip(startVideo) {
      if (typeof startVideo.captureStream !== "function") {
        throw new Error("captureStream is unavailable, cannot mirror the video");
      }

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
          width:100%; height:100%; object-fit:contain; background:#000; display:block;
        }
        #mwt-bar {
          position:absolute; left:0; right:0; bottom:10px; display:flex; gap:2px;
          align-items:center; justify-content:center; padding:6px 4px;
          background:linear-gradient(to top, rgba(0,0,0,.75), rgba(0,0,0,0));
          opacity:0; transition:opacity .15s; font-family:system-ui, sans-serif;
        }
        /* Scrub strip. The hit area is taller than the visible line so the bar
           is grabbable in a small window; only the track inside it is drawn. */
        #mwt-progress {
          position:absolute; left:0; right:0; bottom:0; height:14px; z-index:3;
          display:flex; align-items:flex-end; cursor:pointer;
          touch-action:none; user-select:none;
        }
        #mwt-track {
          position:relative; width:100%; height:3px;
          background:rgba(255,255,255,.28); transition:height .1s;
        }
        #mwt-wrap:hover #mwt-track, #mwt-progress.scrubbing #mwt-track { height:6px; }
        #mwt-buffered, #mwt-played {
          position:absolute; left:0; top:0; bottom:0; width:0;
        }
        #mwt-buffered { background:rgba(255,255,255,.4); }
        #mwt-played { background:#f00; }
        #mwt-knob {
          position:absolute; top:50%; left:0; width:11px; height:11px;
          margin:-5.5px 0 0 -5.5px; border-radius:50%; background:#f00;
          opacity:0; transition:opacity .1s; pointer-events:none;
        }
        #mwt-wrap:hover #mwt-knob, #mwt-progress.scrubbing #mwt-knob { opacity:1; }
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

      const mirror = pipWindow.document.createElement("video");
      mirror.autoplay = true;
      mirror.playsInline = true;
      // Audio still comes from the tab's own element, which never stopped
      // playing. A second output here would just double it.
      mirror.muted = true;
      wrap.append(mirror);

      // The page's real element. Every control drives this, never the mirror:
      // seeking or pausing a MediaStream does nothing useful.
      let source = null;
      let sourceKey = null;
      let reconcileTimer = null;
      let lastAspect = "";
      let userResized = false;
      let tornDown = false;
      let watchdogTimer = null;
      const openedAt = Date.now();
      // Our own resizeTo() calls fire resize events too; ignore those so they
      // don't look like the user grabbing the window edge.
      let suppressResizeUntil = Date.now() + 1000;

      pipWindow.addEventListener("resize", () => {
        if (Date.now() > suppressResizeUntil) userResized = true;
      });

      // Which video the page is showing, independent of which element renders
      // it. YouTube rebuilds the element for its own reasons, and that is not
      // the same thing as the user moving to a different video.
      function pageVideoKey() {
        try {
          const url = new URL(location.href);
          return url.searchParams.get("v") || url.pathname;
        } catch (_) {
          return location.pathname;
        }
      }

      function syncPlayIcon() {
        if (!source) return;
        const label = source.paused ? "▶" : "⏸";
        if (playBtn.textContent !== label) playBtn.textContent = label;
      }

      function clockTime(seconds) {
        if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
        const total = Math.floor(seconds);
        const s = String(total % 60).padStart(2, "0");
        const m = Math.floor(total / 60) % 60;
        const h = Math.floor(total / 3600);
        return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
      }

      // Driven by timeupdate (roughly 4/s) and by the reconcile tick, so the
      // line keeps moving even when the page's element stops firing events —
      // which happens whenever YouTube swaps the element under us.
      function syncProgress() {
        if (!source) return;
        const duration = Number.isFinite(source.duration) ? source.duration : 0;
        if (duration <= 0) {
          played.style.width = "0%";
          buffered.style.width = "0%";
          knob.style.left = "0%";
          return;
        }
        const ratio = Math.min(1, Math.max(0, source.currentTime / duration));
        const pct = (ratio * 100).toFixed(3) + "%";
        played.style.width = pct;
        knob.style.left = pct;
        let ahead = 0;
        try {
          const ranges = source.buffered;
          for (let i = 0; i < ranges.length; i += 1) {
            if (ranges.start(i) <= source.currentTime && ranges.end(i) >= source.currentTime) {
              ahead = ranges.end(i);
              break;
            }
          }
        } catch (_) {
          /* buffered can throw on a detached element */
        }
        buffered.style.width =
          ((Math.min(1, Math.max(ratio, ahead / duration)) * 100).toFixed(3)) + "%";
        progress.title = `${clockTime(source.currentTime)} / ${clockTime(duration)}`;
      }

      function syncMediaUi() {
        syncPlayIcon();
        syncProgress();
      }

      function bindMediaEvents(video) {
        video.addEventListener("play", syncPlayIcon);
        video.addEventListener("pause", syncPlayIcon);
        video.addEventListener("timeupdate", syncProgress);
        video.addEventListener("durationchange", syncProgress);
        video.addEventListener("progress", syncProgress);
      }

      function unbindMediaEvents(video) {
        if (!video) return;
        video.removeEventListener("play", syncPlayIcon);
        video.removeEventListener("pause", syncPlayIcon);
        video.removeEventListener("timeupdate", syncProgress);
        video.removeEventListener("durationchange", syncProgress);
        video.removeEventListener("progress", syncProgress);
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

      function aspectKey(video) {
        if (!video.videoWidth || !video.videoHeight) return "";
        return (video.videoWidth / video.videoHeight).toFixed(3);
      }

      // sized: the window is already at this video's aspect ratio, so resizing
      // would be a no-op request. requestWindow() was given exactly the size
      // pipSize() computes, and resizeTo() is the only call here that acts on
      // the window itself — worth not making it at all rather than making it
      // redundantly a few milliseconds after the window is born.
      function attach(video, sized) {
        if (!video || video === source) return;
        if (source) unbindMediaEvents(source);
        source = video;
        sourceKey = pageVideoKey();
        try {
          mirror.srcObject = video.captureStream();
        } catch (err) {
          console.error("YouTube Floating PiP Toggle: captureStream failed", err);
          return;
        }
        mirror.play().catch(() => {});
        bindMediaEvents(video);
        console.log(`YouTube Floating PiP Toggle: mirroring ${sourceKey}`);
        lastAspect = sized ? aspectKey(video) : "";
        maybeResize(video);
        syncMediaUi();
        setPageBlur(true);
      }

      function streamIsDead() {
        const s = mirror.srcObject;
        if (!s) return true;
        const tracks = s.getVideoTracks();
        return !tracks.length || tracks.every((t) => t.readyState === "ended");
      }

      function teardown(why) {
        if (tornDown) return;
        tornDown = true;
        const lifetime = Date.now() - openedAt;
        console.log(
          `YouTube Floating PiP Toggle: float torn down after ${lifetime}ms (${why})`
        );
        if (reconcileTimer) window.clearInterval(reconcileTimer);
        if (watchdogTimer) window.clearInterval(watchdogTimer);
        unbindMediaEvents(source);
        const wasMirroring = source;
        mirror.srcObject = null;
        setPageBlur(false);

        const ourClose =
          window.__mwtIntentionalClose &&
          Date.now() - window.__mwtIntentionalClose < EARLY_CLOSE_MS;
        // A window this short-lived was taken from us. We cannot open the
        // native one now — requestWindow() already spent the activation — so
        // record it and let the next press go straight there with a fresh one.
        if (!ourClose && lifetime < EARLY_CLOSE_MS && wasMirroring) {
          markDocPipHostile();
          console.warn(
            "YouTube Floating PiP Toggle: the rich float was closed by something " +
              "on this page. Switching to native Picture-in-Picture — press the " +
              "hotkey again and it will open."
          );
        }
      }

      // Runs on the opener's timer, not the PiP window's: a timer owned by the
      // PiP document dies if that document is ever replaced, leaving nothing
      // running to notice.
      function reconcile() {
        let gone = false;
        try {
          gone = pipWindow.closed;
        } catch (_) {
          gone = true;
        }
        if (gone) {
          teardown("reconcile saw window closed");
          return;
        }

        const pageVideo = mainPlayerVideo();
        if (pageVideo && pageVideo !== source) {
          // Follow the page only onto a genuinely different video, or when the
          // element we were mirroring has gone away.
          if (!source || pageVideoKey() !== sourceKey || !source.isConnected) {
            attach(pageVideo);
            return;
          }
        }
        if (!source) return;
        // A track can end under us when YouTube swaps streams mid-playback.
        if (streamIsDead() && source.isConnected) {
          try {
            mirror.srcObject = source.captureStream();
            mirror.play().catch(() => {});
          } catch (_) {
            /* next tick will try again */
          }
        }
        maybeResize(source);
        syncMediaUi();
        setPageBlur(true);
      }

      const bar = pipWindow.document.createElement("div");
      bar.id = "mwt-bar";

      // Position line, always visible — the float otherwise gives no clue how
      // far into the video you are. Fills: buffered behind, played in front,
      // knob at the playhead.
      const progress = pipWindow.document.createElement("div");
      progress.id = "mwt-progress";
      const track = pipWindow.document.createElement("div");
      track.id = "mwt-track";
      const buffered = pipWindow.document.createElement("div");
      buffered.id = "mwt-buffered";
      const played = pipWindow.document.createElement("div");
      played.id = "mwt-played";
      const knob = pipWindow.document.createElement("div");
      knob.id = "mwt-knob";
      track.append(buffered, played, knob);
      progress.append(track);

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

      function seek(delta) {
        if (!source) return;
        const duration = Number.isFinite(source.duration) ? source.duration : Infinity;
        source.currentTime = Math.min(Math.max(0, source.currentTime + delta), duration);
      }

      function togglePlay() {
        if (!source) return;
        if (source.paused) source.play().catch(() => {});
        else source.pause();
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

        // Navigation is the one moment worth polling faster than the steady
        // reconcile interval, so the swap looks instant.
        let tries = 0;
        const burst = () => {
          tries += 1;
          reconcile();
          if (tries < 25) window.setTimeout(burst, 120);
        };
        window.setTimeout(burst, 80);
      }

      const prevBtn = button("⏮", "Previous video", () => nav("prev"));
      const backBtn = button("⏪", `Back ${SEEK_STEP}s`, () => seek(-SEEK_STEP));
      const playBtn = button("⏸", "Play / pause", togglePlay);
      const fwdBtn = button("⏩", `Forward ${SEEK_STEP}s`, () => seek(SEEK_STEP));
      const nextBtn = button("⏭", "Next video", () => nav("next"));

      bar.append(prevBtn, backBtn, playBtn, fwdBtn, nextBtn);
      wrap.append(bar);
      wrap.append(progress);

      // Scrubbing drives the page's element, like every other control here:
      // the mirror is a MediaStream and seeking one does nothing.
      function seekToClientX(clientX) {
        if (!source) return;
        const duration = Number.isFinite(source.duration) ? source.duration : 0;
        const rect = track.getBoundingClientRect();
        if (duration <= 0 || !rect.width) return;
        const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
        source.currentTime = ratio * duration;
        syncProgress();
      }

      let scrubbing = false;

      progress.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        scrubbing = true;
        progress.classList.add("scrubbing");
        // Capture so a drag that leaves the strip — easy in a 480px window —
        // keeps seeking instead of dying on the first pixel outside.
        try {
          progress.setPointerCapture(e.pointerId);
        } catch (_) {
          /* capture is a nicety; click-to-seek still works */
        }
        seekToClientX(e.clientX);
      });

      progress.addEventListener("pointermove", (e) => {
        if (scrubbing) seekToClientX(e.clientX);
      });

      function endScrub(e) {
        if (!scrubbing) return;
        scrubbing = false;
        progress.classList.remove("scrubbing");
        try {
          progress.releasePointerCapture(e.pointerId);
        } catch (_) {
          /* already released */
        }
      }

      progress.addEventListener("pointerup", endScrub);
      progress.addEventListener("pointercancel", endScrub);

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

      attach(startVideo, true);
      reconcileTimer = window.setInterval(reconcile, RECONCILE_MS);

      // Polls far faster than the reconcile interval on purpose: the float has
      // been dying around 15ms in, and every millisecond spent noticing is a
      // millisecond of user activation spent, which the fallback still needs.
      watchdogTimer = window.setInterval(() => {
        let gone = false;
        try {
          gone = pipWindow.closed;
        } catch (_) {
          gone = true;
        }
        if (gone) {
          teardown("watchdog saw window closed");
        } else if (Date.now() - openedAt > EARLY_CLOSE_MS) {
          // Survived the danger window; the steady reconcile loop takes over.
          // Whatever was killing floats here is not doing it any more, so let
          // the rich float be tried again on later presses.
          clearDocPipHostile();
          window.clearInterval(watchdogTimer);
          watchdogTimer = null;
        }
      }, 25);

      pipWindow.addEventListener("pagehide", () => {
        const age = Date.now() - openedAt;
        console.log(`YouTube Floating PiP Toggle: pagehide at ${age}ms`);
        // Confirm on the next turn of the opener's loop: pipWindow.closed is
        // not reliable while the event is still being dispatched.
        window.setTimeout(() => {
          let closed = true;
          try {
            closed = pipWindow.closed;
          } catch (_) {
            closed = true;
          }
          if (closed) teardown("pagehide, window closed");
        }, 0);
      });

      // Nothing in this file closes the window after it is built, so if it dies
      // anyway the caller is outside our world. An isolated-world override is
      // invisible to page scripts, but it still catches anything on our side.
      try {
        const nativeClose = pipWindow.close.bind(pipWindow);
        pipWindow.close = function patchedClose() {
          console.log(
            "YouTube Floating PiP Toggle: close() called on the float\n" +
              new Error("close() call site").stack
          );
          return nativeClose();
        };
      } catch (_) {
        /* diagnostic only */
      }
    }
  
    // Same preview filtering the reconcile loop uses. Picking a hover-preview or
    // miniplayer video here would make the very first reconcile tick swap it out
    // for the real one, which reads as the float glitching on open.
    const video =
      mainPlayerVideo() ||
      document.querySelector("video.html5-main-video") ||
      Array.from(document.querySelectorAll("video")).find((v) => !isPreview(v)) ||
      null;
  
    if (!video) {
      console.warn("YouTube Floating PiP Toggle: no usable video element on this page");
      return;
    }
  
    console.log(
      `YouTube Floating PiP Toggle: video readyState=${video.readyState} ` +
        `dur=${video.duration} ${video.videoWidth}x${video.videoHeight} ` +
        `cls="${video.className}" docPiP=${!!window.documentPictureInPicture}`
    );

    // Deliberately synchronous, even when metadata has not landed yet. User
    // activation is transient: waiting for loadedmetadata would put the request
    // in a later task with the activation already expired, so the call would be
    // refused. An unsized window is recoverable — pipSize() falls back to 16:9
    // and the reconcile loop resizes once the real aspect ratio shows up — but
    // a window we were not allowed to open is not.
    const mode = pipMode();
    if (mode === "native") {
      enterNativePip(video, "pinned to native by preference");
    } else if (!window.documentPictureInPicture) {
      enterNativePip(video, "documentPictureInPicture unavailable");
    } else if (mode !== "rich" && docPipIsHostile()) {
      // Spend the activation on the window that actually survives here.
      enterNativePip(video, "rich float gets closed on this page");
    } else {
      openDocumentPip(video)
        .then(() => console.log("YouTube Floating PiP Toggle: float open"))
        .catch((err) => {
          console.error("YouTube Floating PiP Toggle: documentPictureInPicture failed", err);
          markDocPipHostile();
        });
    }
  }

  // Let the worker reach the same logic via executeScript. That injection path
  // carries Chrome's src gesture, which is what makes the toolbar icon
  // and the not-focused hotkey work without a keydown of their own.
  window.__mwtToggle = togglePip;

  // Reloading the src orphans the copy of this script already running in
  // an open tab: it keeps handling keys, but its chrome.* handles are dead and
  // touching them throws "Extension context invalidated". Unguarded that threw
  // out of the key handler before it reached togglePip, so the float silently
  // stopped opening until the tab was reloaded. An orphan should still be able
  // to open a float — it just cannot talk to the worker.
  function liveRuntime() {
    try {
      return chrome.runtime && chrome.runtime.id ? chrome.runtime : null;
    } catch (_) {
      return null;
    }
  }

  // Two different keys, on purpose.
  //
  // Chrome swallows a bound command accelerator while it has focus — it never
  // reaches the page — so the global shortcut can only ever arrive through the
  // worker, on the src gesture that ad blockers can leave unavailable.
  // This in-page shortcut is a plain keystroke Chrome does not intercept, so it
  // reaches us as a real keydown with activation of its own and opens the float
  // no matter what else is installed. It only works while the YouTube tab has
  // focus, which is exactly the case the global one does not need to cover.
  // Must stay different from the command accelerator below: Chrome consumes a
  // bound command shortcut before the page sees it, so binding both to the same
  // combo would leave the in-page path with no keydown to ride.
  const DEFAULT_PAGE_COMBO = "Ctrl+I";
  let pageCombo = DEFAULT_PAGE_COMBO;
  // Mirrored from chrome.commands by the worker. Matched too, in case a build
  // of Chrome does forward it, but it is normally consumed before we see it.
  let commandCombo = null;

  // Guarded: an orphaned instance keeps DEFAULT_PAGE_COMBO and still works.
  try {
    if (liveRuntime()) {
      chrome.storage.local.get(["toggleCombo", "pageCombo"]).then(
        (v) => {
          commandCombo = (v && v.toggleCombo) || null;
          pageCombo = (v && v.pageCombo) || DEFAULT_PAGE_COMBO;
        },
        () => {}
      );

      chrome.storage.local.onChanged.addListener((changes) => {
        if (changes.toggleCombo) commandCombo = changes.toggleCombo.newValue || null;
        if (changes.pageCombo) pageCombo = changes.pageCombo.newValue || DEFAULT_PAGE_COMBO;
      });
    }
  } catch (_) {
    /* orphaned instance; defaults are good enough to keep the hotkey alive */
  }

  // Match on e.code, not e.key: with Shift held, "9" arrives as "(" on a US
  // layout, and e.key varies by layout anyway.
  function codeFor(key) {
    if (/^[0-9]$/.test(key)) return "Digit" + key;
    if (/^[A-Za-z]$/.test(key)) return "Key" + key.toUpperCase();
    const named = {
      Up: "ArrowUp",
      Down: "ArrowDown",
      Left: "ArrowLeft",
      Right: "ArrowRight",
    };
    return named[key] || key;
  }

  function matches(e, combo) {
    if (!combo) return false;
    const parts = combo.split("+").map((s) => s.trim());
    const key = parts.pop();
    if (e.ctrlKey !== (parts.includes("Ctrl") || parts.includes("MacCtrl"))) return false;
    if (e.altKey !== parts.includes("Alt")) return false;
    if (e.shiftKey !== parts.includes("Shift")) return false;
    if (e.metaKey !== parts.includes("Command")) return false;
    return e.code === codeFor(key);
  }

  // Typing in the search box or a comment must not toggle the float.
  function isTyping(el) {
    if (!el) return false;
    if (el.isContentEditable) return true;
    const tag = el.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
  }

  // Capture phase, because YouTube installs its own document-level key handlers
  // and stops propagation for plenty of combinations.
  window.addEventListener(
    "keydown",
    (e) => {
      if (e.repeat || isTyping(e.target)) return;
      if (!matches(e, pageCombo) && !matches(e, commandCombo)) return;
      console.log(`YouTube Floating PiP Toggle: hotkey matched (${e.code})`);
      e.preventDefault();
      e.stopPropagation();
      // Opening the float is the job; telling the worker is bookkeeping, so it
      // goes second and never gets to abort the toggle.
      togglePip();
      // Tell the worker this press is already handled, so the global command
      // firing for the same keystroke does not toggle straight back off.
      try {
        const rt = liveRuntime();
        if (rt) rt.sendMessage({ type: "handled" }).catch(() => {});
      } catch (_) {
        /* worker unreachable; the float is already open either way */
      }
    },
    true
  );

  // Fallback path: the worker drives us when Chrome is not the focused app, so
  // there is no keydown here to ride. Activation may be missing in that case —
  // togglePip logs it if the request is refused.
  try {
    if (liveRuntime()) {
      chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
        if (msg && msg.type === "toggle") {
          togglePip();
          sendResponse({ ok: true });
        }
        return false;
      });
    }
  } catch (_) {
    /* orphaned instance; the worker will inject a fresh copy when it needs one */
  }

  // Bump on every change. Stale content scripts survive an src reload in
  // already-open tabs and are indistinguishable from fresh ones in the console,
  // which has burned several rounds of debugging — this makes it obvious.
  console.log(
    "YouTube Floating PiP Toggle: content script ready [build 16 — blackout + scrub bar]"
  );
}
