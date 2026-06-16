#![allow(dead_code)]

use crate::rdp_shared_frame::{FrameSnapshot, SharedFrame};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc,
};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

const FRAME_WAIT_TIMEOUT: Duration = Duration::from_millis(100);
const PERF_LOG_INTERVAL: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GpuRendererInfo {
    pub adapter_name: String,
    pub backend: String,
}

pub struct NativeGpuRendererHandle {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl NativeGpuRendererHandle {
    pub fn request_stop(&self) {
        self.stop.store(true, Ordering::Release);
    }

    pub fn stop(mut self) {
        self.request_stop();
        self.join();
    }

    fn join(&mut self) {
        if let Some(thread) = self.thread.take() {
            if let Err(err) = thread.join() {
                log::warn!("[rdp.gpu] renderer thread join failed: {err:?}");
            }
        }
    }
}

impl Drop for NativeGpuRendererHandle {
    fn drop(&mut self) {
        self.request_stop();
        self.join();
    }
}

pub fn spawn_headless_upload_renderer(shared_frame: Arc<SharedFrame>) -> NativeGpuRendererHandle {
    let stop = Arc::new(AtomicBool::new(false));
    let thread_stop = Arc::clone(&stop);
    let thread = thread::Builder::new()
        .name("nextdesk-rdp-gpu-upload".to_string())
        .spawn(move || run_headless_upload_loop(shared_frame, thread_stop))
        .expect("failed to spawn NextDesk RDP GPU renderer thread");

    NativeGpuRendererHandle {
        stop,
        thread: Some(thread),
    }
}

pub async fn probe_gpu_adapter() -> Result<GpuRendererInfo, String> {
    let uploader = HeadlessGpuUploader::new().await?;
    Ok(uploader.info)
}

fn run_headless_upload_loop(shared_frame: Arc<SharedFrame>, stop: Arc<AtomicBool>) {
    let mut uploader = match pollster::block_on(HeadlessGpuUploader::new()) {
        Ok(uploader) => uploader,
        Err(err) => {
            log::warn!("[rdp.gpu] headless renderer init failed: {err}");
            return;
        }
    };

    log::info!(
        "[rdp.gpu] headless renderer started adapter={} backend={}",
        uploader.info.adapter_name,
        uploader.info.backend
    );

    while !stop.load(Ordering::Acquire) {
        let Some(snapshot) = shared_frame.wait_for_frame(FRAME_WAIT_TIMEOUT) else {
            continue;
        };
        if let Err(err) = uploader.upload_snapshot(&snapshot) {
            log::warn!("[rdp.gpu] upload failed: {err}");
        }
    }

    log::info!("[rdp.gpu] headless renderer stopped");
}

struct HeadlessGpuUploader {
    device: wgpu::Device,
    queue: wgpu::Queue,
    texture: Option<wgpu::Texture>,
    texture_width: u32,
    texture_height: u32,
    info: GpuRendererInfo,
    frames_uploaded: AtomicU64,
    bytes_uploaded: AtomicU64,
    last_perf_log: Instant,
    last_perf_frame_count: u64,
    last_perf_byte_count: u64,
}

impl HeadlessGpuUploader {
    async fn new() -> Result<Self, String> {
        let instance = wgpu::Instance::default();
        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::HighPerformance,
                force_fallback_adapter: false,
                compatible_surface: None,
            })
            .await
            .ok_or_else(|| "no GPU adapter found".to_string())?;
        let adapter_info = adapter.get_info();

        let (device, queue) = adapter
            .request_device(
                &wgpu::DeviceDescriptor {
                    label: Some("nextdesk-rdp-headless-gpu"),
                    required_features: wgpu::Features::empty(),
                    required_limits: wgpu::Limits::default(),
                    ..Default::default()
                },
                None,
            )
            .await
            .map_err(|err| format!("failed to create GPU device: {err}"))?;

