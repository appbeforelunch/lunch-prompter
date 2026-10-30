# Results: the build and the parity check

This file is not part of the build. It was added afterwards, for viewers of the App Before Lunch episode about this app.

## What happened

1. **The build.** Claude Code got [`PROMPT.md`](PROMPT.md) and nothing else. One session, 8 min 26 s, 28 turns, about $1.97 at API list price (it ran on a Claude subscription). It named the app SteadyRead and wrote 33 tests; all 33 pass (`node --test tests/*.test.js`).
2. **Its own fix.** After its tests passed, it took screenshots of its own app and wrote: "Three layout problems to fix: the reading line strikes through the text, the control bar wraps too early (an absolute-position shrink-to-fit issue), and the phone library has a big gap." It fixed them, and the tests passed again.
3. **The parity check.** A separate test program, [lunch-prompter-parity](https://github.com/appbeforelunch/lunch-prompter-parity), was written and locked (tag `v1-frozen`) before the build started. Claude was never told about it. It checks the 11 jobs paid teleprompter apps list in their store descriptions, each by a rule fixed in advance.
4. **The verdict** (run 1, two passes): **11 of 11 jobs HAVE in both passes.**

| Job | Result | Why |
|---|---|---|
| J1 Write or paste a script | HAVE | typed text shown at 56px |
| J2 Save and reuse scripts | HAVE | both titled scripts listed after reload and each opens its own text |
| J3 Smooth auto-scroll | HAVE | moved 287 px in 10 s, never back, biggest 0.1 s step 1.02x the median |
| J4 Adjustable speed | HAVE | setting x2 gave x2 px/s |
| J5 Play/pause by keyboard | HAVE | space stopped it in 8 ms and started it again |
| J6 Font size | HAVE | text 56px -> 84px |
| J7 Mirror mode | HAVE | mirror control flips the prompter text left to right |
| J8 Countdown before start | HAVE | count 3-2-1 before scrolling |
| J9 Record video while reading | HAVE | 5.7 s video file, plays (114 frames) |
| J10 No watermark, no time limit | HAVE | 63.8 s recording, no added overlay |
| J11 Works offline | HAVE | loads and scrolls with the network blocked |

## What it doesn't do (by design)

No voice-following scroll, no native phone app, no cloud sync or remote control, no AI script writer, and nobody to fix it for you when it breaks. See "What it can't do" in the [README](README.md).
