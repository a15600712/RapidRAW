# GlideLapse changes in this fork

This is RapidRAW (AGPL-3.0, by CyberTimon and contributors) with a small addition for
[GlideLapse](https://github.com/a15600712/glidelapse), a timelapse grading tool that works on
RapidRAW sidecars. Branch `glidelapse`; everything else follows upstream.

Changes (2026-10-13/14, on top of v1.6.5):

- `src-tauri/src/glidelapse.rs` (new): headless `export ... --max-size <px>` renders every image
  from its own sidecar at most `<px>` on the long edge, all in one process with the GPU kept warm.
  Images are decoded and composited exactly as export does it (full RAW development with its
  highlight headroom, saved AI patches), reduced before the GPU, and their masks generated at the
  reduced size; images with colour or luminance masks go through the export pipeline itself and
  are reduced afterwards. Results are 16-bit TIFFs `<output>/<file name>.tiff`; duplicate file
  names, `--adjustments` together with `--max-size`, and crops too thin to reduce are refused.
- `--cache-dir <dir>` (with `--max-size`): keeps each image's reduced pre-GPU image there and
  reuses it when the same file is rendered again with the same decoding settings and the same
  adjustments apart from masks (the key also covers this build and the file's identity; entries
  carry a checksum and are written atomically). GlideLapse's deflicker renders every frame
  several times with only its correction mask changed, so each RAW is decoded once.
- Timelapse panel (`src/components/panel/right/TimelapsePanel.tsx`, new; a panel of its own in
  the switcher next to Crop, Masks and Inpaint: `Panel.Timelapse` in `AppProperties.tsx`,
  `PanelSwitcher.tsx`, `useUIStore.ts`, `App.tsx`): a 1280 px preview video of the whole graded
  sequence played in the panel (written to RapidRAW's cache folder, `$APPCACHE/glidelapse/`,
  as 1280 px JPEG frames played as a flipbook, since WebKitGTK shows <video> scrambled or grey on
  some Linux GPUs; `tauri.conf.json` lets the asset protocol read only those frames), a pop-out
  to draw the deflicker reference area on that preview while the sequence plays (kept per
  folder, passed to deflicker as an ellipse), set keyframes, ramp, holy grail, deflicker,
  editable mask layers, export video, and the number of parallel jobs. Each action runs the installed
  `glidelapse` program through the
  new commands `glidelapse_run` / `glidelapse_cancel` (`glidelapse.rs`). While it runs an overlay
  (rendered by `App.tsx`) blocks the window and its keyboard shortcuts, and RapidRAW's
  sidecar-writing commands are refused (`glidelapse::guarded` wraps the command handler in
  `lib.rs`); afterwards `App.tsx` reopens the folder. New UI texts are in all locale files
  (English).
- `launch_request.rs`: parses `--max-size` and `--cache-dir`; `export_processing.rs`: hands such
  exports to the
  module above and lets it call the export pipeline; `lib.rs`: declares it.

Measured on a laptop (24 MP Nikon NEF, Intel Iris Xe): about 1.2 s per 1024 px measurement image
instead of about 4.3 s for a full-size export, 0.07 s from the cache; GlideLapse's 300-frame
deflicker took 5 minutes instead of 18 with corrections within 0.001 EV of the full-size run.
