const NS = 'http://www.w3.org/2000/svg';
const NW = 180, NH = 62;          // node box size in world units
const PALETTE = ['#33ff66', '#8dff4d', '#ffd23f', '#ff8a3d', '#ff5c4d', '#4dd6ff', '#c78dff', '#9aa79f'];
const GRID = 20;   // world units between dots - must match the #dotGrid pattern's width/height in index.html
const snapToGrid = v => Math.round(v / GRID) * GRID;

const svg = document.getElementById('canvas');
const gGrid = document.getElementById('gGrid');
const gAnno = document.getElementById('gAnno');
const gEdges = document.getElementById('gEdges');
const gNodes = document.getElementById('gNodes');
// Database/Server icons live here instead of gAnno - it's the last group in
// the SVG, so they always paint on top of every node/edge instead of
// sitting behind them like the other (background-grouping) annotation kinds.
const gIcons = document.getElementById('gIcons');
const $ = id => document.getElementById(id);

let nodes = [], edges = [], annotations = [], byId = new Map(), edgeById = new Map(), annoById = new Map();
let selected = null;        // selected node id
let selectedEdge = null;    // selected edge id
let multiSelected = new Set();   // node ids selected via ctrl+shift, moved together
let pendingTargets = new Set();  // node ids queued via alt+click, for one-src-to-many "add dependency"
let annotating = false;     // armed by the "draw annotations" dropdown, disarmed after one rectangle
let annotationKind = 'label';   // which option the dropdown was armed with: 'label', 'box', 'circle', 'arrow', 'db', or 'server'
const ANNOTATION_KINDS = ['label', 'box', 'circle', 'arrow', 'db', 'server'];
const ANNOTATION_KIND_LABELS = { label: 'Group label', box: 'Text box', circle: 'Circle', arrow: 'Arrow', db: 'Database', server: 'Server' };
// Circle, Arrow, Database, and Server are all outline-only: a dragged
// bounding box with no text ever attached to it, unlike Group Label/Text Box.
const ANNOTATION_KINDS_NO_NOTE = new Set(['circle', 'arrow', 'db', 'server']);
// Arrow-only: which end(s) of the line get an arrowhead - a pair of
// independent toggles (btnAnnoArrowStart/End) in the annotation dialog,
// see askAnnotation. Kept as one of these four strings (not two separate
// booleans) since that's what's actually persisted/round-tripped.
const ARROW_HEAD_CYCLE = ['end', 'start', 'both', 'none'];
function arrowHeadsFor(hasStart, hasEnd) {
  return hasStart && hasEnd ? 'both' : hasStart ? 'start' : hasEnd ? 'end' : 'none';
}
// Arrow-only: which corner of x,y,width,height the drag started from -
// 'l'/'r' (left/right) + 't'/'b' (top/bottom). x,y,width,height alone are
// a plain bounding box and can't tell a top-left-to-bottom-right drag
// apart from the reverse (they normalize identically), so this is what
// lets "start"/"end" mean the actual press/release points instead of
// always the box's top-left/bottom-right corners regardless of drag
// direction. Set once at creation (see the annoDraw pointerup handler);
// there's no UI to change it after the fact.
const START_CORNERS = ['lt', 'lb', 'rt', 'rb'];
// The two actual endpoints of an Arrow's line: p0 is where the drag
// started (the corner named by a.startCorner), p1 is the diagonally
// opposite corner - i.e. where it was released, which is where a default
// 'end' arrowhead belongs.
function arrowEndpoints(a) {
  const left = a.x, right = a.x + a.width, top = a.y, bottom = a.y + a.height;
  const sc = START_CORNERS.includes(a.startCorner) ? a.startCorner : 'lt';
  const p0 = { x: sc[0] === 'l' ? left : right, y: sc[1] === 't' ? top : bottom };
  const p1 = { x: sc[0] === 'l' ? right : left, y: sc[1] === 't' ? bottom : top };
  return { p0, p1 };
}
// Stroke color + arrowhead marker(s) for an Arrow's <line> - shared by the
// real render (draw()) and the live create/edit previews, so all three
// stay in sync by construction instead of three copies of this logic.
function applyArrowMarkers(lineEl, color, heads) {
  lineEl.setAttribute('stroke', color);
  const markerId = markerFor(color);
  if (heads === 'end' || heads === 'both') lineEl.setAttribute('marker-end', `url(#${markerId})`);
  else lineEl.removeAttribute('marker-end');
  if (heads === 'start' || heads === 'both') lineEl.setAttribute('marker-start', `url(#${markerId})`);
  else lineEl.removeAttribute('marker-start');
}
// Database/Server render a fixed icon inscribed in their box instead of an
// ellipse (Circle) or a plain rect (Group Label/Text Box) - no separate
// outline box, so the icon itself carries the annotation's color. The
// source files draw everything in #000000; iconHrefFor() recolors that to
// each annotation's own color and caches the result as a data: URI (not a
// plain "db_icon.svg" reference) so it still resolves once the SVG is
// cloned into a standalone export (svg/pdf/png) that no longer lives at
// this page's URL.
const ANNOTATION_ICON_FILES = { db: 'db_icon.svg', server: 'server_icon.svg' };
const iconTemplates = {};   // kind -> raw SVG source text, #000000 = the recolorable stroke
const iconHrefCache = new Map();   // `${kind}|${color}` -> data: URI
Promise.all(Object.entries(ANNOTATION_ICON_FILES).map(async ([kind, file]) => {
  iconTemplates[kind] = await (await fetch(file)).text();
})).then(() => draw()).catch(() => {});
function iconHrefFor(kind, color) {
  const template = iconTemplates[kind];
  if (!template) return null;   // still loading - box renders without its icon for one frame
  const key = `${kind}|${color}`;
  let href = iconHrefCache.get(key);
  if (!href) {
    const colored = template.replaceAll('#000000', color);
    href = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(colored)))}`;
    iconHrefCache.set(key, href);
  }
  return href;
}
let view = { x: -700, y: -400, k: 1 };   // world coord of top-left + scale
let hiddenColors = new Set();   // palette hex values currently checked in "hide colors" - view-only, not persisted

/* ---------- view transform ---------- */
function applyView() {
  const r = svg.getBoundingClientRect();
  const w = r.width / view.k, h = r.height / view.k;
  svg.setAttribute('viewBox', `${view.x} ${view.y} ${w} ${h}`);
  // Keeps the dot-grid backdrop (a single <rect> filled with the #dotGrid
  // pattern) sized to exactly the visible viewBox instead of one large
  // fixed rect, so it never runs out no matter how far the canvas is panned.
  gGrid.setAttribute('x', view.x); gGrid.setAttribute('y', view.y);
  gGrid.setAttribute('width', w); gGrid.setAttribute('height', h);
  $('zoomReadout').textContent = Math.round(view.k * 100) + '%';
}
function toWorld(cx, cy) {
  const r = svg.getBoundingClientRect();
  return { x: view.x + (cx - r.left) / view.k, y: view.y + (cy - r.top) / view.k };
}
window.addEventListener('resize', applyView);

svg.addEventListener('wheel', e => {
  e.preventDefault();
  const before = toWorld(e.clientX, e.clientY);
  const k = view.k * (e.deltaY < 0 ? 1.12 : 1 / 1.12);
  view.k = Math.min(4, Math.max(0.12, k));
  const after = toWorld(e.clientX, e.clientY);
  view.x += before.x - after.x;
  view.y += before.y - after.y;
  applyView();
}, { passive: false });

/* ---------- pointer: pan bg / drag node with shift / drag curve handle ---------- */
let pan = null, drag = null, handleDrag = null, anchorDrag = null, groupDrag = null, marquee = null, marqueeEl = null, annoDrag = null;
let annoDraw = null, annoDraftEl = null;

// Rubber-band box lives as a plain rect appended directly to <svg>, sibling
// to gEdges/gNodes rather than inside either - draw() replaces those two
// groups wholesale on every redraw, which would wipe the box mid-drag.
function updateMarqueeBox() {
  if (!marqueeEl) marqueeEl = el('rect', { class: 'marquee' }, svg);
  marqueeEl.setAttribute('x', Math.min(marquee.x0, marquee.x1));
  marqueeEl.setAttribute('y', Math.min(marquee.y0, marquee.y1));
  marqueeEl.setAttribute('width', Math.abs(marquee.x1 - marquee.x0));
  marqueeEl.setAttribute('height', Math.abs(marquee.y1 - marquee.y0));
}
// Same "plain rect outside the replaceChildren groups" trick as the
// marquee box, for the same reason - this is a live preview only, the
// real annotation isn't created until the drag ends and the prompts resolve.
function updateAnnoDraft() {
  const isCircle = annotationKind === 'circle';
  const isArrow = annotationKind === 'arrow';
  // annoDraftEl is null at the start of every drag (pointerup tears it
  // down), so this always picks the shape matching whichever kind is
  // currently armed - a rect preview while drawing an oval (or arrow) was
  // the bug.
  if (!annoDraftEl) annoDraftEl = el(isCircle ? 'ellipse' : isArrow ? 'line' : 'rect', { class: 'anno-draft' }, svg);
  const x = Math.min(annoDraw.x0, annoDraw.x1), y = Math.min(annoDraw.y0, annoDraw.y1);
  const width = Math.abs(annoDraw.x1 - annoDraw.x0), height = Math.abs(annoDraw.y1 - annoDraw.y0);
  if (isCircle) {
    annoDraftEl.setAttribute('cx', x + width / 2);
    annoDraftEl.setAttribute('cy', y + height / 2);
    annoDraftEl.setAttribute('rx', width / 2);
    annoDraftEl.setAttribute('ry', height / 2);
    return;
  }
  if (isArrow) {
    // The two raw drag points directly, not the top-left/bottom-right
    // normalization the other kinds use below - a line only needs its two
    // actual endpoints, and using the real press/current-position pair
    // (instead of always forcing x1,y1 to be the top-left corner) is what
    // makes the live preview actually track the drag for every direction,
    // not just a drag toward the bottom-right.
    annoDraftEl.setAttribute('x1', annoDraw.x0);
    annoDraftEl.setAttribute('y1', annoDraw.y0);
    annoDraftEl.setAttribute('x2', annoDraw.x1);
    annoDraftEl.setAttribute('y2', annoDraw.y1);
    return;
  }
  annoDraftEl.setAttribute('x', x);
  annoDraftEl.setAttribute('y', y);
  annoDraftEl.setAttribute('width', width);
  annoDraftEl.setAttribute('height', height);
}

svg.addEventListener('pointerdown', e => {
  if (annotating) {
    // Armed by the toolbar button - takes over the very next pointerdown
    // unconditionally (even on top of a node/edge/handle), since you should
    // be able to circle existing content, not just empty background.
    const w = toWorld(e.clientX, e.clientY);
    annoDraw = { x0: w.x, y0: w.y, x1: w.x, y1: w.y };
    svg.setPointerCapture(e.pointerId);
    return;
  }
  const h = e.target.closest('.handle');
  if (h) {
    const edge = edgeById.get(+h.dataset.edge);
    const which = h.dataset.which;               // 'c1' or 'c2'
    const cur = controlPoints(edge);
    if (edge.c1x == null) {                       // first touch: freeze both ends at their current (procedural) spot
      edge.c1x = cur.c1.x; edge.c1y = cur.c1.y;
      edge.c2x = cur.c2.x; edge.c2y = cur.c2.y;
    }
    const cp = which === 'c1' ? { x: edge.c1x, y: edge.c1y } : { x: edge.c2x, y: edge.c2y };
    const w = toWorld(e.clientX, e.clientY);
    handleDrag = { edge, which, dx: cp.x - w.x, dy: cp.y - w.y, moved: false };
    svg.classList.add('dragging');
    svg.setPointerCapture(e.pointerId);
    return;
  }
  const ah = e.target.closest('.anchor-handle');
  if (ah) {
    anchorDrag = { edge: edgeById.get(+ah.dataset.edge), side: ah.dataset.side, moved: false };
    svg.classList.add('dragging');
    svg.setPointerCapture(e.pointerId);
    return;
  }
  if (e.target.closest('.size-btn')) return;   // handled by its own onclick (resize)
  const mh = e.target.closest('.move-handle');
  if (mh) {
    // Same drag as shift+click on the node body, just reached via a
    // dedicated corner handle so a selected node can be moved without
    // holding shift.
    const node = byId.get(+mh.dataset.id);
    const w = toWorld(e.clientX, e.clientY);
    drag = { node, dx: node.x - w.x, dy: node.y - w.y, moved: false, displaced: new Set() };
    svg.classList.add('dragging');
    svg.setPointerCapture(e.pointerId);
    return;
  }
  const g = e.target.closest('.node');
  if (g) {
    const node = byId.get(+g.dataset.id);
    if (e.ctrlKey && e.shiftKey) {
      // Toggling immediately would make it impossible to drag an
      // already-selected group (mousedown on a member would deselect it
      // before the drag even starts). So: add new members right away, but
      // defer the remove-on-click case to pointerup - only deselect if the
      // pointer never moved, otherwise it was a drag of the whole group.
      const already = multiSelected.has(node.id);
      if (!already) multiSelected.add(node.id);
      const w = toWorld(e.clientX, e.clientY);
      groupDrag = {
        offsets: [...multiSelected].map(id => {
          const n = byId.get(id);
          return { node: n, dx: n.x - w.x, dy: n.y - w.y };
        }),
        primaryId: node.id,   // snap this one to the grid, shift the rest by the same delta - keeps their relative spacing intact
        moved: false,
        deselectIfNoMove: already ? node.id : null,
      };
      svg.classList.add('dragging');
      svg.setPointerCapture(e.pointerId);
      draw();
    } else if (e.shiftKey) {
      const w = toWorld(e.clientX, e.clientY);
      // displaced tracks every neighbor collision resolution has nudged
      // over the course of the whole drag, so pointerup can persist all of
      // them - not just whichever ones happen to still be moving on the
      // very last pointermove.
      drag = { node, dx: node.x - w.x, dy: node.y - w.y, moved: false, displaced: new Set() };
      svg.classList.add('dragging');
      svg.setPointerCapture(e.pointerId);
    } else if (e.altKey) {
      // Queues the node as a dependency target rather than going through
      // select() - select() drives fSrc via renderSelects(), and would
      // stomp whatever "from" node was just picked. Repeated alt+clicks
      // toggle membership, so one src can be wired to several targets in
      // one "add dependency" click.
      const srcId = +$('fSrc').value;
      if (node.id === srcId) {
        say('A node cannot depend on itself.');
      } else if (pendingTargets.has(node.id)) {
        pendingTargets.delete(node.id);
        say(`Removed "${node.name}" from pending targets.`, true);
      } else {
        pendingTargets.add(node.id);
        say(`Queued "${node.name}" as a target (${pendingTargets.size} pending).`, true);
      }
      renderDepForm();
    } else {
      select(node.id);
    }
    return;
  }
  const eg = e.target.closest('.edge');
  if (eg) {
    selectEdge(+eg.dataset.id);
    return;
  }
  const amh = e.target.closest('.anno-handle-zone');
  if (amh) {
    const anno = annoById.get(+amh.dataset.id);
    const w = toWorld(e.clientX, e.clientY);
    annoDrag = { anno, dx: anno.x - w.x, dy: anno.y - w.y, moved: false };
    svg.classList.add('dragging');
    svg.setPointerCapture(e.pointerId);
    return;
  }
  if (e.target.closest('.anno')) return;   // handled by its own onclick (box outline or label text - edit dialog)
  if (e.ctrlKey && e.altKey) {
    const w = toWorld(e.clientX, e.clientY);
    marquee = { x0: w.x, y0: w.y, x1: w.x, y1: w.y, moved: false };
    svg.classList.add('marqueeing');
    svg.setPointerCapture(e.pointerId);
    return;
  }
  pan = { sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y, moved: false };
  svg.classList.add('panning');
  svg.setPointerCapture(e.pointerId);
});

svg.addEventListener('pointermove', e => {
  if (handleDrag) {
    const w = toWorld(e.clientX, e.clientY);
    const x = Math.round(w.x + handleDrag.dx), y = Math.round(w.y + handleDrag.dy);
    handleDrag.edge[handleDrag.which + 'x'] = x;
    handleDrag.edge[handleDrag.which + 'y'] = y;
    handleDrag.moved = true;
    draw();
  } else if (anchorDrag) {
    // Not a free-floating drag like the curve handles - the anchor is
    // clamped to wherever the node's own boundary() logic puts it, so it
    // slides around the box's perimeter instead of floating off of it.
    // Stored in base (scale-1) units, not raw world pixels, and scaled
    // back up in edgeEndpoint() - so a pinned anchor stays on the node's
    // edge if it's resized later instead of drifting inside/outside it.
    const { edge, side } = anchorDrag;
    const node = byId.get(edge[side + '_id']);
    const w = toWorld(e.clientX, e.clientY);
    const b = boundary(node, w.x, w.y);
    const s = node.scale || 1;
    edge[side + '_ox'] = Math.round((b.x - node.x) / s);
    edge[side + '_oy'] = Math.round((b.y - node.y) / s);
    anchorDrag.moved = true;
    draw();
  } else if (groupDrag) {
    const w = toWorld(e.clientX, e.clientY);
    // Snap only the node that was actually grabbed; shift the rest of the
    // group by that same delta so the whole selection lands on the grid
    // together without warping anyone's spacing relative to each other.
    const primary = groupDrag.offsets.find(o => o.node.id === groupDrag.primaryId);
    const rawX = w.x + primary.dx, rawY = w.y + primary.dy;
    const snapDx = snapToGrid(rawX) - rawX, snapDy = snapToGrid(rawY) - rawY;
    for (const o of groupDrag.offsets) {
      o.node.x = Math.round(w.x + o.dx + snapDx);
      o.node.y = Math.round(w.y + o.dy + snapDy);
    }
    groupDrag.moved = true;
    draw();
  } else if (drag) {
    const w = toWorld(e.clientX, e.clientY);
    drag.node.x = snapToGrid(w.x + drag.dx);
    drag.node.y = snapToGrid(w.y + drag.dy);
    drag.moved = true;
    // Same collision avoidance as a resize - anything the dragged node
    // now overlaps gets shoved clear, live, as it moves.
    for (const n of resolveCollisions(drag.node.id)) drag.displaced.add(n.id);
    draw();
  } else if (annoDrag) {
    const w = toWorld(e.clientX, e.clientY);
    annoDrag.anno.x = Math.round(w.x + annoDrag.dx);
    annoDrag.anno.y = Math.round(w.y + annoDrag.dy);
    annoDrag.moved = true;
    draw();
  } else if (marquee) {
    const w = toWorld(e.clientX, e.clientY);
    marquee.x1 = w.x; marquee.y1 = w.y;
    marquee.moved = true;
    updateMarqueeBox();
  } else if (annoDraw) {
    const w = toWorld(e.clientX, e.clientY);
    annoDraw.x1 = w.x; annoDraw.y1 = w.y;
    updateAnnoDraft();
  } else if (pan) {
    view.x = pan.vx - (e.clientX - pan.sx) / view.k;
    view.y = pan.vy - (e.clientY - pan.sy) / view.k;
    pan.moved = true;
    applyView();
  }
});

svg.addEventListener('pointerup', async e => {
  svg.classList.remove('panning', 'dragging', 'marqueeing');
  if (handleDrag) {
    const hd = handleDrag; handleDrag = null;
    if (hd.moved) {
      await api('PUT', `/api/edges/${hd.edge.id}/curve`, {
        c1x: hd.edge.c1x, c1y: hd.edge.c1y, c2x: hd.edge.c2x, c2y: hd.edge.c2y,
      });
    }
  }
  if (anchorDrag) {
    const ad = anchorDrag; anchorDrag = null;
    if (ad.moved) {
      await api('PUT', `/api/edges/${ad.edge.id}/anchor`, {
        side: ad.side, ox: ad.edge[ad.side + '_ox'], oy: ad.edge[ad.side + '_oy'],
      });
    }
  }
  if (groupDrag) {
    const gd = groupDrag; groupDrag = null;
    if (gd.moved) {
      for (const o of gd.offsets) {
        o.node.pinned = 1;
        await api('PUT', `/api/nodes/${o.node.id}/position`, { x: o.node.x, y: o.node.y });
      }
      renderDetails();
    } else if (gd.deselectIfNoMove != null) {
      multiSelected.delete(gd.deselectIfNoMove);
      draw();
    }
  }
  if (drag) {
    const d = drag; drag = null;
    if (d.moved) {
      d.node.pinned = 1;
      await api('PUT', `/api/nodes/${d.node.id}/position`, { x: d.node.x, y: d.node.y });
      for (const id of d.displaced) {
        const n = byId.get(id);
        if (n) await api('PUT', `/api/nodes/${n.id}/position`, { x: n.x, y: n.y });
      }
      renderDetails();
    }
  }
  if (annoDrag) {
    const ad = annoDrag; annoDrag = null;
    if (ad.moved) {
      await api('PUT', `/api/annotations/${ad.anno.id}/position`, { x: ad.anno.x, y: ad.anno.y });
    }
  }
  if (pan) {
    const p = pan; pan = null;
    if (!p.moved) { multiSelected.clear(); select(null); }      // click on empty space clears selection
  }
  if (marquee) {
    const mq = marquee; marquee = null;
    if (marqueeEl) { marqueeEl.remove(); marqueeEl = null; }
    if (mq.moved) {
      const x0 = Math.min(mq.x0, mq.x1), x1 = Math.max(mq.x0, mq.x1);
      const y0 = Math.min(mq.y0, mq.y1), y1 = Math.max(mq.y0, mq.y1);
      // Overlap test, not fully-contained: a node that's only partly
      // inside the box still gets swept up, matching typical rubber-band
      // behavior in other apps.
      for (const n of nodes) {
        const { hw, hh } = nodeHalf(n);
        if (n.x + hw >= x0 && n.x - hw <= x1 && n.y + hh >= y0 && n.y - hh <= y1) {
          multiSelected.add(n.id);
        }
      }
      draw();
    }
  }
  if (annoDraw) {
    const ad = annoDraw; annoDraw = null;
    // Single-shot tool: armed by the dropdown, disarmed by the very next
    // completed drag regardless of outcome - a misfire or a cancelled
    // dialog just means picking a kind from "draw annotations" again to
    // retry, same as any other one-off gesture in this app.
    annotating = false;
    svg.classList.remove('annotating');
    const kind = annotationKind;
    const x = Math.min(ad.x0, ad.x1), y = Math.min(ad.y0, ad.y1);
    const width = Math.abs(ad.x1 - ad.x0), height = Math.abs(ad.y1 - ad.y0);
    // Arrow is fundamentally 1-D - requiring both axes to individually
    // clear 20 (like the 2-D kinds need, to have a real box) would make a
    // perfectly horizontal or vertical arrow impossible to draw. A length
    // check is the equivalent minimum for a line.
    const bigEnough = kind === 'arrow' ? Math.hypot(width, height) >= 20 : (width >= 20 && height >= 20);
    // Which corner of the (now-normalized) box the drag actually started
    // from - 'l'/'r' + 't'/'b'. x,y,width,height alone can't tell "end"
    // (the default arrowhead side) apart from "start": a top-left-to-
    // bottom-right drag and a bottom-right-to-top-left drag normalize to
    // the exact same box, and without this they'd render identically, with
    // the arrowhead always landing on the bottom-right corner regardless
    // of which end the mouse actually released on.
    const startCorner = (ad.x0 <= ad.x1 ? 'l' : 'r') + (ad.y0 <= ad.y1 ? 't' : 'b');
    // For a brand-new Arrow, keep the drag's own draft line on screen
    // (upgraded from the generic dashed draft to the real stroke+marker
    // look) instead of removing it the instant the drag ends - the edit
    // dialog's arrowhead toggles then update it live the same way they
    // already do for an existing arrow, right up until the dialog resolves
    // (nothing is actually created until Save either way).
    let previewEl = null;
    if (bigEnough && kind === 'arrow' && annoDraftEl) {
      previewEl = annoDraftEl;
      annoDraftEl = null;
      previewEl.setAttribute('class', 'anno-box');
      applyArrowMarkers(previewEl, '#ffd23f', 'end');
    } else if (annoDraftEl) {
      annoDraftEl.remove(); annoDraftEl = null;
    }
    if (bigEnough) {
      const result = await askAnnotation({
        defaultColor: '#ffd23f', defaultNote: '', kind,
        onArrowHeadsPreview: previewEl ? heads => applyArrowMarkers(previewEl, '#ffd23f', heads) : undefined,
      });
      previewEl?.remove();
      if (result) {
        try {
          await api('POST', '/api/annotations', {
            x, y, width, height, color: result.color, note: result.note.trim(), kind,
            arrowHeads: result.arrowHeads, startCorner, fontScale: result.fontScale,
          });
          await load();
          say(`${ANNOTATION_KIND_LABELS[kind]} added.`, true);
        } catch (e) { say(e.message); }
      }
    }
    // Covers every way out of this block (misfire, cancel, or a failed
    // POST) - annotating just flipped back to false above and the hint box
    // needs to drop its "drag a box..." message regardless of which one it was.
    updateHint();
  }
});

/* ---------- geometry ---------- */
// A node's actual on-canvas half-width/height, honoring its own resize
// scale (base NW/NH at scale 1) - everything that needs a node's real
// world-space box (edge attachment, marquee/collision hit-testing) goes
// through this instead of the raw NW/NH constants.
function nodeHalf(n) {
  const s = n.scale || 1;
  return { hw: (NW * s) / 2, hh: (NH * s) / 2 };
}
// Point where the line toward (tx,ty) leaves the node's box, just past its
// stroke. The clearance has to scale with the node - the border itself is
// drawn inside the scaled inner <g> (stroke-width 1.5, or 3 while
// selected), so a flat margin would get "buried" under the stroke on a
// scaled-up node instead of clearing it.
function boundary(n, tx, ty) {
  const { hw, hh } = nodeHalf(n);
  const margin = 4 * (n.scale || 1);
  const dx = tx - n.x, dy = ty - n.y;
  if (!dx && !dy) return { x: n.x, y: n.y };
  const s = Math.min(
    dx ? (hw + margin) / Math.abs(dx) : Infinity,
    dy ? (hh + margin) / Math.abs(dy) : Infinity
  );
  return { x: n.x + dx * s, y: n.y + dy * s };
}
// Where an edge actually touches a node's box: procedural (always aimed at
// the other node's center, sliding along the boundary as either node
// moves) until the user drags that endpoint's handle, at which point it's
// frozen as an offset from the node's own center - same "auto vs pinned"
// split as node placement and curve control points. An offset (not an
// absolute point) so a pinned anchor still follows the node if it's later
// moved, staying on the same relative spot on the box. The stored offset
// is in base (scale-1) units - scaled back up here by the node's current
// scale, so it also still lands on the box if the node's later resized.
function edgeEndpoint(e, side, self, other) {
  const ox = e[side + '_ox'], oy = e[side + '_oy'];
  if (ox == null) return boundary(self, other.x, other.y);
  const s = self.scale || 1;
  return { x: self.x + ox * s, y: self.y + oy * s };
}
// Deterministic per-edge jitter so a line always bends the same way.
function wobble(id, salt) {
  const v = Math.sin(id * 12.9898 + salt * 78.233) * 43758.5453;
  return v - Math.floor(v);
}
// Cheap string hash (djb2-ish) - turns the stable seed string below into
// the numeric seed wobble() expects.
function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}
// Control points: procedural (wobble-based, always attached to live node
// positions) until the user drags a handle, at which point both c1 and c2
// are frozen as absolute world coords on the edge row — same "auto vs
// pinned" split as node placement.
function controlPoints(e) {
  if (e.c1x != null && e.c2x != null) {
    return { c1: { x: e.c1x, y: e.c1y }, c2: { x: e.c2x, y: e.c2y } };
  }
  const a = byId.get(e.src_id), b = byId.get(e.dst_id);
  const p0 = edgeEndpoint(e, 'src', a, b), p1 = edgeEndpoint(e, 'dst', b, a);
  const dx = p1.x - p0.x, dy = p1.y - p0.y;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len, ny = dx / len;                  // unit normal
  const amp = Math.min(90, len * 0.28);
  // Seeded by the edge's stable identity (endpoint names + label/color),
  // not its numeric id - an id is fresh on every project import (by design,
  // see the export/import comment below), so an id-seeded wobble bent every
  // never-hand-curved edge differently after a round trip even though
  // nothing about the edge actually changed.
  const seed = hashStr(`${a?.name}→${b?.name}|${e.label || ''}|${e.color || ''}`);
  const o1 = (wobble(seed, 1) - 0.35) * amp + (wobble(seed, 3) > .5 ? 16 : -16);
  const o2 = (wobble(seed, 2) - 0.65) * amp;
  return {
    c1: { x: p0.x + dx * 0.30 + nx * o1, y: p0.y + dy * 0.30 + ny * o1 },
    c2: { x: p0.x + dx * 0.70 + nx * o2, y: p0.y + dy * 0.70 + ny * o2 },
  };
}
function edgePath(e) {
  const a = byId.get(e.src_id), b = byId.get(e.dst_id);
  if (!a || !b) return null;
  const p0 = edgeEndpoint(e, 'src', a, b), p1 = edgeEndpoint(e, 'dst', b, a);
  const { c1, c2 } = controlPoints(e);
  const mid = {                                          // cubic at t=0.5
    x: (p0.x + 3 * c1.x + 3 * c2.x + p1.x) / 8,
    y: (p0.y + 3 * c1.y + 3 * c2.y + p1.y) / 8,
  };
  return { d: `M${p0.x},${p0.y} C${c1.x},${c1.y} ${c2.x},${c2.y} ${p1.x},${p1.y}`, mid, p0, p1, c1, c2 };
}

/* ---------- render ---------- */
function el(tag, attrs, parent) {
  const n = document.createElementNS(NS, tag);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  parent && parent.appendChild(n);
  return n;
}

// Per-color marker defs, created lazily so a custom edge color also colors
// its own arrowhead(s) without touching the shared default #arrow marker.
const markerIds = new Set();
function markerFor(color) {
  if (!color) return 'arrow';
  const id = 'arrow-' + color.replace('#', '');
  if (!markerIds.has(id)) {
    const defs = svg.querySelector('defs');
    const m = el('marker', {
      id, viewBox: '0 0 10 10', refX: 9, refY: 5,
      markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse',
    }, defs);
    el('path', { d: 'M0,0 L10,5 L0,10 z', fill: color }, m);
    markerIds.add(id);
  }
  return id;
}

// Greedy word-wrap for the Text Box annotation kind - canvas measureText
// against the same font the box's text actually renders in (rather than a
// DOM-based measurement), so wrapping works without touching layout.
// Doesn't break mid-word; a single word wider than maxWidth just runs past
// it on its own line and gets clipped, same as the box handles any other
// overflow.
const wrapCtx = document.createElement('canvas').getContext('2d');
function wrapText(text, maxWidth, font) {
  wrapCtx.font = font;
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (line && wrapCtx.measureText(test).width > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function draw() {
  updateHint();
  gAnno.replaceChildren();
  gIcons.replaceChildren();
  const annoFont = themeVar('--font');   // hoisted - same for every text-box annotation this draw()
  for (const a of annotations) {
    if (hiddenColors.has(a.color)) continue;
    // Database/Server go in gIcons (painted after gNodes/gEdges, see the
    // const above) instead of gAnno, so they always sit on top of the
    // diagram rather than behind it like the background-grouping kinds.
    const parent = ANNOTATION_ICON_FILES[a.kind] ? gIcons : gAnno;
    // draw() rebuilds this <g> from scratch on every pointermove of a drag
    // (see annoDrag below) - if the redrawn box doesn't quite keep up with
    // a fast pointer, plain :hover CSS would flicker the handle off mid-drag
    // even though the drag itself (driven by annoDrag, not hover) keeps
    // working. Forcing it here instead keeps it visible for the drag's
    // whole duration regardless of where the pointer momentarily ends up.
    const isDragging = annoDrag && annoDrag.anno.id === a.id;
    const g = el('g', { class: 'anno' + (isDragging ? ' dragging' : ''), 'data-id': a.id }, parent);
    // Click anywhere in the group - the box's outline/fill or the label
    // text - opens the edit dialog, not just the text.
    g.title = 'click to edit this annotation';
    g.onclick = () => editAnnotation(a);
    if (a.kind === 'circle') {
      // Draw Circle: same drag-a-bounding-box gesture as the other two
      // kinds, just rendered as an ellipse inscribed in it instead of a
      // rect - no note field exists for this kind, so there's never any
      // text to render.
      el('ellipse', {
        class: 'anno-hit', cx: a.x + a.width / 2, cy: a.y + a.height / 2, rx: a.width / 2, ry: a.height / 2,
      }, g);
      el('ellipse', {
        class: 'anno-box', cx: a.x + a.width / 2, cy: a.y + a.height / 2,
        rx: a.width / 2, ry: a.height / 2,
        stroke: a.color, fill: 'none',
      }, g);
    } else if (a.kind === 'arrow') {
      // Draw Arrow: same drag-a-bounding-box gesture and no-note/no-fill
      // treatment as Circle, just a line between the two corners the drag
      // actually ran between (see arrowEndpoints - p0 is where it started,
      // p1 where it was released, so a default 'end' arrowhead lands on
      // the release point regardless of which direction was dragged)
      // instead of an ellipse inscribed in the box. Reuses .anno-hit/
      // .anno-box as-is (a line has no interior fill to begin with, and
      // Circle's plotter/theme stroke overrides already apply to any
      // .anno-box regardless of the element it's on), and the same
      // per-color arrowhead marker an edge's line uses - on whichever
      // end(s) a.arrowHeads (cycled in the edit dialog) says to put it.
      const { p0, p1 } = arrowEndpoints(a);
      el('line', { class: 'anno-hit', x1: p0.x, y1: p0.y, x2: p1.x, y2: p1.y }, g);
      const lineEl = el('line', { class: 'anno-box', x1: p0.x, y1: p0.y, x2: p1.x, y2: p1.y }, g);
      applyArrowMarkers(lineEl, a.color, a.arrowHeads || 'end');
    } else if (ANNOTATION_ICON_FILES[a.kind]) {
      // Database/Server: no dashed outline box - the icon itself (already
      // recolored to a.color) is the whole visual, so the hit target is a
      // plain filled-transparent rect covering the full drag box instead of
      // the stroke-only band the outline kinds use.
      el('rect', { class: 'anno-icon-hit', x: a.x, y: a.y, width: a.width, height: a.height }, g);
      const iconHref = iconHrefFor(a.kind, a.color);
      if (iconHref) {
        el('image', {
          class: 'anno-icon', x: a.x, y: a.y, width: a.width, height: a.height,
          href: iconHref, preserveAspectRatio: 'xMidYMid meet',
        }, g);
      }
    } else {
      el('rect', { class: 'anno-hit', x: a.x, y: a.y, width: a.width, height: a.height }, g);
      el('rect', {
        class: 'anno-box', x: a.x, y: a.y, width: a.width, height: a.height,
        stroke: a.color, fill: `${a.color}22`,
      }, g);
    }
    if (a.note && a.kind === 'box') {
      // Text Box: word-wrapped to the box's width, one <tspan> per line,
      // then clipped to the box's bounds - a clipPath scoped to this one
      // annotation's <g> (cheap since gAnno.replaceChildren() rebuilds it
      // every draw(), no stale ids/leftover defs to manage) so text past
      // the right edge wraps like any other text box, and text past the
      // bottom edge (too many wrapped lines for the box) is simply hidden,
      // same "never visible past the drawn outline" rule either way.
      const clipId = `anno-clip-${a.id}`;
      const clip = el('clipPath', { id: clipId }, g);
      el('rect', { x: a.x, y: a.y, width: a.width, height: a.height }, clip);
      const PAD = 10, fontSize = 12 * (a.fontScale || 1), lineHeight = fontSize * 1.3;
      const lines = wrapText(a.note, Math.max(10, a.width - PAD * 2), `700 ${fontSize}px ${annoFont}`);
      const t = el('text', {
        class: 'anno-label', x: a.x + PAD, y: a.y + PAD + fontSize,
        fill: a.color, 'clip-path': `url(#${clipId})`,
        style: `--anno-font-scale:${a.fontScale || 1}`,
      }, g);
      for (const [i, line] of lines.entries()) {
        const tspan = el('tspan', { x: a.x + PAD, dy: i === 0 ? 0 : lineHeight }, t);
        tspan.textContent = line;
      }
    } else if (a.note && a.kind !== 'circle') {
      // Group Label: sits above/outside the box, single line, unwrapped.
      const t = el('text', { class: 'anno-label', x: a.x + 10, y: a.y - 10, fill: a.color }, g);
      t.textContent = a.note;
    }
    // Grab handle - hollow square offset outside the top-right corner,
    // never sitting on the box/ellipse's own outline. Sitting exactly on
    // that line made the handle and the edit-click hit band compete
    // pixel-for-pixel for the same stroke; offsetting it clear of the box
    // fixes that. It's paired with an invisible "zone" rect that reaches
    // from just inside the corner out past the handle - hovering anywhere
    // in that zone (not just the thin handle stroke itself) is what
    // reveals it via the .anno:hover rule in style.css, same as hovering
    // .anno-hit/.anno-icon-hit does; without that reach, a circle's
    // ellipse curve never comes near this corner and the handle could
    // never be discovered by hovering near the annotation at all.
    const HANDLE_OFFSET = 16, HANDLE_SIZE = 12, ZONE_INSET = 4;
    const zoneReach = HANDLE_OFFSET + HANDLE_SIZE / 2 + 4;
    const zone = el('rect', {
      class: 'anno-handle-zone', 'data-id': a.id,
      x: a.x + a.width - ZONE_INSET, y: a.y - zoneReach,
      width: ZONE_INSET + zoneReach, height: ZONE_INSET + zoneReach,
    }, g);
    // g.onclick above fires on release regardless of how far the pointer
    // moved in between - without this, ending a drag (or just hovering to
    // reveal the handle then clicking it) would reopen the edit dialog too.
    zone.onclick = e => e.stopPropagation();
    el('rect', {
      class: 'anno-move-handle',
      x: a.x + a.width + HANDLE_OFFSET - HANDLE_SIZE / 2, y: a.y - HANDLE_OFFSET - HANDLE_SIZE / 2,
      width: HANDLE_SIZE, height: HANDLE_SIZE,
    }, g);
  }

  gEdges.replaceChildren();
  for (const e of edges) {
    if (e.color && hiddenColors.has(e.color)) continue;
    const p = edgePath(e);
    if (!p) continue;
    const hot = selected && (e.src_id === selected || e.dst_id === selected);
    const isSel = e.id === selectedEdge;
    const g = el('g', {
      class: 'edge' + (hot ? ' hot' : '') + (isSel ? ' sel' : ''), 'data-id': e.id,
      style: `--line-scale:${e.lineScale || 1};--label-scale:${e.labelScale || 1}`,
    }, gEdges);
    const markerId = markerFor(e.color);
    const pathAttrs = {
      class: 'edge-line', d: p.d, 'marker-end': `url(#${markerId})`, stroke: e.color || 'var(--wire)',
    };
    if (e.bidirectional) pathAttrs['marker-start'] = `url(#${markerId})`;
    // Fat invisible stroke behind the real line, purely for hit-testing -
    // lights up green on hover/proximity so you don't have to click the
    // hairline itself (mirrors the .handle/.anchor-handle pattern above).
    el('path', { class: 'edge-hit', d: p.d }, g);
    el('path', pathAttrs, g);
    if (e.label) {
      const t = el('text', {
        x: p.mid.x, y: p.mid.y, 'text-anchor': 'middle', fill: e.color || 'var(--phos)',
      }, g);
      t.textContent = e.label;
    }
    if (isSel) {
      el('line', { class: 'handle-arm', x1: p.p0.x, y1: p.p0.y, x2: p.c1.x, y2: p.c1.y }, g);
      el('line', { class: 'handle-arm', x1: p.p1.x, y1: p.p1.y, x2: p.c2.x, y2: p.c2.y }, g);
      for (const [which, pt] of [['c1', p.c1], ['c2', p.c2]]) {
        // Visible dot is small and precise-looking; the actual pointer
        // target is a larger invisible circle on top of it, so the handle
        // is still easy to grab with a mouse even when zoomed out.
        el('circle', { class: 'handle-dot', cx: pt.x, cy: pt.y, r: 6 }, g);
        el('circle', {
          class: 'handle', 'data-edge': e.id, 'data-which': which,
          cx: pt.x, cy: pt.y, r: 16,
        }, g);
      }
      // Anchor handles: where the line/arrowhead actually touches each
      // node's box, separate from the curve-shape handles above. Dashed
      // ring instead of solid so the two handle types read as different
      // things even when they land close together.
      for (const [side, pt] of [['src', p.p0], ['dst', p.p1]]) {
        el('circle', { class: 'anchor-dot', cx: pt.x, cy: pt.y, r: 6 }, g);
        el('circle', {
          class: 'anchor-handle', 'data-edge': e.id, 'data-side': side,
          cx: pt.x, cy: pt.y, r: 16,
        }, g);
      }
    }
  }

  gNodes.replaceChildren();
  for (const n of nodes) {
    if (hiddenColors.has(n.color)) continue;
    const g = el('g', { class: 'node' + (n.id === selected ? ' sel' : ''), 'data-id': n.id }, gNodes);
    // Box/text live in an inner group carrying the resize scale as a
    // transform, in the node's own (0,0)-centered local coordinates - so
    // they grow/shrink together with a single number, no per-element
    // recomputation. Everything below that's meant to stay a fixed
    // on-screen size regardless of scale (selection ring, resize buttons)
    // is a sibling of this group instead, positioned in world space via
    // nodeHalf().
    const inner = el('g', { transform: `translate(${n.x},${n.y}) scale(${n.scale || 1})` }, g);
    // rx/ry as a plain attribute, not a CSS rule keyed off data-node-style -
    // Firefox doesn't implement SVG2's CSS-property form of rx/ry, so a
    // stylesheet-only approach left nodes square there no matter the
    // setting. 0 for "square" is exactly the same as omitting it.
    const cornerRadius = nodeStyle === 'rounded' ? 14 : 0;
    el('rect', {
      x: -NW / 2, y: -NH / 2, width: NW, height: NH, rx: cornerRadius, ry: cornerRadius,
      stroke: n.color, style: `filter:drop-shadow(0 0 7px ${n.color}55)`,
    }, inner);
    const nm = el('text', {
      class: 'nm', x: 0, y: n.kind ? -2 : 6,
      'text-anchor': 'middle', fill: n.color,
    }, inner);
    nm.textContent = n.name.length > 20 ? n.name.slice(0, 19) + '\u2026' : n.name;
    if (n.kind) {
      const kd = el('text', { class: 'kd', x: 0, y: 16, 'text-anchor': 'middle', fill: n.color }, inner);
      kd.textContent = n.kind;
    }
    if (!n.pinned) {
      const u = el('text', { class: 'kd', x: NW / 2 - 6, y: -NH / 2 + 13, 'text-anchor': 'end', fill: n.color }, inner);
      u.textContent = '\u25cb';   // hollow marker = auto-placed, not pinned
    }
    const { hw, hh } = nodeHalf(n);
    if (multiSelected.has(n.id)) {
      el('rect', {
        class: 'msel-ring', x: n.x - hw - 5, y: n.y - hh - 5, width: hw * 2 + 10, height: hh * 2 + 10,
      }, g);
    }
    if (n.id === selected) {
      for (const [dir, symbol, cx] of [['dec', '\u2212', n.x - hw + 16], ['inc', '+', n.x + hw - 16]]) {
        const btn = el('circle', { class: 'size-btn', cx, cy: n.y, r: 11 }, g);
        btn.onclick = () => resizeNode(n, dir);
        const label = el('text', {
          class: 'size-btn-label', x: cx, y: n.y, 'text-anchor': 'middle', 'dominant-baseline': 'central',
        }, g);
        label.textContent = symbol;
      }
      const MH = 12;   // move-handle side length, fixed screen size like the resize buttons
      el('rect', {
        class: 'move-handle', 'data-id': n.id,
        x: n.x + hw - MH / 2, y: n.y - hh - MH / 2, width: MH, height: MH,
      }, g);
    }
  }
}

