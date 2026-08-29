# Adventure — Marketing Website

Static marketing site for **Adventure**, a travel companion app for Romblon Province, Philippines. Plain HTML/CSS, no build step required.

## Folder structure

```
adventure-website/
├── index.html          Home
├── features.html       Feature breakdown
├── romblon.html         Province / island guide
├── about.html           Founder story
├── press.html           Press kit
├── contact.html         Contact / early-access form
├── css/
│   └── styles.css      Shared design tokens + all page styles
├── assets/
│   └── images/          Drop real screenshots, logo, and photos here
├── .vscode/
│   ├── settings.json    Live Server config
│   └── extensions.json  Recommends the Live Server extension
├── package.json
└── README.md
```

## Running it in VS Code

**Option A — Live Server extension (recommended, zero setup)**

1. Open this folder in VS Code (`File → Open Folder…`).
2. Install the recommended extension when prompted (or search "Live Server" by Ritwick Dey in the Extensions panel).
3. Right-click `index.html` → **Open with Live Server**.
4. It opens at `http://127.0.0.1:5500` and reloads automatically on save.

**Option B — npm scripts (no extension needed)**

Requires [Node.js](https://nodejs.org) installed.

```bash
npm run start   # serves the folder at http://localhost:5500
# or
npm run dev     # live-reloading dev server at http://localhost:5500
```

**Option C — just open the files**

Every page works by double-clicking `index.html` directly in a browser — no server required, since there's no build step and no external API calls. A local server (Option A/B) is only useful for auto-reload while editing.

## Before this goes live

- [ ] Replace `css/logo.png` with your real logo — the current one is a generated placeholder using your brand colors and the site's route-line motif, sized 512×512.
- [ ] Add your mockup screenshots to `css/` with these exact filenames (referenced directly in the HTML):
  - `hero-1.png`, `hero-2.png`, `hero-3.png` — home page hero carousel (currently captioned "Batangas → Odiongan", "Dangay → Odiongan", "Romblon → Sibuyan" — edit the captions in `index.html`'s `.carousel-route` spans if you want different routes)
  - `1.png`, `2.png`, `3.png` — home page phone row (Itinerary, Ferry Routes, Ask Isla)
  - `4.png` through `9.png` — features page, one per feature section in page order (trip planning, ferries & terminals, Isla, offline, memories, group trips)
  - `romblon-1.png` through `romblon-6.png` — romblon.html island cards, in page order (Romblon, Tablas, Sibuyan, Carabao, Banton, Simara). Named separately from `1.png`–`9.png` to avoid overwriting the home/features screenshots, since all images share the same `css/` folder.
  - Recommended: portrait screenshots, roughly 9:19.3 aspect ratio to match the phone frame (`object-fit: cover` will crop anything that doesn't match exactly). Island images work best as landscape/square photos — they render at 140×140px (84×84px for the 3-column Carabao/Banton/Simara cards), cropped via `object-fit: cover`. Hero carousel images work best around 4:5 portrait.
- [ ] Wire the form in `contact.html` to a real backend or service (e.g. [Formspree](https://formspree.io), [Netlify Forms](https://www.netlify.com/platform/core/forms/), or your own endpoint) — it currently submits nowhere.
- [ ] Update `hello@adventure.ph` throughout if using a different contact address.
- [ ] Double check the island → municipality groupings on `romblon.html` against your app's actual data (a few municipalities currently appear under more than one island in the app's own provider data — worth confirming which grouping is correct before publishing).

## Deploying

This is a fully static site — it can be hosted on **any** static host with zero configuration:

- **Netlify / Vercel**: drag-and-drop the folder, or connect a GitHub repo.
- **GitHub Pages**: push this folder to a repo and enable Pages in settings.
- **Firebase Hosting**: since you're already on Firebase — `firebase init hosting`, point it at this folder, `firebase deploy`.