        Ok(Self {
            device,
            queue,
            texture: None,
            texture_width: 0,
            texture_height: 0,
            info: GpuRendererInfo {
                adapter_name: adapter_info.name,
                backend: format!("{:?}", adapter_info.backend),
            },
            frames_uploaded: AtomicU64::new(0),
            bytes_uploaded: AtomicU64::new(0),
            last_perf_log: Instant::now(),
            last_perf_frame_count: 0,
            last_perf_byte_count: 0,
        })
    }

    fn upload_snapshot(&mut self, snapshot: &FrameSnapshot) -> Result<(), String> {
        validate_snapshot(snapshot)?;
        self.ensure_texture(snapshot.width, snapshot.height);

        let texture = self
            .texture
            .as_ref()
            .ok_or_else(|| "GPU texture was not initialized".to_string())?;
        let start = Instant::now();
        self.queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            &snapshot.data,
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(4 * snapshot.width),
                rows_per_image: Some(snapshot.height),
            },
            wgpu::Extent3d {
                width: snapshot.width,
                height: snapshot.height,
                depth_or_array_layers: 1,
            },
        );

        let frames = self.frames_uploaded.fetch_add(1, Ordering::Relaxed) + 1;
        let bytes = self
            .bytes_uploaded
            .fetch_add(snapshot.data.len() as u64, Ordering::Relaxed)
            + snapshot.data.len() as u64;
        self.log_perf_if_due(frames, bytes, start.elapsed(), snapshot);
        Ok(())
    }

    fn ensure_texture(&mut self, width: u32, height: u32) {
        if self.texture.is_some() && self.texture_width == width && self.texture_height == height {
            return;
        }

        self.texture = Some(self.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("nextdesk-rdp-headless-frame"),
            size: wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8UnormSrgb,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        }));
        self.texture_width = width;
        self.texture_height = height;
    }

    fn log_perf_if_due(
        &mut self,
        frames: u64,
        bytes: u64,
        upload_time: Duration,
        snapshot: &FrameSnapshot,
    ) {
        let elapsed = self.last_perf_log.elapsed();
        if elapsed < PERF_LOG_INTERVAL {
            return;
        }

        let uploaded_frames = frames.saturating_sub(self.last_perf_frame_count);
        let uploaded_bytes = bytes.saturating_sub(self.last_perf_byte_count);
        let fps = uploaded_frames as f64 / elapsed.as_secs_f64();
        let mib = uploaded_bytes as f64 / 1024.0 / 1024.0;

        log::info!(
            "[rdp.gpu] upload_fps={fps:.1} upload_mib={mib:.2} upload_ms={:.2} texture={}x{}",
            upload_time.as_secs_f64() * 1000.0,
            snapshot.width,
            snapshot.height
        );

        self.last_perf_log = Instant::now();
        self.last_perf_frame_count = frames;
        self.last_perf_byte_count = bytes;
    }
}

fn validate_snapshot(snapshot: &FrameSnapshot) -> Result<(), String> {
    if snapshot.width == 0 || snapshot.height == 0 {
        return Err("frame dimensions must be non-zero".to_string());
    }
    let expected = usize::try_from(snapshot.width)
        .ok()
        .and_then(|width| {
            usize::try_from(snapshot.height)
                .ok()
                .and_then(|height| width.checked_mul(height))
        })
        .and_then(|pixels| pixels.checked_mul(4))
        .ok_or_else(|| {
            format!(
                "frame size overflow: {}x{}",
                snapshot.width, snapshot.height
            )
        })?;
    if snapshot.data.len() != expected {
        return Err(format!(
            "frame payload size mismatch: expected {expected}, got {}",
            snapshot.data.len()
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_snapshot_size() {
        let snapshot = FrameSnapshot {
            width: 2,
            height: 1,
            data: vec![0; 8],
        };

        assert!(validate_snapshot(&snapshot).is_ok());
    }

    #[test]
    fn rejects_invalid_snapshot_size() {
        let snapshot = FrameSnapshot {
            width: 2,
            height: 1,
            data: vec![0; 4],
        };

        let err = validate_snapshot(&snapshot).unwrap_err();

        assert!(err.contains("payload size mismatch"));
    }
}
