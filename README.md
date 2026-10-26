# Thanos Snap

**Disappear from your video call with a finger snap. Snap again to come back.**

Thanos Snap is a Chrome extension for **Google Meet, Microsoft Teams and Zoom on the web**. It swaps your camera video for a snapshot of your empty room, so it looks like you were never there. Turn on **Thanos mode** and you crumble into dust instead of fading out.

Everything runs on your computer. There's no account, no server and no tracking.

## Install

1. Download **`thanos-snap-v1.1.0.zip`** from the [latest release](https://github.com/Naveen-git-platform/thanos-snap/releases/latest).
2. Unzip it. You get a `thanos-snap` folder.
3. Open `chrome://extensions` in Chrome (or Edge, Brave or another Chromium browser, version 111 or newer).
4. Turn on **Developer mode** (top right).
5. Click **Load unpacked** and pick the `thanos-snap` folder.
6. Pin the extension: click the puzzle-piece icon in the toolbar, then the pin next to Thanos Snap.

If a call tab was already open, reload it after installing.

## Use it

1. Open a call in Meet, Teams or Zoom **in the browser** and turn on your camera.
2. Click the Thanos Snap toolbar icon and select the call.
3. **Capture the empty room:** click *Capture empty room*, step out of view during the 5-second countdown, and stay out for 3 more seconds. A double beep (played only on your computer) tells you to come back.
4. Vanish and return with any of these:
   - **Snap your fingers** (turn on *Snap detection* first, then click **Teach my snap** and snap 3 times so it learns how your snap sounds on your mic)
   - the **Vanish / Return** button in the popup
   - **Alt+Shift+V** (change it at `chrome://extensions/shortcuts`)

**Test page:** the popup links to a test page that shows your camera next to what the call would see. You can try everything there without joining a call.

### Tips

- Keep the camera and lighting the same as when you captured the room. If you move the laptop or the light changes, capture the room again.
- On your first try, **turn off the call's own background blur or effects** and ask someone else on the call to check how it looks.
- Snap detection listens for the **sound** of a snap. It doesn't watch your hand. Every mic sounds different, so use **Teach my snap** once.
- Under the meter, the popup shows what it heard and why a sound didn't count: *too quiet*, *not sharp enough* or *lasted too long*. If snaps still don't trigger, raise **Sensitivity**. If it triggers by accident, lower it or turn on **Require double snap**.
- If your camera was already on when you installed or reloaded the extension, turn it off and on again in the call.

## Privacy

- The video effects and snap detection run locally in your browser.
- Your settings and the room snapshot are saved in your browser's extension storage and never uploaded anywhere.
- The call website receives the processed video, the same way it receives your normal camera.
- Snap detection uses a separate microphone stream, so **muting yourself in the call does not stop it.** Turn snap detection off when you don't need it. It also stops when the call releases your camera.

## Limitations

- Works with the **web versions** of Meet, Teams and Zoom only. The Teams and Zoom desktop apps are not supported.
- It might not notice that a call has ended if the site keeps the camera preview running.
- The room snapshot is a still image, so moving things in your room (a clock, a window, a pet) freeze while you're gone.
- Call sites change often. If one stops working, please open an issue.

## How it works

| Part | File | What it does |
| --- | --- | --- |
| Engine | [`src/engine.js`](src/engine.js) | Runs inside the call page and wraps `getUserMedia`. Camera frames go through `MediaStreamTrackProcessor`, are composited on an `OffscreenCanvas`, and come back out through `MediaStreamTrackGenerator`. |
| Thanos effect | `src/engine.js` | Compares the live frame with the empty-room snapshot to find you, without any ML model. It first corrects for the camera re-adjusting exposure and white balance when you step back in, then keeps only large blobs and fills holes. Only you break into particles; the background crossfades smoothly. Returning plays the effect backwards. |
| Snap detector | [`src/snap-analyzer.js`](src/snap-analyzer.js) | Looks for a short, bright, isolated click: high-frequency energy well above the noise floor, quiet before it, and gone within about 30 to 150 ms. Speech, typing and beeps get rejected. *Teach my snap* learns the thresholds from your own snaps. |
| Bridge | [`src/bridge.js`](src/bridge.js) | Passes messages between the page and the extension and syncs settings and the room snapshot. |
| Background | [`src/background.js`](src/background.js) | Handles the toolbar badge (`ON` / `GONE`) and the keyboard shortcut. |
| Popup | [`popup/`](popup/) | The controls. |

English and Ukrainian are included. Chrome picks Ukrainian when its interface language is Ukrainian and English otherwise.

## Development

You need Node 22+ and Chrome. There are no npm dependencies.

```sh
node scripts/test-analyzer.js   # snap detector against synthetic snaps, speech, typing and beeps
node scripts/check-locales.js   # every UI string exists in every language
node scripts/e2e.js             # headless Chrome with a fake camera and mic runs the full vanish/return cycle
node scripts/make-icons.js      # regenerate icons/
node scripts/package.js         # build dist/thanos-snap-v<version>.zip
```

## Disclaimer

This is an unofficial fan project. It isn't affiliated with Marvel, Google, Microsoft, Zoom or Klats. Use it for fun, and be honest with the people you meet.

## License

[MIT](LICENSE)
