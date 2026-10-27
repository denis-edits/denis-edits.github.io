/* Portfolio site: loads data/content.json, renders the page, runs the lightbox player
   and exposes window.Portfolio (see docs/SPEC.md). Vanilla JS, no dependencies. */
(() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  let content = null;      // current content object (deep clone of the JSON)
  let firstRender = true;  // hero intro animation only plays once
  let revealObs = null;
  let spyObs = null;
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
    $('#vw-title').textContent = (str(site.name) ? str(site.name) + ' - ' : '') + 'Showreel ' + new Date().getFullYear();

    // Showreel buttons (hero + transport) + optional looping background clip
    const reel = parseVideo(site.showreel);
    $('#play-showreel').hidden = $('#tr-play').hidden = !str(site.showreel).trim();

    renderHeroMedia(reel, str(site.showreel).trim());

    // Viewer timecode from 01:00:00:00 at 24 fps; the scrubber loops every 60 s
    const tc = $('#timecode');
    const fill = $('#tr-fill');
    if (reduceMotion) { tc.textContent = toTimecode(0, true); }
    else if (!timecodeTimer) {
      const t0 = performance.now();
      timecodeTimer = setInterval(() => {
        const f = Math.floor(((performance.now() - t0) / 1000) * 24);
        tc.textContent = toTimecode(f, true);
        fill.style.width = ((f % 1440) / 1440) * 100 + '%';
      }, 1000 / 24);
    }
  }

  const pad2 = (n) => String(n).padStart(2, '0');
  // fromHour: timelines start at 01:00:00:00, as in the NLE
  function toTimecode(frames, fromHour) {
    if (fromHour) frames += 3600 * 24;
    const s = Math.floor(frames / 24);
    return pad2(Math.floor(s / 3600)) + ':' + pad2(Math.floor(s / 60) % 60) + ':' + pad2(s % 60) + ':' + pad2(frames % 24);
  }

  // The showreel behind the hero. Rebuilt only when its link changes, so admin previews don't reload the player.
  function renderHeroMedia(reel, key) {
    const media = $('#hero-media');
    if (media.dataset.reel === key) return;
    media.dataset.reel = key;
    media.replaceChildren();
    if (reel.type === 'file' && !reduceMotion) {
      const v = h('video');
      v.muted = true; v.loop = true; v.autoplay = true; v.playsInline = true;
      v.setAttribute('muted', ''); v.setAttribute('playsinline', ''); v.setAttribute('aria-hidden', 'true');
      v.src = reel.embedUrl;
      media.appendChild(v);
      const p = v.play();
      if (p && p.catch) p.catch(() => {});
    } else if (reel.type === 'youtube') {
      // still frame first (max-res, falls back to hq), so the footage is there before any player loads
      const img = h('img', null, null, { alt: '', decoding: 'async', fetchpriority: 'high' });
      // the hq fallback is 4:3 with black bars baked in: is-hq crops them away
      const fallback = () => { img.classList.add('is-hq'); img.src = reel.thumb; };
      img.addEventListener('load', () => { if (img.naturalWidth < 200) fallback(); }, { once: true });
      img.addEventListener('error', fallback, { once: true });
      img.src = 'https://i.ytimg.com/vi/' + reel.id + '/maxresdefault.jpg';
      media.appendChild(img);
      // desktop only: a muted looping embed, cut in once it has had time to start (hides YouTube's load UI)
      if (!reduceMotion && window.matchMedia('(min-width: 861px) and (pointer: fine)').matches) {
        const f = h('iframe', 'hero-yt', null, {
          title: 'Showreel (background)', tabindex: '-1', 'aria-hidden': 'true', allow: 'autoplay; encrypted-media',
        });
        f.addEventListener('load', () => setTimeout(() => f.classList.add('on'), 2600), { once: true });
        f.src = 'https://www.youtube-nocookie.com/embed/' + reel.id + '?autoplay=1&mute=1&controls=0&loop=1&playlist=' + reel.id +
          '&playsinline=1&rel=0&modestbranding=1&disablekb=1&iv_load_policy=3';
        media.appendChild(f);
      }
    }
  }

  /* ---------- navigation + ticker ---------- */

  function renderNav(items) {
    const desktop = $('#nav-links');
    const mobile = $('#mobile-links');
    desktop.replaceChildren();
    mobile.replaceChildren();
    items.forEach((it, i) => {
      const a = h('a', 'nav-link', it.label, { href: '#' + it.target });
      a.dataset.target = it.target;
      desktop.appendChild(a);
      const m = h('a', 'mobile-link', null, { href: '#' + it.target });
      m.dataset.target = it.target;
      m.appendChild(h('span', 'mobile-num', String(i + 1).padStart(2, '0')));
      m.appendChild(h('span', 'mobile-label', it.label));
      mobile.appendChild(m);
    });
  }

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

    const wrap = h('li', 'card-wrap reveal');
    wrap.style.setProperty('--d', (i % 6) * 70 + 'ms');

    const card = h('button', 'card' + (vertical ? ' is-vertical' : ''), null, { type: 'button' });
    const unknown = info.type === 'unknown';
    if (!str(video.url).trim()) {
      card.disabled = true;
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

    card.addEventListener('click', () => openPlayer(video));
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

      const allVertical = videos.length > 0 && videos.every((v) => v.vertical === true);
      const grid = h('ul', 'grid' + (allVertical ? ' grid-vertical' : ''));
      if (videos.length) videos.forEach((v, i) => grid.appendChild(buildCard(v, i)));
      else grid.appendChild(h('li', 'grid-empty', 'New work coming soon.'));
      el.appendChild(grid);

      root.appendChild(el);
    });
  }

  /* ---------- about, contact, footer ---------- */

  function renderAbout(site, sections) {
    $('#about-name').textContent = [str(site.name), str(site.role)].filter(Boolean).join('  /  ');
    const text = $('#about-text');
    text.replaceChildren();
    str(site.about).split(/\n+/).map((s) => s.trim()).filter(Boolean)
      .forEach((p) => text.appendChild(h('p', null, p)));

    const total = sections.reduce((n, s) => n + (Array.isArray(s.videos) ? s.videos.length : 0), 0);
    const stats = $('#about-stats');
    stats.replaceChildren();
    [[String(sections.length).padStart(2, '0'), 'Reels'], [String(total).padStart(2, '0'), 'Clips']].forEach(([n, l]) => {
      const box = h('div', 'stat');
      box.appendChild(h('dd', 'stat-num', n));
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
    $('#nav-logo-text').textContent = str(site.name) || 'Portfolio';
  }

  /* ---------- observers (scroll reveal + active nav link) ---------- */

  function setupObservers() {
    if (revealObs) revealObs.disconnect();
    if (spyObs) spyObs.disconnect();
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

    if ('IntersectionObserver' in window) {
      spyObs = new IntersectionObserver((entries) => {
        entries.forEach((e) => { if (e.isIntersecting) setActiveLink(e.target.id); });
      }, { rootMargin: '-45% 0px -50% 0px' });
      document.querySelectorAll('.genre, #about, #contact').forEach((s) => spyObs.observe(s));
    }
  }

  function setActiveLink(id) {
    document.querySelectorAll('.nav-link, .mobile-link').forEach((a) => {
      if (a.dataset.target === id) a.setAttribute('aria-current', 'true');
      else a.removeAttribute('aria-current');
    });
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
      return { el, link, audio };
    }).filter(Boolean);
    layoutTimeline();
  }

  // Clip widths, ruler marks and in/out timecodes follow each section's real place on the page.
  function layoutTimeline() {
    const total = document.documentElement.scrollHeight;
    if (!total || !tlClips.length) return;
    const laneW = $('#tl-clips').clientWidth;
    tlClips.forEach(({ el, link, audio }) => {
      const top = el.getBoundingClientRect().top + window.scrollY;
      const left = (top / total) * 100 + '%';
      const width = 'calc(' + (el.offsetHeight / total) * 100 + '% - 1px)';
      link.style.left = audio.style.left = left;
      link.style.width = audio.style.width = width;
      link.classList.toggle('tight', (el.offsetHeight / total) * laneW < 56);
      const tc = el.querySelector('.genre-tc');
      if (tc) {
        tc.textContent = 'IN ' + toTimecode(Math.round(top / PX_PER_FRAME), true) + '  OUT ' +
          toTimecode(Math.round((top + el.offsetHeight) / PX_PER_FRAME), true);
      }
    });
    const ruler = $('#tl-ruler');
    ruler.replaceChildren();
    for (let k = 0; k < 10; k++) {
      const mark = h('span', 'tl-mark', toTimecode(Math.round((total * k) / 10 / PX_PER_FRAME), true));
      mark.style.left = k * 10 + '%';
      ruler.appendChild(mark);
    }
    updatePlayhead();
  }

  function updatePlayhead() {
    const total = document.documentElement.scrollHeight;
    const y = window.scrollY + window.innerHeight / 2; // the frame under the playhead = middle of the screen
    const lane = $('#tl-clips');
    $('#tl-head').style.transform = 'translateX(' + (lane.offsetLeft + (y / total) * lane.clientWidth) + 'px)';
    const frame = Math.round(y / PX_PER_FRAME);
    if (frame !== tlFrame) { tlFrame = frame; $('#tl-tc').textContent = toTimecode(frame, true); }
    tlClips.forEach(({ el, link }) => {
      const top = el.getBoundingClientRect().top + window.scrollY;
      if (y >= top && y < top + el.offsetHeight) {
        link.setAttribute('aria-current', 'true');
        $('#tl-now').textContent = link.title; // phones: clips are too narrow for their names
      } else link.removeAttribute('aria-current');
    });
  }

  let tlRaf = 0;
  window.addEventListener('scroll', () => {
    if (!tlRaf) tlRaf = requestAnimationFrame(() => { tlRaf = 0; updatePlayhead(); });
  }, { passive: true });
  window.addEventListener('resize', () => requestAnimationFrame(layoutTimeline));

  // Scrubbing: drag the playhead, or press/drag on the ruler, and the page scrolls with it (mouse and touch).
  function scrubTo(clientX) {
    const r = $('#tl-clips').getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    window.scrollTo({ top: f * document.documentElement.scrollHeight - window.innerHeight / 2, behavior: 'instant' });
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
    renderTestimonials(content, navItems);
    navItems.push({ label: 'About', target: 'about' }, { label: 'Contact', target: 'contact' });
    renderNav(navItems);
    renderTicker(sections.map((s) => str(s.title)).filter(Boolean));
    renderAbout(site, sections);
    renderContact(site);
    renderAvailability(content);
    renderProof(content);
    renderContactForm(content, sections);
    renderFooter(site);
    setupObservers();
    fitText();
    renderTimeline([{ label: 'Showreel', target: 'hero', thumb: parseVideo(site.showreel).thumb }].concat(navItems));

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
    if (lastFocus && lastFocus.focus) lastFocus.focus();
    lastFocus = null;
  }

  /* ---------- static event wiring (once) ---------- */

  function setMenu(open) {
    document.body.classList.toggle('menu-open', open);
    const t = $('#nav-toggle');
    t.setAttribute('aria-expanded', String(open));
    t.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
  }

  function wire() {
    $('#player-close').addEventListener('click', closePlayer);
    $('#player-backdrop').addEventListener('click', closePlayer);
    const playReel = () => {
      const site = (content && content.site) || {};
      openPlayer({ title: 'Showreel', url: site.showreel, client: str(site.name), vertical: false });
    };
    $('#play-showreel').addEventListener('click', playReel);
    $('#tr-play').addEventListener('click', playReel);
    $('#nav-toggle').addEventListener('click', () => setMenu(!document.body.classList.contains('menu-open')));
    // any tap in the open menu closes it: on a link (after jumping) or on the empty space around them
    $('#mobile-menu').addEventListener('click', () => setMenu(false));
    $('#retry-load').addEventListener('click', () => { loadContent(); });
    $('#contact-form').addEventListener('submit', submitContactForm);

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (!player.hidden) closePlayer();
        else if (document.body.classList.contains('menu-open')) setMenu(false);
      } else if (e.key === 'Tab' && !player.hidden) {
        // keep focus inside the dialog
        const f = Array.from(player.querySelectorAll('button, iframe, video[controls]'));
        if (!f.length) return;
        const first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    });

    const nav = $('#nav');
    const onScroll = () => nav.classList.toggle('scrolled', window.scrollY > 24);
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();

    window.addEventListener('resize', () => { if (window.innerWidth > 1100) setMenu(false); });
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
