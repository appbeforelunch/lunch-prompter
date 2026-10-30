# SteadyRead

A simple teleprompter that runs in your browser. Write a script, then read it from a large, smoothly scrolling screen while you record yourself with your camera. Everything stays on your device: no account, no uploads, no watermark, no time limit.

## What it does

**Scripts**
- Write or paste a script and give it a title. Keep as many as you like.
- Scripts save automatically in this browser and are there the next time you open the page.
- The editor shows the word count and roughly how long the script takes to read at your speed.
- A short sample script ("How to Make Good Toast") is included the first time you open the app.

**Prompter**
- Full-screen, large text that scrolls smoothly on its own.
- Speed is set in words per minute (40–400). The app measures your text so the speed stays true at any text size or margin.
- A 3-2-1 countdown before scrolling starts. You can turn it off in Settings.
- Mirror mode flips the text left to right, for use with beam-splitter glass.
- Adjustable text size, side margins, and reading-line position. The reading line can be hidden.
- Shows the time left at the current speed.
- Settings are remembered between visits.

| Key | Action |
| --- | --- |
| Space | Play / pause |
| ↑ / ↓ | Nudge back / forward one line |
| Page Up / Page Down | Jump five lines |
| ← / → | Slower / faster (10 wpm steps) |
| + / − | Bigger / smaller text |
| M | Mirror on / off |
| Home | Back to the top |
| Esc | Leave the prompter |

On a phone or tablet, tap the text to play or pause and drag it to move. The buttons at the bottom do the same things as the keys.

**Recording**
- Press the red ● button in the prompter to record from your front camera and microphone. A small preview appears in the corner and the script starts scrolling.
- Press ■ to stop. The video downloads straight to your device as an `.mp4` file, or `.webm` in browsers that can't record MP4. It is named after the script and the date and time.
- No watermark and no time limit. The video never leaves your device.
- If camera access is denied or there's no camera, the app tells you and the prompter keeps working.

## How to open it

1. Download or copy this folder to your computer.
2. Double-click `index.html`, or drag it into a Chrome window.

That's it. There is nothing to install, and it works with no internet connection.

**On a phone:** copy the folder to the phone and open `index.html` in Chrome. The Files app's "Open with" option usually works. Some phone browsers restrict pages opened from local files. If the camera or saving won't work that way, serve the folder from any computer on your network and open that address instead. Even then, nothing is uploaded: the page runs entirely in the browser.

Scripts are kept in the browser's local storage for that browser on that device. Clearing your browsing data deletes them, so keep a copy of anything important.

## Running the tests

You need [Node.js](https://nodejs.org) 22 or newer and Google Chrome. Nothing else needs to be installed.

```sh
node --test tests/*.test.js
```

- `tests/core.test.js` covers the script library, storage, word counts, read-time math, speed math, settings, file names, and camera error messages.
- `tests/browser.test.js` opens `index.html` in headless Chrome and uses the app like a person would. It covers creating, saving, reloading and deleting scripts; the countdown; play and pause with the space bar and with the button; arrow-key nudges and speed changes; checking that scroll speed matches the wpm setting; mirror mode, text size, margins and the reading line; recording a real video with Chrome's fake camera and checking the downloaded file; denied camera access; a phone-sized touch screen; and checking that no network requests or script errors happen.

If Chrome isn't installed in the usual place, set `CHROME_PATH=/path/to/chrome`. Without Chrome, the browser tests are skipped.

## What it can't do

Compared with paid teleprompter apps, SteadyRead does not have:

- **Voice-following scroll.** It scrolls at a steady speed you set and won't follow your voice. Pause, nudge, or change speed by hand.
- **Cloud sync or accounts.** Scripts live in one browser on one device. There's no backup, no sharing, and nothing carries over to your other devices.
- **Remote control.** It doesn't support a second phone, a Bluetooth remote, or a foot pedal unless that device acts as a keyboard (for example, a remote that sends Space or arrow keys).
- **Text in the video.** Recordings contain only the camera picture and sound, not the script. The camera preview is a small corner window and isn't laid over the text.
- **Editing tools.** There's no video trimming, no captions, no filters, no background blur, no choice of resolution or frame rate, and no switching between front and rear cameras.
- **Rich script formatting.** Scripts are plain text with paragraph breaks only: no colors, bold, cue marks, or importing documents.
- **Guaranteed phone support from a local file.** Some mobile browsers limit camera access or downloads for pages opened straight from a file. See "How to open it" above.
