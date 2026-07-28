# YouTube Floating PiP Toggle

Global hotkey pop YouTube video into real OS-level floating window (Picture-in-Picture).
Unlike YouTube's built-in `i` miniplayer, this float stay on top of every app/window, and hotkey work even when Chrome not focused.

## Install (unpacked)

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked**, pick this `extension` folder
4. Go `chrome://extensions/shortcuts`
5. Find "YouTube Floating PiP Toggle" → set shortcut (default `Ctrl+Shift+9`)
6. Set dropdown to **Global** — this make hotkey work outside Chrome too

Shortcut box may be empty on fresh install if suggested key already taken. Bind own key there. Toolbar icon also toggle float, so extension work even with no shortcut bound.

Windows/Linux: Chrome only accept `Ctrl+Shift+[0..9]` as **suggested** global key in manifest — that why default is `Ctrl+Shift+9`. In `chrome://extensions/shortcuts` UI you can pick other combos by hand.

## Use

Two shortcuts, for two different situations:

| Shortcut | Works when | Notes |
| --- | --- | --- |
| `Ctrl+Shift+9` (global) | Any app focused, even outside Chrome | Configurable at `chrome://extensions/shortcuts` |
| `Ctrl+I` (in-page) | YouTube tab focused | Always works, even with an ad blocker on |

Play any YouTube video, press either → video pop into floating window on top of everything. Press again → close float, back to tab.
No YouTube tab focused? Extension find one: audible tab first, else active tab, else most recent YouTube tab.

While the float is open, the player in the tab go fully black, with a "Playing in floating window" label over it — so the two copies of the same frame don't fight for attention. Presentation only: a `brightness(0)` filter on the page's element plus an opaque cover. `captureStream()` take frames before compositing, so the float stay sharp, and playback/audio is untouched. Blackout clear when the float close, however it close.

**Why two?** Both PiP APIs refuse to open a window without *user activation*. A real keypress in the page carries its own activation, so `Ctrl+I` always work. The global shortcut can't — Chrome is not even focused — so it rely on the activation Chrome grant to the extension, and some other extensions (ad blockers on YouTube especially) leave that unavailable. If the global key do nothing while an ad blocker is on, use `Ctrl+I`, or allowlist YouTube in the ad blocker.

Chrome swallow a bound command shortcut when it has focus, so `Ctrl+Shift+9` never reach the page — that why the in-page key is a separate combo and not the same one. Don't bind the global command to `Ctrl+I` for the same reason: Chrome would eat the key before the page handler ever see it.

### Two kinds of float

The extension try the rich float first (Document Picture-in-Picture: own window, own control bar). Some setups kill that window a few milliseconds after it open — ad blockers on YouTube are the common case. The extension notice within ~25ms, remember it, and from then on go straight to **native Picture-in-Picture**: a browser-drawn window with no document of its own, so nothing on the page can reach in and close it. You lose the custom control bar, but Chrome draw its own play/pause and seek, and next/previous is wired through the Media Session API.

**The very first press on such a page do nothing visible** — the rich float open and get killed, and that press is spent. Press again and the native window open. After that it go straight to native every time, remembered per site across reloads.

Why not fail over instantly instead? Because the browser spend your keypress ("transient user activation") on the *first* PiP call. Once `requestWindow()` consume it there is none left to open a second window, so the choice have to be made before the press is spent — which mean learning it from the press before.

If the rich float ever survive again (blocker turned off, site changed), the extension notice and go back to using it.

### Making profiles match

Two Chrome profiles can end up with different-looking floats — one native, one rich — because only one of them can keep a rich float alive. Telling them apart: a rich float have a `youtube.com` title bar and the tab keep playing normally; native PiP have no title bar and the tab show "Playing in picture-in-picture".

To pin one kind, run this in the console on youtube.com in the profile you want to change:

```js
localStorage.setItem("__mwtPipMode", "native"); // always native PiP
localStorage.setItem("__mwtPipMode", "rich");   // always the rich float
localStorage.removeItem("__mwtPipMode");        // back to automatic
```

`native` is the only setting that look the same in every profile, since the rich float genuinely cannot survive where something is closing it.

Float show a live mirror of the video, not the video element itself. The tab keep playing normally and audio still come from the tab. This is deliberate: YouTube video is MediaSource-backed through a `blob:` URL tied to the page document, so moving the element into the float make the stream unresolvable and kill both the playback and the float window.

Float window size follow real video aspect ratio (longest side 480px), so whole frame visible — no crop.
Resize float window by hand any time (width and height both free). After manual resize, extension stop auto-sizing that window — your size stick even across video switches.

### Progress line

Thin red position line sit at the bottom of the float, always visible — same idea as any player. Hover the float: line get thicker and a knob appear at the playhead. Click anywhere on it to jump there, or drag the knob to scrub. Grey-white fill behind the red one is buffered ahead. Hover show `current / total` as a tooltip.

Seeking drive the page's own video element, not the mirror — a MediaStream have nothing to seek.

### Controls (hover float window to reveal bar)

| Button | Key | Action |
| --- | --- | --- |
| ⏮ | `p` | Previous video |
| ⏪ | `←` | Back 5s (`j` = 10s) |
| ⏸ / ▶ | `space` or `k` | Pause / resume |
| ⏩ | `→` | Forward 5s (`l` = 10s) |
| ⏭ | `n` | Next video |

Next/prev click YouTube's own player buttons. The float run in the extension isolated world (needed so the PiP request keep its user activation), which can't reach the page's player object, so button clicking is the path used.

## Note

- Global shortcuts on Mac may need Chrome added under System Settings → Privacy & Security → Accessibility, if OS block it.
- If multiple YouTube tabs open, extension pick one already floating (to close it), else one playing audio, else first found.
- Needs Chrome 116+ for Document Picture-in-Picture, 111+ for MAIN-world injection. Older Chrome fall back to plain video PiP (no custom controls).
- Shortcut not firing? Check `chrome://extensions/shortcuts` — empty box means unbound. Errors log to service worker console (`chrome://extensions` → **service worker** link).
