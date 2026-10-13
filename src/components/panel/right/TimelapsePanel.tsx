// GlideLapse (timelapse grading, https://github.com/a15600712/glidelapse): the Timelapse panel.
// Every action runs the installed `glidelapse` program on the open folder through the
// `glidelapse_run` command. While it runs, RapidRAW's sidecar writes are refused
// (glidelapse::guarded) and an overlay blocks the window; afterwards the folder is reopened.
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { appCacheDir, join } from '@tauri-apps/api/path';
import { ask, open } from '@tauri-apps/plugin-dialog';
import { useTranslation } from 'react-i18next';
import { create } from 'zustand';
import Button from '../../ui/Button';
import Slider from '../../ui/Slider';
import Text from '../../ui/Text';
import { Invokes, Panel } from '../../ui/AppProperties';
import { TextVariants } from '../../../types/typography';
import { Mask } from './Masks';
import { useEditorStore } from '../../../store/useEditorStore';
import { useLibraryStore } from '../../../store/useLibraryStore';
import { useUIStore } from '../../../store/useUIStore';
import { debouncedSave, useEditorActions } from '../../../hooks/useEditorActions';
import { INITIAL_MASK_ADJUSTMENTS, INITIAL_MASK_CONTAINER } from '../../../utils/adjustments';
import { createSubMask } from '../../../utils/maskUtils';

/** The deflicker reference area: a radial mask glidelapse only reads. */
const REFERENCE_ID = 'glidelapse-reference';

/** An ellipse as fractions of the visible photo: centre, radii of its width and height, and its
 * rotation in degrees (clockwise on screen, as RapidRAW's radial mask). */
type Area = { cx: number; cy: number; rx: number; ry: number; rot: number };

/** Smallest radius, as a fraction of the photo side: about 30 px on deflicker's 1024 px renders,
 * well above the 256 pixels a measurement needs. */
const MIN_RADIUS = 0.03;

/**
 * The preview video in a pop-out with the reference ellipse on top (LRTimelapse draws its area on
 * the sequence preview): drag inside to move it, the white dot to resize it in its own axes, the
 * slider to stop on any frame and look for clouds passing. Keys are swallowed while it is open
 * (Escape cancels), so the photo or its geometry underneath cannot change.
 */
