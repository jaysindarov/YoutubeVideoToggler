# YouTube Floating PiP Toggle

Global hotkey pop YouTube video into real OS-level floating window (Picture-in-Picture).
Unlike YouTube's built-in `i` miniplayer, this float stay on top of every app/window, and hotkey work even when Chrome not focused.

## Install (unpacked)

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked**, pick this `extension` folder
4. Go `chrome://extensions/shortcuts`
5. Find "YouTube Floating PiP Toggle" → set shortcut (default `Alt+P`)
6. Check box **Global** next to it — this make hotkey work outside Chrome too

## Use

Play any YouTube video, press hotkey anywhere (even other app focused) → video pop into floating window on top of everything. Press again → close float, back to tab.

Float window size follow real video aspect ratio (longest side 480px), so whole frame visible — no crop.
Resize float window by hand any time (width and height both free). After manual resize, extension stop auto-sizing that window — your size stick even across video switches.

### Controls (hover float window to reveal bar)

| Button | Key | Action |
| --- | --- | --- |
| ⏮ | `p` | Previous video |
| ⏪ | `←` | Back 5s (`j` = 10s) |
| ⏸ / ▶ | `space` or `k` | Pause / resume |
| ⏩ | `→` | Forward 5s (`l` = 10s) |
| ⏭ | `n` | Next video |

Next/prev drive YouTube's own player API, so float keep showing correct video after switch even when YouTube reuse same `<video>` element.

## Note

- Global shortcuts on Mac may need Chrome added under System Settings → Privacy & Security → Accessibility, if OS block it.
- If multiple YouTube tabs open, extension pick one already floating (to close it), else one playing audio, else first found.
