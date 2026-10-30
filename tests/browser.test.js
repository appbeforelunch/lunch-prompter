// End-to-end tests: opens index.html from disk in headless Chrome and drives it
// over the Chrome DevTools Protocol. Uses only Node built-ins (fetch, WebSocket,
// node:test), so there is nothing to install.
//
// Chrome is found automatically on macOS, Linux and Windows, or set CHROME_PATH.
// Chrome's fake camera stands in for a real one, so recording is tested end to end.
'use strict';
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const APP_URL = pathToFileURL(path.join(__dirname, '..', 'index.html')).href;

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ];
  return candidates.find((p) => p && fs.existsSync(p));
}

const CHROME = findChrome();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Browser {
  async launch() {
    this.profile = fs.mkdtempSync(path.join(os.tmpdir(), 'steadyread-profile-'));
    this.downloads = fs.mkdtempSync(path.join(os.tmpdir(), 'steadyread-downloads-'));
    this.proc = spawn(
      CHROME,
      [
        '--headless=new',
        '--remote-debugging-port=0',
        `--user-data-dir=${this.profile}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        '--autoplay-policy=no-user-gesture-required',
        '--window-size=1280,800',
        'about:blank',
      ],
      { stdio: 'ignore' }
    );
    const portFile = path.join(this.profile, 'DevToolsActivePort');
    const deadline = Date.now() + 20000;
    while (!fs.existsSync(portFile) || fs.readFileSync(portFile, 'utf8').split('\n').length < 2) {
      if (Date.now() > deadline) throw new Error('Chrome did not start');
      await sleep(100);
    }
    const [port, wsPath] = fs.readFileSync(portFile, 'utf8').trim().split('\n');
    this.ws = new WebSocket(`ws://127.0.0.1:${port}${wsPath}`);
    await new Promise((res, rej) => {
      this.ws.onopen = res;
      this.ws.onerror = rej;
    });
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = [];
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} ${msg.error.data || ''}`));
        else resolve(msg.result);
      } else if (msg.method) {
        for (const fn of this.listeners) fn(msg);
      }
    };

    await this.send('Browser.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: this.downloads,
      eventsEnabled: true,
    });
    const { targetId } = await this.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    this.sessionId = sessionId;

    this.requests = [];
    this.errors = [];
    this.on((m) => {
      if (m.sessionId !== this.sessionId) return;
      if (m.method === 'Network.requestWillBeSent') this.requests.push(m.params.request.url);
      if (m.method === 'Runtime.exceptionThrown') this.errors.push(m.params.exceptionDetails.text + ' ' + JSON.stringify(m.params.exceptionDetails.exception && m.params.exceptionDetails.exception.description));
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
        this.errors.push(m.params.args.map((a) => a.value || a.description).join(' '));
      }
      if (m.method === 'Page.javascriptDialogOpening') {
        this.page('Page.handleJavaScriptDialog', { accept: this.acceptDialogs !== false }).catch(() => {});
      }
    });
    await this.page('Page.enable');
    await this.page('Runtime.enable');
    await this.page('Network.enable');
  }

  on(fn) {
    this.listeners.push(fn);
    return () => (this.listeners = this.listeners.filter((f) => f !== fn));
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    this.ws.send(JSON.stringify(msg));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  page(method, params) {
    return this.send(method, params, this.sessionId);
  }

  waitEvent(method, timeout = 10000) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        off();
        reject(new Error(`timeout waiting for ${method}`));
      }, timeout);
      const off = this.on((m) => {
        if (m.method === method && (!m.sessionId || m.sessionId === this.sessionId)) {
          clearTimeout(t);
          off();
          resolve(m.params);
        }
      });
    });
  }

  async goto(url) {
    const loaded = this.waitEvent('Page.loadEventFired');
    await this.page('Page.navigate', { url });
    await loaded;
  }

  async reload() {
    const loaded = this.waitEvent('Page.loadEventFired');
    await this.page('Page.reload');
    await loaded;
  }

  async eval(expression) {
    const r = await this.page('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (r.exceptionDetails) {
      throw new Error(`eval failed: ${expression}\n${r.exceptionDetails.exception && r.exceptionDetails.exception.description}`);
    }
    return r.result.value;
  }

  async waitFor(expression, timeout = 8000) {
    const deadline = Date.now() + timeout;
    for (;;) {
      if (await this.eval(`!!(${expression})`)) return;
      if (Date.now() > deadline) throw new Error(`timed out waiting for: ${expression}`);
      await sleep(50);
    }
  }

  click(selector) {
    return this.eval(`document.querySelector(${JSON.stringify(selector)}).click()`);
  }

  async key(key) {
    const codes = {
      ' ': ['Space', 32],
      ArrowUp: ['ArrowUp', 38],
      ArrowDown: ['ArrowDown', 40],
      ArrowLeft: ['ArrowLeft', 37],
      ArrowRight: ['ArrowRight', 39],
      Home: ['Home', 36],
      Escape: ['Escape', 27],
      m: ['KeyM', 77],
      '+': ['Equal', 187],
    };
    const [code, keyCode] = codes[key];
    const base = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode };
    const printable = key.length === 1;
    await this.page('Input.dispatchKeyEvent', Object.assign({ type: printable ? 'keyDown' : 'rawKeyDown', text: printable ? key : undefined }, base));
    await this.page('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, base));
  }

  async type(selector, text) {
    await this.eval(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.focus(); el.select && el.select(); })()`);
    await this.page('Input.insertText', { text });
  }

  setRange(id, value) {
    return this.eval(`(() => { const r = document.getElementById(${JSON.stringify(id)}); r.value = ${Number(value)}; r.dispatchEvent(new Event('input')); })()`);
  }

  state() {
    return this.eval('window.SteadyRead.state()');
  }

  async close() {
    try {
      this.ws.close();
    } catch (e) {
      /* ignore */
    }
    if (this.proc) this.proc.kill();
    await sleep(300);
    for (const dir of [this.profile, this.downloads]) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch (e) {
        /* ignore */
      }
    }
  }
}

