//! GlideLapse support (timelapse grading, https://github.com/a15600712/glidelapse).
//!
//! `RapidRAW export <folder|file> --output <dir> --max-size <px>` renders every image from its
//! own sidecar at most `<px>` on the long edge, all in this one process with the GPU kept warm:
//! the image is decoded and composited exactly as export does it (full RAW development with its
//! highlight headroom, saved AI patches), then reduced before the GPU, with masks generated at the
//! reduced size the way the export-size estimate does. Frames with colour or luminance masks,
//! which sample the full-size image, are rendered by the export pipeline itself and reduced
//! afterwards. Each result is written as a 16-bit TIFF `<dir>/<file name>.tiff`. GlideLapse's
//! deflicker measures whole sequences this way instead of one full-size export per frame.

use std::borrow::Cow;
use std::path::Path;

use image::{DynamicImage, GenericImageView, imageops::FilterType};
use serde_json::Value;
use tauri::Manager;

use crate::AppState;
use crate::app_settings::AppSettings;
use crate::cache_utils::calculate_full_job_hash;
use crate::exif_processing::load_sidecar;
use crate::file_management::parse_virtual_path;
use crate::formats::is_raw_file;
use crate::image_loader::load_and_composite;
use crate::image_processing::{
    GpuContext, RenderOutputPrecision, RenderRequest, downscale_f32_image,
    get_all_adjustments_from_json, get_or_init_gpu_context,
    process_and_get_dynamic_image_with_precision, resolve_tonemapper_override_from_handle,
};
use crate::lut_processing::get_or_load_lut;
use crate::mask_generation::MaskDefinition;
use crate::white_balance::as_shot_white_balance;
use crate::{apply_all_transformations, get_cached_or_generate_mask, load_settings};

/// Render `paths` at most `max_dim` px into `output`; one failed image does not stop the rest.
pub async fn run_reduced_export(
    paths: Vec<String>,
    output: &str,
    max_dim: u32,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let state = app_handle.state::<AppState>();
    let context = get_or_init_gpu_context(&state, &app_handle)?;
    let settings = load_settings(app_handle.clone()).unwrap_or_default();
    // one flat output folder: two images with the same file name would overwrite each other
    let names: Vec<String> = paths
        .iter()
        .map(|p| {
            Path::new(p)
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default()
        })
        .collect();
    let mut seen = std::collections::HashSet::new();
    if let Some(dup) = names.iter().find(|n| !seen.insert(n.as_str())) {
        return Err(format!(
            "{} occurs more than once in the source; --max-size writes one flat folder",
            dup
        ));
    }
    std::fs::create_dir_all(output)
        .map_err(|e| format!("Failed to create output directory: {}", e))?;
    let mut failed = 0;
    for (path, name) in paths.iter().zip(&names) {
        let started = std::time::Instant::now();
        let target = Path::new(output).join(format!("{name}.tiff"));
        let result = render_reduced(path, max_dim, &context, &state, &app_handle, &settings)
            .and_then(|image| image.to_rgb16().save(&target).map_err(|e| e.to_string()));
        match result {
            Ok(()) => cli_println!(
                "{} -> {} ({} ms)",
                path,
                target.display(),
                started.elapsed().as_millis()
            ),
            Err(e) => {
                failed += 1;
                cli_eprintln!("{}: {}", path, e);
            }
        }
    }
    if failed > 0 {
        return Err(format!("{} of {} images failed", failed, paths.len()));
    }
    Ok(())
}

/// One image from its sidecar at most `max_dim` px on the long edge, 16-bit.
fn render_reduced(
    path: &str,
    max_dim: u32,
    context: &GpuContext,
    state: &tauri::State<AppState>,
    app_handle: &tauri::AppHandle,
    settings: &AppSettings,
) -> Result<DynamicImage, String> {
    let (source_path, sidecar_path) = parse_virtual_path(path);
    let source = source_path.to_string_lossy().to_string();
    let is_raw = is_raw_file(&source);
    let js_adjustments: Value = load_sidecar(&sidecar_path).adjustments;

    // decoded and composited as export does it: full development keeps the highlight headroom
    // that the fast demosaic clips at 1.0, and saved AI patches are applied at full size
    let bytes = std::fs::read(&source).map_err(|e| format!("{}: {}", source, e))?;
    let original = load_and_composite(&bytes, &source, &js_adjustments, false, settings, None)
        .map_err(|e| e.to_string())?;
    let mask_definitions: Vec<MaskDefinition> = js_adjustments
        .get("masks")
        .and_then(|m| serde_json::from_value(m.clone()).ok())
        .unwrap_or_default();

    // colour and luminance masks sample the full-size image: render exactly as export, then reduce
    if mask_definitions.iter().any(MaskDefinition::requires_warped_image) {
        let full = crate::export_processing::process_image_for_export_pipeline(
            path,
            &original,
            &js_adjustments,
            context,
            state,
            is_raw,
            "glidelapse_reduced_export_full",
            app_handle,
            RenderOutputPrecision::SixteenBit,
        )?;
        let (fw, fh) = full.dimensions();
        return Ok(if fw.max(fh) > max_dim {
            full.resize(max_dim, max_dim, FilterType::Triangle)
        } else {
            full
        });
    }

    let (transformed, unscaled_crop_offset) =
        apply_all_transformations(Cow::Borrowed(&original), &js_adjustments);
    let (w, h) = transformed.dimensions();
    if w.max(h) > max_dim && (u64::from(w.min(h)) * u64::from(max_dim)) < u64::from(w.max(h)) {
        return Err(format!(
            "{}x{} is too thin to reduce to {} px",
            w, h, max_dim
        ));
    }
    let base = if w > max_dim || h > max_dim {
        downscale_f32_image(transformed.as_ref(), max_dim, max_dim)
    } else {
        transformed.into_owned()
    };
    let (bw, bh) = base.dimensions();
    let gpu_scale = if w > 0 { bw as f32 / w as f32 } else { 1.0 };

    let crop_offset = (
        unscaled_crop_offset.0 * gpu_scale,
        unscaled_crop_offset.1 * gpu_scale,
    );
    let mask_bitmaps: Vec<_> = mask_definitions
        .iter()
        .filter_map(|def| {
            get_cached_or_generate_mask(
                state,
                &source,
                def,
                bw,
                bh,
                gpu_scale,
                crop_offset,
                &js_adjustments,
            )
        })
        .collect();

    let tone_mapper = resolve_tonemapper_override_from_handle(app_handle, is_raw);
    let mut adjustments = get_all_adjustments_from_json(
        &js_adjustments,
        is_raw,
        as_shot_white_balance(&source),
        tone_mapper,
    );
    adjustments.global.show_clipping = 0;
    let lut = js_adjustments["lutPath"]
        .as_str()
        .and_then(|p| get_or_load_lut(state, p).ok());
    let job_hash = calculate_full_job_hash(&source, &js_adjustments).wrapping_add(2);

    process_and_get_dynamic_image_with_precision(
        context,
        state,
        &base,
        job_hash,
        RenderRequest {
            adjustments,
            mask_bitmaps: &mask_bitmaps,
            lut,
            roi: None,
        },
        "glidelapse_reduced_export",
        RenderOutputPrecision::SixteenBit,
    )
}
