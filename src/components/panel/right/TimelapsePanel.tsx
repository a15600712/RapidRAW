// GlideLapse (timelapse grading, https://github.com/a15600712/glidelapse): the Timelapse panel.
// Every action runs the installed `glidelapse` program on the open folder through the
// `glidelapse_run` command. While it runs, RapidRAW's sidecar writes are refused
// (glidelapse::guarded) and an overlay blocks the window; afterwards the folder is reopened.
import { useEffect, useRef, useState } from 'react';
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

/** The running action, kept outside the panel so it survives switching panels. */
const useRun = create<{
  busy: boolean;
  stopped: boolean;
  log: string[];
  preview: { folder: string; src: string } | null;
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
  const adjustments = useEditorStore((s) => s.adjustments);
  const { setAdjustments } = useEditorActions();
  const folder = useLibraryStore((s) => s.currentFolderPath);
  const frameCount = useLibraryStore((s) => s.imageList.length);
  const selectedPath = useEditorStore((s) => s.selectedImage?.path);
  const originalSize = useEditorStore((s) => s.originalSize);
  const { busy, log, preview } = useRun();
  const [keyframes, setKeyframes] = useState(5);
  const [smoothing, setSmoothing] = useState(0.5);
  const [jobs, setJobs] = useState(2);

  const usable = !!folder && !folder.startsWith('Album: ') && !busy;
  const hasReference = (adjustments.masks || []).some((m) => m.id === REFERENCE_ID);
  // virtual copies share the photo's file; glidelapse works on files and their sidecars
  const referenceFile = selectedPath && !selectedPath.includes('?vc=') ? selectedPath.split('/').pop() : undefined;

  /** Runs the steps in order; true when all of them finished. */
  const run = async (confirmText: string | null, ...steps: string[][]) => {
    if (!usable || !folder || useRun.getState().busy) return false;
    // every action changes the grade (or remakes the preview): an older video would mislead
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

  // a radial mask in the middle of the visible (cropped) photo, selected in the Masks panel to be
  // moved; the container stays hidden, so RapidRAW never renders it however it is edited
  const setReference = () => {
    if (!hasReference) {
      // without a crop: the whole photo, its sides swapped by a quarter turn
      const turned = (adjustments.orientationSteps ?? 0) % 2 === 1;
      const [w, h] = turned ? [originalSize.height, originalSize.width] : [originalSize.width, originalSize.height];
      const crop = adjustments.crop ?? { x: 0, y: 0, width: w, height: h };
      const base = createSubMask(Mask.Radial, { width: crop.width, height: crop.height });
      const shape = {
        ...base,
        parameters: { ...base.parameters, centerX: crop.x + crop.width / 2, centerY: crop.y + crop.height / 2 },
      };
      const container = {
        ...INITIAL_MASK_CONTAINER,
        id: REFERENCE_ID,
        name: t('editor.timelapse.referenceMask'),
        visible: false,
        adjustments: { ...INITIAL_MASK_ADJUSTMENTS },
        subMasks: [shape],
      };
      setAdjustments((prev) => ({ ...prev, masks: [...(prev.masks || []), container] }));
    }
    useEditorStore.getState().setEditor({ activeMaskContainerId: REFERENCE_ID });
    useUIStore.getState().setPanel(Panel.Masks);
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
    if (await run(null, ['preview', folder, '--out', file, '--jobs', String(jobs)])) {
      useRun.setState({ preview: { folder, src: `${convertFileSrc(file)}?v=${Date.now()}` } });
    }
  };

  const size = `${originalSize.width},${originalSize.height}`;

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
            onError={() => say(t('editor.timelapse.previewFailed'))}
          />
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
          <Button disabled={!usable || !referenceFile} onClick={setReference}>
            {t(hasReference ? 'editor.timelapse.editReference' : 'editor.timelapse.setReference')}
          </Button>
          <Button
            disabled={!usable || !hasReference || !referenceFile}
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
