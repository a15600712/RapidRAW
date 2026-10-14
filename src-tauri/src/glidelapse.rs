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
//!
//! With `--cache-dir <dir>` the reduced image before the GPU (decoded, composited, geometry
//! applied) is kept there and reused when the same file is rendered again with the same settings
//! and the same adjustments apart from masks: the deflicker renders every frame several times
//! with only its correction mask changed, so the RAW is decoded once instead of every pass.

use std::borrow::Cow;
use std::path::{Path, PathBuf};

use image::{DynamicImage, GenericImageView, ImageBuffer, imageops::FilterType};
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
    cache_dir: Option<&str>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    // the cache only saves time: without a usable folder every image is simply decoded
    let cache_dir = cache_dir.filter(|dir| match std::fs::create_dir_all(dir) {
        Ok(()) => true,
        Err(e) => {
            cli_eprintln!("not cached: cache directory {}: {}", dir, e);
            false
        }
    });
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
        let result = render_reduced(path, max_dim, cache_dir.map(Path::new), &context, &state, &app_handle, &settings)
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

/// The image the GPU starts from: decoded, composited, geometry applied, reduced; with the scale
/// and crop offset the masks need at that size.
struct Base {
    image: DynamicImage,
    gpu_scale: f32,
    crop_offset: (f32, f32),
}