/* ---------- panes ---------- */
function renderSelects() {
  const sorted = [...nodes].sort((a, b) => a.name.localeCompare(b.name));
  for (const id of ['fSrc', 'fDst']) {
    const s = $(id), keep = s.value;
    s.replaceChildren();
    for (const n of sorted) {
      const o = document.createElement('option');
      o.value = n.id; o.textContent = n.name;
      s.appendChild(o);
    }
    if (keep && byId.has(+keep)) s.value = keep;
  }
  if (selected) $('fSrc').value = selected;
}

function renderForm() {
  const n = selected ? byId.get(selected) : null;
  $('formTitle').textContent = n ? `EDIT NODE #${n.id}` : 'ADD NODE';
  $('fName').value = n ? n.name : '';
  $('fKind').value = n ? n.kind : '';
  $('fColor').value = n ? n.color : '#33ff66';
  syncSwatchSelection($('swatches'), $('fColor').value);
  const pct = n ? scaleToPercent(n.scale) : 0;
  $('fScale').value = pct;
  $('fScalePct').value = pct;
  $('fScale').disabled = $('fScalePct').disabled = !n;
  $('fNotes').value = n ? (n.notes || '') : '';
  $('btnSave').textContent = n ? 'update node' : 'save node';
  $('btnDelete').disabled = !n;
}

