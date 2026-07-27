const YOUTUBE_MATCH = "*://*.youtube.com/*";
const YOUTUBE_HOST = /(^|\.)youtube\.com$/;

function isYouTubeTab(tab) {
  if (!tab || !tab.url) return false;
  try {
    return YOUTUBE_HOST.test(new URL(tab.url).hostname);
  } catch (_) {
    return false;
  }
}

// The toggle itself lives in content.js so a real keydown can drive it. This
// worker only decides which tab should act, and gets out of the way when the
// content script is already handling the press.

async function pickTab(preferredTab) {
  if (isYouTubeTab(preferredTab)) return preferredTab;

  const tabs = await chrome.tabs.query({ url: YOUTUBE_MATCH });
  if (!tabs.length) return null;

  // Metadata only, deliberately. Probing each tab with executeScript to find
  // one already in PiP spends the command's transient user activation before
  // the toggle ever runs, and both requestWindow() and requestPictureInPicture()
  // hard-refuse without activation. The toggle already closes an open float on
  // its own, so the probe cost us the feature and bought nothing.
  return (
    tabs.find((t) => t.active && t.audible) ||
    tabs.find((t) => t.audible) ||
    tabs.find((t) => t.active) ||
    tabs.slice().sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0]
  );
}

// Runs in the isolated world, where content.js has already defined the toggle.
// Calling through executeScript (rather than sendMessage) keeps us on the path
// that carries Chrome's extension gesture.
function invokeToggle() {
  if (window.__mwtToggle) {
    window.__mwtToggle();
    return true;
  }
  return false;
}

async function runToggle(preferredTab) {
  const target = await pickTab(preferredTab);
  if (!target) {
    console.warn("YouTube Floating PiP Toggle: no YouTube tab open");
    return;
  }
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: target.id },
      func: invokeToggle,
    });
    // Tabs that were already open when the extension was installed or reloaded
    // never got the declared content script, so put it there and retry once.
    if (res && res.result === false) {
      await chrome.scripting.executeScript({
        target: { tabId: target.id },
        files: ["content.js"],
      });
      await chrome.scripting.executeScript({
        target: { tabId: target.id },
        func: invokeToggle,
      });
    }
  } catch (err) {
    console.error("YouTube Floating PiP Toggle: injection failed", err);
  }
}

// Mirror the live shortcut into storage so the content script can match the
// same keystroke. The user can rebind it at chrome://extensions/shortcuts and
// content scripts cannot read chrome.commands themselves.
async function publishCombo() {
  try {
    const cmds = await chrome.commands.getAll();
    const combo = cmds.find((c) => c.name === "toggle-pip")?.shortcut || "";
    await chrome.storage.local.set({ toggleCombo: combo });
    console.log(`YouTube Floating PiP Toggle: shortcut is ${combo || "(unbound)"}`);
  } catch (err) {
    console.error("YouTube Floating PiP Toggle: could not read shortcut", err);
  }
}

chrome.runtime.onInstalled.addListener(publishCombo);
chrome.runtime.onStartup.addListener(publishCombo);
publishCombo();

// A press the content script already served. The global command fires for the
// same keystroke, and acting on it too would close the float we just opened.
let handledAt = 0;

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "handled") {
    handledAt = Date.now();
    sendResponse({ ok: true });
  }
  return false;
});

// A single press can also reach onCommand twice on Windows, where a global
// accelerator is registered with the OS as well as the browser; the second
// dispatch would toggle the float straight back off. Held keys repeat through
// the same path.
const TOGGLE_DEBOUNCE_MS = 700;
let lastToggleAt = 0;

async function requestToggle(source, tab) {
  const now = Date.now();
  if (now - lastToggleAt < TOGGLE_DEBOUNCE_MS) {
    console.log(`YouTube Floating PiP Toggle: ignored duplicate ${source} trigger`);
    return;
  }

  if (source === "hotkey") {
    if (now - handledAt < TOGGLE_DEBOUNCE_MS) {
      console.log("YouTube Floating PiP Toggle: content script already served this press");
      return;
    }
    // When Chrome owns the keyboard and a YouTube tab is in front, that tab got
    // a real keydown and its own activation with it. Let it win — this path
    // depends on Chrome's extension gesture, which other extensions on the page
    // can leave unavailable.
    if (await youTubeTabIsFrontmost()) {
      console.log("YouTube Floating PiP Toggle: leaving this press to the focused tab");
      return;
    }
  }

  lastToggleAt = now;
  console.log(`YouTube Floating PiP Toggle: toggle via ${source}`);
  runToggle(tab);
}

async function youTubeTabIsFrontmost() {
  try {
    const win = await chrome.windows.getLastFocused();
    if (!win || !win.focused) return false;
    const [active] = await chrome.tabs.query({ active: true, windowId: win.id });
    return isYouTubeTab(active);
  } catch (_) {
    return false;
  }
}

chrome.commands.onCommand.addListener((command) => {
  if (command !== "toggle-pip") return;
  requestToggle("hotkey", null);
});

// Clicking the toolbar icon does the same thing. Without this the icon is dead,
// which leaves no way to trigger the extension when the keyboard shortcut is
// unbound — the default state on a fresh install if the suggested key is
// already taken.
chrome.action.onClicked.addListener((tab) => {
  requestToggle("toolbar icon", tab);
});
