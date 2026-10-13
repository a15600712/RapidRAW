# GlideLapse changes in this fork

This is RapidRAW (AGPL-3.0, by CyberTimon and contributors) with a small addition for
[GlideLapse](https://github.com/a15600712/glidelapse), a timelapse grading tool that works on
RapidRAW sidecars. Branch `glidelapse`; everything else follows upstream.

Changes (2026-10-13, on top of v1.6.5):

- `src-tauri/src/glidelapse.rs` (new): headless `export ... --max-size <px>` renders every image
  from its own sidecar at most `<px>` on the long edge, all in one process with the GPU kept warm.
  Images are decoded and composited exactly as export does it (full RAW development with its
  highlight headroom, saved AI patches), reduced before the GPU, and their masks generated at the
  reduced size; images with colour or luminance masks go through the export pipeline itself and
  are reduced afterwards. Results are 16-bit TIFFs `<output>/<file name>.tiff`; duplicate file
  names, `--adjustments` together with `--max-size`, and crops too thin to reduce are refused.
- `launch_request.rs`: parses `--max-size`; `export_processing.rs`: hands such exports to the
  module above and lets it call the export pipeline; `lib.rs`: declares it.

Measured on a laptop (24 MP Nikon NEF, Intel Iris Xe): about 1.2 s per 1024 px measurement image
instead of about 4.3 s for a full-size export; GlideLapse's 300-frame deflicker took 13 minutes
instead of 18 with corrections within 0.001 EV of the full-size run.
