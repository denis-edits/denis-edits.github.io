# Portofolio — editare video

Site de portofoliu pentru editare video, găzduit gratuit pe **GitHub Pages**.
Tot conținutul (texte, secțiuni pe genuri, videoclipuri) se editează **direct din site**, din panoul de admin
protejat cu parolă.

Adresa publică: **https://denys702-wq.github.io/Portofolio/**

## Cum editezi site-ul

1. Deschide site-ul și apasă pe **lacătul discret din subsol** (butonul de admin).
2. Introdu parola. Se deschide editorul din dreapta:
   - **Site**: nume, rol, titlul mare, intro, showreel, despre mine, email, culoare accent, rețele sociale.
   - **Secțiuni**: câte o secțiune pe gen (Music Videos, Reels, Nunți…). Adaugi, redenumești, muți, ștergi
     secțiuni și videoclipuri.
   - **Setări**: schimbi parola, înlocuiești tokenul GitHub, te deconectezi.
3. Vezi modificările pe loc. Apasă **Publică**: site-ul se actualizează pentru toată lumea în ~1 minut.

### Videoclipuri
- Recomandat: urci clipul pe **YouTube** (poate fi *Unlisted*), **Vimeo** sau **Google Drive** (partajat „Oricine
  are linkul”) și lipești linkul. Thumbnail-ul de la YouTube se pune automat.
- Clipuri scurte (≤ 50 MB) și imagini (≤ 10 MB) se pot urca direct, cu butonul **Încarcă fișier**.
  GitHub are limite de spațiu și trafic, de aceea clipurile mari merg pe YouTube/Vimeo/Drive.
- Bifează **Vertical** pentru Reels / TikTok / Shorts (format 9:16).

## Configurare inițială (o singură dată)

1. Creează un **token GitHub fine-grained**:
   <https://github.com/settings/personal-access-tokens/new>
   - *Repository access*: **Only select repositories** → `Portofolio`
   - *Permissions → Repository permissions → Contents*: **Read and write**
   - Alege o expirare (când expiră, faci un token nou și îl înlocuiești din **Setări**).
2. Pe site, apasă lacătul → **Configurare inițială**: lipești tokenul și alegi parola de admin.

## De ce e sigur

Orice modificare a site-ului este un commit în acest repo, făcut cu tokenul tău GitHub. Tokenul este
**criptat în browser cu parola ta** (PBKDF2-SHA256, 600.000 iterații → AES-GCM 256) și doar varianta
criptată este salvată în `data/auth.json`. Fără parolă, tokenul nu poate fi folosit, deci nimeni altcineva
nu poate modifica site-ul.

- Folosește o parolă **lungă** (minim 12 caractere, ideal o frază), pentru că fișierul criptat e public.
- Tokenul are acces doar la acest repo, doar la conținut.
- Dacă bănuiești ceva, șterge tokenul din GitHub (Settings → Developer settings) și fă altul.

## Structură

```
index.html            pagina publică
assets/css/           stiluri (site + admin)
assets/js/site.js     afișarea conținutului, player video
assets/js/admin.js    panoul de admin (parolă, criptare, publicare prin GitHub API)
data/content.json     tot conținutul editabil
data/auth.json        tokenul criptat
media/                fișiere urcate din admin
docs/SPEC.md          specificația tehnică
```

Test local: `python -m http.server 8000` în acest folder, apoi <http://localhost:8000>.