// Context-sensitive one-liner for the bottom-right hint box - checked in
// priority order (most specific in-progress action first), falling back to
// a generic tip once nothing more specific applies. Called from draw(),
// which already runs after every state change that could affect any of
// these (selection, multi-selection, the annotation tool being armed,
// etc.), so this never needs its own separate set of call sites.
function computeHint() {
  if (annotating) return `Drag a box on the canvas to place the new ${ANNOTATION_KIND_LABELS[annotationKind].toLowerCase()}.`;
  if (multiSelected.size > 1) return `${multiSelected.size} nodes selected - press Ctrl+Shift then drag any one of them to move the whole group.`;
  if (pendingTargets.size > 0) return `${pendingTargets.size} dependency target${pendingTargets.size === 1 ? '' : 's'} queued - click "add dependency", or Alt-click more nodes to add them.`;
  if (selectedEdge) return 'Drag a curve handle to reshape the line, or an anchor dot to move where it touches a node.';
  if (selected) return 'Shift-drag (or drag its move-handle) to move this node - Ctrl+Shift-click another to start a group, Alt-click one to queue it as a dependency target.';
  if (!nodes.length) return 'Add a node in the panel on the right to get started.';
  return 'Click a node to edit it, drag with Ctrl+Alt held to marquee-select several, or Ctrl+Shift-click them one at a time.';
}
function updateHint() {
  $('hintBox').textContent = computeHint();
}

