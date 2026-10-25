/* Shared helpers: icons, ringtone, toasts, avatars, image resizing, chat bubbles. */
(function () {
  'use strict';

  /* ---------- icons (Feather-style, inline SVG) ---------- */
  const P = {
    mic: '<path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/>',
    'mic-off': '<line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/>',
    video: '<polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>',
    'video-off': '<path d="M16 16v1a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2m5.66 0H14a2 2 0 0 1 2 2v3.34l1 1L23 7v10"/><line x1="1" y1="1" x2="23" y2="23"/>',
    flip: '<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>',
    chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    'user-plus': '<path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><line x1="20" y1="8" x2="20" y2="14"/><line x1="23" y1="11" x2="17" y2="11"/>',
    phone: '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>',
    image: '<rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>',
    send: '<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>',
    back: '<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>',
    shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
    logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>',
    x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
    user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
    trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>',
    key: '<path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.78 7.78 5.5 5.5 0 0 1 7.78-7.78zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/>'
  };

  function icon(name, size) {
    const s = size || 22;
    return (
      '<svg viewBox="0 0 24 24" width="' + s + '" height="' + s + '" fill="none" stroke="currentColor" ' +
      'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      (P[name] || '') + '</svg>'
    );
  }
  function setIcon(el, name, size) { el.innerHTML = icon(name, size); }
  function hydrateIcons(root) {
    (root || document).querySelectorAll('[data-icon]').forEach((el) => {
      if (el.dataset.iconDone) return;
      el.insertAdjacentHTML('afterbegin', icon(el.dataset.icon, Number(el.dataset.size) || 22));
      el.dataset.iconDone = '1';
    });
  }

  /* ---------- small formatters ---------- */
  function initials(name) {
    const parts = String(name || '?').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    const a = parts[0][0] || '?';
    const b = parts.length > 1 ? parts[parts.length - 1][0] : '';
    return (a + b).toUpperCase();
  }
  function colorFor(str) {
    let h = 0;
    const s = String(str || '');
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return 'hsl(' + (h % 360) + ' 45% 38%)';
  }
  function avatar(name, size) {
    const el = document.createElement('span');
    el.className = 'avatar';
    el.textContent = initials(name);
    el.style.background = colorFor(name);
    if (size) {
      el.style.width = el.style.height = size + 'px';
      el.style.fontSize = Math.round(size * 0.4) + 'px';
    }
    return el;
  }
  function fmtTime(ts) {
    return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
  function fmtDay(ts) {
    const d = new Date(ts);
    const today = new Date();
    const yest = new Date(Date.now() - 86400000);
    if (d.toDateString() === today.toDateString()) return 'Today';
    if (d.toDateString() === yest.toDateString()) return 'Yesterday';
    return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  }
  function fmtShort(ts) {
    const d = new Date(ts);
    return d.toDateString() === new Date().toDateString()
      ? fmtTime(ts)
      : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }
  function fmtDuration(sec) {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    const h = Math.floor(m / 60);
    const pad = (n) => String(n).padStart(2, '0');
    return h ? h + ':' + pad(m % 60) + ':' + pad(s) : pad(m) + ':' + pad(s);
  }

  /* ---------- toasts ---------- */
  function toast(msg, ms) {
    const root = document.getElementById('toasts');
    if (!root) return;
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = msg;
    root.appendChild(t);
    setTimeout(() => {
      t.classList.add('out');
      setTimeout(() => t.remove(), 300);
    }, ms || 3500);
  }

  /* ---------- ringtone / sounds (WebAudio, no files needed) ---------- */
  const Ring = (function () {
    let ctx = null;
    let timer = null;
    function unlock() {
      try {
        if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
        if (ctx.state === 'suspended') ctx.resume();
      } catch (e) { /* no audio available */ }
    }
    function beep(freq, dur, when, vol) {
      if (!ctx) return;
      const t0 = ctx.currentTime + (when || 0);
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sine';
      o.frequency.value = freq;
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(vol || 0.15, t0 + 0.02);
      g.gain.linearRampToValueAtTime(0, t0 + dur);
      o.connect(g);
      g.connect(ctx.destination);
      o.start(t0);
      o.stop(t0 + dur + 0.05);
    }
    function once() {
      beep(880, 0.3, 0);
      beep(660, 0.3, 0.38);
      beep(880, 0.3, 0.95);
      beep(660, 0.3, 1.33);
      if (navigator.vibrate) navigator.vibrate([300, 150, 300]);
    }
    return {
      unlock,
      start() { this.stop(); unlock(); once(); timer = setInterval(once, 3200); },
      stop() { clearInterval(timer); timer = null; if (navigator.vibrate) navigator.vibrate(0); },
      ding() { unlock(); beep(1200, 0.12, 0, 0.08); beep(1600, 0.14, 0.13, 0.08); }
    };
  })();
  document.addEventListener('pointerdown', () => Ring.unlock());

  /* ---------- images ---------- */
  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Could not read that image.'));
      img.src = url;
    });
  }
  // Resize to a JPEG data URL so chat images stay small and fast.
  async function imageToDataUrl(file, maxSide, quality) {
    if (!file || !/^image\//.test(file.type)) throw new Error('Please choose an image file.');
    maxSide = maxSide || 1280;
    quality = quality || 0.82;
    let src;
    let w;
    let h;
    let revoke = null;
    try {
      src = await createImageBitmap(file, { imageOrientation: 'from-image' });
      w = src.width;
      h = src.height;
    } catch (e) {
      revoke = URL.createObjectURL(file);
      src = await loadImage(revoke);
      w = src.naturalWidth;
      h = src.naturalHeight;
    }
    const scale = Math.min(1, maxSide / Math.max(w, h));
    const cw = Math.max(1, Math.round(w * scale));
    const ch = Math.max(1, Math.round(h * scale));
    const canvas = document.createElement('canvas');
    canvas.width = cw;
    canvas.height = ch;
    const g = canvas.getContext('2d');
    g.fillStyle = '#fff'; // transparent PNGs would turn black in a JPEG
    g.fillRect(0, 0, cw, ch);
    g.drawImage(src, 0, 0, cw, ch);
    if (revoke) URL.revokeObjectURL(revoke);
    if (src.close) src.close();
    return canvas.toDataURL('image/jpeg', quality);
  }

  /* ---------- image viewer ---------- */
  function openViewer(src) {
    const v = document.getElementById('viewer');
    const img = document.getElementById('viewer-img');
    if (!v || !img) return;
    img.src = src;
    v.classList.remove('hidden');
  }

  /* ---------- chat bubble (text via textContent: never HTML) ---------- */
  function bubble(m) {
    const row = document.createElement('div');
    row.className = 'msg ' + (m.mine ? 'mine' : 'theirs');
    const b = document.createElement('div');
    b.className = 'bubble';
    if (m.name && !m.mine) {
      const n = document.createElement('div');
      n.className = 'msg-name';
      n.textContent = m.name;
      b.appendChild(n);
    }
    if (m.image && /^data:image\//.test(m.image)) {
      const img = document.createElement('img');
      img.className = 'msg-img';
      img.src = m.image;
      img.alt = 'Photo';
      img.addEventListener('click', () => openViewer(m.image));
      b.appendChild(img);
    }
    if (m.text) {
      const t = document.createElement('div');
      t.className = 'msg-text';
      t.textContent = m.text;
      b.appendChild(t);
    }
    const time = document.createElement('div');
    time.className = 'msg-time';
    time.textContent = fmtTime(m.ts);
    b.appendChild(time);
    row.appendChild(b);
    return row;
  }

  window.U = {
    icon, setIcon, hydrateIcons, initials, colorFor, avatar,
    fmtTime, fmtDay, fmtShort, fmtDuration,
    toast, Ring, imageToDataUrl, openViewer, bubble
  };
})();
