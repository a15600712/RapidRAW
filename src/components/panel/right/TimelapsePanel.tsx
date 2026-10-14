// GlideLapse (timelapse grading, https://github.com/a15600712/glidelapse): the Timelapse panel.
// Every action runs the installed `glidelapse` program on the open folder through the
// `glidelapse_run` command. While it runs, RapidRAW's sidecar writes are refused
// (glidelapse::guarded) and an overlay blocks the window; afterwards the folder is reopened.
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { appCacheDir, join } from '@tauri-apps/api/path';
import { ask, open } from '@tauri-apps/plugin-dialog';
import { useTranslation } from 'react-i18next';
import { create } from 'zustand';
import Button from '../../ui/Button';
import Slider from '../../ui/Slider';
import Text from '../../ui/Text';
import { Invokes } from '../../ui/AppProperties';
import { TextVariants } from '../../../types/typography';
import { useEditorStore } from '../../../store/useEditorStore';
import { useLibraryStore } from '../../../store/useLibraryStore';
import { debouncedSave } from '../../../hooks/useEditorActions';

/** An ellipse as fractions of the visible photo: centre, radii of its width and height, and its
 * rotation in degrees (clockwise on screen, as RapidRAW's radial mask). */
type Area = { cx: number; cy: number; rx: number; ry: number; rot: number };

/** Smallest radius, as a fraction of the photo side: about 30 px on deflicker's 1024 px renders,
 * well above the 256 pixels a measurement needs. */
const MIN_RADIUS = 0.03;

/** The preview: its JPEG frames in RapidRAW's cache folder, as glidelapse describes them (count,
 * every frame size and which one each frame has, the frames' geometry and file names, the
 * deflicker EV each frame was rendered with, the brightness grid's cells per side), `made` (when
 * glidelapse wrote it) and one generation per Preview run; it stays until the next Preview
 * replaces it, marked outdated once an action changed the grade. */
type Preview = {
  folder: string;
  dir: string;
  count: number;
  sizes: [number, number][];
  size_of: number[];
  geometry: string;
  files: string[];
  deflicker: number[];
  grid: number;
  made: number;
  gen: number;
  outdated?: boolean;
};

/** One point of the reference area's path: its ellipse on preview frame `frame`. One anchor is a
 * static area; several make it move from one to the next (LRT's animated reference area, F103). */
type Anchor = { frame: number; area: Area };

/** The sequence's reference area with the geometry of the preview it was drawn on (deflicker
 * refuses it once the frames' crops changed); kept per folder, in memory and in this window's
 * storage (LRT keeps its area per sequence too, F94). */
type StoredArea = { anchors: Anchor[]; geometry: string };
const AREA_KEY = 'glidelapse.referenceArea:';
const areas = new Map<string, StoredArea>();
const isArea = (v: unknown): v is Area => {
  const a = v as Record<string, unknown> | null;
  const n = (k: string) => (typeof a?.[k] === 'number' && Number.isFinite(a[k]) ? (a[k] as number) : NaN);
  return (
    n('cx') >= 0 &&
    n('cx') <= 1 &&
    n('cy') >= 0 &&
    n('cy') <= 1 &&
    n('rx') > 0 &&
    n('ry') > 0 &&
    Number.isFinite(n('rot'))
  );
};
const isAnchors = (v: unknown): v is Anchor[] =>
  Array.isArray(v) &&
  v.length > 0 &&
  v.every(
    (x, i) =>
      Number.isInteger(x?.frame) && x.frame >= 0 && isArea(x.area) && (i === 0 || x.frame > (v[i - 1] as Anchor).frame),
  );
const loadArea = (folder: string): StoredArea | null => {
  const kept = areas.get(folder);
  if (kept) return kept;
  try {
    const v = JSON.parse(localStorage.getItem(AREA_KEY + folder) ?? 'null');
    if (typeof v?.geometry !== 'string') return null;
    // an area kept before anchors existed is one static anchor
    if (isArea(v.area)) return { anchors: [{ frame: 0, area: v.area }], geometry: v.geometry };
    return isAnchors(v.anchors) ? { anchors: v.anchors, geometry: v.geometry } : null;
  } catch {
    return null;
  }
};
const saveArea = (folder: string, stored: StoredArea | null) => {
  if (stored) areas.set(folder, stored);
  else areas.delete(folder);
  try {
    if (stored) localStorage.setItem(AREA_KEY + folder, JSON.stringify(stored));
    else localStorage.removeItem(AREA_KEY + folder);
  } catch {
    // storage unavailable: the area lasts while RapidRAW runs
  }
};

/** The area on frame `i`, as glidelapse's render::per_frame: every number linear between two
 * anchors (rotation the short way, modulo 180 degrees), the nearer anchor's area outside them. */
const areaAt = (anchors: Anchor[], i: number): Area | null => {
  if (!anchors.length) return null;
  const j = anchors.findIndex((a) => a.frame > i);
  if (j === 0) return anchors[0].area;
  if (j < 0) return anchors[anchors.length - 1].area;
  const [a, b] = [anchors[j - 1], anchors[j]];
  const t = (i - a.frame) / (b.frame - a.frame);
  const l = (p: number, q: number) => p + (q - p) * t;
  let turn = (((b.area.rot - a.area.rot) % 180) + 180) % 180;
  if (turn > 90) turn -= 180;
  return {
    cx: l(a.area.cx, b.area.cx),
    cy: l(a.area.cy, b.area.cy),
    rx: l(a.area.rx, b.area.rx),
    ry: l(a.area.ry, b.area.ry),
    rot: a.area.rot + turn * t,
  };
};