function renderDetails() {
  const box = $('detailList');
  box.replaceChildren();
  $('detailCount').textContent = `${nodes.length} nodes · ${edges.length} dependencies`;
  if (!nodes.length) {
    box.innerHTML = '<div class="empty">No nodes yet. Add one in the right pane.</div>';
    return;
  }
  const sorted = [...nodes].sort((a, b) => a.name.localeCompare(b.name));
  for (const n of sorted) {
    const row = document.createElement('div');
    row.className = 'drow' + (n.id === selected ? ' sel' : '');
    row.innerHTML =
      `<i class="c" style="background:${n.color}"></i>` +
      `<span><b>${esc(n.name)}</b> ${n.notes ? `<span class="k">— ${esc(n.notes)}</span>` : ''}</span>` +
      `<span class="k">${esc(n.kind || '')}</span>` +
      `<span class="k">${n.pinned ? 'pinned' : 'auto'}</span>`;
    row.onclick = () => { select(n.id); centerOn(n); };
    box.appendChild(row);

    if (n.id === selected) {
      const out = edges.filter(e => e.src_id === n.id);
      const inc = edges.filter(e => e.dst_id === n.id);
      const d = document.createElement('div');
      d.className = 'deps';
      if (!out.length && !inc.length) d.textContent = 'no dependencies recorded';
      for (const e of out) d.appendChild(depRow(e, `\u2192 ${byId.get(e.dst_id)?.name}`));
      for (const e of inc) d.appendChild(depRow(e, `\u2190 ${byId.get(e.src_id)?.name}`));
      box.appendChild(d);
    }
  }
}
function depRow(e, text) {
  const r = document.createElement('div');
  const s = document.createElement('span');
  s.innerHTML = `<b>${esc(text)}</b>${e.label ? ' · ' + esc(e.label) : ''}`;
  const b = document.createElement('button');
  b.className = 'danger'; b.textContent = 'x'; b.title = 'remove dependency';
  b.onclick = ev => { ev.stopPropagation(); api('DELETE', `/api/edges/${e.id}`).then(load); };
  r.append(s, b);
  return r;
}
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function renderDepForm() {
  const e = selectedEdge ? edgeById.get(selectedEdge) : null;
  $('depTitle').textContent = e ? `EDIT DEPENDENCY #${e.id}` : 'ADD DEPENDENCY';
  $('fLabel').value = e ? e.label : '';
  $('fEdgeColor').value = e && e.color ? e.color : '#2fd85e';
  syncSwatchSelection($('edgeSwatches'), $('fEdgeColor').value);
  const linePct = e ? scaleToPercent(e.lineScale) : 0, labelPct = e ? scaleToPercentCentered(e.labelScale) : 50;
  $('fLineScale').value = linePct; $('fLineScalePct').value = linePct;
  $('fLabelScale').value = labelPct; $('fLabelScalePct').value = labelPct;
  $('fLineScale').disabled = $('fLineScalePct').disabled = !e;
  $('fLabelScale').disabled = $('fLabelScalePct').disabled = !e;
  $('fBidir').checked = !!(e && e.bidirectional);
  if (e && byId.has(e.src_id)) $('fSrc').value = e.src_id;
  if (e && byId.has(e.dst_id)) $('fDst').value = e.dst_id;
  // Queued targets (chips) are what actually gets used once there are any -
  // grey the dropdown out so it doesn't look like a second, ignored answer.
  $('fDst').disabled = !e && pendingTargets.size > 0;
  $('btnLink').textContent = e
    ? 'update dependency'
    : pendingTargets.size ? `add ${pendingTargets.size} dependenc${pendingTargets.size === 1 ? 'y' : 'ies'}` : 'add dependency';
  $('btnUnlink').disabled = !e;
  renderPendingTargets();
}
function renderPendingTargets() {
  const box = $('pendingTargets');
  box.replaceChildren();
  for (const id of pendingTargets) {
    const n = byId.get(id);
    if (!n) continue;
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.append(n.name);
    const b = document.createElement('button');
    b.textContent = '×'; b.title = `remove "${n.name}" from pending targets`;
    b.onclick = () => { pendingTargets.delete(id); renderDepForm(); };
    chip.appendChild(b);
    box.appendChild(chip);
  }
}

function select(id) {
  selected = id;
  selectedEdge = null;
  renderForm(); renderSelects(); renderDepForm(); renderDetails(); draw();
}
function selectEdge(id) {
  selectedEdge = id;
  selected = null;
  pendingTargets.clear();   // editing one specific edge, or starting fresh - either way the queue doesn't apply
  renderForm(); renderSelects(); renderDepForm(); renderDetails(); draw();
}
function centerOn(n) {
  const r = svg.getBoundingClientRect();
  view.x = n.x - r.width / view.k / 2;
  view.y = n.y - r.height / view.k / 2;
  applyView();
}
// Where a freshly-created node should land: inside the currently visible
// viewport (not wherever the color-ring auto-place algorithm put it, which
// is laid out for the whole graph and often lands off-screen). Tries the
// view center first, then rings outward in view-relative steps looking for
// a spot clear of every existing node, same MIN spacing autoPlace() uses -
// falling back to dead-center if the visible area is too packed to find one.
function placeInView() {
  const r = svg.getBoundingClientRect();
  const vw = r.width / view.k, vh = r.height / view.k;
  const x0 = view.x, y0 = view.y, x1 = x0 + vw, y1 = y0 + vh;
  const marginX = NW / 2 + 20, marginY = NH / 2 + 20;
  const minX = x0 + marginX, maxX = Math.max(minX, x1 - marginX);
  const minY = y0 + marginY, maxY = Math.max(minY, y1 - marginY);
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const NODE_MIN = 240;
  const clear = (x, y) => nodes.every(n => Math.hypot(n.x - x, n.y - y) >= NODE_MIN);
  if (clear(cx, cy)) return { x: Math.round(cx), y: Math.round(cy) };
  const stepX = Math.max(60, (maxX - minX) / 8), stepY = Math.max(60, (maxY - minY) / 8);
  for (let ring = 1; ring < 8; ring++) {
    for (let dy = -ring; dy <= ring; dy++) {
      for (let dx = -ring; dx <= ring; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;   // ring border only
        const x = cx + dx * stepX, y = cy + dy * stepY;
        if (x < minX || x > maxX || y < minY || y > maxY) continue;
        if (clear(x, y)) return { x: Math.round(x), y: Math.round(y) };
      }
    }
  }
  return { x: Math.round(cx), y: Math.round(cy) };
}

/* ---------- node resize + collision avoidance ---------- */
const SCALE_MIN = 0.5, SCALE_MAX = 3, SCALE_STEP = 0.15;
// Text Box's font-size slider gets its own, much higher ceiling - a
// dedicated constant/pair of helpers rather than raising the shared
// SCALE_MAX above, which would also blow out node size and edge line/
// label scale limits that weren't asked to change.
const FONT_SCALE_MIN = 1, FONT_SCALE_MAX = 20;
function fontScaleToPercent(scale) {
  return Math.round(Math.max(0, Math.min(100, ((scale || 1) - FONT_SCALE_MIN) / (FONT_SCALE_MAX - FONT_SCALE_MIN) * 100)));
}
function percentToFontScale(pct) {
  return FONT_SCALE_MIN + (pct / 100) * (FONT_SCALE_MAX - FONT_SCALE_MIN);
}
// Iterative pairwise AABB separation: after a node's box changes, run
// several passes over every pair looking for overlap and pushing the pair
// apart along whichever axis has the smaller overlap (the usual
// "least displacement" heuristic). Not a real physics sim - just enough to
// settle a crowded neighborhood in a handful of passes. The node that was
// actually resized (anchorId) never moves; a colliding pair that's both
// bystanders splits the separation between them, so a chain reaction (the
// pushed node now overlapping a third) has a chance to settle too instead
// of just shoving the nearest neighbor into someone else.
const COLLISION_MARGIN = 12;
function resolveCollisions(anchorId) {
  const moved = new Set();
  for (let pass = 0; pass < 12; pass++) {
    let any = false;
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j];
        const ab = nodeHalf(a), bb = nodeHalf(b);
        let dx = b.x - a.x, dy = b.y - a.y;
        if (!dx && !dy) dx = 1;   // exact overlap - break the tie deterministically
        const ox = ab.hw + bb.hw + COLLISION_MARGIN - Math.abs(dx);
        const oy = ab.hh + bb.hh + COLLISION_MARGIN - Math.abs(dy);
        if (ox <= 0 || oy <= 0) continue;   // clear on at least one axis - boxes don't actually overlap
        any = true;
        const alongX = ox < oy;
        const push = alongX ? ox : oy;
        const sign = alongX ? Math.sign(dx) : Math.sign(dy);
        const aShare = b.id === anchorId ? 1 : a.id === anchorId ? 0 : 0.5;
        const bShare = a.id === anchorId ? 1 : b.id === anchorId ? 0 : 0.5;
        if (alongX) { a.x -= push * sign * aShare; b.x += push * sign * bShare; }
        else { a.y -= push * sign * aShare; b.y += push * sign * bShare; }
        if (aShare) moved.add(a.id);
        if (bShare) moved.add(b.id);
      }
    }
    if (!any) break;
  }
  for (const id of moved) {
    const n = byId.get(id);
    n.x = Math.round(n.x); n.y = Math.round(n.y);
    n.pinned = 1;
  }
  return [...moved].map(id => byId.get(id));
}
// Shared by the canvas +/- buttons and the sidebar size slider/field -
// clamps to the allowed range, applies it, runs the same collision
// avoidance as a drag, and persists the node plus anything it displaced.
async function applyNodeScale(node, raw) {
  const cur = node.scale || 1;
  const next = Math.round(Math.max(SCALE_MIN, Math.min(SCALE_MAX, raw)) * 100) / 100;
  if (next === cur) return;
  node.scale = next;
  const displaced = resolveCollisions(node.id);
  draw();
  try {
    await api('PUT', `/api/nodes/${node.id}/scale`, { scale: next });
    for (const m of displaced) await api('PUT', `/api/nodes/${m.id}/position`, { x: m.x, y: m.y });
    if (displaced.length) renderDetails();
  } catch (e) { say(e.message); }
}
function resizeNode(node, dir) {
  const cur = node.scale || 1;
  return applyNodeScale(node, cur + (dir === 'inc' ? SCALE_STEP : -SCALE_STEP));
}
// 0-100% maps onto the growth range only (default size 1x -> 0%, SCALE_MAX
// -> 100%) - matches what the sidebar slider shows, not the +/- buttons'
// separate ability to shrink below default down to SCALE_MIN.
function scaleToPercent(scale) {
  return Math.round(Math.max(0, Math.min(100, ((scale || 1) - 1) / (SCALE_MAX - 1) * 100)));
}
function percentToScale(pct) {
  return 1 + (pct / 100) * (SCALE_MAX - 1);
}
// Label scale uses a centered mapping instead: 50% is the label's actual
// default/natural size (1x, i.e. "100%" scale), with 0-50% shrinking down
// to SCALE_MIN and 50-100% growing up to SCALE_MAX - so the default sits
// at the middle of the bar rather than at its left edge.
function scaleToPercentCentered(scale) {
  const s = scale || 1;
  const pct = s <= 1
    ? (s - SCALE_MIN) / (1 - SCALE_MIN) * 50
    : 50 + (s - 1) / (SCALE_MAX - 1) * 50;
  return Math.round(Math.max(0, Math.min(100, pct)));
}
function percentToScaleCentered(pct) {
  return pct <= 50
    ? SCALE_MIN + (pct / 50) * (1 - SCALE_MIN)
    : 1 + ((pct - 50) / 50) * (SCALE_MAX - 1);
}
// Edge line/label scale - same clamp-and-persist shape as applyNodeScale,
// but with no collision avoidance to run (edges don't occupy their own
// space the way nodes do) and two independent values instead of one.
async function applyEdgeScale(edge, { lineScale, labelScale } = {}) {
  const nextLine = lineScale != null
    ? Math.round(Math.max(SCALE_MIN, Math.min(SCALE_MAX, lineScale)) * 100) / 100 : edge.lineScale || 1;
  const nextLabel = labelScale != null
    ? Math.round(Math.max(SCALE_MIN, Math.min(SCALE_MAX, labelScale)) * 100) / 100 : edge.labelScale || 1;
  if (nextLine === (edge.lineScale || 1) && nextLabel === (edge.labelScale || 1)) return;
  edge.lineScale = nextLine;
  edge.labelScale = nextLabel;
  draw();
  try { await api('PUT', `/api/edges/${edge.id}/scale`, { lineScale: nextLine, labelScale: nextLabel }); }
  catch (e) { say(e.message); }
}

/* ---------- local store (fork of depmap with no server-side DB) ---------- */
// Everything below stands in for the original MySQL-backed server.js -
// same shape of data, same routes-as-strings dispatched through api(), but
// persisted to this browser's localStorage instead of a database over the
// network. Nothing above this point (draw(), event handlers, CSV import/
// export) had to change: they all go through api()/load() exactly as
// before, unaware whether the other end is a fetch or an in-page store.
const STORE_KEY = 'ephdepmap-data';
function loadStore() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* corrupt or inaccessible storage - start fresh */ }
  return { seq: { node: 1, edge: 1, anno: 1 }, nodes: [], edges: [], annotations: [] };
}
let store = loadStore();
function persistStore() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); }
  catch { throw new Error('Could not save - browser storage is full or unavailable.'); }
}

// --- auto placement -------------------------------------------------------
// Ported verbatim from the original server.js: new nodes are grouped by
// color into their own grid block, skipping anything too close to an
// existing node. See that file's history for the reasoning behind the
// evenly-spaced-anchor-per-color approach.
const PLACE_MIN = 240, PLACE_ROWS = 20;
function colorAnchor(index, total) {
  if (total <= 1) return { x: 0, y: 0 };
  const reach = PLACE_ROWS * PLACE_MIN + PLACE_MIN;
  const r = reach / (2 * Math.sin(Math.PI / total));
  const a = index * (2 * Math.PI / total);
  return { x: Math.round(Math.cos(a) * r), y: Math.round(Math.sin(a) * r) };
}
function autoPlace(existing, anchor) {
  for (let i = 0; i < 4000; i++) {
    const row = i % PLACE_ROWS, col = Math.floor(i / PLACE_ROWS);
    const p = { x: anchor.x + col * PLACE_MIN, y: anchor.y + row * PLACE_MIN };
    if (existing.every(n => Math.hypot(n.x - p.x, n.y - p.y) >= PLACE_MIN)) return p;
  }
  return anchor;
}

// CSV-import-only layout: a Vogel/sunflower ("fibonacci") spiral - golden-
// angle divergence per point, radius growing with sqrt(index) - centered
// on the world origin like colorAnchor above. Items are sorted by color
// first, so same-colored nodes land in contiguous wedges along the spiral
// instead of scattered in CSV row order. FIB_SPACING is its own constant,
// tighter than PLACE_MIN (the grid-anchor scheme's minimum node-center
// spacing) on purpose - a few close/overlapping pairs, mostly right near
// the center, are expected and left for the resolveCollisions pass after
// placing (see the import handler) to nudge apart, in exchange for a
// visibly tighter spiral everywhere else.
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));   // ~137.5°, in radians
const FIB_SPACING = 130;
function fibonacciSpiralPositions(items) {
  const sorted = [...items].sort((a, b) => (a.color || '').localeCompare(b.color || ''));
  return sorted.map((item, i) => {
    const angle = i * GOLDEN_ANGLE;
    const radius = FIB_SPACING * Math.sqrt(i + 0.5);
    return { ...item, x: Math.round(Math.cos(angle) * radius), y: Math.round(Math.sin(angle) * radius) };
  });
}

