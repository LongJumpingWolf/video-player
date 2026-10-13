(() => {
  'use strict';

  const COUNTDOWN_SECONDS = 10;
  const HOLD_MS = 200;        // stationary press needed to start hold-speed (a normal tap is shorter)
  const HOLD_SLOP = 10;       // px of movement allowed before a press counts as a pan
  const SPEED_STEP_PX = 32;   // horizontal drag per speed step while holding
  const MAX_ZOOM = 8;
  const HIDE_AFTER_MS = 3000;

  const $ = id => document.getElementById(id);
  const player = $('player'), stage = $('stage'), video = $('video');
  const els = {
    title: $('title'), cur: $('cur'), rem: $('rem'), track: $('track'), fill: $('fill'), knob: $('knob'),
    settings: $('settings'), queue: $('queue'), queueList: $('queueList'), queueCount: $('queueCount'),
    zoomBadge: $('zoomBadge'), upnext: $('upnext'), file: $('file'),
    spdVal: $('spdVal'), skipSeg: $('skipSeg'), backNum: $('backNum'), fwdNum: $('fwdNum'),
  };

  /* ---------- Persistent prefs ---------- */
  const prefs = { speed: 1, skip: 10, maxSpeed: 3 };
  try { Object.assign(prefs, JSON.parse(localStorage.getItem('offlinePlayerPrefs') || '{}')); } catch {}
  const savePrefs = () => { try { localStorage.setItem('offlinePlayerPrefs', JSON.stringify(prefs)); } catch {} };

  /* ---------- Helpers ---------- */
  const fmt = s => {
    if (!isFinite(s) || s < 0) s = 0;
    s = Math.floor(s);
    const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), sec = s % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(sec).padStart(2, '0');
  };
  const stripExt = n => n.replace(/\.[^.]+$/, '');
  const esc = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const CLOSE_SVG = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>';

  /* ---------- Queue state ---------- */
  let items = [];      // { id, file, name, url, thumb, duration }
  let index = -1;
  let nextId = 1;

  function addFiles(fileList) {
    const files = [...fileList].filter(f => f.type.startsWith('video/') || /\.(mp4|mkv|webm|mov|m4v|avi|ogv)$/i.test(f.name));
    if (!files.length) return;
    const wasEmpty = items.length === 0 || index < 0;
    const added = files.map(file => ({ id: nextId++, file, name: stripExt(file.name), url: URL.createObjectURL(file), thumb: '', duration: 0 }));
    items.push(...added);
    renderQueue();
    if (wasEmpty) playIndex(items.indexOf(added[0]));
    added.forEach(it => makeThumb(it));
  }

  // Grab a frame + duration using a throwaway video element (serialised so big files don't pile up)
  let thumbChain = Promise.resolve();
  function makeThumb(item) {
    thumbChain = thumbChain.then(() => new Promise(resolve => {
      const v = document.createElement('video');
      v.muted = true; v.preload = 'auto'; v.src = item.url;
      const done = () => { v.removeAttribute('src'); v.load(); resolve(); };
      const timer = setTimeout(done, 8000);
      v.onloadedmetadata = () => {
        item.duration = v.duration;
        v.currentTime = Math.min(v.duration * 0.1 || 0, 10);
      };
      v.onseeked = () => {
        try {
          const c = document.createElement('canvas');
          const w = 320, h = Math.round(w * (v.videoHeight / v.videoWidth || 9 / 16));
          c.width = w; c.height = h;
          c.getContext('2d').drawImage(v, 0, 0, w, h);
          item.thumb = c.toDataURL('image/jpeg', .7);
        } catch {}
        clearTimeout(timer); renderQueue(); done();
      };
      v.onerror = () => { clearTimeout(timer); done(); };
    }));
  }

  function renderQueue() {
    els.queueCount.textContent = items.length;
    els.queueCount.hidden = items.length === 0;
    els.queueList.innerHTML = items.map((it, i) => `
      <li data-i="${i}" class="${i === index ? 'current' : ''}">
        <div class="t">${it.thumb ? `<img src="${it.thumb}" alt="">` : ''}${it.duration ? `<em>${fmt(it.duration)}</em>` : ''}</div>
        <div class="n">${esc(it.name)}${i === index ? '<small>Now playing</small>' : ''}</div>
        <button class="rm" data-rm="${i}" aria-label="Remove">${CLOSE_SVG}</button>
      </li>`).join('');
  }

  function playIndex(i) {
    if (i < 0 || i >= items.length) return;
    cancelCountdown();
    index = i;
    const it = items[i];
    video.src = it.url;
    video.playbackRate = prefs.speed;
    resetZoom();
    els.title.textContent = it.name;
    document.title = it.name + ' · Offline Player';
    player.classList.add('has-video');
    renderQueue();
    video.play().catch(() => {});
    showControls();
  }

  function removeAt(i) {
    const [it] = items.splice(i, 1);
    URL.revokeObjectURL(it.url);
    if (i === index) {
      if (items.length) { index = -1; playIndex(Math.min(i, items.length - 1)); }
      else stopPlayback();
    } else if (i < index) index--;
    renderQueue();
  }

  function stopPlayback() {
    cancelCountdown();
    video.pause(); video.removeAttribute('src'); video.load();
    index = -1; els.title.textContent = '';
    document.title = 'Offline Player';
    player.classList.remove('has-video', 'playing');
    closePanels(); resetZoom(); renderQueue();
  }

  /* ---------- Transport ---------- */
  const toggle = () => video.paused ? video.play().catch(() => {}) : video.pause();
  const seekBy = d => { video.currentTime = Math.max(0, Math.min(video.duration || 0, video.currentTime + d)); };

  video.addEventListener('play', () => { player.classList.add('playing'); scheduleHide(); });
  video.addEventListener('pause', () => { player.classList.remove('playing'); showControls(); });
  video.addEventListener('timeupdate', updateProgress);
  video.addEventListener('loadedmetadata', () => { video.playbackRate = prefs.speed; updateProgress(); });
  video.addEventListener('ended', () => { if (index + 1 < items.length) startCountdown(); else showControls(); });

  function updateProgress() {
    const d = video.duration || 0, t = video.currentTime || 0, p = d ? t / d * 100 : 0;
    els.cur.textContent = fmt(t);
    els.rem.textContent = '-' + fmt(d - t);
    els.fill.style.width = p + '%';
    els.knob.style.left = p + '%';
  }

  // Scrubbing
  let scrubbing = false;
  const scrubTo = e => {
    const r = els.track.getBoundingClientRect();
    const p = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    if (video.duration) video.currentTime = p * video.duration;
  };
  els.track.addEventListener('pointerdown', e => { scrubbing = true; els.track.classList.add('drag'); els.track.setPointerCapture(e.pointerId); scrubTo(e); });
  els.track.addEventListener('pointermove', e => { if (scrubbing) scrubTo(e); });
  const endScrub = () => { scrubbing = false; els.track.classList.remove('drag'); };
  els.track.addEventListener('pointerup', endScrub);
  els.track.addEventListener('pointercancel', endScrub);

  /* ---------- Settings ---------- */
  // 0.25 steps up to 2×, then 0.5 steps, capped at the user's max speed
  function speedSteps() {
    const out = [];
    for (let v = 0.25; v <= prefs.maxSpeed + 1e-9; v += v < 2 ? 0.25 : 0.5) out.push(+v.toFixed(2));
    return out;
  }
  const nearestIdx = (list, v) => list.reduce((b, s, i) => Math.abs(s - v) < Math.abs(list[b] - v) ? i : b, 0);
  function applyPrefs() {
    if (![2, 3, 4, 8].includes(prefs.maxSpeed)) prefs.maxSpeed = 3;
    const list = speedSteps();
    prefs.speed = list[nearestIdx(list, prefs.speed)];
    els.spdVal.textContent = prefs.speed + '×';
    els.backNum.textContent = els.fwdNum.textContent = prefs.skip;
    [...els.skipSeg.children].forEach(b => b.classList.toggle('on', +b.dataset.v === prefs.skip));
    [...$('maxSeg').children].forEach(b => b.classList.toggle('on', +b.dataset.v === prefs.maxSpeed));
    video.playbackRate = prefs.speed;
  }
  function stepSpeed(dir) {
    const list = speedSteps();
    prefs.speed = list[Math.max(0, Math.min(list.length - 1, nearestIdx(list, prefs.speed) + dir))];
    savePrefs(); applyPrefs();
  }
  $('maxSeg').onclick = e => { const b = e.target.closest('button'); if (b) { prefs.maxSpeed = +b.dataset.v; savePrefs(); applyPrefs(); } };
  $('spdDown').onclick = () => stepSpeed(-1);
  $('spdUp').onclick = () => stepSpeed(1);
  els.skipSeg.onclick = e => { const b = e.target.closest('button'); if (b) { prefs.skip = +b.dataset.v; savePrefs(); applyPrefs(); } };

  const closePanels = () => { els.settings.hidden = true; els.queue.hidden = true; };
  $('settingsBtn').onclick = () => { const o = els.settings.hidden; closePanels(); els.settings.hidden = !o; };
  $('queueBtn').onclick = () => { const o = els.queue.hidden; closePanels(); els.queue.hidden = !o; };
  $('queueClose').onclick = closePanels;

  /* ---------- Buttons ---------- */
  $('playBtn').onclick = toggle;
  $('backBtn').onclick = () => seekBy(-prefs.skip);
  $('fwdBtn').onclick = () => seekBy(prefs.skip);
  $('closeBtn').onclick = stopPlayback;
  $('fsBtn').onclick = () => document.fullscreenElement ? document.exitFullscreen() : (player.requestFullscreen || player.webkitRequestFullscreen)?.call(player);
  const openPicker = () => { els.file.value = ''; els.file.click(); };
  $('addBtn').onclick = $('homeOpen').onclick = $('queueAdd').onclick = openPicker;
  els.file.onchange = () => addFiles(els.file.files);
  $('queueClear').onclick = () => { items.forEach(i => URL.revokeObjectURL(i.url)); items = []; stopPlayback(); };

  els.queueList.addEventListener('click', e => {
    const rm = e.target.closest('[data-rm]');
    if (rm) return removeAt(+rm.dataset.rm);
    const li = e.target.closest('li');
    if (li) playIndex(+li.dataset.i);
  });

  /* ---------- Up next countdown ---------- */
  let cdTimer = null, cdEnd = 0;
  const RING_LEN = 2 * Math.PI * 19;
  function startCountdown() {
    const next = items[index + 1];
    if (!next) return;
    $('cdName').textContent = next.name;
    $('cdThumb').src = next.thumb || '';
    $('cdThumb').style.visibility = next.thumb ? 'visible' : 'hidden';
    els.upnext.hidden = false;
    cdEnd = performance.now() + COUNTDOWN_SECONDS * 1000;
    clearInterval(cdTimer);
    const tick = () => {
      const left = Math.max(0, cdEnd - performance.now());
      $('cdNum').textContent = Math.ceil(left / 1000);
      $('cdRing').style.strokeDashoffset = RING_LEN * (1 - left / (COUNTDOWN_SECONDS * 1000));
      if (left <= 0) playIndex(index + 1);
    };
    tick(); cdTimer = setInterval(tick, 100);
  }
  function cancelCountdown() { clearInterval(cdTimer); cdTimer = null; els.upnext.hidden = true; }
  $('cdPlay').onclick = () => playIndex(index + 1);
  $('cdCancel').onclick = () => { cancelCountdown(); showControls(); };

  /* ---------- Zoom (pinch / pan / wheel only: no double-tap zoom, video only) ---------- */
  const z = { s: 1, x: 0, y: 0 };
  const pointers = new Map();
  let gesture = null, badgeTimer = null;

  function clampZoom() {
    z.s = Math.max(1, Math.min(MAX_ZOOM, z.s));
    const w = stage.clientWidth, h = stage.clientHeight;
    const mx = w * (z.s - 1) / 2, my = h * (z.s - 1) / 2;
    z.x = Math.max(-mx, Math.min(mx, z.x));
    z.y = Math.max(-my, Math.min(my, z.y));
    if (z.s === 1) z.x = z.y = 0;
  }
  function applyZoom(flash = true) {
    clampZoom();
    video.style.transform = z.s === 1 ? '' : `translate(${z.x}px, ${z.y}px) scale(${z.s})`;
    const zoomed = z.s > 1.001;
    els.zoomBadge.textContent = z.s.toFixed(1) + '×';
    if (zoomed || flash) {
      els.zoomBadge.hidden = false;
      els.zoomBadge.classList.remove('fade');
      clearTimeout(badgeTimer);
      badgeTimer = setTimeout(() => { if (z.s > 1.001) els.zoomBadge.classList.add('fade'); else els.zoomBadge.hidden = true; }, 1200);
    } else els.zoomBadge.hidden = true;
  }
  function resetZoom() { z.s = 1; z.x = z.y = 0; video.style.transform = ''; els.zoomBadge.hidden = true; }
  els.zoomBadge.onclick = resetZoom;

  // Zoom around a screen point so the content under it stays put
  function zoomAt(newS, px, py) {
    const r = stage.getBoundingClientRect();
    const cx = px - (r.left + r.width / 2), cy = py - (r.top + r.height / 2);
    newS = Math.max(1, Math.min(MAX_ZOOM, newS));
    const k = newS / z.s;
    z.x = cx - (cx - z.x) * k;
    z.y = cy - (cy - z.y) * k;
    z.s = newS;
  }
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

  /* Hold + drag left/right to change speed.
     Press began in the centre third  -> speed change is temporary (restored on release).
     Press began in a left/right third -> the new speed is kept on release. */
  let holdTimer = null, h_vis = false;
  const sb = { el: $('speedBadge'), val: $('sbVal'), hint: $('sbHint') };
  function startHold() {
    if (!gesture || gesture.multi || gesture.moved >= HOLD_SLOP || pointers.size !== 1) return;
    const r = stage.getBoundingClientRect(), f = (gesture.lx - r.left) / r.width;
    const list = speedSteps();
    gesture.hold = { edge: f < 1 / 3 || f > 2 / 3, base: prefs.speed, idx0: nearestIdx(list, prefs.speed), x0: gesture.lx, cur: prefs.speed };
    h_vis = player.classList.contains('controls-visible');
    player.classList.remove('controls-visible');
    showSpeedBadge();
  }
  function showSpeedBadge() {
    const h = gesture.hold;
    sb.val.textContent = '▶▶ ' + h.cur + '×';
    sb.hint.textContent = h.edge ? 'keep' : 'temp';
    sb.el.hidden = false;
  }
  function dragSpeed(x) {
    const h = gesture.hold, list = speedSteps();
    const i = Math.max(0, Math.min(list.length - 1, h.idx0 + Math.round((x - h.x0) / SPEED_STEP_PX)));
    h.cur = list[i];
    video.playbackRate = h.cur;
    showSpeedBadge();
  }
  function endHold(commit) {
    clearTimeout(holdTimer);
    const h = gesture?.hold;
    if (!h) return;
    gesture.hold = null;
    sb.el.hidden = true;
    if (commit && h.edge) { prefs.speed = h.cur; savePrefs(); }
    if (h_vis) showControls();
    applyPrefs();                       // sets playbackRate to prefs.speed (restores in the centre case)
  }

  stage.addEventListener('pointerdown', e => {
    stage.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) {
      gesture = { moved: 0, multi: false, t: performance.now(), lx: e.clientX, ly: e.clientY, hold: null };
      clearTimeout(holdTimer);
      holdTimer = setTimeout(startHold, HOLD_MS);
    }
    if (pointers.size === 2) {
      endHold(false); clearTimeout(holdTimer);
      const [a, b] = [...pointers.values()];
      gesture.multi = true;
      gesture.d0 = dist(a, b); gesture.s0 = z.s;
      gesture.lm = mid(a, b);
    }
  });
  stage.addEventListener('pointermove', e => {
    if (!pointers.has(e.pointerId)) { if (e.pointerType === 'mouse') showControls(); return; }
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size >= 2 && gesture?.d0) {
      const [a, b] = [...pointers.values()], m = mid(a, b);
      z.x += m.x - gesture.lm.x; z.y += m.y - gesture.lm.y;
      gesture.lm = m;
      zoomAt(gesture.s0 * dist(a, b) / gesture.d0, m.x, m.y);
      gesture.moved = 99;
      applyZoom();
    } else if (pointers.size === 1 && gesture) {
      if (gesture.hold) { dragSpeed(e.clientX); gesture.moved = 99; return; }
      const dx = e.clientX - gesture.lx, dy = e.clientY - gesture.ly;
      gesture.lx = e.clientX; gesture.ly = e.clientY;
      gesture.moved += Math.abs(dx) + Math.abs(dy);
      if (gesture.moved >= HOLD_SLOP) clearTimeout(holdTimer);
      if (z.s > 1) { z.x += dx; z.y += dy; applyZoom(false); }
    }
  });
  const upHandler = e => {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    if (pointers.size === 1 && gesture) { // pinch -> pan handoff
      const p = [...pointers.values()][0];
      gesture.lx = p.x; gesture.ly = p.y; gesture.d0 = 0;
    }
    if (pointers.size === 0 && gesture) {
      clearTimeout(holdTimer);
      const held = !!gesture.hold;
      endHold(e.type === 'pointerup');
      const tap = !held && !gesture.multi && gesture.moved < 8 && performance.now() - gesture.t < 350 && e.type === 'pointerup';
      gesture = null;
      if (tap) handleTap(e.clientX);
    }
  };
  stage.addEventListener('contextmenu', e => e.preventDefault());

  /* Rapid taps on the left / right third skip back / forward by the skip interval.
     The first tap behaves normally (toggle controls); follow-up taps within TAP_GAP_MS skip,
     and each extra tap adds another interval (10s, 20s, 30s ...). Centre taps never skip. */
  const TAP_GAP_MS = 350;
  let tapSeq = null, flashTimer = null, ctrlBefore = false;
  function handleTap(x) {
    const r = stage.getBoundingClientRect(), f = (x - r.left) / r.width;
    const side = f < 1 / 3 ? -1 : f > 2 / 3 ? 1 : 0, now = performance.now();
    if (side && tapSeq && tapSeq.side === side && now - tapSeq.t < TAP_GAP_MS) {
      if (tapSeq.n === 0) { // second tap of the sequence: undo the first tap's control toggle
        player.classList.toggle('controls-visible', ctrlBefore);
      }
      tapSeq.n++; tapSeq.t = now;
      seekBy(side * prefs.skip);
      flashSkip(side, tapSeq.n * prefs.skip);
      return;
    }
    ctrlBefore = player.classList.contains('controls-visible');
    tapSeq = side ? { side, t: now, n: 0 } : null;
    ctrlBefore && video.paused === false ? hideControls() : showControls();
  }
  function flashSkip(side, total) {
    const el = $(side < 0 ? 'skipL' : 'skipR');
    $('skipL').hidden = $('skipR').hidden = true;
    el.textContent = side < 0 ? '« ' + total + 's' : total + 's »';
    el.hidden = false;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { el.hidden = true; }, 700);
  }
  stage.addEventListener('pointerup', upHandler);
  stage.addEventListener('pointercancel', upHandler);
  stage.addEventListener('dblclick', e => e.preventDefault());
  stage.addEventListener('wheel', e => {
    e.preventDefault();
    zoomAt(z.s * Math.exp(-e.deltaY * 0.002), e.clientX, e.clientY);
    applyZoom();
  }, { passive: false });
  // iOS Safari pinch gestures would otherwise zoom the whole page
  ['gesturestart', 'gesturechange'].forEach(t => document.addEventListener(t, e => e.preventDefault()));
  window.addEventListener('resize', () => applyZoom(false));

  /* ---------- Controls auto-hide ---------- */
  let hideTimer = null;
  function showControls() { player.classList.add('controls-visible'); scheduleHide(); }
  function hideControls() { if (!video.paused && els.settings.hidden && els.queue.hidden) player.classList.remove('controls-visible'); }
  function scheduleHide() {
    clearTimeout(hideTimer);
    if (!video.paused) hideTimer = setTimeout(hideControls, HIDE_AFTER_MS);
  }
  document.querySelector('.bottom-bar').addEventListener('pointermove', showControls);
  document.addEventListener('pointerdown', e => {
    if (!els.settings.hidden && !e.target.closest('#settings, #settingsBtn')) els.settings.hidden = true;
  });

  /* ---------- Drag & drop ---------- */
  let dragDepth = 0;
  window.addEventListener('dragenter', e => { e.preventDefault(); dragDepth++; player.classList.add('dragging'); });
  window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; player.classList.remove('dragging'); } });
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('drop', e => { e.preventDefault(); dragDepth = 0; player.classList.remove('dragging'); addFiles(e.dataTransfer.files); });

  /* ---------- Keyboard ---------- */
  document.addEventListener('keydown', e => {
    if (!player.classList.contains('has-video')) return;
    const k = e.key.toLowerCase();
    if (k === ' ' || k === 'k') { e.preventDefault(); toggle(); }
    else if (k === 'arrowleft' || k === 'j') seekBy(-prefs.skip);
    else if (k === 'arrowright' || k === 'l') seekBy(prefs.skip);
    else if (k === 'arrowup') { video.volume = Math.min(1, video.volume + .05); e.preventDefault(); }
    else if (k === 'arrowdown') { video.volume = Math.max(0, video.volume - .05); e.preventDefault(); }
    else if (k === 'f') $('fsBtn').click();
    else if (k === 'n') playIndex(index + 1);
    else if (k === 'p') playIndex(index - 1);
    else if (k === 'q') $('queueBtn').click();
    else if (k === '0') resetZoom();
    else if (k === 'escape') { closePanels(); cancelCountdown(); }
    else return;
    showControls();
  });

  applyPrefs();
  renderQueue();
})();
