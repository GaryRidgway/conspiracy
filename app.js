(() => {
  'use strict';

  // ════════════════════════════════════════════════════════
  //  DATA MODEL
  //  One board document. Keyed MAPS for every collection;
  //  positions in world coordinates. Synced to Drive as JSON.
  // ════════════════════════════════════════════════════════
  const STORAGE_KEY = 'whiteboard';
  const SCHEMA_VERSION = 1;
  const MIN_ZOOM = 0.1;   // 10% overview
  const MAX_ZOOM = 4;     // 400% detail (past this, DOM text blurs)
  const ZOOM_SPEED = 0.0035; // wheel/pinch → zoom sensitivity (higher = faster)
  // Every iframe lays its page out at this logical width (a desktop layout),
  // then we CSS-scale that render down to fit the node's box. Zoomed out it's
  // a crisp thumbnail; zoomed in it sharpens to a normal desktop view instead
  // of a magnified narrow/mobile layout.
  const IFRAME_LOGICAL_WIDTH = 1440;
  // Lazy-load iframes: only load the src once a frame is on-screen (within a
  // margin) AND large enough on screen to be worth rendering. Heavy embeds
  // (e.g. Google Docs) off-screen or shrunk to a dot stay as placeholders.
  const FRAME_MIN_LOAD_PX = 120;   // skip loading if narrower than this on screen
  const FRAME_LOAD_MARGIN = 0.5;   // load within 1.5× the viewport

  function blankBoard() {
    return {
      schema: SCHEMA_VERSION,
      version: 0,                       // bumped on every commit — the sync watermark
      viewport: { x: 0, y: 0, zoom: 1 },// world-space offset + scale
      cards: {},                        // { id: { x, y, title, body } }
      iframes: {},                      // { id: { x, y, w, h, src } }
      connections: {}                   // { id: { from, to } } — from/to are any node id
    };
  }

  let board = blankBoard();   // the open board's content (set at boot)
  let currentBoardId = null;

  // ════════════════════════════════════════════════════════
  //  THREE-WAY MERGE — reconcile a Drive board without clobbering
  //  changes the other side made. Given the common ancestor (the
  //  last-synced "base"), we know what each side actually edited, so
  //  non-overlapping edits both survive; only the SAME field of the
  //  SAME node edited on both sides is a true conflict (local wins).
  // ════════════════════════════════════════════════════════
  // Node/connection records are flat objects of primitives, so a shallow
  // key+value compare is a correct equality test.
  function shallowEqual(a, b) {
    if (a === b) return true;
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => a[k] === b[k]);
  }
  // Merge one record (node/connection) edited on both sides, field by field.
  // Returns [mergedRecord, hadFieldConflict].
  function mergeRecord(base, local, remote) {
    base = base || {};
    const merged = {};
    let conflict = false;
    const keys = new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)]);
    for (const k of keys) {
      const bv = base[k], lv = local[k], rv = remote[k];
      const lChanged = lv !== bv, rChanged = rv !== bv;
      if (lChanged && rChanged && lv !== rv) { merged[k] = lv; conflict = true; }  // true tie → local wins
      else if (lChanged) merged[k] = lv;
      else if (rChanged) merged[k] = rv;
      else merged[k] = lv !== undefined ? lv : rv;
    }
    return [merged, conflict];
  }
  // Merge one keyed collection (cards | iframes | connections).
  function mergeCollection(base, local, remote) {
    const out = {};
    const conflictIds = [];
    const ids = new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)]);
    for (const id of ids) {
      const b = base[id], l = local[id], r = remote[id];
      const lChanged = !shallowEqual(b, l);   // includes add (b undefined) and delete (l undefined)
      const rChanged = !shallowEqual(b, r);
      if (!lChanged && !rChanged) { if (l !== undefined) out[id] = l; continue; }   // untouched
      if (lChanged && !rChanged)  { if (l !== undefined) out[id] = l; continue; }   // only this side (edit/add/delete)
      if (!lChanged && rChanged)  { if (r !== undefined) out[id] = r; continue; }   // only the other side
      // both sides changed this id:
      if (l === undefined && r === undefined) continue;                 // both deleted → gone
      if (l === undefined || r === undefined) { out[id] = l || r; conflictIds.push(id); continue; } // delete vs edit → keep the edit
      const [merged, hadConflict] = mergeRecord(b, l, r);
      out[id] = merged;
      if (hadConflict) conflictIds.push(id);
    }
    return { out, conflictIds };
  }
  // Three-way merge of whole boards. Keeps THIS device's viewport, bumps
  // version. Returns { merged, conflicts }.
  function mergeBoards(base, local, remote) {
    base = base || blankBoard();
    const conflictItems = [];
    const merged = {
      schema: local.schema || remote.schema || SCHEMA_VERSION,
      version: Math.max(local.version || 0, remote.version || 0) + 1,
      viewport: local.viewport || remote.viewport || { x: 0, y: 0, zoom: 1 },
    };
    for (const coll of ['cards', 'iframes', 'connections']) {
      const res = mergeCollection(base[coll] || {}, local[coll] || {}, remote[coll] || {});
      merged[coll] = res.out;
      for (const id of res.conflictIds) conflictItems.push({ coll, id });
    }
    const normalized = normalizeBoard(merged);
    // label each conflicted item from the merged content, for the notice
    for (const it of conflictItems) {
      const n = normalized[it.coll][it.id];
      it.label = it.coll === 'cards' ? ((n && n.title) || 'Untitled card')
        : it.coll === 'iframes' ? ((n && (n.src || '').replace(/^https?:\/\//, '').split('/')[0]) || 'Frame')
        : 'a connection';
    }
    return { merged: normalized, conflicts: conflictItems.length, conflictItems };
  }
  // Test hook (pure function; no side effects) so the merge logic can be
  // exercised without the live Drive/OAuth flow.
  window.__wb_mergeBoards = mergeBoards;

  // ════════════════════════════════════════════════════════
  //  PERSISTENCE — a local library of boards (device-backed for
  //  now; Drive boards slot in later). Each board's content lives
  //  under its own key; the library lists them.
  // ════════════════════════════════════════════════════════
  const LIB_KEY = 'whiteboard:library';
  const CURRENT_KEY = 'whiteboard:current';
  const boardKey = (id) => 'whiteboard:board:' + id;
  // Merge base: the board content as it stood at the last successful sync — the
  // common ancestor a three-way merge diffs against. Stored per Drive board.
  const baseKey = (id) => 'whiteboard:base:' + id;
  function saveBase(id, content) {
    try { localStorage.setItem(baseKey(id), JSON.stringify(contentForStore(content))); } catch (e) { /* quota */ }
  }
  function loadBase(id) {
    try { const raw = localStorage.getItem(baseKey(id)); return raw ? JSON.parse(raw) : null; }
    catch { return null; }
  }
  function clearBase(id) { try { localStorage.removeItem(baseKey(id)); } catch (e) { /* ignore */ } }

  // ════════════════════════════════════════════════════════
  //  GOOGLE DRIVE — opt-in per board. Auth is the Google Identity
  //  Services token flow (drive.file scope). Nothing is stored on a
  //  server; the access token lives only in memory for the session.
  //  External Google scripts load lazily on first Connect, so the
  //  app (and tests) never touch the network unless the user opts in.
  // ════════════════════════════════════════════════════════
  const DRIVE = (() => {
    const cfg = window.WHITEBOARD_CONFIG || {};
    const SCOPE = 'https://www.googleapis.com/auth/drive.file';
    const BOUNDARY = '-=-=-whiteboard' + Math.random().toString(36).slice(2);
    const TOKEN_CACHE = 'whiteboard:drive:tok';
    let tokenClient = null, accessToken = null, tokenExpiry = 0;
    let gisLoaded = false;

    const configured = () => !!cfg.googleClientId;
    const tokenValid = () => !!accessToken && Date.now() < tokenExpiry - 60000;

    // Cache the short-lived access token in sessionStorage so a page reload
    // within its ~1h life reconnects instantly — no popup, no network. (Session,
    // not local, so it's gone when the tab closes.)
    function persistToken() {
      try { sessionStorage.setItem(TOKEN_CACHE, JSON.stringify({ t: accessToken, e: tokenExpiry })); } catch (e) { /* ignore */ }
    }
    function clearToken() {
      accessToken = null; tokenExpiry = 0;
      try { sessionStorage.removeItem(TOKEN_CACHE); } catch (e) { /* ignore */ }
    }
    (function restoreToken() {
      try {
        const o = JSON.parse(sessionStorage.getItem(TOKEN_CACHE) || 'null');
        if (o && o.t) { accessToken = o.t; tokenExpiry = o.e || 0; }
      } catch (e) { /* ignore */ }
    })();

    function loadScript(src) {
      return new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = src; s.async = true; s.defer = true;
        s.onload = resolve;
        s.onerror = () => reject(new Error('Failed to load ' + src));
        document.head.appendChild(s);
      });
    }
    async function ensureGis() {
      if (gisLoaded) return;
      await loadScript('https://accounts.google.com/gsi/client');
      gisLoaded = true;
    }

    // Request (or silently refresh) an access token. `interactive` shows the
    // Google account chooser / consent popup; a refresh can be silent.
    async function connect(interactive = true) {
      if (!configured()) throw new Error('Google Drive is not configured (missing client ID in config.js).');
      await ensureGis();
      return new Promise((resolve, reject) => {
        if (!tokenClient) {
          tokenClient = google.accounts.oauth2.initTokenClient({
            client_id: cfg.googleClientId,
            scope: SCOPE,
            callback: (resp) => {
              if (resp && resp.error) { reject(new Error(resp.error)); return; }
              accessToken = resp.access_token;
              tokenExpiry = Date.now() + (resp.expires_in || 3600) * 1000;
              persistToken();
              resolve(accessToken);
            },
            error_callback: (err) => reject(new Error((err && err.type) || 'auth failed')),
          });
        }
        tokenClient.requestAccessToken({ prompt: interactive ? '' : 'none' });
      });
    }
    function signOut() {
      if (accessToken && window.google && google.accounts) {
        try { google.accounts.oauth2.revoke(accessToken); } catch (e) { /* ignore */ }
      }
      clearToken();
    }

    async function authed() {
      if (tokenValid()) return accessToken;
      return connect(true);
    }

    // Create a new Drive file holding the board JSON; returns { id, name }.
    async function createFile(name, contentObj) {
      const token = await authed();
      const meta = { name: name + '.whiteboard.json', mimeType: 'application/json' };
      const body =
        '--' + BOUNDARY + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' +
        JSON.stringify(meta) + '\r\n' +
        '--' + BOUNDARY + '\r\nContent-Type: application/json\r\n\r\n' +
        JSON.stringify(contentObj) + '\r\n' +
        '--' + BOUNDARY + '--';
      const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,version', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'multipart/related; boundary=' + BOUNDARY },
        body,
      });
      if (!res.ok) throw new Error('Drive create failed (' + res.status + ')');
      return res.json();
    }
    // Rename an existing Drive file (metadata only); returns { id, name, version }.
    async function renameFile(fileId, name) {
      const token = await authed();
      const res = await fetch('https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(fileId) + '?fields=id,name,version', {
        method: 'PATCH',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name + '.whiteboard.json' }),
      });
      if (!res.ok) throw new Error('Drive rename failed (' + res.status + ')');
      return res.json();
    }
    // Overwrite an existing Drive file's contents; returns { id, name, version }.
    async function updateFile(fileId, contentObj) {
      const token = await authed();
      const res = await fetch('https://www.googleapis.com/upload/drive/v3/files/' + encodeURIComponent(fileId) + '?uploadType=media&fields=id,name,version', {
        method: 'PATCH',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify(contentObj),
      });
      if (!res.ok) throw new Error('Drive save failed (' + res.status + ')');
      return res.json();
    }
    // Cheap metadata read (no content) to detect remote changes; { id, name, version, modifiedTime }.
    async function getMeta(fileId) {
      const token = await authed();
      const res = await fetch('https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(fileId) + '?fields=id,name,version,modifiedTime', {
        headers: { Authorization: 'Bearer ' + token },
      });
      if (!res.ok) throw new Error('Drive metadata failed (' + res.status + ')');
      return res.json();
    }
    // Download a Drive file's JSON contents (parsed).
    async function getFile(fileId) {
      const token = await authed();
      const res = await fetch('https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(fileId) + '?alt=media', {
        headers: { Authorization: 'Bearer ' + token },
      });
      if (!res.ok) throw new Error('Drive open failed (' + res.status + ')');
      return res.json();
    }

    // Google Picker — lets the user choose a board file (including ones shared
    // with them; drive.file then grants this app access to just that file).
    let pickerReady = false;
    async function ensurePicker() {
      if (pickerReady) return;
      await loadScript('https://apis.google.com/js/api.js');
      await new Promise((resolve) => gapi.load('picker', { callback: resolve }));
      pickerReady = true;
    }
    // Resolves to { id, name } of the picked file, or null if cancelled.
    // The Cloud project number, needed so the Picker actually grants this app
    // drive.file access to a file the user picks (esp. one shared TO them, which
    // the app didn't create). It's the numeric prefix of the OAuth client id.
    const APP_ID = (cfg.googleClientId || '').split('-')[0];
    async function pickFile() {
      const token = await authed();
      await ensurePicker();
      return new Promise((resolve) => {
        // Two views so both owned boards AND ones shared with this user appear;
        // picking either grants drive.file access to just that file.
        const mkView = (ownedByMe) => {
          const v = new google.picker.DocsView(google.picker.ViewId.DOCS)
            .setMimeTypes('application/json')
            .setMode(google.picker.DocsViewMode.LIST);
          if (ownedByMe != null) v.setOwnedByMe(ownedByMe);
          return v;
        };
        const builder = new google.picker.PickerBuilder()
          .setOAuthToken(token)
          .setAppId(APP_ID)                 // required for drive.file grants
          .addView(mkView(true))            // My Drive
          .addView(mkView(false))           // Shared with me
          .setTitle('Open a whiteboard from Drive')
          .setCallback((data) => {
            const a = data[google.picker.Response.ACTION];
            if (a === google.picker.Action.PICKED) {
              const doc = data[google.picker.Response.DOCUMENTS][0];
              resolve({ id: doc[google.picker.Document.ID], name: doc[google.picker.Document.NAME] });
            } else if (a === google.picker.Action.CANCEL) {
              resolve(null);
            }
          });
        if (cfg.googleApiKey) builder.setDeveloperKey(cfg.googleApiKey);
        builder.build().setVisible(true);
      });
    }

    return { configured, isConnected: tokenValid, connect, signOut,
             createFile, updateFile, renameFile, getFile, getMeta, pickFile };
  })();

  function isPlainBoardObject(d) {
    return !!d && typeof d === 'object' && !Array.isArray(d);
  }

  // Shallow-merge arbitrary data onto a blank board so missing/future fields
  // stay valid. Shared by content load and JSON import.
  function normalizeBoard(data) {
    return Object.assign(blankBoard(), data, {
      viewport: Object.assign({ x: 0, y: 0, zoom: 1 }, data && data.viewport),
      cards: (data && data.cards) || {},
      iframes: (data && data.iframes) || {},
      connections: (data && data.connections) || {}
    });
  }

  function newBoardId() {
    return 'b_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  }
  function loadLibrary() {
    try { const a = JSON.parse(localStorage.getItem(LIB_KEY)); return Array.isArray(a) ? a : []; }
    catch { return []; }
  }
  function saveLibrary(lib) { try { localStorage.setItem(LIB_KEY, JSON.stringify(lib)); } catch (e) { /* quota */ } }
  function libraryEntry(id) { return loadLibrary().find((b) => b.id === id) || null; }
  function touchLibrary(id) {
    const lib = loadLibrary();
    const e = lib.find((b) => b.id === id);
    if (e) { e.updatedAt = Date.now(); saveLibrary(lib); }
  }
  // Record the sync watermark for a Drive board: the local board.version and the
  // Drive file version that were last known to be in agreement. Divergence from
  // these on either side is how we detect remote/local changes (and conflicts).
  function setDriveSyncMeta(id, localVersion, driveVersion) {
    const lib = loadLibrary();
    const e = lib.find((b) => b.id === id);
    if (!e) return;
    if (localVersion != null) e.syncedLocalVersion = localVersion;
    if (driveVersion != null) e.driveVersion = String(driveVersion);
    saveLibrary(lib);
  }

  function loadBoardContent(id) {
    let b;
    try {
      const raw = localStorage.getItem(boardKey(id));
      b = raw ? normalizeBoard(JSON.parse(raw)) : blankBoard();
    } catch (e) {
      console.warn('Could not parse saved board, starting fresh.', e);
      b = blankBoard();
    }
    // Viewport comes from the local per-device key; fall back to any value
    // embedded in legacy content (migrated out on the next save).
    b.viewport = loadViewport(id, b.viewport);
    return b;
  }
  // Viewport (pan/zoom) is a per-DEVICE view preference, NOT board content: it's
  // stored under its own local key, never written to Drive, and never bumps the
  // content version. This stops pans/zooms from churning the sync (and from
  // yanking one device's view to another's when a remote change is pulled).
  const contentForStore = (b) => { const { viewport, ...rest } = b; return rest; };
  const viewportKey = (id) => 'whiteboard:viewport:' + id;
  function loadViewport(id, fallback) {
    try {
      const raw = localStorage.getItem(viewportKey(id));
      if (raw) { const v = JSON.parse(raw); return { x: +v.x || 0, y: +v.y || 0, zoom: +v.zoom || 1 }; }
    } catch (e) { /* ignore */ }
    return fallback || { x: 0, y: 0, zoom: 1 };
  }
  function saveViewport(id) {
    const v = board.viewport;
    try { localStorage.setItem(viewportKey(id), JSON.stringify({ x: v.x, y: v.y, zoom: v.zoom })); } catch (e) { /* quota */ }
  }
  let vpTimer = null;
  function scheduleViewportSave() {
    clearTimeout(vpTimer);
    vpTimer = setTimeout(() => { vpTimer = null; saveViewport(currentBoardId); }, 400);
  }
  function flushViewport() {
    if (vpTimer) { clearTimeout(vpTimer); vpTimer = null; }
    saveViewport(currentBoardId);
  }

  function saveBoardContent(id, b) {
    try { localStorage.setItem(boardKey(id), JSON.stringify(contentForStore(b))); } catch (e) { /* quota */ }
  }

  // Build/repair the library: migrate the legacy single-board key, then
  // guarantee at least one board exists. Returns the library.
  function ensureLibrary() {
    let lib = loadLibrary();
    const legacy = localStorage.getItem(STORAGE_KEY);   // pre-library single board
    if (legacy !== null) {
      const id = newBoardId();
      const migrated = normalizeBoard(safeParse(legacy));
      saveBoardContent(id, migrated);
      // viewport is now a separate local key; preserve the legacy board's view
      try { localStorage.setItem(viewportKey(id), JSON.stringify(migrated.viewport)); } catch (e) { /* quota */ }
      lib.unshift({ id, name: 'My board', mode: 'device', updatedAt: Date.now() });
      localStorage.removeItem(STORAGE_KEY);
      localStorage.setItem(CURRENT_KEY, id);   // open the just-migrated board
      saveLibrary(lib);
    }
    if (!lib.length) {
      const id = newBoardId();
      saveBoardContent(id, blankBoard());
      lib = [{ id, name: 'Untitled board', mode: 'device', updatedAt: Date.now() }];
      saveLibrary(lib);
    }
    return lib;
  }
  function safeParse(s) { try { return JSON.parse(s); } catch { return {}; } }

  function pickInitialBoardId(lib) {
    const m = location.hash.match(/[#&]board=([^&]+)/);
    const fromHash = m ? decodeURIComponent(m[1]) : null;
    if (fromHash && lib.some((b) => b.id === fromHash)) return fromHash;
    const cur = localStorage.getItem(CURRENT_KEY);
    if (cur && lib.some((b) => b.id === cur)) return cur;
    return lib[0].id;
  }

  let saveTimer = null;
  function scheduleSave() {
    setSaveState('dirty');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        saveBoardContent(currentBoardId, board);
        touchLibrary(currentBoardId);
        setSaveState('saved');
        // Drive is NOT pushed here — pushes are batched onto the 20s sync tick
        // (syncTick) and flushed on tab-leave, so an active session doesn't hit
        // Drive on every editing pause. Local save above is the durable one.
      } catch (e) {
        console.error('Save failed', e);
        setSaveState('error');
      }
    }, 400);
  }

  // commit() is the single mutation chokepoint. opts.coalesce groups rapid
  // text edits into one undo step.
  function commit(opts) {
    // Viewport-only changes (pan/zoom) are a local, per-device view preference:
    // they don't touch content, aren't undoable, and must NOT bump the version
    // or trigger a Drive push — just persist the viewport to its own local key.
    if (opts && opts.viewportOnly) { scheduleViewportSave(); return; }
    board.version++;
    recordUndo(opts && opts.coalesce);
    scheduleSave();
    updateEmptyState();
    refreshColorFilter();   // legend/dimming track content changes
    refreshDriveStatus();   // show "changes pending…" until the next sync tick pushes
  }

  // Show a centered prompt while the board has nothing on it, so a blank canvas
  // tells the user where to start instead of looking broken.
  let emptyHintEl = null;
  function updateEmptyState() {
    if (!emptyHintEl) emptyHintEl = document.getElementById('empty-hint');
    if (!emptyHintEl) return;
    const empty = !Object.keys(board.cards).length && !Object.keys(board.iframes).length;
    emptyHintEl.classList.toggle('hidden', !empty);
  }

  // ════════════════════════════════════════════════════════
  //  UNDO / REDO — content snapshots (cards/iframes/connections).
  //  Viewport changes aren't tracked; text edits coalesce.
  // ════════════════════════════════════════════════════════
  const MAX_HISTORY = 80;
  const undoStack = [];
  const redoStack = [];
  let lastContent = null;     // last recorded content snapshot (string)
  let coalesceBase = null;    // pre-burst snapshot while a text edit is in flight
  let coalesceTimer = null;
  const undoBtn = document.getElementById('undoBtn');
  const redoBtn = document.getElementById('redoBtn');

  function updateHistoryButtons() {
    if (undoBtn) undoBtn.disabled = undoStack.length === 0 && !coalesceTimer;
    if (redoBtn) redoBtn.disabled = redoStack.length === 0;
  }
  function contentSnapshot() {
    return JSON.stringify({ cards: board.cards, iframes: board.iframes, connections: board.connections });
  }
  function pushUndo(snap) {
    undoStack.push(snap);
    if (undoStack.length > MAX_HISTORY) undoStack.shift();
    redoStack.length = 0;
  }
  function flushCoalesce() {
    if (!coalesceTimer) return;
    clearTimeout(coalesceTimer); coalesceTimer = null;
    pushUndo(coalesceBase);
    coalesceBase = null;
  }
  function recordUndo(coalesce) {
    const snap = contentSnapshot();
    if (lastContent === null) { lastContent = snap; return; }  // first commit: seed baseline
    if (snap === lastContent) return;                          // no content change (e.g. pan/zoom)
    if (coalesce) {
      if (!coalesceTimer) coalesceBase = lastContent;          // remember pre-burst state
      clearTimeout(coalesceTimer);
      coalesceTimer = setTimeout(flushCoalesce, 600);
    } else {
      flushCoalesce();                                          // finalize any pending text burst
      pushUndo(lastContent);
    }
    lastContent = snap;
    updateHistoryButtons();
  }
  function applyContentSnapshot(snapStr) {
    const data = JSON.parse(snapStr);
    board.cards = data.cards || {};
    board.iframes = data.iframes || {};
    board.connections = data.connections || {};
    reconcileToBoard();
    lastContent = snapStr;
    board.version++;
    scheduleSave();
    updateHistoryButtons();
  }
  function undo() {
    flushCoalesce();
    if (!undoStack.length) { updateHistoryButtons(); return; }
    redoStack.push(contentSnapshot());
    applyContentSnapshot(undoStack.pop());
  }
  function redo() {
    if (!redoStack.length) return;
    undoStack.push(contentSnapshot());
    if (undoStack.length > MAX_HISTORY) undoStack.shift();
    applyContentSnapshot(redoStack.pop());
  }
  if (undoBtn) undoBtn.addEventListener('click', undo);
  if (redoBtn) redoBtn.addEventListener('click', redo);

  // ════════════════════════════════════════════════════════
  //  VIEW LAYER
  // ════════════════════════════════════════════════════════
  const viewport = document.getElementById('viewport');
  const world = document.getElementById('world');
  const coordsEl = document.getElementById('coords');
  const saveStateEl = document.getElementById('saveState');
  const zoomValEl = document.getElementById('zoomReset');

  // Dotted grid layer. It's a viewport-sized element moved by transform (GPU)
  // rather than a background-position on #viewport — panning a full-screen
  // background-position repaints the whole screen every frame, which is the
  // dominant per-frame cost during a pan. Since the pattern repeats every tile,
  // we only translate it by the sub-tile remainder; a one-tile overhang keeps
  // it covering the edges. background-size changes only on zoom (not per pan).
  const grid = document.createElement('div');
  grid.id = 'grid';
  viewport.insertBefore(grid, world);
  const GRID_INSET = 160;   // must match #grid's `inset: -160px` in styles.css

  let lastTile = 0;
  function applyViewport() {
    const { x, y, zoom } = board.viewport;
    world.style.transform = `translate(${x}px, ${y}px) scale(${zoom})`;
    // Grid: move by transform (GPU) using the sub-tile remainder; resize only
    // when zoom changes it. Avoids a full-screen background repaint per pan.
    // GRID_INSET compensates for #grid's negative inset so the pattern's screen
    // phase is exactly (x mod tile) — i.e. the same mapping the world transform
    // uses. Without it the phase carries a fixed -160px error that changes with
    // tile size, so the dots drift (and don't anchor to the cursor) on zoom.
    const tile = 28 * zoom;
    if (tile !== lastTile) { grid.style.backgroundSize = tile + 'px ' + tile + 'px'; lastTile = tile; }
    const phase = (v) => ((((v + GRID_INSET) % tile) + tile) % tile) + 'px';
    grid.style.transform = 'translate(' + phase(x) + ', ' + phase(y) + ')';
    coordsEl.textContent = `x: ${Math.round(-x)}  y: ${Math.round(-y)}`;
    if (zoomValEl) zoomValEl.textContent = Math.round(zoom * 100) + '%';
    repositionTextToolbar();   // keep the edit toolbar anchored to its card as the view moves
    scheduleFrameEval();   // pan/zoom can bring frames into (or out of) loadable range
  }

  function setSaveState(state) {
    saveStateEl.className = 'save ' + state;
    saveStateEl.textContent =
      state === 'dirty' ? 'saving…' :
      state === 'error' ? 'save failed' : 'saved';
  }

  // screen point → world coordinate (inverse of the viewport transform)
  function toWorld(screenX, screenY) {
    const { x, y, zoom } = board.viewport;
    return { x: (screenX - x) / zoom, y: (screenY - y) / zoom };
  }

  // Zoom to a new level while keeping the screen point (cx, cy) fixed.
  // While a pan is in flight we promote #world to a GPU layer (<body.panning>).
  // Without it, translating #world repaints the whole viewport every frame —
  // fine slowly, but a fast trackpad flick jumps a big distance per frame and
  // the repaints fall behind (stutter). A composited layer just moves, no
  // repaint, at any speed. Zoom demotes it (zoomAround → endPanLayer) so a
  // scaled layer never bitmap-blurs the text.
  const PAN_SETTLE_MS = 260;    // idle gap after which motion counts as stopped
  let panLayerTimer = null;
  function markPanActive() {
    if (world.style.willChange !== 'transform') world.style.willChange = 'transform';
    if (!document.body.classList.contains('panning')) document.body.classList.add('panning');
    clearTimeout(panLayerTimer);
    panLayerTimer = setTimeout(endPanLayer, PAN_SETTLE_MS);
  }
  function endPanLayer() {
    clearTimeout(panLayerTimer);
    world.style.willChange = 'auto';
    document.body.classList.remove('panning');
  }

  function zoomAround(nextZoom, cx, cy) {
    const zoom = board.viewport.zoom;
    const next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, nextZoom));
    if (next === zoom) return;
    endPanLayer();                 // never composite while scaling — keep zoom crisp
    const w = toWorld(cx, cy);
    board.viewport.zoom = next;
    board.viewport.x = cx - w.x * next;
    board.viewport.y = cy - w.y * next;
    applyViewport();
    commit({ viewportOnly: true });
  }

  // ════════════════════════════════════════════════════════
  //  SVG CONNECTION LAYER — lives inside #world, so arrows
  //  pan/zoom with the transform; we only redraw on node move.
  // ════════════════════════════════════════════════════════
  const SVGNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.id = 'connections';
  svg.innerHTML = `
    <defs>
      <marker id="arrow" viewBox="0 0 10 10" refX="8.5" refY="5"
              markerWidth="7" markerHeight="7" orient="auto-start-reverse">
        <path d="M0,0 L10,5 L0,10 z" fill="context-stroke"></path>
      </marker>
    </defs>`;
  world.appendChild(svg);

  // ════════════════════════════════════════════════════════
  //  NODE REGISTRY — cards and iframes share one element map
  // ════════════════════════════════════════════════════════
  const nodeEls = new Map();  // id → element
  const connEls = new Map();  // id → { g, line, hit }

  function getNode(id) {
    if (board.cards[id])   return { type: 'card',   data: board.cards[id] };
    if (board.iframes[id]) return { type: 'iframe', data: board.iframes[id] };
    return null;
  }

  // current geometry in world units (reads live size from the DOM)
  function nodeGeom(id) {
    const el = nodeEls.get(id);
    const n = getNode(id);
    if (!el || !n) return null;
    return { x: n.data.x, y: n.data.y, w: el.offsetWidth, h: el.offsetHeight };
  }

  let idCounter = 0;
  function newId(prefix) {
    let id;
    do {
      id = prefix + (idCounter++).toString(36) + '_' + (performance.now() | 0).toString(36);
    } while (board.cards[id] || board.iframes[id] || board.connections[id]);
    return id;
  }

  // ════════════════════════════════════════════════════════
  //  SELECTION — a set of nodes, or a single connection
  // ════════════════════════════════════════════════════════
  const selectedNodes = new Set();   // node ids
  let selectedConn = null;           // connection id, or null

  function markNode(id, on) { const el = nodeEls.get(id); if (el) el.classList.toggle('selected', on); }
  function markConn(id, on) {
    const entry = connEls.get(id);
    if (!entry) return;
    entry.g.classList.toggle('selected', on);
    entry.labelEl.classList.toggle('selected', on);
  }
  function deselectConn() {
    if (selectedConn) markConn(selectedConn, false);
    selectedConn = null;
  }
  function clearSelection() {
    for (const id of selectedNodes) markNode(id, false);
    selectedNodes.clear();
    deselectConn();
  }
  // select a single node (default), or add it to the current selection
  function selectNode(id, opts) {
    deselectConn();
    if (!(opts && opts.add)) { for (const sid of selectedNodes) if (sid !== id) markNode(sid, false); selectedNodes.clear(); }
    if (id && nodeEls.has(id)) { selectedNodes.add(id); markNode(id, true); }
  }
  function toggleNodeSelection(id) {
    deselectConn();
    if (selectedNodes.has(id)) { selectedNodes.delete(id); markNode(id, false); }
    else if (nodeEls.has(id)) { selectedNodes.add(id); markNode(id, true); }
  }
  // replace the node selection with exactly these ids (used by box-select)
  function setSelection(ids) {
    deselectConn();
    const next = new Set(ids);
    for (const id of selectedNodes) if (!next.has(id)) markNode(id, false);
    for (const id of next) if (!selectedNodes.has(id)) markNode(id, true);
    selectedNodes.clear();
    for (const id of next) if (nodeEls.has(id)) selectedNodes.add(id);
  }
  function selectConn(id) {
    clearSelection();
    if (!connEls.has(id)) return;
    selectedConn = id;
    markConn(id, true);
  }
  // pointerdown on a node: shift toggles; otherwise select just it — but keep
  // an existing multi-selection intact when pressing on an already-selected
  // node, so it can be dragged as a group.
  function nodePointerSelect(id, e) {
    if (e.shiftKey) toggleNodeSelection(id);
    else if (!selectedNodes.has(id)) selectNode(id);
  }

  // ════════════════════════════════════════════════════════
  //  SHARED DRAG — move any node by a handle
  // ════════════════════════════════════════════════════════
  function startNodeDrag(id, el, e) {
    if (e.button !== 0) return;
    e.preventDefault();
    // Return keyboard focus to the page so a follow-up ⌘/Ctrl+Z reaches us.
    // An embedded page (e.g. Google Docs) can hold focus inside its <iframe>,
    // which would otherwise swallow the shortcut; a focused text field would
    // send it to native text undo. The drag's preventDefault keeps that focus,
    // so blur it explicitly.
    const ae = document.activeElement;
    if (ae && ae.blur && (ae.tagName === 'IFRAME' || ae.isContentEditable ||
        ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) ae.blur();
    // selection was set by the node's capture-phase pointerdown; if this node
    // isn't in the selection (edge case), fall back to selecting just it.
    if (!selectedNodes.has(id)) selectNode(id);

    // move every selected node together
    const movers = [...selectedNodes].map((nid) => {
      const d = getNode(nid).data;
      return { nid, d, ox: d.x, oy: d.y, el: nodeEls.get(nid) };
    });
    const start = toWorld(e.clientX, e.clientY);
    let moved = false;
    movers.forEach((m) => m.el.classList.add('dragging'));

    const onMove = (ev) => {
      const now = toWorld(ev.clientX, ev.clientY);
      const dx = Math.round(now.x - start.x), dy = Math.round(now.y - start.y);
      for (const m of movers) {
        m.d.x = m.ox + dx; m.d.y = m.oy + dy;
        m.el.style.left = m.d.x + 'px';
        m.el.style.top = m.d.y + 'px';
        redrawConnectionsFor(m.nid);
      }
      if (dx || dy) moved = true;
      scheduleFrameEval();
    };
    const onUp = () => {
      movers.forEach((m) => m.el.classList.remove('dragging'));
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      if (moved) commit();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }

  // ════════════════════════════════════════════════════════
  //  PORTS — hover a node to reveal handles; drag one to a
  //  target node to create a connection (Miro / FigJam model)
  // ════════════════════════════════════════════════════════
  function addPorts(el, id) {
    for (const side of ['top', 'right', 'bottom', 'left']) {
      const port = document.createElement('div');
      port.className = 'port ' + side;
      port.addEventListener('pointerdown', (e) => startConnectionDrag(id, e));
      el.appendChild(port);
    }
  }

  function startConnectionDrag(fromId, e) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();

    const temp = document.createElementNS(SVGNS, 'path');
    temp.setAttribute('class', 'conn-temp');
    temp.setAttribute('marker-end', 'url(#arrow)');
    svg.appendChild(temp);

    let hoverEl = null;
    const setHover = (el) => {
      if (hoverEl === el) return;
      if (hoverEl) hoverEl.classList.remove('drop-target');
      hoverEl = el;
      if (hoverEl) hoverEl.classList.add('drop-target');
    };

    const onMove = (ev) => {
      const w = toWorld(ev.clientX, ev.clientY);
      const g = nodeGeom(fromId);
      const a = borderPoint(g, w.x, w.y);
      temp.setAttribute('d', `M${a.x},${a.y} L${w.x},${w.y}`);

      const under = document.elementFromPoint(ev.clientX, ev.clientY);
      const target = under && under.closest('.node');
      setHover(target && target.dataset.id !== fromId ? target : null);
    };
    const onUp = (ev) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      temp.remove();
      setHover(null);
      const under = document.elementFromPoint(ev.clientX, ev.clientY);
      const target = under && under.closest('.node');
      if (target && target.dataset.id !== fromId) {
        createConnection(fromId, target.dataset.id);
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }

  // ════════════════════════════════════════════════════════
  //  INLINE RENAME — shared by card titles and iframe titles:
  //  double-click to edit, drag otherwise, commit on blur/Enter.
  // ════════════════════════════════════════════════════════
  function beginRename(labelEl) {
    labelEl.setAttribute('contenteditable', 'plaintext-only');
    labelEl.focus();
    document.execCommand('selectAll', false);
  }
  function makeRenamable(labelEl, { onInput, onCommit, onEnter } = {}) {
    labelEl.addEventListener('dblclick', (e) => { e.stopPropagation(); beginRename(labelEl); });
    labelEl.addEventListener('input', () => { if (onInput) onInput(labelEl.textContent); });
    labelEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); labelEl.blur(); if (onEnter) onEnter(); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); labelEl.blur(); }
    });
    labelEl.addEventListener('blur', () => {
      labelEl.removeAttribute('contenteditable');
      if (onCommit) onCommit(labelEl.textContent.trim());
    });
  }

  // ════════════════════════════════════════════════════════
  //  CARD NODE
  // ════════════════════════════════════════════════════════
  // ── Node color coding ──────────────────────────────────────────────────
  // A per-node accent used to tint the heading and border (see .colored CSS).
  // Stored as a palette key on the node's data (data.color); absent = default.
  // It's just another data field, so it persists and 3-way-merges for free.
  const NODE_COLORS = [
    { key: 'red',    label: 'Red',    hex: '#F87171' },
    { key: 'amber',  label: 'Amber',  hex: '#F8CF5F' },
    { key: 'green',  label: 'Green',  hex: '#5AD19A' },
    { key: 'blue',   label: 'Blue',   hex: '#6BA6FF' },
    { key: 'purple', label: 'Purple', hex: '#B08CFF' },
    { key: 'pink',   label: 'Pink',   hex: '#F17FB8' },
    { key: 'gray',   label: 'Gray',   hex: '#9AA3B7' },
  ];
  function applyNodeColor(el, color) {
    const c = color && NODE_COLORS.find((x) => x.key === color);
    if (c) {
      el.style.setProperty('--node-color', c.hex);
      el.style.setProperty('--node-color-hi', saturate(c.hex));   // selection highlight
      el.classList.add('colored');
    } else {
      el.style.removeProperty('--node-color');
      el.style.removeProperty('--node-color-hi');
      el.classList.remove('colored');
    }
  }
  // Set (or clear, color=null) the color of the given nodes in one undo step.
  function setNodesColor(ids, color) {
    let changed = false;
    for (const id of ids) {
      const node = getNode(id);
      if (!node) continue;
      if (color) node.data.color = color; else delete node.data.color;
      const el = nodeEls.get(id);
      if (el) applyNodeColor(el, color);
      redrawConnectionsFor(id);          // connections fade to the new color
      changed = true;
    }
    if (changed) commit();
  }

  // ════════════════════════════════════════════════════════
  //  COLOR FILTER — a legend of the colors in use; clicking a dot spotlights
  //  those items and dims the rest. Pure view state: per-device, in-memory,
  //  never synced, never in undo history.
  // ════════════════════════════════════════════════════════
  const colorFilterEl = document.getElementById('color-filter');
  const colorFilter = new Set();          // active palette keys; empty = show all

  function colorsInUse() {
    const used = new Set();
    for (const n of Object.values(board.cards)) if (n.color) used.add(n.color);
    for (const n of Object.values(board.iframes)) if (n.color) used.add(n.color);
    return used;
  }

  // Dim what doesn't match. A connection stays lit if EITHER endpoint matches,
  // so a spotlighted item still shows what it's linked to.
  function applyColorFilter() {
    const active = colorFilter.size > 0;
    const keep = (id) => {
      const n = getNode(id);
      return !active || (n && colorFilter.has(n.data.color));
    };
    for (const [id, el] of nodeEls) el.classList.toggle('filtered-out', !keep(id));
    for (const [cid, c] of Object.entries(board.connections)) {
      const entry = connEls.get(cid);
      if (!entry) continue;
      const dim = active && !keep(c.from) && !keep(c.to);
      entry.g.classList.toggle('filtered-out', dim);
      entry.labelEl.classList.toggle('filtered-out', dim);
    }
  }

  // Rebuild the legend from the colors actually on the board; hide it (and any
  // stale filter entries) when a color disappears.
  function refreshColorFilter() {
    const used = colorsInUse();
    for (const key of [...colorFilter]) if (!used.has(key)) colorFilter.delete(key);
    colorFilterEl.innerHTML = '';
    if (!used.size) {
      colorFilterEl.classList.add('hidden');
      applyColorFilter();
      return;
    }
    for (const c of NODE_COLORS) {
      if (!used.has(c.key)) continue;
      const dot = document.createElement('button');
      dot.type = 'button';
      dot.className = 'cf-dot' + (colorFilter.has(c.key) ? ' active' : '');
      dot.title = colorFilter.has(c.key) ? `Stop filtering ${c.label}` : `Show only ${c.label}`;
      dot.style.setProperty('--sw', c.hex);
      dot.addEventListener('click', () => {
        if (colorFilter.has(c.key)) colorFilter.delete(c.key); else colorFilter.add(c.key);
        refreshColorFilter();
      });
      colorFilterEl.appendChild(dot);
    }
    if (colorFilter.size) {
      const clear = document.createElement('button');
      clear.type = 'button';
      clear.className = 'cf-clear';
      clear.title = 'Clear color filter';
      clear.textContent = '×';
      clear.addEventListener('click', () => { colorFilter.clear(); refreshColorFilter(); });
      colorFilterEl.appendChild(clear);
    }
    colorFilterEl.classList.remove('hidden');
    applyColorFilter();
  }

  function renderCard(id) {
    const data = board.cards[id];
    if (!data) return;

    let el = nodeEls.get(id);
    if (!el) {
      el = document.createElement('div');
      el.className = 'node card';
      el.dataset.id = id;
      el.innerHTML = `
        <div class="card-header">
          <div class="card-title" title="Double-click to rename" spellcheck="false"></div>
          <button class="copy-link icon-btn" title="Copy link to this card"><span class="icon icon-tag"></span></button>
          <button class="card-delete icon-btn" title="Delete card"><span class="icon icon-delete"></span></button>
        </div>
        <div class="card-body" contenteditable="true" spellcheck="false"></div>`;
      world.appendChild(el);
      nodeEls.set(id, el);
      wireCard(id, el);
      addPorts(el, id);
    }
    el.style.left = data.x + 'px';
    el.style.top = data.y + 'px';
    applyNodeColor(el, data.color);

    const titleEl = el.querySelector('.card-title');
    const bodyEl = el.querySelector('.card-body');
    if (document.activeElement !== titleEl) titleEl.textContent = data.title || '';
    if (document.activeElement !== bodyEl) bodyEl.innerHTML = sanitizeHtml(data.body || '');
    return el;
  }

  function wireCard(id, el) {
    const header = el.querySelector('.card-header');
    const titleEl = el.querySelector('.card-title');
    const bodyEl = el.querySelector('.card-body');
    const delBtn = el.querySelector('.card-delete');

    el.addEventListener('pointerdown', (e) => nodePointerSelect(id, e), true);

    header.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      if (titleEl.isContentEditable) return;   // editing the title, don't drag
      startNodeDrag(id, el, e);
    });

    // Title: double-click to rename (shared with iframe titles); Enter → body.
    makeRenamable(titleEl, {
      onInput: (v) => { board.cards[id].title = v; commit({ coalesce: true }); },
      onCommit: (v) => { board.cards[id].title = v; commit(); },
      onEnter: () => bodyEl.focus(),
    });
    bodyEl.addEventListener('input', () => saveCardBody(id, bodyEl));

    // rich-text editing: floating toolbar on focus.
    bodyEl.addEventListener('focus', () => { activeBody = { id, el: bodyEl }; showTextToolbar(el); });
    bodyEl.addEventListener('blur', () => { setTimeout(hideTextToolbarIfIdle, 150); });
    // Follow a link on plain click when NOT editing this card; while editing,
    // require ⌘/Ctrl (plain click places the caret). Handled on pointerdown so
    // we can suppress focus/edit before it happens.
    bodyEl.addEventListener('pointerdown', (e) => {
      const a = e.target.closest('a.node-link, a[href]');
      if (!a) return;
      const editing = document.activeElement === bodyEl;
      if (!editing || e.metaKey || e.ctrlKey) {
        e.preventDefault();
        followLink(a);
      }
    });

    const copyBtn = el.querySelector('.copy-link');
    copyBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
    copyBtn.addEventListener('click', (e) => { e.stopPropagation(); copyNodeLink(id, copyBtn); });

    delBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
    delBtn.addEventListener('click', (e) => { e.stopPropagation(); deleteNode(id); });
  }

  function createCard(worldX, worldY) {
    const id = newId('c_');
    board.cards[id] = { x: Math.round(worldX), y: Math.round(worldY), title: '', body: '' };
    commit();
    const el = renderCard(id);
    selectNode(id);
    beginRename(el.querySelector('.card-title'));   // element is already in the DOM
    return id;
  }

  // ════════════════════════════════════════════════════════
  //  IFRAME NODE
  // ════════════════════════════════════════════════════════
  let interactiveId = null; // which iframe is in interact mode (runtime only)

  function setInteractive(id, on) {
    if (interactiveId && interactiveId !== id && nodeEls.has(interactiveId)) {
      nodeEls.get(interactiveId).classList.remove('interactive');
    }
    interactiveId = on ? id : null;
    const el = nodeEls.get(id);
    if (el) el.classList.toggle('interactive', on);
  }

  // Drop out of interact mode — called on any canvas gesture (pan, wheel,
  // zoom control) so the user is never trapped with frames swallowing input.
  function exitInteract() {
    if (interactiveId) setInteractive(interactiveId, false);
  }

  function renderIframe(id) {
    const data = board.iframes[id];
    if (!data) return;

    let el = nodeEls.get(id);
    if (!el) {
      el = document.createElement('div');
      el.className = 'node iframe-node';
      el.dataset.id = id;
      el.innerHTML = `
        <div class="iframe-header">
          <span class="iframe-label" title="Double-click to rename" spellcheck="false"></span>
          <button class="iframe-edit icon-btn" title="Edit URL"><span class="icon icon-edit"></span></button>
          <button class="copy-link icon-btn" title="Copy link to this frame"><span class="icon icon-tag"></span></button>
          <span class="iframe-czoom">
            <button class="czoom-btn czoom-out" title="Zoom content out"><span class="icon icon-remove"></span></button>
            <button class="czoom-val" title="Reset content zoom to 100%">100%</button>
            <button class="czoom-btn czoom-in" title="Zoom content in"><span class="icon icon-add"></span></button>
          </span>
          <button class="iframe-zoom icon-btn" title="Zoom canvas to this frame"><span class="icon icon-center_focus_strong"></span></button>
          <button class="iframe-toggle" title="Toggle interact mode">interact</button>
          <button class="card-delete icon-btn" title="Delete frame"><span class="icon icon-delete"></span></button>
        </div>
        <div class="iframe-wrap">
          <div class="frame-placeholder" title="Click to load">
            <span class="ph-host"></span>
            <span class="ph-note">click to load</span>
          </div>
          <iframe class="iframe-frame"
                  sandbox="allow-scripts allow-same-origin allow-forms"
                  referrerpolicy="no-referrer"></iframe>
        </div>
        <div class="resize-handle" title="Resize"></div>`;
      world.appendChild(el);
      nodeEls.set(id, el);
      wireIframe(id, el);
      addPorts(el, id);
    }
    el.style.left = data.x + 'px';
    el.style.top = data.y + 'px';
    el.style.width = data.w + 'px';
    el.style.height = data.h + 'px';
    applyNodeColor(el, data.color);

    // src is set lazily by evaluateFrameLoading(), not here
    const labelEl = el.querySelector('.iframe-label');
    if (document.activeElement !== labelEl) labelEl.textContent = data.title || labelFor(data.src);
    el.querySelector('.ph-host').textContent = labelFor(data.src);
    el.querySelector('.czoom-val').textContent = frameZoomPct(data) + '%';
    // if an already-loaded frame's src changed (e.g. undo of a URL edit), reload
    // it — but a move/resize leaves src untouched so the page is preserved
    const frame = el.querySelector('.iframe-frame');
    if (el.classList.contains('loaded') && frame.getAttribute('src') !== data.src) {
      frame.setAttribute('src', data.src);
    }
    layoutFrame(el);
    return el;
  }

  // Default iframe titles: "Webpage 1", "Webpage 2", …
  function nextWebpageNumber() {
    let max = 0;
    for (const f of Object.values(board.iframes)) {
      const m = /^Webpage (\d+)$/.exec(f.title || '');
      if (m) max = Math.max(max, +m[1]);
    }
    return max + 1;
  }

  // ── Lazy iframe loading ──
  function loadFrame(id) {
    const el = nodeEls.get(id);
    const data = board.iframes[id];
    if (!el || !data) return;
    const frame = el.querySelector('.iframe-frame');
    if (frame.getAttribute('src') !== data.src) frame.setAttribute('src', data.src);
    el.classList.add('loaded');
  }

  function frameShouldLoad(data) {
    const z = board.viewport.zoom;
    const w = data.w * z, h = data.h * z;
    if (w < FRAME_MIN_LOAD_PX) return false;          // too small on screen
    const left = data.x * z + board.viewport.x;
    const top = data.y * z + board.viewport.y;
    const mx = innerWidth * FRAME_LOAD_MARGIN, my = innerHeight * FRAME_LOAD_MARGIN;
    return left < innerWidth + mx && left + w > -mx &&  // intersects expanded viewport
           top < innerHeight + my && top + h > -my;
  }

  function evaluateFrameLoading() {
    for (const id of Object.keys(board.iframes)) {
      const el = nodeEls.get(id);
      if (!el || el.classList.contains('loaded')) continue;
      if (frameShouldLoad(board.iframes[id])) loadFrame(id);
    }
  }

  let frameEvalQueued = false;
  function scheduleFrameEval() {
    if (frameEvalQueued) return;
    frameEvalQueued = true;
    requestAnimationFrame(() => { frameEvalQueued = false; evaluateFrameLoading(); });
  }

  // Per-iframe content-zoom bounds, expressed as logical render widths.
  const FRAME_LW_MIN = 360;    // narrowest layout → most zoomed-in (~400%)
  const FRAME_LW_MAX = 5760;   // widest layout → most zoomed-out (~25%)

  function frameLogicalWidth(data) {
    return (data && data.logicalWidth) || IFRAME_LOGICAL_WIDTH;
  }
  function frameZoomPct(data) {
    return Math.round((IFRAME_LOGICAL_WIDTH / frameLogicalWidth(data)) * 100);
  }

  // Size the inner iframe to its logical width and scale it to fit the box.
  function layoutFrame(el) {
    const data = board.iframes[el.dataset.id];
    const lw = frameLogicalWidth(data);
    const wrap = el.querySelector('.iframe-wrap');
    const frame = el.querySelector('.iframe-frame');
    const s = wrap.clientWidth / lw;
    frame.style.width = lw + 'px';
    frame.style.height = (s > 0 ? wrap.clientHeight / s : wrap.clientHeight) + 'px';
    frame.style.transform = `scale(${s})`;
  }

  function setFrameZoom(id, lw) {
    const data = board.iframes[id];
    if (!data) return;
    data.logicalWidth = Math.max(FRAME_LW_MIN, Math.min(FRAME_LW_MAX, Math.round(lw)));
    const el = nodeEls.get(id);
    layoutFrame(el);
    el.querySelector('.czoom-val').textContent = frameZoomPct(data) + '%';
    commit();
  }
  // dir > 0 zooms the content in (bigger), dir < 0 out; ×1.25 per step.
  const nudgeFrameZoom = (id, dir) =>
    setFrameZoom(id, frameLogicalWidth(board.iframes[id]) * (dir > 0 ? 1 / 1.25 : 1.25));

  function labelFor(src) {
    try { return new URL(src).hostname.replace(/^www\./, ''); }
    catch { return src || 'frame'; }
  }

  function wireIframe(id, el) {
    const header = el.querySelector('.iframe-header');
    const toggle = el.querySelector('.iframe-toggle');
    const zoomBtn = el.querySelector('.iframe-zoom');
    const delBtn = el.querySelector('.card-delete');
    const handle = el.querySelector('.resize-handle');

    el.addEventListener('pointerdown', (e) => nodePointerSelect(id, e), true);

    header.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      const lbl = e.target.closest('.iframe-label');
      if (lbl && lbl.isContentEditable) return;   // editing the title, don't drag
      startNodeDrag(id, el, e);
    });

    // Enter interact mode by double-clicking the frame; exit via the button / Esc.
    el.addEventListener('dblclick', (e) => {
      if (e.target.closest('.iframe-header') || e.target.closest('.resize-handle')) return;
      setInteractive(id, !el.classList.contains('interactive'));
    });

    // Title: double-click to rename (shared with card titles).
    const labelEl = el.querySelector('.iframe-label');
    makeRenamable(labelEl, {
      onInput: (v) => { board.iframes[id].title = v; commit({ coalesce: true }); },
      onCommit: (v) => {
        board.iframes[id].title = v;
        labelEl.textContent = v || labelFor(board.iframes[id].src);
        commit();
      },
    });
    toggle.addEventListener('pointerdown', (e) => e.stopPropagation());
    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      setInteractive(id, !el.classList.contains('interactive'));
    });

    zoomBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
    zoomBtn.addEventListener('click', (e) => { e.stopPropagation(); frameNode(id); });

    const editBtn = el.querySelector('.iframe-edit');
    editBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
    editBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openFrameModal({ type: 'edit', id, src: board.iframes[id].src });
    });

    const copyBtn = el.querySelector('.copy-link');
    copyBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
    copyBtn.addEventListener('click', (e) => { e.stopPropagation(); copyNodeLink(id, copyBtn); });

    // content-zoom stepper
    const czoom = el.querySelector('.iframe-czoom');
    czoom.addEventListener('pointerdown', (e) => e.stopPropagation());
    el.querySelector('.czoom-in').addEventListener('click', (e) => { e.stopPropagation(); nudgeFrameZoom(id, 1); });
    el.querySelector('.czoom-out').addEventListener('click', (e) => { e.stopPropagation(); nudgeFrameZoom(id, -1); });
    el.querySelector('.czoom-val').addEventListener('click', (e) => { e.stopPropagation(); setFrameZoom(id, IFRAME_LOGICAL_WIDTH); });

    delBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
    delBtn.addEventListener('click', (e) => { e.stopPropagation(); deleteNode(id); });

    // click the placeholder to force-load even when small/off-screen
    el.querySelector('.frame-placeholder').addEventListener('click', (e) => {
      e.stopPropagation();
      loadFrame(id);
    });

    makeResizable(id, el, handle);
  }

  function makeResizable(id, el, handle) {
    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      selectNode(id);
      const data = board.iframes[id];
      const start = toWorld(e.clientX, e.clientY);
      const ow = data.w, oh = data.h;
      let moved = false;

      const onMove = (ev) => {
        const now = toWorld(ev.clientX, ev.clientY);
        data.w = Math.max(220, Math.round(ow + (now.x - start.x)));
        data.h = Math.max(160, Math.round(oh + (now.y - start.y)));
        el.style.width = data.w + 'px';
        el.style.height = data.h + 'px';
        layoutFrame(el);
        redrawConnectionsFor(id);
        scheduleFrameEval();
        moved = true;
      };
      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
        if (moved) commit();
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    });
  }

  function normalizeUrl(input) {
    const s = (input || '').trim();
    if (!s) return null;
    return /^https?:\/\//i.test(s) ? s : 'https://' + s;
  }

  function createIframe(worldX, worldY, src) {
    const id = newId('f_');
    board.iframes[id] = {
      x: Math.round(worldX), y: Math.round(worldY),
      w: 480, h: 320, src, logicalWidth: IFRAME_LOGICAL_WIDTH,
      title: 'Webpage ' + nextWebpageNumber()
    };
    commit();
    const el = renderIframe(id);
    selectNode(id);
    scheduleFrameEval();
    return el;
  }

  // ════════════════════════════════════════════════════════
  //  CONNECTIONS — bezier arrows, dynamically anchored
  // ════════════════════════════════════════════════════════
  // Point on a rect's border along the line from its center toward (tx, ty).
  function borderPoint(g, tx, ty) {
    const cx = g.x + g.w / 2, cy = g.y + g.h / 2;
    const dx = tx - cx, dy = ty - cy;
    if (dx === 0 && dy === 0) return { x: cx, y: cy };
    const sx = dx !== 0 ? (g.w / 2) / Math.abs(dx) : Infinity;
    const sy = dy !== 0 ? (g.h / 2) / Math.abs(dy) : Infinity;
    const s = Math.min(sx, sy);
    return { x: cx + dx * s, y: cy + dy * s };
  }

  function pathBetween(fromId, toId) {
    const g1 = nodeGeom(fromId), g2 = nodeGeom(toId);
    if (!g1 || !g2) return null;
    const c1 = { x: g1.x + g1.w / 2, y: g1.y + g1.h / 2 };
    const c2 = { x: g2.x + g2.w / 2, y: g2.y + g2.h / 2 };
    const a = borderPoint(g1, c2.x, c2.y);
    const b = borderPoint(g2, c1.x, c1.y);

    // push control points out along each node's outward normal for a clean curve
    const dist = Math.hypot(b.x - a.x, b.y - a.y);
    const k = Math.max(30, Math.min(160, dist * 0.4));
    const n1 = unit(a.x - c1.x, a.y - c1.y);
    const n2 = unit(b.x - c2.x, b.y - c2.y);
    const cp1 = { x: a.x + n1.x * k, y: a.y + n1.y * k };
    const cp2 = { x: b.x + n2.x * k, y: b.y + n2.y * k };
    return { d: `M${a.x},${a.y} C${cp1.x},${cp1.y} ${cp2.x},${cp2.y} ${b.x},${b.y}`, a, b, cp1, cp2 };
  }

  // The stroke color for an endpoint: its node's color, else the default line
  // color. Connections fade between their two endpoints' colors (see below).
  const DEFAULT_CONN_HEX =
    getComputedStyle(document.documentElement).getPropertyValue('--text-3').trim() || '#ABB3C5';
  function nodeColorHex(id) {
    const n = getNode(id);
    const c = n && n.data.color && NODE_COLORS.find((x) => x.key === n.data.color);
    return c ? c.hex : DEFAULT_CONN_HEX;
  }

  function hexToHsl(hex) {
    const r = parseInt(hex.slice(1, 3), 16) / 255,
          g = parseInt(hex.slice(3, 5), 16) / 255,
          b = parseInt(hex.slice(5, 7), 16) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    let h = 0; const l = (max + min) / 2;
    const s = d === 0 ? 0 : (l > 0.5 ? d / (2 - max - min) : d / (max + min));
    if (d) {
      if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
    }
    return { h, s, l };
  }
  function hslToHex(h, s, l) {
    h /= 360;
    const f = (n) => {
      const k = (n + h * 12) % 12;
      const a = s * Math.min(l, 1 - l);
      const c = l - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)));
      return Math.round(c * 255).toString(16).padStart(2, '0');
    };
    return '#' + f(0) + f(8) + f(4);
  }
  // A punchier version of a color, for selection highlights.
  function saturate(hex) {
    const { h, s, l } = hexToHsl(hex);
    return hslToHex(h, Math.min(1, s * 1.5 + 0.12), Math.max(0, Math.min(1, l * 0.9)));
  }

  // Stops that rotate through the color wheel from one hex to another, so the
  // fade stays saturated (a straight RGB blend grays out through the middle).
  // Endpoints are exact; the middle sweeps hue along the shorter arc. If one end
  // is (near-)gray its hue is undefined, so we borrow the other's hue and just
  // fade saturation — no phantom rainbow toward red.
  const CONN_STOPS = 7;
  function spectrumStops(fromHex, toHex, n) {
    const A = hexToHsl(fromHex), B = hexToHsl(toHex);
    if (A.s < 0.06 && B.s >= 0.06) A.h = B.h;
    if (B.s < 0.06 && A.s >= 0.06) B.h = A.h;
    let dh = B.h - A.h;
    if (dh > 180) dh -= 360; else if (dh < -180) dh += 360;
    const out = [];
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      const h = (((A.h + dh * t) % 360) + 360) % 360;
      const s = A.s + (B.s - A.s) * t;
      const l = A.l + (B.l - A.l) * t;
      out.push(`hsl(${h.toFixed(1)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%)`);
    }
    out[0] = fromHex; out[n - 1] = toHex;   // keep endpoints exactly on the node colors
    return out;
  }

  function unit(x, y) {
    const m = Math.hypot(x, y) || 1;
    return { x: x / m, y: y / m };
  }

  function renderConnection(id) {
    const data = board.connections[id];
    if (!data) return;
    // drop dangling connections whose endpoints no longer exist
    if (!getNode(data.from) || !getNode(data.to)) { delete board.connections[id]; return; }

    let entry = connEls.get(id);
    if (!entry) {
      const g = document.createElementNS(SVGNS, 'g');
      g.setAttribute('class', 'conn');
      g.dataset.id = id;

      // Per-connection gradient + arrowhead, kept inside this <g> so g.remove()
      // cleans them up. The line fades from the source color to the target
      // color; the arrowhead takes the target color. Both are referenced by id.
      const grad = document.createElementNS(SVGNS, 'linearGradient');
      grad.setAttribute('id', 'cg-' + id);
      grad.setAttribute('gradientUnits', 'userSpaceOnUse');   // stops track world coords
      const stops = [];
      for (let i = 0; i < CONN_STOPS; i++) {
        const s = document.createElementNS(SVGNS, 'stop');
        s.setAttribute('offset', (i / (CONN_STOPS - 1)).toFixed(4));
        grad.appendChild(s);
        stops.push(s);
      }

      const marker = document.createElementNS(SVGNS, 'marker');
      marker.setAttribute('id', 'ca-' + id);
      marker.setAttribute('viewBox', '0 0 10 10');
      marker.setAttribute('refX', '8.5'); marker.setAttribute('refY', '5');
      marker.setAttribute('markerWidth', '7'); marker.setAttribute('markerHeight', '7');
      marker.setAttribute('orient', 'auto-start-reverse');
      const mpath = document.createElementNS(SVGNS, 'path');
      mpath.setAttribute('d', 'M0,0 L10,5 L0,10 z');
      marker.appendChild(mpath);

      const hit = document.createElementNS(SVGNS, 'path');
      hit.setAttribute('class', 'hit');
      const line = document.createElementNS(SVGNS, 'path');
      line.setAttribute('class', 'line');
      line.setAttribute('marker-end', 'url(#ca-' + id + ')');
      // Fed to CSS `stroke: var(--conn-stroke, …)`, so hover/selected rules
      // (which set `stroke` directly) still override the gradient.
      line.style.setProperty('--conn-stroke', 'url(#cg-' + id + ')');

      g.appendChild(grad); g.appendChild(marker); g.appendChild(hit); g.appendChild(line);
      svg.appendChild(g);
      g.addEventListener('pointerdown', (e) => { e.stopPropagation(); selectConn(id); });

      // Label: an HTML pill in #world (not the SVG) so it pans/zooms with the
      // board and takes contenteditable. Hidden until the connection has text.
      const labelEl = document.createElement('div');
      labelEl.className = 'conn-label hidden';
      labelEl.dataset.connId = id;
      world.appendChild(labelEl);
      labelEl.addEventListener('pointerdown', (e) => { e.stopPropagation(); selectConn(id); });
      makeRenamable(labelEl, {
        onCommit: (v) => {
          const c = board.connections[id];
          if (!c) return;
          const prev = c.label || '';
          if (v) c.label = v; else delete c.label;
          drawConnection(id);
          if (v !== prev) commit();
        },
      });
      // Double-click anywhere on the line to add (or edit) its label.
      g.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        selectConn(id);
        beginConnLabelEdit(id);
      });

      entry = { g, line, hit, grad, stops, mpath, labelEl };
      connEls.set(id, entry);
    }
    drawConnection(id);
  }

  function beginConnLabelEdit(id) {
    const entry = connEls.get(id);
    if (!entry) return;
    entry.labelEl.classList.remove('hidden');
    beginRename(entry.labelEl);
  }

  function drawConnection(id) {
    const entry = connEls.get(id);
    const data = board.connections[id];
    if (!entry || !data) return;
    const p = pathBetween(data.from, data.to);
    if (!p) return;
    entry.line.setAttribute('d', p.d);
    entry.hit.setAttribute('d', p.d);
    // Gradient runs along the curve's endpoints and rotates through the color
    // wheel so the fade stays vivid; stops = each node's color at the ends.
    const from = nodeColorHex(data.from), to = nodeColorHex(data.to);
    entry.grad.setAttribute('x1', p.a.x); entry.grad.setAttribute('y1', p.a.y);
    entry.grad.setAttribute('x2', p.b.x); entry.grad.setAttribute('y2', p.b.y);
    const colors = spectrumStops(from, to, CONN_STOPS);
    entry.stops.forEach((s, i) => s.setAttribute('stop-color', colors[i]));
    entry.mpath.setAttribute('fill', to);

    // Label pill sits at the curve's midpoint (cubic bezier at t=0.5) and is
    // tinted with the gradient's middle color so it reads as part of the line.
    const lbl = entry.labelEl;
    const editing = document.activeElement === lbl;
    if (!editing) lbl.textContent = data.label || '';
    lbl.classList.toggle('hidden', !data.label && !editing);
    if (data.label || editing) {
      const mx = (p.a.x + 3 * p.cp1.x + 3 * p.cp2.x + p.b.x) / 8;
      const my = (p.a.y + 3 * p.cp1.y + 3 * p.cp2.y + p.b.y) / 8;
      lbl.style.left = mx + 'px';
      lbl.style.top = my + 'px';
      lbl.style.setProperty('--conn-label-color', colors[(CONN_STOPS - 1) / 2]);
    }
  }

  function redrawConnectionsFor(nodeId) {
    for (const [cid, c] of Object.entries(board.connections)) {
      if (c.from === nodeId || c.to === nodeId) drawConnection(cid);
    }
  }

  function createConnection(from, to) {
    // skip exact duplicates (same direction)
    for (const c of Object.values(board.connections)) {
      if (c.from === from && c.to === to) return;
    }
    const id = newId('cn_');
    board.connections[id] = { from, to };
    renderConnection(id);
    commit();
  }

  function deleteConnection(id) {
    delete board.connections[id];
    const entry = connEls.get(id);
    if (entry) { entry.g.remove(); entry.labelEl.remove(); connEls.delete(id); }
    if (selectedConn === id) selectedConn = null;
    commit();
  }

  // ════════════════════════════════════════════════════════
  //  DELETE (any node) — also removes attached connections
  // ════════════════════════════════════════════════════════
  function deleteNode(id) {
    delete board.cards[id];
    delete board.iframes[id];
    const el = nodeEls.get(id);
    if (el) { el.remove(); nodeEls.delete(id); }
    if (interactiveId === id) interactiveId = null;
    for (const [cid, c] of Object.entries(board.connections)) {
      if (c.from === id || c.to === id) {
        delete board.connections[cid];
        const ce = connEls.get(cid);
        if (ce) { ce.g.remove(); connEls.delete(cid); }
      }
    }
    selectedNodes.delete(id);
    commit();
  }

  // Create a node from a plain data object (a deep copy of another node's data);
  // returns the new id. Shared by duplicate and paste.
  function addNodeFromData(type, data) {
    if (type === 'card') { const nid = newId('c_'); board.cards[nid] = data; renderCard(nid); return nid; }
    const nid = newId('f_'); board.iframes[nid] = data; renderIframe(nid); return nid;
  }
  // Re-create connections from {from,to} pairs, remapping endpoints through
  // idMap; only pairs whose BOTH endpoints were cloned carry over.
  function remapConnections(pairs, idMap) {
    for (const c of pairs) {
      if (idMap[c.from] && idMap[c.to]) {
        const cid = newId('cn_');
        board.connections[cid] = { from: idMap[c.from], to: idMap[c.to] };
        if (c.label) board.connections[cid].label = c.label;
        renderConnection(cid);
      }
    }
  }

  // Duplicate the current selection (nodes + connections between them),
  // offset slightly, and select the copies. One undo step.
  function duplicateSelection() {
    const ids = [...selectedNodes];
    if (!ids.length) return;
    const OFF = 24;
    const idMap = {};
    for (const oldId of ids) {
      const n = getNode(oldId);
      if (!n) continue;
      const data = JSON.parse(JSON.stringify(n.data));
      data.x += OFF; data.y += OFF;
      idMap[oldId] = addNodeFromData(n.type, data);
    }
    remapConnections(Object.values(board.connections), idMap);
    setSelection(Object.values(idMap));
    scheduleFrameEval();
    commit();
  }

  function selectAllNodes() { setSelection([...nodeEls.keys()]); }

  // Internal clipboard (in-session, works across boards). Copy snapshots the
  // selection + its internal connections; paste clones them with a cascading
  // offset so repeated pastes don't stack exactly.
  let clipboard = null;
  let pasteCount = 0;

  function copySelection() {
    const ids = [...selectedNodes];
    if (!ids.length) return;
    const nodes = [];
    for (const id of ids) {
      const n = getNode(id);
      if (n) nodes.push({ oldId: id, type: n.type, data: JSON.parse(JSON.stringify(n.data)) });
    }
    const idset = new Set(ids);
    const conns = Object.values(board.connections)
      .filter((c) => idset.has(c.from) && idset.has(c.to))
      .map((c) => ({ from: c.from, to: c.to }));
    clipboard = { nodes, conns };
    pasteCount = 0;
  }

  function pasteClipboard(anchor) {
    if (!clipboard || !clipboard.nodes.length) return;
    // Keyboard paste cascades by a fixed offset; a context-menu "Paste here"
    // drops the group's top-left at the cursor (anchor, in world units).
    let dx, dy;
    if (anchor) {
      let minX = Infinity, minY = Infinity;
      for (const item of clipboard.nodes) { minX = Math.min(minX, item.data.x); minY = Math.min(minY, item.data.y); }
      dx = anchor.x - minX; dy = anchor.y - minY;
    } else {
      dx = dy = 24 * (++pasteCount);
    }
    const idMap = {};
    for (const item of clipboard.nodes) {
      const data = JSON.parse(JSON.stringify(item.data));
      data.x += dx; data.y += dy;
      idMap[item.oldId] = addNodeFromData(item.type, data);
    }
    remapConnections(clipboard.conns, idMap);
    setSelection(Object.values(idMap));
    scheduleFrameEval();
    commit();
  }

  // ════════════════════════════════════════════════════════
  //  RENDER ALL
  // ════════════════════════════════════════════════════════
  function renderAll() {
    for (const id of Object.keys(board.cards)) renderCard(id);
    for (const id of Object.keys(board.iframes)) renderIframe(id);
    // connections after nodes exist so geometry is available
    for (const id of Object.keys(board.connections)) renderConnection(id);
    applyViewport();
    refreshColorFilter();
  }

  // Sync the DOM to the current board WITHOUT tearing everything down:
  // existing nodes are updated in place (so a moved iframe keeps its loaded
  // page — no reload), only added/removed nodes are created/destroyed.
  // Used by undo/redo and import. Viewport is left as-is.
  function reconcileToBoard() {
    for (const id of [...nodeEls.keys()]) {
      if (!board.cards[id] && !board.iframes[id]) {
        nodeEls.get(id).remove(); nodeEls.delete(id);
        if (interactiveId === id) interactiveId = null;
      }
    }
    for (const id of [...connEls.keys()]) {
      if (!board.connections[id]) {
        const entry = connEls.get(id);
        entry.g.remove(); entry.labelEl.remove();
        connEls.delete(id);
      }
    }
    for (const id of Object.keys(board.cards)) renderCard(id);
    for (const id of Object.keys(board.iframes)) renderIframe(id);
    for (const id of Object.keys(board.connections)) renderConnection(id);
    for (const id of [...selectedNodes]) if (!nodeEls.has(id)) selectedNodes.delete(id);
    if (selectedConn && !connEls.has(selectedConn)) selectedConn = null;
    applyViewport();
    updateEmptyState();
    refreshColorFilter();
  }

  // ════════════════════════════════════════════════════════
  //  CANVAS PAN / BOX-SELECT / WHEEL / DOUBLE-CLICK
  // ════════════════════════════════════════════════════════
  // Pan: hold Space + drag (anywhere), middle-mouse drag, or scroll/two-finger.
  // Box-select: left-drag on empty canvas.
  let spaceHeld = false;
  const selectionBox = document.createElement('div');
  selectionBox.id = 'selection-box';
  selectionBox.className = 'hidden';
  document.body.appendChild(selectionBox);

  function startPan(e) {
    exitInteract();
    viewport.classList.add('panning');
    const startX = e.clientX, startY = e.clientY;
    const ox = board.viewport.x, oy = board.viewport.y;
    let moved = false;
    const onMove = (ev) => {
      board.viewport.x = ox + (ev.clientX - startX);
      board.viewport.y = oy + (ev.clientY - startY);
      applyViewport();
      markPanActive();
      moved = true;
    };
    const onUp = () => {
      viewport.classList.remove('panning');
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      if (moved) commit({ viewportOnly: true });
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }

  function rectsOverlap(ax, ay, aw, ah, bx, by, bw, bh) {
    return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
  }
  function startBoxSelect(e) {
    exitInteract();
    if (!e.shiftKey) clearSelection();
    const baseSel = new Set(selectedNodes);
    const sx = e.clientX, sy = e.clientY;
    let moved = false;
    // collapse to a zero-size rect at the start point BEFORE showing, so the
    // previous selection's rectangle never flashes
    selectionBox.style.left = sx + 'px'; selectionBox.style.top = sy + 'px';
    selectionBox.style.width = '0px'; selectionBox.style.height = '0px';
    selectionBox.classList.remove('hidden');
    viewport.classList.add('selecting');
    const onMove = (ev) => {
      const x = Math.min(sx, ev.clientX), y = Math.min(sy, ev.clientY);
      const w = Math.abs(ev.clientX - sx), h = Math.abs(ev.clientY - sy);
      selectionBox.style.left = x + 'px'; selectionBox.style.top = y + 'px';
      selectionBox.style.width = w + 'px'; selectionBox.style.height = h + 'px';
      if (w > 3 || h > 3) moved = true;
      const a = toWorld(x, y), b = toWorld(x + w, y + h);   // box in world coords
      const sel = new Set(baseSel);
      for (const id of nodeEls.keys()) {
        const g = nodeGeom(id);
        if (g && rectsOverlap(g.x, g.y, g.w, g.h, a.x, a.y, b.x - a.x, b.y - a.y)) sel.add(id);
      }
      setSelection([...sel]);
    };
    const onUp = () => {
      selectionBox.classList.add('hidden');
      viewport.classList.remove('selecting');
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      if (!moved && !e.shiftKey) clearSelection();   // a plain click on empty space
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }

  // Space-drag pans anywhere — capture phase so it beats node drag/select.
  viewport.addEventListener('pointerdown', (e) => {
    if (spaceHeld && e.button === 0) { e.preventDefault(); e.stopPropagation(); startPan(e); }
  }, true);

  // Empty-canvas gestures: middle-drag pans, left-drag box-selects.
  viewport.addEventListener('pointerdown', (e) => {
    if (e.target !== viewport && e.target !== world && e.target !== svg) return;
    if (e.button === 1) { e.preventDefault(); startPan(e); return; }
    if (e.button !== 0 || spaceHeld) return;
    startBoxSelect(e);
  });

  // ════════════════════════════════════════════════════════
  //  RIGHT-CLICK CONTEXT MENU
  // ════════════════════════════════════════════════════════
  const contextMenu = document.createElement('div');
  contextMenu.id = 'context-menu';
  contextMenu.className = 'hidden';
  document.body.appendChild(contextMenu);
  let ctxDispose = null;

  function closeContextMenu() {
    if (contextMenu.classList.contains('hidden')) return;
    contextMenu.classList.add('hidden');
    contextMenu.innerHTML = '';
    if (ctxDispose) { ctxDispose(); ctxDispose = null; }
  }

  // items: array of 'sep' or { label, hint?, danger?, action }
  function openContextMenu(x, y, items) {
    contextMenu.innerHTML = '';
    for (const it of items) {
      if (it === 'sep') {
        const s = document.createElement('div');
        s.className = 'ctx-sep';
        contextMenu.appendChild(s);
        continue;
      }
      if (it.swatches) {
        const row = document.createElement('div');
        row.className = 'ctx-swatches';
        const none = document.createElement('button');
        none.type = 'button';
        none.className = 'ctx-swatch ctx-swatch-none' + (it.current ? '' : ' active');
        none.title = 'No color';
        none.addEventListener('click', () => { closeContextMenu(); it.onPick(null); });
        row.appendChild(none);
        for (const c of NODE_COLORS) {
          const sw = document.createElement('button');
          sw.type = 'button';
          sw.className = 'ctx-swatch' + (it.current === c.key ? ' active' : '');
          sw.title = c.label;
          sw.style.setProperty('--sw', c.hex);
          sw.addEventListener('click', () => { closeContextMenu(); it.onPick(c.key); });
          row.appendChild(sw);
        }
        contextMenu.appendChild(row);
        continue;
      }
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ctx-item' + (it.danger ? ' danger' : '');
      b.innerHTML = `<span class="ctx-label"></span>` + (it.hint ? `<span class="ctx-hint"></span>` : '');
      b.querySelector('.ctx-label').textContent = it.label;
      if (it.hint) b.querySelector('.ctx-hint').textContent = it.hint;
      b.addEventListener('click', () => { closeContextMenu(); it.action(); });
      contextMenu.appendChild(b);
    }
    contextMenu.classList.remove('hidden');
    // position, clamped so the whole menu stays on-screen
    const r = contextMenu.getBoundingClientRect();
    contextMenu.style.left = Math.max(6, Math.min(x, innerWidth - r.width - 6)) + 'px';
    contextMenu.style.top = Math.max(6, Math.min(y, innerHeight - r.height - 6)) + 'px';

    const onDown = (e) => { if (!contextMenu.contains(e.target)) closeContextMenu(); };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); closeContextMenu(); } };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('wheel', closeContextMenu, { passive: true });
    window.addEventListener('keydown', onKey, true);
    ctxDispose = () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('wheel', closeContextMenu);
      window.removeEventListener('keydown', onKey, true);
    };
  }

  // A right-click can itself focus an always-editable card body, so we can't
  // judge "was the user editing?" from activeElement after the fact — record it
  // at pointerdown, before focus moves.
  let ctxPreActive = null;
  viewport.addEventListener('pointerdown', (e) => { if (e.button === 2) ctxPreActive = document.activeElement; }, true);

  viewport.addEventListener('contextmenu', (e) => {
    // if the user was already editing text (or is inside an interactive frame),
    // leave the native menu alone for paste/spellcheck
    const pa = ctxPreActive;
    if (pa && (pa.tagName === 'IFRAME' ||
        ((pa.isContentEditable || pa.tagName === 'INPUT' || pa.tagName === 'TEXTAREA') && pa.contains(e.target)))) return;
    e.preventDefault();
    const world = toWorld(e.clientX, e.clientY);
    const nodeEl = e.target.closest && e.target.closest('.node');
    const connG = e.target.closest && e.target.closest('.conn');
    const items = [];

    if (nodeEl) {
      const id = nodeEl.dataset.id;
      if (!selectedNodes.has(id)) selectNode(id);     // right-click grabs the node it's on
      const many = selectedNodes.size > 1;
      const isFrame = getNode(id) && getNode(id).type === 'iframe';
      items.push({ label: many ? 'Duplicate selection' : 'Duplicate', hint: '⌘D', action: duplicateSelection });
      items.push({ label: 'Copy', hint: '⌘C', action: copySelection });
      items.push({ label: 'Cut', hint: '⌘X', action: () => { copySelection(); for (const nid of [...selectedNodes]) deleteNode(nid); } });
      if (clipboard) items.push({ label: 'Paste here', hint: '⌘V', action: () => pasteClipboard(world) });
      items.push('sep');
      const gn = getNode(id);
      const curColor = (gn && gn.data.color) || null;   // reflects the right-clicked node
      items.push({ swatches: true, current: curColor, onPick: (key) => setNodesColor([...selectedNodes], key) });
      items.push('sep');
      items.push({ label: many ? 'Delete selection' : (isFrame ? 'Delete frame' : 'Delete card'), hint: 'Del', danger: true, action: () => { for (const nid of [...selectedNodes]) deleteNode(nid); } });
    } else if (connG) {
      const id = connG.dataset.id;
      selectConn(id);
      const hasLabel = !!(board.connections[id] && board.connections[id].label);
      items.push({ label: hasLabel ? 'Edit label' : 'Add label', hint: '2×click', action: () => beginConnLabelEdit(id) });
      items.push('sep');
      items.push({ label: 'Delete connection', hint: 'Del', danger: true, action: () => deleteConnection(id) });
    } else {
      items.push({ label: 'Add card here', action: () => createCard(world.x - 120, world.y - 24) });
      items.push({ label: 'Add frame here', action: () => openFrameModal({ type: 'create', at: world }) });
      if (clipboard) items.push({ label: 'Paste here', hint: '⌘V', action: () => pasteClipboard(world) });
      items.push('sep');
      items.push({ label: 'Select all', hint: '⌘A', action: selectAllNodes });
    }
    openContextMenu(e.clientX, e.clientY, items);
  });

  window.addEventListener('keydown', (e) => {
    if (e.code !== 'Space') return;
    const ae = document.activeElement;
    if (ae && (ae.isContentEditable || ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) return;
    e.preventDefault();                  // don't scroll / click a focused button
    if (!spaceHeld) { spaceHeld = true; document.body.classList.add('space-pan'); }
  });
  window.addEventListener('keyup', (e) => {
    if (e.code === 'Space') { spaceHeld = false; document.body.classList.remove('space-pan'); }
  });
  window.addEventListener('blur', () => { spaceHeld = false; document.body.classList.remove('space-pan'); });

  // Insurance against focus-scroll: if anything ever manages to scroll the
  // container (e.g. a loading iframe grabbing focus), snap it back — we drive
  // the view with transform, never native scroll. (overflow:clip should already
  // prevent this; this catches the document-level case too.)
  const pinScroll = (el) => { if (el && (el.scrollLeft || el.scrollTop)) { el.scrollLeft = 0; el.scrollTop = 0; } };
  viewport.addEventListener('scroll', () => pinScroll(viewport), { passive: true });
  window.addEventListener('scroll', () => { pinScroll(document.scrollingElement); pinScroll(document.body); }, { passive: true });

  let wheelRAF = 0;
  viewport.addEventListener('wheel', (e) => {
    e.preventDefault();
    exitInteract();
    // Ctrl+scroll, and trackpad pinch (which the browser reports as a
    // wheel event with ctrlKey set), zoom about the cursor. Plain
    // scroll / two-finger swipe pans.
    if (e.ctrlKey) {
      zoomAround(board.viewport.zoom * Math.exp(-e.deltaY * ZOOM_SPEED), e.clientX, e.clientY);
      return;
    }
    // Pan: accumulate deltas now, apply once per animation frame. Wheel events
    // can arrive several per frame; coalescing avoids redundant transform/grid
    // repaints and keeps the motion locked to the paint cycle.
    board.viewport.x -= e.deltaX;
    board.viewport.y -= e.deltaY;
    markPanActive();
    if (!wheelRAF) {
      wheelRAF = requestAnimationFrame(() => {
        wheelRAF = 0;
        applyViewport();
        commit({ viewportOnly: true });
      });
    }
  }, { passive: false });

  // (Cards are added from the left tool palette, not by double-clicking the
  // canvas — double-click-create fired accidentally right after a box-select.)

  // ════════════════════════════════════════════════════════
  //  FIT TO CONTENT — zoom-out-only framing of all nodes
  //  (interactive zoom-in is a 90% feature)
  // ════════════════════════════════════════════════════════
  // The on-screen area not covered by the fixed UI chrome (toolbar on top,
  // status/hint along the bottom). Framing centers within this, not the whole
  // window, so nodes don't land behind the toolbar.
  function visibleRect() {
    const tb = document.getElementById('toolbar').getBoundingClientRect();
    const top = tb.bottom + 12;
    const bottomChrome = 52;          // status + hint strip
    return { x: 0, y: top, w: innerWidth, h: Math.max(50, innerHeight - top - bottomChrome) };
  }

  // Frame a single node: zoom the canvas so it (nearly) fills the visible area,
  // centered. With the 1440px logical-width iframes, this reads as a crisp
  // full-window view of the embed.
  function frameNode(id) {
    const g = nodeGeom(id);
    if (!g) return;
    const r = visibleRect();
    const pad = 24;
    const zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM,
      Math.min(r.w / (g.w + pad * 2), r.h / (g.h + pad * 2))));
    board.viewport.zoom = zoom;
    board.viewport.x = r.x + r.w / 2 - (g.x + g.w / 2) * zoom;
    board.viewport.y = r.y + r.h / 2 - (g.y + g.h / 2) * zoom;
    applyViewport();
    commit({ viewportOnly: true });
  }

  // ── Linking to nodes ──
  // Copy a #node=<id> deep link to the clipboard; opening that link frames
  // the node (see focusFromHash). Inline links inside cards are a future,
  // WYSIWYG-dependent enhancement; this is the navigation primitive.
  function nodeLink(id) {
    return location.origin + location.pathname + '#node=' + encodeURIComponent(id);
  }
  function copyNodeLink(id, btn) {
    const flash = () => {
      const icon = btn && btn.querySelector('.icon');
      if (!icon) return;
      icon.classList.replace('icon-tag', 'icon-check');
      setTimeout(() => { icon.classList.replace('icon-check', 'icon-tag'); }, 900);
    };
    const url = nodeLink(id);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(flash, () => fallbackCopy(url, flash));
    } else {
      fallbackCopy(url, flash);
    }
  }
  function fallbackCopy(text, done) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); if (done) done(); } catch (e) { /* ignore */ }
    ta.remove();
  }
  // Frame (and select) the node named in the URL hash, e.g. #node=c_a1
  function focusFromHash() {
    const m = location.hash.match(/^#node=(.+)$/);
    if (!m) return;
    const id = decodeURIComponent(m[1]);
    if (getNode(id)) { frameNode(id); selectNode(id); }
  }

  // Step zoom / reset, centered on the visible area. Used by the zoom widget.
  function zoomStep(dir) {
    exitInteract();
    const r = visibleRect();
    zoomAround(board.viewport.zoom * (dir > 0 ? 1.25 : 1 / 1.25), r.x + r.w / 2, r.y + r.h / 2);
  }
  function zoomTo100() {
    exitInteract();
    const r = visibleRect();
    zoomAround(1, r.x + r.w / 2, r.y + r.h / 2);
  }

  function fitToContent() {
    exitInteract();
    const ids = [...nodeEls.keys()];
    if (!ids.length) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const id of ids) {
      const g = nodeGeom(id);
      if (!g) continue;
      minX = Math.min(minX, g.x); minY = Math.min(minY, g.y);
      maxX = Math.max(maxX, g.x + g.w); maxY = Math.max(maxY, g.y + g.h);
    }
    const r = visibleRect();
    const pad = 80;
    const bw = (maxX - minX) + pad * 2;
    const bh = (maxY - minY) + pad * 2;
    const zoom = Math.min(1, r.w / bw, r.h / bh);
    board.viewport.zoom = zoom;
    board.viewport.x = r.x + (r.w - bw * zoom) / 2 - (minX - pad) * zoom;
    board.viewport.y = r.y + (r.h - bh * zoom) / 2 - (minY - pad) * zoom;
    applyViewport();
    commit({ viewportOnly: true });
  }

  // ════════════════════════════════════════════════════════
  //  TOOLBAR + KEYBOARD
  // ════════════════════════════════════════════════════════
  document.getElementById('addCard').addEventListener('click', () => {
    const c = toWorld(innerWidth / 2, innerHeight / 2);
    createCard(c.x - 120, c.y - 24);
  });

  // ── Themed modal — creates a new frame, or edits an existing frame's URL ──
  const frameModal = document.getElementById('frame-modal');
  const frameUrl = document.getElementById('frame-url');
  const frameModalTitle = document.getElementById('frame-modal-title');
  const frameAddBtn = document.getElementById('frame-add');
  let frameModalMode = { type: 'create' };

  function openFrameModal(mode) {
    frameModalMode = mode;
    const isEdit = mode.type === 'edit';
    frameModalTitle.textContent = isEdit ? 'Edit frame URL' : 'Embed a web page';
    frameAddBtn.textContent = isEdit ? 'Save' : 'Add frame';
    frameModal.classList.remove('hidden');
    frameUrl.value = isEdit ? (mode.src || '') : '';
    frameUrl.focus();
    frameUrl.select();
  }
  function closeFrameModal() {
    frameModal.classList.add('hidden');
  }
  function submitFrameModal() {
    const src = normalizeUrl(frameUrl.value);
    if (!src) { frameUrl.focus(); return; }
    const mode = frameModalMode;
    closeFrameModal();
    if (mode.type === 'edit') {
      const data = board.iframes[mode.id];
      if (data) {
        data.src = src;
        const el = nodeEls.get(mode.id);
        el.classList.remove('loaded');                 // reset so the new URL lazy-loads
        el.querySelector('.iframe-frame').removeAttribute('src');
        renderIframe(mode.id);                          // refresh label + placeholder host
        scheduleFrameEval();                            // reload if currently in view
        commit();
      }
    } else {
      const c = mode.at || toWorld(innerWidth / 2, innerHeight / 2);
      createIframe(c.x - 240, c.y - 160, src);
    }
  }

  document.getElementById('addFrame').addEventListener('click', () => openFrameModal({ type: 'create' }));
  document.getElementById('frame-add').addEventListener('click', submitFrameModal);
  document.getElementById('frame-cancel').addEventListener('click', closeFrameModal);
  frameUrl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submitFrameModal(); }
  });
  // click the backdrop (not the dialog) to dismiss
  frameModal.addEventListener('pointerdown', (e) => {
    if (e.target === frameModal) closeFrameModal();
  });

  document.getElementById('fitContent').addEventListener('click', fitToContent);

  // On-screen zoom widget — always zooms the canvas, regardless of where the
  // cursor is, so it never conflicts with an interactive iframe.
  document.getElementById('zoomIn').addEventListener('click', () => zoomStep(1));
  document.getElementById('zoomOut').addEventListener('click', () => zoomStep(-1));
  document.getElementById('zoomReset').addEventListener('click', zoomTo100);
  document.getElementById('zoomFit').addEventListener('click', fitToContent);

  document.getElementById('resetView').addEventListener('click', () => {
    exitInteract();
    board.viewport.x = 0; board.viewport.y = 0; board.viewport.zoom = 1;
    applyViewport();
    commit({ viewportOnly: true });
  });

  // ── Clear board (typed-CLEAR confirmation modal) ──
  const clearModal = document.getElementById('clear-modal');
  const clearInput = document.getElementById('clear-confirm');
  const clearConfirmBtn = document.getElementById('clear-confirm-btn');

  function doClearBoard() {
    board.cards = {}; board.iframes = {}; board.connections = {};
    nodeEls.forEach((el) => el.remove()); nodeEls.clear();
    connEls.forEach((c) => { c.g.remove(); c.labelEl.remove(); }); connEls.clear();
    clearSelection(); interactiveId = null;
    commit();
  }
  function openClearModal() {
    if (boardIsEmpty()) return;            // nothing to clear
    clearModal.classList.remove('hidden');
    clearInput.value = '';
    clearConfirmBtn.disabled = true;
    clearInput.focus();
  }
  function closeClearModal() { clearModal.classList.add('hidden'); }
  function confirmClear() {
    if (clearInput.value !== 'CLEAR') return;
    closeClearModal();
    doClearBoard();
  }

  document.getElementById('clearBoard').addEventListener('click', openClearModal);
  clearInput.addEventListener('input', () => { clearConfirmBtn.disabled = clearInput.value !== 'CLEAR'; });
  clearInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); confirmClear(); }
  });
  clearConfirmBtn.addEventListener('click', confirmClear);
  document.getElementById('clear-cancel').addEventListener('click', closeClearModal);
  clearModal.addEventListener('pointerdown', (e) => { if (e.target === clearModal) closeClearModal(); });

  // ── JSON export / import — a portable backup, same shape as the cloud doc ──
  function boardIsEmpty() {
    return !Object.keys(board.cards).length &&
           !Object.keys(board.iframes).length &&
           !Object.keys(board.connections).length;
  }

  function exportBoard() {
    const blob = new Blob([JSON.stringify(board, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'whiteboard.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  // Replace the whole board (matches the 90% milestone: import restores
  // every node, connection, and the viewport exactly as saved).
  function replaceBoard(data) {
    board = normalizeBoard(data);
    reconcileToBoard();
    commit();   // recorded as one undo step, so an import can be undone
  }

  function importBoardFromFile(file) {
    const reader = new FileReader();
    reader.onload = () => {
      let data;
      try { data = JSON.parse(reader.result); }
      catch { alert('Import failed: that file is not valid JSON.'); return; }
      if (!isPlainBoardObject(data)) { alert('Import failed: not a whiteboard file.'); return; }
      if (!boardIsEmpty() && !confirm('Replace the current board with the imported file?')) return;
      replaceBoard(data);
    };
    reader.onerror = () => alert('Import failed: could not read the file.');
    reader.readAsText(file);
  }

  document.getElementById('exportBtn').addEventListener('click', exportBoard);
  const importInput = document.getElementById('importFile');
  document.getElementById('importBtn').addEventListener('click', () => importInput.click());
  importInput.addEventListener('change', () => {
    const file = importInput.files && importInput.files[0];
    if (file) importBoardFromFile(file);
    importInput.value = '';     // let the same file be re-imported later
  });

  // Nodes in reading order (top-to-bottom, then left-to-right) for Tab nav.
  function orderedNodeIds() {
    return [...nodeEls.keys()]
      .map((id) => ({ id, g: nodeGeom(id) }))
      .filter((o) => o.g)
      .sort((a, b) => (a.g.y - b.g.y) || (a.g.x - b.g.x))
      .map((o) => o.id);
  }

  // Pan (keeping zoom) just enough to bring a node fully into the visible area.
  function ensureNodeVisible(id) {
    const g = nodeGeom(id);
    if (!g) return;
    const z = board.viewport.zoom;
    const left = g.x * z + board.viewport.x, top = g.y * z + board.viewport.y;
    const right = left + g.w * z, bottom = top + g.h * z;
    const r = visibleRect();
    let dx = 0, dy = 0;
    if (left < r.x) dx = r.x - left + 20;
    else if (right > r.x + r.w) dx = (r.x + r.w) - right - 20;
    if (top < r.y) dy = r.y - top + 20;
    else if (bottom > r.y + r.h) dy = (r.y + r.h) - bottom - 20;
    if (dx || dy) { board.viewport.x += dx; board.viewport.y += dy; applyViewport(); commit({ viewportOnly: true }); }
  }

  function tabToNode(dir) {
    const order = orderedNodeIds();
    if (!order.length) return;
    const cur = selectedNodes.size === 1 ? [...selectedNodes][0] : null;
    let i;
    if (cur && order.includes(cur)) {
      i = (order.indexOf(cur) + dir + order.length) % order.length;
    } else {
      i = dir > 0 ? 0 : order.length - 1;
    }
    selectNode(order[i]);
    ensureNodeVisible(order[i]);
  }

  document.addEventListener('keydown', (e) => {
    // close any open modal first, whatever else is going on
    if (e.key === 'Escape' && !frameModal.classList.contains('hidden')) {
      e.preventDefault();
      closeFrameModal();
      return;
    }
    if (e.key === 'Escape' && !clearModal.classList.contains('hidden')) {
      e.preventDefault();
      closeClearModal();
      return;
    }
    if (e.key === 'Escape' && boardMenu && !boardMenu.classList.contains('hidden')) {
      e.preventDefault();
      closeBoardMenu();
      return;
    }
    const ae = document.activeElement;
    const editing = ae && (ae.isContentEditable ||
      ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA');

    // Undo / redo — only at the board level when NOT editing text (otherwise
    // let the browser handle native text undo inside the field).
    if (!editing && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) redo(); else undo();
      return;
    }
    if (!editing && e.ctrlKey && e.key.toLowerCase() === 'y') {  // Windows redo
      e.preventDefault();
      redo();
      return;
    }
    if (!editing && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'd' && selectedNodes.size) {
      e.preventDefault();        // (also stops the browser's bookmark dialog)
      duplicateSelection();
      return;
    }
    if (!editing && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      selectAllNodes();
      return;
    }
    if (!editing && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'c' && selectedNodes.size) {
      e.preventDefault();
      copySelection();
      return;
    }
    if (!editing && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'x' && selectedNodes.size) {
      e.preventDefault();
      copySelection();
      for (const id of [...selectedNodes]) deleteNode(id);
      return;
    }
    if (!editing && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'v' && clipboard) {
      e.preventDefault();
      pasteClipboard();
      return;
    }

    // Shift+1 — zoom to fit all content (mirrors the Fit button). "1" reports
    // as "!" with Shift on most layouts, so accept either.
    if (!editing && e.shiftKey && (e.key === '1' || e.key === '!')) {
      e.preventDefault();
      fitToContent();
      return;
    }

    if (e.key === 'Tab' && !editing && frameModal.classList.contains('hidden')) {
      e.preventDefault();
      tabToNode(e.shiftKey ? -1 : 1);
      return;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && !editing && (selectedNodes.size || selectedConn)) {
      e.preventDefault();
      if (selectedConn) deleteConnection(selectedConn);
      for (const id of [...selectedNodes]) deleteNode(id);
    }
    if (e.key === 'Escape') {
      if (editing) ae.blur();
      else if (interactiveId) setInteractive(interactiveId, false);
      else clearSelection();
    }
  });

  // While Ctrl/⌘ is held, let the canvas capture the wheel even over an
  // interactive frame (CSS drops the frame's pointer-events), so zoom works
  // there instead of triggering the browser's own page zoom. Best-effort: it
  // can't help once keyboard focus is inside a cross-origin frame, nor for
  // trackpad pinch (which has no real key press) — exit interact mode for those.
  const onModifier = (e) => {
    document.body.classList.toggle('zoom-modifier', e.ctrlKey || e.metaKey);
  };
  window.addEventListener('keydown', onModifier);
  window.addEventListener('keyup', onModifier);
  window.addEventListener('blur', () => document.body.classList.remove('zoom-modifier'));

  // ════════════════════════════════════════════════════════
  //  RICH TEXT — card bodies are sanitized HTML, edited with a
  //  mini toolbar (bold / italic / list) and inline node links.
  // ════════════════════════════════════════════════════════
  const ALLOWED_TAGS = new Set(['B', 'I', 'EM', 'STRONG', 'U', 'UL', 'OL', 'LI', 'BR', 'DIV', 'P', 'SPAN', 'A']);

  function sanitizeHtml(html) {
    const src = document.createElement('div');
    src.innerHTML = html || '';
    const out = document.createElement('div');
    const copy = (from, to) => {
      from.childNodes.forEach((n) => {
        if (n.nodeType === 3) {
          to.appendChild(document.createTextNode(n.nodeValue));
        } else if (n.nodeType === 1 && ALLOWED_TAGS.has(n.tagName)) {
          const el = document.createElement(n.tagName.toLowerCase());
          if (n.tagName === 'A') {
            const href = n.getAttribute('href') || '';
            const isNode = n.classList.contains('node-link');
            if (/^#node=/.test(href) || /^https?:\/\//i.test(href)) el.setAttribute('href', href);
            if (isNode) {
              el.className = 'node-link';
              const dn = n.getAttribute('data-node');
              if (dn) el.setAttribute('data-node', dn);
              el.setAttribute('contenteditable', 'false');
            } else if (/^https?:\/\//i.test(href)) {
              el.setAttribute('target', '_blank');
              el.setAttribute('rel', 'noopener noreferrer');
            }
          }
          copy(n, el);
          to.appendChild(el);
        } else if (n.nodeType === 1 && !/^(SCRIPT|STYLE)$/.test(n.tagName)) {
          copy(n, to);     // drop the tag, keep its sanitized children
        }
      });
    };
    copy(src, out);
    return out.innerHTML;
  }

  // Follow a link inside a card body: node links frame their target;
  // external (http) links open in a new tab.
  function followLink(a) {
    const nid = a.dataset.node;
    if (nid) {
      if (getNode(nid)) { frameNode(nid); selectNode(nid); }
      return;
    }
    const href = a.getAttribute('href');
    if (href && /^https?:/i.test(href)) window.open(href, '_blank', 'noopener');
  }

  function saveCardBody(id, bodyEl) {
    const data = board.cards[id];
    if (!data) return;
    data.body = sanitizeHtml(bodyEl.innerHTML);
    redrawConnectionsFor(id);   // body height may have changed
    commit({ coalesce: true });
  }

  // A card's label: its title, else a short snippet of its body text.
  function cardSnippet(data) {
    if (data.title && data.title.trim()) return data.title.trim();
    const tmp = document.createElement('div');
    tmp.innerHTML = sanitizeHtml(data.body || '');
    const t = (tmp.textContent || '').trim().replace(/\s+/g, ' ');
    return t ? t.slice(0, 40) : '(untitled)';
  }
  function nodeTitle(id) {
    const n = getNode(id);
    if (!n) return 'node';
    if (n.type === 'card') return cardSnippet(n.data);
    return n.data.title || labelFor(n.data.src);
  }
  function nodeKind(id) {
    const n = getNode(id);
    return n ? (n.type === 'card' ? 'Card' : 'Frame') : '';
  }

  // ── floating toolbar ──
  let activeBody = null;        // { id, el } of the card body being edited
  let savedRange = null;        // selection captured when opening the picker
  let editingLink = null;       // an existing node-link the picker will re-target

  // The node-link the caret/selection is currently on (so the link button
  // edits it instead of inserting a new one), or null.
  function nodeLinkAtSelection(bodyEl) {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return null;
    const r = sel.getRangeAt(0);
    if (!bodyEl.contains(r.startContainer)) return null;
    const isLink = (n) => (n && n.nodeType === 1 && n.matches && n.matches('a.node-link')) ? n : null;
    // 1) selection inside a chip (rare — chips are contenteditable=false)
    const startEl = r.startContainer.nodeType === 3 ? r.startContainer.parentElement : r.startContainer;
    const anc = startEl && startEl.closest && startEl.closest('a.node-link');
    if (anc && bodyEl.contains(anc)) return anc;
    // 2) element container: chip selected, or sitting at / just before the offset
    const fromEl = (cont, off) => cont && cont.nodeType === 1
      ? (isLink(cont.childNodes[off]) || isLink(cont.childNodes[off - 1])) : null;
    // 3) text container: chip is the adjacent sibling of the caret
    const fromText = (cont, off) => {
      if (!cont || cont.nodeType !== 3) return null;
      if (off === 0) return isLink(cont.previousSibling);
      if (off === cont.length) return isLink(cont.nextSibling);
      return null;
    };
    return fromEl(r.startContainer, r.startOffset) || fromEl(r.endContainer, r.endOffset)
        || fromText(r.startContainer, r.startOffset) || fromText(r.endContainer, r.endOffset);
  }
  const textToolbar = document.getElementById('text-toolbar');
  const nodePicker = document.getElementById('node-picker');
  const npFilter = document.getElementById('np-filter');
  const npList = document.getElementById('np-list');

  // The node the toolbar is anchored to, so it can re-track the card as the
  // board pans/zooms (the toolbar is fixed-positioned in screen space).
  let textToolbarEl = null;
  function positionTextToolbar(cardEl) {
    const r = cardEl.getBoundingClientRect();
    const tw = textToolbar.offsetWidth, th = textToolbar.offsetHeight;
    const left = Math.max(8, Math.min(r.left, innerWidth - tw - 8));
    let top = r.top - th - 8;
    if (top < 8) top = r.bottom + 8;
    textToolbar.style.left = left + 'px';
    textToolbar.style.top = top + 'px';
  }
  function showTextToolbar(cardEl) {
    textToolbarEl = cardEl;
    textToolbar.classList.remove('hidden');
    positionTextToolbar(cardEl);
  }
  function repositionTextToolbar() {
    if (textToolbarEl && !textToolbar.classList.contains('hidden')) positionTextToolbar(textToolbarEl);
  }
  function hideTextToolbarIfIdle() {
    const ae = document.activeElement;
    if (ae && (ae.closest('#text-toolbar') || ae.closest('#node-picker'))) return;
    if (ae && ae.classList && ae.classList.contains('card-body')) return;
    textToolbar.classList.add('hidden');
    textToolbarEl = null;
    closeNodePicker();
    activeBody = null;
  }

  document.execCommand('styleWithCSS', false, false);  // prefer <b>/<i> over inline styles
  textToolbar.querySelectorAll('[data-cmd]').forEach((btn) => {
    btn.addEventListener('mousedown', (e) => e.preventDefault());  // keep the selection
    btn.addEventListener('click', () => {
      document.execCommand(btn.dataset.cmd, false);
      if (activeBody) saveCardBody(activeBody.id, activeBody.el);
    });
  });

  // ── inline node links ──
  const ttLink = document.getElementById('tt-link');
  ttLink.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const sel = window.getSelection();
    savedRange = sel && sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
    // if the caret/selection is on an existing link, the picker re-targets it
    editingLink = activeBody ? nodeLinkAtSelection(activeBody.el) : null;
  });
  ttLink.addEventListener('click', () => openNodePicker());

  function openNodePicker() {
    if (!activeBody) return;
    renderPickerList('');
    nodePicker.classList.remove('hidden');
    const r = ttLink.getBoundingClientRect();
    nodePicker.style.left = Math.max(8, Math.min(r.left, innerWidth - nodePicker.offsetWidth - 8)) + 'px';
    nodePicker.style.top = (r.bottom + 6) + 'px';
    npFilter.value = '';
    npFilter.placeholder = editingLink ? 'Change link target…' : 'Card, frame, or paste an ID…';
    npFilter.focus();
  }
  function closeNodePicker() { nodePicker.classList.add('hidden'); editingLink = null; }

  function renderPickerList(filter) {
    // accept a pasted "#node=ID" / full deep link, else plain text/id
    const raw = (filter || '').trim();
    const hash = raw.match(/#node=([^\s&]+)/);
    const f = (hash ? decodeURIComponent(hash[1]) : raw).toLowerCase();

    npList.innerHTML = '';
    const ids = [...nodeEls.keys()].filter((id) => !activeBody || id !== activeBody.id);
    let any = false;
    for (const id of ids) {
      const kind = nodeKind(id);
      const primary = nodeTitle(id);
      const hay = (kind + ' ' + primary + ' ' + id).toLowerCase();  // match label OR id
      if (f && !hay.includes(f)) continue;
      any = true;
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'np-item';
      item.dataset.id = id;
      item.innerHTML = '<span class="np-type"></span><span class="np-label"></span><span class="np-id"></span>';
      item.querySelector('.np-type').textContent = kind;
      item.querySelector('.np-label').textContent = primary;
      item.querySelector('.np-id').textContent = id;
      item.addEventListener('mousedown', (e) => e.preventDefault());
      item.addEventListener('click', () => insertNodeLink(id));
      npList.appendChild(item);
    }
    if (!any) {
      const empty = document.createElement('div');
      empty.className = 'np-empty';
      empty.textContent = 'No matching nodes';
      npList.appendChild(empty);
    }
  }
  npFilter.addEventListener('input', () => renderPickerList(npFilter.value));
  npFilter.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); closeNodePicker(); if (activeBody) activeBody.el.focus(); }
    if (e.key === 'Enter') {
      e.preventDefault();
      const first = npList.querySelector('.np-item');
      if (first) insertNodeLink(first.dataset.id);
    }
  });

  function insertNodeLink(targetId) {
    if (!activeBody) return;
    const bodyEl = activeBody.el;

    // Editing an existing link: just re-target it (and refresh an auto label).
    if (editingLink && bodyEl.contains(editingLink)) {
      const oldId = editingLink.dataset.node;
      const wasAutoLabel = editingLink.textContent === nodeTitle(oldId);
      editingLink.dataset.node = targetId;
      editingLink.setAttribute('href', '#node=' + encodeURIComponent(targetId));
      if (wasAutoLabel) editingLink.textContent = nodeTitle(targetId);
      closeNodePicker();
      saveCardBody(activeBody.id, bodyEl);
      return;
    }

    bodyEl.focus();
    const sel = window.getSelection();
    if (savedRange) { sel.removeAllRanges(); sel.addRange(savedRange); }
    const range = sel.rangeCount ? sel.getRangeAt(0) : null;

    const a = document.createElement('a');
    a.className = 'node-link';
    a.setAttribute('href', '#node=' + encodeURIComponent(targetId));
    a.setAttribute('data-node', targetId);
    a.setAttribute('contenteditable', 'false');
    a.textContent = (range && !range.collapsed) ? range.toString() : nodeTitle(targetId);

    if (range) {
      range.deleteContents();
      range.insertNode(a);
      const space = document.createTextNode(' ');
      a.after(space);
      const after = document.createRange();
      after.setStartAfter(space);
      after.collapse(true);
      sel.removeAllRanges();
      sel.addRange(after);
    } else {
      bodyEl.appendChild(a);
    }
    closeNodePicker();
    saveCardBody(activeBody.id, bodyEl);
  }

  // ════════════════════════════════════════════════════════
  //  QUICK JUMP (⌘K) — search every card/frame by its visible text and fly
  //  the viewport to the pick. Arrow keys move the highlight, Enter jumps.
  // ════════════════════════════════════════════════════════
  const jumpEl = document.getElementById('jump');
  const jumpInput = document.getElementById('jump-input');
  const jumpList = document.getElementById('jump-list');

  // Everything findable about a node: its rendered text (title + card body),
  // a frame's URL, and the id (so a pasted deep-link id matches too).
  function nodeSearchText(id) {
    const n = getNode(id);
    const el = nodeEls.get(id);
    const extra = n && n.type === 'iframe' ? (n.data.src || '') : '';
    return ((el ? el.textContent : '') + ' ' + extra + ' ' + id).toLowerCase();
  }

  function openJump() {
    exitInteract();
    renderJumpList('');
    jumpEl.classList.remove('hidden');
    jumpInput.value = '';
    jumpInput.focus();
  }
  function closeJump() { jumpEl.classList.add('hidden'); }

  function jumpToNode(id) {
    closeJump();
    frameNode(id);
    selectNode(id);
    flashNode(id);
  }
  // A brief pulse so the eye lands on the found node after the viewport moves.
  function flashNode(id) {
    const el = nodeEls.get(id);
    if (!el) return;
    el.classList.remove('flash');
    void el.offsetWidth;               // restart the animation if re-triggered
    el.classList.add('flash');
    el.addEventListener('animationend', () => el.classList.remove('flash'), { once: true });
  }

  function renderJumpList(query) {
    const q = (query || '').trim().toLowerCase();
    jumpList.innerHTML = '';
    let any = false;
    for (const id of nodeEls.keys()) {
      if (q && !nodeSearchText(id).includes(q)) continue;
      any = true;
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'np-item';
      item.dataset.id = id;
      item.innerHTML = '<span class="np-type"></span><span class="np-label"></span><span class="np-id"></span>';
      item.querySelector('.np-type').textContent = nodeKind(id);
      item.querySelector('.np-label').textContent = nodeTitle(id);
      item.querySelector('.np-id').textContent = id;
      item.addEventListener('mousedown', (e) => e.preventDefault());
      item.addEventListener('click', () => jumpToNode(id));
      jumpList.appendChild(item);
    }
    if (!any) {
      const empty = document.createElement('div');
      empty.className = 'np-empty';
      empty.textContent = 'No matching items';
      jumpList.appendChild(empty);
    }
    setJumpSel(0);
  }
  function setJumpSel(i) {
    const items = [...jumpList.querySelectorAll('.np-item')];
    if (!items.length) return;
    const idx = ((i % items.length) + items.length) % items.length;
    items.forEach((el, n) => el.classList.toggle('sel', n === idx));
    items[idx].scrollIntoView({ block: 'nearest' });
  }
  function jumpSelIndex() {
    const items = [...jumpList.querySelectorAll('.np-item')];
    return items.findIndex((el) => el.classList.contains('sel'));
  }

  jumpInput.addEventListener('input', () => renderJumpList(jumpInput.value));
  jumpInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeJump(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setJumpSel(jumpSelIndex() + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setJumpSel(jumpSelIndex() - 1); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const sel = jumpList.querySelector('.np-item.sel') || jumpList.querySelector('.np-item');
      if (sel) jumpToNode(sel.dataset.id);
    }
  });
  jumpEl.addEventListener('pointerdown', (e) => e.stopPropagation());
  window.addEventListener('pointerdown', (e) => {
    if (!jumpEl.classList.contains('hidden') && !jumpEl.contains(e.target)) closeJump();
  }, true);
  document.getElementById('findBtn').addEventListener('click', openJump);
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      if (jumpEl.classList.contains('hidden')) openJump(); else closeJump();
    }
  });

  // ════════════════════════════════════════════════════════
  //  BOARD LIBRARY — picker dropdown, switch / new / rename / remove
  // ════════════════════════════════════════════════════════
  const boardMenuBtn = document.getElementById('boardMenuBtn');
  const boardMenu = document.getElementById('board-menu');
  const boardList = document.getElementById('board-list');
  const boardNameLabel = document.getElementById('board-name');

  // ── Drive bar UI ──
  const driveStateEl = document.getElementById('drive-state');
  const driveConnectBtn = document.getElementById('driveConnectBtn');
  const driveSaveBtn = document.getElementById('driveSaveBtn');
  const driveSignoutBtn = document.getElementById('driveSignoutBtn');
  const openDriveBtn = document.getElementById('openDriveBtn');

  function setDriveState(cls, text) {
    if (!driveStateEl) return;
    const className = 'drive-state' + (cls ? ' ' + cls : '');
    if (driveStateEl.className === className && driveStateEl.textContent === text) return;   // no-op if unchanged
    driveStateEl.className = className;
    driveStateEl.textContent = text;
  }
  // Light status-line refresh: reflect whether the open Drive board has local
  // edits not yet pushed. Cheap enough to call on every commit (setDriveState
  // no-ops when unchanged); skipped mid-reconcile so it doesn't stomp the
  // transient 'syncing…/merging…' messages.
  function refreshDriveStatus() {
    if (!DRIVE.isConnected() || reconciling.has(currentBoardId)) return;
    const entry = libraryEntry(currentBoardId);
    if (!entry || entry.mode !== 'drive' || !entry.driveFileId) return;   // non-Drive board: leave as-is
    if (currentBoardFullySynced()) setDriveState('connected', 'Drive: synced');
    else setDriveState('pending', 'Drive: changes pending…');
  }
  function updateDriveUI() {
    if (!driveStateEl) return;
    const ok = DRIVE.configured();
    const connected = DRIVE.isConnected();
    const entry = libraryEntry(currentBoardId);
    const onDrive = entry && entry.mode === 'drive';

    if (!ok) {
      setDriveState('', 'Drive: not set up');
      driveConnectBtn.disabled = true;
      driveConnectBtn.title = 'Add your Google client ID + API key to config.js (see SETUP-google-drive.md).';
      driveConnectBtn.classList.remove('hidden');
      driveSaveBtn.classList.add('hidden');
      openDriveBtn.classList.add('hidden');
      driveSignoutBtn.classList.add('hidden');
      return;
    }
    driveConnectBtn.disabled = false;
    driveConnectBtn.title = '';
    driveConnectBtn.classList.toggle('hidden', connected);
    driveSaveBtn.classList.toggle('hidden', !connected);
    openDriveBtn.classList.toggle('hidden', !connected);
    driveSignoutBtn.classList.toggle('hidden', !connected);
    driveSaveBtn.textContent = onDrive ? 'Saved to Drive ✓' : 'Save to Drive';
    driveSaveBtn.disabled = onDrive;
    if (!connected) setDriveState('', 'Drive: not connected');
    else if (!onDrive) setDriveState('connected', 'Drive: connected');
    else if (currentBoardFullySynced()) setDriveState('connected', 'Drive: synced');
    else setDriveState('pending', 'Drive: changes pending…');
  }

  // Remember that the user opted into Drive so we can silently reconnect on the
  // next visit (no popup). Set only after a real connection; cleared on Sign out.
  const DRIVE_OPTED_KEY = 'whiteboard:drive:opted';
  const rememberDriveOptIn = () => { try { localStorage.setItem(DRIVE_OPTED_KEY, '1'); } catch (e) { /* quota */ } };
  const forgetDriveOptIn = () => { try { localStorage.removeItem(DRIVE_OPTED_KEY); } catch (e) { /* quota */ } };

  const stripBoardExt = (n) => (n || 'Untitled board').replace(/\.whiteboard\.json$/i, '').replace(/\.json$/i, '');

  // Link the current board to Drive: create its file (or reuse if already
  // linked), flip the library entry to Drive mode, and let future edits sync.
  async function linkCurrentBoardToDrive() {
    const entry = libraryEntry(currentBoardId);
    if (!entry) return;
    saveCurrent();                       // flush any pending local edits first
    setDriveState('syncing', 'Drive: saving…');
    try {
      const snapshot = JSON.parse(JSON.stringify(board));
      const body = contentForStore(snapshot);   // viewport is local-only, never written to Drive
      const res = entry.driveFileId
        ? await DRIVE.updateFile(entry.driveFileId, body)
        : await DRIVE.createFile(entry.name || 'Untitled board', body);
      const lib = loadLibrary();
      const e = lib.find((b) => b.id === currentBoardId);
      if (e) { e.mode = 'drive'; e.driveFileId = res.id; saveLibrary(lib); }
      setDriveSyncMeta(currentBoardId, snapshot.version, res.version);
      saveBase(currentBoardId, snapshot);   // this pushed state is the merge base
      rememberDriveOptIn();
      renderBoardMenu();
      updateDriveUI();
    } catch (err) {
      console.error('Save to Drive failed', err);
      setDriveState('error', 'Drive: save failed');
    }
  }

  // Open a board from Drive via the Picker. Reuses an existing local entry if
  // we already know this file; otherwise adds a new Drive-backed board.
  async function openFromDrive() {
    if (!DRIVE.isConnected()) return;
    setDriveState('syncing', 'Drive: opening…');
    try {
      const picked = await DRIVE.pickFile();
      if (!picked) { updateDriveUI(); return; }
      const content = normalizeBoard(await DRIVE.getFile(picked.id));
      const meta = await DRIVE.getMeta(picked.id);
      const lib = loadLibrary();
      let entry = lib.find((b) => b.driveFileId === picked.id);
      let id;
      if (entry) {
        id = entry.id;
        entry.name = stripBoardExt(picked.name);
        entry.updatedAt = Date.now();
      } else {
        id = newBoardId();
        entry = { id, name: stripBoardExt(picked.name), mode: 'drive', driveFileId: picked.id, updatedAt: Date.now() };
        lib.unshift(entry);
      }
      saveLibrary(lib);
      saveBoardContent(id, content);     // cache the just-fetched Drive content locally
      setDriveSyncMeta(id, content.version, meta.version);   // we are now in sync with Drive
      saveBase(id, content);             // fetched state is the merge base
      saveCurrent();                     // flush the board we're leaving
      loadAndShow(id);                   // loads the cache we just wrote
      updateDriveUI();
    } catch (err) {
      console.error('Open from Drive failed', err);
      setDriveState('error', 'Drive: open failed');
    }
  }

  // ── Sync reconcile (last-write-wins, with a prompt on true divergence) ──
  // Replace a board's content in place (cache + live view + history baseline).
  function applyPulledBoard(id, content) {
    saveBoardContent(id, content);
    if (id === currentBoardId) {
      content.viewport = board.viewport;   // viewport is local-only: don't let a pull move the view
      board = content;
      undoStack.length = 0; redoStack.length = 0; coalesceBase = null;
      if (coalesceTimer) { clearTimeout(coalesceTimer); coalesceTimer = null; }
      clearSelection(); interactiveId = null;
      reconcileToBoard();
      lastContent = contentSnapshot();
      updateHistoryButtons();
    }
  }

  // Non-blocking notice shown after a background merge that had true conflicts
  // (same field edited on both devices → this device's version was kept). Names
  // the affected nodes and offers to select/center them for review.
  const conflictNotice = document.createElement('div');
  conflictNotice.id = 'conflict-notice';
  conflictNotice.className = 'hidden';
  conflictNotice.innerHTML =
    '<span class="notice-text"></span>' +
    '<button class="notice-show" type="button">Show</button>' +
    '<button class="notice-dismiss" type="button" title="Dismiss" aria-label="Dismiss">×</button>';
  document.body.appendChild(conflictNotice);
  const hideConflictNotice = () => conflictNotice.classList.add('hidden');
  conflictNotice.querySelector('.notice-dismiss').addEventListener('click', hideConflictNotice);
  let conflictNoticeTimer = null;
  function showConflictNotice(items) {
    const named = items.filter((i) => i.coll !== 'connections').map((i) => '“' + i.label + '”');
    const shown = named.slice(0, 3).join(', ') + (named.length > 3 ? ' +' + (named.length - 3) + ' more' : '');
    const what = named.length ? shown : items.length + ' item(s)';
    conflictNotice.querySelector('.notice-text').textContent =
      'Merged with Drive — kept this device’s edits to ' + what + ' (the other device changed the same thing).';
    // "Show" selects the still-present conflicted nodes and centers the first.
    const ids = items.map((i) => i.id).filter((id) => nodeEls.has(id));
    const showBtn = conflictNotice.querySelector('.notice-show');
    showBtn.classList.toggle('hidden', !ids.length);
    showBtn.onclick = () => { setSelection(ids); if (ids[0]) frameNode(ids[0]); hideConflictNotice(); };
    conflictNotice.classList.remove('hidden');
    clearTimeout(conflictNoticeTimer);
    conflictNoticeTimer = setTimeout(hideConflictNotice, 15000);
  }

  const conflictModal = document.getElementById('conflict-modal');
  function openConflictModal(name) {
    return new Promise((resolve) => {
      if (!conflictModal) { resolve('cancel'); return; }
      const nameEl = document.getElementById('conflict-name');
      const keepLocal = document.getElementById('conflict-keep-local');
      const keepDrive = document.getElementById('conflict-keep-drive');
      const cancelBtn = document.getElementById('conflict-cancel');
      if (nameEl) nameEl.textContent = name || 'this board';
      conflictModal.classList.remove('hidden');
      const done = (choice) => {
        conflictModal.classList.add('hidden');
        keepLocal.removeEventListener('click', onLocal);
        keepDrive.removeEventListener('click', onDrive);
        cancelBtn.removeEventListener('click', onCancel);
        resolve(choice);
      };
      const onLocal = () => done('local');
      const onDrive = () => done('drive');
      const onCancel = () => done('cancel');
      keepLocal.addEventListener('click', onLocal);
      keepDrive.addEventListener('click', onDrive);
      cancelBtn.addEventListener('click', onCancel);
    });
  }

  // Bring one Drive board into agreement with its Drive file. Pulls when only
  // Drive changed, pushes when only this device changed, and prompts when both
  // diverged since the last sync. No-op for device boards / when disconnected.
  const reconciling = new Set();
  // Optimistic-concurrency write: re-read Drive's version right before writing
  // and bail if it no longer matches what our push/merge decision was based on.
  // A mismatch means another device pushed in the read→write window, so writing
  // would clobber it; instead we signal a retry and re-reconcile against the new
  // remote. This shrinks the clobber window to a single getMeta→PATCH gap (Drive
  // has no content-version precondition to close it fully) and never loses the
  // other device's edit — the retry merges it in.
  async function guardedUpdate(entry, content, basedOnVersion) {
    const fresh = await DRIVE.getMeta(entry.driveFileId);
    if (String(fresh.version) !== String(basedOnVersion)) return { stale: true };
    return { stale: false, res: await DRIVE.updateFile(entry.driveFileId, contentForStore(content)) };
  }

  // One reconcile pass. Returns 'retry' when a guarded write found Drive had
  // moved under us (re-run against the newer remote), otherwise 'done'.
  async function reconcileAttempt(id) {
    const entry = libraryEntry(id);
    if (!entry || entry.mode !== 'drive' || !entry.driveFileId) return 'done';
    const isCurrent = id === currentBoardId;
    const localBoard = isCurrent ? board : loadBoardContent(id);
    const localVersion = localBoard.version;
    const meta = await DRIVE.getMeta(entry.driveFileId);
    const localChanged = entry.syncedLocalVersion != null && localVersion !== entry.syncedLocalVersion;
    const remoteChanged = entry.driveVersion == null || String(meta.version) !== String(entry.driveVersion);

    if (!remoteChanged && !localChanged) {           // already in sync
      if (entry.driveVersion == null || entry.syncedLocalVersion == null) setDriveSyncMeta(id, localVersion, meta.version);
      if (!loadBase(id)) saveBase(id, localBoard);   // establish a base for future merges
      return 'done';
    }
    if (remoteChanged && !localChanged) {            // Drive is newer → pull
      setDriveState('syncing', 'Drive: updating…');
      const content = normalizeBoard(await DRIVE.getFile(entry.driveFileId));
      applyPulledBoard(id, content);
      saveBase(id, content);
      setDriveSyncMeta(id, content.version, meta.version);
      updateDriveUI();
      return 'done';
    }
    if (localChanged && !remoteChanged) {            // this device is ahead → push
      setDriveState('syncing', 'Drive: syncing…');
      const g = await guardedUpdate(entry, localBoard, meta.version);
      if (g.stale) return 'retry';                   // Drive moved under us → re-reconcile & merge
      saveBase(id, localBoard);
      setDriveSyncMeta(id, localVersion, g.res.version);
      updateDriveUI();
      return 'done';
    }
    // both sides changed since the last sync
    const remoteContent = normalizeBoard(await DRIVE.getFile(entry.driveFileId));
    const base = loadBase(id);
    if (base) {                                      // three-way merge: keep both sides' edits
      setDriveState('syncing', 'Drive: merging…');
      const { merged, conflicts, conflictItems } = mergeBoards(base, localBoard, remoteContent);
      const g = await guardedUpdate(entry, merged, meta.version);
      if (g.stale) return 'retry';                   // don't apply locally either — retry re-merges
      applyPulledBoard(id, merged);
      saveBase(id, merged);
      setDriveSyncMeta(id, merged.version, g.res.version);
      updateDriveUI();
      setDriveState('connected', conflicts
        ? 'Drive: merged (' + conflicts + ' kept this device)'
        : 'Drive: merged');
      if (conflicts && id === currentBoardId) showConflictNotice(conflictItems);
      return 'done';
    }
    // no base to merge against (first divergence / legacy board) → ask
    const choice = await openConflictModal(entry.name);
    if (choice === 'drive') {
      applyPulledBoard(id, remoteContent);
      saveBase(id, remoteContent);
      setDriveSyncMeta(id, remoteContent.version, meta.version);
    } else if (choice === 'local') {
      const res = await DRIVE.updateFile(entry.driveFileId, contentForStore(localBoard));
      saveBase(id, localBoard);
      setDriveSyncMeta(id, localVersion, res.version);
    }                                                // 'cancel' → leave both as-is
    updateDriveUI();
    return 'done';
  }

  async function reconcileDriveBoard(id) {
    const entry = libraryEntry(id);
    if (!entry || entry.mode !== 'drive' || !entry.driveFileId) return;
    if (!DRIVE.isConnected() || reconciling.has(id)) return;
    reconciling.add(id);
    try {
      // Retry a bounded number of times if a write loses the concurrency check;
      // each retry re-reads the remote and merges, so it converges quickly.
      for (let attempt = 0; attempt < 3; attempt++) {
        if (await reconcileAttempt(id) !== 'retry') break;
      }
    } catch (e) {
      console.error('Drive reconcile failed', e);
      setDriveState('error', 'Drive: sync failed');
    } finally {
      reconciling.delete(id);
    }
  }
  function maybeReconcileCurrent() { reconcileDriveBoard(currentBoardId); }

  // ── Background sync (batched, laggy by design) ─────────────────────────
  // Local saves are immediate (localStorage). Drive I/O is BATCHED onto this
  // tick: every ~20s the open board reconciles with Drive — pushing pending
  // local edits, pulling remote changes, or merging if both moved. This keeps
  // an active editing session from hitting Drive on every pause; edits reach
  // Drive within the tick interval (or immediately on tab-leave, see
  // flushPendingSync). A no-change tick is one cheap getMeta.
  const SYNC_POLL_MS = 10000;
  let syncPollTimer = null;
  function currentBoardFullySynced() {
    const e = libraryEntry(currentBoardId);
    return !!e && e.mode === 'drive' && e.syncedLocalVersion != null && board.version === e.syncedLocalVersion;
  }
  function syncTick() {
    if (document.hidden || !DRIVE.isConnected()) return;
    reconcileDriveBoard(currentBoardId);   // push pending local edits and/or pull remote
  }
  // Flush immediately on tab hide/close so edits from the current 20s window
  // aren't stranded. The local save is synchronous (always lands); the Drive
  // push is reliable on a tab switch and best-effort on actual close (the fetch
  // may be cut off), but the next boot reconcile pushes anything missed.
  function flushPendingSync() {
    flushViewport();                    // persist pan/zoom before leaving (local-only)
    if (saveTimer) {
      clearTimeout(saveTimer); saveTimer = null;
      try { saveBoardContent(currentBoardId, board); touchLibrary(currentBoardId); setSaveState('saved'); }
      catch (e) { console.error('Save failed', e); }
    }
    if (DRIVE.isConnected()) reconcileDriveBoard(currentBoardId);   // push this window's edits now
  }

  function startSyncPolling() {
    if (syncPollTimer) return;
    syncPollTimer = setInterval(syncTick, SYNC_POLL_MS);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) flushPendingSync();                                // leaving → flush pending edits
      else if (DRIVE.isConnected()) maybeReconcileCurrent();                  // returning → catch up (can prompt)
    });
    window.addEventListener('pagehide', flushPendingSync);                    // tab close / navigation away
  }

  // Attempt a silent (popup-free) reconnect for a returning opted-in user.
  // MUST run inside a user gesture (e.g. opening the board menu): Google's token
  // flow can only suppress its popup when invoked from a gesture, and a token
  // restored from sessionStorage means most reloads skip this entirely. We never
  // call it on bare page load — that's what was triggering the blocked popup.
  let autoConnectTried = false;
  async function tryDriveSilentReconnect() {
    if (autoConnectTried) return;          // once per session is enough
    if (!DRIVE.configured() || DRIVE.isConnected()) return;
    if (localStorage.getItem(DRIVE_OPTED_KEY) !== '1') return;
    autoConnectTried = true;
    try { await DRIVE.connect(false); }    // prompt:'none' → resolves via hidden iframe or fails quietly
    catch (e) { /* session expired / consent revoked — show Connect */ }
    updateDriveUI();
    if (DRIVE.isConnected()) maybeReconcileCurrent();   // catch up the open board
  }

  if (driveConnectBtn) {
    driveConnectBtn.addEventListener('click', async () => {
      driveConnectBtn.disabled = true;
      setDriveState('syncing', 'Drive: connecting…');
      try { await DRIVE.connect(true); rememberDriveOptIn(); }
      catch (e) { console.error(e); setDriveState('error', 'Drive: connection failed'); }
      finally { driveConnectBtn.disabled = false; updateDriveUI(); }
    });
    driveSaveBtn.addEventListener('click', linkCurrentBoardToDrive);
    openDriveBtn.addEventListener('click', openFromDrive);
    driveSignoutBtn.addEventListener('click', () => { DRIVE.signOut(); forgetDriveOptIn(); updateDriveUI(); });
  }

  function updateBoardMenuLabel() {
    const e = libraryEntry(currentBoardId);
    if (boardNameLabel) boardNameLabel.textContent = e ? e.name : 'Board';
  }
  function setHashBoard(id) {
    // replaceState avoids a hashchange event and any history spam
    history.replaceState(null, '', location.pathname + location.search + '#board=' + encodeURIComponent(id));
  }

  // Load a board's content into view (no save of the previous board).
  function loadAndShow(id) {
    currentBoardId = id;
    localStorage.setItem(CURRENT_KEY, id);
    board = loadBoardContent(id);
    undoStack.length = 0; redoStack.length = 0; coalesceBase = null;
    if (coalesceTimer) { clearTimeout(coalesceTimer); coalesceTimer = null; }
    clearSelection(); interactiveId = null;
    reconcileToBoard();
    lastContent = contentSnapshot();
    updateHistoryButtons();
    setHashBoard(id);
    setSaveState('saved');
    updateBoardMenuLabel();
    renderBoardMenu();
    closeBoardMenu();
    reconcileDriveBoard(id);    // if it's a Drive board, pull/push/resolve against Drive
  }
  function saveCurrent() {
    if (!currentBoardId) return;
    flushCoalesce();
    flushViewport();                    // persist this device's pan/zoom (local-only)
    saveBoardContent(currentBoardId, board);
    touchLibrary(currentBoardId);
  }
  function openBoard(id) {
    if (id === currentBoardId) { closeBoardMenu(); return; }
    saveCurrent();
    loadAndShow(id);
  }
  function createBoard() {
    saveCurrent();
    const id = newBoardId();
    saveBoardContent(id, blankBoard());
    const lib = loadLibrary();
    lib.unshift({ id, name: 'Board ' + (lib.length + 1), mode: 'device', updatedAt: Date.now() });
    saveLibrary(lib);
    loadAndShow(id);
  }
  function renameBoard(id, name) {
    const lib = loadLibrary();
    const e = lib.find((b) => b.id === id);
    if (!e) return;
    e.name = (name || '').trim() || 'Untitled board';
    saveLibrary(lib);
    updateBoardMenuLabel();
    // keep the Drive file's name in sync for Drive-backed boards
    if (e.mode === 'drive' && e.driveFileId && DRIVE.isConnected()) {
      setDriveState('syncing', 'Drive: renaming…');
      DRIVE.renameFile(e.driveFileId, e.name)
        .then(() => updateDriveUI())
        .catch((err) => { console.error('Drive rename failed', err); setDriveState('error', 'Drive: rename failed'); });
    }
  }
  function removeBoard(id) {
    const lib = loadLibrary();
    const idx = lib.findIndex((b) => b.id === id);
    if (idx === -1) return;
    lib.splice(idx, 1);
    saveLibrary(lib);
    localStorage.removeItem(boardKey(id));   // device board: content is gone
    clearBase(id);                           // drop any merge base too
    if (id !== currentBoardId) { renderBoardMenu(); return; }
    currentBoardId = null;                    // so we don't re-save the removed board
    if (!lib.length) {
      const nid = newBoardId();
      saveBoardContent(nid, blankBoard());
      lib.unshift({ id: nid, name: 'Untitled board', mode: 'device', updatedAt: Date.now() });
      saveLibrary(lib);
      loadAndShow(nid);
    } else {
      loadAndShow(lib[0].id);
    }
  }

  function closeBoardMenu() { if (boardMenu) boardMenu.classList.add('hidden'); }
  function renderBoardMenu() {
    if (!boardList) return;
    boardList.innerHTML = '';
    for (const entry of loadLibrary()) {
      const row = document.createElement('div');
      row.className = 'board-row' + (entry.id === currentBoardId ? ' current' : '');
      row.dataset.id = entry.id;
      row.innerHTML =
        '<span class="board-row-name" spellcheck="false"></span>' +
        '<span class="board-badge"></span>' +
        '<button class="board-rename icon-btn" title="Rename"><span class="icon icon-edit"></span></button>' +
        '<button class="board-remove icon-btn" title="Remove board"><span class="icon icon-delete"></span></button>';
      const nameEl = row.querySelector('.board-row-name');
      nameEl.textContent = entry.name;
      row.querySelector('.board-badge').textContent = entry.mode === 'drive' ? 'Drive' : 'Device';
      row.addEventListener('click', (e) => {
        if (e.target.closest('button') || nameEl.isContentEditable) return;
        openBoard(entry.id);
      });
      // rename via the ✎ button (avoids click-to-switch vs dblclick conflict)
      nameEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); nameEl.blur(); }
      });
      nameEl.addEventListener('blur', () => {
        nameEl.removeAttribute('contenteditable');
        renameBoard(entry.id, nameEl.textContent);
      });
      row.querySelector('.board-rename').addEventListener('click', (e) => { e.stopPropagation(); beginRename(nameEl); });
      const rm = row.querySelector('.board-remove');
      rm.addEventListener('click', (e) => {
        e.stopPropagation();
        if (rm.dataset.armed) { removeBoard(entry.id); return; }
        rm.dataset.armed = '1'; rm.classList.add('armed'); rm.title = 'Click again to delete';
        setTimeout(() => { rm.removeAttribute('data-armed'); rm.classList.remove('armed'); rm.title = 'Remove board'; }, 2500);
      });
      boardList.appendChild(row);
    }
    updateDriveUI();
  }

  if (boardMenuBtn) {
    boardMenuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const willOpen = boardMenu.classList.contains('hidden');
      boardMenu.classList.toggle('hidden');
      if (willOpen) { renderBoardMenu(); tryDriveSilentReconnect(); }
    });
    document.addEventListener('click', (e) => {
      if (!boardMenu.classList.contains('hidden') && !e.target.closest('#board-menu-wrap')) closeBoardMenu();
    });
    document.getElementById('newBoardBtn').addEventListener('click', createBoard);
  }
  function onBoardHashChange() {
    const m = location.hash.match(/[#&]board=([^&]+)/);
    const id = m ? decodeURIComponent(m[1]) : null;
    if (id && id !== currentBoardId && loadLibrary().some((b) => b.id === id)) openBoard(id);
  }

  // ════════════════════════════════════════════════════════
  //  BOOT
  // ════════════════════════════════════════════════════════
  const library = ensureLibrary();
  currentBoardId = pickInitialBoardId(library);
  localStorage.setItem(CURRENT_KEY, currentBoardId);
  board = loadBoardContent(currentBoardId);
  renderAll();
  updateEmptyState();
  lastContent = contentSnapshot();   // baseline for undo history
  setSaveState('saved');
  updateBoardMenuLabel();
  renderBoardMenu();
  focusFromHash();
  window.addEventListener('hashchange', focusFromHash);
  window.addEventListener('hashchange', onBoardHashChange);
  maybeReconcileCurrent();   // if connected (cached token) and the open board is Drive-backed, sync it
  startSyncPolling();        // keep the open Drive board fresh in the background
})();
