// Unit tests for core.js. Run with: node --test tests/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../core.js');

function memoryStorage(initial) {
  const data = Object.assign({}, initial);
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => {
      data[k] = String(v);
    },
  };
}

test('countWords handles spacing, newlines and empty input', () => {
  assert.equal(C.countWords(''), 0);
  assert.equal(C.countWords('   '), 0);
  assert.equal(C.countWords(null), 0);
  assert.equal(C.countWords('one'), 1);
  assert.equal(C.countWords('  two   words \n\n and\tthree more '), 5);
});

test('readTimeSeconds and formatDuration', () => {
  assert.equal(C.readTimeSeconds(140, 140), 60);
  assert.equal(C.readTimeSeconds(70, 140), 30);
  assert.equal(C.readTimeSeconds(0, 140), 0);
  assert.equal(C.readTimeSeconds(100, 0), 0);
  assert.equal(C.formatDuration(0), '0:00');
  assert.equal(C.formatDuration(75), '1:15');
  assert.equal(C.formatDuration(3725), '1:02:05');
  assert.equal(C.formatDuration(-5), '0:00');
});

test('pixelsPerSecond moves wpm words past the line per minute', () => {
  // 120 words in 1200px = 10px per word; 60 wpm = 1 word/s = 10px/s
  assert.equal(C.pixelsPerSecond(60, 120, 1200), 10);
  assert.equal(C.pixelsPerSecond(120, 120, 1200), 20);
  assert.equal(C.pixelsPerSecond(120, 0, 1200), 0);
  assert.equal(C.pixelsPerSecond(120, 10, 0), 0);
});

test('paragraphs splits on blank lines and keeps single line breaks', () => {
  assert.deepEqual(C.paragraphs('a\nb\n\n\nc\r\n\r\nd'), ['a\nb', 'c', 'd']);
  assert.deepEqual(C.paragraphs('  \n \n '), []);
});

test('normalizeSettings clamps numbers and ignores junk', () => {
  const s = C.normalizeSettings({ wpm: 9999, fontSize: 'x', margin: -4, mirror: 'yes', countdown: false });
  assert.equal(s.wpm, 400);
  assert.equal(s.fontSize, C.DEFAULT_SETTINGS.fontSize);
  assert.equal(s.margin, 0);
  assert.equal(s.mirror, false);
  assert.equal(s.countdown, false);
  assert.deepEqual(C.normalizeSettings(null), C.DEFAULT_SETTINGS);
});

test('settings round-trip through storage, with fallback for first visit', () => {
  const st = memoryStorage();
  assert.equal(C.loadSettings(st, { fontSize: 36 }).fontSize, 36);
  assert.ok(C.saveSettings(st, { wpm: 180, mirror: true }));
  const s = C.loadSettings(st, { fontSize: 36 });
  assert.equal(s.wpm, 180);
  assert.equal(s.mirror, true);
  st.setItem(C.SETTINGS_KEY, '{broken');
  assert.equal(C.loadSettings(st).wpm, C.DEFAULT_SETTINGS.wpm);
});

test('library seeds the toast sample only on first visit', () => {
  const st = memoryStorage();
  const lib = C.createLibrary(st);
  const all = lib.list();
  assert.equal(all.length, 1);
  assert.match(all[0].title, /toast/i);
  assert.equal(lib.current().id, all[0].id);
  lib.remove(all[0].id);
  assert.equal(lib.list().length, 0);
  const again = C.createLibrary(st);
  assert.equal(again.list().length, 0, 'deleted sample must not come back');
});

test('library create / update / select / remove persist across reloads', () => {
  let t = 1000;
  const st = memoryStorage();
  const lib = C.createLibrary(st, { now: () => (t += 1) });
  const a = lib.create({ title: 'Intro', body: 'hello world' });
  const b = lib.create({ title: 'Outro', body: 'bye' });
  assert.equal(lib.currentId, b.id);
  lib.update(a.id, { body: 'hello there world' });
  assert.equal(lib.list()[0].id, a.id, 'most recently edited first');
  lib.select(a.id);

  const reloaded = C.createLibrary(st);
  assert.equal(reloaded.list().length, 3);
  assert.equal(reloaded.currentId, a.id);
  assert.equal(reloaded.get(a.id).body, 'hello there world');

  assert.ok(reloaded.remove(a.id));
  assert.notEqual(reloaded.currentId, a.id);
  assert.ok(reloaded.currentId);
  assert.equal(reloaded.remove('nope'), false);
  assert.equal(reloaded.select('nope'), false);
  assert.equal(reloaded.update('nope', { title: 'x' }), null);
});

test('library survives corrupt or blocked storage', () => {
  const corrupt = memoryStorage({ [C.LIBRARY_KEY]: 'not json' });
  assert.equal(C.createLibrary(corrupt).list().length, 1);

  const blocked = {
    getItem: () => {
      throw new Error('blocked');
    },
    setItem: () => {
      throw new Error('blocked');
    },
  };
  const lib = C.createLibrary(blocked);
  assert.equal(lib.storageOk, false);
  const s = lib.create({ title: 'Still works', body: 'in memory' });
  assert.equal(lib.get(s.id).title, 'Still works');
});

test('sample script is about toast and short', () => {
  const words = C.countWords(C.SAMPLE_SCRIPT.body);
  assert.match(C.SAMPLE_SCRIPT.body, /toast/i);
  assert.ok(words > 50 && words < 250, `sample has ${words} words`);
});

test('pickMimeType prefers mp4, falls back to webm, tolerates missing API', () => {
  assert.equal(C.pickMimeType((t) => t.startsWith('video/webm')), 'video/webm;codecs=vp9,opus');
  assert.equal(C.pickMimeType(() => true), 'video/mp4;codecs=avc1,mp4a');
  assert.equal(C.pickMimeType(() => false), '');
  assert.equal(C.pickMimeType(undefined), '');
  assert.equal(C.extensionFor('video/mp4;codecs=avc1'), 'mp4');
  assert.equal(C.extensionFor('video/webm'), 'webm');
});

test('recordingFilename is safe and dated', () => {
  const d = new Date(2026, 0, 2, 3, 4, 5);
  assert.equal(C.recordingFilename('How to Make Good Toast!', d, 'mp4'), 'how-to-make-good-toast_2026-01-02_03-04-05.mp4');
  assert.equal(C.recordingFilename('  ', d, 'webm'), 'recording_2026-01-02_03-04-05.webm');
  assert.equal(C.recordingFilename('Café / Crème', d, 'webm'), 'cafe-creme_2026-01-02_03-04-05.webm');
});

test('cameraErrorMessage explains denial and keeps prompter usable', () => {
  const msg = C.cameraErrorMessage({ name: 'NotAllowedError' });
  assert.match(msg, /denied/i);
  assert.match(msg, /prompter still works/i);
  assert.match(C.cameraErrorMessage({ name: 'NotFoundError' }), /no camera/i);
  assert.match(C.cameraErrorMessage(null), /prompter still works/i);
});