// CSV-import-only layout ("blocks" mode): one single grid block for the
// whole batch, filled column-by-column with the same row/col formula
// autoPlace uses - but walked once across the whole (color-sorted) list
// instead of restarting at a fresh, far-apart colorAnchor for every
// distinct color. Same-colored nodes land in contiguous columns right next
// to each other instead of each color's block sitting off on its own
// point around a big circle.
// Row (north-south) spacing is its own constant, much tighter than
// PLACE_MIN/the column spacing - PLACE_MIN (240) leaves ~180 units of dead
// air between node boxes (NH is only 62), which read as far more spread
// out vertically than the block was meant to look. Column spacing stays at
// PLACE_MIN untouched.
const BLOCK_ROW_SPACING = NH + 12;
function blockGridPositions(items) {
  const sorted = [...items].sort((a, b) => (a.color || '').localeCompare(b.color || ''));
  return sorted.map((item, i) => {
    const row = i % PLACE_ROWS, col = Math.floor(i / PLACE_ROWS);
    return { ...item, x: col * PLACE_MIN, y: row * BLOCK_ROW_SPACING };
  });
}

function findNode(id) {
  const n = store.nodes.find(n => n.id === id);
  if (!n) throw new Error(`node ${id} not found`);
  return n;
}
function findEdge(id) {
  const e = store.edges.find(e => e.id === id);
  if (!e) throw new Error(`edge ${id} not found`);
  return e;
}

function createNode(body) {
  const { name, kind = '', color = '#33ff66', notes = '' } = body || {};
  if (!name || !name.trim()) throw new Error('name is required');
  const trimmed = name.trim();
  if (store.nodes.some(n => n.name === trimmed)) {
    throw new Error(`Duplicate entry '${trimmed}' for key 'nodes.uq_nodes_name'`);
  }
  const colors = [...new Set(store.nodes.map(n => n.color))];
  if (!colors.includes(color)) colors.push(color);
  colors.sort();
  const anchor = colorAnchor(colors.indexOf(color), colors.length);
  const p = autoPlace(store.nodes, anchor);
  const node = { id: store.seq.node++, name: trimmed, kind, color, notes, x: p.x, y: p.y, pinned: 0, scale: 1 };
  store.nodes.push(node);
  return { ...node };
}
function updateNode(id, body) {
  const node = findNode(id);
  const { name, kind = '', color = '#33ff66', notes = '' } = body || {};
  if (!name || !name.trim()) throw new Error('name is required');
  const trimmed = name.trim();
  if (store.nodes.some(n => n.id !== id && n.name === trimmed)) {
    throw new Error(`Duplicate entry '${trimmed}' for key 'nodes.uq_nodes_name'`);
  }
  Object.assign(node, { name: trimmed, kind, color, notes });
  return { ...node };
}
function updateNodePosition(id, body) {
  const node = findNode(id);
  node.x = Math.round(body.x); node.y = Math.round(body.y); node.pinned = 1;
  return { ok: true };
}
function updateNodeScale(id, body) {
  const node = findNode(id);
  const scale = Number(body.scale);
  if (!Number.isFinite(scale)) throw new Error('scale must be a number');
  node.scale = Math.max(SCALE_MIN, Math.min(SCALE_MAX, scale));
  return { ok: true };
}
function deleteNode(id) {
  // Same cascade as the FK in the original schema: an edge disappears if
  // either end of it was the deleted node.
  store.nodes = store.nodes.filter(n => n.id !== id);
  store.edges = store.edges.filter(e => e.src_id !== id && e.dst_id !== id);
  return { ok: true };
}

function createEdge(body) {
  const { src_id, dst_id, label = '', color = null, bidirectional = 0 } = body || {};
  if (!src_id || !dst_id) throw new Error('source and target are required');
  if (Number(src_id) === Number(dst_id)) throw new Error('a node cannot depend on itself');
  if (store.edges.some(e => e.src_id === Number(src_id) && e.dst_id === Number(dst_id) && e.label === label)) {
    throw new Error(`Duplicate entry for key 'uq_edge'`);
  }
  const edge = {
    id: store.seq.edge++, src_id: Number(src_id), dst_id: Number(dst_id), label, color: color || null,
    bidirectional: bidirectional ? 1 : 0,
    c1x: null, c1y: null, c2x: null, c2y: null,
    src_ox: null, src_oy: null, dst_ox: null, dst_oy: null,
    lineScale: 1, labelScale: 1,
  };
  store.edges.push(edge);
  return { ...edge };
}
// Mirrors the original PUT /api/edges/:id, which (deliberately or not) only
// ever wrote label/color/bidirectional server-side too - src/dst on an
// existing edge were never actually re-pointed by this route.
function updateEdge(id, body) {
  const edge = findEdge(id);
  const { label = '', color = null, bidirectional = 0 } = body || {};
  Object.assign(edge, { label, color: color || null, bidirectional: bidirectional ? 1 : 0 });
  return { ...edge };
}
function updateEdgeCurve(id, body) {
  const edge = findEdge(id);
  edge.c1x = Math.round(body.c1x); edge.c1y = Math.round(body.c1y);
  edge.c2x = Math.round(body.c2x); edge.c2y = Math.round(body.c2y);
  return { ok: true };
}
function updateEdgeAnchor(id, body) {
  const edge = findEdge(id);
  const { side, ox, oy } = body;
  if (side !== 'src' && side !== 'dst') throw new Error('side must be "src" or "dst"');
  edge[side + '_ox'] = Math.round(ox); edge[side + '_oy'] = Math.round(oy);
  return { ok: true };
}
function updateEdgeScale(id, body) {
  const edge = findEdge(id);
  const lineScale = Number(body.lineScale), labelScale = Number(body.labelScale);
  if (Number.isFinite(lineScale)) edge.lineScale = Math.max(SCALE_MIN, Math.min(SCALE_MAX, lineScale));
  if (Number.isFinite(labelScale)) edge.labelScale = Math.max(SCALE_MIN, Math.min(SCALE_MAX, labelScale));
  return { ok: true };
}
function deleteEdge(id) {
  store.edges = store.edges.filter(e => e.id !== id);
  return { ok: true };
}

function createAnnotation(body) {
  const { x, y, width, height, color = '#ffd23f', note = '', kind: rawKind = 'label', arrowHeads, startCorner, fontScale } = body || {};
  const kind = ANNOTATION_KINDS.includes(rawKind) ? rawKind : 'label';
  const anno = {
    id: store.seq.anno++, x: Math.round(x), y: Math.round(y),
    width: Math.round(width), height: Math.round(height), color,
    note: ANNOTATION_KINDS_NO_NOTE.has(kind) ? '' : note,   // Circle/Database/Server have no note field - never persist stray text for one
    kind,
    arrowHeads: ARROW_HEAD_CYCLE.includes(arrowHeads) ? arrowHeads : 'end',   // unused/harmless for every kind but Arrow
    startCorner: START_CORNERS.includes(startCorner) ? startCorner : 'lt',   // ditto - which corner the drag started from
    fontScale: Number.isFinite(fontScale) ? Math.max(FONT_SCALE_MIN, Math.min(FONT_SCALE_MAX, fontScale)) : 1,   // ditto - only meaningful for Text Box
  };
  store.annotations.push(anno);
  return { ...anno };
}
function updateAnnotationRecord(id, body) {
  const anno = store.annotations.find(a => a.id === id);
  if (!anno) throw new Error(`annotation ${id} not found`);
  const { color, note, arrowHeads, fontScale } = body || {};
  if (ARROW_HEAD_CYCLE.includes(arrowHeads)) anno.arrowHeads = arrowHeads;
  if (Number.isFinite(fontScale)) anno.fontScale = Math.max(FONT_SCALE_MIN, Math.min(FONT_SCALE_MAX, fontScale));
  if (color != null) anno.color = color;
  if (note != null) anno.note = note;
  return { ...anno };
}
function updateAnnotationPosition(id, body) {
  const anno = store.annotations.find(a => a.id === id);
  if (!anno) throw new Error(`annotation ${id} not found`);
  anno.x = Math.round(body.x); anno.y = Math.round(body.y);
  return { ok: true };
}
function deleteAnnotationRecord(id) {
  store.annotations = store.annotations.filter(a => a.id !== id);
  return { ok: true };
}

// One row per original server.js route, matched the same way Express
// would (method + path pattern) so every existing api('METHOD', url, body)
// call site above needed zero changes.
const ROUTES = [
  ['GET', /^\/api\/graph$/, () => ({
    nodes: store.nodes.map(n => ({ ...n })),
    edges: store.edges.map(e => ({ ...e })),
    annotations: store.annotations.map(a => ({ ...a })),
  })],
  ['DELETE', /^\/api\/nodes$/, () => { store.nodes = []; store.edges = []; store.annotations = []; return { ok: true }; }],
  ['POST', /^\/api\/nodes$/, (_m, body) => createNode(body)],
  ['PUT', /^\/api\/nodes\/(\d+)$/, (m, body) => updateNode(+m[1], body)],
  ['PUT', /^\/api\/nodes\/(\d+)\/position$/, (m, body) => updateNodePosition(+m[1], body)],
  ['PUT', /^\/api\/nodes\/(\d+)\/scale$/, (m, body) => updateNodeScale(+m[1], body)],
  ['DELETE', /^\/api\/nodes\/(\d+)$/, (m) => deleteNode(+m[1])],
  ['POST', /^\/api\/edges$/, (_m, body) => createEdge(body)],
  ['PUT', /^\/api\/edges\/(\d+)$/, (m, body) => updateEdge(+m[1], body)],
  ['PUT', /^\/api\/edges\/(\d+)\/curve$/, (m, body) => updateEdgeCurve(+m[1], body)],
  ['PUT', /^\/api\/edges\/(\d+)\/scale$/, (m, body) => updateEdgeScale(+m[1], body)],
  ['PUT', /^\/api\/edges\/(\d+)\/anchor$/, (m, body) => updateEdgeAnchor(+m[1], body)],
  ['DELETE', /^\/api\/edges\/(\d+)$/, (m) => deleteEdge(+m[1])],
  ['POST', /^\/api\/annotations$/, (_m, body) => createAnnotation(body)],
  ['PUT', /^\/api\/annotations\/(\d+)$/, (m, body) => updateAnnotationRecord(+m[1], body)],
  ['PUT', /^\/api\/annotations\/(\d+)\/position$/, (m, body) => updateAnnotationPosition(+m[1], body)],
  ['DELETE', /^\/api\/annotations\/(\d+)$/, (m) => deleteAnnotationRecord(+m[1])],
];

/* ---------- api ---------- */
// Same signature/contract the rest of this file already expects
// (async, throws Error on failure, resolves to the created/updated
// record or { ok: true }) - only the transport changed, from a fetch
// to a synchronous local dispatch against `store`.
async function api(method, url, body) {
  for (const [m, re, handler] of ROUTES) {
    if (m !== method) continue;
    const match = re.exec(url);
    if (match) {
      const result = handler(match, body);
      persistStore();
      return result;
    }
  }
  throw new Error(`${method} ${url} failed`);
}
function say(text, ok) {
  const m = $('msg');
  m.textContent = text;
  m.className = 'msg' + (ok ? ' ok' : '');
  clearTimeout(say.t);
  say.t = setTimeout(() => { m.textContent = ''; }, 4000);
}

async function load() {
  const g = await api('GET', '/api/graph');
  nodes = g.nodes; edges = g.edges; annotations = g.annotations || [];
  byId = new Map(nodes.map(n => [n.id, n]));
  edgeById = new Map(edges.map(e => [e.id, e]));
  annoById = new Map(annotations.map(a => [a.id, a]));
  if (selected && !byId.has(selected)) selected = null;
  if (selectedEdge && !edgeById.has(selectedEdge)) selectedEdge = null;
  for (const id of multiSelected) if (!byId.has(id)) multiSelected.delete(id);
  for (const id of pendingTargets) if (!byId.has(id)) pendingTargets.delete(id);
  renderSelects(); renderForm(); renderDepForm(); renderDetails(); draw();
}

/* ---------- theme ---------- */
const THEME_ORDER = ['', 'corporate', 'light', 'plotter', 'tangerine-light', 'tangerine-dark'];
const THEME_LABELS = { '': 'retro', corporate: 'forest', light: 'light', plotter: 'plotter', 'tangerine-light': 'tangerine light', 'tangerine-dark': 'tangerine dark' };
const themeSelect = $('themeSelect');
for (const t of THEME_ORDER) {
  const o = document.createElement('option');
  o.value = t;
  o.textContent = THEME_LABELS[t];
  themeSelect.appendChild(o);
}
// Same action-menu pattern as the project/annotations dropdowns - the
// select's face always shows the static "Theme" placeholder rather than
// the current theme's name, snapping back to it after every pick (retro's
// real value is '', so the placeholder needs its own non-colliding
// sentinel instead of reusing '' the way those other two dropdowns do).
themeSelect.onchange = () => {
  const next = themeSelect.value;
  document.documentElement.dataset.theme = next;
  localStorage.setItem('depmap-theme', next);
  themeSelect.value = '__theme__';
};

/* ---------- node style ---------- */
// Same action-menu pattern as themeSelect right above. rx/ry is set as a
// plain attribute on each node rect in draw() (below), not as a CSS
// property - CSS-level rx/ry is SVG2, and Firefox doesn't implement it, so
// a node stayed square-only there regardless of this setting. Attributes
// work everywhere, and since export (viewportClone) clones the live DOM
// as-is, the exported file gets the correct corners for free too, with no
// separate export-side handling needed.
let nodeStyle = localStorage.getItem('depmap-node-style') || 'square';
const nodeStyleSelect = $('nodeStyleSelect');
nodeStyleSelect.onchange = () => {
  nodeStyle = nodeStyleSelect.value;
  document.documentElement.dataset.nodeStyle = nodeStyle;
  localStorage.setItem('depmap-node-style', nodeStyle);
  nodeStyleSelect.value = '__nodestyle__';
  draw();
};

$('btnControls').onclick = () => window.open('controls.html', '_blank', 'noopener');

// Grid dots are a visual aid only - toggling them off doesn't turn off the
// snap itself (see GRID/snapToGrid above), same as a design tool's "show
// grid" not being the same setting as "snap to grid".
const btnGridToggle = $('btnGridToggle');
let gridVisible = localStorage.getItem('depmap-grid') !== 'off';
function applyGridVisible() {
  gGrid.style.display = gridVisible ? '' : 'none';
  btnGridToggle.setAttribute('aria-pressed', String(gridVisible));
}
btnGridToggle.onclick = () => {
  gridVisible = !gridVisible;
  localStorage.setItem('depmap-grid', gridVisible ? 'on' : 'off');
  applyGridVisible();
};
applyGridVisible();

// Off: hides the native color <input> beside every swatch row (via the
// [data-extended-colors="off"] rule in style.css), leaving only the 8
// PALETTE swatches pickable - purely a picker restriction, doesn't touch
// any color already set on a node/edge/annotation.
const btnExtendedColorsToggle = $('btnExtendedColorsToggle');
let extendedColors = localStorage.getItem('depmap-extended-colors') !== 'off';
function applyExtendedColors() {
  document.documentElement.dataset.extendedColors = extendedColors ? 'on' : 'off';
  btnExtendedColorsToggle.setAttribute('aria-pressed', String(extendedColors));
}
btnExtendedColorsToggle.onclick = () => {
  extendedColors = !extendedColors;
  localStorage.setItem('depmap-extended-colors', extendedColors ? 'on' : 'off');
  applyExtendedColors();
};
applyExtendedColors();

/* ---------- annotations ---------- */
// Action-menu dropdown like projectSelect, not a persistent setting -
// picking either option arms the tool with that kind and snaps the select
// back to its placeholder so picking the same kind twice in a row still
// fires. The actual draw/save flow (pointerdown..pointerup below,
// askAnnotation()) is unchanged - it just tags the result with whichever
// kind was armed.
$('annoTypeSelect').onchange = () => {
  annotationKind = $('annoTypeSelect').value;
  $('annoTypeSelect').value = '';
  annotating = true;
  svg.classList.add('annotating');
  updateHint();
};

