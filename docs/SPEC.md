# Portofolio — technical spec (contract between site and admin)

Static video-editing portfolio hosted on **GitHub Pages** (repo `denys702-wq/Portofolio`, branch `main`,
served from the repo root). No build step, no Node, no frameworks: plain HTML + CSS + vanilla JS (ES2020),
works by opening via any static server (`python -m http.server`).

## File layout

```
index.html                public page (owned by SITE agent)
assets/css/style.css      public styles (SITE)
assets/js/site.js         loads content, renders, player, exposes window.Portfolio (SITE)
assets/css/admin.css      admin UI styles (ADMIN agent)
assets/js/admin.js        admin: password, crypto, GitHub API, editor drawer (ADMIN)
data/content.json         ALL editable content (SITE writes the sample)
data/auth.json            encrypted GitHub token + repo coordinates (ADMIN writes the initial file)
media/                    uploaded thumbnails / short clips (create media/.gitkeep)
.nojekyll                 empty file (SITE)
```

`index.html` must include, in this order, at the end of body:
```html
<script src="assets/js/site.js" defer></script>
<script src="assets/js/admin.js" defer></script>
```
and in head: `<link rel="stylesheet" href="assets/css/style.css">` then `<link rel="stylesheet" href="assets/css/admin.css">`.

## data/content.json schema

```json
{
  "site": {
    "name": "Your Name",                 // shown in nav/logo and <title>
    "role": "Video Editor",
    "tagline": "Cuts that move people.",  // big hero headline
    "intro": "Short paragraph under the hero.",
    "showreel": "https://www.youtube.com/watch?v=...",   // any supported video URL or "" (hero background / play button)
    "about": "Longer about text. Newlines = paragraphs.",
    "email": "you@example.com",
    "socials": [ { "label": "Instagram", "url": "https://instagram.com/..." } ],
    "accent": "#ff3b5c"                  // CSS accent colour; site sets --accent from it
  },
  "sections": [
    {
      "id": "music-videos",              // slug, unique
      "title": "Music Videos",
      "description": "One line about this genre.",
      "videos": [
        {
          "id": "v-1730000000000",        // unique
          "title": "Artist — Song",
          "description": "Optional text.",
          "url": "https://youtu.be/xxxx", // YouTube, Vimeo, Google Drive share link, direct .mp4/.webm URL, or relative "media/clip.mp4"
          "thumbnail": "",                // optional image URL or "media/thumb.jpg"; empty = auto (YouTube) or gradient placeholder
          "year": "2026",
          "client": "",
          "vertical": false               // true for 9:16 content (reels/tiktok) -> card + player use vertical ratio
        }
      ]
    }
  ]
}
```
Sample content: 5 genres (Music Videos, Commercials, Social Media / Reels (vertical), Weddings & Events,
Short Films / Documentary), each with 2–3 videos using real, public, embeddable YouTube/Vimeo URLs
(e.g. well-known short films/music videos are fine as placeholders), plus a showreel URL.

## window.Portfolio API (implemented in site.js, used by admin.js)

```js
window.Portfolio = {
  ready,                 // Promise resolved after first content load + render
  getContent(),          // returns a deep clone of current content object
  setContent(obj),       // replaces content and re-renders everything (no network)
  render(),              // re-render from current content
  parseVideo(url),       // -> { type: 'youtube'|'vimeo'|'drive'|'file'|'unknown', id, embedUrl, thumb }
                         //    embedUrl autoplays when opened in player; thumb = auto thumbnail or ''
  openPlayer(video),     // opens the lightbox player for a video object
};
document.dispatchEvent(new CustomEvent('portfolio:rendered'))  // after every render
```
- site.js loads content with `fetch('data/content.json?v=' + Date.now(), {cache:'no-store'})`.
- If the fetch fails, show a tasteful error state (don't crash).
- All user text is inserted with textContent / escaping, never raw innerHTML (no XSS).

## Admin button

SITE puts in the footer: `<button id="admin-trigger" class="admin-trigger" type="button" aria-label="Admin">`
(small, discreet lock icon). ADMIN binds to it; if missing, ADMIN injects its own discreet floating button.

## data/auth.json schema (ADMIN)

Initial (not yet set up):
```json
{ "version": 1, "owner": "denys702-wq", "repo": "Portofolio", "branch": "main" }
```
After setup:
```json
{ "version": 1, "owner": "...", "repo": "...", "branch": "main",
  "kdf": { "name": "PBKDF2", "hash": "SHA-256", "iterations": 600000, "salt": "<base64 16 bytes>" },
  "iv": "<base64 12 bytes>", "ciphertext": "<base64 AES-GCM of the GitHub token>" }
```

## Security model

Writing to the site = committing to the GitHub repo through the GitHub REST API with a **fine-grained
personal access token** (only this repo, Contents: Read & write). The token is encrypted in the browser
with the admin password (PBKDF2-SHA256 600k → AES-GCM 256) and the ciphertext is stored in
`data/auth.json`. Without the password nobody can decrypt the token, so nobody else can change the site.
Visitors who open the admin panel before setup cannot harm anything: a token of theirs has no write
access to this repo.
