/* SteadyRead app: DOM wiring for the script library, prompter and recorder. */
(function () {
  'use strict';

  const C = window.SteadyCore;
  const $ = (id) => document.getElementById(id);

  let storage;
  try {
    storage = window.localStorage;
  } catch (e) {
    storage = null;
  }
  if (!storage) {
    // Storage is unavailable (e.g. blocked); keep scripts in memory for this visit.
    const mem = {};
    storage = {
      getItem: (k) => (k in mem ? mem[k] : null),
      setItem: () => {
        throw new Error('storage unavailable');
      },
    };
  }

  const smallScreen = window.matchMedia && window.matchMedia('(max-width: 720px)').matches;
  const settings = C.loadSettings(storage, { fontSize: smallScreen ? 36 : 56, margin: smallScreen ? 4 : 10 });
  const library = C.createLibrary(storage);

  /* ======================= Library / editor ======================= */

  const el = {
    storageWarning: $('storageWarning'),
    list: $('scriptList'),
    editor: $('editor'),
    empty: $('emptyState'),
    title: $('titleInput'),
    body: $('bodyInput'),
    wordCount: $('wordCount'),
    readTime: $('readTime'),
    editorWpm: $('editorWpm'),
    saveStatus: $('saveStatus'),
  };

  let saveTimer = null;
  let pendingEdit = false;

  function showStorageState() {
    el.storageWarning.hidden = library.storageOk;
  }

  function renderList() {
    const items = library.list();
    const frag = document.createDocumentFragment();
    for (const s of items) {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.dataset.id = s.id;
      if (s.id === library.currentId) btn.setAttribute('aria-current', 'true');
      const t = document.createElement('span');
      t.className = 'item-title';
      t.textContent = s.title.trim() || 'Untitled script';
      const m = document.createElement('span');
      m.className = 'item-meta';
      const words = C.countWords(s.body);
      m.textContent = `${words} word${words === 1 ? '' : 's'} · ${C.formatDuration(
        C.readTimeSeconds(words, settings.wpm)
      )} · ${new Date(s.updated).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
      btn.append(t, m);
      li.append(btn);
      frag.append(li);
    }
    el.list.replaceChildren(frag);
  }

  function updateMeta() {
    const words = C.countWords(el.body.value);
    el.wordCount.textContent = `${words} word${words === 1 ? '' : 's'}`;
    el.readTime.textContent = C.formatDuration(C.readTimeSeconds(words, settings.wpm));
  }

  function renderEditor() {
    const s = library.current();
    el.editor.hidden = !s;
    el.empty.hidden = !!s;
    if (s) {
      el.title.value = s.title;
      el.body.value = s.body;
    }
    el.editorWpm.value = settings.wpm;
    el.saveStatus.textContent = '';
    updateMeta();
  }

  function flushEdit() {
    clearTimeout(saveTimer);
    if (!pendingEdit) return;
    pendingEdit = false;
    const id = library.currentId;
    if (!id) return;
    library.update(id, { title: el.title.value, body: el.body.value });
    el.saveStatus.textContent = library.storageOk ? 'Saved' : 'Not saved: storage blocked';
    showStorageState();
    renderList();
  }

  function onEdit() {
    pendingEdit = true;
    el.saveStatus.textContent = 'Saving…';
    updateMeta();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushEdit, 400);
  }

  function newScript() {
    flushEdit();
    library.create({ title: '', body: '' });
    renderList();
    renderEditor();
    el.title.focus();
  }

  el.title.addEventListener('input', onEdit);
  el.body.addEventListener('input', onEdit);
  el.title.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      el.body.focus();
    }
  });
  window.addEventListener('beforeunload', flushEdit);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushEdit();
  });

  el.list.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-id]');
    if (!btn) return;
    flushEdit();
    library.select(btn.dataset.id);
    renderList();
    renderEditor();
  });

  $('newScript').addEventListener('click', newScript);
  $('emptyNew').addEventListener('click', newScript);

  $('deleteScript').addEventListener('click', () => {
    const s = library.current();
    if (!s) return;
    const name = s.title.trim() || 'Untitled script';
    if (!window.confirm(`Delete "${name}"? This can't be undone.`)) return;
    pendingEdit = false;
    clearTimeout(saveTimer);
    library.remove(s.id);
    renderList();
    renderEditor();
  });

  el.editorWpm.addEventListener('input', () => {
    const v = Number(el.editorWpm.value);
    if (v >= C.LIMITS.wpm[0] && v <= C.LIMITS.wpm[1]) {
      settings.wpm = Math.round(v);
      C.saveSettings(storage, settings);
      updateMeta();
      renderList();
    }
  });
  el.editorWpm.addEventListener('change', () => {
    setWpm(el.editorWpm.value);
  });

  $('openPrompter').addEventListener('click', openPrompter);

  /* ======================= Prompter ======================= */

  const p = {
    root: $('prompter'),
    stage: $('stage'),
    mirrorBox: $('mirrorBox'),
    scroller: $('scroller'),
    text: $('scriptText'),
    line: $('readingLine'),
    countdown: $('countdown'),
    timeLeft: $('timeLeft'),
    play: $('playBtn'),
    wpmDisplay: $('wpmDisplay'),
    settingsPanel: $('settingsPanel'),
    settingsBtn: $('settingsBtn'),
    notice: $('notice'),
    noticeText: $('noticeText'),
    noticeLink: $('noticeLink'),
    cam: $('camPreview'),
    recBtn: $('recordBtn'),
    recBadge: $('recBadge'),
    recTime: $('recTime'),
  };

  const ctl = {
    wpm: $('wpmRange'),
    size: $('sizeRange'),
    margin: $('marginRange'),
    line: $('lineRange'),
    mirror: $('mirrorToggle'),
    lineOn: $('lineToggle'),
    countdown: $('countdownToggle'),
  };

  const LINE_HEIGHT = 1.45; // matches .script-text line-height in styles.css
  let isOpen = false;
  let playing = false;
  let counting = false;
  let countdownTimer = null;
  let rafId = 0;
  let lastFrame = 0;
  let pos = 0; // pixels scrolled
  let maxPos = 0;
  let pps = 0; // pixels per second
  let words = 0;
  let idleTimer = null;
  let wakeLock = null;

  function render() {
    p.scroller.style.transform = `translate3d(0, ${(-pos).toFixed(2)}px, 0)`;
    const remaining = pps > 0 ? (maxPos - pos) / pps : 0;
    p.timeLeft.textContent = `${C.formatDuration(remaining)} left`;
  }

  function setPos(v) {
    pos = C.clamp(v, 0, maxPos);
    render();
  }

  function relayout() {
    if (!isOpen) return;
    const frac = maxPos > 0 ? pos / maxPos : 0;
    const stageH = p.stage.clientHeight;
    const lineY = (stageH * settings.linePosition) / 100;
    p.text.style.fontSize = `${settings.fontSize}px`;
    p.scroller.style.paddingLeft = `${settings.margin}%`;
    p.scroller.style.paddingRight = `${settings.margin}%`;
    const lineHeight = settings.fontSize * LINE_HEIGHT;
    // Centre the first line of text on the reading line.
    p.scroller.style.paddingTop = `${Math.max(0, lineY - lineHeight / 2)}px`;
    p.scroller.style.paddingBottom = `${stageH}px`;
    p.line.style.top = `${lineY - lineHeight / 2}px`;
    p.line.style.height = `${lineHeight}px`;
    p.line.hidden = !settings.readingLine;
    p.mirrorBox.classList.toggle('mirrored', settings.mirror);
    maxPos = p.text.offsetHeight;
    pps = C.pixelsPerSecond(settings.wpm, words, maxPos);
    pos = frac * maxPos;
    render();
  }

  function syncControls() {
    ctl.wpm.value = settings.wpm;
    ctl.size.value = settings.fontSize;
    ctl.margin.value = settings.margin;
    ctl.line.value = settings.linePosition;
    ctl.mirror.checked = settings.mirror;
    ctl.lineOn.checked = settings.readingLine;
    ctl.countdown.checked = settings.countdown;
    $('wpmOut').textContent = settings.wpm;
    $('sizeOut').textContent = settings.fontSize;
    $('marginOut').textContent = settings.margin;
    $('lineOut').textContent = settings.linePosition;
    p.wpmDisplay.textContent = `${settings.wpm} wpm`;
    el.editorWpm.value = settings.wpm;
  }

  function applySettings(patch) {
    Object.assign(settings, C.normalizeSettings(Object.assign({}, settings, patch)));
    C.saveSettings(storage, settings);
    syncControls();
    relayout();
    updateMeta();
  }

  function setWpm(v) {
    applySettings({ wpm: v });
    renderList();
  }

  function tick(now) {
    if (!playing) return;
    const dt = Math.min(0.1, (now - lastFrame) / 1000);
    lastFrame = now;
    pos += pps * dt;
    if (pos >= maxPos) {
      pos = maxPos;
      render();
      pause();
      return;
    }
    render();
    rafId = requestAnimationFrame(tick);
  }

  function startPlaying() {
    if (playing) return;
    if (pos >= maxPos - 0.5) setPos(0);
    playing = true;
    p.root.classList.add('playing');
    p.play.textContent = '❚❚';
    p.play.setAttribute('aria-label', 'Pause');
    lastFrame = performance.now();
    rafId = requestAnimationFrame(tick);
    bumpIdle();
  }

  function cancelCountdown() {
    clearInterval(countdownTimer);
    counting = false;
    p.countdown.hidden = true;
  }

  function pause() {
    cancelCountdown();
    playing = false;
    cancelAnimationFrame(rafId);
    p.root.classList.remove('playing');
    p.play.textContent = '▶';
    p.play.setAttribute('aria-label', 'Play');
  }

  function play() {
    if (playing || counting) return;
    if (!settings.countdown) {
      startPlaying();
      return;
    }
    if (pos >= maxPos - 0.5) setPos(0);
    counting = true;
    let n = 3;
    p.countdown.textContent = n;
    p.countdown.hidden = false;
    p.play.textContent = '❚❚';
    p.play.setAttribute('aria-label', 'Cancel countdown');
    countdownTimer = setInterval(() => {
      n -= 1;
      if (n > 0) {
        p.countdown.textContent = n;
        return;
      }
      cancelCountdown();
      startPlaying();
    }, 1000);
  }

  function togglePlay() {
    if (playing || counting) pause();
    else play();
  }

  function nudge(lines) {
    setPos(pos + lines * settings.fontSize * LINE_HEIGHT);
  }

  function bumpIdle() {
    p.root.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => p.root.classList.add('idle'), 2500);
  }

  async function requestWakeLock() {
    try {
      if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
    } catch (e) {
      wakeLock = null;
    }
  }

  function isFullscreen() {
    return !!(document.fullscreenElement || document.webkitFullscreenElement);
  }

  function enterFullscreen() {
    const r = p.root;
    try {
      const req = r.requestFullscreen || r.webkitRequestFullscreen;
      const res = req && req.call(r);
      if (res && res.catch) res.catch(() => {});
    } catch (e) {
      /* fullscreen not allowed: the overlay already fills the window */
    }
  }

  function exitFullscreen() {
    try {
      const exit = document.exitFullscreen || document.webkitExitFullscreen;
      if (isFullscreen() && exit) {
        const res = exit.call(document);
        if (res && res.catch) res.catch(() => {});
      }
    } catch (e) {
      /* ignore */
    }
  }

  function openPrompter() {
    flushEdit();
    const s = library.current();
    if (!s) return;
    const paras = C.paragraphs(s.body);
    words = C.countWords(s.body);
    const frag = document.createDocumentFragment();
    if (!paras.length) {
      const para = document.createElement('p');
      para.textContent = 'This script is empty. Go back and write something to read.';
      frag.append(para);
    }
    for (const text of paras) {
      const para = document.createElement('p');
      para.textContent = text;
      frag.append(para);
    }
    p.text.replaceChildren(frag);
    hideNotice();
    p.settingsPanel.hidden = true;
    p.settingsBtn.setAttribute('aria-expanded', 'false');
    document.getElementById('app').hidden = true;
    p.root.hidden = false;
    isOpen = true;
    pos = 0;
    maxPos = 0;
    syncControls();
    relayout();
    enterFullscreen();
    requestWakeLock();
    bumpIdle();
    p.play.focus({ preventScroll: true });
  }

  function closePrompter() {
    if (!isOpen) return;
    if (isRecording()) stopRecording();
    pause();
    exitFullscreen();
    if (wakeLock) {
      wakeLock.release().catch(() => {});
      wakeLock = null;
    }
    isOpen = false;
    p.root.hidden = true;
    document.getElementById('app').hidden = false;
    renderList();
    renderEditor();
  }

  function showNotice(text, link) {
    p.noticeText.textContent = text;
    if (link) {
      p.noticeLink.href = link.href;
      p.noticeLink.download = link.download || '';
      p.noticeLink.textContent = link.label;
      p.noticeLink.hidden = false;
    } else {
      p.noticeLink.hidden = true;
      p.noticeLink.removeAttribute('href');
    }
    p.notice.hidden = false;
  }

  function hideNotice() {
    p.notice.hidden = true;
  }

  /* ---- prompter controls ---- */

  // Keep focus off buttons after a click so Space never "clicks" the last button pressed.
  p.root.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) b.blur();
  });

  p.play.addEventListener('click', togglePlay);
  $('exitPrompter').addEventListener('click', closePrompter);
  $('restartBtn').addEventListener('click', () => {
    pause();
    setPos(0);
  });
  $('slowerBtn').addEventListener('click', () => setWpm(settings.wpm - 10));
  $('fasterBtn').addEventListener('click', () => setWpm(settings.wpm + 10));
  $('fullscreenBtn').addEventListener('click', () => (isFullscreen() ? exitFullscreen() : enterFullscreen()));
  $('noticeClose').addEventListener('click', hideNotice);
  p.settingsBtn.addEventListener('click', () => {
    const open = p.settingsPanel.hidden;
    p.settingsPanel.hidden = !open;
    p.settingsBtn.setAttribute('aria-expanded', String(open));
  });

  ctl.wpm.addEventListener('input', () => setWpm(ctl.wpm.value));
  ctl.size.addEventListener('input', () => applySettings({ fontSize: ctl.size.value }));
  ctl.margin.addEventListener('input', () => applySettings({ margin: ctl.margin.value }));
  ctl.line.addEventListener('input', () => applySettings({ linePosition: ctl.line.value }));
  ctl.mirror.addEventListener('change', () => applySettings({ mirror: ctl.mirror.checked }));
  ctl.lineOn.addEventListener('change', () => applySettings({ readingLine: ctl.lineOn.checked }));
  ctl.countdown.addEventListener('change', () => applySettings({ countdown: ctl.countdown.checked }));

  // Tap the text to play/pause; drag it to move through the script by hand.
  let drag = null;
  p.stage.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    drag = { y: e.clientY, start: pos, moved: false, id: e.pointerId };
    try {
      p.stage.setPointerCapture(e.pointerId);
    } catch (err) {
      /* ignore */
    }
  });
  p.stage.addEventListener('pointermove', (e) => {
    bumpIdle();
    if (!drag || drag.id !== e.pointerId) return;
    const dy = e.clientY - drag.y;
    if (Math.abs(dy) > 8) drag.moved = true;
    if (drag.moved) setPos(drag.start - dy);
  });
  p.stage.addEventListener('pointerup', (e) => {
    if (!drag || drag.id !== e.pointerId) return;
    const wasTap = !drag.moved;
    drag = null;
    if (wasTap) {
      if (!p.settingsPanel.hidden) {
        p.settingsPanel.hidden = true;
        p.settingsBtn.setAttribute('aria-expanded', 'false');
      } else {
        togglePlay();
      }
    }
  });
  p.stage.addEventListener('pointercancel', () => {
    drag = null;
  });
  p.stage.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      setPos(pos + e.deltaY);
    },
    { passive: false }
  );
  p.root.addEventListener('pointermove', bumpIdle);

  function isTypingTarget(t) {
    if (!t || !t.tagName) return false;
    if (t.tagName === 'TEXTAREA' || t.isContentEditable) return true;
    if (t.tagName === 'INPUT') return !['range', 'checkbox', 'button'].includes(t.type);
    return false;
  }

  window.addEventListener(
    'keydown',
    (e) => {
      if (!isOpen || e.ctrlKey || e.metaKey || e.altKey) return;
      if (isTypingTarget(e.target)) return;
      let handled = true;
      switch (e.key) {
        case ' ':
        case 'Spacebar':
          if (!e.repeat) togglePlay();
          break;
        case 'ArrowDown':
          nudge(1);
          break;
        case 'ArrowUp':
          nudge(-1);
          break;
        case 'PageDown':
          nudge(5);
          break;
        case 'PageUp':
          nudge(-5);
          break;
        case 'ArrowRight':
          setWpm(settings.wpm + 10);
          break;
        case 'ArrowLeft':
          setWpm(settings.wpm - 10);
          break;
        case 'Home':
          pause();
          setPos(0);
          break;
        case 'End':
          setPos(maxPos);
          break;
        case '+':
        case '=':
          applySettings({ fontSize: settings.fontSize + 4 });
          break;
        case '-':
        case '_':
          applySettings({ fontSize: settings.fontSize - 4 });
          break;
        case 'm':
        case 'M':
          applySettings({ mirror: !settings.mirror });
          break;
        case 'Escape':
          if (!isFullscreen()) closePrompter();
          break;
        default:
          handled = false;
      }
      if (handled) {
        e.preventDefault();
        bumpIdle();
      }
    },
    true
  );
  // Swallow Space keyup so a focused control is never activated as well.
  window.addEventListener(
    'keyup',
    (e) => {
      if (isOpen && (e.key === ' ' || e.key === 'Spacebar') && !isTypingTarget(e.target)) e.preventDefault();
    },
    true
  );

  window.addEventListener('resize', relayout);
  document.addEventListener('fullscreenchange', relayout);
  document.addEventListener('webkitfullscreenchange', relayout);
  document.addEventListener('visibilitychange', () => {
    if (isOpen && document.visibilityState === 'visible') requestWakeLock();
  });

  /* ======================= Recording ======================= */

  let recorder = null;
  let stream = null;
  let chunks = [];
  let recStarted = 0;
  let recTimer = null;
  let lastUrl = null;
  let starting = false;

  function isRecording() {
    return !!(recorder && recorder.state !== 'inactive');
  }

  function stopTracks() {
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null;
    p.cam.srcObject = null;
    p.cam.hidden = true;
  }

  async function getCameraStream() {
    const video = { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } };
    try {
      return await navigator.mediaDevices.getUserMedia({ video, audio: true });
    } catch (err) {
      // No microphone? Record video only rather than failing.
      if (err && (err.name === 'NotFoundError' || err.name === 'OverconstrainedError')) {
        return navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      }
      throw err;
    }
  }

  async function startRecording() {
    if (starting) return;
    hideNotice();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || typeof MediaRecorder === 'undefined') {
      showNotice('This browser cannot record from the camera on this page. The prompter still works.');
      return;
    }
    starting = true;
    p.recBtn.disabled = true;
    try {
      stream = await getCameraStream();
    } catch (err) {
      stream = null;
      showNotice(C.cameraErrorMessage(err));
      return;
    } finally {
      starting = false;
      p.recBtn.disabled = false;
    }
    if (!isOpen) {
      stopTracks();
      return;
    }

    p.cam.srcObject = stream;
    p.cam.hidden = false;
    const playRes = p.cam.play();
    if (playRes && playRes.catch) playRes.catch(() => {});

    const mimeType = C.pickMimeType((t) => MediaRecorder.isTypeSupported(t));
    try {
      recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    } catch (err) {
      stopTracks();
      showNotice('Recording is not supported in this browser. The prompter still works.');
      return;
    }
    chunks = [];
    const title = (library.current() || {}).title;
    recorder.addEventListener('dataavailable', (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    });
    recorder.addEventListener('stop', () => {
      const type = recorder.mimeType || mimeType || 'video/webm';
      const blob = new Blob(chunks, { type });
      chunks = [];
      recorder = null;
      stopTracks();
      setRecUi(false);
      saveRecording(blob, C.recordingFilename(title, new Date(), C.extensionFor(type)));
    });
    recorder.start(1000);
    recStarted = Date.now();
    setRecUi(true);
    if (!playing && !counting) play();
  }

  function stopRecording() {
    if (isRecording()) recorder.stop();
  }

  function setRecUi(on) {
    p.recBtn.classList.toggle('on', on);
    p.recBtn.textContent = on ? '■' : '●';
    p.recBtn.setAttribute('aria-label', on ? 'Stop recording' : 'Start recording');
    p.recBadge.hidden = !on;
    clearInterval(recTimer);
    if (on) {
      p.recTime.textContent = '0:00';
      recTimer = setInterval(() => {
        p.recTime.textContent = C.formatDuration((Date.now() - recStarted) / 1000);
      }, 500);
    }
  }

  function saveRecording(blob, filename) {
    if (lastUrl) URL.revokeObjectURL(lastUrl);
    lastUrl = URL.createObjectURL(blob);
    const a = $('downloadLink');
    a.href = lastUrl;
    a.download = filename;
    a.dataset.size = String(blob.size);
    a.click();
    const msg = `Recording saved as ${filename}. If the download didn't start,`;
    if (isOpen) showNotice(msg, { href: lastUrl, download: filename, label: 'download it here' });
  }

  p.recBtn.addEventListener('click', () => {
    if (isRecording()) stopRecording();
    else startRecording();
  });

  /* ======================= Start ======================= */

  showStorageState();
  syncControls();
  renderList();
  renderEditor();

  // Read-only hooks for the automated tests.
  window.SteadyRead = {
    state: () => ({ isOpen, playing, counting, pos, maxPos, pps, words, recording: isRecording() }),
    settings: () => Object.assign({}, settings),
  };
})();