/* ---------- hide colors ---------- */
// Not a native <select> - it needs to stay open across multiple checkbox
// toggles rather than closing on the first pick, so it's a plain
// positioned panel instead, opened/closed by hand.
{
  const toggle = $('hideColorsToggle'), panel = $('hideColorsPanel');
  const closePanel = () => { panel.hidden = true; toggle.setAttribute('aria-expanded', 'false'); };
  for (const c of PALETTE) {
    const row = document.createElement('label');
    row.className = 'color-hide-row';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.onchange = () => {
      if (cb.checked) hiddenColors.add(c); else hiddenColors.delete(c);
      toggle.textContent = hiddenColors.size ? `hide colors (${hiddenColors.size})` : 'hide colors';
      draw();
    };
    const swatch = document.createElement('i');
    swatch.style.background = c;
    const label = document.createElement('span');
    label.textContent = c;
    row.append(cb, swatch, label);
    panel.appendChild(row);
  }
  toggle.onclick = () => {
    const willOpen = panel.hidden;
    panel.hidden = !willOpen;
    toggle.setAttribute('aria-expanded', String(willOpen));
  };
  document.addEventListener('pointerdown', e => {
    if (!panel.hidden && !e.target.closest('#hideColorsDropdown')) closePanel();
  });
}
// Returns whether the annotation was actually deleted (false on a
// declined confirm() or a failed request) - the edit dialog's delete
// button uses that to decide whether it's safe to close itself.
async function deleteAnnotation(id) {
  if (!confirm('Delete this annotation?')) return false;
  try { await api('DELETE', `/api/annotations/${id}`); await load(); return true; }
  catch (e) { say(e.message); return false; }
}
// Click-to-edit for an existing annotation (both kinds) - opens the same
// dialog drawing a new one uses, pre-filled, with its delete button shown.
// A null result covers both "cancelled" and "deleted via the dialog" -
// either way there's nothing left to save here.
async function editAnnotation(a) {
  const originalArrowHeads = a.arrowHeads, originalFontScale = a.fontScale;
  // Arrowhead/font-size changes preview live on the actual canvas element
  // while the dialog's open (mutate the real annotation + redraw, not a
  // copy) - so cancelling has to put those mutations back the way they
  // were, same as never having touched them.
  const result = await askAnnotation({
    defaultColor: a.color, defaultNote: a.note, kind: a.kind, editId: a.id,
    defaultArrowHeads: a.arrowHeads,
    onArrowHeadsPreview: heads => { a.arrowHeads = heads; draw(); },
    defaultFontScale: a.fontScale,
    onFontScalePreview: scale => { a.fontScale = scale; draw(); },
  });
  if (!result) {
    a.arrowHeads = originalArrowHeads;
    a.fontScale = originalFontScale;
    draw();
    return;
  }
  try {
    await api('PUT', `/api/annotations/${a.id}`, {
      color: result.color, note: result.note.trim(), arrowHeads: result.arrowHeads, fontScale: result.fontScale,
    });
    await load();
    say('Annotation updated.', true);
  } catch (e) { say(e.message); }
}

/* ---------- wiring ---------- */
$('btnNew').onclick = () => select(null);
$('btnNewDep').onclick = () => selectEdge(null);

$('btnSave').onclick = async () => {
  const body = {
    name: $('fName').value,
    kind: $('fKind').value,
    color: $('fColor').value,
    notes: $('fNotes').value,
  };
  try {
    if (selected) { await api('PUT', `/api/nodes/${selected}`, body); say('Node updated.', true); }
    else {
      const n = await api('POST', '/api/nodes', body);
      const p = placeInView();
      await api('PUT', `/api/nodes/${n.id}/position`, p);
      selected = n.id;
      say('Node added in the current view — shift+drag to reposition.', true);
    }
    await load();
  } catch (e) { say(e.message); }
};

$('btnDelete').onclick = async () => {
  if (!selected) return;
  const n = byId.get(selected);
  if (!confirm(`Delete "${n.name}" and its dependencies?`)) return;
  try { await api('DELETE', `/api/nodes/${selected}`); selected = null; await load(); say('Node deleted.', true); }
  catch (e) { say(e.message); }
};

// Slider is live (fires on every drag tick, like a canvas drag); the
// number field only commits on blur/Enter ('change'), so clamping mid-
// typing doesn't fight the cursor while entering a multi-digit value.
$('fScale').oninput = () => {
  if (!selected) return;
  const pct = +$('fScale').value;
  $('fScalePct').value = pct;
  applyNodeScale(byId.get(selected), percentToScale(pct));
};
$('fScalePct').onchange = () => {
  if (!selected) return;
  const pct = Math.max(0, Math.min(100, Math.round(Number($('fScalePct').value) || 0)));
  $('fScalePct').value = pct;
  $('fScale').value = pct;
  applyNodeScale(byId.get(selected), percentToScale(pct));
};

// Same live-slider/commit-on-blur split as the node size control above,
// just parameterized over which of the two edge scale fields it's driving
// (and, for label scale, a different percent<->scale mapping - see
// percentToScaleCentered above).
function wireEdgeScaleSlider(rangeId, numId, key, toScale = percentToScale) {
  const range = $(rangeId), num = $(numId);
  range.oninput = () => {
    if (!selectedEdge) return;
    const pct = +range.value;
    num.value = pct;
    applyEdgeScale(edgeById.get(selectedEdge), { [key]: toScale(pct) });
  };
  num.onchange = () => {
    if (!selectedEdge) return;
    const pct = Math.max(0, Math.min(100, Math.round(Number(num.value) || 0)));
    num.value = pct;
    range.value = pct;
    applyEdgeScale(edgeById.get(selectedEdge), { [key]: toScale(pct) });
  };
}
wireEdgeScaleSlider('fLineScale', 'fLineScalePct', 'lineScale');
wireEdgeScaleSlider('fLabelScale', 'fLabelScalePct', 'labelScale', percentToScaleCentered);

$('btnLink').onclick = async () => {
  const base = {
    src_id: +$('fSrc').value, label: $('fLabel').value,
    color: $('fEdgeColor').value, bidirectional: $('fBidir').checked ? 1 : 0,
  };
  try {
    if (selectedEdge) {
      await api('PUT', `/api/edges/${selectedEdge}`, { ...base, dst_id: +$('fDst').value });
      say('Dependency updated.', true);
    } else if (pendingTargets.size) {
      // One src -> every alt+click'd target, all sharing whatever's
      // currently in label/color/bidirectional - same one-shot tradeoff as
      // a CSV import row, no per-edge review.
      let added = 0, skipped = 0;
      for (const dst_id of pendingTargets) {
        try { await api('POST', '/api/edges', { ...base, dst_id }); added++; }
        catch { skipped++; }
      }
      pendingTargets.clear();
      say(`Added ${added} dependenc${added === 1 ? 'y' : 'ies'}${skipped ? `, skipped ${skipped}` : ''}.`, added > 0);
    } else {
      await api('POST', '/api/edges', { ...base, dst_id: +$('fDst').value });
      say('Dependency added.', true);
    }
    await load();
  } catch (e) { say(e.message.includes('Duplicate') ? 'That dependency already exists.' : e.message); }
};

$('btnUnlink').onclick = async () => {
  if (!selectedEdge) return;
  try {
    await api('DELETE', `/api/edges/${selectedEdge}`);
    selectedEdge = null;
    await load();
    say('Dependency deleted.', true);
  } catch (e) { say(e.message); }
};

// Arrow keys nudge the selected node by one grid step - same GRID constant
// (and the same collision/persist/pinned handling) a mouse drag uses, so a
// keyboard-nudged node lands exactly where a dragged one snapping to the
// same spot would.
const ARROW_DELTA = { ArrowUp: [0, -GRID], ArrowDown: [0, GRID], ArrowLeft: [-GRID, 0], ArrowRight: [GRID, 0] };

// Delete/Backspace deletes whatever's selected - a node (via the same
// confirm()-guarded handler as the sidebar's "delete" button) or an edge
// (no confirm, same as its button). Both this and the arrow-key nudge above
// are skipped while focus is in a text field, so neither hijacks normal
// editing (deleting a character in the notes textarea, moving the caret in
// a field with the arrow keys, etc).
document.addEventListener('keydown', async e => {
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (selected) { e.preventDefault(); $('btnDelete').click(); }
    else if (selectedEdge) { e.preventDefault(); $('btnUnlink').click(); }
    return;
  }
  if (selected && ARROW_DELTA[e.key]) {
    e.preventDefault();
    const node = byId.get(selected);
    if (!node) return;
    const [dx, dy] = ARROW_DELTA[e.key];
    node.x += dx; node.y += dy;
    node.pinned = 1;
    const displaced = resolveCollisions(node.id);
    draw();
    try {
      await api('PUT', `/api/nodes/${node.id}/position`, { x: node.x, y: node.y });
      for (const n of displaced) await api('PUT', `/api/nodes/${n.id}/position`, { x: n.x, y: n.y });
      renderDetails();
    } catch (err) { say(err.message); }
  }
});

// Marks whichever swatch (if any) matches a color input's current value
// with an X - called after every value change, whether that's a swatch
// click, the native picker (extended colors on), or a form re-populating
// the input programmatically for a newly-selected node/edge/annotation.
function syncSwatchSelection(container, value) {
  for (const i of container.children) i.classList.toggle('selected', i.title === value);
}
function addSwatches(container, target) {
  const input = $(target);
  for (const c of PALETTE) {
    const i = document.createElement('i');
    i.style.background = c;
    i.title = c;
    // Each swatch row lives in the same <label> as its <input type=color> -
    // a plain click on any descendant of a <label> also forwards a
    // synthetic click to that label's associated control by default, which
    // pops the native color picker open. Normally anchored near the
    // (visible) input so it went unnoticed; with extended-colors off that
    // input is display:none, so the browser has nothing to anchor to and
    // the picker flies to the top-left instead - and stealing focus there
    // is also why the form's own save button needed a second click right
    // after. preventDefault on the swatch's own click cancels that
    // forwarded activation before it happens, in both states.
    i.onclick = e => { e.preventDefault(); input.value = c; syncSwatchSelection(container, c); };
    container.appendChild(i);
  }
  // Setting .value from JS (renderForm/renderDepForm/askAnnotation) never
  // fires input/change, so those call syncSwatchSelection themselves - this
  // only covers the input's own native picker, when extended colors is on.
  input.addEventListener('input', () => syncSwatchSelection(container, input.value));
}
addSwatches($('swatches'), 'fColor');
addSwatches($('edgeSwatches'), 'fEdgeColor');
addSwatches($('annoSwatches'), 'fAnnoColor');

// Color-picker + note dialog, shared by both "draw a new annotation" and
// "click an existing one to edit it". Resolves {color, note, arrowHeads,
// fontScale} on save, or null on cancel/delete - same two outcomes
// prompt() used to give the caller, so a null result always means "nothing
// left to do here". An options object rather than a long positional list,
// since arrowHeads/fontScale each need both a starting value and a live-
// preview callback (editId is the annotation's id when editing - shows the
// delete button, which runs the same confirm()-guarded deleteAnnotation()
// the old click-to-delete behavior used - or omitted when creating new).
function askAnnotation({ defaultColor, defaultNote, kind, editId, defaultArrowHeads, onArrowHeadsPreview, defaultFontScale, onFontScalePreview }) {
  return new Promise(resolve => {
    const overlay = $('annoDialog');
    const note = $('fAnnoNote');
    const noteRow = $('fAnnoNoteRow');
    const save = $('btnAnnoSave');
    const del = $('btnAnnoDelete');
    const arrowStartBtn = $('btnAnnoArrowStart');
    const arrowEndBtn = $('btnAnnoArrowEnd');
    const fontSizeRow = $('fAnnoFontSizeRow');
    const fontScaleRange = $('fAnnoFontScale');
    const fontScalePct = $('fAnnoFontScalePct');
    // Circle/Database/Server carry no text at all - there's nowhere on a
    // plain outline or fixed icon to put it, unlike Group Label (above the
    // box) or Text Box (inside it) - so they skip the note field entirely,
    // not just the requirement.
    const needsNote = !ANNOTATION_KINDS_NO_NOTE.has(kind);
    const isArrow = kind === 'arrow';
    const isBox = kind === 'box';
    $('annoDialogTitle').textContent = (editId ? 'EDIT ' : '') + ANNOTATION_KIND_LABELS[kind].toUpperCase();
    note.placeholder = kind === 'box' ? 'text shown inside the box' : 'what is this area';
    noteRow.hidden = !needsNote;
    // Stays visible for every kind (not hidden like noteRow) - just
    // disabled/greyed out (button:disabled in style.css) unless this is
    // actually an Arrow, so the toggles are never a live control for a
    // kind they don't apply to.
    arrowStartBtn.disabled = arrowEndBtn.disabled = !isArrow;
    // Font size only means anything once there's text to size - hidden for
    // every kind but Text Box, same reasoning as noteRow above.
    fontSizeRow.hidden = !isBox;
    $('fAnnoColor').value = defaultColor;
    syncSwatchSelection($('annoSwatches'), $('fAnnoColor').value);
    note.value = defaultNote;
    del.hidden = !editId;
    overlay.hidden = false;
    (needsNote ? note : $('fAnnoColor')).focus();
    // A blank annotation is just an unlabeled box - require a note rather
    // than silently allowing one, same as a node needing a name. Doesn't
    // apply to Circle, which has no note field to begin with.
    const syncSave = () => { save.disabled = needsNote && !note.value.trim(); };
    syncSave();
    note.addEventListener('input', syncSave);
    let arrowHeads = ARROW_HEAD_CYCLE.includes(defaultArrowHeads) ? defaultArrowHeads : 'end';
    const syncArrowButtons = () => {
      arrowStartBtn.setAttribute('aria-pressed', String(arrowHeads === 'start' || arrowHeads === 'both'));
      arrowEndBtn.setAttribute('aria-pressed', String(arrowHeads === 'end' || arrowHeads === 'both'));
    };
    syncArrowButtons();
    // Each button toggles only its own side - the other side's current
    // state carries over untouched, so all four combinations (one/both/
    // neither) are reachable independently rather than cycled through.
    arrowStartBtn.onclick = () => {
      arrowHeads = arrowHeadsFor(!(arrowHeads === 'start' || arrowHeads === 'both'), arrowHeads === 'end' || arrowHeads === 'both');
      syncArrowButtons();
      onArrowHeadsPreview?.(arrowHeads);
    };
    arrowEndBtn.onclick = () => {
      arrowHeads = arrowHeadsFor(arrowHeads === 'start' || arrowHeads === 'both', !(arrowHeads === 'end' || arrowHeads === 'both'));
      syncArrowButtons();
      onArrowHeadsPreview?.(arrowHeads);
    };
    // Same growth-only 0-100% shape as the node size slider (0% = default
    // 1x/12px) but its own much higher ceiling - FONT_SCALE_MAX (20x, i.e.
    // up to 240px), not the shared SCALE_MAX node/edge scale uses.
    let fontScale = Math.max(FONT_SCALE_MIN, Math.min(FONT_SCALE_MAX, defaultFontScale || 1));
    const syncFontScale = pct => {
      fontScaleRange.value = pct; fontScalePct.value = pct;
      fontScale = percentToFontScale(pct);
      onFontScalePreview?.(fontScale);
    };
    fontScaleRange.value = fontScalePct.value = fontScaleToPercent(fontScale);
    fontScaleRange.oninput = () => syncFontScale(+fontScaleRange.value);
    fontScalePct.onchange = () => syncFontScale(Math.max(0, Math.min(100, Math.round(Number(fontScalePct.value) || 0))));
    function done(result) {
      overlay.hidden = true;
      note.removeEventListener('input', syncSave);
      save.onclick = null;
      del.onclick = null;
      $('btnAnnoCancel').onclick = null;
      arrowStartBtn.onclick = null;
      arrowEndBtn.onclick = null;
      fontScaleRange.oninput = null;
      fontScalePct.onchange = null;
      resolve(result);
    }
    save.onclick = () => {
      if (needsNote && !note.value.trim()) return;
      done({ color: $('fAnnoColor').value, note: needsNote ? note.value : '', arrowHeads, fontScale });
    };
    del.onclick = async () => { if (await deleteAnnotation(editId)) done(null); };
    $('btnAnnoCancel').onclick = () => done(null);
  });
}