/** `--ellipse` for glidelapse: one static ellipse, or `F@ellipse;...` for anchors. */
const ellipseArg = (anchors: Anchor[]) => {
  const e = (a: Area) => [a.cx, a.cy, a.rx, a.ry, a.rot].map((v) => v.toFixed(5)).join(',');
  return anchors.length === 1 ? e(anchors[0].area) : anchors.map((a) => `${a.frame}@${e(a.area)}`).join(';');
};

/** Pixels inside the ellipse on deflicker's measurement of a `w` x `h` frame, counted as
 * glidelapse's area_mean does (at most 1024 px on the long side, never enlarged; pixel centres;
 * RapidRAW's radial formula). It needs 256; 300 leaves room for the render size rounding. The
 * count stops once it is enough. */
const pixelsIn = (a: Area, w: number, h: number) => {
  const scale = Math.min(1, 1024 / Math.max(w, h));
  // rounded down: a render a pixel smaller must not empty the area (a very thin crop)
  const [mw, mh] = [Math.max(1, Math.floor(w * scale)), Math.max(1, Math.floor(h * scale))];
  // at least 3 measured pixels across each radius, however the render size rounds
  if (a.rx * mw < 3 || a.ry * mh < 3) return 0;
  const th = (a.rot * Math.PI) / 180;
  const [ecx, ecy, erx, ery] = [a.cx * mw, a.cy * mh, a.rx * mw, a.ry * mh];
  const [ex, ey] = [
    Math.hypot(erx * Math.cos(th), ery * Math.sin(th)),
    Math.hypot(erx * Math.sin(th), ery * Math.cos(th)),
  ];
  const on = (v: number, n: number) => Math.min(n, Math.max(0, v));
  let pixels = 0;
  for (let y = on(Math.floor(ecy - ey), mh); y < on(Math.ceil(ecy + ey), mh); y++) {
    for (let x = on(Math.floor(ecx - ex), mw); x < on(Math.ceil(ecx + ex), mw); x++) {
      const [dx, dy] = [x + 0.5 - ecx, y + 0.5 - ecy];
      const [u, v] = [dx * Math.cos(th) + dy * Math.sin(th), -dx * Math.sin(th) + dy * Math.cos(th)];
      if ((u / erx) ** 2 + (v / ery) ** 2 <= 1 && ++pixels >= 300) return pixels;
    }
  }
  return pixels;
};

/** Mean Y' (0..1) inside `a` on frame `i` of the preview's brightness grid (`g` cells per side,
 * 16-bit means), every cell weighted by how much of it lies inside (4 x 4 samples) on the frame's
 * own shape `w` x `h`, so a thin area still counts; NaN when it covers nothing. An approximation
 * of what deflicker measures (no clipping rules, 1280 px preview): for the curves only. */
const gridMean = (grid: Uint16Array, g: number, i: number, a: Area, w: number, h: number) => {
  const th = (a.rot * Math.PI) / 180;
  const [cos, sin] = [Math.cos(th), Math.sin(th)];
  const [cx, cy, rx, ry] = [a.cx * w, a.cy * h, a.rx * w, a.ry * h];
  const [ex, ey] = [Math.hypot(rx * cos, ry * sin), Math.hypot(rx * sin, ry * cos)];
  const [cw, ch] = [w / g, h / g];
  const cell = (v: number, size: number) => Math.min(g - 1, Math.max(0, Math.floor(v / size)));
  const base = i * g * g;
  let [sum, n] = [0, 0];
  for (let gy = cell(cy - ey, ch); gy <= cell(cy + ey, ch); gy++) {
    for (let gx = cell(cx - ex, cw); gx <= cell(cx + ex, cw); gx++) {
      let k = 0;
      for (let s = 0; s < 16; s++) {
        const [dx, dy] = [(gx + ((s % 4) + 0.5) / 4) * cw - cx, (gy + (Math.floor(s / 4) + 0.5) / 4) * ch - cy];
        const [u, v] = [dx * cos + dy * sin, -dx * sin + dy * cos];
        if ((u / rx) ** 2 + (v / ry) ** 2 <= 1) k++;
      }
      if (k) {
        sum += k * grid[base + gy * g + gx];
        n += k;
      }
    }
  }
  return n ? sum / n / 65535 : NaN;
};

/** glidelapse's deflicker::loess: the LOESS target its deflicker aims for, `frac` of the sequence
 * per neighbourhood (at least 8 frames). */
const loess = (y: number[], frac: number) => {
  const n = y.length;
  if (n < 8) return [];
  const k = Math.min(n, Math.max(8, Math.ceil(frac * n)));
  return y.map((_, i) => {
    const lo = Math.min(Math.max(0, i - Math.floor(k / 2)), n - k);
    const h = Math.max(i - lo, lo + k - 1 - i);
    let [sw, swx, swy, swxx, swxy] = [0, 0, 0, 0, 0];
    for (let j = lo; j < lo + k; j++) {
      const x = j - i;
      const w = (1 - (Math.abs(x) / h) ** 3) ** 3;
      [sw, swx, swy, swxx, swxy] = [sw + w, swx + w * x, swy + w * y[j], swxx + w * x * x, swxy + w * x * y[j]];
    }
    const det = sw * swxx - swx * swx;
    return Math.abs(det) > 1e-12 ? (swxx * swy - swx * swxy) / det : swy / sw;
  });
};

/** A frame's brightness without its deflicker correction `ev`, from the display value `y`:
 * through sRGB's curve, so a stop is a stop. ponytail: RapidRAW's tone mapping is not sRGB, fine
 * for the small corrections deflicker writes; exact would need a render without them. */
const withoutCorrection = (y: number, ev: number) => {
  const dec = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const enc = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
  return ev ? enc(Math.min(1, dec(y) * 2 ** -ev)) : y;
};