function ReferencePicker({
  src,
  size,
  initial,
  onSave,
  onCancel,
}: {
  src: string;
  /** the visible photo in pixels (the crop) */
  size: { width: number; height: number };
  initial: Area;
  onSave(a: Area): void;
  onCancel(): void;
}) {
  const { t } = useTranslation();
  const aspect = size.width / size.height;
  const [a, setA] = useState(initial);
  const [time, setTime] = useState(0);
  const video = useRef<HTMLVideoElement>(null);
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
  // pixels of the photo inside the ellipse on deflicker's 1024 px measurement, counted exactly as
  // glidelapse's area_mean does (pixel centres, RapidRAW's radial formula); it needs 256, and 300
  // leaves room for the render size rounding by a pixel. The count stops once it is enough.
  // deflicker renders at most 1024 px on the long side and never enlarges a smaller crop
  const scale = Math.min(1, 1024 / Math.max(size.width, size.height));
  const [mw, mh] = [Math.max(1, Math.round(size.width * scale)), Math.max(1, Math.round(size.height * scale))];
  const [ecx, ecy, erx, ery] = [a.cx * mw, a.cy * mh, a.rx * mw, a.ry * mh];
  const [ex, ey] = [
    Math.hypot(erx * Math.cos(th), ery * Math.sin(th)),
    Math.hypot(erx * Math.sin(th), ery * Math.cos(th)),
  ];
  const on = (v: number, n: number) => Math.min(n, Math.max(0, v));
  let pixels = 0;
  rows: for (let y = on(Math.floor(ecy - ey), mh); y < on(Math.ceil(ecy + ey), mh); y++) {
    for (let x = on(Math.floor(ecx - ex), mw); x < on(Math.ceil(ecx + ex), mw); x++) {
      const [dx, dy] = [x + 0.5 - ecx, y + 0.5 - ecy];
      const [u, v] = [dx * Math.cos(th) + dy * Math.sin(th), -dx * Math.sin(th) + dy * Math.cos(th)];
      if ((u / erx) ** 2 + (v / ery) ** 2 <= 1 && ++pixels >= 300) break rows;
    }
  }
  const tooSmall = pixels < 300;
  const width = { ['--ar' as string]: aspect };

  return createPortal(
    <div ref={box} className="fixed inset-0 z-[900] bg-black/80 flex flex-col items-center justify-center gap-3 p-6">
      <div className="relative w-[min(90vw,calc(70vh*var(--ar)))]" style={width}>
        <video
          ref={video}
          src={src}
          className="block w-full"
          style={{ aspectRatio: aspect }}
          autoPlay
          loop
          muted
          onTimeUpdate={(e) => setTime(e.currentTarget.currentTime / (e.currentTarget.duration || 1))}
        />
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
      <input
        type="range"
        min={0}
        max={1}
        step={0.001}
        value={time}
        className="w-[min(90vw,calc(70vh*var(--ar)))]"
        style={width}
        onChange={(e) => {
          const v = video.current;
          if (!v) return;
          v.pause();
          v.currentTime = Number(e.target.value) * (v.duration || 0);
          setTime(Number(e.target.value));
        }}
      />
      <Text variant={TextVariants.small}>
        {t(tooSmall ? 'editor.timelapse.areaTooSmall' : 'editor.timelapse.pickHint')}
      </Text>
      <div className="flex gap-2">
        <Button onClick={() => (video.current?.paused ? video.current.play() : video.current?.pause())}>
          {t('editor.timelapse.playPause')}
        </Button>
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
  /** geom: the visible photo's geometry it was made with; the picker maps onto that */
  preview: { folder: string; src: string; geom: string } | null;
}>(() => ({
  busy: false,
  stopped: false,
  log: [],
  preview: null,
}));
const say = (line: string) => useRun.setState((s) => ({ log: [...s.log.slice(-199), line] }));
/** Counts started actions: a preview video still loading when another action began is outdated. */
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
  const adjustments = useEditorStore((s) => s.adjustments);
  const { setAdjustments } = useEditorActions();
  const folder = useLibraryStore((s) => s.currentFolderPath);
  const frameCount = useLibraryStore((s) => s.imageList.length);
  const selectedImage = useEditorStore((s) => s.selectedImage);
  const selectedPath = selectedImage?.path;
  const originalSize = useEditorStore((s) => s.originalSize);
  // RapidRAW's decoded size, from where its own Masks panel takes it; 0 until the photo has loaded
  const dims = {
    width: selectedImage?.width || originalSize.width,
    height: selectedImage?.height || originalSize.height,
  };
  const { busy, log, preview } = useRun();
  const [keyframes, setKeyframes] = useState(5);
  const [smoothing, setSmoothing] = useState(0.5);
  const [jobs, setJobs] = useState(2);

  const usable = !!folder && !folder.startsWith('Album: ') && !busy;
  const reference = (adjustments.masks || []).find((m) => m.id === REFERENCE_ID)?.subMasks[0];
  // a reference drawn before the size was known is a dot at 0,0: it counts as none and is replaced
  const hasReference = !!reference?.parameters?.radiusX;
  // the reference being placed on the preview, for the photo it was opened on (null: closed)
  const [picking, setPicking] = useState<{ area: Area; path: string } | null>(null);
  // virtual copies share the photo's file; glidelapse works on files and their sidecars
  const referenceFile = selectedPath && !selectedPath.includes('?vc=') ? selectedPath.split('/').pop() : undefined;

  /** Runs the steps in order; true when all of them finished. */
  const run = async (confirmText: string | null, ...steps: string[][]) => {
    if (!usable || !folder || useRun.getState().busy) return false;
    // every action changes the grade (or remakes the preview): an older video would mislead
    const old = useRun.getState().preview?.src;
    if (old) URL.revokeObjectURL(old);
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

  // the visible photo in mask coordinates: the crop as RapidRAW renders it (rounded, clipped to
  // the photo; glidelapse's effective_crop), or the whole photo, sides swapped by a quarter turn
  const frame = () => {
    const turned = (adjustments.orientationSteps ?? 0) % 2 === 1;
    const [w, h] = turned ? [dims.height, dims.width] : [dims.width, dims.height];
    const c = adjustments.crop;
    const r = (v: number) => Math.max(0, Math.round(v));
    if (c && r(c.width) > 0 && r(c.height) > 0 && r(c.x) < w && r(c.y) < h) {
      const [x, y] = [r(c.x), r(c.y)];
      return { x, y, width: Math.min(r(c.width), w - x), height: Math.min(r(c.height), h - y) };
    }
    return { x: 0, y: 0, width: w, height: h };
  };
  // everything that moves pixels between the video and the mask (glidelapse's GEOMETRY_KEYS)
  const geom = () =>
    JSON.stringify([
      frame(),
      adjustments.orientationSteps ?? 0,
      adjustments.rotation ?? 0,
      adjustments.flipHorizontal ?? false,
      adjustments.flipVertical ?? false,
    ]);

  // the reference as a radial mask on this frame; the container stays hidden, so RapidRAW never
  // renders it however it is edited, and deflicker measures the same spot on every frame
  const putReference = (a: Area) => {
    const f = frame();
    const base = createSubMask(Mask.Radial, { width: f.width, height: f.height });
    const shape = {
      ...base,
      parameters: {
        ...base.parameters,
        centerX: f.x + a.cx * f.width,
        centerY: f.y + a.cy * f.height,
        radiusX: a.rx * f.width,
        radiusY: a.ry * f.height,
        rotation: a.rot,
      },
    };
    const container = {
      ...INITIAL_MASK_CONTAINER,
      id: REFERENCE_ID,
      name: t('editor.timelapse.referenceMask'),
      visible: false,
      adjustments: { ...INITIAL_MASK_ADJUSTMENTS },
      subMasks: [shape],
    };
    setAdjustments((prev) => ({
      ...prev,
      masks: [...(prev.masks || []).filter((m) => m.id !== REFERENCE_ID), container],
    }));
    return shape.id;
  };

  // a quarter-width circle in the middle, selected in the Masks panel to be moved (the ellipse
  // itself is selected, not only its mask: RapidRAW shows handles on the active sub-mask)
  const setReference = () => {
    const f = frame();
    const shapeId = hasReference
      ? reference!.id
      : putReference({ cx: 0.5, cy: 0.5, rx: 0.25, ry: (0.25 * f.width) / f.height, rot: 0 });
    useEditorStore.getState().setEditor({ activeMaskContainerId: REFERENCE_ID, activeMaskId: shapeId });
    useUIStore.getState().setPanel(Panel.Masks);
  };

  // the pop-out starts from the current reference or a centred circle
  const pickOnPreview = () => {
    if (!selectedPath) return;
    const f = frame();
    const p = reference?.parameters;
    const area =
      hasReference && p
        ? {
            cx: Math.min(1, Math.max(0, (p.centerX - f.x) / f.width)),
            cy: Math.min(1, Math.max(0, (p.centerY - f.y) / f.height)),
            rx: Math.max(MIN_RADIUS, p.radiusX / f.width),
            ry: Math.max(MIN_RADIUS, p.radiusY / f.height),
            rot: p.rotation ?? 0,
          }
        : { cx: 0.5, cy: 0.5, rx: 0.15, ry: (0.15 * f.width) / f.height, rot: 0 };
    setPicking({ area, path: selectedPath });
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

  // a 1280 px video of every frame as graded now, in RapidRAW's cache folder (asset scope)
  const showPreview = async () => {
    if (!folder) return;
    const file = await join(await appCacheDir(), 'glidelapse', 'preview.mp4');
    const made = geom();
    if (!(await run(null, ['preview', folder, '--out', file, '--jobs', String(jobs)]))) return;
    const mine = actions;
    try {
      // a Blob URL: WebKitGTK does not play video from the asset protocol
      const bytes = await invoke<ArrayBuffer>('glidelapse_preview_video');
      // ponytail: diagnostics while the Linux playback problem is open (LOG F96); drop once it plays
      const kind = `${Object.prototype.toString.call(bytes)} ${(bytes as ArrayBuffer)?.byteLength ?? (bytes as unknown as unknown[])?.length}`;
      console.error(`[glidelapse] preview bytes: ${kind}`);
      say(`preview bytes: ${kind}`);
      // another action started while the bytes came over: this video no longer shows the grade
      if (actions !== mine) return;
      const src = URL.createObjectURL(new Blob([bytes], { type: 'video/mp4' }));
      const old = useRun.getState().preview?.src;
      if (old) URL.revokeObjectURL(old);
      useRun.setState({ preview: { folder, src, geom: made } });
    } catch (e) {
      say(String(e));
    }
  };

  const size = `${dims.width},${dims.height}`;
  const f = frame();

  return (
    <div className="flex flex-col h-full">
      <div className="p-3 flex justify-between items-center shrink-0 border-b border-surface">
        <Text variant={TextVariants.title}>{t('editor.timelapse.title')}</Text>
      </div>
      <div className="grow overflow-y-auto p-3 custom-scrollbar flex flex-col gap-2">
        {preview?.folder === folder && (
          <video
            key={preview.src}
            src={preview.src}
            className="w-full rounded-md bg-black"
            controls
            loop
            autoPlay
            muted
            onError={(e) => {
              const err = e.currentTarget.error;
              console.error(`[glidelapse] preview video error ${err?.code}: ${err?.message}`);
              say(`video error ${err?.code}: ${err?.message ?? ''}`);
              say(t('editor.timelapse.previewFailed'));
            }}
          />
        )}
        <Button disabled={!usable} onClick={showPreview}>
          {t('editor.timelapse.preview')}
        </Button>
        <Button
          // the video must show this geometry: after a crop or turn, make a new Preview first
          disabled={
            !usable ||
            preview?.folder !== folder ||
            preview.geom !== geom() ||
            !referenceFile ||
            !dims.width ||
            !dims.height
          }
          onClick={pickOnPreview}
        >
          {t('editor.timelapse.pickOnPreview')}
        </Button>
        {picking && preview && (
          <ReferencePicker
            src={preview.src}
            size={f}
            initial={picking.area}
            onCancel={() => setPicking(null)}
            onSave={(area) => {
              // only onto the photo it was opened for (keys are blocked meanwhile, this is a guard)
              if (useEditorStore.getState().selectedImage?.path === picking.path) putReference(area);
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
          <Button disabled={!usable || !referenceFile || !dims.width || !dims.height} onClick={setReference}>
            {t(hasReference ? 'editor.timelapse.editReference' : 'editor.timelapse.setReference')}
          </Button>
          <Button
            disabled={!usable || !hasReference || !referenceFile || !dims.width || !dims.height}
            onClick={() =>
              run(t('editor.timelapse.confirmDeflicker'), [
                'deflicker',
                folder!,
                '--reference',
                referenceFile!,
                '--size',
                size,
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
