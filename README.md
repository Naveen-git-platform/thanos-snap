# Thanos Snap

**Disappear from your video call with a hand gesture or a finger snap. Do it again to come back.**

Thanos Snap is a Chrome extension for **Google Meet, Microsoft Teams and Zoom on the web**. It swaps your camera video for a snapshot of your empty room, so it looks like you were never there. Turn on **Thanos mode** and you crumble into dust instead of fading out.

Show ✌️ to the camera and you're gone. Show ✌️ again and you're back.

Everything runs on your computer. There's no account, no server and no tracking.

## Install

1. Download **`thanos-snap-v1.2.0.zip`** from the [latest release](https://github.com/Naveen-git-platform/thanos-snap/releases/latest).
2. Unzip it. You get a `thanos-snap` folder.
3. Open `chrome://extensions` in Chrome (or Edge, Brave or another Chromium browser, version 116 or newer). Works on **Windows, macOS and Linux**.
4. Turn on **Developer mode** (top right).
5. Click **Load unpacked** and pick the `thanos-snap` folder.
6. Pin the extension: click the puzzle-piece icon in the toolbar, then the pin next to Thanos Snap.

If a call tab was already open, reload it after installing.

**Updating from an older version:** unzip the new version over the old folder, click the reload ↻ icon on Thanos Snap in `chrome://extensions`, then reload your call tab.

## Use it

1. Open a call in Meet, Teams or Zoom **in the browser** and turn on your camera.
2. Click the Thanos Snap toolbar icon and select the call.
3. **Capture the empty room:** click *Capture empty room*, step out of view during the 5-second countdown, and stay out for 3 more seconds. A double beep (played only on your computer) tells you to come back.
4. Vanish and return with any of these:
   - **Hand gesture** (on by default): hold up ✌️ for a moment. Drop your hand, then show ✌️ again to come back. You can pick a different gesture: 🤟 👍 ✋ ☝️ ✊.
   - **Finger snap** (turn on *Snap detection*, then click **Teach my snap** and snap 3 times)
   - the **Vanish / Return** button in the popup
   - **Alt+Shift+V** on Windows/Linux, **⌥⇧V** on Mac (change it at `chrome://extensions/shortcuts`)

**Test page:** the popup links to a test page that shows your camera next to what the call would see. You can try everything there without joining a call.

### Tips

- Keep the camera and lighting the same as when you captured the room. If you move the laptop or the light changes, capture the room again.
- On your first try, **turn off the call's own background blur or effects** and ask someone else on the call to check how it looks.
- **Gestures:** keep your hand clearly in frame, about a forearm's length from the camera, with your palm facing the camera. The popup shows *Seen!* when it recognises your gesture. The model takes a few seconds to load the first time a call starts.
- **Snaps on Windows:** many Windows laptops clean up the microphone before Chrome even hears it, and that removes clicks like snaps. If snaps only work right next to the mic, open **Settings → System → Sound → your microphone** and turn off **Audio enhancements** / **Voice clarity**. Some laptops also have a noise-suppression switch in the audio driver app (Realtek, Dolby, MaxxAudio and others). Or just use hand gestures.
- Under the meter, the popup shows what it heard and why a sound didn't count: *too quiet*, *not sharp enough* or *lasted too long*.
- If your camera was already on when you installed or reloaded the extension, turn it off and on again in the call.

## Privacy

- The video effects, hand-gesture recognition and snap detection all run locally in your browser.
- For gestures, small copies of your camera frames go to a hidden page inside the extension, which runs Google's MediaPipe hand model offline. Nothing is uploaded.
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
| Engine | [`src/engine.js`](src/engine.js) | Runs inside the call page and wraps `getUserMedia`. It controls the state, room snapshot, snap detector and gesture trigger. |
| Compositor | [`src/compositor.js`](src/compositor.js) | Processes every camera frame (`MediaStreamTrackProcessor` → `OffscreenCanvas` → `MediaStreamTrackGenerator`) in a **Worker**, so a busy call page can't make your video lag. Under load it drops stale frames instead of queueing them. If a site blocks workers, it runs in the page instead. |
| Thanos effect | `src/compositor.js` | Finds you by comparing the live frame with the empty-room snapshot. It first corrects for the camera re-adjusting exposure and white balance when you step back in, then keeps only large blobs and fills holes. Only you break into particles; the background crossfades smoothly. Returning plays the effect backwards. |
| Gestures | [`src/gesture.js`](src/gesture.js), [`offscreen/`](offscreen/) | About 10 small frames a second go to an offscreen extension page. There, [MediaPipe's gesture recogniser](https://ai.google.dev/edge/mediapipe/solutions/vision/gesture_recognizer) runs on the GPU in its own process, separate from the call page. Holding the chosen gesture for 0.2 s toggles once; it re-arms after you drop your hand. |
| Snap detector | [`src/snap-analyzer.js`](src/snap-analyzer.js) | Looks for a short, bright, isolated click: high-frequency energy well above the noise floor, quiet before it, and gone within about 30 to 150 ms. Speech, typing and beeps get rejected. *Teach my snap* learns the thresholds from your own snaps. |
| Bridge | [`src/bridge.js`](src/bridge.js) | Passes messages between the page and the extension and syncs settings and the room snapshot. |
| Background | [`src/background.js`](src/background.js) | Handles the toolbar badge (`ON` / `GONE`), the keyboard shortcut and the gesture page. |
| Popup | [`popup/`](popup/) | The controls. |

English and Ukrainian are included. Chrome picks Ukrainian when its interface language is Ukrainian and English otherwise.

## Development

You need Node 22+ and Chrome. There are no npm dependencies.

```sh
node scripts/test-analyzer.js   # snap detector against synthetic snaps, speech, typing and beeps
node scripts/check-locales.js   # every UI string exists in every language
node scripts/e2e.js             # headless Chrome, fake camera + mic: vanish/return, room capture,
                                # and ✌️/👍 photos for gestures, with and without a Worker
node scripts/make-icons.js      # regenerate icons/
node scripts/package.js         # build dist/thanos-snap-v<version>.zip
```

## Credits

Hand-gesture recognition uses [MediaPipe Tasks Vision](https://www.npmjs.com/package/@mediapipe/tasks-vision) and its gesture recogniser model, © Google LLC, Apache License 2.0. They are vendored in [`vendor/mediapipe/`](vendor/mediapipe/).

## Disclaimer

This is an unofficial fan project. It isn't affiliated with Marvel, Google, Microsoft, Zoom or Klats. Use it for fun, and be honest with the people you meet.

## License

[MIT](LICENSE) for Thanos Snap's own code. The vendored MediaPipe files keep their Apache 2.0 license.
