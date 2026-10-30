/*
 * SteadyRead core: pure logic shared by the app (browser) and the tests (Node).
 * No DOM access here, so every function can be tested without a browser.
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SteadyCore = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const LIBRARY_KEY = 'steadyread.library.v1';
  const SETTINGS_KEY = 'steadyread.settings.v1';

  const LIMITS = {
    wpm: [40, 400],
    fontSize: [20, 160],
    margin: [0, 35],
    linePosition: [10, 80],
  };

  const DEFAULT_SETTINGS = {
    wpm: 140,
    fontSize: 56,
    margin: 10,
    linePosition: 35,
    mirror: false,
    readingLine: true,
    countdown: true,
  };

  const SAMPLE_SCRIPT = {
    title: 'How to Make Good Toast',
    body: [
      "Hi there. Today we're making toast, and I promise it's worth doing right.",
      'Start with bread that is a day or two old. Slightly dry bread browns more evenly than a fresh, soft slice.',
      'Set your toaster to the middle setting. You can always toast it a little longer, but you can never untoast it.',
      'While it browns, get your butter out so it softens. Cold butter tears the bread. Soft butter melts right in.',
      "When the toast pops up, butter it straight away, edge to edge. Don't skip the corners. The corners matter.",
      'Add a pinch of salt, a drizzle of honey, or simply enjoy it as it is.',
      "That's it. Warm, crisp, golden toast. Thanks for watching, and happy toasting.",
    ].join('\n\n'),
  };

  function clamp(value, min, max) {
    const n = Number(value);
    if (!Number.isFinite(n)) return min;
    return Math.min(max, Math.max(min, n));
  }

  function countWords(text) {
    const words = String(text == null ? '' : text).trim().match(/\S+/g);
    return words ? words.length : 0;
  }

  /** Seconds needed to read `words` at `wpm` words per minute. */
  function readTimeSeconds(words, wpm) {
    if (!(words > 0) || !(wpm > 0)) return 0;
    return Math.round((words / wpm) * 60);
  }

  /** 75 -> "1:15", 3725 -> "1:02:05". */
  function formatDuration(totalSeconds) {
    const s = Math.max(0, Math.round(Number(totalSeconds) || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = String(s % 60).padStart(2, '0');
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
  }

  /**
   * Scroll speed so that `wpm` words pass the reading line each minute,
   * given the rendered height of the text holding `words` words.
   */
  function pixelsPerSecond(wpm, words, textHeight) {
    if (!(words > 0) || !(textHeight > 0) || !(wpm > 0)) return 0;
    return (wpm / 60) * (textHeight / words);
  }

  /** Split a script into paragraphs on blank lines. */
  function paragraphs(text) {
    return String(text == null ? '' : text)
      .replace(/\r\n?/g, '\n')
      .split(/\n[ \t]*\n/)
      .map((p) => p.trim())
      .filter(Boolean);
  }

  function normalizeSettings(input) {
    const src = input && typeof input === 'object' ? input : {};
    const out = Object.assign({}, DEFAULT_SETTINGS);
    for (const key of Object.keys(LIMITS)) {
      if (src[key] !== undefined && Number.isFinite(Number(src[key]))) {
        out[key] = Math.round(clamp(src[key], LIMITS[key][0], LIMITS[key][1]));
      }
    }
    for (const key of ['mirror', 'readingLine', 'countdown']) {
      if (typeof src[key] === 'boolean') out[key] = src[key];
    }
    return out;
  }

  function loadSettings(storage, fallback) {
    let raw = null;
    try {
      raw = storage.getItem(SETTINGS_KEY);
    } catch (e) {
      /* storage blocked: use defaults */
    }
    if (raw) {
      try {
        return normalizeSettings(JSON.parse(raw));
      } catch (e) {
        /* corrupt: fall through */
      }
    }
    return normalizeSettings(fallback);
  }

  function saveSettings(storage, settings) {
    try {
      storage.setItem(SETTINGS_KEY, JSON.stringify(normalizeSettings(settings)));
      return true;
    } catch (e) {
      return false;
    }
  }

  let idCounter = 0;
  function makeId() {
    idCounter += 1;
    return `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}${idCounter}`;
  }

  /**
   * Script library persisted to a Storage-like object (localStorage).
   * Seeds the sample script on the very first visit only.
   */
  function createLibrary(storage, options) {
    const now = (options && options.now) || (() => Date.now());
    let scripts = [];
    let currentId = null;
    let storageOk = true;

    function persist() {
      try {
        storage.setItem(LIBRARY_KEY, JSON.stringify({ scripts, currentId }));
        storageOk = true;
      } catch (e) {
        storageOk = false;
      }
      return storageOk;
    }

    function cleanScript(s) {
      if (!s || typeof s !== 'object' || typeof s.id !== 'string') return null;
      return {
        id: s.id,
        title: typeof s.title === 'string' ? s.title : '',
        body: typeof s.body === 'string' ? s.body : '',
        created: Number(s.created) || now(),
        updated: Number(s.updated) || now(),
      };
    }

    function load() {
      let raw = null;
      try {
        raw = storage.getItem(LIBRARY_KEY);
      } catch (e) {
        storageOk = false;
      }
      let parsed = null;
      if (raw) {
        try {
          parsed = JSON.parse(raw);
        } catch (e) {
          parsed = null;
        }
      }
      if (parsed && Array.isArray(parsed.scripts)) {
        scripts = parsed.scripts.map(cleanScript).filter(Boolean);
        currentId = scripts.some((s) => s.id === parsed.currentId)
          ? parsed.currentId
          : scripts[0]
          ? scripts[0].id
          : null;
      } else {
        scripts = [];
        currentId = null;
        const sample = create(SAMPLE_SCRIPT);
        currentId = sample.id;
      }
      persist();
    }

    function get(id) {
      const s = scripts.find((x) => x.id === id);
      return s ? Object.assign({}, s) : null;
    }

    function list() {
      return scripts
        .slice()
        .sort((a, b) => b.updated - a.updated)
        .map((s) => Object.assign({}, s));
    }

    function create(fields) {
      const t = now();
      const s = {
        id: makeId(),
        title: String((fields && fields.title) || ''),
        body: String((fields && fields.body) || ''),
        created: t,
        updated: t,
      };
      scripts.push(s);
      currentId = s.id;
      persist();
      return Object.assign({}, s);
    }

    function update(id, patch) {
      const s = scripts.find((x) => x.id === id);
      if (!s) return null;
      if (patch && typeof patch.title === 'string') s.title = patch.title;
      if (patch && typeof patch.body === 'string') s.body = patch.body;
      s.updated = now();
      persist();
      return Object.assign({}, s);
    }

    function remove(id) {
      const before = scripts.length;
      scripts = scripts.filter((x) => x.id !== id);
      if (scripts.length === before) return false;
      if (currentId === id) {
        const next = list()[0];
        currentId = next ? next.id : null;
      }
      persist();
      return true;
    }

    function select(id) {
      if (!scripts.some((x) => x.id === id)) return false;
      currentId = id;
      persist();
      return true;
    }

    load();

    return {
      list,
      get,
      create,
      update,
      remove,
      select,
      current: () => (currentId ? get(currentId) : null),
      get currentId() {
        return currentId;
      },
      get storageOk() {
        return storageOk;
      },
    };
  }

  /** Best recording format this browser supports; MP4 first because it plays everywhere. */
  function pickMimeType(isTypeSupported) {
    const candidates = [
      'video/mp4;codecs=avc1,mp4a',
      'video/mp4',
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm',
    ];
    if (typeof isTypeSupported !== 'function') return '';
    for (const type of candidates) {
      try {
        if (isTypeSupported(type)) return type;
      } catch (e) {
        /* ignore */
      }
    }
    return '';
  }

  function extensionFor(mimeType) {
    return /mp4/i.test(String(mimeType || '')) ? 'mp4' : 'webm';
  }

  function recordingFilename(title, date, ext) {
    const slug =
      String(title || '')
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 50) || 'recording';
    const d = date instanceof Date ? date : new Date();
    const p = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(
      d.getMinutes()
    )}-${p(d.getSeconds())}`;
    return `${slug}_${stamp}.${ext || 'webm'}`;
  }

  /** Human message for a getUserMedia failure. */
  function cameraErrorMessage(err) {
    const name = err && err.name;
    if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') {
      return 'Camera access was denied, so recording is off. The prompter still works. To record, allow camera access for this page in your browser settings and press Record again.';
    }
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') {
      return 'No camera was found. The prompter still works; connect a camera and press Record again to record.';
    }
    if (name === 'NotReadableError' || name === 'TrackStartError') {
      return 'The camera is busy in another app. Close that app and press Record again. The prompter still works.';
    }
    return 'The camera could not be started. The prompter still works without it.';
  }

  return {
    LIBRARY_KEY,
    SETTINGS_KEY,
    LIMITS,
    DEFAULT_SETTINGS,
    SAMPLE_SCRIPT,
    clamp,
    countWords,
    readTimeSeconds,
    formatDuration,
    pixelsPerSecond,
    paragraphs,
    normalizeSettings,
    loadSettings,
    saveSettings,
    createLibrary,
    pickMimeType,
    extensionFor,
    recordingFilename,
    cameraErrorMessage,
  };
});
