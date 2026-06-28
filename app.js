(() => {
  'use strict';

  // ════════════════════════════════════════════════════════
  //  DATA MODEL
  //  One board document — designed at 30%, reused verbatim as
  //  the Firestore document in Track B. Keyed MAPS for every
  //  collection; positions in world coordinates.
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
      version: 0,                       // bumped on every commit — the Track B poll sentinel
      viewport: { x: 0, y: 0, zoom: 1 },// world-space offset + scale
      cards: {},                        // { id: { x, y, title, body } }
      iframes: {},                      // { id: { x, y, w, h, src } }
      connections: {}                   // { id: { from, to } } — from/to are any node id
    };
  }

  let board = loadBoard();

  // ════════════════════════════════════════════════════════
  //  PERSISTENCE — debounced auto-save, restore on load
  // ════════════════════════════════════════════════════════
  function isPlainBoardObject(d) {
    return !!d && typeof d === 'object' && !Array.isArray(d);
  }

  // Shallow-merge arbitrary data onto a blank board so missing/future fields
  // stay valid. Shared by localStorage load and JSON import.
  function normalizeBoard(data) {
    return Object.assign(blankBoard(), data, {
      viewport: Object.assign({ x: 0, y: 0, zoom: 1 }, data && data.viewport),
      cards: (data && data.cards) || {},
      iframes: (data && data.iframes) || {},
      connections: (data && data.connections) || {}
    });
  }

  function loadBoard() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return blankBoard();
      return normalizeBoard(JSON.parse(raw));
    } catch (e) {
      console.warn('Could not parse saved board, starting fresh.', e);
      return blankBoard();
    }
  }

  let saveTimer = null;
  function commit() {
    board.version++;
    setSaveState('dirty');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(board));
        setSaveState('saved');
      } catch (e) {
        console.error('Save failed', e);
        setSaveState('error');
      }
    }, 400);
  }

  // ════════════════════════════════════════════════════════
  //  VIEW LAYER
  // ════════════════════════════════════════════════════════
  const viewport = document.getElementById('viewport');
  const world = document.getElementById('world');
  const coordsEl = document.getElementById('coords');
  const saveStateEl = document.getElementById('saveState');
  const zoomValEl = document.getElementById('zoomReset');

  function applyViewport() {
    const { x, y, zoom } = board.viewport;
    world.style.transform = `translate(${x}px, ${y}px) scale(${zoom})`;
    viewport.style.backgroundPosition = `${x}px ${y}px`;
    viewport.style.backgroundSize = `${28 * zoom}px ${28 * zoom}px`;
    coordsEl.textContent = `x: ${Math.round(-x)}  y: ${Math.round(-y)}`;
    if (zoomValEl) zoomValEl.textContent = Math.round(zoom * 100) + '%';
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
  function zoomAround(nextZoom, cx, cy) {
    const zoom = board.viewport.zoom;
    const next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, nextZoom));
    if (next === zoom) return;
    const w = toWorld(cx, cy);
    board.viewport.zoom = next;
    board.viewport.x = cx - w.x * next;
    board.viewport.y = cy - w.y * next;
    applyViewport();
    commit();
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
  //  SELECTION — a node OR a connection
  // ════════════════════════════════════════════════════════
  let selected = null; // { kind: 'node' | 'conn', id }

  function clearSelection() {
    if (!selected) return;
    if (selected.kind === 'node' && nodeEls.has(selected.id)) {
      nodeEls.get(selected.id).classList.remove('selected');
    } else if (selected.kind === 'conn' && connEls.has(selected.id)) {
      connEls.get(selected.id).g.classList.remove('selected');
    }
    selected = null;
  }
  function selectNode(id) {
    clearSelection();
    if (!id || !nodeEls.has(id)) return;
    selected = { kind: 'node', id };
    nodeEls.get(id).classList.add('selected');
  }
  function selectConn(id) {
    clearSelection();
    if (!connEls.has(id)) return;
    selected = { kind: 'conn', id };
    connEls.get(id).g.classList.add('selected');
  }

  // ════════════════════════════════════════════════════════
  //  SHARED DRAG — move any node by a handle
  // ════════════════════════════════════════════════════════
  function startNodeDrag(id, el, e) {
    if (e.button !== 0) return;
    e.preventDefault();
    selectNode(id);

    const data = getNode(id).data;
    const start = toWorld(e.clientX, e.clientY);
    const ox = data.x, oy = data.y;
    let moved = false;
    el.classList.add('dragging');

    const onMove = (ev) => {
      const now = toWorld(ev.clientX, ev.clientY);
      data.x = Math.round(ox + (now.x - start.x));
      data.y = Math.round(oy + (now.y - start.y));
      el.style.left = data.x + 'px';
      el.style.top = data.y + 'px';
      redrawConnectionsFor(id);
      moved = true;
    };
    const onUp = () => {
      el.classList.remove('dragging');
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

    el.addEventListener('pointerdown', () => selectNode(id), true);

    header.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      if (titleEl.isContentEditable) return;   // editing the title, don't drag
      startNodeDrag(id, el, e);
    });

    // Title: double-click to rename (shared with iframe titles); Enter → body.
    makeRenamable(titleEl, {
      onInput: (v) => { board.cards[id].title = v; commit(); },
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
    requestAnimationFrame(() => beginRename(el.querySelector('.card-title')));
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
            <button class="czoom-btn icon-btn czoom-out" title="Zoom content out"><span class="icon icon-remove"></span></button>
            <button class="czoom-val" title="Reset content zoom to 100%">100%</button>
            <button class="czoom-btn icon-btn czoom-in" title="Zoom content in"><span class="icon icon-add"></span></button>
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

    // src is set lazily by evaluateFrameLoading(), not here
    const labelEl = el.querySelector('.iframe-label');
    if (document.activeElement !== labelEl) labelEl.textContent = data.title || labelFor(data.src);
    el.querySelector('.ph-host').textContent = labelFor(data.src);
    el.querySelector('.czoom-val').textContent = frameZoomPct(data) + '%';
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

    el.addEventListener('pointerdown', () => selectNode(id), true);

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
      onInput: (v) => { board.iframes[id].title = v; commit(); },
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
    return `M${a.x},${a.y} C${cp1.x},${cp1.y} ${cp2.x},${cp2.y} ${b.x},${b.y}`;
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
      const hit = document.createElementNS(SVGNS, 'path');
      hit.setAttribute('class', 'hit');
      const line = document.createElementNS(SVGNS, 'path');
      line.setAttribute('class', 'line');
      line.setAttribute('marker-end', 'url(#arrow)');
      g.appendChild(hit);
      g.appendChild(line);
      svg.appendChild(g);
      g.addEventListener('pointerdown', (e) => { e.stopPropagation(); selectConn(id); });
      entry = { g, line, hit };
      connEls.set(id, entry);
    }
    drawConnection(id);
  }

  function drawConnection(id) {
    const entry = connEls.get(id);
    const data = board.connections[id];
    if (!entry || !data) return;
    const d = pathBetween(data.from, data.to);
    if (!d) return;
    entry.line.setAttribute('d', d);
    entry.hit.setAttribute('d', d);
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
    if (entry) { entry.g.remove(); connEls.delete(id); }
    if (selected && selected.kind === 'conn' && selected.id === id) selected = null;
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
    if (selected && selected.kind === 'node' && selected.id === id) selected = null;
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
  }

  // ════════════════════════════════════════════════════════
  //  CANVAS PAN / WHEEL / DOUBLE-CLICK
  // ════════════════════════════════════════════════════════
  viewport.addEventListener('pointerdown', (e) => {
    if (e.target !== viewport && e.target !== world && e.target !== svg) return;
    if (e.button !== 0) return;
    clearSelection();
    if (interactiveId) setInteractive(interactiveId, false);
    viewport.classList.add('panning');

    const startX = e.clientX, startY = e.clientY;
    const ox = board.viewport.x, oy = board.viewport.y;
    let moved = false;

    const onMove = (ev) => {
      board.viewport.x = ox + (ev.clientX - startX);
      board.viewport.y = oy + (ev.clientY - startY);
      applyViewport();
      moved = true;
    };
    const onUp = () => {
      viewport.classList.remove('panning');
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      if (moved) commit();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  });

  viewport.addEventListener('wheel', (e) => {
    e.preventDefault();
    exitInteract();
    // Ctrl+scroll, and trackpad pinch (which the browser reports as a
    // wheel event with ctrlKey set), zoom about the cursor. Plain
    // scroll / two-finger swipe pans.
    if (e.ctrlKey) {
      zoomAround(board.viewport.zoom * Math.exp(-e.deltaY * ZOOM_SPEED), e.clientX, e.clientY);
    } else {
      board.viewport.x -= e.deltaX;
      board.viewport.y -= e.deltaY;
      applyViewport();
      commit();
    }
  }, { passive: false });

  viewport.addEventListener('dblclick', (e) => {
    if (e.target !== viewport && e.target !== world && e.target !== svg) return;
    const w = toWorld(e.clientX, e.clientY);
    createCard(w.x - 120, w.y - 24);
  });

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
    commit();
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
    commit();
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
      const c = toWorld(innerWidth / 2, innerHeight / 2);
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
    commit();
  });

  document.getElementById('clearBoard').addEventListener('click', () => {
    const empty = !Object.keys(board.cards).length &&
                  !Object.keys(board.iframes).length;
    if (empty) return;
    if (!confirm('Delete everything on this board?')) return;
    board.cards = {}; board.iframes = {}; board.connections = {};
    nodeEls.forEach((el) => el.remove()); nodeEls.clear();
    connEls.forEach((c) => c.g.remove()); connEls.clear();
    selected = null; interactiveId = null;
    commit();
  });

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
    nodeEls.forEach((el) => el.remove()); nodeEls.clear();
    connEls.forEach((c) => c.g.remove()); connEls.clear();
    selected = null; interactiveId = null;
    renderAll();
    commit();
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
    if (dx || dy) { board.viewport.x += dx; board.viewport.y += dy; applyViewport(); commit(); }
  }

  function tabToNode(dir) {
    const order = orderedNodeIds();
    if (!order.length) return;
    let i;
    if (selected && selected.kind === 'node' && order.includes(selected.id)) {
      i = (order.indexOf(selected.id) + dir + order.length) % order.length;
    } else {
      i = dir > 0 ? 0 : order.length - 1;
    }
    selectNode(order[i]);
    ensureNodeVisible(order[i]);
  }

  document.addEventListener('keydown', (e) => {
    // close the modal first, whatever else is going on
    if (e.key === 'Escape' && !frameModal.classList.contains('hidden')) {
      e.preventDefault();
      closeFrameModal();
      return;
    }
    const ae = document.activeElement;
    const editing = ae && (ae.isContentEditable ||
      ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA');

    if (e.key === 'Tab' && !editing && frameModal.classList.contains('hidden')) {
      e.preventDefault();
      tabToNode(e.shiftKey ? -1 : 1);
      return;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && selected && !editing) {
      e.preventDefault();
      if (selected.kind === 'node') deleteNode(selected.id);
      else deleteConnection(selected.id);
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
    commit();
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
  const textToolbar = document.getElementById('text-toolbar');
  const nodePicker = document.getElementById('node-picker');
  const npFilter = document.getElementById('np-filter');
  const npList = document.getElementById('np-list');

  function showTextToolbar(cardEl) {
    const r = cardEl.getBoundingClientRect();
    textToolbar.classList.remove('hidden');
    const tw = textToolbar.offsetWidth, th = textToolbar.offsetHeight;
    const left = Math.max(8, Math.min(r.left, innerWidth - tw - 8));
    let top = r.top - th - 8;
    if (top < 8) top = r.bottom + 8;
    textToolbar.style.left = left + 'px';
    textToolbar.style.top = top + 'px';
  }
  function hideTextToolbarIfIdle() {
    const ae = document.activeElement;
    if (ae && (ae.closest('#text-toolbar') || ae.closest('#node-picker'))) return;
    if (ae && ae.classList && ae.classList.contains('card-body')) return;
    textToolbar.classList.add('hidden');
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
    npFilter.focus();
  }
  function closeNodePicker() { nodePicker.classList.add('hidden'); }

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
  //  BOOT
  // ════════════════════════════════════════════════════════
  renderAll();
  setSaveState('saved');
  focusFromHash();
  window.addEventListener('hashchange', focusFromHash);
})();