/// One image from its sidecar at most `max_dim` px on the long edge, 16-bit.
#[allow(clippy::too_many_arguments)]
fn render_reduced(
    path: &str,
    max_dim: u32,
    cache_dir: Option<&Path>,
    context: &GpuContext,
    state: &tauri::State<AppState>,
    app_handle: &tauri::AppHandle,
    settings: &AppSettings,
) -> Result<DynamicImage, String> {
    let (source_path, sidecar_path) = parse_virtual_path(path);
    let source = source_path.to_string_lossy().to_string();
    let is_raw = is_raw_file(&source);
    let js_adjustments: Value = load_sidecar(&sidecar_path).adjustments;
    let mask_definitions: Vec<MaskDefinition> = js_adjustments
        .get("masks")
        .and_then(|m| serde_json::from_value(m.clone()).ok())
        .unwrap_or_default();

    // colour and luminance masks sample the full-size image: render exactly as export, then reduce
    if mask_definitions.iter().any(MaskDefinition::requires_warped_image) {
        let original = decode(&source, &js_adjustments, settings)?;
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

    let cache = cache_dir.and_then(|d| Some(d.join(cache_key(&source, &js_adjustments, max_dim, settings)?)));
    let base = match cache.as_deref().and_then(read_base) {
        Some(base) => base,
        None => {
            let base = reduce(&source, &js_adjustments, max_dim, settings)?;
            if let Some(c) = &cache
                && let Err(e) = write_base(c, &base)
            {
                cli_eprintln!("{}: not cached: {}", source, e);
            }
            base
        }
    };
    let (bw, bh) = base.image.dimensions();
    let (gpu_scale, crop_offset) = (base.gpu_scale, base.crop_offset);
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
        &base.image,
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

/// Decoded and composited as export does it: full development keeps the highlight headroom that
/// the fast demosaic clips at 1.0, and saved AI patches are applied at full size.
fn decode(source: &str, js_adjustments: &Value, settings: &AppSettings) -> Result<DynamicImage, String> {
    let bytes = std::fs::read(source).map_err(|e| format!("{}: {}", source, e))?;
    load_and_composite(&bytes, source, js_adjustments, false, settings, None).map_err(|e| e.to_string())
}

/// Decode, apply the geometry, reduce to at most `max_dim` before the GPU.
fn reduce(source: &str, js_adjustments: &Value, max_dim: u32, settings: &AppSettings) -> Result<Base, String> {
    let original = decode(source, js_adjustments, settings)?;
    let (transformed, unscaled_crop_offset) =
        apply_all_transformations(Cow::Borrowed(&original), js_adjustments);
    let (w, h) = transformed.dimensions();
    if w.max(h) > max_dim && (u64::from(w.min(h)) * u64::from(max_dim)) < u64::from(w.max(h)) {
        return Err(format!("{}x{} is too thin to reduce to {} px", w, h, max_dim));
    }
    let image = if w > max_dim || h > max_dim {
        downscale_f32_image(transformed.as_ref(), max_dim, max_dim)
    } else {
        transformed.into_owned()
    };
    let gpu_scale = if w > 0 { image.width() as f32 / w as f32 } else { 1.0 };
    Ok(Base {
        image,
        gpu_scale,
        crop_offset: (unscaled_crop_offset.0 * gpu_scale, unscaled_crop_offset.1 * gpu_scale),
    })
}

/// Cache file name. Everything the reduced image depends on: this RapidRAW build (a hash of
/// the executable), the source as named (its extension picks the decoder) and as stored (device,
/// inode, size, modification and change time: the change time moves on every write, even when a
/// tool keeps the modification time), the size, the decoding settings and environment, and every
/// adjustment except masks, which only act on the GPU. Unix only; elsewhere nothing is cached.
#[cfg(unix)]
fn cache_key(source: &str, js_adjustments: &Value, max_dim: u32, settings: &AppSettings) -> Option<String> {
    use std::os::unix::fs::MetadataExt;
    static BUILD: std::sync::OnceLock<Option<blake3::Hash>> = std::sync::OnceLock::new();
    let build = BUILD.get_or_init(|| std::fs::read(std::env::current_exe().ok()?).ok().map(|b| blake3::hash(&b)));
    let file = std::fs::metadata(std::fs::canonicalize(source).ok()?).ok()?;
    let mut adjustments = js_adjustments.clone();
    adjustments.as_object_mut()?.remove("masks");
    let mut hasher = blake3::Hasher::new();
    hasher.update(b"glidelapse-base-3\0");
    hasher.update(build.as_ref()?.as_bytes());
    hasher.update(Path::new(source).extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default().as_bytes());
    for n in [file.dev(), file.ino(), file.size(), file.mtime() as u64, file.mtime_nsec() as u64, file.ctime() as u64, file.ctime_nsec() as u64] {
        hasher.update(&n.to_le_bytes());
    }
    hasher.update(&max_dim.to_le_bytes());
    hasher.update(serde_json::to_string(&adjustments).ok()?.as_bytes());
    // only the settings decoding reads: the rest holds hash maps that serialise in a different
    // order in every process
    let decoding = (
        settings.apply_preprocessing_to_non_raws,
        &settings.linear_raw_mode,
        settings.raw_highlight_compression,
        settings.raw_preprocessing_color_nr,
        settings.raw_preprocessing_sharpening,
        settings.use_apple_raw9,
    );
    hasher.update(format!("{decoding:?}").as_bytes());
    // the RAW decoder reads some switches from the environment
    let mut env: Vec<(String, String)> = std::env::vars().filter(|(k, _)| k.starts_with("RAWLER")).collect();
    env.sort();
    hasher.update(format!("{env:?}").as_bytes());
    Some(format!("{}.rgb32f", hasher.finalize().to_hex()))
}

#[cfg(not(unix))]
fn cache_key(_: &str, _: &Value, _: u32, _: &AppSettings) -> Option<String> {
    None
}

const MAGIC: &[u8; 4] = b"GLB3";
/// Magic, width, height, gpu scale, crop offset x/y, then BLAKE3 of all of those and the pixels.
const FIELDS: usize = 4 + 4 * 5;
const HEADER: usize = FIELDS + 32;

fn checksum(fields: &[u8], payload: &[u8]) -> blake3::Hash {
    blake3::Hasher::new().update(fields).update(payload).finalize()
}

/// Header then RGB f32 pixels, native byte order; written under a name of its own and renamed,
/// so a reader never sees a half-written entry.
fn write_base(path: &Path, base: &Base) -> Result<(), String> {
    let DynamicImage::ImageRgb32F(pixels) = &base.image else {
        return Err("not an RGB float image".into());
    };
    let payload: &[u8] = bytemuck::cast_slice(pixels.as_raw());
    let mut bytes = Vec::with_capacity(HEADER + payload.len());
    bytes.extend_from_slice(MAGIC);
    bytes.extend_from_slice(&pixels.width().to_ne_bytes());
    bytes.extend_from_slice(&pixels.height().to_ne_bytes());
    for v in [base.gpu_scale, base.crop_offset.0, base.crop_offset.1] {
        bytes.extend_from_slice(&v.to_ne_bytes());
    }
    let sum = checksum(&bytes, payload);
    bytes.extend_from_slice(sum.as_bytes());
    bytes.extend_from_slice(payload);
    static WRITES: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let n = WRITES.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let tmp = PathBuf::from(format!("{}.{}-{}.part", path.display(), std::process::id(), n));
    let r = std::fs::write(&tmp, &bytes).and_then(|_| std::fs::rename(&tmp, path));
    if r.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    r.map_err(|e| e.to_string())
}

/// An entry only when it is complete and intact: exact length for its size, and a checksum that
/// matches both the header fields and the pixels.
fn read_base(path: &Path) -> Option<Base> {
    let bytes = std::fs::read(path).ok()?;
    let word = |i: usize| -> Option<[u8; 4]> { bytes.get(i..i + 4)?.try_into().ok() };
    if bytes.get(..4)? != MAGIC {
        return None;
    }
    let (w, h) = (u32::from_ne_bytes(word(4)?), u32::from_ne_bytes(word(8)?));
    let f = |i: usize| Some(f32::from_ne_bytes(word(i)?));
    let (gpu_scale, x, y) = (f(12)?, f(16)?, f(20)?);
    let payload = bytes.get(HEADER..)?;
    let expected = usize::try_from(u64::from(w) * u64::from(h) * 12).ok()?;
    if w == 0 || h == 0 || payload.len() != expected || !gpu_scale.is_finite() || !x.is_finite() || !y.is_finite() {
        return None;
    }
    if checksum(bytes.get(..FIELDS)?, payload).as_bytes() != bytes.get(FIELDS..HEADER)? {
        return None;
    }
    let data: Vec<f32> = bytemuck::pod_collect_to_vec(payload);
    let pixels = ImageBuffer::from_raw(w, h, data)?;
    Some(Base { image: DynamicImage::ImageRgb32F(pixels), gpu_scale, crop_offset: (x, y) })
}

/// The running GlideLapse action's process group, so the panel can stop it and the RapidRAW
/// renders it started.
static RUNNING: std::sync::Mutex<Option<u32>> = std::sync::Mutex::new(None);

/// Run the installed `glidelapse` program (or `GLIDELAPSE_BIN`) with `args` for the Timelapse
/// section: one action at a time, every line it reports sent as a `glidelapse-log` event, its
/// renders done by this very RapidRAW build (`GLIDELAPSE_RAPIDRAW`). Returns the exit code.
#[tauri::command]
pub async fn glidelapse_run(args: Vec<String>, app_handle: tauri::AppHandle) -> Result<i32, String> {
    use std::io::BufRead;
    use tauri::Emitter;
    let rapidraw = std::env::current_exe().map_err(|e| e.to_string())?;
    let bin = std::env::var("GLIDELAPSE_BIN").unwrap_or_else(|_| "glidelapse".to_string());
    STOP.store(false, std::sync::atomic::Ordering::SeqCst);
    tauri::async_runtime::spawn_blocking(move || {
        let mut running = RUNNING.lock().map_err(|e| e.to_string())?;
        if running.is_some() {
            return Err("a GlideLapse action is already running".to_string());
        }
        let mut cmd = std::process::Command::new(&bin);
        cmd.args(&args)
            .env("GLIDELAPSE_RAPIDRAW", &rapidraw)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped());
        #[cfg(unix)]
        std::os::unix::process::CommandExt::process_group(&mut cmd, 0);
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("cannot start {}: {} (install GlideLapse or set GLIDELAPSE_BIN)", bin, e))?;
        *running = Some(child.id());
        drop(running);
        if STOP.load(std::sync::atomic::Ordering::SeqCst) {
            let _ = glidelapse_cancel();
        }
        if let Some(err) = child.stderr.take() {
            for line in std::io::BufReader::new(err).lines().map_while(Result::ok) {
                let _ = app_handle.emit("glidelapse-log", line);
            }
        }
        let status = child.wait().map_err(|e| e.to_string());
        *RUNNING.lock().map_err(|e| e.to_string())? = None;
        Ok(status?.code().unwrap_or(-1))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// RapidRAW commands that write sidecars. While a GlideLapse action runs they are refused, so
/// nothing RapidRAW holds in memory (the open photo, auto-sync, paste, ratings) is saved over what
/// glidelapse writes; the Timelapse section reloads everything once the action has finished.
const WRITERS: &[&str] = &[
    "save_metadata_and_update_thumbnail",
    "apply_adjustments_to_paths",
    "reset_adjustments_for_paths",
    "apply_auto_lens_correction_to_paths",
    "apply_auto_adjustments_to_paths",
    "clear_all_sidecars",
    "set_color_label_for_paths",
    "set_rating_for_paths",
    "set_flag_for_paths",
    "add_tag_for_paths",
    "remove_tag_for_paths",
    "clear_ai_tags",
    "clear_all_tags",
    "start_background_indexing",
    "update_exif_fields",
    "rename_files",
    "move_files",
    "copy_files",
    "duplicate_file",
    "create_virtual_copy",
    "delete_files_from_disk",
    "delete_files_with_associated",
    "delete_folder",
    "rename_folder",
    "import_files",
    // reading can write too: EXIF repair and XMP sync rewrite sidecars while loading them
    "load_metadata",
    "load_image",
];
// ponytail: refuses new writes only; a paste or AI indexing already running when an action starts
// can still finish its own writes. Start actions when RapidRAW is idle.

/// Stop pressed before the action's process exists: it is stopped as soon as it does.
static STOP: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// RapidRAW's command handler, refusing the `WRITERS` while an action runs.
pub fn guarded<R: tauri::Runtime>(
    handler: impl Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync + 'static,
) -> impl Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync + 'static {
    move |invoke| {
        let running = RUNNING.lock().map(|r| r.is_some()).unwrap_or(false);
        if running && WRITERS.contains(&invoke.message.command()) {
            invoke
                .resolver
                .reject("GlideLapse is working on this folder: changes are not saved until it has finished");
            return true;
        }
        handler(invoke)
    }
}

/// How many frames the last preview published (frame_000001.jpg on, without gaps) in RapidRAW's
/// cache folder; only that folder is looked at.
#[tauri::command]
pub fn glidelapse_preview_frames(app_handle: tauri::AppHandle) -> Result<usize, String> {
    let dir = app_handle
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("glidelapse")
        .join("preview");
    Ok((1..)
        .take_while(|i| dir.join(format!("frame_{i:06}.jpg")).is_file())
        .count())
}

/// Stop the running GlideLapse action with everything it started.
#[tauri::command]
pub fn glidelapse_cancel() -> Result<(), String> {
    STOP.store(true, std::sync::atomic::Ordering::SeqCst);
    let Some(group) = *RUNNING.lock().map_err(|e| e.to_string())? else {
        return Ok(());
    };
    #[cfg(unix)]
    {
        // "--": the negative number is the process group, not an option
        let status = std::process::Command::new("kill")
            .args(["-TERM", "--", &format!("-{}", group)])
            .status()
            .map_err(|e| e.to_string())?;
        if status.success() { Ok(()) } else { Err(format!("could not stop process group {}", group)) }
    }
    #[cfg(not(unix))]
    {
        let _ = group;
        Err("stopping is not supported on this system".to_string())
    }
}
