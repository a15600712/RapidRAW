// GlideLapse (timelapse grading, https://github.com/a15600712/glidelapse): the Timelapse section of
// the editing panel. Every action runs the installed `glidelapse` program on the open folder
// through the `glidelapse_run` command. While it runs, RapidRAW's sidecar writes are refused
// (glidelapse::guarded) and an overlay blocks the window; afterwards the folder is reopened.
import { useState } from 'react';
import { createPortal } from 'react-dom';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { ask, open } from '@tauri-apps/plugin-dialog';
import { useTranslation } from 'react-i18next';
import { create } from 'zustand';
import Button from '../ui/Button';
import Slider from '../ui/Slider';
import Text from '../ui/Text';
import { Invokes, Panel } from '../ui/AppProperties';
import { TextVariants } from '../../types/typography';
import { Mask } from '../panel/right/Masks';
import { useEditorStore } from '../../store/useEditorStore';
import { useLibraryStore } from '../../store/useLibraryStore';
import { useUIStore } from '../../store/useUIStore';
import { useSettingsStore } from '../../store/useSettingsStore';
import { debouncedSave } from '../../hooks/useEditorActions';
import { Adjustments, INITIAL_MASK_ADJUSTMENTS, INITIAL_MASK_CONTAINER } from '../../utils/adjustments';
import { createSubMask } from '../../utils/maskUtils';

/** The deflicker reference area: a radial mask glidelapse only reads. */
const REFERENCE_ID = 'glidelapse-reference';

/** The running action, kept outside the section so it survives switching panels. */
const useRun = create<{ busy: boolean; stopped: boolean; log: string[] }>(() => ({
  busy: false,
  stopped: false,
  log: [],
}));
const say = (line: string) => useRun.setState((s) => ({ log: [...s.log.slice(-199), line] }));
listen<string>('glidelapse-log', (e) => say(e.payload));

interface TimelapseProps {
  adjustments: Adjustments;
  setAdjustments(updater: (prev: Adjustments) => Adjustments): void;
}

export default function Timelapse({ adjustments, setAdjustments }: TimelapseProps) {
  const { t } = useTranslation();
  const folder = useLibraryStore((s) => s.currentFolderPath);
  const frameCount = useLibraryStore((s) => s.imageList.length);
  const selectedPath = useEditorStore((s) => s.selectedImage?.path);
  const originalSize = useEditorStore((s) => s.originalSize);
  const { busy, log } = useRun();
  // with XMP sync RapidRAW rewrites sidecars while it merely lists or opens photos
  const xmpSync = useSettingsStore((s) => s.appSettings?.enableXmpSync === true);
  const [keyframes, setKeyframes] = useState(5);
  const [smoothing, setSmoothing] = useState(0.5);
  const [jobs, setJobs] = useState(2);

  const usable = !!folder && !folder.startsWith('Album: ') && !busy && !xmpSync;
  const hasReference = (adjustments.masks || []).some((m) => m.id === REFERENCE_ID);
  // virtual copies share the photo's file; glidelapse works on files and their sidecars
  const referenceFile = selectedPath && !selectedPath.includes('?vc=') ? selectedPath.split('/').pop() : undefined;

  const run = async (confirmText: string | null, ...steps: string[][]) => {
    if (!usable || !folder || useRun.getState().busy) return;
    useRun.setState({ busy: true, stopped: false, log: [] });
    try {
      if (confirmText && !(await ask(confirmText, { title: 'GlideLapse', kind: 'warning' }))) return;
      // the open photo's latest edits must be on disk before glidelapse reads the sidecars
      const { selectedImage, adjustments: current } = useEditorStore.getState();
      debouncedSave.cancel();
      if (selectedImage?.isReady) {
        await invoke(Invokes.SaveMetadataAndUpdateThumbnail, { path: selectedImage.path, adjustments: current });
      }
      for (const args of steps) {
        if (useRun.getState().stopped) break;
        say(`$ glidelapse ${args.join(' ')}`);
        if ((await invoke<number>('glidelapse_run', { args })) !== 0) {
          say(t('editor.timelapse.failed'));
          break;
        }
      }
      // glidelapse rewrote the sidecars: App.tsx reopens the folder
      window.dispatchEvent(new Event('glidelapse-refresh'));
    } catch (e) {
      say(String(e));
    } finally {
      useRun.setState({ busy: false });
    }
  };

  const stop = () => {
    useRun.setState({ stopped: true });
    invoke('glidelapse_cancel').catch((e) => say(String(e)));
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

  const size = `${originalSize.width},${originalSize.height}`;

  return (
    <div className="flex flex-col gap-2">
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
        <Button disabled={!usable} onClick={() => run(t('editor.timelapse.confirmHolyGrail'), ['holygrail', folder!])}>
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
      {xmpSync && <Text variant={TextVariants.small}>{t('editor.timelapse.xmpSync')}</Text>}
      {!busy && log.length > 0 && (
        <Text variant={TextVariants.small} className="whitespace-pre-wrap break-all max-h-32 overflow-y-auto font-mono">
          {log.slice(-8).join('\n')}
        </Text>
      )}
      {/* while an action runs nothing in RapidRAW can be clicked: no edit, selection or file
          operation can interfere with what glidelapse writes */}
      {busy &&
        createPortal(
          <div className="fixed inset-0 z-[1000] bg-black/60 flex items-center justify-center">
            <div className="bg-surface rounded-md p-4 flex flex-col gap-2 w-[32rem] max-w-[90vw]">
              <Text
                variant={TextVariants.small}
                className="whitespace-pre-wrap break-all max-h-64 overflow-y-auto font-mono"
              >
                {log.slice(-12).join('\n')}
              </Text>
              <Button onClick={stop}>{t('editor.timelapse.stop')}</Button>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