/* ---------- export ---------- */
// Interactive-only bits (drag handles, selection outlines) don't belong in
// an exported diagram - strip them from a clone before it leaves the app.
function cleanForExport(cloneSvg) {
  cloneSvg.querySelectorAll('.handle, .handle-dot, .handle-arm, .anchor-handle, .anchor-dot, .msel-ring, .marquee, .anno-draft, .anno-hit, .anno-icon-hit, .anno-handle-zone, .anno-move-handle, .edge-hit, .size-btn, .size-btn-label, .move-handle').forEach(n => n.remove());
  cloneSvg.querySelector('#gGrid')?.remove();   // dot grid is an editing aid, not diagram content
  cloneSvg.querySelectorAll('.edge.sel, .edge.hot').forEach(n => n.classList.remove('sel', 'hot'));
  cloneSvg.querySelectorAll('.node.sel').forEach(n => n.classList.remove('sel'));
}
function viewportClone() {
  const r = svg.getBoundingClientRect();
  const clone = svg.cloneNode(true);
  clone.setAttribute('viewBox', `${view.x} ${view.y} ${r.width / view.k} ${r.height / view.k}`);
  clone.setAttribute('width', Math.round(r.width));
  clone.setAttribute('height', Math.round(r.height));
  cleanForExport(clone);
  return clone;
}

// Standalone, self-contained SVG file - never attached to the live DOM, so
// its inlined styles can't leak onto the running app. draw() always writes
// an explicit stroke/fill attribute per edge (custom color, or a literal
// var(--wire)/var(--phos) reference for defaults) - this just needs to
// define those two vars, plus whatever else the exported markup relies on
// via CSS class rather than presentation attribute. Values are read from
// the live computed theme (not hardcoded) so an export taken under the
// corporate theme doesn't come out looking like the retro one.
const themeVar = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
function standaloneSvg() {
  const clone = viewportClone();
  const panel = themeVar('--panel'), wire = themeVar('--wire'), phos = themeVar('--phos');
  const font = themeVar('--font'), canvasBg = themeVar('--canvas-bg'), nodeFill = themeVar('--node-fill');
  clone.querySelectorAll('.edge text, .anno-label').forEach(t => t.setAttribute('stroke', panel));
  // No node-style handling needed here - rx/ry is a plain attribute set in
  // draw() itself now (see nodeStyle up top), so viewportClone()'s
  // cloneNode(true) already carries the correct corners over automatically,
  // in every browser, with nothing export-specific to do.
  const style = document.createElementNS(NS, 'style');
  style.textContent = `
    :root{--wire:${wire};--phos:${phos}}
    svg{background:${canvasBg}}
    .node rect{fill:${nodeFill};stroke-width:1.5}
    .node text{font-family:${font}}
    .node .nm{font-size:15px;font-weight:700}
    .node .kd{font-size:11px;font-weight:600}
    .edge .edge-line{fill:none;stroke-width:calc(1.6px * var(--line-scale, 1))}
    .edge text{font-family:${font};
      font-size:calc(11px * var(--label-scale, 1));font-weight:600;paint-order:stroke;
      stroke-width:calc(4px * var(--label-scale, 1));stroke-linejoin:round}
    .anno-box{stroke-width:5;stroke-dasharray:16 10}
    .anno-label{font-family:${font};font-size:calc(12px * var(--anno-font-scale, 1));font-weight:700;
      paint-order:stroke;stroke-width:calc(5px * var(--anno-font-scale, 1));stroke-linejoin:round}
    ${document.documentElement.dataset.theme === 'plotter' ? `
    .node text,.edge text,.anno-label{fill:#000}
    .node rect,.edge .edge-line{stroke:#000}
    .node rect{filter:none!important}
    .anno-box{stroke:#000;fill:none}
    .anno-icon{filter:brightness(0)}
    marker path{fill:#000}
    ` : ''}
  `;
  clone.insertBefore(style, clone.firstChild);
  return clone;
}

function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

$('btnExportSvg').onclick = () => {
  const xml = new XMLSerializer().serializeToString(standaloneSvg());
  downloadBlob(`depmap-${Date.now()}.svg`, new Blob([`<?xml version="1.0" encoding="UTF-8"?>\n${xml}`], { type: 'image/svg+xml' }));
};

// Print path reuses the page's own stylesheet (via @media print in
// style.css) instead of inlining one, so it never touches the live cascade.
let printRoot = null;
$('btnExportPdf').onclick = () => {
  if (!printRoot) {
    printRoot = document.createElement('div');
    printRoot.className = 'print-root';
    document.body.appendChild(printRoot);
  }
  printRoot.replaceChildren(viewportClone());
  window.print();
};

// Rasterizes the same standalone SVG used by "export svg" onto an offscreen
// canvas sized for a fixed print target (600 DPI, 17x11in landscape
// tabloid = 10200x6600px), then downloads that as a PNG. The SVG's own
// width/height (the live viewport's CSS pixel size) give its aspect ratio;
// the image is scaled to fit inside the page without distortion and
// centered, with any leftover margin filled in the canvas's own background
// rather than left transparent. Note: this sets pixel dimensions matching
// 600 DPI at that page size, it does not embed a pHYs/DPI chunk in the PNG
// itself - most print/image tools just want the right pixel count for a
// given size, but say so if you need literal DPI metadata too.
$('btnExportPng').onclick = async () => {
  const DPI = 600, PAGE_W_IN = 17, PAGE_H_IN = 11;
  const pxW = DPI * PAGE_W_IN, pxH = DPI * PAGE_H_IN;
  const svgEl = standaloneSvg();
  const srcW = Number(svgEl.getAttribute('width'));
  const srcH = Number(svgEl.getAttribute('height'));
  const xml = new XMLSerializer().serializeToString(svgEl);
  const url = URL.createObjectURL(new Blob([`<?xml version="1.0" encoding="UTF-8"?>\n${xml}`], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; img.src = url; });
    const canvas = document.createElement('canvas');
    canvas.width = pxW; canvas.height = pxH;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = themeVar('--canvas-bg');
    ctx.fillRect(0, 0, pxW, pxH);
    const scale = Math.min(pxW / srcW, pxH / srcH);
    const drawW = srcW * scale, drawH = srcH * scale;
    ctx.drawImage(img, (pxW - drawW) / 2, (pxH - drawH) / 2, drawW, drawH);
    canvas.toBlob(blob => {
      if (!blob) { say('PNG export failed - image too large for this browser.'); return; }
      downloadBlob(`depmap-${Date.now()}.png`, blob);
    }, 'image/png');
  } catch {
    say('PNG export failed to render the SVG.');
  } finally {
    URL.revokeObjectURL(url);
  }
};

/* ---------- CSV export / import ---------- */
function csvField(v) {
  const s = String(v ?? '');
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function toCsv(columns, rows) {
  const lines = [columns.join(',')];
  for (const r of rows) lines.push(columns.map(c => csvField(r[c])).join(','));
  return lines.join('\r\n') + '\r\n';
}
// Minimal RFC4180 parser: quoted fields, embedded commas/quotes/newlines,
// "" as an escaped quote. Returns an array of rows, each an array of cells.
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; }
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = ''; rows.push(row); row = [];
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(f => f.trim() !== ''));
}

$('btnExportCsv').onclick = () => {
  // One row per node - every node is listed even with no dependencies,
  // "depends_on" packs its outgoing edges' target names into one cell
  // (semicolon-separated) rather than fanning out to one row per edge.
  const rows = nodes.map(n => ({
    name: n.name,
    depends_on: edges
      .filter(e => e.src_id === n.id)
      .map(e => byId.get(e.dst_id)?.name)
      .filter(Boolean)
      .join('; '),
  }));
  downloadBlob(`depmap-dependencies-${Date.now()}.csv`,
    new Blob([toCsv(['name', 'depends_on'], rows)], { type: 'text/csv' }));
};

// Shared by both CSV imports below - parses the file and creates one node
// per row (each landing whereever createNode's own grid-block autoPlace
// puts it). What happens to their position afterward is entirely up to the
// caller: "import csv" leaves it there, "import csv as fib" moves the
// batch onto a spiral right after.
async function importNodesFromCsv(file) {
  const rows = parseCsv(await file.text());
  const header = (rows.shift() || []).map(h => h.trim().toLowerCase());
  const col = name => header.indexOf(name);
  const nameIdx = col('name');
  if (nameIdx === -1) throw new Error('CSV needs a "name" column.');
  const kindIdx = col('kind'), colorIdx = col('color'), notesIdx = col('notes');
  let added = 0, skipped = 0;
  const createdNodes = [];
  // Sequential, not parallel: node placement (server-side autoPlace) reads
  // existing node positions fresh per request, so concurrent inserts could
  // race and land on top of each other. One at a time keeps "no overlap"
  // true for the whole batch, not just against nodes that existed before import.
  for (const row of rows) {
    // Standardize on upper case regardless of how the source CSV wrote it -
    // letters only (toUpperCase leaves digits/punctuation untouched), so
    // e.g. "web-01", "Web-01", and "WEB-01" all land as the same name
    // instead of silently becoming three separate nodes.
    const name = (row[nameIdx] || '').trim().toUpperCase();
    if (!name) { skipped++; continue; }
    const body = { name };
    if (kindIdx !== -1) body.kind = (row[kindIdx] || '').trim();
    if (colorIdx !== -1 && row[colorIdx]) body.color = row[colorIdx].trim();
    if (notesIdx !== -1) body.notes = (row[notesIdx] || '').trim();
    try { createdNodes.push(await api('POST', '/api/nodes', body)); added++; }
    catch { skipped++; }
  }
  return { createdNodes, added, skipped };
}

// Selects everything a CSV import (either mode) just created, replacing
// whatever was selected before - ctrl+shift-dragging any one of them then
// moves the whole batch as a unit, same as a manual marquee-select would,
// so a layout that landed somewhere awkward can be picked up and
// repositioned as one piece.
function selectImportedBatch(createdNodes) {
  multiSelected.clear();
  for (const { id } of createdNodes) multiSelected.add(id);
  select(null);
}

$('btnImportCsv').onclick = () => $('fImportCsv').click();
$('fImportCsv').onchange = async () => {
  const file = $('fImportCsv').files[0];
  $('fImportCsv').value = '';
  if (!file) return;
  let createdNodes, added, skipped;
  try { ({ createdNodes, added, skipped } = await importNodesFromCsv(file)); }
  catch (e) { say(e.message); return; }
  // No collision resolution here on purpose - the grid formula is what
  // decides where these land, overlaps included, not a nudge-apart pass.
  for (const { id, x, y } of blockGridPositions(createdNodes)) {
    await api('PUT', `/api/nodes/${id}/position`, { x, y });
  }
  await load();
  selectImportedBatch(createdNodes);
  say(`Imported ${added} node${added === 1 ? '' : 's'}${skipped ? `, skipped ${skipped}` : ''}.`, added > 0);
};

$('btnImportCsvFib').onclick = () => $('fImportCsvFib').click();
$('fImportCsvFib').onchange = async () => {
  const file = $('fImportCsvFib').files[0];
  $('fImportCsvFib').value = '';
  if (!file) return;
  let createdNodes, added, skipped;
  try { ({ createdNodes, added, skipped } = await importNodesFromCsv(file)); }
  catch (e) { say(e.message); return; }
  // No collision resolution here on purpose - the spiral formula is what
  // decides where these land, overlaps included (mainly the handful of
  // close pairs right near the center), not a nudge-apart pass.
  for (const { id, x, y } of fibonacciSpiralPositions(createdNodes)) {
    await api('PUT', `/api/nodes/${id}/position`, { x, y });
  }
  await load();
  selectImportedBatch(createdNodes);
  say(`Imported ${added} node${added === 1 ? '' : 's'} in a spiral${skipped ? `, skipped ${skipped}` : ''}.`, added > 0);
};

$('btnRemoveCsv').onclick = () => $('fRemoveCsv').click();
$('fRemoveCsv').onchange = async () => {
  const file = $('fRemoveCsv').files[0];
  $('fRemoveCsv').value = '';
  if (!file) return;
  const rows = parseCsv(await file.text());
  const header = (rows.shift() || []).map(h => h.trim().toLowerCase());
  const nameIdx = header.indexOf('name');
  if (nameIdx === -1) { say('CSV needs a "name" column.'); return; }
  // Resolve against the nodes that actually exist before asking anything -
  // the confirm() count (and the delete itself) should only ever cover
  // real, matched nodes, not blank cells or names with no match.
  const toRemove = [];
  let notFound = 0;
  const seen = new Set();
  for (const row of rows) {
    const name = (row[nameIdx] || '').trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const node = nodes.find(n => n.name === name);
    if (node) toRemove.push(node); else notFound++;
  }
  if (!toRemove.length) { say('No matching nodes found in that CSV.'); return; }
  if (!confirm(`Delete ${toRemove.length} node(s) matching this CSV (and their dependencies)? This cannot be undone.`)) return;
  let removed = 0;
  for (const n of toRemove) {
    try { await api('DELETE', `/api/nodes/${n.id}`); removed++; }
    catch { /* already gone or otherwise failed - skip */ }
  }
  await load();
  say(`Removed ${removed} node${removed === 1 ? '' : 's'}${notFound ? `, ${notFound} not found` : ''}.`, removed > 0);
};

/* ---------- tar (USTAR) ---------- */
// Just enough of POSIX ustar to round-trip our own three CSVs: fixed
// 100-char names, regular-file entries only, no long-name/long-size (GNU)
// extensions - fine since "nodes.csv" etc. never gets close to those limits.
function tarHeader(name, size, mtime) {
  const buf = new Uint8Array(512);
  const put = (str, offset, len) => { const b = new TextEncoder().encode(str); buf.set(b.subarray(0, len), offset); };
  const octal = (n, len) => n.toString(8).padStart(len - 1, '0') + '\0';
  put(name, 0, 100);
  put(octal(0o644, 8), 100, 8);
  put(octal(0, 8), 108, 8);
  put(octal(0, 8), 116, 8);
  put(octal(size, 12), 124, 12);
  put(octal(mtime, 12), 136, 12);
  put('        ', 148, 8); // chksum placeholder (8 spaces) while summing
  buf[156] = '0'.charCodeAt(0); // typeflag: regular file
  put('ustar\0', 257, 6);
  put('00', 263, 2);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += buf[i];
  // Fixed 6-digit octal (always sufficient - max possible sum, 512*255,
  // fits in 6 octal digits) + NUL + space, per the ustar chksum format.
  put(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return buf;
}
function buildTar(files) {
  const mtime = Math.floor(Date.now() / 1000);
  const parts = [];
  for (const { name, text } of files) {
    const bytes = new TextEncoder().encode(text);
    parts.push(tarHeader(name, bytes.length, mtime));
    parts.push(bytes);
    const pad = (512 - (bytes.length % 512)) % 512;
    if (pad) parts.push(new Uint8Array(pad));
  }
  parts.push(new Uint8Array(1024)); // two zero-filled end-of-archive blocks
  return new Blob(parts, { type: 'application/x-tar' });
}
function parseTar(buf) {
  const bytes = new Uint8Array(buf);
  const decoder = new TextDecoder();
  const files = [];
  let offset = 0;
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every(b => b === 0)) break; // end-of-archive marker
    const name = decoder.decode(header.subarray(0, 100)).replace(/\0.*$/s, '');
    const sizeField = decoder.decode(header.subarray(124, 136)).replace(/\0.*$/s, '').trim();
    const size = parseInt(sizeField, 8) || 0;
    const typeflag = String.fromCharCode(header[156]);
    offset += 512;
    if ((typeflag === '0' || typeflag === '\0') && name) {
      files.push({ name, text: decoder.decode(bytes.subarray(offset, offset + size)) });
    }
    offset += Math.ceil(size / 512) * 512;
  }
  return files;
}

