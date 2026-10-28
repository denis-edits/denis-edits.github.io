/* Portfolio admin: password login, token crypto, GitHub API publishing, editor drawer.
 * Vanilla ES2020, no dependencies. Everything lives inside this IIFE.
 * Only window.PortfolioAdmin = { encryptToken, decryptToken } is exposed (for testing). */
(function () {
  'use strict';

  // ------------------------------------------------------------------ constants
  const DEFAULTS = { owner: 'denis-edits', repo: 'denis-edits.github.io', branch: 'main' };
  const AUTH_PATH = 'data/auth.json';
  const CONTENT_PATH = 'data/content.json';
  const SESSION_KEY = 'adm-token';
  const PBKDF2_ITERATIONS = 600000;
  const MAX_IMAGE = 10 * 1024 * 1024;
  const MAX_VIDEO = 50 * 1024 * 1024;
  const TOKEN_URL = 'https://github.com/settings/personal-access-tokens/new';
  const LOCK_SVG =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';

  // ------------------------------------------------------------------ state
  const S = {
    auth: null, // contents of data/auth.json
    token: '', // decrypted GitHub token (memory + sessionStorage)
    content: null, // working copy being edited
    baseline: '', // JSON string of the last committed/loaded content
    dirty: false,
    busy: false,
    tab: 'site',
    expandedSections: new Set(),
    expandedVideos: new Set(),
    autoId: new Set(), // sections whose id still follows the title
    blobs: new Map(), // uploaded media path -> local object URL (for previews)
    previewTimer: 0,
    override: null, // transient footer message { text, kind }
    pending: new Map(), // trust-block key -> default object, attached to content on first edit
  };
  const M = { root: null, title: null, body: null }; // modal
  const D = { root: null, body: null, status: null, publish: null, sub: null, tabs: [] }; // drawer

  // ------------------------------------------------------------------ small helpers
  function h(tag, props, ...kids) {
    const e = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v == null || v === false) continue;
        if (k === 'class') e.className = v;
        else if (k === 'text') e.textContent = v;
        else if (k === 'value') e.value = v;
        else if (k === 'checked') e.checked = !!v;
        else if (k.length > 2 && k.startsWith('on')) e.addEventListener(k.slice(2).toLowerCase(), v);
        else e.setAttribute(k, v === true ? '' : String(v));
      }
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid == null || kid === false) continue;
      e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return e;
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const ser = (o) => JSON.stringify(o);

  function slugify(s) {
    return String(s || '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/&/g, ' and ')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60);
  }
  function uniqueSlug(base, takenIds) {
    let slug = slugify(base) || 'sectiune';
    if (!takenIds.has(slug)) return slug;
    let n = 2;
    while (takenIds.has(slug + '-' + n)) n++;
    return slug + '-' + n;
  }
  const uid = () => 'v-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
  function toggleSet(set, x) {
    if (set.has(x)) set.delete(x);
    else set.add(x);
  }
  function ssGet() {
    try { return sessionStorage.getItem(SESSION_KEY) || ''; } catch (e) { return ''; }
  }
  function ssSet(v) {
    try { if (v) sessionStorage.setItem(SESSION_KEY, v); else sessionStorage.removeItem(SESSION_KEY); } catch (e) { /* ignore */ }
  }

  // ------------------------------------------------------------------ base64 / utf-8
  function bytesToB64(bytes) {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const CHUNK = 0x8000;
    const parts = [];
    for (let i = 0; i < u8.length; i += CHUNK) {
      parts.push(String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK)));
    }
    return btoa(parts.join(''));
  }
  function b64ToBytes(b64) {
    const bin = atob(String(b64).replace(/\s+/g, ''));
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
  }
  const utf8ToB64 = (str) => bytesToB64(new TextEncoder().encode(str));
  const b64ToUtf8 = (b64) => new TextDecoder('utf-8').decode(b64ToBytes(b64));

  // ------------------------------------------------------------------ crypto
  function requireCrypto() {
    if (!window.crypto || !window.crypto.subtle) {
      throw new Error('Criptarea nu este disponibilă în acest browser sau pagină. Deschide site-ul prin HTTPS (sau localhost).');
    }
  }
  async function deriveKey(password, salt, iterations) {
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
      base,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }
  /** Returns { kdf, iv, ciphertext } to merge into auth.json. */
  async function encryptToken(token, password) {
    requireCrypto();
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveKey(password, salt, PBKDF2_ITERATIONS);
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(token));
    return {
      kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: PBKDF2_ITERATIONS, salt: bytesToB64(salt) },
      iv: bytesToB64(iv),
      ciphertext: bytesToB64(new Uint8Array(ct)),
    };
  }
  /** Returns the token, or throws an Error with code 'BADPASS' when the password is wrong. */
  async function decryptToken(authObj, password) {
    requireCrypto();
    if (!authObj || !authObj.kdf || !authObj.iv || !authObj.ciphertext) {
      throw new Error('Fișierul data/auth.json este incomplet.');
    }
    const iterations = Number(authObj.kdf.iterations);
    if (!Number.isFinite(iterations) || iterations < 1000 || iterations > 10000000) {
      throw new Error('Parametri de criptare invalizi în data/auth.json.');
    }
    const key = await deriveKey(password, b64ToBytes(authObj.kdf.salt), iterations);
    try {
      const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64ToBytes(authObj.iv) }, key, b64ToBytes(authObj.ciphertext));
      return new TextDecoder().decode(pt);
    } catch (e) {
      const err = new Error('Parolă greșită.');
      err.code = 'BADPASS';
      throw err;
    }
  }

  // ------------------------------------------------------------------ GitHub API
  class GhError extends Error {
    constructor(status, message, data) {
      super(message);
      this.status = status;
      this.data = data;
    }
  }
  const encPath = (p) => p.split('/').map(encodeURIComponent).join('/');
  const repoApi = () => `/repos/${encodeURIComponent(S.auth.owner)}/${encodeURIComponent(S.auth.repo)}`;
  const contentsApi = (p) => `${repoApi()}/contents/${encPath(p)}`;

  function ghHeaders(token, json) {
    const hd = {
      Authorization: 'Bearer ' + token,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (json) hd['Content-Type'] = 'application/json';
    return hd;
  }
  function parseJsonSafe(text) {
    try { return text ? JSON.parse(text) : null; } catch (e) { return null; }
  }
  /** Generic GitHub request. onProgress(0..1) switches to XHR to get upload progress. */
  function gh(method, apiPath, body, token, onProgress) {
    const url = 'https://api.github.com' + apiPath;
    const payload = body == null ? undefined : JSON.stringify(body);
    if (onProgress && typeof XMLHttpRequest !== 'undefined') {
      return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open(method, url);
        const hd = ghHeaders(token, payload != null);
        Object.keys(hd).forEach((k) => xhr.setRequestHeader(k, hd[k]));
        xhr.upload.onprogress = (ev) => { if (ev.lengthComputable) onProgress(ev.loaded / ev.total); };
        xhr.onerror = () => reject(new GhError(0, 'network'));
        xhr.onload = () => {
          const data = parseJsonSafe(xhr.responseText);
          if (xhr.status >= 200 && xhr.status < 300) resolve(data);
          else reject(new GhError(xhr.status, (data && data.message) || 'HTTP ' + xhr.status, data));
        };
        xhr.send(payload);
      });
    }
    return fetch(url, { method, headers: ghHeaders(token, payload != null), body: payload, cache: 'no-store' }).then(
      async (res) => {
        const data = parseJsonSafe(await res.text());
        if (!res.ok) throw new GhError(res.status, (data && data.message) || 'HTTP ' + res.status, data);
        return data;
      },
      () => { throw new GhError(0, 'network'); }
    );
  }
  /** Returns { sha, text } or null when the file does not exist. */
  async function getFile(path, token) {
    try {
      const data = await gh('GET', contentsApi(path) + '?ref=' + encodeURIComponent(S.auth.branch), null, token || S.token);
      if (Array.isArray(data) || !data) throw new GhError(0, 'Răspuns neașteptat de la GitHub pentru ' + path);
      if (!data.content) throw new GhError(0, 'Fișierul ' + path + ' este prea mare pentru a fi citit prin API.');
      return { sha: data.sha, text: b64ToUtf8(data.content) };
    } catch (e) {
      if (e instanceof GhError && e.status === 404) return null;
      throw e;
    }
  }
  function putFile(path, b64, message, sha, token, onProgress) {
    const body = { message, content: b64, branch: S.auth.branch };
    if (sha) body.sha = sha;
    return gh('PUT', contentsApi(path), body, token || S.token, onProgress);
  }
  /** Reads the latest sha (always via API), then PUTs; retries once on a 409/422 sha conflict. */
  async function commitFile(path, b64, message, token) {
    for (let attempt = 0; ; attempt++) {
      const cur = await getFile(path, token);
      try {
        return await putFile(path, b64, message, cur && cur.sha, token);
      } catch (e) {
        if (attempt === 0 && e instanceof GhError && (e.status === 409 || e.status === 422)) continue;
        throw e;
      }
    }
  }

  function describeError(e) {
    if (e && e.code === 'BADPASS') return 'Parolă greșită.';
    if (e instanceof GhError) {
      const m = e.message || '';
      switch (e.status) {
        case 0:
          return e.message && e.message !== 'network' ? e.message : 'Nu mă pot conecta la GitHub. Verifică conexiunea la internet și încearcă din nou.';
        case 401:
          return 'Token-ul GitHub este invalid sau a expirat. Înlocuiește-l din Setări → „Înlocuiește token”.';
        case 403:
          if (/rate limit/i.test(m)) return 'Prea multe cereri către GitHub. Așteaptă câteva minute și încearcă din nou.';
          return 'GitHub a refuzat accesul (403). Token-ul nu are permisiunea „Contents: Read and write” pe acest repository sau a expirat. Înlocuiește-l din Setări → „Înlocuiește token”.';
        case 404:
          return 'Repository-ul sau fișierul nu a fost găsit (404). Token-ul poate să nu aibă acces la repository. Înlocuiește-l din Setări → „Înlocuiește token”.';
        case 409:
        case 422:
          return 'Conflict la salvare (fișierul s-a schimbat între timp). Încearcă din nou. Detalii: ' + m;
        default:
          return `GitHub a răspuns cu eroarea ${e.status}: ${m}`;
      }
    }
    return (e && e.message) || String(e);
  }

  // ------------------------------------------------------------------ content model
  function normalizeContent(c) {
    const out = c && typeof c === 'object' ? c : {};
    out.site = out.site && typeof out.site === 'object' ? out.site : {};
    const s = out.site;
    ['name', 'role', 'tagline', 'intro', 'showreel', 'about', 'email', 'accent'].forEach((k) => {
      if (typeof s[k] !== 'string') s[k] = s[k] == null ? '' : String(s[k]);
    });
    s.showreelArchive = Array.isArray(s.showreelArchive) ? s.showreelArchive.filter((x) => x && typeof x === 'object' && x.url) : [];
    s.socials = Array.isArray(s.socials) ? s.socials.filter((x) => x && typeof x === 'object') : [];
    s.socials.forEach((x) => { x.label = String(x.label || ''); x.url = String(x.url || ''); });
    out.sections = Array.isArray(out.sections) ? out.sections.filter((x) => x && typeof x === 'object') : [];
    out.sections.forEach((sec) => {
      sec.id = String(sec.id || '');
      sec.title = String(sec.title || '');
      sec.description = String(sec.description || '');
      sec.videos = Array.isArray(sec.videos) ? sec.videos.filter((x) => x && typeof x === 'object') : [];
      sec.videos.forEach((v) => {
        v.id = String(v.id || uid());
        ['title', 'description', 'url', 'thumbnail', 'year', 'client'].forEach((k) => { v[k] = v[k] == null ? '' : String(v[k]); });
        v.vertical = !!v.vertical;
      });
    });
    out.sections.forEach((sec) => {
      if ('hidden' in sec) sec.hidden = !!sec.hidden;
      sec.videos.forEach((v) => { if ('hidden' in v) v.hidden = !!v.hidden; });
    });
    // trust blocks are optional: tidy the ones that exist, never create missing ones
    TRUST_KEYS.forEach((k) => {
      if (!(k in out)) return;
      const b = out[k];
      if (!b || typeof b !== 'object' || Array.isArray(b)) { delete out[k]; return; }
      if ('hidden' in b) b.hidden = !!b.hidden;
      const def = trustDefaults(k);
      Object.keys(def).forEach((f) => {
        if (f === 'items') {
          b.items = Array.isArray(b.items) ? b.items.filter((x) => x && typeof x === 'object') : [];
          b.items.forEach((it) => {
            if ('hidden' in it) it.hidden = !!it.hidden;
            Object.keys(trustItemDefaults(k)).forEach((g) => { if (g !== 'hidden' && typeof it[g] !== 'string') it[g] = it[g] == null ? '' : String(it[g]); });
          });
        } else if (f !== 'hidden' && typeof b[f] !== 'string' && b[f] != null) b[f] = String(b[f]);
      });
    });
    return out;
  }
  const TRUST_KEYS = ['availability', 'stats', 'clients', 'testimonials', 'contactForm'];
  function trustDefaults(k) {
    switch (k) {
      case 'availability': return { hidden: false, text: '' };
      case 'stats': return { hidden: false, items: [] };
      case 'clients': return { hidden: false, title: 'Worked with', items: [] };
      case 'testimonials': return { hidden: false, title: 'Kind words', items: [] };
      default: return { hidden: false, accessKey: '', buttonText: 'Send message' };
    }
  }
  function trustItemDefaults(k) {
    if (k === 'stats') return { value: '', label: '', hidden: false };
    if (k === 'clients') return { name: '', logo: '', url: '', hidden: false };
    return { quote: '', name: '', role: '', photo: '', hidden: false };
  }
  /** The block to edit: the real one if present, else a detached default that is attached on the first edit. */
  function trustBlock(k) {
    if (S.content[k]) return S.content[k];
    if (!S.pending.has(k)) S.pending.set(k, trustDefaults(k));
    return S.pending.get(k);
  }
  function attachPending() {
    if (!S.content) return;
    S.pending.forEach((b, k) => { if (!S.content[k]) S.content[k] = b; });
    S.pending.clear();
  }
  /** Makes section/video ids non-empty and unique. Returns an error string or ''. */
  function prepareForPublish() {
    const secIds = new Set();
    for (const sec of S.content.sections) {
      if (!sec.title.trim()) return 'Fiecare secțiune are nevoie de un titlu.';
      let id = slugify(sec.id) || slugify(sec.title);
      sec.id = uniqueSlug(id, secIds);
      secIds.add(sec.id);
      const vIds = new Set();
      for (const v of sec.videos) {
        if (!v.id || vIds.has(v.id)) v.id = uid();
        vIds.add(v.id);
      }
    }
    return '';
  }

  // ------------------------------------------------------------------ dirty tracking + live preview
  function markDirty() {
    attachPending();
    S.dirty = ser(S.content) !== S.baseline;
    S.override = null;
    renderFooter();
    clearTimeout(S.previewTimer);
    S.previewTimer = setTimeout(pushPreview, 200);
  }
  function pushPreview() {
    try { window.Portfolio.setContent(clone(S.content)); } catch (e) { console.warn('[admin] preview failed', e); }
  }
  window.addEventListener('beforeunload', (e) => {
    if (S.dirty) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  // ------------------------------------------------------------------ modal
  function ensureModal() {
    if (M.root) return;
    M.title = h('h2', { class: 'adm-modal-title', id: 'adm-modal-title' });
    M.body = h('div', { class: 'adm-modal-body' });
    M.root = h(
      'div',
      { class: 'adm-scope adm-overlay', hidden: true, onmousedown: (e) => { if (e.target === M.root) closeModal(); } },
      h(
        'div',
        { class: 'adm-modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'adm-modal-title' },
        h('div', { class: 'adm-modal-head' }, M.title, h('button', { type: 'button', class: 'adm-x', 'aria-label': 'Închide', onclick: closeModal, text: '✕' })),
        M.body
      )
    );
    document.body.append(M.root);
  }
  function showModal(title, node) {
    ensureModal();
    M.title.textContent = title;
    M.body.replaceChildren(node);
    M.root.hidden = false;
    const f = M.body.querySelector('input:not([type=hidden]), textarea');
    if (f) setTimeout(() => f.focus(), 30);
  }
  function closeModal() {
    if (M.root) M.root.hidden = true;
  }
  const modalOpen = () => !!(M.root && !M.root.hidden);
  function loadingNode(text) {
    return h('div', { class: 'adm-center' }, h('div', { class: 'adm-spin' }), h('p', { text }));
  }
  function setMsg(el, text, kind) {
    el.textContent = text || '';
    el.className = 'adm-msg' + (kind ? ' adm-msg--' + kind : '');
    el.hidden = !text;
  }
  const msgEl = () => h('div', { class: 'adm-msg', role: 'status', 'aria-live': 'polite', hidden: true });

  // ------------------------------------------------------------------ form pieces
  function passStrength(pw) {
    if (pw.length < 10) return 0;
    let sc = 1;
    if (pw.length >= 14) sc++;
    if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) sc++;
    if (/\d/.test(pw) && /[^A-Za-z0-9]/.test(pw)) sc++;
    return Math.min(sc, 4);
  }
  /** Password input with optional strength meter. Returns { wrap, input }. */
  function passwordField(label, { meter = false, autocomplete = 'new-password' } = {}) {
    const input = h('input', { type: 'password', class: 'adm-input', autocomplete, required: true });
    const hint = h('p', { class: 'adm-hint' });
    const bar = h('div', { class: 'adm-meter', 'data-level': '0' }, h('i'), h('i'), h('i'), h('i'));
    if (meter) {
      const upd = () => {
        const sc = passStrength(input.value);
        bar.dataset.level = String(sc);
        if (!input.value) hint.textContent = 'Minim 10 caractere. Folosește litere mari/mici, cifre și simboluri.';
        else if (input.value.length < 10) hint.textContent = `Prea scurtă: ${input.value.length}/10 caractere.`;
        else hint.textContent = ['', 'Acceptabilă. O parolă mai lungă e mai sigură.', 'Bună.', 'Foarte bună.', 'Excelentă.'][sc];
      };
      input.addEventListener('input', upd);
      upd();
    }
    const wrap = h('label', { class: 'adm-field' }, h('span', { class: 'adm-label', text: label }), input, meter ? [bar, hint] : null);
    return { wrap, input };
  }
  function plainField(label, input, hint) {
    return h('label', { class: 'adm-field' }, h('span', { class: 'adm-label', text: label }), input, hint ? h('p', { class: 'adm-hint', text: hint }) : null);
  }

  // ------------------------------------------------------------------ modal views
  function showLoading(title, text) {
    showModal(title, loadingNode(text));
  }
  function showError(title, text, actions) {
    const box = h('div', null, h('div', { class: 'adm-msg adm-msg--err', text }));
    const row = h('div', { class: 'adm-row', style: 'margin-top:14px;flex-wrap:wrap' });
    (actions || []).forEach((a) => row.append(h('button', { type: 'button', class: 'adm-btn' + (a.primary ? ' adm-btn--primary' : ''), onclick: a.run, text: a.label })));
    box.append(row);
    showModal(title, box);
  }

  function viewLogin(notice) {
    const pw = passwordField('Parolă', { autocomplete: 'current-password' });
    const msg = msgEl();
    const btn = h('button', { type: 'submit', class: 'adm-btn adm-btn--primary adm-btn--block', text: 'Intră' });
    if (notice) setMsg(msg, notice, 'warn');
    const form = h(
      'form',
      {
        onsubmit: async (e) => {
          e.preventDefault();
          if (!pw.input.value) return;
          btn.disabled = true;
          btn.textContent = 'Se verifică…';
          setMsg(msg, '');
          try {
            S.token = await decryptToken(S.auth, pw.input.value);
            ssSet(S.token);
            await enterAdmin();
          } catch (err) {
            if (err && err.code === 'BADPASS') await sleep(900);
            setMsg(msg, describeError(err), 'err');
            btn.disabled = false;
            btn.textContent = 'Intră';
            pw.input.select();
          }
        },
      },
      h('p', { text: 'Introdu parola de administrator pentru a edita site-ul.' }),
      pw.wrap,
      btn,
      msg,
      h('button', { type: 'button', class: 'adm-linkbtn', text: 'Ai uitat parola? Reconfigurează cu un token nou', onclick: () => viewSetup('setup') })
    );
    showModal('Autentificare admin', form);
  }

  function viewSetup(mode) {
    const replace = mode === 'replace';
    const { owner, repo } = S.auth;
    const link = h('a', { href: TOKEN_URL, target: '_blank', rel: 'noopener noreferrer', text: 'această pagină GitHub' });
    const steps = h(
      'ol',
      { class: 'adm-steps' },
      h('li', null, 'Deschide ', link, ' (sau: github.com → Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token).'),
      h('li', null, 'La „Token name” scrie orice (ex. „Portofolio admin”) și alege „Expiration”. Când expiră, îl înlocuiești din Setări.'),
      h('li', null, 'La „Resource owner” alege ', h('strong', { text: owner }), '. La „Repository access” alege ', h('strong', { text: 'Only select repositories' }), ' și selectează ', h('strong', { text: `${owner}/${repo}` }), '.'),
      h('li', null, 'La „Permissions” → „Repository permissions” → ', h('strong', { text: 'Contents' }), ' setează ', h('strong', { text: 'Read and write' }), '. Restul rămân „No access”.'),
      h('li', null, 'Apasă „Generate token”, copiază token-ul (începe cu github_pat_…) și lipește-l mai jos. GitHub îl arată o singură dată.'),
      h('li', null, 'Alege o parolă de admin. Token-ul este criptat în browser cu această parolă; pe GitHub ajunge doar textul criptat.')
    );
    const tokenInput = h('input', { type: 'password', class: 'adm-input', autocomplete: 'off', spellcheck: 'false', placeholder: 'github_pat_…', required: true });
    const pw = passwordField(replace ? 'Parolă (nouă sau cea existentă)' : 'Parolă admin', { meter: true });
    const pw2 = passwordField('Confirmă parola');
    const msg = msgEl();
    const btn = h('button', { type: 'submit', class: 'adm-btn adm-btn--primary adm-btn--block', text: replace ? 'Salvează token-ul' : 'Configurează' });
    const form = h(
      'form',
      {
        onsubmit: async (e) => {
          e.preventDefault();
          const token = tokenInput.value.trim();
          const p1 = pw.input.value;
          if (!token) return setMsg(msg, 'Lipește token-ul GitHub.', 'err');
          if (p1.length < 10) return setMsg(msg, 'Parola trebuie să aibă cel puțin 10 caractere.', 'err');
          if (p1 !== pw2.input.value) return setMsg(msg, 'Cele două parole nu coincid.', 'err');
          btn.disabled = true;
          try {
            setMsg(msg, 'Verific token-ul pe GitHub…', 'warn');
            const info = await gh('GET', repoApi(), null, token);
            if (info && info.permissions && info.permissions.push !== true) {
              throw new GhError(403, 'Token-ul poate citi repository-ul, dar nu poate scrie în el. Setează „Contents: Read and write”.');
            }
            setMsg(msg, 'Criptez token-ul (poate dura o secundă)…', 'warn');
            const enc = await encryptToken(token, p1);
            const authObj = { version: 1, owner: S.auth.owner, repo: S.auth.repo, branch: S.auth.branch, kdf: enc.kdf, iv: enc.iv, ciphertext: enc.ciphertext };
            setMsg(msg, 'Salvez configurarea în repository…', 'warn');
            await commitFile(AUTH_PATH, utf8ToB64(JSON.stringify(authObj, null, 2) + '\n'), 'Configure admin access', token);
            S.auth = authObj;
            S.token = token;
            ssSet(token);
            await enterAdmin();
          } catch (err) {
            setMsg(msg, describeError(err), 'err');
            btn.disabled = false;
          }
        },
      },
      h('p', { text: replace ? 'Creează un token nou și introdu-l aici. Poți păstra aceeași parolă sau alege alta.' : 'Site-ul nu are încă un administrator. Urmează pașii:' }),
      steps,
      plainField('Token GitHub', tokenInput),
      pw.wrap,
      pw2.wrap,
      btn,
      msg
    );
    showModal(replace ? 'Înlocuiește token-ul' : 'Configurare inițială', form);
  }

  // ------------------------------------------------------------------ session flow
  async function loadAuth() {
    const res = await fetch('data/auth.json?v=' + Date.now(), { cache: 'no-store' });
    if (res.status === 404) return Object.assign({ version: 1 }, DEFAULTS);
    if (!res.ok) throw new Error('Nu am putut citi data/auth.json (HTTP ' + res.status + ').');
    const j = Object.assign({ version: 1 }, DEFAULTS, await res.json());
    // Pages can serve a stale copy for ~1 min after setup/password change; prefer the API copy.
    try {
      const api = await fetch('https://api.github.com/repos/' + j.owner + '/' + j.repo +
        '/contents/' + AUTH_PATH + '?ref=' + encodeURIComponent(j.branch || 'main'),
        { headers: { Accept: 'application/vnd.github.raw+json' }, cache: 'no-store' });
      if (api.ok) return Object.assign({ version: 1 }, DEFAULTS, await api.json());
    } catch (_) { /* offline or rate-limited: use the Pages copy */ }
    return j;
  }

  async function startFlow() {
    showLoading('Admin', 'Se încarcă…');
    try {
      if (!window.Portfolio) throw new Error('Site-ul nu a încărcat corect (window.Portfolio lipsește).');
      S.auth = await loadAuth();
    } catch (e) {
      return showError('Admin', describeError(e), [{ label: 'Reîncearcă', primary: true, run: startFlow }]);
    }
    const saved = ssGet();
    if (saved && S.auth.ciphertext) {
      S.token = saved;
      return enterAdmin();
    }
    if (S.auth.ciphertext) return viewLogin();
    viewSetup('setup');
  }

  function dropSession() {
    S.token = '';
    ssSet('');
  }

  async function enterAdmin() {
    if (S.content && S.dirty && D.root) {
      // token replaced mid-session: keep the unsaved edits instead of reloading
      closeModal();
      renderAll();
      setDrawerOpen(true);
      return;
    }
    showLoading('Admin', 'Se încarcă conținutul de pe GitHub…');
    try {
      await window.Portfolio.ready;
      let content = null;
      try {
        const f = await getFile(CONTENT_PATH);
        if (f) content = JSON.parse(f.text);
      } catch (e) {
        if (e instanceof GhError && e.status === 401) {
          dropSession();
          return S.auth.ciphertext ? viewLogin('Sesiunea a expirat sau token-ul nu mai e valid. Autentifică-te din nou; dacă problema persistă, înlocuiește token-ul din Setări.') : viewSetup('setup');
        }
        throw e;
      }
      if (!content) content = window.Portfolio.getContent();
      S.content = normalizeContent(content);
      S.baseline = ser(S.content);
      S.dirty = false;
      pushPreview();
      closeModal();
      buildDrawer();
      renderAll();
      setDrawerOpen(true);
    } catch (e) {
      showError('Eroare', describeError(e), [
        { label: 'Reîncearcă', primary: true, run: enterAdmin },
        { label: 'Înlocuiește token', run: () => viewSetup('replace') },
        { label: 'Deconectează', run: logout },
      ]);
    }
  }

  function logout() {
    dropSession();
    if (S.dirty) {
      try { window.Portfolio.setContent(JSON.parse(S.baseline)); } catch (e) { /* ignore */ }
    }
    S.dirty = false;
    S.content = null;
    closeModal();
    setDrawerOpen(false);
  }

  function onTrigger(e) {
    if (e) e.preventDefault();
    if (S.content && S.token && D.root) {
      setDrawerOpen(!D.root.classList.contains('adm-open'));
      return;
    }
    startFlow();
  }

  // ------------------------------------------------------------------ drawer shell
  function buildDrawer() {
    if (D.root) return;
    D.sub = h('p', { class: 'adm-drawer-sub' });
    D.body = h('div', { class: 'adm-body' });
    D.status = h('div', { class: 'adm-status', role: 'status', 'aria-live': 'polite' });
    D.publish = h('button', { type: 'button', class: 'adm-btn adm-btn--primary', onclick: publish, text: 'Publică' });
    const tabs = [['site', 'Site'], ['sections', 'Secțiuni'], ['trust', 'Încredere'], ['settings', 'Setări']];
    const tablist = h('div', { class: 'adm-tabs', role: 'tablist' });
    D.tabs = tabs.map(([id, label]) => {
      const b = h('button', { type: 'button', class: 'adm-tab', role: 'tab', 'data-tab': id, text: label, onclick: () => { S.tab = id; renderAll(); D.body.scrollTop = 0; } });
      tablist.append(b);
      return b;
    });
    D.root = h(
      'aside',
      { class: 'adm-scope adm-drawer', 'aria-label': 'Panou admin', inert: true },
      h(
        'div',
        { class: 'adm-drawer-head' },
        h('div', null, h('h2', { class: 'adm-drawer-title', text: 'Panou admin' }), D.sub),
        h('button', { type: 'button', class: 'adm-btn adm-btn--sm adm-btn--ghost', onclick: () => setDrawerOpen(false), text: 'Închide' })
      ),
      tablist,
      D.body,
      h('div', { class: 'adm-foot' }, D.status, D.publish)
    );
    document.body.append(D.root);
  }
  function setDrawerOpen(on) {
    if (!D.root) return;
    D.root.classList.toggle('adm-open', on);
    D.root.inert = !on;
    D.root.setAttribute('aria-hidden', on ? 'false' : 'true');
  }
  function renderAll() {
    D.sub.textContent = `${S.auth.owner}/${S.auth.repo} · ${S.auth.branch}`;
    renderTab();
    renderFooter();
  }
  function renderTab(keepScroll) {
    const top = keepScroll ? D.body.scrollTop : 0;
    D.tabs.forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === S.tab)));
    S.pending.clear();
    const node = S.tab === 'site' ? tabSite() : S.tab === 'sections' ? tabSections() : S.tab === 'trust' ? tabTrust() : tabSettings();
    D.body.replaceChildren(node);
    D.body.scrollTop = top;
  }
  function setStatus(text, kind) {
    S.override = text ? { text, kind } : null;
    renderFooter();
  }
  function renderFooter() {
    if (!D.status) return;
    let text, kind;
    if (S.override) ({ text, kind } = S.override);
    else if (S.dirty) { text = 'Modificări nesalvate'; kind = 'dirty'; }
    else { text = 'Totul este publicat'; kind = ''; }
    D.status.className = 'adm-status' + (kind ? ' adm-status--' + kind : '');
    D.status.replaceChildren(h('span', { class: 'adm-dot' }), text);
    D.publish.disabled = S.busy || !S.dirty;
  }

  // ------------------------------------------------------------------ publish
  // A replaced showreel is kept: it moves to site.showreelArchive (newest first), which the site lists in
  // the viewer bar's dropdown. Putting an archived one back makes it current again.
  function archiveReplacedShowreel() {
    const s = S.content.site;
    let before = {};
    try { before = (JSON.parse(S.baseline || '{}').site) || {}; } catch (e) { /* no baseline */ }
    const oldUrl = String(before.showreel || '').trim();
    const newUrl = String(s.showreel || '').trim();
    if (oldUrl === newUrl) return;
    const today = new Date().toISOString().slice(0, 10);
    s.showreelArchive = (s.showreelArchive || []).filter((r) => r.url !== newUrl && r.url !== oldUrl);
    if (oldUrl) s.showreelArchive.unshift({ url: oldUrl, title: 'Showreel ' + String(before.showreelDate || today).slice(0, 7) });
    s.showreelDate = newUrl ? today : '';
  }

  async function publish() {
    if (S.busy || !S.content) return;
    const problem = prepareForPublish();
    if (problem) return setStatus(problem, 'err');
    archiveReplacedShowreel();
    S.busy = true;
    setStatus('Se publică…', '');
    const snapshot = ser(S.content);
    try {
      const json = JSON.stringify(S.content, null, 2) + '\n';
      await commitFile(CONTENT_PATH, utf8ToB64(json), 'Update content from admin panel');
      S.baseline = snapshot;
      S.dirty = ser(S.content) !== S.baseline;
      S.busy = false;
      setStatus('Publicat! Site-ul se actualizează în ~1 minut.', 'ok');
      if (S.tab === 'sections') renderTab(true); // ids may have been normalised
    } catch (e) {
      S.busy = false;
      setStatus(describeError(e), 'err');
    }
  }

  // ------------------------------------------------------------------ field builders
  /** Text / textarea field bound to obj[key]. opts: textarea, rows, type, placeholder, hint, upload ('video'|'image'), onChange(value) */
  function textField(label, obj, key, opts = {}) {
    const input = opts.textarea
      ? h('textarea', { class: 'adm-textarea', rows: opts.rows || 3, placeholder: opts.placeholder })
      : h('input', { class: 'adm-input', type: opts.type || 'text', placeholder: opts.placeholder, autocomplete: 'off' });
    input.value = obj[key] == null ? '' : obj[key];
    input.addEventListener('input', () => {
      obj[key] = input.value;
      if (opts.onChange) opts.onChange(input.value);
      markDirty();
    });
    if (!opts.upload) return plainField(label, input, opts.hint);
    const status = h('div', { class: 'adm-upload-status', hidden: true });
    const bar = h('div', { class: 'adm-progress', hidden: true }, h('i'));
    const file = h('input', { type: 'file', class: 'adm-file', tabindex: '-1', accept: opts.upload === 'image' ? 'image/*' : 'video/*' });
    const btn = h('button', { type: 'button', class: 'adm-btn adm-btn--sm', text: 'Încarcă fișier', onclick: () => file.click() });
    file.addEventListener('change', async () => {
      const f = file.files && file.files[0];
      file.value = '';
      if (!f) return;
      btn.disabled = true;
      try {
        const path = await uploadMedia(f, opts.upload, status, bar);
        obj[key] = path;
        input.value = path;
        if (opts.onChange) opts.onChange(path);
        markDirty();
      } catch (e) {
        setUploadStatus(status, describeError(e), 'err');
        bar.hidden = true;
      }
      btn.disabled = false;
    });
    const limits = opts.upload === 'image' ? 'Imagini: maxim 10 MB.' : 'Videoclipuri: maxim 50 MB. Fișierele mari (filme, clipuri lungi) pune-le pe YouTube/Vimeo/Drive și lipește linkul aici; GitHub are limite de dimensiune și site-ul se încarcă mai greu.';
    return h(
      'div',
      { class: 'adm-field' },
      h('span', { class: 'adm-label', text: label }),
      h('div', { class: 'adm-row' }, input, btn, file),
      status,
      bar,
      h('p', { class: 'adm-hint', text: (opts.hint ? opts.hint + ' ' : '') + limits })
    );
  }
  function setUploadStatus(el, text, kind) {
    el.textContent = text || '';
    el.className = 'adm-upload-status' + (kind ? ' adm-upload-status--' + kind : '');
    el.hidden = !text;
  }
  function safeName(name) {
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 ? name.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8) : '';
    const base = slugify(dot > 0 ? name.slice(0, dot) : name).slice(0, 40) || 'fisier';
    return ext ? base + '.' + ext : base;
  }
  async function uploadMedia(file, kind, statusEl, barEl) {
    const type = file.type || '';
    const isImage = /^image\//.test(type) || /\.(jpe?g|png|webp|gif|avif|svg)$/i.test(file.name);
    const isVideo = /^video\//.test(type) || /\.(mp4|webm|mov|m4v|ogv)$/i.test(file.name);
    if (kind === 'image' && !isImage) throw new Error('Alege un fișier imagine (JPG, PNG, WebP…).');
    if (kind === 'video' && !isVideo) throw new Error('Alege un fișier video (MP4, WebM…).');
    const limit = kind === 'image' ? MAX_IMAGE : MAX_VIDEO;
    if (file.size > limit) {
      const mb = (file.size / 1048576).toFixed(1);
      throw new Error(`Fișierul are ${mb} MB, peste limita de ${limit / 1048576} MB. ` + (kind === 'video' ? 'Încarcă videoclipul pe YouTube, Vimeo sau Google Drive și lipește linkul în câmp.' : 'Micșorează imaginea și încearcă din nou.'));
    }
    const path = 'media/' + Date.now() + '-' + safeName(file.name);
    setUploadStatus(statusEl, 'Se pregătește fișierul…', '');
    barEl.hidden = false;
    barEl.firstChild.style.width = '0%';
    const b64 = bytesToB64(await file.arrayBuffer());
    const t0 = Date.now();
    await putFile(path, b64, 'Upload media ' + path, null, null, (p) => {
      barEl.firstChild.style.width = Math.round(p * 100) + '%';
      setUploadStatus(statusEl, `Se încarcă… ${Math.round(p * 100)}%`, '');
    }).catch(async (e) => {
      // a retry without progress handles the rare case where XHR is blocked
      if (e instanceof GhError && e.status === 0 && Date.now() - t0 < 1500) return putFile(path, b64, 'Upload media ' + path, null);
      throw e;
    });
    if (isImage) { try { S.blobs.set(path, URL.createObjectURL(file)); } catch (e) { /* ignore */ } }
    barEl.firstChild.style.width = '100%';
    setUploadStatus(statusEl, `Încărcat: ${path}. Apare pe site după ce apeși „Publică” (și ~1 minut).`, 'ok');
    return path;
  }

  function thumbSrc(v) {
    const t = (v.thumbnail || '').trim();
    if (t) return S.blobs.get(t) || t;
    try {
      const p = window.Portfolio.parseVideo((v.url || '').trim());
      return (p && p.thumb) || '';
    } catch (e) { return ''; }
  }
  function thumbBox(v, big) {
    const img = h('img', { alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' });
    const box = h('div', { class: 'adm-thumb' + (big ? ' adm-thumb--big' : '') }, img);
    const update = () => {
      box.classList.toggle('adm-thumb--v', !!v.vertical);
      const src = thumbSrc(v);
      img.hidden = !src;
      if (src && img.getAttribute('src') !== src) img.setAttribute('src', src);
    };
    img.addEventListener('error', () => { img.hidden = true; });
    img.addEventListener('load', () => { img.hidden = false; });
    update();
    return { box, update };
  }
  function iconBtn(glyph, title, onclick, disabled, danger) {
    return h('button', { type: 'button', class: 'adm-icon-btn' + (danger ? ' adm-icon-btn--danger' : ''), title, 'aria-label': title, onclick, disabled, text: glyph });
  }
  const EYE_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/><path class="adm-eye-slash" d="M4 4l16 16"/></svg>';
  /** Eye toggle bound to obj.hidden. onToggle(hidden) lets the caller restyle the card. */
  function eyeBtn(obj, onToggle) {
    const b = h('button', { type: 'button', class: 'adm-icon-btn adm-eye' });
    b.innerHTML = EYE_SVG; // static, trusted markup
    const paint = () => {
      const hid = !!obj.hidden;
      b.classList.toggle('adm-eye--off', hid);
      b.setAttribute('aria-label', hid ? 'Arată' : 'Ascunde');
      b.title = hid ? 'Arată' : 'Ascunde';
      b.setAttribute('aria-pressed', String(hid));
      if (onToggle) onToggle(hid);
    };
    b.addEventListener('click', () => { obj.hidden = !obj.hidden; paint(); markDirty(); });
    paint();
    return b;
  }
  /** "Vizibil" / "Ascuns" toggle bound to obj.hidden. */
  function visBtn(obj, onToggle) {
    const b = h('button', { type: 'button', class: 'adm-btn adm-btn--sm adm-vis' });
    const paint = () => {
      const hid = !!obj.hidden;
      b.textContent = hid ? 'Ascuns' : 'Vizibil';
      b.classList.toggle('adm-vis--off', hid);
      b.setAttribute('aria-pressed', String(!hid));
      if (onToggle) onToggle(hid);
    };
    b.addEventListener('click', () => { obj.hidden = !obj.hidden; paint(); markDirty(); });
    paint();
    return b;
  }
  const hiddenBadge = () => h('span', { class: 'adm-badge adm-badge--hidden', text: 'ascuns' });
  function move(arr, i, d) {
    const j = i + d;
    if (j < 0 || j >= arr.length) return;
    [arr[i], arr[j]] = [arr[j], arr[i]];
    markDirty();
    renderTab(true);
  }

  // ------------------------------------------------------------------ tab: Site
  function tabSite() {
    const s = S.content.site;
    const accentValid = /^#[0-9a-f]{6}$/i.test(s.accent);
    const accentText = h('input', { class: 'adm-input', type: 'text', value: s.accent, placeholder: '#ff3b5c', autocomplete: 'off', maxlength: '9' });
    const accentPick = h('input', { class: 'adm-color', type: 'color', value: accentValid ? s.accent : '#ff3b5c', 'aria-label': 'Alege culoarea' });
    accentPick.addEventListener('input', () => { s.accent = accentPick.value; accentText.value = s.accent; markDirty(); });
    accentText.addEventListener('input', () => {
      s.accent = accentText.value.trim();
      if (/^#[0-9a-f]{6}$/i.test(s.accent)) accentPick.value = s.accent;
      markDirty();
    });

    const socials = h('div');
    const drawSocials = () => {
      socials.replaceChildren();
      if (!s.socials.length) socials.append(h('div', { class: 'adm-empty', text: 'Nicio rețea adăugată.' }));
      s.socials.forEach((soc, i) => {
        const label = h('input', { class: 'adm-input', placeholder: 'Nume (ex. Instagram)', value: soc.label, 'aria-label': 'Nume rețea' });
        const url = h('input', { class: 'adm-input', placeholder: 'https://…', value: soc.url, 'aria-label': 'Link' });
        label.addEventListener('input', () => { soc.label = label.value; markDirty(); });
        url.addEventListener('input', () => { soc.url = url.value; markDirty(); });
        socials.append(
          h(
            'div',
            { class: 'adm-social' },
            label,
            url,
            iconBtn('↑', 'Mută sus', () => { move(s.socials, i, -1); }, i === 0),
            iconBtn('↓', 'Mută jos', () => { move(s.socials, i, 1); }, i === s.socials.length - 1),
            iconBtn('✕', 'Șterge', () => { s.socials.splice(i, 1); markDirty(); renderTab(true); }, false, true)
          )
        );
      });
    };
    drawSocials();

    return h(
      'div',
      { class: 'adm-pane' },
      textField('Nume', s, 'name'),
      textField('Rol', s, 'role'),
      textField('Slogan (titlul mare)', s, 'tagline'),
      textField('Introducere', s, 'intro', { textarea: true, rows: 3 }),
      textField('Showreel (link video)', s, 'showreel', { upload: 'video', placeholder: 'https://youtu.be/…', hint: 'Când pui un showreel nou și publici, cel vechi rămâne pe site, în lista din bara de sus.' }),
      textField('Despre mine', s, 'about', { textarea: true, rows: 6, hint: 'Rândurile noi devin paragrafe.' }),
      textField('Email', s, 'email', { type: 'email' }),
      h('div', { class: 'adm-field' }, h('span', { class: 'adm-label', text: 'Culoare accent' }), h('div', { class: 'adm-row' }, accentPick, accentText)),
      h('h3', { class: 'adm-h3', text: 'Rețele sociale' }),
      socials,
      h('button', { type: 'button', class: 'adm-btn adm-btn--sm', text: '+ Adaugă rețea', onclick: () => { s.socials.push({ label: '', url: '' }); markDirty(); renderTab(true); } })
    );
  }

  // ------------------------------------------------------------------ tab: Sections
  function tabSections() {
    const secs = S.content.sections;
    const wrap = h('div', { class: 'adm-pane' });
    if (!secs.length) wrap.append(h('div', { class: 'adm-empty', text: 'Nicio secțiune încă. Adaugă prima!' }));
    secs.forEach((sec, i) => wrap.append(sectionCard(sec, i)));
    wrap.append(
      h('button', {
        type: 'button',
        class: 'adm-btn adm-btn--primary',
        style: 'margin-top:6px',
        text: '+ Adaugă secțiune',
        onclick: () => {
          const ids = new Set(secs.map((x) => x.id));
          const sec = { id: uniqueSlug('sectiune-noua', ids), title: 'Secțiune nouă', description: '', videos: [] };
          secs.push(sec);
          S.autoId.add(sec);
          S.expandedSections.add(sec);
          markDirty();
          renderTab(true);
          setTimeout(() => { D.body.scrollTop = D.body.scrollHeight; }, 0);
        },
      })
    );
    return wrap;
  }

  function sectionCard(sec, i) {
    const secs = S.content.sections;
    const open = S.expandedSections.has(sec);
    const titleSpan = h('span', { class: 'adm-card-title', text: sec.title || '(fără titlu)' });
    const secBadge = hiddenBadge();
    let card;
    const head = h(
      'div',
      { class: 'adm-card-head' },
      h(
        'button',
        { type: 'button', class: 'adm-card-toggle', 'aria-expanded': String(open), onclick: () => { toggleSet(S.expandedSections, sec); renderTab(true); } },
        h('span', { class: 'adm-chev' }),
        titleSpan,
        h('span', { class: 'adm-badge', text: String(sec.videos.length) }),
        secBadge
      ),
      visBtn(sec, (hid) => { secBadge.hidden = !hid; if (card) card.classList.toggle('adm-dim', hid); }),
      iconBtn('↑', 'Mută secțiunea sus', () => move(secs, i, -1), i === 0),
      iconBtn('↓', 'Mută secțiunea jos', () => move(secs, i, 1), i === secs.length - 1),
      iconBtn('✕', 'Șterge secțiunea', () => {
        if (!window.confirm(`Ștergi secțiunea „${sec.title || 'fără titlu'}” și cele ${sec.videos.length} videoclipuri din ea?`)) return;
        secs.splice(i, 1);
        S.expandedSections.delete(sec);
        S.autoId.delete(sec);
        markDirty();
        renderTab(true);
      }, false, true)
    );
    card = h('div', { class: 'adm-card' }, head);
    card.classList.toggle('adm-dim', !!sec.hidden);
    if (!open) return card;

    const idInput = h('input', { class: 'adm-input', value: sec.id, autocomplete: 'off', spellcheck: 'false' });
    idInput.addEventListener('input', () => { S.autoId.delete(sec); sec.id = idInput.value; markDirty(); });
    idInput.addEventListener('change', () => {
      const others = new Set(secs.filter((x) => x !== sec).map((x) => x.id));
      sec.id = uniqueSlug(idInput.value || sec.title, others);
      idInput.value = sec.id;
      markDirty();
    });
    const titleField = textField('Titlu', sec, 'title', {
      onChange: (v) => {
        titleSpan.textContent = v || '(fără titlu)';
        if (S.autoId.has(sec)) {
          const others = new Set(secs.filter((x) => x !== sec).map((x) => x.id));
          sec.id = uniqueSlug(v, others);
          idInput.value = sec.id;
        }
      },
    });

    const list = h('div');
    if (!sec.videos.length) list.append(h('div', { class: 'adm-empty', text: 'Niciun videoclip în această secțiune.' }));
    sec.videos.forEach((v, j) => list.append(videoCard(sec, v, j)));

    card.append(
      h(
        'div',
        { class: 'adm-card-body' },
        titleField,
        textField('Descriere', sec, 'description', { textarea: true, rows: 2 }),
        plainField('ID (slug)', idInput, 'Se generează automat din titlu; apare în adresa secțiunii.'),
        h('div', { class: 'adm-sub' }, h('div', { class: 'adm-sub-head' }, h('span', { class: 'adm-label', style: 'margin:0', text: 'Videoclipuri' })), list),
        h('button', {
          type: 'button',
          class: 'adm-btn adm-btn--sm',
          style: 'margin-top:10px',
          text: '+ Adaugă videoclip',
          onclick: () => {
            const v = { id: uid(), title: 'Videoclip nou', description: '', url: '', thumbnail: '', year: String(new Date().getFullYear()), client: '', vertical: false };
            sec.videos.push(v);
            S.expandedVideos.add(v);
            markDirty();
            renderTab(true);
          },
        })
      )
    );
    return card;
  }

  function videoCard(sec, v, j) {
    const open = S.expandedVideos.has(v);
    const mini = thumbBox(v, false);
    const titleSpan = h('span', { class: 'adm-card-title', text: v.title || '(fără titlu)' });
    const vBadge = hiddenBadge();
    let card;
    card = h(
      'div',
      { class: 'adm-card adm-card--video' },
      h(
        'div',
        { class: 'adm-card-head' },
        h(
          'button',
          { type: 'button', class: 'adm-card-toggle', 'aria-expanded': String(open), onclick: () => { toggleSet(S.expandedVideos, v); renderTab(true); } },
          h('span', { class: 'adm-chev' }),
          mini.box,
          titleSpan,
          vBadge
        ),
        eyeBtn(v, (hid) => { vBadge.hidden = !hid; if (card) card.classList.toggle('adm-dim', hid); }),
        iconBtn('↑', 'Mută sus', () => move(sec.videos, j, -1), j === 0),
        iconBtn('↓', 'Mută jos', () => move(sec.videos, j, 1), j === sec.videos.length - 1),
        iconBtn('✕', 'Șterge videoclipul', () => {
          if (!window.confirm(`Ștergi videoclipul „${v.title || 'fără titlu'}”?`)) return;
          sec.videos.splice(j, 1);
          S.expandedVideos.delete(v);
          markDirty();
          renderTab(true);
        }, false, true)
      )
    );
    card.classList.toggle('adm-dim', !!v.hidden);
    if (!open) return card;

    const big = thumbBox(v, true);
    const refresh = () => { mini.update(); big.update(); };
    const vertical = h('input', { type: 'checkbox', checked: v.vertical });
    vertical.addEventListener('change', () => { v.vertical = vertical.checked; refresh(); markDirty(); });
    card.append(
      h(
        'div',
        { class: 'adm-card-body' },
        h('div', { class: 'adm-preview' }, big.box, h('p', { class: 'adm-hint', style: 'margin:0', text: 'Previzualizare miniatură. Dacă lași miniatura goală, se folosește cea automată (YouTube) sau un fundal generic.' })),
        textField('Titlu', v, 'title', { onChange: (t) => { titleSpan.textContent = t || '(fără titlu)'; } }),
        textField('Descriere', v, 'description', { textarea: true, rows: 2 }),
        textField('Link video', v, 'url', { upload: 'video', placeholder: 'https://youtu.be/… sau media/clip.mp4', onChange: refresh }),
        textField('Miniatură (imagine)', v, 'thumbnail', { upload: 'image', placeholder: 'https://… sau media/miniatura.jpg', onChange: refresh }),
        h('div', { class: 'adm-grid2' }, textField('An', v, 'year'), textField('Client', v, 'client')),
        h('label', { class: 'adm-check' }, vertical, h('span', { text: 'Vertical (9:16: reels / TikTok)' }))
      )
    );
    return card;
  }

  // ------------------------------------------------------------------ tab: Trust blocks
  function trustCard(title, b, ...kids) {
    const badge = hiddenBadge();
    let card;
    card = h(
      'div',
      { class: 'adm-card adm-block' },
      h('div', { class: 'adm-card-head adm-block-head' }, h('span', { class: 'adm-card-title', text: title }), badge, visBtn(b, (hid) => { badge.hidden = !hid; if (card) card.classList.toggle('adm-dim', hid); })),
      h('div', { class: 'adm-card-body' }, ...kids)
    );
    card.classList.toggle('adm-dim', !!b.hidden);
    return card;
  }
  /** Editable list of items. fields(item, updateTitle) returns the nodes of one item's body. */
  function itemList(b, kind, summary, fields, emptyText, addText) {
    const items = b.items;
    const list = h('div', { class: 'adm-items' });
    if (!items.length) list.append(h('div', { class: 'adm-empty', text: emptyText }));
    items.forEach((it, i) => {
      const titleSpan = h('span', { class: 'adm-card-title', text: summary(it) || '(gol)' });
      const badge = hiddenBadge();
      let card;
      card = h(
        'div',
        { class: 'adm-card adm-card--video adm-item' },
        h(
          'div',
          { class: 'adm-card-head' },
          h('span', { class: 'adm-item-title' }, titleSpan, badge),
          eyeBtn(it, (hid) => { badge.hidden = !hid; if (card) card.classList.toggle('adm-dim', hid); }),
          iconBtn('↑', 'Mută sus', () => move(items, i, -1), i === 0),
          iconBtn('↓', 'Mută jos', () => move(items, i, 1), i === items.length - 1),
          iconBtn('✕', 'Șterge', () => {
            if (!window.confirm(`Ștergi „${summary(it) || 'elementul'}” definitiv? (Dacă vrei doar să-l ascunzi, folosește ochiul.)`)) return;
            items.splice(i, 1);
            markDirty();
            renderTab(true);
          }, false, true)
        ),
        h('div', { class: 'adm-card-body' }, fields(it, () => { titleSpan.textContent = summary(it) || '(gol)'; }))
      );
      card.classList.toggle('adm-dim', !!it.hidden);
      list.append(card);
    });
    return h(
      'div',
      { class: 'adm-sub' },
      list,
      h('button', { type: 'button', class: 'adm-btn adm-btn--sm', style: 'margin-top:10px', text: addText, onclick: () => { items.push(trustItemDefaults(kind)); markDirty(); renderTab(true); } })
    );
  }

  function tabTrust() {
    const av = trustBlock('availability');
    const st = trustBlock('stats');
    const cl = trustBlock('clients');
    const te = trustBlock('testimonials');
    const cf = trustBlock('contactForm');
    return h(
      'div',
      { class: 'adm-pane' },
      h('p', { class: 'adm-hint', style: 'margin:0 0 12px', text: 'Blocurile ascunse (sau elementele ascunse) nu apar pe site, dar rămân aici și le poți arăta oricând.' }),
      trustCard('Disponibilitate', av, textField('Text', av, 'text', { placeholder: 'Disponibil pentru proiecte noi', hint: 'Apare ca o mică etichetă cu punct verde în prima pagină și deasupra contactului.' })),
      trustCard(
        'Cifre',
        st,
        itemList(st, 'stats', (it) => [it.value, it.label].filter(Boolean).join(' · '), (it, upd) => [
          h('div', { class: 'adm-grid2' }, textField('Valoare', it, 'value', { placeholder: '2M+', onChange: upd }), textField('Etichetă', it, 'label', { placeholder: 'Vizualizări generate', onChange: upd })),
        ], 'Nicio cifră încă.', '+ Adaugă cifră')
      ),
      trustCard(
        'Am lucrat cu',
        cl,
        textField('Titlul blocului', cl, 'title', { placeholder: 'Worked with', hint: 'Lasă gol pentru titlul implicit („Worked with”).' }),
        itemList(cl, 'clients', (it) => it.name, (it, upd) => [
          textField('Nume', it, 'name', { onChange: upd }),
          textField('Logo (imagine)', it, 'logo', { upload: 'image', placeholder: 'media/logo.png' }),
          textField('Link (opțional)', it, 'url', { placeholder: 'https://…' }),
        ], 'Niciun client încă.', '+ Adaugă client')
      ),
      trustCard(
        'Testimoniale',
        te,
        h('p', { class: 'adm-hint', style: 'margin:0 0 10px', text: 'Folosește doar păreri reale, cu acordul clientului.' }),
        textField('Titlul blocului', te, 'title', { placeholder: 'Kind words', hint: 'Lasă gol pentru titlul implicit („Kind words”).' }),
        itemList(te, 'testimonials', (it) => it.name || (it.quote || '').slice(0, 40), (it, upd) => [
          textField('Citat', it, 'quote', { textarea: true, rows: 3, onChange: upd }),
          h('div', { class: 'adm-grid2' }, textField('Nume', it, 'name', { onChange: upd }), textField('Rol', it, 'role', { placeholder: 'Producer, Brand' })),
          textField('Fotografie (opțional)', it, 'photo', { upload: 'image', placeholder: 'media/persoana.jpg' }),
        ], 'Niciun testimonial încă.', '+ Adaugă testimonial')
      ),
      trustCard(
        'Formular de contact',
        cf,
        h(
          'div',
          { class: 'adm-note', style: 'margin-bottom:14px' },
          h('p', null, 'Cum obții cheia: intră pe ', h('a', { href: 'https://web3forms.com', target: '_blank', rel: 'noopener noreferrer', text: 'web3forms.com' }), ', introdu adresa ta de email, iar cheia (access key) îți vine pe email. Lipește-o mai jos.'),
          h('p', { text: 'Cheia poate fi publică fără risc: permite doar trimiterea mesajelor din formular către emailul tău.' }),
          h('p', { text: 'Formularul apare pe site doar când cheia este completată și blocul este „Vizibil”.' })
        ),
        textField('Access key', cf, 'accessKey', { placeholder: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx' }),
        textField('Text buton', cf, 'buttonText', { placeholder: 'Send message' })
      )
    );
  }

  // ------------------------------------------------------------------ tab: Settings
  function tabSettings() {
    // change password
    const cur = passwordField('Parola curentă', { autocomplete: 'current-password' });
    const np = passwordField('Parola nouă', { meter: true });
    const np2 = passwordField('Confirmă parola nouă');
    const pwMsg = msgEl();
    const pwBtn = h('button', { type: 'submit', class: 'adm-btn', text: 'Schimbă parola' });
    const pwForm = h(
      'form',
      {
        onsubmit: async (e) => {
          e.preventDefault();
          if (np.input.value.length < 10) return setMsg(pwMsg, 'Parola nouă trebuie să aibă cel puțin 10 caractere.', 'err');
          if (np.input.value !== np2.input.value) return setMsg(pwMsg, 'Cele două parole noi nu coincid.', 'err');
          pwBtn.disabled = true;
          try {
            setMsg(pwMsg, 'Verific parola curentă…', 'warn');
            await decryptToken(S.auth, cur.input.value);
            setMsg(pwMsg, 'Criptez și salvez…', 'warn');
            const enc = await encryptToken(S.token, np.input.value);
            const authObj = { version: 1, owner: S.auth.owner, repo: S.auth.repo, branch: S.auth.branch, kdf: enc.kdf, iv: enc.iv, ciphertext: enc.ciphertext };
            await commitFile(AUTH_PATH, utf8ToB64(JSON.stringify(authObj, null, 2) + '\n'), 'Change admin password');
            S.auth = authObj;
            pwForm.reset();
            np.input.dispatchEvent(new Event('input'));
            setMsg(pwMsg, 'Parola a fost schimbată. Intră în vigoare în ~1 minut pe site-ul public.', 'ok');
          } catch (err) {
            if (err && err.code === 'BADPASS') await sleep(700);
            setMsg(pwMsg, err && err.code === 'BADPASS' ? 'Parola curentă este greșită.' : describeError(err), 'err');
          }
          pwBtn.disabled = false;
        },
      },
      cur.wrap, np.wrap, np2.wrap, pwBtn, pwMsg
    );

    return h(
      'div',
      { class: 'adm-pane' },
      h('h3', { class: 'adm-h3', text: 'Schimbă parola' }),
      pwForm,
      h('h3', { class: 'adm-h3', text: 'Token GitHub' }),
      h('p', { class: 'adm-hint', style: 'margin:0 0 10px', text: 'Dacă token-ul a expirat sau a fost revocat, creează unul nou și înlocuiește-l aici.' }),
      h('button', { type: 'button', class: 'adm-btn', text: 'Înlocuiește token', onclick: () => viewSetup('replace') }),
      h('h3', { class: 'adm-h3', text: 'Sesiune' }),
      h('button', {
        type: 'button',
        class: 'adm-btn adm-btn--danger',
        text: 'Deconectează-te',
        onclick: () => {
          if (S.dirty && !window.confirm('Ai modificări nepublicate. Dacă te deconectezi, se pierd. Continui?')) return;
          logout();
        },
      }),
      h('h3', { class: 'adm-h3', text: 'Cum funcționează' }),
      h(
        'div',
        { class: 'adm-note' },
        h('p', { text: 'Site-ul este static, găzduit pe GitHub Pages. „Publică” salvează conținutul ca un commit în repository, iar Pages îl afișează după ~1 minut.' }),
        h('p', { text: 'Pentru a scrie în repository se folosește un token GitHub limitat la acest repo. Token-ul este criptat în browser (PBKDF2 + AES-256-GCM) cu parola ta; pe GitHub este stocat doar textul criptat, în data/auth.json. Fără parolă nimeni nu îl poate folosi.' }),
        h('p', { text: 'Modificările se văd imediat în pagină ca previzualizare, dar devin publice doar după „Publică”. Token-ul decriptat rămâne doar în memoria acestei file (sessionStorage) și dispare când o închizi sau te deconectezi.' })
      )
    );
  }

  // ------------------------------------------------------------------ boot
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (modalOpen()) closeModal();
    else if (D.root && D.root.classList.contains('adm-open')) setDrawerOpen(false);
  });

  function init() {
    let trigger = document.getElementById('admin-trigger');
    if (!trigger) {
      trigger = h('button', { id: 'admin-trigger', class: 'adm-scope adm-fab', type: 'button', 'aria-label': 'Admin', title: 'Admin' });
      trigger.innerHTML = LOCK_SVG; // static, trusted markup
      document.body.append(trigger);
    }
    trigger.addEventListener('click', onTrigger);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  window.PortfolioAdmin = { encryptToken, decryptToken };
})();
