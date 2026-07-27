# Conspiracy

An infinite-canvas whiteboard for pinning up ideas and linking them with
red thread — cards, labelled frames, live web embeds, and jump buttons,
connected by labelled arrows.

**[Open the board →](https://garyridgway.github.io/conspiracy/)**

Vanilla JavaScript. No build step, no frameworks, no runtime
dependencies: `index.html` + `styles.css` + `app.js` are the whole app.
Boards are stored in your browser; syncing them through your own Google
Drive is optional and off by default, and the app makes no network
requests until you opt in.

## Documentation

- **[GUIDE.md](GUIDE.md)** — what you can do in the app: every item type,
  gesture, menu, shortcut and setting. Start here.
- **[SETUP-google-drive.md](SETUP-google-drive.md)** — wiring up Drive
  sync on your own deployment.
- **[ARCHITECTURE.md](ARCHITECTURE.md)** — how it works inside, and the
  invariants to respect before changing sync, merge, persistence, node
  kinds or keyboard handling. Read this before contributing.
- **[ROADMAP.md](ROADMAP.md)** — wanted but unbuilt, and why.

In the app, press **?** for the shortcut cheat-sheet.

## Running it locally

Serve the repo root over HTTP — `file://` won't do, because real
localStorage needs an origin:

```sh
python3 -m http.server 8123    # then open http://localhost:8123
```

## Tests

```sh
npm install        # Playwright
npm test           # full suite (starts its own server)
npm run test:cards # one feature area while iterating
```

Buckets: `canvas` `cards` `connections` `frames` `buttons` `boards` `nav`
`select` `undo` `chrome` `a11y` `dock` `touch`.

## Deployment

`main` deploys to GitHub Pages on every push. There is no CI build — the
served files are the source files.
