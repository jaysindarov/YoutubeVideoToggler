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

## Note

- Global shortcuts on Mac may need Chrome added under System Settings → Privacy & Security → Accessibility, if OS block it.
- If multiple YouTube tabs open, extension pick one already floating (to close it), else one playing audio, else first found.