/** What `glidelapse curves` reports, by file: stars, HG and deflicker EV, and every slider that
 * changes across the frames (with exposure), at RapidRAW's defaults where a sidecar has none. */
type Curves = {
  files: string[];
  rating: number[];
  hg: number[];
  deflicker: number[];
  values: Record<string, number[]>;
};

/** The preview's data and view, shared by the panel and its pop-out: the frame on show, playback,
 * the brightness grid of the preview generation `gen`, the folder's curves, and the switches. */
const useView = create<{
  frame: number;
  playing: boolean;
  grid: { gen: number; data: Uint16Array } | null;
  curves: { folder: string; data: Curves } | null;
  showCurves: boolean;
  showPhoto: boolean;
  param: string;
  allParams: boolean;
  editing: boolean;
  poppedOut: boolean;
  smoothing: number;
  constant: boolean;
}>(() => ({
  frame: 0,
  playing: true,
  grid: null,
  curves: null,
  showCurves: true,
  showPhoto: true,
  param: 'exposure',
  allParams: false,
  editing: false,
  poppedOut: false,
  smoothing: 0.1,
  constant: false,
}));

/** Reload the folder's curves from its sidecars; an answer for a folder no longer open is dropped. */
const loadCurves = (folder: string) =>
  invoke<Curves>('glidelapse_curves', { folder }).then(
    (data) => {
      if (useLibraryStore.getState().currentFolderPath === folder) useView.setState({ curves: { folder, data } });
    },
    (e) => say(String(e)),
  );

/** Load the brightness grid that came with preview `p`, checked against its size. */
const loadGrid = (p: Preview) =>
  invoke<ArrayBuffer>('glidelapse_preview_grid', { made: p.made }).then(
    (buf) => {
      // little-endian as written; every platform RapidRAW runs on is
      const data = new Uint16Array(buf);
      if (data.length !== p.count * p.grid * p.grid) throw new Error('the preview grid does not match its frames');
      useView.setState({ grid: { gen: p.gen, data } });
    },
    (e) => say(String(e)),
  );

