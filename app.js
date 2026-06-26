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
          <div class="card-title" contenteditable="plaintext-only" spellcheck="false"></div>
          <button class="copy-link" title="Copy link to this card">⧉</button>
          <button class="card-delete" title="Delete card">×</button>
        </div>
        <div class="card-body" contenteditable="plaintext-only" spellcheck="false"></div>`;
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
    if (document.activeElement !== bodyEl) bodyEl.textContent = data.body || '';
    return el;
  }

  function wireCard(id, el) {
    const header = el.querySelector('.card-header');
    const titleEl = el.querySelector('.card-title');
    const bodyEl = el.querySelector('.card-body');
    const delBtn = el.querySelector('.card-delete');

    el.addEventListener('pointerdown', () => selectNode(id), true);

    header.addEventListener('pointerdown', (e) => {
      if (e.target === titleEl) return;   // let clicks into the title edit
      startNodeDrag(id, el, e);
    });

    titleEl.addEventListener('input', () => { board.cards[id].title = titleEl.textContent; commit(); });
    bodyEl.addEventListener('input', () => {
      board.cards[id].body = bodyEl.textContent;
      redrawConnectionsFor(id);           // body growth changes the card's height
      commit();
    });
    titleEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); bodyEl.focus(); }
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
    requestAnimationFrame(() => el.querySelector('.card-title').focus());
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
          <span class="iframe-label"></span>
          <button class="iframe-edit" title="Edit URL">✎</button>
          <button class="copy-link" title="Copy link to this frame">⧉</button>
          <span class="iframe-czoom">
            <button class="czoom-btn czoom-out" title="Zoom content out">−</button>
            <button class="czoom-val" title="Reset content zoom to 100%">100%</button>
            <button class="czoom-btn czoom-in" title="Zoom content in">+</button>
          </span>
          <button class="iframe-zoom" title="Zoom canvas to this frame">⛶</button>
          <button class="iframe-toggle" title="Toggle interact mode">interact</button>
          <button class="card-delete" title="Delete frame">×</button>
        </div>
        <div class="iframe-wrap">
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

    const frame = el.querySelector('.iframe-frame');
    if (frame.getAttribute('src') !== data.src) frame.setAttribute('src', data.src);
    el.querySelector('.iframe-label').textContent = labelFor(data.src);
    el.querySelector('.czoom-val').textContent = frameZoomPct(data) + '%';
    layoutFrame(el);
    return el;
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
      startNodeDrag(id, el, e);
    });

    // Enter interact mode by double-clicking the frame; exit via the button / Esc.
    el.addEventListener('dblclick', (e) => {
      if (e.target.closest('.iframe-header') || e.target.closest('.resize-handle')) return;
      setInteractive(id, !el.classList.contains('interactive'));
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
      w: 480, h: 320, src, logicalWidth: IFRAME_LOGICAL_WIDTH
    };
    commit();
    const el = renderIframe(id);
    selectNode(id);
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
      if (!btn) return;
      const prev = btn.textContent;
      btn.textContent = '✓';
      setTimeout(() => { btn.textContent = prev; }, 900);
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
      if (data) { data.src = src; renderIframe(mode.id); commit(); }
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
  //  BOOT
  // ════════════════════════════════════════════════════════
  renderAll();
  setSaveState('saved');
  focusFromHash();
  window.addEventListener('hashchange', focusFromHash);
})();