describe('SteadyRead in Chrome', { skip: !CHROME && 'Chrome not found (set CHROME_PATH)' }, () => {
  const b = new Browser();

  before(async () => {
    await b.launch();
    await b.goto(APP_URL);
  });

  after(async () => {
    await b.close();
  });

  test('first visit shows the app name and the toast sample script', async () => {
    assert.equal(await b.eval('document.querySelector(".brand-name").textContent'), 'SteadyRead');
    const titles = await b.eval('[...document.querySelectorAll("#scriptList .item-title")].map(e => e.textContent)');
    assert.deepEqual(titles, ['How to Make Good Toast']);
    assert.match(await b.eval('document.getElementById("bodyInput").value'), /toast/i);
    assert.equal(await b.eval('document.getElementById("storageWarning").hidden'), true);
  });

  test('editor shows word count and read time at the chosen wpm', async () => {
    const words = await b.eval('SteadyCore.countWords(document.getElementById("bodyInput").value)');
    assert.equal(await b.eval('document.getElementById("wordCount").textContent'), `${words} words`);
    const expected140 = await b.eval(`SteadyCore.formatDuration(SteadyCore.readTimeSeconds(${words}, 140))`);
    assert.equal(await b.eval('document.getElementById("readTime").textContent'), expected140);

    await b.type('#editorWpm', '70');
    const expected70 = await b.eval(`SteadyCore.formatDuration(SteadyCore.readTimeSeconds(${words}, 70))`);
    await b.waitFor(`document.getElementById("readTime").textContent === ${JSON.stringify(expected70)}`);
    await b.type('#editorWpm', '140');
    await b.eval('document.getElementById("editorWpm").dispatchEvent(new Event("change"))');
    await b.waitFor('document.getElementById("readTime").textContent === ' + JSON.stringify(expected140));
  });

  test('new scripts are saved in the browser and survive a reload', async () => {
    await b.click('#newScript');
    await b.type('#titleInput', 'Weekly Update');
    await b.type('#bodyInput', 'First paragraph here.\n\nSecond paragraph with more words in it.');
    await b.waitFor('document.getElementById("saveStatus").textContent === "Saved"');
    await b.reload();
    const titles = await b.eval('[...document.querySelectorAll("#scriptList .item-title")].map(e => e.textContent)');
    assert.deepEqual(titles.sort(), ['How to Make Good Toast', 'Weekly Update']);
    assert.equal(await b.eval('document.getElementById("titleInput").value'), 'Weekly Update');
    assert.match(await b.eval('document.getElementById("bodyInput").value'), /Second paragraph/);
  });

  test('switching scripts loads the chosen one', async () => {
    await b.eval('[...document.querySelectorAll("#scriptList button")].find(x => x.textContent.includes("Toast")).click()');
    assert.equal(await b.eval('document.getElementById("titleInput").value'), 'How to Make Good Toast');
  });

  test('prompter opens full window with the script as large text', async () => {
    await b.click('#openPrompter');
    await b.waitFor('window.SteadyRead.state().isOpen');
    assert.equal(await b.eval('document.getElementById("prompter").hidden'), false);
    assert.equal(await b.eval('document.getElementById("app").hidden'), true);
    const box = await b.eval('(() => { const r = document.getElementById("prompter").getBoundingClientRect(); return [r.width, r.height, innerWidth, innerHeight]; })()');
    assert.equal(box[0], box[2]);
    assert.equal(box[1], box[3]);
    assert.equal(await b.eval('document.querySelectorAll("#scriptText p").length'), 7);
    const fontPx = await b.eval('parseFloat(getComputedStyle(document.getElementById("scriptText")).fontSize)');
    assert.ok(fontPx >= 40, `font size ${fontPx}`);
    assert.match(await b.eval('document.getElementById("timeLeft").textContent'), /^\d+:\d\d left$/);
  });

  test('space bar runs a 3-2-1 countdown, then scrolls; space pauses', async () => {
    assert.equal((await b.state()).pos, 0);
    await b.key(' ');
    let s = await b.state();
    assert.equal(s.counting, true);
    assert.equal(s.playing, false);
    assert.equal(await b.eval('document.getElementById("countdown").textContent'), '3');
    await b.waitFor('document.getElementById("countdown").textContent === "2"', 2000);
    await b.waitFor('document.getElementById("countdown").textContent === "1"', 2000);
    await b.waitFor('window.SteadyRead.state().playing', 2000);
    assert.equal(await b.eval('document.getElementById("countdown").hidden'), true);
    await sleep(600);
    const p1 = (await b.state()).pos;
    assert.ok(p1 > 0, 'scrolled');

    await b.key(' ');
    s = await b.state();
    assert.equal(s.playing, false);
    const p2 = s.pos;
    await sleep(400);
    assert.equal((await b.state()).pos, p2, 'stays put while paused');
  });

  test('on-screen play button plays and pauses (countdown can be turned off)', async () => {
    await b.click('#settingsBtn');
    assert.equal(await b.eval('document.getElementById("settingsPanel").hidden'), false);
    await b.click('#countdownToggle');
    assert.equal(await b.eval('window.SteadyRead.settings().countdown'), false);
    await b.click('#playBtn');
    assert.equal((await b.state()).playing, true);
    assert.equal(await b.eval('document.getElementById("playBtn").getAttribute("aria-label")'), 'Pause');
    await b.click('#playBtn');
    assert.equal((await b.state()).playing, false);
  });

  test('scroll speed matches the words-per-minute setting', async () => {
    await b.key('Home');
    const s0 = await b.state();
    const wpm = (await b.eval('window.SteadyRead.settings()')).wpm;
    const expectedPps = (wpm / 60) * (s0.maxPos / s0.words);
    assert.ok(Math.abs(s0.pps - expectedPps) < 0.01);

    await b.click('#playBtn');
    const t0 = Date.now();
    const start = (await b.state()).pos;
    await sleep(2000);
    const end = (await b.state()).pos;
    const elapsed = (Date.now() - t0) / 1000;
    await b.click('#playBtn');
    const measured = (end - start) / elapsed;
    assert.ok(Math.abs(measured - expectedPps) / expectedPps < 0.2, `measured ${measured}px/s vs expected ${expectedPps}px/s`);

    // Doubling wpm doubles the speed.
    await b.setRange('wpmRange', 280);
    const s1 = await b.state();
    assert.ok(Math.abs(s1.pps - expectedPps * (280 / wpm)) < 0.05);
    assert.equal(await b.eval('document.getElementById("wpmDisplay").textContent'), '280 wpm');
    await b.setRange('wpmRange', wpm);
  });

  test('arrow keys nudge position and change speed; Home goes back to top', async () => {
    await b.key('Home');
    const fontSize = (await b.eval('window.SteadyRead.settings()')).fontSize;
    await b.key('ArrowDown');
    await b.key('ArrowDown');
    const s1 = await b.state();
    assert.ok(Math.abs(s1.pos - 2 * fontSize * 1.45) < 1, `pos ${s1.pos}`);
    await b.key('ArrowUp');
    assert.ok(Math.abs((await b.state()).pos - fontSize * 1.45) < 1);

    const w0 = (await b.eval('window.SteadyRead.settings()')).wpm;
    await b.key('ArrowRight');
    assert.equal((await b.eval('window.SteadyRead.settings()')).wpm, w0 + 10);
    await b.key('ArrowLeft');
    await b.key('ArrowLeft');
    assert.equal((await b.eval('window.SteadyRead.settings()')).wpm, w0 - 10);
    await b.key('ArrowRight');
    await b.click('#fasterBtn');
    assert.equal((await b.eval('window.SteadyRead.settings()')).wpm, w0 + 10);
    await b.click('#slowerBtn');

    await b.key('Home');
    assert.equal((await b.state()).pos, 0);
  });

  test('read time left reflects the chosen speed', async () => {
    const s = await b.state();
    const expected = await b.eval(`SteadyCore.formatDuration(${s.maxPos / s.pps})`);
    assert.equal(await b.eval('document.getElementById("timeLeft").textContent'), `${expected} left`);
  });

  test('mirror mode flips the text left to right (checkbox and M key)', async () => {
    const transform = () => b.eval('getComputedStyle(document.getElementById("mirrorBox")).transform');
    assert.equal(await transform(), 'none');
    await b.click('#mirrorToggle');
    assert.match(await transform(), /^matrix\(-1, 0, 0, 1, 0, 0\)$/);
    await b.key('m');
    assert.equal(await transform(), 'none');
  });

  test('text size and margins are adjustable', async () => {
    await b.setRange('sizeRange', 90);
    assert.equal(await b.eval('getComputedStyle(document.getElementById("scriptText")).fontSize'), '90px');
    const before = (await b.state()).maxPos;
    await b.setRange('marginRange', 25);
    const pad = await b.eval('parseFloat(getComputedStyle(document.getElementById("scroller")).paddingLeft)');
    const width = await b.eval('document.getElementById("scroller").getBoundingClientRect().width');
    assert.ok(Math.abs(pad - width * 0.25) < 2, `padding ${pad} of ${width}`);
    assert.ok((await b.state()).maxPos > before, 'narrower column makes the text taller');
    await b.key('+');
    assert.equal(await b.eval('window.SteadyRead.settings().fontSize'), 94);
  });

  test('reading line sits at the chosen height and can be hidden', async () => {
    await b.setRange('lineRange', 50);
    const [mid, h] = await b.eval('(() => { const r = document.getElementById("readingLine").getBoundingClientRect(); return [r.top + r.height / 2, document.getElementById("stage").clientHeight]; })()');
    assert.ok(Math.abs(mid - h / 2) < 2, `line centred at ${mid} of ${h}`);
    // The first line of text sits inside the reading band.
    const [lineTop, lineBottom, textTop] = await b.eval('[document.getElementById("readingLine").getBoundingClientRect().top, document.getElementById("readingLine").getBoundingClientRect().bottom, document.getElementById("scriptText").getBoundingClientRect().top]');
    assert.ok(textTop >= lineTop - 1 && textTop < lineBottom, `text top ${textTop} vs band ${lineTop}-${lineBottom}`);
    await b.click('#lineToggle');
    assert.equal(await b.eval('document.getElementById("readingLine").hidden'), true);
    await b.click('#lineToggle');
    assert.equal(await b.eval('document.getElementById("readingLine").hidden'), false);
  });

  test('prompter settings are remembered after a reload', async () => {
    await b.reload();
    const s = await b.eval('window.SteadyRead.settings()');
    assert.equal(s.fontSize, 94);
    assert.equal(s.margin, 25);
    assert.equal(s.linePosition, 50);
    assert.equal(s.countdown, false);
  });

  test('recording with the camera saves a video file to download', async () => {
    await b.click('#openPrompter');
    await b.waitFor('window.SteadyRead.state().isOpen');
    const began = b.waitEvent('Browser.downloadWillBegin', 20000);
    await b.click('#recordBtn');
    await b.waitFor('window.SteadyRead.state().recording', 10000);
    assert.equal(await b.eval('document.getElementById("recBadge").hidden'), false);
    assert.equal(await b.eval('document.getElementById("camPreview").hidden'), false);
    assert.equal((await b.state()).playing, true, 'recording starts the prompter');
    await sleep(2500);
    await b.click('#recordBtn');
    const dl = await began;
    assert.match(dl.suggestedFilename, /^how-to-make-good-toast_\d{4}-\d\d-\d\d_\d\d-\d\d-\d\d\.(mp4|webm)$/);
    await b.waitFor('!window.SteadyRead.state().recording');
    await b.waitFor('/Recording saved as/.test(document.getElementById("noticeText").textContent)');
    assert.equal(await b.eval('document.getElementById("camPreview").hidden'), true);
    assert.match(await b.eval('document.getElementById("downloadLink").href'), /^blob:/);

    const file = path.join(b.downloads, dl.suggestedFilename);
    const deadline = Date.now() + 10000;
    while (!(fs.existsSync(file) && fs.statSync(file).size > 0)) {
      if (Date.now() > deadline) throw new Error(`download not written: ${file}`);
      await sleep(100);
    }
    assert.ok(fs.statSync(file).size > 10000, `video is ${fs.statSync(file).size} bytes`);
    await b.click('#playBtn');
  });

  test('if camera access is denied, it says so and the prompter keeps working', async () => {
    await b.eval(`navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException("Permission denied", "NotAllowedError"))`);
    await b.click('#recordBtn');
    await b.waitFor('!document.getElementById("notice").hidden');
    assert.match(await b.eval('document.getElementById("noticeText").textContent'), /denied.*prompter still works/i);
    assert.equal((await b.state()).recording, false);
    assert.equal(await b.eval('document.getElementById("recordBtn").disabled'), false);

    await b.key('Home');
    await b.key(' ');
    assert.equal((await b.state()).playing, true);
    await sleep(300);
    assert.ok((await b.state()).pos > 0);
    await b.key(' ');
  });

  test('Escape leaves the prompter and returns to the scripts', async () => {
    for (let i = 0; i < 3 && (await b.state()).isOpen; i++) {
      await b.key('Escape');
      await sleep(300);
    }
    assert.equal((await b.state()).isOpen, false);
    assert.equal(await b.eval('document.getElementById("app").hidden'), false);
  });

  test('deleting a script asks first and is remembered', async () => {
    b.acceptDialogs = false;
    await b.click('#deleteScript');
    assert.equal(await b.eval('document.querySelectorAll("#scriptList li").length'), 2);
    b.acceptDialogs = true;
    await b.eval('[...document.querySelectorAll("#scriptList button")].find(x => x.textContent.includes("Weekly")).click()');
    await b.click('#deleteScript');
    assert.equal(await b.eval('document.querySelectorAll("#scriptList li").length'), 1);
    await b.reload();
    const titles = await b.eval('[...document.querySelectorAll("#scriptList .item-title")].map(e => e.textContent)');
    assert.deepEqual(titles, ['How to Make Good Toast']);
  });

  test('works on a phone-sized touch screen', async () => {
    await b.page('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
    await b.page('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await b.reload();
    assert.ok(await b.eval('document.documentElement.scrollWidth <= innerWidth'), 'no sideways scrolling in library');
    await b.click('#openPrompter');
    await b.waitFor('window.SteadyRead.state().isOpen');
    const r = await b.eval('(() => { const r = document.getElementById("controls").getBoundingClientRect(); return { left: r.left, right: r.right, bottom: r.bottom, w: innerWidth, h: innerHeight }; })()');
    assert.ok(r.left >= 0 && r.right <= r.w && r.bottom <= r.h, JSON.stringify(r));

    // Tap the text to start, tap again to pause.
    const tap = async () => {
      await b.page('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 195, y: 300 }] });
      await b.page('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    };
    await tap();
    await b.waitFor('window.SteadyRead.state().playing', 2000);
    await tap();
    await b.waitFor('!window.SteadyRead.state().playing', 2000);
    await b.page('Emulation.clearDeviceMetricsOverride');
    await b.page('Emulation.setTouchEmulationEnabled', { enabled: false });
  });

  test('makes no network requests and throws no errors', () => {
    const external = b.requests.filter((u) => !/^(file|data|blob|about):/.test(u));
    assert.deepEqual(external, []);
    assert.deepEqual(b.errors, []);
  });
});
