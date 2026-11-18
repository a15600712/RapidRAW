# GlideLapse changes in this fork

This is RapidRAW (AGPL-3.0, by CyberTimon and contributors) with a small addition for
[GlideLapse](https://github.com/a15600712/glidelapse), a timelapse grading tool that works on
RapidRAW sidecars. Branch `glidelapse`; everything else follows upstream.

Changes (2026-10-13/14; on v1.7.0 since 2026-11-18):

- `src-tauri/src/glidelapse.rs` (new): headless `export ... --max-size <px>` renders every image
  from its own sidecar at most `<px>` on the long edge, all in one process with the GPU kept warm.
  Images are decoded and composited exactly as export does it (full RAW development with its
  highlight headroom, saved AI patches), reduced before the GPU, and rendered the way export
  renders an image too large for the GPU (geometry, crop and masks at the reduced scale); images
  with colour or luminance masks go through the export pipeline itself and are reduced afterwards;
  adjustments are resolved as export resolves a sidecar (default preset for an unedited image,
  saved patches, AI results made ready first), and an AI-upscaled image keeps its scale. Results are 16-bit TIFFs `<output>/<file name>.tiff`; duplicate file
  names, `--adjustments` together with `--max-size`, and crops too thin to reduce are refused.
- `--cache-dir <dir>` (with `--max-size`): keeps each image's reduced pre-GPU image there and
  reuses it when the same file is rendered again with the same decoding settings and the same
  adjustments apart from masks (the key also covers this build and the file's identity; entries
  carry a checksum and are written atomically). GlideLapse's deflicker renders every frame
  several times with only its correction mask changed, so each RAW is decoded once.
- Timelapse panel (`src/components/panel/right/TimelapsePanel.tsx`, new; a panel of its own in
  the switcher next to Crop, Masks and Inpaint: `Panel.Timelapse` in
  `src/types/ui.ts`, `PanelSwitcher.tsx` (icon `Clapperboard`; `Film` is upstream's filmstrip),
  `useUIStore.ts`, `App.tsx`): a 1280 px preview video of the whole graded
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
  `lib.rs`); afterwards `App.tsx` reopens the folder. New UI texts are in `en.json` only; the
  other languages fall back to it.
- `app/launch_request.rs`: parses `--max-size` and `--cache-dir`; `export/mod.rs`: hands such
  exports to the module above and lets it call the export pipeline; `lib.rs`: declares it.
- `shaders/shader.wgsl` (one line, since v1.7.0): the Contrast pivot (`contrast_key`) follows the
  total exposure `t_exposure`, masks included, as the white level next to it already does;
  upstream uses the global exposure only, so an exposure mask over the whole image (GlideLapse's
  holy-grail and deflicker corrections) shifted the contrast curve and left a ~3 % brightness
  step per 1/3 EV with Contrast 30, where a global exposure change leaves none.

Measured on a laptop (24 MP Nikon NEF, Intel Iris Xe), v1.7.0: about 2.5 s per 1024 px
measurement image when it has to be decoded (the GPU demosaic of the full RAW dominates), 0.1 s from
the cache, against about 2.8 s per full-size export in one process; reduced renders read 0.04 to
0.09 % brighter than full-size ones, within 0.035 % of each other across 12 frames even with
Contrast 30 and Highlights -40. On v1.6.5, GlideLapse's 300-frame deflicker took 5 minutes instead
of 18 with corrections within 0.001 EV of the full-size run.
