/* Portfolio site: loads data/content.json, renders the page, runs the lightbox player
   and exposes window.Portfolio (see docs/SPEC.md). Vanilla JS, no dependencies. */
(() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  let content = null;      // current content object (deep clone of the JSON)
  let firstRender = true;  // hero intro animation only plays once
  let revealObs = null;
  let timecodeTimer = null;
  let lastFocus = null;

  /* ---------- small helpers ---------- */

  const clone = (o) => JSON.parse(JSON.stringify(o));
  const str = (v) => (v === undefined || v === null ? '' : String(v));

  // Create an element; text is always set through textContent (no XSS).
  function h(tag, cls, text, attrs) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null && text !== '') node.textContent = text;
    if (attrs) for (const k in attrs) node.setAttribute(k, attrs[k]);
    return node;
  }

  // Only http(s) or relative URLs are ever used in href/src (blocks javascript:, data:, ...).
  function safeUrl(u) {
    u = str(u).trim();
    if (!u) return '';
    if (/^[a-z][a-z0-9+.-]*:/i.test(u)) return /^https?:/i.test(u) ? u : '';
    return u;
  }

  function slug(s, fallback) {
    const out = str(s).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
    return out || fallback;
  }

  function hexToRgb(hex) {
    let m = /^#?([0-9a-f]{3}|[0-9a-f]{6})([0-9a-f]{2})?$/i.exec(str(hex).trim());
    if (!m) return null;
    let c = m[1];
    if (c.length === 3) c = c.split('').map((x) => x + x).join('');
    const n = parseInt(c, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  function hashHue(s) {
    let x = 0;
    for (let i = 0; i < s.length; i++) x = (x * 31 + s.charCodeAt(i)) >>> 0;
    return x % 360;
  }

  /* ---------- video URL parsing ---------- */

  function parseVideo(rawUrl) {
    const url = safeUrl(rawUrl);
    const out = { type: 'unknown', id: '', embedUrl: url, thumb: '' };
    if (!url) return out;

    let u;
    try { u = new URL(url, window.location.href); } catch (e) { return out; }
    const host = u.hostname.replace(/^(www|m)\./i, '').toLowerCase();
    const parts = u.pathname.split('/').filter(Boolean);

    // YouTube: watch?v=, youtu.be/, /shorts/, /embed/ (+ /live/, /v/)
    if (['youtube.com', 'music.youtube.com', 'youtube-nocookie.com', 'youtu.be'].includes(host)) {
      let id = '';
      if (host === 'youtu.be') id = parts[0] || '';
      else if (parts[0] === 'watch') id = u.searchParams.get('v') || '';
      else if (['shorts', 'embed', 'live', 'v'].includes(parts[0])) id = parts[1] || '';
      if (/^[\w-]{11}$/.test(id)) {
        return {
          type: 'youtube',
          id,
          embedUrl: 'https://www.youtube.com/embed/' + id + '?autoplay=1&rel=0&modestbranding=1&playsinline=1',
          thumb: 'https://i.ytimg.com/vi/' + id + '/hqdefault.jpg',
        };
      }
      return out;
    }

    // Vimeo: vimeo.com/<id>[/<hash>] and player.vimeo.com/video/<id>
    if (host === 'vimeo.com' || host === 'player.vimeo.com') {
      const i = parts.findIndex((p) => /^\d+$/.test(p));
      if (i === -1) return out;
      const id = parts[i];
      const next = parts[i + 1] || '';
      const hash = u.searchParams.get('h') || (/^[a-f0-9]{8,}$/i.test(next) ? next : '');
      return {
        type: 'vimeo',
        id,
        embedUrl: 'https://player.vimeo.com/video/' + id + '?autoplay=1&title=0&byline=0&portrait=0' +
          (hash ? '&h=' + encodeURIComponent(hash) : ''),
        thumb: '', // Vimeo has no thumbnail without its API
      };
    }

    // Google Drive share links
    if (host === 'drive.google.com') {
      let id = '';
      const d = parts.indexOf('d');
      if (parts[0] === 'file' && d !== -1) id = parts[d + 1] || '';
      else id = u.searchParams.get('id') || '';
      if (/^[\w-]+$/.test(id)) {
        return { type: 'drive', id, embedUrl: 'https://drive.google.com/file/d/' + id + '/preview', thumb: '' };
      }
      return out;
    }

    // Direct video files (absolute URL or relative path such as media/clip.mp4)
    if (/\.(mp4|webm|mov|m4v)$/i.test(u.pathname)) {
      return { type: 'file', id: '', embedUrl: url, thumb: '' };
    }

    return out;
  }

  /* ---------- hero ---------- */

  function renderHero(site, sections) {
    document.title = (str(site.name) || 'Portfolio') + (site.role ? ' | ' + str(site.role) : '');

    $('#hero-role').textContent = str(site.role);
    $('#hero-intro').textContent = str(site.intro);

    // Kinetic headline: each word cuts in on its own frame; the last one in the accent colour.
    const title = $('#hero-tagline');
    title.replaceChildren();
    title.classList.toggle('no-anim', !firstRender);
    const words = str(site.tagline).split(/\s+/).filter(Boolean);
    const altAt = words.length - 1;
    title.setAttribute('aria-label', words.join(' '));
    words.forEach((w, i) => {
      const wrap = h('span', 'word' + (i === altAt && i > 0 ? ' word-alt' : ''));
      wrap.setAttribute('aria-hidden', 'true');
      const inner = h('span', 'word-in', w);
      inner.style.setProperty('--i', i);
      wrap.appendChild(inner);
      title.appendChild(wrap);
      title.appendChild(document.createTextNode(' '));
    });

    const total = sections.reduce((n, s) => n + (Array.isArray(s.videos) ? s.videos.length : 0), 0);
    const software = str(site.software).trim() || 'DaVinci Resolve';
    $('#hero-meta').textContent = 'Edited in ' + software + '  /  ' + pad2(sections.length) + ' reels  /  ' + pad2(total) + ' clips';
    // Showreel picked in the viewer bar (the current one unless a visitor chose an older one)
    const reels = showreelList(site);
    if (!reels.some((r) => r.url === selectedReel)) selectedReel = reels.length ? reels[0].url : '';
    const picked = reels.find((r) => r.url === selectedReel);
    $('#vw-title').textContent = (str(site.name) ? str(site.name) + ' - ' : '') + (picked ? picked.title : 'Showreel');
    renderReelPicker(reels);

    // the hero button opens the showreel with sound; the transport drives the muted deck behind the hero
    const reel = parseVideo(selectedReel);
    $('#play-showreel').hidden = !selectedReel;
    $('#transport').hidden = !(reel.type === 'youtube' || reel.type === 'file');

    renderHeroMedia(reel, selectedReel);
    startViewerClock();
  }

  /* ---------- showreels: the current one + the ones it replaced (the admin archives them on publish) ---------- */

  let selectedReel = '';

  function showreelList(site) {
    const list = [];
    const cur = str(site.showreel).trim();
    if (cur) {
      const year = str(site.showreelDate).slice(0, 4) || String(new Date().getFullYear());
      list.push({ url: cur, title: 'Showreel ' + year, latest: true });
    }
    (Array.isArray(site.showreelArchive) ? site.showreelArchive : []).forEach((r) => {
      const url = str(r && r.url).trim();
      if (url && !list.some((x) => x.url === url)) list.push({ url, title: str(r.title).trim() || 'Showreel' });
    });
    return list;
  }

  function renderReelPicker(reels) {
    const ul = $('#vw-list');
    ul.replaceChildren();
    reels.forEach((r) => {
      const li = h('li', 'vw-opt', null, { role: 'option', tabindex: '0', 'aria-selected': String(r.url === selectedReel) });
      li.appendChild(h('span', null, r.title));
      if (r.latest) li.appendChild(h('small', null, 'latest'));
      const pick = () => {
        setReelPicker(false);
        if (r.url === selectedReel) return;
        selectedReel = r.url;
        render();
      };
      li.addEventListener('click', pick);
      li.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
      ul.appendChild(li);
    });
  }

  function setReelPicker(open) {
    $('#vw-list').hidden = !open;
    $('#vw-name').setAttribute('aria-expanded', String(open));
    if (open) { const sel = $('#vw-list [aria-selected="true"]'); if (sel) sel.focus(); }
  }

  const pad2 = (n) => String(n).padStart(2, '0');
  // fromHour: timelines start at 01:00:00:00, as in the NLE
  function toTimecode(frames, fromHour) {
    if (fromHour) frames += 3600 * 24;
    const s = Math.floor(frames / 24);
    return pad2(Math.floor(s / 3600)) + ':' + pad2(Math.floor(s / 60) % 60) + ':' + pad2(s % 60) + ':' + pad2(frames % 24);
  }

  /* ---------- hero deck: the showreel behind the hero, driven by the transport (and J / K / L) ---------- */

  // ctl = { play, pause, seek(s), time(), duration(), mute(on) } once a player is ready;
  // dir: -1 reverse, 0 stopped, 1 play; sound: unmuted (full view only)
  const deck = { ctl: null, reel: null, dir: 0, loop: true, revTimer: 0, wantPlay: false, mounted: false, sound: false };

  let ytApi = null;
  function loadYouTubeApi() {
    if (!ytApi) {
      ytApi = new Promise((resolve) => {
        if (window.YT && window.YT.Player) { resolve(window.YT); return; }
        const prev = window.onYouTubeIframeAPIReady;
        window.onYouTubeIframeAPIReady = () => { if (prev) prev(); resolve(window.YT); };
        document.head.appendChild(h('script', null, null, { src: 'https://www.youtube.com/iframe_api', async: '' }));
      });
    }
    return ytApi;
  }

  // The showreel behind the hero. Rebuilt only when its link changes, so admin previews don't reload the player.
  function renderHeroMedia(reel, key) {
    const media = $('#hero-media');
    if (media.dataset.reel === key) return;
    media.dataset.reel = key;
    media.replaceChildren();
    stopReverse();
    Object.assign(deck, { ctl: null, reel, dir: 0, wantPlay: false, mounted: false, sound: false });
    // phones and reduced motion: a still until someone presses play
    const auto = !reduceMotion && window.matchMedia('(min-width: 861px) and (pointer: fine)').matches;

    if (reel.type === 'file') {
      const v = h('video', null, null, { muted: '', playsinline: '', preload: auto ? 'auto' : 'metadata', 'aria-hidden': 'true' });
      v.muted = true; v.playsInline = true;
      v.src = reel.embedUrl;
      v.addEventListener('ended', onDeckEnded);
      media.appendChild(v);
      deck.ctl = {
        play: () => { const p = v.play(); if (p && p.catch) p.catch(() => {}); },
        pause: () => v.pause(),
        seek: (s) => { v.currentTime = s; },
        time: () => v.currentTime || 0,
        duration: () => v.duration || 0,
        mute: (on) => { v.muted = on; },
      };
      if (auto) deckPlay();
    } else if (reel.type === 'youtube') {
      // still frame first (max-res, falls back to hq), so the footage is there before any player loads
      const img = h('img', null, null, { alt: '', decoding: 'async', fetchpriority: 'high' });
      // the hq fallback is 4:3 with black bars baked in: is-hq crops them away
      const fallback = () => { img.classList.add('is-hq'); img.src = reel.thumb; };
      img.addEventListener('load', () => { if (img.naturalWidth < 200) fallback(); }, { once: true });
      img.addEventListener('error', fallback, { once: true });
      img.src = 'https://i.ytimg.com/vi/' + reel.id + '/maxresdefault.jpg';
      media.appendChild(img);
      if (auto) deckPlay();
    }
  }

  function mountYouTube(reel) {
    const media = $('#hero-media');
    const holder = h('div');
    media.appendChild(holder);
    loadYouTubeApi().then((YT) => {
      if (deck.reel !== reel) return; // showreel changed while the API loaded
      const p = new YT.Player(holder, {
        host: 'https://www.youtube-nocookie.com',
        videoId: reel.id,
        playerVars: { autoplay: 1, mute: 1, controls: 0, playsinline: 1, rel: 0, modestbranding: 1, disablekb: 1, iv_load_policy: 3, fs: 0 },
        events: {
          onReady: (e) => {
            if (deck.sound) e.target.unMute(); else e.target.mute();
            deck.ctl = {
              play: () => p.playVideo(),
              pause: () => p.pauseVideo(),
              seek: (s) => p.seekTo(s, true),
              time: () => p.getCurrentTime() || 0,
              duration: () => p.getDuration() || 0,
              restart: () => p.loadVideoById({ videoId: reel.id, startSeconds: 0 }), // seek+play no longer works once ENDED
              mute: (on) => { if (on) p.mute(); else { p.unMute(); p.setVolume(100); } },
            };
            if (deck.wantPlay) deckPlay();
          },
          onStateChange: (e) => {
            // cut the picture in once it really plays (hides YouTube's load UI)
            if (e.data === YT.PlayerState.PLAYING) setTimeout(() => p.getIframe().classList.add('on'), 300);
            if (e.data === YT.PlayerState.ENDED) onDeckEnded();
          },
        },
      });
      const f = p.getIframe();
      f.className = 'hero-yt';
      f.setAttribute('tabindex', '-1');
      f.setAttribute('aria-hidden', 'true');
      f.title = 'Showreel (background)';
    });
  }

  function deckPlay() {
    stopReverse();
    deck.dir = 1;
    if (deck.ctl) { deck.ctl.play(); return; }
    deck.wantPlay = true;
    if (deck.reel && deck.reel.type === 'youtube' && !deck.mounted) { deck.mounted = true; mountYouTube(deck.reel); }
  }
  function deckStop() {
    stopReverse();
    deck.dir = 0;
    deck.wantPlay = false;
    if (deck.ctl) deck.ctl.pause();
    // a paused YouTube embed draws its own title and play button: cut back to the still instead
    // (PLAYING cuts the picture in again)
    const yt = $('#hero-media .hero-yt');
    if (yt) yt.classList.remove('on');
  }
  // reverse playback, stepped (the players have no native reverse). The player keeps running and is
  // stepped back faster than it plays, because a paused YouTube embed shows its own UI.
  function deckReverse() {
    if (!deck.ctl) return;
    stopReverse();
    deck.dir = -1;
    deck.ctl.play();
    deck.revTimer = setInterval(() => {
      const t = deck.ctl.time() - 0.5;
      if (t <= 0) { deck.ctl.seek(0); deckStop(); } else deck.ctl.seek(t);
    }, 250);
  }
  function stopReverse() { clearInterval(deck.revTimer); deck.revTimer = 0; }

  // Called just before the end (see the clock) or, as a fallback, on the players' own end event.
  function onDeckEnded() {
    if (deck.loop) {
      if (deck.ctl.restart && deck.ctl.time() >= deck.ctl.duration() - 0.05) deck.ctl.restart();
      else { deck.ctl.seek(0); deck.ctl.play(); }
      deck.dir = 1;
      return;
    }
    deckStop();
    const first = $('.genre');
    if (first) first.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth' });
  }

  function setLoop(on) {
    deck.loop = on;
    $('#tr-loop').setAttribute('aria-pressed', String(on));
  }

  // Viewer timecode (01:00:00:00 + the deck's time) and scrubber, at 24 fps
  function startViewerClock() {
    if (timecodeTimer) return;
    const tc = $('#timecode');
    const fill = $('#tr-fill');
    timecodeTimer = setInterval(() => {
      const t = deck.ctl ? deck.ctl.time() : 0;
      const d = deck.ctl ? deck.ctl.duration() : 0;
      // act on the end while still playing: the loop stays seamless and YouTube never shows its end screen
      if (deck.dir === 1 && d && t >= d - 0.35) onDeckEnded();
      tc.textContent = toTimecode(Math.floor(t * 24), true);
      fill.style.width = (d ? Math.min(1, t / d) * 100 : 0) + '%';
      $('#tr-rev').classList.toggle('on', deck.dir === -1);
      $('#tr-stop').classList.toggle('on', deck.dir === 0);
      $('#tr-play').classList.toggle('on', deck.dir === 1);
    }, 1000 / 24);
  }

  /* ---------- ticker ---------- */

  function renderTicker(titles) {
    const track = $('#ticker-track');
    track.replaceChildren();
    const ticker = $('#ticker');
    ticker.hidden = titles.length === 0;
    if (!titles.length) return;
    let items = titles.slice();
    while (items.length < 10) items = items.concat(titles);
    // two identical halves -> seamless -50% loop
    for (let copy = 0; copy < 2; copy++) {
      items.forEach((t) => {
        const item = h('span', 'ticker-item');
        item.appendChild(h('span', 'ticker-text', t));
        item.appendChild(h('span', 'ticker-star', '/ CUT'));
        track.appendChild(item);
      });
    }
  }

  /* ---------- genre sections + cards ---------- */

  const PLAY_ICON = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5Z" fill="currentColor"/></svg>';

  function buildCard(video, i) {
    const info = parseVideo(video.url);
    const title = str(video.title) || 'Untitled';
    const vertical = video.vertical === true;

    const wrap = h('li', 'card-wrap car-item');
    wrap.dataset.idx = String(i);

    const card = h('button', 'card' + (vertical ? ' is-vertical' : ''), null, { type: 'button' });
    const unknown = info.type === 'unknown';
    if (!str(video.url).trim()) {
      card.setAttribute('aria-disabled', 'true'); // not disabled: it can still be turned to the front and focused
      card.setAttribute('aria-label', title + ' (no video linked)');
    } else {
      card.setAttribute('aria-label', (unknown ? 'Open ' : 'Play ') + title + (unknown ? ' in a new tab' : ''));
    }

    const media = h('span', 'card-media');
    const thumb = safeUrl(video.thumbnail) || info.thumb;

    const placeholder = () => {
      const ph = h('span', 'ph');
      ph.style.setProperty('--h', hashHue(title));
      ph.appendChild(h('span', 'ph-title', title));
      return ph;
    };

    if (thumb) {
      const img = h('img', 'card-img' + (thumb === info.thumb && info.type === 'youtube' ? ' is-hq' : ''), null, { alt: '', loading: 'lazy', decoding: 'async' });
      img.addEventListener('error', () => { img.replaceWith(placeholder()); });
      img.src = thumb;
      media.appendChild(img);
    } else if (info.type === 'file' && !reduceMotion) {
      // direct clip without a thumbnail: show its first frame
      const v = h('video', 'card-img', null, { preload: 'metadata', muted: '', playsinline: '', 'aria-hidden': 'true' });
      v.muted = true;
      v.addEventListener('error', () => { v.replaceWith(placeholder()); });
      v.src = info.embedUrl + '#t=0.5';
      media.appendChild(v);
    } else {
      media.appendChild(placeholder());
    }

    const play = h('span', 'card-play');
    play.innerHTML = PLAY_ICON; // static, trusted markup
    media.appendChild(play);
    media.appendChild(h('span', 'card-tc', 'CLIP ' + pad2(i + 1), { 'aria-hidden': 'true' }));
    if (vertical) media.appendChild(h('span', 'card-badge', '9:16'));
    media.appendChild(h('span', 'card-sheen'));
    card.appendChild(media);

    const meta = [str(video.year), str(video.client)].filter(Boolean).join('  ·  ');
    const text = h('span', 'card-info');
    text.appendChild(h('span', 'card-title', title));
    if (meta) text.appendChild(h('span', 'card-meta', meta));
    card.appendChild(text);

    card.addEventListener('click', () => { if (card.getAttribute('aria-disabled') !== 'true') openPlayer(video); });
    wrap._video = video;
    wrap._info = info;
    if (!reduceMotion) {
      card.addEventListener('pointermove', (e) => {
        const r = card.getBoundingClientRect();
        card.style.setProperty('--mx', e.clientX - r.left + 'px');
        card.style.setProperty('--my', e.clientY - r.top + 'px');
      });
    }

    wrap.appendChild(card);
    return wrap;
  }

  function renderSections(sections, navItems) {
    const root = $('#sections');
    carousels.forEach(carStopPreview);
    carousels = [];
    root.replaceChildren();
    const used = new Set();

    sections.forEach((sec, idx) => {
      let id = 'genre-' + slug(sec.id || sec.title, String(idx + 1));
      while (used.has(id)) id += '-x';
      used.add(id);
      const title = str(sec.title) || 'Untitled';
      const videos = Array.isArray(sec.videos) ? sec.videos : [];
      const firstThumb = videos.map((v) => safeUrl(v.thumbnail) || parseVideo(v.url).thumb).find(Boolean) || '';
      navItems.push({ label: title, target: id, thumb: firstThumb });

      const el = h('section', 'genre', null, { id, 'aria-labelledby': id + '-title' });
      el.dataset.spy = '';

      // slate: reel number + in/out timecodes (filled in by layoutTimeline from the section's place on the page)
      const head = h('div', 'genre-head reveal');
      const slate = h('p', 'genre-slate', null, { 'aria-hidden': 'true' });
      slate.appendChild(h('span', 'genre-index', 'V1 / Reel ' + pad2(idx + 1)));
      slate.appendChild(h('span', 'genre-tc'));
      head.appendChild(slate);
      const titleWrap = h('div', 'genre-title-wrap');
      titleWrap.appendChild(h('h2', 'genre-title', title, { id: id + '-title' }));
      head.appendChild(titleWrap);
      const aside = h('div', 'genre-aside');
      if (sec.description) aside.appendChild(h('p', 'genre-desc', str(sec.description)));
      aside.appendChild(h('span', 'genre-count', pad2(videos.length) + (videos.length === 1 ? ' clip' : ' clips')));
      head.appendChild(aside);
      el.appendChild(head);

      if (videos.length) {
        el.appendChild(buildCarousel(videos, title));
      } else {
        const grid = h('ul', 'grid');
        grid.appendChild(h('li', 'grid-empty', 'New work coming soon.'));
        el.appendChild(grid);
      }

      root.appendChild(el);
    });
  }

  /* ---------- 3D carousel: one per genre ----------
     The clips sit on a curved row: the front one faces you, the others turn away and recede to both sides.
     The wheel turns it only while the pointer is over the clips (elsewhere the page scrolls as usual);
     on phones a sideways swipe turns it and an up/down swipe scrolls the page. The front clip of the
     carousel nearest the middle of the screen plays muted on its own; a click opens it with sound.
     With reduced motion it is a plain row that scrolls sideways, every clip reachable, nothing autoplays. */

  let carousels = [];
  const carState = { paused: false, settleTimer: 0, wheelOutsideAt: 0 };
  const saveData = !!(navigator.connection && navigator.connection.saveData);

  const mod = (a, n) => ((a % n) + n) % n;

  // a wheel gesture that started on the page keeps scrolling the page when a carousel slides under the pointer
  window.addEventListener('wheel', (e) => {
    if (!(e.target.closest && e.target.closest('.car-track'))) carState.wheelOutsideAt = performance.now();
  }, { passive: true, capture: true });

  function buildCarousel(videos, title) {
    const n = videos.length;
    const allVertical = videos.every((v) => v.vertical === true);
    const flat = reduceMotion;
    const box = h('div', 'carousel reveal' + (allVertical ? ' car-vertical' : '') + (flat ? ' car-flat' : '') + (n === 1 ? ' car-single' : ''));
    const stageEl = h('div', 'car-stage');
    const track = h('ul', 'car-track', null, { 'aria-roledescription': 'carousel', 'aria-label': title + ' clips' });
    const items = videos.map((v, i) => buildCard(v, i));
    items.forEach((it) => track.appendChild(it));
    stageEl.appendChild(track);
    box.appendChild(stageEl);

    // two clips do not wrap; three or more do, and the card crossing the back fades out on the way
    const c = { box, stage: stageEl, track, items, n, flat, wrap: n >= 3, pos: 0, target: 0, raf: 0, last: 0, w: 0,
      wheelAt: 0, wheelD: 0, wheelAcc: 0, stepAt: 0, front: -1, drag: null, dragged: false, touchedAt: 0 };

    if (n > 1) {
      const bar = h('div', 'car-bar');
      const prev = h('button', 'car-btn car-prev', null, { type: 'button', 'aria-label': 'Previous clip' });
      prev.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M15 5 8 12l7 7" fill="none" stroke="currentColor" stroke-width="2"/></svg>';
      const next = h('button', 'car-btn car-next', null, { type: 'button', 'aria-label': 'Next clip' });
      next.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="m9 5 7 7-7 7" fill="none" stroke="currentColor" stroke-width="2"/></svg>';
      const count = h('span', 'car-count', null, { 'aria-hidden': 'true' });
      // read out once the carousel stops, not for every clip it passes
      const live = h('span', 'sr-only', null, { 'aria-live': 'polite' });
      bar.append(prev, count, next, live);
      box.appendChild(bar);
      Object.assign(c, { prev, next, count, live });
      prev.addEventListener('click', () => { if (flat) flatStep(c, -1); else carGo(c, c.target - 1); playSfx('tick'); });
      next.addEventListener('click', () => { if (flat) flatStep(c, 1); else carGo(c, c.target + 1); playSfx('tick'); });
    }

    if (flat) {
      items.forEach((it) => it.classList.add('is-front'));
      let raf = 0;
      track.addEventListener('scroll', () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; flatSync(c); }); }, { passive: true });
    } else if (n > 1) {
      wireCarousel(c);
    }
    carousels.push(c);
    return box;
  }

  // reduced motion: the buttons move the row by one clip; the counter follows the row
  function flatStep(c, dir) {
    c.track.scrollBy({ left: dir * (c.items[0].offsetWidth + 16), behavior: 'auto' });
  }

  function flatSync(c) {
    if (!c.count) return;
    const t = c.track, step = c.items[0].offsetWidth + 16;
    const i = Math.max(0, Math.min(c.n - 1, Math.round(t.scrollLeft / step)));
    setCount(c, i);
    c.prev.disabled = t.scrollLeft <= 1;
    c.next.disabled = t.scrollLeft >= t.scrollWidth - t.clientWidth - 1;
  }

  function setCount(c, i) {
    if (!c.count) return;
    const text = pad2(i + 1) + ' / ' + pad2(c.n) + '  ·  ' + (str(c.items[i]._video.title) || 'Untitled');
    c.count.textContent = text;
    c.countText = text;
  }

  // a disabled button that has focus would drop it to the page: hand it to the other one first
  function setDisabled(btn, other, on) {
    if (on && document.activeElement === btn) other.focus({ preventScroll: true });
    btn.disabled = on;
  }

  // the front clip the carousel is heading to (c.front is the one it is passing)
  const carTargetIndex = (c) => (c.wrap ? mod(c.target, c.n) : c.target);

  function carGo(c, t) {
    if (!c.wrap) t = Math.max(0, Math.min(c.n - 1, t));
    c.target = Math.round(t);
    c.touchedAt = performance.now();
    carAnimate(c);
  }

  const holding = (c) => !!(c.drag && c.drag.lock);

  function carAnimate(c) {
    if (c.raf) return;
    c.last = 0;
    const step = (now) => {
      c.raf = 0;
      if (!c.box.isConnected) return;
      const dt = c.last ? Math.min(64, now - c.last) : 16.7;
      c.last = now;
      if (!holding(c)) {
        c.pos += (c.target - c.pos) * (1 - Math.pow(0.84, dt / 16.7));
        if (Math.abs(c.target - c.pos) < 0.002) c.pos = c.target;
      }
      carLayout(c);
      if (holding(c) || c.pos !== c.target) c.raf = requestAnimationFrame(step);
      else {
        if (c.live && c.live.textContent !== c.countText) c.live.textContent = c.countText;
        carSettled();
      }
    };
    c.raf = requestAnimationFrame(step);
  }

  // card width, read once per layout pass (not on every animation frame)
  function carMeasure() {
    carousels.forEach((c) => { c.w = c.items[0].offsetWidth || 260; });
  }

  function carLayout(c) {
    const { n, items } = c;
    if (c.flat) { if (c.front < 0) { c.front = 0; flatSync(c); } return; }
    const front = c.wrap ? mod(Math.round(c.pos), n) : Math.max(0, Math.min(n - 1, Math.round(c.pos)));
    if (front !== c.front) {
      carStopPreview(c);
      c.front = front;
      setCount(c, front);
      if (c.prev && !c.wrap) { setDisabled(c.prev, c.next, front === 0); setDisabled(c.next, c.prev, front === n - 1); }
      items.forEach((it, i) => {
        it.firstElementChild.tabIndex = i === front ? 0 : -1;
        it.classList.toggle('is-front', i === front);
      });
    }
    const w = c.w || 260;
    items.forEach((it, i) => {
      let d = i - c.pos;
      if (c.wrap) d = mod(d + n / 2, n) - n / 2;
      const a = Math.abs(d), s = Math.sign(d);
      const near = Math.min(a, 1), far = Math.max(0, a - 1);
      const x = s * (near * w * 0.74 + far * w * 0.44);
      const z = -Math.min(a, 3.6) * w * 0.62;
      const ry = -s * (near * 42 + Math.min(far, 3) * 5);
      let op = a <= 2.6 ? 1 : Math.max(0, 1 - (a - 2.6) / 0.7);
      // where the ring closes (behind, at ±n/2) a card changes sides: it is faded out there, not seen jumping
      if (c.wrap) op *= Math.max(0, Math.min(1, (n / 2 - a) / 0.4));
      it.style.transform = 'translate3d(' + x.toFixed(1) + 'px,0,' + z.toFixed(1) + 'px) rotateY(' + ry.toFixed(2) + 'deg)';
      it.style.opacity = op.toFixed(2);
      it.style.visibility = op <= 0.01 ? 'hidden' : '';
      it.style.zIndex = String(100 - Math.round(a * 10));
      it.style.setProperty('--dim', Math.min(1, a).toFixed(3));
    });
  }

  function carSettled() {
    clearTimeout(carState.settleTimer);
    carState.settleTimer = setTimeout(updateCarouselPlayback, 220);
  }

  function wireCarousel(c) {
    const { track } = c;
    const slot = () => (c.w || 260) * 0.74; // px of drag per clip

    // The wheel turns it only over the clips themselves (the track and its turned cards); elsewhere the page
    // scrolls. One clip per mouse notch. A trackpad push turns it one clip; its momentum tail (falling
    // deltas) does not keep spinning it, a fresh push (rising deltas) turns it again.
    track.addEventListener('wheel', (e) => {
      if (e.ctrlKey) return; // pinch zoom
      const now = performance.now();
      if (now - carState.wheelOutsideAt < 250) return; // still the page's scroll gesture
      const mode = e.deltaMode;
      const horiz = Math.abs(e.deltaX) > Math.abs(e.deltaY);
      let d = horiz ? e.deltaX : e.deltaY;
      if (mode === 1) d *= 33; else if (mode === 2) d *= window.innerHeight;
      if (!d) return;
      // a carousel that does not wrap lets a vertical wheel scroll the page on once it is at that end
      // (a sideways one is kept, or the browser would take it as back/forward)
      const atEnd = !c.wrap && ((d < 0 && c.target <= 0) || (d > 0 && c.target >= c.n - 1));
      if (atEnd && !horiz) return;
      e.preventDefault();
      if (atEnd) return;
      const ad = Math.abs(d), fresh = now - c.wheelAt > 200;
      const rising = ad >= Math.abs(c.wheelD) && Math.sign(d) === Math.sign(c.wheelD || d);
      c.wheelAt = now;
      let go = false;
      if (fresh) { c.wheelAcc = 0; go = true; }
      else if (rising && ad >= 30 && now - c.stepAt > 90) go = true;
      else if (ad < Math.abs(c.wheelD) * 0.9) c.wheelAcc = 0; // momentum dying away
      else if (Math.abs(c.wheelAcc += d) >= 140 && now - c.stepAt > 250) go = true; // slow, steady trackpad push
      c.wheelD = d;
      if (go) {
        c.stepAt = now;
        c.wheelAcc = 0;
        carGo(c, c.target + Math.sign(d));
        playSfx('tick');
      }
    }, { passive: false });

    // drag (mouse) and sideways swipe (touch); touch-action: pan-y leaves vertical swipes and pinch to the page
    track.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || holding(c)) return; // a second finger does not take over the drag
      const now = performance.now();
      c.drag = { id: e.pointerId, x: e.clientX, y: e.clientY, pos: c.pos, lock: '', vx: 0, lx: e.clientX, lt: now };
      c.dragged = false;
      // released anywhere (also off the track, before the drag locked): the press is over
      const off = (ev) => {
        if (ev.pointerId !== e.pointerId) return;
        window.removeEventListener('pointerup', off, true);
        window.removeEventListener('pointercancel', off, true);
        end(ev);
      };
      window.addEventListener('pointerup', off, true);
      window.addEventListener('pointercancel', off, true);
    });
    track.addEventListener('pointermove', (e) => {
      const g = c.drag;
      if (!g || g.id !== e.pointerId) return;
      if (e.pointerType === 'mouse' && !(e.buttons & 1)) { end(e); return; }
      const dx = e.clientX - g.x, dy = e.clientY - g.y;
      if (!g.lock) {
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
        g.lock = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
        if (g.lock === 'y') { c.drag = null; return; }
        try { track.setPointerCapture(e.pointerId); } catch (err) { /* pointer already gone */ }
        track.classList.add('is-dragging');
        carStopPreview(c);
      }
      const now = performance.now();
      if (now > g.lt) { g.vx = (e.clientX - g.lx) / (now - g.lt); g.lx = e.clientX; g.lt = now; }
      c.dragged = true;
      let p = g.pos - dx / slot();
      if (!c.wrap) p = Math.max(-0.35, Math.min(c.n - 1 + 0.35, p));
      c.pos = p;
      c.target = p;
      c.touchedAt = now;
      carAnimate(c);
    });
    function end(e) {
      const g = c.drag;
      if (!g || g.id !== e.pointerId) return;
      c.drag = null;
      track.classList.remove('is-dragging');
      if (!g.lock) { carSettled(); return; }
      // the click that follows a mouse drag comes before this timer; after a swipe no click comes at all
      setTimeout(() => { c.dragged = false; }, 0);
      // a flick carries on by its speed
      const fling = performance.now() - g.lt < 80 ? -g.vx * 120 / slot() : 0;
      carGo(c, Math.round(c.pos + Math.max(-2, Math.min(2, fling))));
    }
    track.addEventListener('pointerup', end);
    track.addEventListener('pointercancel', end);
    track.addEventListener('dragstart', (e) => e.preventDefault()); // Firefox would drag the thumbnail image

    // a click right after a drag is not a click; a click on a side clip brings it to the front
    track.addEventListener('click', (e) => {
      if (c.dragged) { c.dragged = false; e.preventDefault(); e.stopPropagation(); return; }
      const it = e.target.closest('.car-item');
      if (!it) return;
      const i = Number(it.dataset.idx);
      if (i !== carTargetIndex(c)) {
        e.preventDefault();
        e.stopPropagation();
        carGoIndex(c, i);
        playSfx('tick');
      }
    }, true);

    // keyboard: arrows turn it, focus follows the front clip
    track.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      carGo(c, c.target + (e.key === 'ArrowRight' ? 1 : -1));
      const card = c.items[carTargetIndex(c)].firstElementChild;
      card.tabIndex = 0;
      card.focus({ preventScroll: true });
    });
  }

  // the shortest way round to clip i
  function carGoIndex(c, i) {
    if (!c.wrap) { carGo(c, i); return; }
    carGo(c, c.target + Math.round(mod(i - c.target + c.n / 2, c.n) - c.n / 2));
  }

  /* autoplay: only the front clip of one carousel, muted and looped: the one just turned, if it is still in
     view, otherwise the one nearest the middle of the screen */

  function updateCarouselPlayback() {
    if (!carousels.length) return;
    let best = null, bestD = Infinity, touched = null;
    if (!carState.paused && !reduceMotion && !saveData && !document.hidden) {
      const vh = window.innerHeight, mid = vh / 2, now = performance.now();
      carousels.forEach((c) => {
        if (!c.box.isConnected) return;
        const r = c.track.getBoundingClientRect();
        const visible = Math.min(r.bottom, vh) - Math.max(r.top, 0);
        if (visible < Math.min(r.height, vh) * 0.6) return;
        if (now - c.touchedAt < 4000 && (!touched || c.touchedAt > touched.touchedAt)) touched = c;
        const d = Math.abs(r.top + r.height / 2 - mid);
        if (d < bestD) { bestD = d; best = c; }
      });
      if (touched) best = touched;
    }
    const still = (c) => !holding(c) && c.pos === c.target;
    carousels.forEach((c) => { if (c !== best || !still(c)) carStopPreview(c); });
    if (best && still(best)) carStartPreview(best);
  }

  function carStartPreview(c) {
    const it = c.items[c.front];
    if (!it || it._live || !str(it._video.url).trim()) return;
    const info = it._info;
    const media = it.querySelector('.card-media');
    const before = media.querySelector('.card-play');
    const undo = () => {
      if (it._live !== el) return;
      it._live = null;
      it.classList.remove('is-live');
      dropLive(el);
    };
    let el;
    if (info.type === 'file') {
      // its own element over the still, so stopping it drops the download and leaves the still as it was
      el = h('video', 'card-live', null, { playsinline: '', 'aria-hidden': 'true' });
      el.muted = true;
      el.loop = true;
      el.playsInline = true;
      el.preload = 'auto';
      el.addEventListener('playing', () => { if (it._live === el) it.classList.add('is-live'); });
      el.addEventListener('error', undo);
      el.src = info.embedUrl;
      media.insertBefore(el, before);
      const p = el.play();
      if (p && p.catch) p.catch(undo); // autoplay refused (e.g. iPhone low power mode): keep the still
    } else if (info.type === 'youtube' || info.type === 'vimeo') {
      const src = info.type === 'youtube'
        ? 'https://www.youtube-nocookie.com/embed/' + info.id + '?autoplay=1&mute=1&controls=0&loop=1&playlist=' + info.id +
          '&playsinline=1&rel=0&modestbranding=1&disablekb=1&iv_load_policy=3'
        : 'https://player.vimeo.com/video/' + info.id + '?background=1&autoplay=1&muted=1&loop=1';
      el = h('iframe', 'card-live card-live-frame', null, {
        title: '', tabindex: '-1', 'aria-hidden': 'true', allow: 'autoplay; encrypted-media', referrerpolicy: 'strict-origin-when-cross-origin',
      });
      // shown once the player has had time to start, so its loading screen does not show
      el.addEventListener('load', () => setTimeout(() => {
        if (it._live !== el) return;
        el.classList.add('on');
        it.classList.add('is-live');
      }, 900));
      el.src = src;
      media.insertBefore(el, before);
    } else {
      return;
    }
    it._live = el;
  }

  function dropLive(el) {
    if (el.tagName === 'VIDEO') { el.pause(); el.removeAttribute('src'); el.load(); }
    el.remove();
  }

  function carStopPreview(c) {
    c.items.forEach((it) => {
      const el = it._live;
      if (!el) return;
      it._live = null;
      it.classList.remove('is-live');
      dropLive(el);
    });
  }

  /* ---------- about, contact, footer ---------- */

  function renderAbout(site, sections) {
    $('#about-name').textContent = [str(site.name), str(site.role)].filter(Boolean).join('  /  ');
    // the words light up one by one with the scroll (updateAboutMotion), like subtitles cut onto a timeline
    const text = $('#about-text');
    text.replaceChildren();
    str(site.about).split(/\n+/).map((s) => s.trim()).filter(Boolean).forEach((para) => {
      const p = h('p');
      para.split(/\s+/).forEach((word, i) => {
        if (i) p.appendChild(document.createTextNode(' '));
        p.appendChild(h('span', 'w', word));
      });
      text.appendChild(p);
    });

    // the title's letters rise and turn into place in 3D with the scroll
    const title = $('#about-title');
    const label = str(title.getAttribute('aria-label')) || title.textContent || 'About';
    title.setAttribute('aria-label', label);
    title.replaceChildren();
    [...label].forEach((ch) => title.appendChild(h('span', 'ltr', ch, { 'aria-hidden': 'true' })));

    const total = sections.reduce((n, s) => n + (Array.isArray(s.videos) ? s.videos.length : 0), 0);
    const stats = $('#about-stats');
    stats.replaceChildren();
    delete stats.dataset.counted; // new numbers count up again
    [[String(sections.length).padStart(2, '0'), 'Reels'], [String(total).padStart(2, '0'), 'Clips']].forEach(([n, l]) => {
      const box = h('div', 'stat');
      box.appendChild(h('dd', 'stat-num', n, { 'data-value': n })); // counts up when it comes into view
      box.appendChild(h('dt', 'stat-label', l));
      stats.appendChild(box);
    });
  }

  function renderContact(site) {
    const mail = $('#contact-email');
    const email = str(site.email).trim();
    mail.textContent = email || 'Say hello'; // one line; fitText shrinks it to fit
    if (email && !/[\s<>"]/.test(email)) mail.href = 'mailto:' + email;
    else mail.removeAttribute('href');

    const list = $('#contact-socials');
    list.replaceChildren();
    (Array.isArray(site.socials) ? site.socials : []).forEach((s) => {
      const url = safeUrl(s && s.url);
      if (!url || !s.label) return;
      const li = h('li');
      li.appendChild(h('a', 'social', str(s.label), { href: url, target: '_blank', rel: 'noopener noreferrer' }));
      list.appendChild(li);
    });
  }

  /* ---------- trust blocks: availability, proof band, testimonials, contact form ---------- */

  // Items of a block that should be shown: the block and the item are not hidden, and keep(item) holds.
  function visibleItems(block, keep) {
    if (!block || block.hidden === true || !Array.isArray(block.items)) return [];
    return block.items.filter((it) => it && it.hidden !== true && keep(it));
  }

  function renderAvailability(c) {
    const a = c.availability;
    const text = a && a.hidden !== true ? str(a.text).trim() : '';
    ['#hero-avail', '#contact-avail'].forEach((sel) => {
      const el = $(sel);
      el.hidden = !text;
      el.querySelector('.avail-text').textContent = text;
    });
  }

  function renderProof(c) {
    const stats = visibleItems(c.stats, (it) => str(it.value).trim());
    const clients = visibleItems(c.clients, (it) => str(it.name).trim() || safeUrl(it.logo));

    const dl = $('#proof-stats');
    dl.replaceChildren();
    stats.forEach((it) => {
      const box = h('div', 'proof-stat');
      box.appendChild(h('dd', 'proof-num', str(it.value)));
      box.appendChild(h('dt', 'proof-label', str(it.label)));
      dl.appendChild(box);
    });
    dl.hidden = !stats.length;

    const list = $('#client-list');
    list.replaceChildren();
    clients.forEach((it) => {
      const url = safeUrl(it.url);
      const logo = safeUrl(it.logo);
      const name = str(it.name).trim();
      const li = h('li', 'client');
      const inner = url ? h('a', 'client-link', null, { href: url, target: '_blank', rel: 'noopener noreferrer' }) : h('span', 'client-link');
      if (logo) {
        const img = h('img', 'client-logo', null, { alt: name || 'Client logo', loading: 'lazy', decoding: 'async' });
        img.addEventListener('error', () => { img.replaceWith(h('span', 'client-name', name)); });
        img.src = logo;
        inner.appendChild(img);
      } else {
        inner.appendChild(h('span', 'client-name', name));
      }
      li.appendChild(inner);
      list.appendChild(li);
    });
    $('#clients-title').textContent = str(c.clients && c.clients.title).trim() || 'Worked with';
    $('#proof-clients').hidden = !clients.length;
    $('#proof').hidden = !stats.length && !clients.length;
  }

  function renderTestimonials(c, navItems) {
    const items = visibleItems(c.testimonials, (it) => str(it.quote).trim());
    const title = str(c.testimonials && c.testimonials.title).trim() || 'Kind words';
    $('#testimonials').hidden = !items.length;
    $('#testimonials-title').textContent = title;
    const list = $('#quotes');
    list.replaceChildren();
    items.forEach((it, i) => {
      const li = h('li', 'quote reveal');
      li.style.setProperty('--d', (i % 3) * 90 + 'ms');
      li.appendChild(h('blockquote', 'quote-text', str(it.quote)));
      const who = h('div', 'quote-who');
      const photo = safeUrl(it.photo);
      const initial = h('span', 'quote-initial', (str(it.name).trim()[0] || '*').toUpperCase(), { 'aria-hidden': 'true' });
      if (photo) {
        const img = h('img', 'quote-photo', null, { alt: '', loading: 'lazy', decoding: 'async' });
        img.addEventListener('error', () => { img.replaceWith(initial); });
        img.src = photo;
        who.appendChild(img);
      } else {
        who.appendChild(initial);
      }
      const meta = h('div', 'quote-meta');
      meta.appendChild(h('span', 'quote-name', str(it.name)));
      if (str(it.role).trim()) meta.appendChild(h('span', 'quote-role', str(it.role)));
      who.appendChild(meta);
      li.appendChild(who);
      list.appendChild(li);
    });
    if (items.length) navItems.push({ label: title, target: 'testimonials' });
  }

  function renderContactForm(c, sections) {
    const cf = c.contactForm;
    const form = $('#contact-form');
    const on = !!(cf && cf.hidden !== true && str(cf.accessKey).trim());
    form.hidden = !on;
    if (!on) return;
    form.querySelector('.cf-submit').textContent = str(cf.buttonText).trim() || 'Send message';
    const sel = form.elements.project_type;
    const keep = sel.value;
    sel.replaceChildren(h('option', null, 'Choose...', { value: '' }));
    sections.map((s) => str(s.title).trim()).filter(Boolean).concat('Other')
      .forEach((t) => sel.appendChild(h('option', null, t, { value: t })));
    sel.value = keep;
  }

  async function submitContactForm(e) {
    e.preventDefault();
    const form = e.currentTarget;
    const status = $('#cf-status');
    const btn = form.querySelector('.cf-submit');
    const say = (msg, state) => { status.textContent = msg; status.dataset.state = state || ''; };
    if (form.elements.botcheck.checked) return; // honeypot: bots tick it, people never see it

    const data = {};
    ['name', 'email', 'project_type', 'deadline', 'budget', 'message'].forEach((k) => { data[k] = form.elements[k].value.trim(); });
    if (!data.name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email) || !data.message) {
      say('Please fill in your name, a valid email and a few words about the project.', 'error');
      return;
    }
    const cf = (content && content.contactForm) || {};
    btn.disabled = true;
    say('Sending...');
    try {
      const res = await fetch('https://api.web3forms.com/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(Object.assign({
          access_key: str(cf.accessKey).trim(),
          subject: 'New project inquiry from ' + data.name,
          from_name: 'Portfolio website',
        }, data)),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || j.success === false) throw new Error(j.message || 'HTTP ' + res.status);
      form.reset();
      say('Thank you! Your message is on its way, I will get back to you soon.', 'ok');
    } catch (err) {
      say('Sorry, the message could not be sent. Please email me directly at the address above.', 'error');
    } finally {
      btn.disabled = false;
    }
  }

  function renderFooter(site) {
    $('#year').textContent = new Date().getFullYear();
    $('#footer-name').textContent = str(site.name);
  }

  /* ---------- scroll reveal ---------- */

  function setupObservers() {
    if (revealObs) revealObs.disconnect();
    const items = document.querySelectorAll('.reveal');

    if (reduceMotion || !('IntersectionObserver' in window)) {
      items.forEach((n) => n.classList.add('in'));
    } else {
      revealObs = new IntersectionObserver((entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) { e.target.classList.add('in'); revealObs.unobserve(e.target); }
        });
      }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
      items.forEach((n) => revealObs.observe(n));
    }
  }

  /* ---------- edit timeline (Resolve Edit page look): scroll = playhead, page sections = clips ---------- */

  const PX_PER_FRAME = 4;  // page runtime: 4 px of scroll = 1 frame at 24 fps
  let tlClips = [];        // [{ el, link, audio }]
  let tlFrame = -1;

  // A made-up waveform, the same for the same seed on every load.
  function waveSvg(seed) {
    const n = 90;
    let d = '';
    for (let i = 0; i < n; i++) {
      const a = 0.15 + 0.8 * Math.abs(Math.sin((i + seed * 13) * 0.37) * Math.cos((i + seed * 7) * 0.113) * Math.sin(i * 0.05 + seed));
      d += 'M' + (i + 0.5) + ' ' + (50 - a * 44).toFixed(1) + 'V' + (50 + a * 44).toFixed(1);
    }
    return '<svg viewBox="0 0 ' + n + ' 100" preserveAspectRatio="none" aria-hidden="true">' +
      '<path d="' + d + '" stroke="currentColor" stroke-width="0.6" vector-effect="non-scaling-stroke"/></svg>';
  }

  function renderTimeline(items) {
    const lane = $('#tl-clips');
    const audioLane = $('#tl-audio');
    lane.replaceChildren();
    audioLane.replaceChildren();
    tlClips = items.map((it, i) => {
      const el = document.getElementById(it.target);
      if (!el) return null;
      // reels are video clips with a filmstrip; the other sections are title clips
      const kind = /^genre-|^hero$/.test(it.target) ? '' : ' is-title';
      const link = h('a', 'tl-clip' + kind, null, { href: '#' + it.target, title: it.label });
      link.appendChild(h('span', 'tl-clip-name', it.label));
      const strip = h('span', 'tl-clip-strip');
      if (it.thumb) strip.style.backgroundImage = 'url("' + it.thumb.replace(/["\\]/g, '') + '")';
      link.appendChild(strip);
      lane.appendChild(link);
      const audio = h('span', 'tl-aclip' + kind);
      audio.innerHTML = waveSvg(i + 1); // generated, trusted markup
      audioLane.appendChild(audio);
      return { el, link, audio, thumb: it.thumb || '' };
    }).filter(Boolean);
    layoutTimeline();
  }

  // The timeline is the scroll range: the top of the page is its first frame, the bottom its last.
  // A section's clip starts where scrolling brings that section to the middle of the screen,
  // and runs until the next clip starts.
  const maxScroll = () => Math.max(1, document.documentElement.scrollHeight - window.innerHeight);

  function layoutTimeline() {
    if (!tlClips.length) return;
    const max = maxScroll();
    const laneW = $('#tl-clips').clientWidth;
    const starts = tlClips.map(({ el }, i) => i === 0 ? 0 :
      Math.min(1, Math.max(0, (el.getBoundingClientRect().top + window.scrollY - window.innerHeight / 2) / max)));
    tlClips.forEach((clip, i) => {
      clip.start = starts[i];
      clip.end = i + 1 < starts.length ? starts[i + 1] : 1;
      const { link, audio, el } = clip;
      link.style.left = audio.style.left = clip.start * 100 + '%';
      link.style.width = audio.style.width = 'calc(' + (clip.end - clip.start) * 100 + '% - 1px)';
      link.classList.toggle('tight', (clip.end - clip.start) * laneW < 56);
      const tc = el.querySelector('.genre-tc');
      if (tc) {
        tc.textContent = 'IN ' + toTimecode(Math.round((clip.start * max) / PX_PER_FRAME), true) + '  OUT ' +
          toTimecode(Math.round((clip.end * max) / PX_PER_FRAME), true);
      }
    });
    const ruler = $('#tl-ruler');
    ruler.replaceChildren();
    for (let k = 0; k < 10; k++) {
      const mark = h('span', 'tl-mark', toTimecode(Math.round((max * k) / 10 / PX_PER_FRAME), true));
      mark.style.left = k * 10 + '%';
      ruler.appendChild(mark);
    }
    updatePlayhead();
  }

  function updatePlayhead() {
    const p = Math.min(1, Math.max(0, window.scrollY / maxScroll()));
    const lane = $('#tl-clips');
    $('#tl-head').style.transform = 'translateX(' + (lane.offsetLeft + p * lane.clientWidth) + 'px)';
    const frame = Math.round(window.scrollY / PX_PER_FRAME);
    if (frame !== tlFrame) { tlFrame = frame; $('#tl-tc').textContent = toTimecode(frame, true); }
    tlClips.forEach(({ link, start, end }, i) => {
      const last = i === tlClips.length - 1;
      if (p >= start && (p < end || (last && p <= end))) {
        link.setAttribute('aria-current', 'true');
        $('#tl-now').textContent = link.title; // phones: clips are too narrow for their names
      } else link.removeAttribute('aria-current');
    });
  }

  let tlRaf = 0;
  let lastScroll = { y: window.scrollY, t: performance.now() };
  window.addEventListener('scroll', () => {
    // scroll speed (px per ms) drives the scrub sound, heard only while the page moves
    const now = performance.now();
    scrubSound(Math.abs(window.scrollY - lastScroll.y) / Math.max(1, now - lastScroll.t));
    lastScroll = { y: window.scrollY, t: now };
    if (!tlRaf) tlRaf = requestAnimationFrame(() => { tlRaf = 0; updatePlayhead(); updateScrollMotion(); });
    carSettled(); // the front clip nearest the middle starts once the page stops
  }, { passive: true });
  window.addEventListener('resize', () => requestAnimationFrame(() => {
    carMeasure();
    carousels.forEach(carLayout);
    layoutTimeline();
    updateScrollMotion();
    carSettled();
  }));
  document.addEventListener('visibilitychange', updateCarouselPlayback);

  // Scrubbing: drag the playhead, or press/drag on the ruler, and the page scrolls with it (mouse and touch).
  function scrubTo(clientX) {
    const r = $('#tl-clips').getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    window.scrollTo({ top: f * maxScroll(), behavior: 'instant' });
  }
  [$('#tl-ruler'), $('#tl-head')].forEach((handle) => {
    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      $('#timeline').classList.add('scrubbing');
      scrubTo(e.clientX);
    });
    handle.addEventListener('pointermove', (e) => { if (handle.hasPointerCapture(e.pointerId)) scrubTo(e.clientX); });
    const stop = () => $('#timeline').classList.remove('scrubbing');
    handle.addEventListener('pointerup', stop);
    handle.addEventListener('pointercancel', stop);
  });

  // images and fonts change the page height after render
  if ('ResizeObserver' in window) new ResizeObserver(() => requestAnimationFrame(layoutTimeline)).observe(document.body);

  /* ---------- fit long words ---------- */

  // Big display text never breaks inside a word: when a word is wider than its box,
  // the font shrinks just enough for it to fit.
  const FIT_SELECTOR = '#hero-tagline, .genre-title, #about-title, .contact h2, #contact-email';

  function fitText() {
    document.querySelectorAll(FIT_SELECTOR).forEach((el) => {
      el.style.fontSize = '';
      el.style.maxWidth = '';
      // a max-width in ch/em shrinks with the font, so lift it before shrinking,
      // but never let the text grow past its parent
      if (el.scrollWidth > el.clientWidth + 1) el.style.maxWidth = 'none';
      const parent = getComputedStyle(el.parentElement);
      const parentW = el.parentElement.clientWidth - parseFloat(parent.paddingLeft) - parseFloat(parent.paddingRight);
      const avail = Math.min(el.clientWidth, parentW);
      if (!avail) return;
      let size = parseFloat(getComputedStyle(el).fontSize);
      for (let i = 0; i < 12 && el.scrollWidth > avail + 1 && size > 12; i++) {
        size = Math.max(12, size * Math.min(0.97, avail / el.scrollWidth));
        el.style.fontSize = size + 'px';
      }
    });
  }

  let fitTimer = 0;
  function scheduleFit() {
    clearTimeout(fitTimer);
    fitTimer = setTimeout(fitText, 80);
  }
  window.addEventListener('resize', scheduleFit);
  window.addEventListener('orientationchange', scheduleFit);
  // start the intro once the fonts are in (or after 1.5 s at most), with titles already fitted
  const fontsIn = document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve();
  Promise.race([fontsIn, new Promise((r) => setTimeout(r, 1500))]).then(() => {
    fitText();
    document.documentElement.classList.remove('fonts-wait');
  });
  fontsIn.then(scheduleFit);

  /* ---------- render ---------- */

  function render() {
    if (!content) return;
    const site = content.site || {};
    // hidden sections and videos stay in the data but are left out of the page, nav, ticker and counts
    const sections = (Array.isArray(content.sections) ? content.sections : [])
      .filter((s) => s && s.hidden !== true)
      .map((s) => Object.assign({}, s, { videos: (Array.isArray(s.videos) ? s.videos : []).filter((v) => v && v.hidden !== true) }));

    // accent colour -> CSS variables
    const rgb = hexToRgb(site.accent) || [255, 59, 92];
    const root = document.documentElement.style;
    root.setProperty('--accent', 'rgb(' + rgb.join(',') + ')');
    root.setProperty('--accent-rgb', rgb.join(','));

    const navItems = [];
    renderHero(site, sections);
    renderSections(sections, navItems);
    carMeasure(); // now that the cards are on the page and have a width
    carousels.forEach(carLayout);
    renderTestimonials(content, navItems);
    navItems.push({ label: 'About', target: 'about' }, { label: 'Contact', target: 'contact' });
    renderTicker(sections.map((s) => str(s.title)).filter(Boolean));
    renderAbout(site, sections);
    renderContact(site);
    renderAvailability(content);
    renderProof(content);
    renderContactForm(content, sections);
    renderFooter(site);
    setupObservers();
    fitText();
    renderTimeline([{ label: 'Showreel', target: 'hero', thumb: parseVideo(selectedReel).thumb }].concat(navItems));
    setupScrollMotion();
    carSettled();

    // a shared link to a section (#genre-commercials, #contact): the sections exist only now, so jump here
    if (firstRender && location.hash.length > 1) {
      const target = document.getElementById(decodeURIComponent(location.hash.slice(1)));
      if (target) requestAnimationFrame(() => target.scrollIntoView({ behavior: 'instant' }));
    }
    firstRender = false;
    document.dispatchEvent(new CustomEvent('portfolio:rendered'));
  }

  /* ---------- player ---------- */

  const player = $('#player');
  const stage = $('#player-stage');

  function openPlayer(video) {
    video = video || {};
    const info = parseVideo(video.url);
    if (info.type === 'unknown') {
      const u = safeUrl(video.url);
      if (u) window.open(u, '_blank', 'noopener,noreferrer');
      return;
    }

    lastFocus = document.activeElement;
    stage.replaceChildren();
    const vertical = video.vertical === true;
    stage.className = 'player-stage' + (vertical ? ' is-vertical' : '');
    const title = str(video.title) || 'Video';

    if (info.type === 'file') {
      const v = h('video', 'player-video', null, { controls: '', playsinline: '', 'aria-label': title });
      v.autoplay = true;
      v.src = info.embedUrl;
      stage.appendChild(v);
      const p = v.play();
      if (p && p.catch) p.catch(() => {}); // autoplay may be blocked; controls remain
    } else {
      const f = h('iframe', 'player-frame', null, {
        title,
        allow: 'autoplay; fullscreen; picture-in-picture; encrypted-media',
        allowfullscreen: '',
        referrerpolicy: 'strict-origin-when-cross-origin',
      });
      f.src = info.embedUrl;
      stage.appendChild(f);
    }

    $('#player-title').textContent = title;
    $('#player-meta').textContent = [str(video.year), str(video.client), str(video.description)].filter(Boolean).join('  ·  ');
    // the muted deck behind the hero waits while something plays with sound
    carState.paused = true;
    carousels.forEach(carStopPreview);
    deck.resume = deck.dir === 1;
    if (deck.dir !== 0) deckStop();
    player.hidden = false;
    document.body.classList.add('player-open');
    requestAnimationFrame(() => player.classList.add('open'));
    $('#player-close').focus();
  }

  function closePlayer() {
    if (player.hidden) return;
    const media = stage.querySelector('video');
    if (media) { media.pause(); media.removeAttribute('src'); media.load(); }
    stage.replaceChildren(); // removing the iframe stops playback
    player.classList.remove('open');
    player.hidden = true;
    document.body.classList.remove('player-open');
    if (deck.resume) { deck.resume = false; deckPlay(); }
    carState.paused = false;
    carSettled();
    if (lastFocus && lastFocus.focus) lastFocus.focus();
    lastFocus = null;
  }

  /* ---------- editing sound effects: synthesised with Web Audio (no files to load), off until switched on ---------- */

  // scrub: the running scrub chain while sounds are on; scrubStop: timer that fades it when scrolling stops
  const sfx = { on: false, ctx: null, noise: null, scrub: null, scrubStop: 0 };

  function sfxContext() {
    if (!sfx.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      sfx.ctx = new AC();
      // one second of white noise, reused by the scrub and the cut
      sfx.noise = sfx.ctx.createBuffer(1, sfx.ctx.sampleRate, sfx.ctx.sampleRate);
      const d = sfx.noise.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    if (sfx.ctx.state === 'suspended') sfx.ctx.resume();
    return sfx.ctx;
  }

  // cut: a noise click on a low thump; tick: a short blip
  function playSfx(kind) {
    if (!sfx.on) return;
    const ctx = sfxContext();
    if (!ctx) return;
    const t = ctx.currentTime;
    const env = (node, peak, attack, release) => {
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(peak, t + attack);
      g.gain.exponentialRampToValueAtTime(0.0001, t + attack + release);
      node.connect(g).connect(ctx.destination);
    };
    const noise = (dur) => { const s = ctx.createBufferSource(); s.buffer = sfx.noise; s.start(t, Math.random() * 0.5, dur); return s; };
    if (kind === 'cut') {
      const f = ctx.createBiquadFilter();
      f.type = 'highpass'; f.frequency.value = 2200;
      noise(0.04).connect(f);
      env(f, 0.22, 0.003, 0.03);
      const o = ctx.createOscillator();
      o.frequency.setValueAtTime(120, t);
      o.frequency.exponentialRampToValueAtTime(48, t + 0.1);
      o.start(t); o.stop(t + 0.14);
      env(o, 0.35, 0.004, 0.11);
    } else if (kind === 'tick') {
      const o = ctx.createOscillator();
      o.type = 'square'; o.frequency.value = 1700;
      o.start(t); o.stop(t + 0.03);
      env(o, 0.05, 0.002, 0.022);
    }
  }

  // Scrub: heard only while the page moves, like jogging a timeline. A looped noise band chattered by a
  // low oscillator (the tape flutter); speed (px per ms of scroll) raises its level, pitch and flutter rate,
  // and it fades out within a tenth of a second of the page stopping.
  function scrubSound(speed) {
    if (!sfx.on) return;
    const ctx = sfxContext();
    if (!ctx) return;
    if (!sfx.scrub) {
      const src = ctx.createBufferSource();
      src.buffer = sfx.noise; src.loop = true;
      const band = ctx.createBiquadFilter();
      band.type = 'bandpass'; band.Q.value = 2.2;
      const flutter = ctx.createGain();
      flutter.gain.value = 0.5;
      const lfo = ctx.createOscillator();
      lfo.type = 'square'; lfo.frequency.value = 12;
      const depth = ctx.createGain();
      depth.gain.value = 0.5;
      lfo.connect(depth).connect(flutter.gain);
      const level = ctx.createGain();
      level.gain.value = 0;
      src.connect(band).connect(flutter).connect(level).connect(ctx.destination);
      src.start(); lfo.start();
      sfx.scrub = { band, lfo, level };
    }
    const t = ctx.currentTime;
    const v = Math.min(1, speed / 3);
    sfx.scrub.level.gain.setTargetAtTime(0.03 + v * 0.2, t, 0.03);
    sfx.scrub.band.frequency.setTargetAtTime(500 + v * 2500, t, 0.05);
    sfx.scrub.lfo.frequency.setTargetAtTime(10 + v * 38, t, 0.05);
    clearTimeout(sfx.scrubStop);
    sfx.scrubStop = setTimeout(() => sfx.scrub.level.gain.setTargetAtTime(0, sfx.ctx.currentTime, 0.05), 90);
  }

  function setSfx(on) {
    sfx.on = on;
    $('#vw-sound').setAttribute('aria-pressed', String(on));
    $('#vw-sound-text').textContent = on ? 'Sound: On' : 'Sound: Off';
    if (on) playSfx('cut'); // the click that turns it on is the gesture that unlocks audio
    else if (sfx.scrub) sfx.scrub.level.gain.setTargetAtTime(0, sfx.ctx.currentTime, 0.03);
  }

  /* ---------- scroll motion: the reels' cards and titles move in 3D with the scroll (no overlays) ----------
     Each card is measured on its untransformed list item and its inner .card is moved: below the middle of
     the screen it sits back in depth, tilted, and lower; it flattens as it reaches the middle, where it is
     read, and tilts away again above. Columns travel at different speeds (parallax) and fan out to the
     sides. Genre titles slide in from the right out of a fade and stop in their frame; at the top the viewer
     bar squeezes them smaller as the page rises, and when they cannot shrink any more they leave to the
     right in the same fade, before their clips reach them. */

  let motionItems = [];

  function setupScrollMotion() {
    motionItems = [];
    if (reduceMotion) return;
    const titles = [];
    document.querySelectorAll('.genre').forEach((sec) => {
      const title = sec.querySelector('.genre-title');
      // the carousel tilts as a whole; its own clips are turned by carLayout
      const tracks = [...sec.querySelectorAll('.car-track')];
      if (title) titles.push({ box: title.parentElement, el: title, kind: 'title', sec, cards: tracks });
      tracks.forEach((track) => motionItems.push({ box: track.parentElement, el: track, kind: 'card' }));
    });
    motionItems.push(...titles); // after the cards: a title reads where its cards were just drawn
    updateScrollMotion();
  }

  function updateScrollMotion() {
    updateAboutMotion();
    if (!motionItems.length) return;
    const vh = window.innerHeight, mid = vh / 2;
    const phone = window.innerWidth < 600;
    const top = $('#viewer-bar').offsetHeight;
    const clamp01 = (v) => Math.max(0, Math.min(1, v));
    const ease = (v) => v * v * (3 - 2 * v);
    motionItems.forEach(({ box, el, kind, sec, cards }) => {
      const r = box.getBoundingClientRect();
      if (kind === 'title') {
        const s = sec.getBoundingClientRect();
        if (s.bottom < 0 || s.top > vh * 1.5) return;
        // in from the right out of a fade, at rest from 62% of the screen up
        const enter = clamp01((vh * 0.92 - r.top) / (vh * 0.3));
        // the viewer bar squeezes it: its top stops at the bar while its bottom keeps rising with the page,
        // down to about one small line per line of text
        const pinY = top + (phone ? 6 : 10);
        const h = el.offsetHeight;
        const lines = Math.max(1, Math.round(h / (parseFloat(getComputedStyle(el).fontSize) * 0.84)));
        const minH = Math.min(h, lines * (phone ? 26 : 38));
        const H = Math.min(h, Math.max(minH, r.bottom - pinY));
        // the clips rise in 3D as they near the top: the title never sits on them, they push it up instead
        let floor = s.bottom;
        cards.forEach((c) => { floor = Math.min(floor, c.getBoundingClientRect().top); });
        floor -= phone ? 10 : 16;
        const T = Math.min(Math.max(r.top, pinY), floor - H);
        const scale = H / h, y = T - r.top;
        // when it cannot get any smaller it leaves to the right in the same fade, gone by the time the
        // clips reach it (or as they push it up under the bar)
        const d = pinY + (minH + h) / 2 - r.bottom; // from halfway squeezed, so even a one-line title leaves slowly
        const room = Math.max(0, floor - pinY - H);
        let exit = Math.max(d > 0 ? d / (d + room) : 0, (pinY - T) / H);
        exit = ease(clamp01(exit));
        const x = ((1 - enter) + exit) * (phone ? 40 : 30) * window.innerWidth / 100;
        el.style.transform = 'translate3d(' + x.toFixed(1) + 'px,' + y.toFixed(1) + 'px,0) scale(' + scale.toFixed(3) + ')';
        el.style.opacity = (enter * (1 - exit)).toFixed(2);
        // the fade strip stays fixed on the page while the title slides and shrinks under it
        const w = el.offsetWidth, strip = box.clientWidth - w;
        el.style.setProperty('--fs', ((w - x) / scale).toFixed(1) + 'px');
        el.style.setProperty('--fe', ((w + strip - x) / scale).toFixed(1) + 'px');
        return;
      }
      if (r.bottom < -vh * 0.5 || r.top > vh * 1.5) return;
      const p = Math.max(-1, Math.min(1, (r.top + r.height / 2 - mid) / mid)); // -1 above, 0 middle, 1 below
      // the whole carousel: tilted back and lower below the middle, flat at the middle, tilted away above
      // (the stage holds the perspective, so the clips' own turn and this tilt add up)
      const rx = p * (phone ? 16 : 24);
      const z = -Math.abs(p) * (phone ? 120 : 240);
      // it rises less above the middle, so it does not catch up with its title at the top
      const y = p * (phone ? 50 : 110) * (p < 0 ? 0.4 : 1);
      el.style.transform = 'translate3d(0,' + y.toFixed(1) + 'px,' + z.toFixed(1) + 'px) rotateX(' + rx.toFixed(2) + 'deg)';
    });
  }

  // About, tied to the scroll: the title's letters rise and turn into place one after another, then the
  // words light up in reading order (the newest one in the accent colour, like a subtitle cursor); the
  // stats count up once when they come into view.
  function updateAboutMotion() {
    if (reduceMotion) return;
    const vh = window.innerHeight;
    const title = $('#about-title');
    const letters = title.querySelectorAll('.ltr');
    const tp = Math.max(0, Math.min(1, (vh * 0.95 - title.getBoundingClientRect().top) / (vh * 0.45)));
    letters.forEach((l, k) => {
      const q = Math.max(0, Math.min(1, tp * (1 + letters.length * 0.18) - k * 0.18));
      l.style.transform = 'translateY(' + ((1 - q) * 0.5).toFixed(3) + 'em) rotateX(' + ((1 - q) * -95).toFixed(1) + 'deg)';
      l.style.opacity = (0.15 + q * 0.85).toFixed(2);
    });
    // words: from the text's top reaching 85% of the screen to its bottom reaching 60%
    const text = $('#about-text');
    const br = text.getBoundingClientRect();
    const words = text.querySelectorAll('.w');
    const lit = Math.round(Math.max(0, Math.min(1, (vh * 0.85 - br.top) / (br.height + vh * 0.25))) * words.length);
    words.forEach((w, i) => {
      w.classList.toggle('lit', i < lit);
      w.classList.toggle('now', i === lit - 1 && lit < words.length);
    });
    const stats = $('#about-stats');
    if (!stats.dataset.counted && stats.getBoundingClientRect().top < vh * 0.9) {
      stats.dataset.counted = '1';
      stats.querySelectorAll('.stat-num').forEach((n) => {
        const to = parseInt(n.dataset.value, 10) || 0;
        const t0 = performance.now();
        const step = (ts) => {
          const k = Math.min(1, (ts - t0) / 900);
          n.textContent = pad2(Math.round(to * (1 - Math.pow(1 - k, 3))));
          if (k < 1) requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      });
    }
  }

  /* ---------- full view: the text flies off to the sides and the showreel plays with sound ---------- */

  let fullViewY = 0;

  function setFullView(on) {
    $('#hero').classList.toggle('clean', on);
    $('#vw-hint').textContent = on ? 'Click again or scroll to bring the text back' : 'Click the picture to watch it full, with sound';
    deck.sound = on;
    if (deck.ctl && deck.ctl.mute) deck.ctl.mute(!on);
    playSfx('cut');
    if (on) {
      fullViewY = window.scrollY;
      if (deck.dir !== 1) deckPlay();
    }
  }

  /* ---------- static event wiring (once) ---------- */

  function wire() {
    $('#player-close').addEventListener('click', closePlayer);
    $('#player-backdrop').addEventListener('click', closePlayer);
    $('#play-showreel').addEventListener('click', () => {
      const site = (content && content.site) || {};
      openPlayer({ title: $('#vw-title').textContent || 'Showreel', url: selectedReel, client: str(site.name), vertical: false });
    });
    // clicking the picture (or the text over it) toggles full view; scrolling away from it ends it and stops the reel
    $('#hero').addEventListener('click', (e) => {
      if (e.target.closest('a, button, .transport') || String(window.getSelection())) return;
      setFullView(!$('#hero').classList.contains('clean'));
    });
    window.addEventListener('scroll', () => {
      if ($('#hero').classList.contains('clean') && Math.abs(window.scrollY - fullViewY) > 40) {
        setFullView(false);
        deckStop();
      }
    }, { passive: true });

    // showreel dropdown in the viewer bar
    $('#vw-name').addEventListener('click', () => setReelPicker($('#vw-list').hidden));
    document.addEventListener('click', (e) => { if (!e.target.closest('.vw-pick')) setReelPicker(false); });

    // transport: reverse, stop, play, loop (on by default)
    $('#tr-rev').addEventListener('click', deckReverse);
    $('#tr-stop').addEventListener('click', deckStop);
    $('#tr-play').addEventListener('click', deckPlay);
    $('#tr-loop').addEventListener('click', () => setLoop(!deck.loop));
    document.querySelectorAll('.tr-key').forEach((k) => k.addEventListener('click', () => playSfx('tick')));
    setLoop(true);

    // editing sounds toggle; a click on a timeline clip is a cut
    $('#vw-sound').addEventListener('click', () => setSfx(!sfx.on));
    $('#tl-clips').addEventListener('click', (e) => { if (e.target.closest('.tl-clip')) playSfx('cut'); });
    // the scrubber seeks the deck
    const scrub = $('#tr-scrub');
    const seekAt = (x) => {
      if (!deck.ctl || !deck.ctl.duration()) return;
      const r = scrub.getBoundingClientRect();
      deck.ctl.seek(Math.min(1, Math.max(0, (x - r.left) / r.width)) * deck.ctl.duration());
    };
    scrub.addEventListener('pointerdown', (e) => {
      seekAt(e.clientX);
      try { scrub.setPointerCapture(e.pointerId); } catch (err) { /* pointer already gone */ }
    });
    scrub.addEventListener('pointermove', (e) => { if (scrub.hasPointerCapture(e.pointerId)) seekAt(e.clientX); });

    $('#retry-load').addEventListener('click', () => { loadContent(); });
    $('#contact-form').addEventListener('submit', submitContactForm);

    document.addEventListener('keydown', (e) => {
      // J / K / L drive the deck, as in the NLE (not while typing or watching)
      const typing = e.target.closest && e.target.closest('input, textarea, select, [contenteditable]');
      if (!typing && player.hidden && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const k = e.key.toLowerCase();
        if (k === 'j') { deckReverse(); return; }
        if (k === 'k') { deckStop(); return; }
        if (k === 'l') { deckPlay(); return; }
      }
      if (e.key === 'Escape') {
        if (!player.hidden) closePlayer();
        else if ($('#hero').classList.contains('clean')) setFullView(false);
        else if (!$('#vw-list').hidden) { setReelPicker(false); $('#vw-name').focus(); }
      } else if (e.key === 'Tab' && !player.hidden) {
        // keep focus inside the dialog
        const f = Array.from(player.querySelectorAll('button, iframe, video[controls]'));
        if (!f.length) return;
        const first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    });
  }

  /* ---------- loading ---------- */

  function showError(err) {
    $('#load-error-text').textContent = 'The portfolio content could not be loaded (' +
      (err && err.message ? err.message : 'unknown error') + '). If you opened this file directly, serve the folder through a web server.';
    $('#load-error').hidden = false;
  }

  async function loadContent() {
    try {
      const res = await fetch('data/content.json?v=' + Date.now(), { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      content = clone(await res.json());
      $('#load-error').hidden = true;
      render();
    } catch (err) {
      console.error('[portfolio] load failed:', err);
      showError(err);
    }
  }

  function setContent(obj) {
    content = clone(obj);
    $('#load-error').hidden = true;
    render();
  }

  wire();

  window.Portfolio = {
    ready: loadContent(), // never rejects: resolves after the first load attempt + render
    getContent: () => (content ? clone(content) : null),
    setContent,
    render,
    parseVideo,
    openPlayer,
  };
})();