/* ---------- project export / import / delete-all ---------- */
// Full round-trip CSV, unlike the plain "export csv" above: nodes keep
// their exact position/pin state, edges are re-linkable by name. IDs are
// left out on purpose - they won't be reused on import (a re-imported
// project gets fresh auto-increment IDs), name is the stable key both
// sides agree on. Bundled into a single tar so it's one file instead of
// three loose downloads.
$('btnExportProject').onclick = () => {
  const stamp = Date.now();
  const tar = buildTar([
    { name: 'nodes.csv', text: toCsv(['name', 'kind', 'color', 'notes', 'x', 'y', 'pinned', 'scale'], nodes) },
    { name: 'edges.csv', text: toCsv(
      // c1x/c1y/c2x/c2y (a hand-dragged curve handle) and src_ox/src_oy/
      // dst_ox/dst_oy (a hand-dragged anchor point) are null until touched -
      // csvField renders null as an empty cell, and the import side below
      // only applies them when the cell parses back to a finite number, so
      // an edge that was never reshaped round-trips with no curve/anchor
      // columns filled in, same as it started.
      ['src_name', 'dst_name', 'label', 'color', 'bidirectional', 'line_scale', 'label_scale',
        'c1x', 'c1y', 'c2x', 'c2y', 'src_ox', 'src_oy', 'dst_ox', 'dst_oy'],
      edges.map(e => ({
        src_name: byId.get(e.src_id)?.name || '',
        dst_name: byId.get(e.dst_id)?.name || '',
        label: e.label, color: e.color || '', bidirectional: e.bidirectional ? 1 : 0,
        line_scale: e.lineScale || 1, label_scale: e.labelScale || 1,
        c1x: e.c1x, c1y: e.c1y, c2x: e.c2x, c2y: e.c2y,
        src_ox: e.src_ox, src_oy: e.src_oy, dst_ox: e.dst_ox, dst_oy: e.dst_oy,
      })),
    ) },
    { name: 'annotations.csv', text: toCsv(
      ['x', 'y', 'width', 'height', 'color', 'note', 'kind', 'arrow_heads', 'start_corner', 'font_scale'],
      annotations.map(a => ({ ...a, arrow_heads: a.arrowHeads, start_corner: a.startCorner, font_scale: a.fontScale })),
    ) },
  ]);
  downloadBlob(`depmap-project-${stamp}.tar`, tar);
};

$('btnImportProject').onclick = () => $('fImportProject').click();
$('fImportProject').onchange = async () => {
  const picked = [...$('fImportProject').files];
  $('fImportProject').value = '';
  if (!picked.length) return;

  // A single .tar (what "export project" now produces) unpacks into its
  // three CSV members; anything else is treated as one or more loose CSVs,
  // for old exports from before project export was bundled into a tar.
  let csvFiles;
  if (picked.length === 1 && /\.tar$/i.test(picked[0].name)) {
    csvFiles = parseTar(await picked[0].arrayBuffer());
    if (!csvFiles.length) { say('Empty or unreadable tar file.'); return; }
  } else {
    csvFiles = await Promise.all(picked.map(async f => ({ name: f.name, text: await f.text() })));
  }

  // Classify each member by its header instead of its filename - the
  // export always writes a nodes file, an edges file, and an annotations
  // file together, but nothing stops someone from renaming them.
  let nodeFile = null, edgeFile = null, annoFile = null;
  for (const file of csvFiles) {
    const rows = parseCsv(file.text);
    const header = (rows.shift() || []).map(h => h.trim().toLowerCase());
    if (header.includes('src_name') && header.includes('dst_name')) edgeFile = { header, rows };
    else if (header.includes('width') && header.includes('height')) annoFile = { header, rows };
    else if (header.includes('name')) nodeFile = { header, rows };
  }
  if (!nodeFile && !edgeFile && !annoFile) {
    say('No recognizable project CSV selected (need a "name", "src_name"/"dst_name", or "width"/"height" header).');
    return;
  }

  const col = (header, name) => header.indexOf(name);
  const idByName = new Map(nodes.map(n => [n.name, n.id]));   // seed with what's already there, for edges-only re-imports
  let nodesAdded = 0, nodesSkipped = 0;

  if (nodeFile) {
    const { header, rows } = nodeFile;
    const nameIdx = col(header, 'name'), kindIdx = col(header, 'kind'), colorIdx = col(header, 'color'),
      notesIdx = col(header, 'notes'), xIdx = col(header, 'x'), yIdx = col(header, 'y'), scaleIdx = col(header, 'scale');
    // Sequential for the same reason as the plain import above (auto-place
    // reads existing positions per request) - and here it also matters
    // because idByName has to be fully populated before edges resolve names.
    for (const row of rows) {
      const name = (row[nameIdx] || '').trim();
      if (!name) { nodesSkipped++; continue; }
      const body = { name };
      if (kindIdx !== -1) body.kind = (row[kindIdx] || '').trim();
      if (colorIdx !== -1 && row[colorIdx]) body.color = row[colorIdx].trim();
      if (notesIdx !== -1) body.notes = (row[notesIdx] || '').trim();
      try {
        const n = await api('POST', '/api/nodes', body);
        const x = xIdx !== -1 ? Number(row[xIdx]) : NaN, y = yIdx !== -1 ? Number(row[yIdx]) : NaN;
        // Restore the exact recorded position rather than leaving it at its
        // auto-placed spot - that's the whole point of a project restore.
        if (Number.isFinite(x) && Number.isFinite(y)) await api('PUT', `/api/nodes/${n.id}/position`, { x, y });
        const scale = scaleIdx !== -1 ? Number(row[scaleIdx]) : NaN;
        if (Number.isFinite(scale)) await api('PUT', `/api/nodes/${n.id}/scale`, { scale });
        idByName.set(name, n.id);
        nodesAdded++;
      } catch { nodesSkipped++; }
    }
  }

  let edgesAdded = 0, edgesSkipped = 0;
  if (edgeFile) {
    const { header, rows } = edgeFile;
    const srcIdx = col(header, 'src_name'), dstIdx = col(header, 'dst_name'),
      labelIdx = col(header, 'label'), colorIdx = col(header, 'color'), bidirIdx = col(header, 'bidirectional'),
      lineScaleIdx = col(header, 'line_scale'), labelScaleIdx = col(header, 'label_scale'),
      c1xIdx = col(header, 'c1x'), c1yIdx = col(header, 'c1y'), c2xIdx = col(header, 'c2x'), c2yIdx = col(header, 'c2y'),
      srcOxIdx = col(header, 'src_ox'), srcOyIdx = col(header, 'src_oy'),
      dstOxIdx = col(header, 'dst_ox'), dstOyIdx = col(header, 'dst_oy');
    // A cell for a column this file doesn't have (an older export, from
    // before curve/anchor round-tripped) reads back as NaN via the -1
    // index, same as an untouched edge's genuinely blank cell - both
    // correctly leave that edge on its default procedural curve/anchor.
    // Number('') is 0, not NaN - a blank cell (an edge that was never
    // hand-curved/anchored, the common case) would otherwise parse as a
    // real 0 and get written back as an explicit frozen curve/anchor,
    // permanently overriding the procedural default it started with.
    const cell = (idx, row) => {
      if (idx === -1) return NaN;
      const s = (row[idx] || '').trim();
      return s === '' ? NaN : Number(s);
    };
    for (const row of rows) {
      const srcId = idByName.get((row[srcIdx] || '').trim());
      const dstId = idByName.get((row[dstIdx] || '').trim());
      if (!srcId || !dstId) { edgesSkipped++; continue; }
      const body = {
        src_id: srcId, dst_id: dstId,
        label: labelIdx !== -1 ? (row[labelIdx] || '').trim() : '',
        color: colorIdx !== -1 ? (row[colorIdx] || '').trim() : '',
        bidirectional: bidirIdx !== -1 && /^(1|true|yes)$/i.test((row[bidirIdx] || '').trim()) ? 1 : 0,
      };
      try {
        const created = await api('POST', '/api/edges', body);
        const lineScale = lineScaleIdx !== -1 ? Number(row[lineScaleIdx]) : NaN;
        const labelScale = labelScaleIdx !== -1 ? Number(row[labelScaleIdx]) : NaN;
        if (Number.isFinite(lineScale) || Number.isFinite(labelScale)) {
          await api('PUT', `/api/edges/${created.id}/scale`, { lineScale, labelScale });
        }
        const c1x = cell(c1xIdx, row), c1y = cell(c1yIdx, row), c2x = cell(c2xIdx, row), c2y = cell(c2yIdx, row);
        if ([c1x, c1y, c2x, c2y].every(Number.isFinite)) {
          await api('PUT', `/api/edges/${created.id}/curve`, { c1x, c1y, c2x, c2y });
        }
        const srcOx = cell(srcOxIdx, row), srcOy = cell(srcOyIdx, row);
        if (Number.isFinite(srcOx) && Number.isFinite(srcOy)) {
          await api('PUT', `/api/edges/${created.id}/anchor`, { side: 'src', ox: srcOx, oy: srcOy });
        }
        const dstOx = cell(dstOxIdx, row), dstOy = cell(dstOyIdx, row);
        if (Number.isFinite(dstOx) && Number.isFinite(dstOy)) {
          await api('PUT', `/api/edges/${created.id}/anchor`, { side: 'dst', ox: dstOx, oy: dstOy });
        }
        edgesAdded++;
      } catch { edgesSkipped++; }
    }
  }

  let annosAdded = 0, annosSkipped = 0;
  if (annoFile) {
    const { header, rows } = annoFile;
    const xIdx = col(header, 'x'), yIdx = col(header, 'y'), wIdx = col(header, 'width'), hIdx = col(header, 'height'),
      colorIdx = col(header, 'color'), noteIdx = col(header, 'note'), kindIdx = col(header, 'kind'),
      arrowHeadsIdx = col(header, 'arrow_heads'), startCornerIdx = col(header, 'start_corner'),
      fontScaleIdx = col(header, 'font_scale');
    for (const row of rows) {
      const x = Number(row[xIdx]), y = Number(row[yIdx]), width = Number(row[wIdx]), height = Number(row[hIdx]);
      if (![x, y, width, height].every(Number.isFinite)) { annosSkipped++; continue; }
      const body = {
        x, y, width, height, note: noteIdx !== -1 ? (row[noteIdx] || '').trim() : '',
        kind: kindIdx !== -1 && ANNOTATION_KINDS.includes(row[kindIdx]) ? row[kindIdx] : 'label',
      };
      // Truthy check, not just "column present" - an empty cell should
      // fall back to the server's default color, not store '' literally
      // (the default parameter in the route only kicks in for undefined).
      if (colorIdx !== -1 && row[colorIdx]) body.color = row[colorIdx].trim();
      if (arrowHeadsIdx !== -1 && row[arrowHeadsIdx]) body.arrowHeads = row[arrowHeadsIdx].trim();
      if (startCornerIdx !== -1 && row[startCornerIdx]) body.startCorner = row[startCornerIdx].trim();
      if (fontScaleIdx !== -1 && row[fontScaleIdx]) {
        const fs = Number(row[fontScaleIdx]);
        if (Number.isFinite(fs)) body.fontScale = fs;
      }
      try { await api('POST', '/api/annotations', body); annosAdded++; }
      catch { annosSkipped++; }
    }
  }

  await load();
  const skippedTotal = nodesSkipped + edgesSkipped + annosSkipped;
  say(`Imported ${nodesAdded} node(s), ${edgesAdded} dependency(ies), ${annosAdded} annotation(s).` +
    (skippedTotal ? ` Skipped ${nodesSkipped} node(s), ${edgesSkipped} dependency(ies), ${annosSkipped} annotation(s).` : ''),
    nodesAdded > 0 || edgesAdded > 0 || annosAdded > 0);
};

$('btnDeleteAll').onclick = async () => {
  if (!nodes.length && !edges.length) { say('Nothing to delete.'); return; }
  if (!confirm(`Delete all ${nodes.length} node(s) and ${edges.length} dependency(ies)? This cannot be undone.`)) return;
  try {
    await api('DELETE', '/api/nodes');
    selected = null;
    selectedEdge = null;
    await load();
    say('Project cleared.', true);
  } catch (e) { say(e.message); }
};

// The "project" toolbar dropdown is an action menu, not a persistent
// setting like the theme select - it snaps back to its placeholder after
// every pick, so choosing the same action twice in a row still fires.
$('projectSelect').onchange = () => {
  const action = $('projectSelect').value;
  $('projectSelect').value = '';
  if (action === 'export') $('btnExportProject').click();
  else if (action === 'import') $('btnImportProject').click();
  else if (action === 'delete') $('btnDeleteAll').click();
};

// Same action-menu pattern - svg/pdf/png/csv export buttons are still the
// real thing (see the hidden wrapper at the end of index.html), this just
// picks which one to click.
const EXPORT_BUTTONS = { svg: 'btnExportSvg', pdf: 'btnExportPdf', png: 'btnExportPng', csv: 'btnExportCsv' };
$('exportSelect').onchange = () => {
  const format = $('exportSelect').value;
  $('exportSelect').value = '';
  $(EXPORT_BUTTONS[format])?.click();
};

// Same action-menu pattern - "import csv" (btnImportCsv, the original
// grid-per-color placement) and "import csv as fib" (btnImportCsvFib, the
// spiral) are still the real things (hidden wrapper at the end of
// index.html), this just picks which one to click.
const IMPORT_CSV_BUTTONS = { fib: 'btnImportCsvFib', blocks: 'btnImportCsv' };
$('importCsvSelect').onchange = () => {
  const mode = $('importCsvSelect').value;
  $('importCsvSelect').value = '';
  $(IMPORT_CSV_BUTTONS[mode])?.click();
};

// Same action-menu pattern - re-lays-out the currently multi-selected
// nodes (2+ required) using the same block/fibonacci formulas the CSV
// imports use, centered on the selection's current centroid rather than
// the world origin so an in-place rearrange doesn't teleport the group
// across the canvas. No collision resolution here either, same as those
// imports - overlaps are the formula's call, not something to nudge apart.
// The selection itself is untouched (still just the same node ids), so
// it's still multi-selected and ctrl+shift-draggable as a group afterward.
const REARRANGE_LAYOUTS = { blocks: blockGridPositions, fib: fibonacciSpiralPositions };
$('rearrangeSelect').onchange = async () => {
  const mode = $('rearrangeSelect').value;
  $('rearrangeSelect').value = '';
  if (multiSelected.size <= 1) {
    say('Select more than one node (ctrl+shift-click, or drag a marquee) to rearrange.');
    return;
  }
  const selectedNodes = [...multiSelected].map(id => byId.get(id)).filter(Boolean);
  const cx = Math.round(selectedNodes.reduce((s, n) => s + n.x, 0) / selectedNodes.length);
  const cy = Math.round(selectedNodes.reduce((s, n) => s + n.y, 0) / selectedNodes.length);
  const positioned = REARRANGE_LAYOUTS[mode](selectedNodes.map(n => ({ id: n.id, color: n.color })));
  for (const { id, x, y } of positioned) {
    await api('PUT', `/api/nodes/${id}/position`, { x: x + cx, y: y + cy });
  }
  await load();
  const shape = mode === 'fib' ? 'spiral' : 'block';
  say(`Rearranged ${selectedNodes.length} nodes into a ${shape}.`, true);
};

applyView();
load().catch(e => say(e.message));
