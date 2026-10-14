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
 * every frame size, the frames' geometry), one generation per Preview run. */
type Preview = { folder: string; dir: string; count: number; sizes: [number, number][]; geometry: string; gen: number };

/** The sequence's reference area with the geometry of the preview it was drawn on (deflicker
 * refuses it once the frames' crops changed); kept per folder, in memory and in this window's
 * storage (LRT keeps its area per sequence too, F94). */
type StoredArea = { area: Area; geometry: string };
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
const loadArea = (folder: string): StoredArea | null => {
  const kept = areas.get(folder);
  if (kept) return kept;
  try {
    const v = JSON.parse(localStorage.getItem(AREA_KEY + folder) ?? 'null');
    return v && isArea(v.area) && typeof v.geometry === 'string' ? { area: v.area, geometry: v.geometry } : null;
  } catch {
    return null;
  }
};
const saveArea = (folder: string, stored: StoredArea) => {
  areas.set(folder, stored);
  try {
    localStorage.setItem(AREA_KEY + folder, JSON.stringify(stored));
  } catch {
    // storage unavailable: the area lasts while RapidRAW runs
  }
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

/** The reference area's outline over a preview canvas (viewBox 0..aspect x 0..1). */
function AreaOutline({ area, aspect }: { area: Area; aspect: number }) {
  const [cx, rx] = [area.cx * aspect, area.rx * aspect];
  return (
    <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox={`0 0 ${aspect} 1`}>
      <ellipse
        cx={cx}
        cy={area.cy}
        rx={rx}
        ry={area.ry}
        transform={`rotate(${area.rot} ${cx} ${area.cy})`}
        fill="none"
        stroke="white"
        strokeWidth={1.5}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

/**
 * The preview played as a flipbook of its frames (LOG F96: WebKitGTK shows <video> scrambled or
 * grey on some Linux GPUs, while images it shows everywhere). A frame is decoded before it
 * replaces the last one on the canvas, so nothing flashes; each stays up 40 ms (25 a second at
 * most), and a slow decode makes playback wait, never skip, so flicker stays visible. Four frames
 * are decoded ahead.
 */
function useFlipbook(p: Preview, active: boolean) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(true);
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
  // a new preview starts at its first frame
  useEffect(() => {
    pending.current.clear();
    setFrame(0);
    setCount(p.count);
  }, [p.gen, p.count]);
  useEffect(() => {
    if (count < 1) return;
    let live = true;
    let timer = 0;
    for (const k of pending.current.keys()) if ((k - frame + count) % count > 4) pending.current.delete(k);
    for (let k = 1; k <= 4 && k < count; k++) load((frame + k) % count).catch(() => {});
    load(frame).then(
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
        if (playing && active && count > 1) {
          timer = window.setTimeout(() => setFrame((f) => (f + 1) % count), 40);
        }
      },
      () => {
        if (!live) return;
        setCount(frame);
        setFrame(0);
      },
    );
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [frame, playing, active, count, load]);
  return { canvas, frame, setFrame, playing, setPlaying, count, size };
}

/** Play/pause, a frame slider (stops playback) and the frame number. */
function FlipbookControls({ fb, className }: { fb: ReturnType<typeof useFlipbook>; className?: string }) {
  const { t } = useTranslation();
  return (
    <div className={`flex items-center gap-2 ${className ?? ''}`}>
      <Button onClick={() => fb.setPlaying(!fb.playing)}>{t('editor.timelapse.playPause')}</Button>
      <input
        type="range"
        className="grow"
        min={0}
        max={Math.max(0, fb.count - 1)}
        step={1}
        value={fb.frame}
        onChange={(e) => {
          fb.setPlaying(false);
          fb.setFrame(Number(e.target.value));
        }}
      />
      <Text variant={TextVariants.small}>
        {fb.frame + 1}/{fb.count}
      </Text>
    </div>
  );
}

function Flipbook({ preview, active, area }: { preview: Preview; active: boolean; area: Area | null }) {
  const { t } = useTranslation();
  const fb = useFlipbook(preview, active);
  if (fb.count < 1) return <Text variant={TextVariants.small}>{t('editor.timelapse.previewFailed')}</Text>;
  return (
    <div className="flex flex-col gap-1">
      <div className="relative">
        <canvas ref={fb.canvas} className="block w-full rounded-md bg-black" />
        {area && <AreaOutline area={area} aspect={fb.size[0] / fb.size[1]} />}
      </div>
      <FlipbookControls fb={fb} />
    </div>
  );
}

/**
 * The preview flipbook in a pop-out with the reference ellipse on top: the area is chosen while the
 * whole sequence plays under it, not on one photo (LRTimelapse draws its area on
 * the sequence preview): drag inside to move it, the white dot to resize it in its own axes, the
 * slider to stop on any frame and look for clouds passing. Keys are swallowed while it is open
 * (Escape cancels).
 */
function ReferencePicker({
  preview,
  initial,
  onSave,
  onCancel,
}: {
  preview: Preview;
  initial: Area;
  onSave(a: Area): void;
  onCancel(): void;
}) {
  const { t } = useTranslation();
  const [a, setA] = useState(initial);
  const fb = useFlipbook(preview, true);
  // the frame on show sets the shape; the area is a fraction of each frame
  const aspect = fb.size[0] / fb.size[1];
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; move: boolean; dx: number; dy: number } | null>(null);
  useEffect(() => {
    const block = (e: KeyboardEvent) => {
      e.stopImmediatePropagation();
      if (e.key === 'Escape') onCancel();
      if (e.key === 'Escape' || e.key === 'Tab' || !box.current?.contains(e.target as Node)) e.preventDefault();
    };
    window.addEventListener('keydown', block, true);
    return () => window.removeEventListener('keydown', block, true);
  }, [onCancel]);

  // viewBox units: x in [0, aspect], y in [0, 1], so circles and rotations look as on the photo
  const cx = a.cx * aspect;
  const rx = a.rx * aspect;
  const th = (a.rot * Math.PI) / 180;
  const dot = [cx + rx * Math.cos(th) - a.ry * Math.sin(th), a.cy + rx * Math.sin(th) + a.ry * Math.cos(th)];
  const at = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * aspect, (e.clientY - r.top) / r.height];
  };
  const inside = (v: number) => Math.min(1, Math.max(0, v));
  const end = (e: React.PointerEvent<SVGSVGElement>) => {
    if (drag.current?.id === e.pointerId) drag.current = null;
  };
  // big enough on every frame size of the sequence, or deflicker would refuse it
  const tooSmall = preview.sizes.some(([w, h]) => pixelsIn(a, w, h) < 300);
  const width = { ['--ar' as string]: aspect };

  return createPortal(
    <div ref={box} className="fixed inset-0 z-[900] bg-black/80 flex flex-col items-center justify-center gap-3 p-6">
      <div className="relative w-[min(90vw,calc(70vh*var(--ar)))]" style={width}>
        <canvas ref={fb.canvas} className="block w-full" style={{ aspectRatio: aspect }} />
        <svg
          className="absolute inset-0 w-full h-full touch-none"
          viewBox={`0 0 ${aspect} 1`}
          onPointerDown={(e) => {
            if (drag.current) return;
            const [x, y] = at(e);
            const onDot = Math.hypot(x - dot[0], y - dot[1]) < 0.04;
            drag.current = { id: e.pointerId, move: !onDot, dx: x - cx, dy: y - a.cy };
            e.currentTarget.setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => {
            const d = drag.current;
            if (!d || d.id !== e.pointerId) return;
            const [x, y] = at(e);
            if (d.move) {
              // the centre stays on the photo, so the area is always measurable
              setA({ ...a, cx: inside((x - d.dx) / aspect), cy: inside(y - d.dy) });
              return;
            }
            // the dot in the ellipse's own axes, RapidRAW's radial formula
            const [dx, dy] = [x - cx, y - a.cy];
            const lx = dx * Math.cos(th) + dy * Math.sin(th);
            const ly = -dx * Math.sin(th) + dy * Math.cos(th);
            setA({ ...a, rx: Math.max(MIN_RADIUS, Math.abs(lx) / aspect), ry: Math.max(MIN_RADIUS, Math.abs(ly)) });
          }}
          onPointerUp={end}
          onPointerCancel={end}
          onLostPointerCapture={end}
        >
          <ellipse
            cx={cx}
            cy={a.cy}
            rx={rx}
            ry={a.ry}
            transform={`rotate(${a.rot} ${cx} ${a.cy})`}
            fill="rgba(255,255,255,0.15)"
            stroke="white"
            strokeWidth={2}
            vectorEffect="non-scaling-stroke"
          />
          <circle cx={dot[0]} cy={dot[1]} r={0.015} fill="white" />
        </svg>
      </div>
      <FlipbookControls fb={fb} className="w-[min(90vw,calc(70vh*var(--ar)))]" />
      <Text variant={TextVariants.small}>
        {t(tooSmall ? 'editor.timelapse.areaTooSmall' : 'editor.timelapse.pickHint')}
      </Text>
      <div className="flex gap-2">
        <Button autoFocus disabled={tooSmall} onClick={() => onSave(a)}>
          {t('editor.timelapse.useArea')}
        </Button>
        <Button onClick={onCancel}>{t('editor.timelapse.cancel')}</Button>
      </div>
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
/** Counts started actions: a preview still being looked up when another action began is outdated. */
let actions = 0;
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
  // the area being placed on the preview (null: pop-out closed)
  const [picking, setPicking] = useState<Area | null>(null);

  /** Runs the steps in order; true when all of them finished. */
  const run = async (confirmText: string | null, ...steps: string[][]) => {
    if (!usable || !folder || useRun.getState().busy) return false;
    // every action changes the grade (or remakes the preview): an older preview would mislead
    actions += 1;
    useRun.setState({ busy: true, stopped: false, log: [], preview: null });
    try {
      if (confirmText && !(await ask(confirmText, { title: 'GlideLapse', kind: 'warning' }))) return false;
      // the open photo's latest edits must be on disk before glidelapse reads the sidecars
      const { selectedImage, adjustments: current } = useEditorStore.getState();
      debouncedSave.cancel();
      if (selectedImage?.isReady) {
        await invoke(Invokes.SaveMetadataAndUpdateThumbnail, { path: selectedImage.path, adjustments: current });
      }
      let ok = true;
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
      // glidelapse rewrote the sidecars: App.tsx reopens the folder
      window.dispatchEvent(new Event('glidelapse-refresh'));
      return ok;
    } catch (e) {
      say(String(e));
      return false;
    } finally {
      useRun.setState({ busy: false });
    }
  };

  // the pop-out starts from the folder's area or a centred circle
  const pickOnPreview = () => {
    if (!preview) return;
    const [w, h] = preview.sizes[0] ?? [1, 1];
    setPicking(stored?.area ?? { cx: 0.5, cy: 0.5, rx: 0.15, ry: (0.15 * w) / h, rot: 0 });
  };

  const exportVideo = async () => {
    const out = await open({ directory: true, title: t('editor.timelapse.exportVideo') });
    if (typeof out !== 'string' || !folder) return;
    run(
      null,
      ['export', folder, '--out', out, '--jobs', String(jobs)],
      ['video', out, '--out', `${out}/glidelapse.mp4`],
    );
  };

  // every frame as graded now, 1280 px JPEGs in RapidRAW's cache folder (asset scope), played as a
  // flipbook; a new generation number makes the image URLs new
  const showPreview = async () => {
    if (!folder) return;
    const dir = await join(await appCacheDir(), 'glidelapse', 'preview');
    if (!(await run(null, ['preview', folder, '--frames', dir, '--jobs', String(jobs)]))) return;
    const mine = actions;
    try {
      // as many as glidelapse published (it skips files RapidRAW lists, and the list may still load)
      const info = await invoke<{ count: number; sizes: [number, number][]; geometry: string }>(
        'glidelapse_preview_frames',
      );
      if (actions !== mine) return;
      useRun.setState({ preview: { folder, dir, ...info, gen: Date.now() } });
    } catch (e) {
      say(String(e));
    }
  };

  return (
    <div className="flex flex-col h-full">
      <div className="p-3 flex justify-between items-center shrink-0 border-b border-surface">
        <Text variant={TextVariants.title}>{t('editor.timelapse.title')}</Text>
      </div>
      <div className="grow overflow-y-auto p-3 custom-scrollbar flex flex-col gap-2">
        {preview?.folder === folder && <Flipbook preview={preview} active={!picking} area={stored?.area ?? null} />}
        {preview?.folder === folder && stored && stored.geometry !== preview.geometry && (
          <Text variant={TextVariants.small}>{t('editor.timelapse.areaOutdated')}</Text>
        )}
        <Button disabled={!usable} onClick={showPreview}>
          {t('editor.timelapse.preview')}
        </Button>
        <Button disabled={!usable || preview?.folder !== folder || !preview?.count} onClick={pickOnPreview}>
          {t('editor.timelapse.pickOnPreview')}
        </Button>
        {picking && preview && folder && (
          <ReferencePicker
            preview={preview}
            initial={picking}
            onCancel={() => setPicking(null)}
            onSave={(a) => {
              const s = { area: a, geometry: preview.geometry };
              setStored(s);
              saveArea(folder, s);
              setPicking(null);
            }}
          />
        )}
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
              'keyframes',
              folder!,
              '--count',
              String(keyframes),
            ])
          }
        >
          {t('editor.timelapse.setKeyframes')}
        </Button>
        <Slider
          label={t('editor.timelapse.smoothing')}
          min={0}
          max={1}
          step={0.05}
          value={smoothing}
          onChange={(e) => setSmoothing(Number(e.target.value))}
        />
        <div className="grid grid-cols-2 gap-2">
          <Button
            disabled={!usable}
            onClick={() => run(t('editor.timelapse.confirmRamp'), ['ramp', folder!, '--smoothing', String(smoothing)])}
          >
            {t('editor.timelapse.ramp')}
          </Button>
          <Button
            disabled={!usable}
            onClick={() => run(t('editor.timelapse.confirmHolyGrail'), ['holygrail', folder!])}
          >
            {t('editor.timelapse.holyGrail')}
          </Button>
          <Button
            disabled={!usable || !stored}
            onClick={() =>
              stored &&
              run(t('editor.timelapse.confirmDeflicker'), [
                'deflicker',
                folder!,
                '--ellipse',
                [stored.area.cx, stored.area.cy, stored.area.rx, stored.area.ry, stored.area.rot]
                  .map((v) => v.toFixed(5))
                  .join(','),
                // glidelapse refuses the area once the frames' crops changed since its preview
                '--geometry',
                stored.geometry,
                '--passes',
                '2',
                '--fast',
                '--jobs',
                String(jobs),
              ])
            }
          >
            {t('editor.timelapse.deflicker')}
          </Button>
          <Button disabled={!usable} onClick={() => run(t('editor.timelapse.confirmMasks'), ['masks', folder!])}>
            {t('editor.timelapse.addMasks')}
          </Button>
          <Button disabled={!usable} onClick={exportVideo}>
            {t('editor.timelapse.exportVideo')}
          </Button>
        </div>
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