/** "lumaNoiseReduction" -> "Luma noise reduction". */
const label = (key: string) => {
  const words = key.replace(/([A-Z])/g, ' $1').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/**
 * The preview played as a flipbook of its frames (LOG F96: WebKitGTK shows <video> scrambled or
 * grey on some Linux GPUs, while images it shows everywhere). A frame is decoded before it
 * replaces the last one on the canvas, so nothing flashes; each stays up 40 ms (25 a second at
 * most), and a slow decode makes playback wait, never skip, so flicker stays visible. Four frames
 * are decoded ahead. The frame and playback are shared (`useView`), so the pop-out continues
 * where the panel was.
 */
function useFlipbook(p: Preview) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const { frame, playing } = useView();
  const setFrame = (f: number) => useView.setState({ frame: f });
  // frames that load: a missing one ends the set there
  const [count, setCount] = useState(p.count);
  // the frame on show may differ in size from the first (crops can change along a sequence)
  const [size, setSize] = useState<[number, number]>(p.sizes[0] ?? [1, 1]);
  const pending = useRef(new Map<number, Promise<HTMLImageElement>>());
  const load = useCallback(
    (i: number) => {
      let img = pending.current.get(i);
      if (!img) {
        const el = new Image();
        el.src = `${convertFileSrc(`${p.dir}/frame_${String(i + 1).padStart(6, '0')}.jpg`)}?v=${p.gen}`;
        img = el.decode().then(() => el);
        pending.current.set(i, img);
      }
      return img;
    },
    [p.dir, p.gen],
  );
  useEffect(() => {
    pending.current.clear();
    setCount(p.count);
  }, [p.gen, p.count]);
  useEffect(() => {
    if (count < 1) return;
    const shown = Math.min(frame, count - 1);
    let live = true;
    let timer = 0;
    for (const k of pending.current.keys()) if ((k - shown + count) % count > 4) pending.current.delete(k);
    for (let k = 1; k <= 4 && k < count; k++) load((shown + k) % count).catch(() => {});
    load(shown).then(
      (img) => {
        const c = canvas.current;
        if (!live || !c) return;
        if (c.width !== img.naturalWidth) c.width = img.naturalWidth;
        if (c.height !== img.naturalHeight) c.height = img.naturalHeight;
        c.getContext('2d')?.drawImage(img, 0, 0);
        setSize((s) =>
          s[0] === img.naturalWidth && s[1] === img.naturalHeight ? s : [img.naturalWidth, img.naturalHeight],
        );
        // every frame stays up 40 ms from when it is drawn, however long its decode took
        if (playing && count > 1) timer = window.setTimeout(() => setFrame((shown + 1) % count), 40);
      },
      () => {
        if (!live) return;
        setCount(shown);
        setFrame(0);
      },
    );
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [frame, playing, count, load]);
  return { canvas, frame: Math.min(frame, Math.max(0, count - 1)), count, size };
}

const BLUE = '#5b8cff';
const GREEN = '#3ddc84';
const ORANGE = '#ff9a3c';
const YELLOW = '#ffd43b';

/**
 * The preview with LRTimelapse's overlays (seen running LRT 7.5.5, F103): curves over the photo
 * (brightness in the reference area before deflicker, the deflicker target for the chosen
 * smoothing, the brightness after deflicker, a parameter of the grade with the keyframes as
 * diamonds, the frame on show as a dashed line) and the reference area, edited in place: drag on
 * the photo to draw it, inside it to move it, the dot to resize it; on a frame without an anchor
 * you choose between moving the area there (a new anchor) and using it on all frames.
 */
function PreviewView({
  preview,
  stored,
  onStore,
  big,
}: {
  preview: Preview;
  stored: StoredArea | null;
  onStore(s: StoredArea | null): void;
  big?: boolean;
}) {
  const { t } = useTranslation();
  const fb = useFlipbook(preview);
  const v = useView();
  const aspect = fb.size[0] / fb.size[1];
  const n = preview.count;
  const anchors = stored?.anchors ?? [];
  // the area being dragged, and an edited area waiting for "moving or all frames"
  const [draft, setDraft] = useState<Area | null>(null);
  const [choice, setChoice] = useState<Area | null>(null);
  const drag = useRef<{
    id: number;
    mode: 'draw' | 'move' | 'size';
    x: number;
    y: number;
    dx: number;
    dy: number;
  } | null>(null);
  // with a draft or a pending choice, the frame on show has that area
  const shownAnchors = (() => {
    const a = draft ?? choice;
    if (!a) return anchors;
    return [...anchors.filter((x) => x.frame !== fb.frame), { frame: fb.frame, area: a }].sort(
      (p, q) => p.frame - q.frame,
    );
  })();
  const area = areaAt(shownAnchors, fb.frame);
  const isAnchor = anchors.some((a) => a.frame === fb.frame);

  // Escape undoes the drag in progress or the pending edit; nothing else is taken from RapidRAW
  useEffect(() => {
    if (!v.editing) return;
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || (!drag.current && !choice)) return;
      e.stopImmediatePropagation();
      e.preventDefault();
      drag.current = null;
      setDraft(null);
      setChoice(null);
    };
    window.addEventListener('keydown', esc, true);
    return () => window.removeEventListener('keydown', esc, true);
  }, [v.editing, choice]);

  // the curves: brightness inside each frame's area from the grid, without and with the deflicker
  // the preview was rendered with, and the target deflicker would aim for
  const grid = v.grid?.gen === preview.gen ? v.grid.data : null;
  const shown = (() => {
    if (!grid || !shownAnchors.length || !v.showCurves) return null;
    return Array.from({ length: n }, (_, i) => {
      const a = areaAt(shownAnchors, i)!;
      const [w, h] = preview.sizes[preview.size_of[i] ?? 0] ?? [1, 1];
      return gridMean(grid, preview.grid, i, a, w, h);
    });
  })();
  const before = shown?.map((y, i) => withoutCorrection(y, preview.deflicker[i] ?? 0)) ?? null;
  const corrected = preview.deflicker.some((d) => d !== 0);
  const target = (() => {
    if (!before || before.some((y) => !Number.isFinite(y))) return null;
    if (v.constant) return before.map(() => before.reduce((s, y) => s + y, 0) / n);
    return loess(before, v.smoothing);
  })();

  // the grade's numbers in preview order
  const curves = v.curves?.folder === preview.folder ? v.curves.data : null;
  const byFile = new Map((curves?.files ?? []).map((f, k) => [f, k] as [string, number]));
  const per = (series: number[] | undefined) => preview.files.map((f) => series?.[byFile.get(f) ?? -1] ?? NaN);
  const params: Record<string, number[]> = {};
  for (const [k, s] of Object.entries(curves?.values ?? {})) params[k] = per(s);
  if (curves?.hg.some((x) => x !== 0)) params.hg = per(curves.hg);
  if (curves?.deflicker.some((x) => x !== 0)) params.deflicker = per(curves.deflicker);
  const param = params[v.param] ? v.param : 'exposure';
  const keyframes = per(curves?.rating);
  const paramLabel = (k: string) =>
    k === 'hg'
      ? t('editor.timelapse.holyGrailCurve')
      : k === 'deflicker'
        ? t('editor.timelapse.deflickerCurve')
        : label(k);

  const x = (i: number) => (n > 1 ? (i / (n - 1)) * aspect : aspect / 2);
  const line = (ys: (number | null)[]) =>
    ys
      .map((y, i) => (y === null || !Number.isFinite(y) ? null : `${x(i).toFixed(4)},${y.toFixed(4)}`))
      .filter(Boolean)
      .join(' ');
  // brightness: Y' up the photo, as LRT draws its luminance
  const lum = (ys: number[] | null) => (ys ? line(ys.map((y) => 1 - y)) : '');
  // a parameter: EV-like ones around the middle, others between their extremes
  const scaled = (k: string) => {
    const s = params[k] ?? [];
    const ok = s.filter(Number.isFinite);
    if (!ok.length) return [];
    if (k === 'exposure' || k === 'hg' || k === 'deflicker') {
      const r = Math.max(1, ...ok.map(Math.abs));
      return s.map((y) => 0.5 - (0.4 * y) / r);
    }
    const [lo, hi] = [Math.min(...ok), Math.max(...ok)];
    return s.map((y) => (hi > lo ? 0.85 - (0.7 * (y - lo)) / (hi - lo) : 0.5));
  };
  const yellow = scaled(param);

  const at = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * aspect, (e.clientY - r.top) / r.height];
  };
  const inside = (u: number) => Math.min(1, Math.max(0, u));
  const th = ((area?.rot ?? 0) * Math.PI) / 180;
  const dot = area
    ? [
        area.cx * aspect + area.rx * aspect * Math.cos(th) - area.ry * Math.sin(th),
        area.cy + area.rx * aspect * Math.sin(th) + area.ry * Math.cos(th),
      ]
    : null;

  const commit = (a: Area) => {
    if (!anchors.length || isAnchor) {
      const next = [...anchors.filter((p) => p.frame !== fb.frame), { frame: fb.frame, area: a }];
      onStore({ anchors: next.sort((p, q) => p.frame - q.frame), geometry: preview.geometry });
    } else {
      setChoice(a);
    }
  };
  const end = (e: React.PointerEvent<SVGSVGElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    if (draft) commit(draft);
    setDraft(null);
  };

  if (fb.count < 1) return <Text variant={TextVariants.small}>{t('editor.timelapse.previewFailed')}</Text>;
  const width = big ? 'w-[min(90vw,calc(70vh*var(--ar)))]' : 'w-full';
  return (
    <div className="flex flex-col gap-1 items-center">
      <div className={`relative ${width}`} style={{ ['--ar' as string]: aspect }}>
        <canvas
          ref={fb.canvas}
          className="block w-full rounded-md bg-black"
          style={{ aspectRatio: aspect, opacity: v.showPhoto ? 1 : 0 }}
        />
        <svg
          className={`absolute inset-0 w-full h-full touch-none ${v.editing ? 'cursor-crosshair' : 'pointer-events-none'}`}
          viewBox={`0 0 ${aspect} 1`}
          preserveAspectRatio="none"
          onPointerDown={(e) => {
            if (!v.editing || drag.current || choice) return;
            useView.setState({ playing: false });
            const [px, py] = at(e);
            const onDot = dot && Math.hypot(px - dot[0], py - dot[1]) < 0.04;
            let into = false;
            if (area) {
              const [dx, dy] = [px - area.cx * aspect, py - area.cy];
              const [u, w] = [dx * Math.cos(th) + dy * Math.sin(th), -dx * Math.sin(th) + dy * Math.cos(th)];
              into = (u / (area.rx * aspect)) ** 2 + (w / area.ry) ** 2 <= 1;
            }
            const mode = onDot ? 'size' : into ? 'move' : 'draw';
            drag.current = {
              id: e.pointerId,
              mode,
              x: px,
              y: py,
              dx: px - (area?.cx ?? 0) * aspect,
              dy: py - (area?.cy ?? 0),
            };
            e.currentTarget.setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => {
            const d = drag.current;
            if (!d || d.id !== e.pointerId) return;
            const [px, py] = at(e);
            if (d.mode === 'draw') {
              // the ellipse inside the dragged box, drawn once the pointer has really moved
              if (Math.hypot(px - d.x, py - d.y) < 0.01) return;
              setDraft({
                cx: inside((d.x + px) / 2 / aspect),
                cy: inside((d.y + py) / 2),
                rx: Math.max(MIN_RADIUS, Math.abs(px - d.x) / 2 / aspect),
                ry: Math.max(MIN_RADIUS, Math.abs(py - d.y) / 2),
                rot: 0,
              });
            } else if (area && d.mode === 'move') {
              // the centre stays on the photo, so the area is always measurable
              setDraft({ ...area, cx: inside((px - d.dx) / aspect), cy: inside(py - d.dy) });
            } else if (area) {
              // the dot in the ellipse's own axes, RapidRAW's radial formula
              const [dx, dy] = [px - area.cx * aspect, py - area.cy];
              const lx = dx * Math.cos(th) + dy * Math.sin(th);
              const ly = -dx * Math.sin(th) + dy * Math.cos(th);
              setDraft({
                ...area,
                rx: Math.max(MIN_RADIUS, Math.abs(lx) / aspect),
                ry: Math.max(MIN_RADIUS, Math.abs(ly)),
              });
            }
          }}
          onPointerUp={end}
          onPointerCancel={(e) => {
            if (drag.current?.id === e.pointerId) drag.current = null;
            setDraft(null);
          }}
        >
          {v.showCurves && (
            <g fill="none" strokeWidth={big ? 2 : 1.5} vectorEffect="non-scaling-stroke">
              {v.allParams &&
                Object.keys(params)
                  .filter((k) => k !== param)
                  .map((k) => (
                    <polyline
                      key={k}
                      points={line(scaled(k))}
                      stroke={YELLOW}
                      strokeOpacity={0.35}
                      vectorEffect="non-scaling-stroke"
                    />
                  ))}
              <polyline points={line(yellow)} stroke={YELLOW} vectorEffect="non-scaling-stroke" />
              {corrected && <polyline points={lum(shown)} stroke={ORANGE} vectorEffect="non-scaling-stroke" />}
              <polyline points={lum(before)} stroke={BLUE} vectorEffect="non-scaling-stroke" />
              {target && <polyline points={lum(target)} stroke={GREEN} vectorEffect="non-scaling-stroke" />}
              <line
                x1={x(fb.frame)}
                x2={x(fb.frame)}
                y1={0}
                y2={1}
                stroke="white"
                strokeOpacity={0.7}
                strokeDasharray="4 4"
                vectorEffect="non-scaling-stroke"
              />
            </g>
          )}
          {v.showCurves &&
            keyframes.map((r, i) =>
              r >= 1 && Number.isFinite(yellow[i]) ? (
                <rect
                  key={i}
                  x={x(i) - 0.012}
                  y={yellow[i] - 0.018}
                  width={0.024}
                  height={0.036}
                  transform={`rotate(45 ${x(i)} ${yellow[i]})`}
                  fill="#3fa9f5"
                  stroke="black"
                  strokeWidth={0.5}
                  vectorEffect="non-scaling-stroke"
                />
              ) : null,
            )}
          {/* the anchors along the bottom, as LRT marks the frame an area was drawn on */}
          {anchors.map((a) => (
            <rect key={a.frame} x={x(a.frame) - 0.006} y={0.96} width={0.012} height={0.04} fill={ORANGE} />
          ))}
        </svg>
        {/* the area in true proportions (the curves above stretch with the box) */}
        {area && (
          <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox={`0 0 ${aspect} 1`}>
            <ellipse
              cx={area.cx * aspect}
              cy={area.cy}
              rx={area.rx * aspect}
              ry={area.ry}
              transform={`rotate(${area.rot} ${area.cx * aspect} ${area.cy})`}
              fill={v.editing ? 'rgba(255,255,255,0.12)' : 'none'}
              stroke="white"
              strokeOpacity={isAnchor || draft || choice || anchors.length < 2 ? 1 : 0.55}
              strokeWidth={2}
              vectorEffect="non-scaling-stroke"
            />
            {v.editing && dot && <circle cx={dot[0]} cy={dot[1]} r={0.015} fill="white" />}
          </svg>
        )}
      </div>
      <div className={`flex items-center gap-2 ${width}`}>
        <Button onClick={() => useView.setState({ playing: !v.playing })}>{t('editor.timelapse.playPause')}</Button>
        <input
          type="range"
          className="grow"
          min={0}
          max={Math.max(0, fb.count - 1)}
          step={1}
          value={fb.frame}
          onChange={(e) => useView.setState({ playing: false, frame: Number(e.target.value) })}
        />
        <Text variant={TextVariants.small}>
          {fb.frame + 1}/{fb.count}
        </Text>
      </div>
      <div className={`flex flex-wrap items-center gap-x-3 gap-y-1 ${width}`}>
        {(
          [
            ['showCurves', 'curves'],
            ['showPhoto', 'photo'],
            ['allParams', 'allParams'],
          ] as const
        ).map(([key, text]) => (
          <label key={key} className="flex items-center gap-1 text-xs text-text-secondary">
            <input type="checkbox" checked={v[key]} onChange={(e) => useView.setState({ [key]: e.target.checked })} />
            {t(`editor.timelapse.${text}`)}
          </label>
        ))}
        <select
          className="bg-surface text-xs rounded px-1"
          value={param}
          onChange={(e) => useView.setState({ param: e.target.value })}
        >
          {Object.keys(params).map((k) => (
            <option key={k} value={k}>
              {paramLabel(k)}
            </option>
          ))}
        </select>
        {!big && <Button onClick={() => useView.setState({ poppedOut: true })}>{t('editor.timelapse.popOut')}</Button>}
      </div>
      {v.showCurves && (
        <Text variant={TextVariants.small} className={width}>
          <span style={{ color: BLUE }}>{t('editor.timelapse.legendBefore')}</span> ·{' '}
          <span style={{ color: GREEN }}>{t('editor.timelapse.legendTarget')}</span>
          {corrected && (
            <>
              {' '}
              · <span style={{ color: ORANGE }}>{t('editor.timelapse.legendAfter')}</span>
            </>
          )}{' '}
          ·{' '}
          <span style={{ color: YELLOW }}>
            {paramLabel(param)} {Number.isFinite(params[param]?.[fb.frame]) ? params[param][fb.frame].toFixed(2) : ''}
          </span>
        </Text>
      )}
      {v.editing && (
        <div className={`flex flex-col gap-1 ${width}`}>
          <Text variant={TextVariants.small}>{t('editor.timelapse.pickHint')}</Text>
          {choice ? (
            <div className="flex flex-wrap gap-2 items-center">
              <Text variant={TextVariants.small}>{t('editor.timelapse.anchorChoice')}</Text>
              <Button
                onClick={() => {
                  const next = [...anchors, { frame: fb.frame, area: choice }].sort((p, q) => p.frame - q.frame);
                  onStore({ anchors: next, geometry: preview.geometry });
                  setChoice(null);
                }}
              >
                {t('editor.timelapse.addAnchor')}
              </Button>
              <Button
                onClick={() => {
                  onStore({ anchors: [{ frame: fb.frame, area: choice }], geometry: preview.geometry });
                  setChoice(null);
                }}
              >
                {t('editor.timelapse.replaceAll', { n: anchors.length })}
              </Button>
              <Button onClick={() => setChoice(null)}>{t('editor.timelapse.undo')}</Button>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              {isAnchor && anchors.length > 1 && (
                <Button
                  onClick={() =>
                    onStore({ anchors: anchors.filter((a) => a.frame !== fb.frame), geometry: preview.geometry })
                  }
                >
                  {t('editor.timelapse.removeAnchor')}
                </Button>
              )}
              {anchors.length > 0 && <Button onClick={() => onStore(null)}>{t('editor.timelapse.clearArea')}</Button>}
              <Button onClick={() => useView.setState({ editing: false })}>{t('editor.timelapse.doneEditing')}</Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** The same preview, large, over the window; the frame and switches carry over. */
function PopOut(props: { preview: Preview; stored: StoredArea | null; onStore(s: StoredArea | null): void }) {
  const { t } = useTranslation();
  return createPortal(
    <div className="fixed inset-0 z-[900] bg-black/85 flex flex-col items-center justify-center gap-2 p-6 overflow-auto">
      <PreviewView {...props} big />
      <Button autoFocus onClick={() => useView.setState({ poppedOut: false })}>
        {t('editor.timelapse.close')}
      </Button>
    </div>,
    document.body,
  );
}

/** The running action, kept outside the panel so it survives switching panels. */
const useRun = create<{
  busy: boolean;
  stopped: boolean;
  log: string[];
  preview: Preview | null;
}>(() => ({
  busy: false,
  stopped: false,
  log: [],
  preview: null,
}));
const say = (line: string) => useRun.setState((s) => ({ log: [...s.log.slice(-199), line] }));
listen<string>('glidelapse-log', (e) => say(e.payload));

const stop = () => {
  useRun.setState({ stopped: true });
  invoke('glidelapse_cancel').catch((e) => say(String(e)));
};

/**
 * While an action runs nothing in RapidRAW can be clicked: no edit, selection or file operation
 * can interfere with what glidelapse writes. Rendered by App.tsx, so switching panels (or the
 * keyboard shortcut for it) cannot take it away.
 */
export function TimelapseOverlay() {
  const { t } = useTranslation();
  const { busy, log } = useRun();
  const box = useRef<HTMLDivElement>(null);
  // keyboard shortcuts too (panels, ratings, undo): RapidRAW's listeners never see a key; only
  // Enter/Space on the focused Stop button keep their default action, and focus stays there
  useEffect(() => {
    if (!busy) return;
    const block = (e: KeyboardEvent) => {
      e.stopImmediatePropagation();
      if (e.key === 'Tab' || !box.current?.contains(e.target as Node)) e.preventDefault();
    };
    window.addEventListener('keydown', block, true);
    return () => window.removeEventListener('keydown', block, true);
  }, [busy]);
  if (!busy) return null;
  return createPortal(
    <div ref={box} className="fixed inset-0 z-[1000] bg-black/60 flex items-center justify-center">
      <div className="bg-surface rounded-md p-4 flex flex-col gap-2 w-[32rem] max-w-[90vw]">
        <Text variant={TextVariants.small} className="whitespace-pre-wrap break-all max-h-64 overflow-y-auto font-mono">
          {log.slice(-12).join('\n')}
        </Text>
        <Button autoFocus onClick={stop}>
          {t('editor.timelapse.stop')}
        </Button>
      </div>
    </div>,
    document.body,
  );
}

export default function TimelapsePanel() {
  const { t } = useTranslation();
  const folder = useLibraryStore((s) => s.currentFolderPath);
  const frameCount = useLibraryStore((s) => s.imageList.length);
  const { busy, log, preview } = useRun();
  const [keyframes, setKeyframes] = useState(5);
  const [smoothing, setSmoothing] = useState(0.5);
  const [jobs, setJobs] = useState(2);

  const usable = !!folder && !folder.startsWith('Album: ') && !busy;
  const [stored, setStored] = useState<StoredArea | null>(null);
  useEffect(() => setStored(folder ? loadArea(folder) : null), [folder]);
  const store = (s: StoredArea | null) => {
    setStored(s);
    if (folder) saveArea(folder, s);
  };
  const view = useView();
  const mine = preview?.folder === folder ? preview : null;

  // the brightness grid with each new preview; the folder's curves with it, after every action
  // (run) and a little after edits in the editor are saved
  useEffect(() => {
    if (mine && useView.getState().grid?.gen !== mine.gen) loadGrid(mine);
  }, [mine]);
  useEffect(() => {
    if (folder && mine) loadCurves(folder);
  }, [folder, mine]);
  useEffect(() => {
    let timer = 0;
    const off = useEditorStore.subscribe((s, old) => {
      if (s.adjustments === old.adjustments) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const f = useLibraryStore.getState().currentFolderPath;
        if (f && !useRun.getState().busy && useRun.getState().preview?.folder === f) loadCurves(f);
      }, 2000);
    });
    return () => {
      off();
      window.clearTimeout(timer);
    };
  }, []);
  // deflicker needs the area big enough on every frame (glidelapse would refuse it)
  const tooSmall = (() => {
    if (!mine || !stored) return -1;
    for (let i = 0; i < mine.count; i++) {
      const a = areaAt(stored.anchors, i)!;
      const [w, h] = mine.sizes[mine.size_of[i] ?? 0] ?? [1, 1];
      if (pixelsIn(a, w, h) < 300) return i;
    }
    return -1;
  })();

  /** Runs the steps in order, then `after` while still busy (no other action can start before it
   * is done); true when all steps finished. */
  const run = async (confirmText: string | null, steps: string[][], after?: (ok: boolean) => Promise<void>) => {
    if (!usable || !folder || useRun.getState().busy) return false;
    useRun.setState({ busy: true, stopped: false, log: [] });
    try {
      if (confirmText && !(await ask(confirmText, { title: 'GlideLapse', kind: 'warning' }))) return false;
      // the open photo's latest edits must be on disk before glidelapse reads the sidecars; when
      // that fails nothing runs and nothing reloads (the outer catch)
      const { selectedImage, adjustments: current } = useEditorStore.getState();
      debouncedSave.cancel();
      if (selectedImage?.isReady) {
        await invoke(Invokes.SaveMetadataAndUpdateThumbnail, { path: selectedImage.path, adjustments: current });
      }
      // the action changes the grade (or remakes the preview): the shown preview is from before it
      useRun.setState((s) => ({ preview: s.preview && { ...s.preview, outdated: true } }));
      let ok = true;
      try {
        for (const args of steps) {
          if (useRun.getState().stopped) {
            ok = false;
            break;
          }
          say(`$ glidelapse ${args.join(' ')}`);
          if ((await invoke<number>('glidelapse_run', { args })) !== 0) {
            say(t('editor.timelapse.failed'));
            ok = false;
            break;
          }
        }
      } catch (e) {
        say(String(e));
        ok = false;
      }
      // glidelapse rewrote the sidecars: App.tsx reopens the folder, the curves follow
      window.dispatchEvent(new Event('glidelapse-refresh'));
      await after?.(ok);
      if (useRun.getState().preview?.folder === folder) await loadCurves(folder);
      return ok;
    } catch (e) {
      say(String(e));
      return false;
    } finally {
      useRun.setState({ busy: false });
    }
  };

  const exportVideo = async () => {
    const out = await open({ directory: true, title: t('editor.timelapse.exportVideo') });
    if (typeof out !== 'string' || !folder) return;
    run(null, [
      ['export', folder, '--out', out, '--jobs', String(jobs)],
      ['video', out, '--out', `${out}/glidelapse.mp4`],
    ]);
  };

  // every frame as graded now, 1280 px JPEGs in RapidRAW's cache folder (asset scope), played as a
  // flipbook; a new generation number makes the image URLs new
  const showPreview = async () => {
    if (!folder) return;
    const dir = await join(await appCacheDir(), 'glidelapse', 'preview');
    const started = Date.now();
    await run(null, [['preview', folder, '--frames', dir, '--jobs', String(jobs)]], async (ok) => {
      // glidelapse swaps the new frames in at its very end, so even a stopped run may have replaced
      // them: show what the folder holds whenever this run wrote it, else keep the old preview
      try {
        const info = await invoke<Omit<Preview, 'folder' | 'dir' | 'gen' | 'outdated'>>('glidelapse_preview_frames');
        if (ok || info.made >= started) useRun.setState({ preview: { folder, dir, ...info, gen: Date.now() } });
      } catch (e) {
        say(String(e));
        useRun.setState({ preview: null });
      }
    });
  };

  return (
    <div className="flex flex-col h-full">
      <div className="p-3 flex justify-between items-center shrink-0 border-b border-surface">
        <Text variant={TextVariants.title}>{t('editor.timelapse.title')}</Text>
      </div>
      <div className="grow overflow-y-auto p-3 custom-scrollbar flex flex-col gap-2">
        {mine && !view.poppedOut && <PreviewView preview={mine} stored={stored} onStore={store} />}
        {mine && view.poppedOut && <PopOut preview={mine} stored={stored} onStore={store} />}
        {preview?.folder === folder && preview.outdated && (
          <Text variant={TextVariants.small}>{t('editor.timelapse.previewOutdated')}</Text>
        )}
        {preview?.folder === folder && stored && stored.geometry !== preview.geometry && (
          <Text variant={TextVariants.small}>{t('editor.timelapse.areaOutdated')}</Text>
        )}
        <Button disabled={!usable} onClick={showPreview}>
          {t('editor.timelapse.preview')}
        </Button>
        <Slider
          label={t('editor.timelapse.keyframes')}
          min={2}
          max={Math.max(2, frameCount)}
          step={1}
          value={keyframes}
          onChange={(e) => setKeyframes(Number(e.target.value))}
        />
        <Button
          disabled={!usable}
          onClick={() =>
            run(t('editor.timelapse.confirmKeyframes', { n: keyframes }), [
              ['keyframes', folder!, '--count', String(keyframes)],
            ])
          }
        >
          1. {t('editor.timelapse.setKeyframes')}
        </Button>
        <Button
          disabled={!usable}
          onClick={() => run(t('editor.timelapse.confirmHolyGrail'), [['holygrail', folder!]])}
        >
          2. {t('editor.timelapse.holyGrail')}
        </Button>
        <Button disabled={!usable} onClick={() => run(t('editor.timelapse.confirmMasks'), [['masks', folder!]])}>
          3. {t('editor.timelapse.addMasks')}
        </Button>
        <Text variant={TextVariants.small}>4. {t('editor.timelapse.editKeyframes')}</Text>
        <Slider
          label={t('editor.timelapse.smoothing')}
          min={0}
          max={1}
          step={0.05}
          value={smoothing}
          onChange={(e) => setSmoothing(Number(e.target.value))}
        />
        <Button
          disabled={!usable}
          onClick={() => run(t('editor.timelapse.confirmRamp'), [['ramp', folder!, '--smoothing', String(smoothing)]])}
        >
          5. {t('editor.timelapse.ramp')}
        </Button>
        <Button
          disabled={!usable || !mine?.count}
          onClick={() => useView.setState({ editing: !view.editing, playing: view.editing && view.playing })}
        >
          6. {t('editor.timelapse.pickOnPreview')}
        </Button>
        <Slider
          label={t('editor.timelapse.deflickerSmoothing')}
          min={0.02}
          max={1}
          step={0.01}
          value={view.smoothing}
          onChange={(e) => useView.setState({ smoothing: Number(e.target.value) })}
        />
        <label className="flex items-center gap-1 text-xs text-text-secondary">
          <input
            type="checkbox"
            checked={view.constant}
            onChange={(e) => useView.setState({ constant: e.target.checked })}
          />
          {t('editor.timelapse.constant')}
        </label>
        {tooSmall >= 0 && (
          <Text variant={TextVariants.small}>{t('editor.timelapse.areaTooSmall', { frame: tooSmall + 1 })}</Text>
        )}
        <Button
          disabled={!usable || !stored || tooSmall >= 0}
          onClick={() =>
            stored &&
            run(t('editor.timelapse.confirmDeflicker'), [
              [
                'deflicker',
                folder!,
                '--ellipse',
                ellipseArg(stored.anchors),
                // glidelapse refuses the area once the frames' crops changed since its preview
                '--geometry',
                stored.geometry,
                '--smoothing',
                String(view.smoothing),
                ...(view.constant ? ['--constant'] : []),
                '--passes',
                '2',
                '--fast',
                '--jobs',
                String(jobs),
              ],
            ])
          }
        >
          7. {t('editor.timelapse.deflicker')}
        </Button>
        <Button disabled={!usable} onClick={exportVideo}>
          8. {t('editor.timelapse.exportVideo')}
        </Button>
        <Slider
          label={t('editor.timelapse.jobs')}
          min={1}
          max={8}
          step={1}
          value={jobs}
          onChange={(e) => setJobs(Number(e.target.value))}
        />
        {!busy && log.length > 0 && (
          <Text
            variant={TextVariants.small}
            className="whitespace-pre-wrap break-all max-h-32 overflow-y-auto font-mono"
          >
            {log.slice(-8).join('\n')}
          </Text>
        )}
      </div>
    </div>
  );
}
