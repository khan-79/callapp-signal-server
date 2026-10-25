/*
 * Video stage layout. Pure maths (no DOM) so it can be unit-tested.
 *
 * Given the stage size and the tiles, returns a pixel rectangle for each tile:
 *   1 tile            -> fills the stage
 *   2 tiles           -> picture-in-picture: one big, one small in the corner
 *                        (tap the small one to swap)
 *   3+ tiles          -> best-fitting grid sized to the screen, last row centred
 *   3+ and one pinned -> spotlight: pinned tile big, the rest in a strip
 *                        (bottom strip on portrait/phones, side strip on wide screens)
 */
(function (root) {
  'use strict';

  const rect = (x, y, w, h, kind, z) => ({
    x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h), kind, z: z || 1
  });

  // Place `items` in rows of `perRow`, each row centred horizontally.
  function placeRows(out, items, W, y0, cw, ch, gap, perRow, kind) {
    const rows = Math.ceil(items.length / perRow);
    for (let r = 0; r < rows; r++) {
      const rowItems = items.slice(r * perRow, (r + 1) * perRow);
      const rowW = rowItems.length * cw + (rowItems.length - 1) * gap;
      const x0 = (W - rowW) / 2;
      rowItems.forEach((id, i) => {
        out[id] = rect(x0 + i * (cw + gap), y0 + r * (ch + gap), cw, ch, kind, 2);
      });
    }
  }

  function computeLayout(opts) {
    const W = opts.W;
    const H = opts.H;
    const ids = opts.ids || [];
    const gap = opts.gap === undefined ? 8 : opts.gap;
    const out = {};
    const n = ids.length;
    if (!n || W <= 0 || H <= 0) return out;

    const portrait = H > W;
    const pinned = ids.indexOf(opts.pinned) >= 0 ? opts.pinned : null;

    // --- one tile ---
    if (n === 1) {
      out[ids[0]] = rect(0, 0, W, H, 'main', 1);
      return out;
    }

    // --- two tiles: picture-in-picture ---
    if (n === 2) {
      const main = pinned || ids.find((i) => i !== opts.selfId) || ids[0];
      const other = ids.find((i) => i !== main);
      const tw = portrait ? Math.min(120, Math.round(W * 0.3)) : Math.min(220, Math.round(W * 0.2));
      const th = portrait ? Math.round(tw * 1.33) : Math.round(tw * 0.75);
      out[main] = rect(0, 0, W, H, 'main', 1);
      out[other] = rect(W - tw - gap, H - th - gap, tw, th, 'pip', 3);
      return out;
    }

    // --- spotlight (3+ tiles, one pinned) ---
    if (pinned) {
      const others = ids.filter((i) => i !== pinned);
      const m = others.length;
      if (!portrait && W >= 640) {
        const stripW = Math.round(Math.min(240, Math.max(130, W * 0.2)));
        const mainW = W - stripW - gap;
        out[pinned] = rect(0, 0, mainW, H, 'main', 1);
        // One column of thumbnails; wrap to more columns if they'd get too small.
        let cols = 1;
        while (cols < m && Math.floor((H - gap * (Math.ceil(m / cols) - 1)) / Math.ceil(m / cols)) < 64) cols++;
        const rows = Math.ceil(m / cols);
        const tw = Math.floor((stripW - gap * (cols - 1)) / cols);
        const avail = Math.floor((H - gap * (rows - 1)) / rows);
        const th = Math.min(Math.round(tw * (cols === 1 ? 0.75 : 1)), avail);
        others.forEach((id, i) => {
          out[id] = rect(mainW + gap + (i % cols) * (tw + gap), Math.floor(i / cols) * (th + gap), tw, th, 'thumb', 2);
        });
      } else {
        const minThumb = 72;
        const perRow = Math.max(1, Math.min(m, Math.floor((W + gap) / (minThumb + gap))));
        const rows = Math.ceil(m / perRow);
        const tw = Math.min(120, Math.floor((W - gap * (perRow - 1)) / perRow));
        const th = Math.round(tw * 1.25);
        const stripH = rows * th + (rows - 1) * gap;
        const mainH = Math.max(80, H - stripH - gap);
        out[pinned] = rect(0, 0, W, mainH, 'main', 1);
        placeRows(out, others, W, mainH + gap, tw, th, gap, perRow, 'thumb');
      }
      return out;
    }

    // --- grid ---
    const target = portrait ? 0.75 : 1.333; // preferred width/height of a cell
    let best = null;
    for (let cols = 1; cols <= n; cols++) {
      const rows = Math.ceil(n / cols);
      const cw = (W - gap * (cols - 1)) / cols;
      const ch = (H - gap * (rows - 1)) / rows;
      if (cw <= 0 || ch <= 0) continue;
      const penalty = Math.abs(Math.log(cw / ch / target)) + (rows * cols - n) * 0.05;
      if (!best || penalty < best.penalty) best = { cols, rows, cw, ch, penalty };
    }
    placeRows(out, ids, W, 0, best.cw, best.ch, gap, best.cols, 'grid');
    return out;
  }

  const api = { computeLayout };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Layout = api;
})(typeof window !== 'undefined' ? window : globalThis);
