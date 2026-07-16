//! Native RDP Session — full Rust RDP client embedded in Tauri.
//!
//! # Frame Transport (Raw Binary via Channel)
//! Uses `tauri::ipc::Channel` for zero-overhead binary streaming.
//!
//! Binary frame format (little-endian):
//! ```text
//! Offset  Size  Field
//! 0       2     desktop_width  (u16le)
//! 2       2     desktop_height (u16le)
//! 4       2     region_x       (u16le)
//! 6       2     region_y       (u16le)
//! 8       2     region_width   (u16le)
//! 10      2     region_height  (u16le)
//! 12      N     RGBA pixel data (row-major, 4 bytes/pixel)
//!               where N = region_width * region_height * 4
//! ```
//! Total header: 12 bytes. Frontend receives ArrayBuffer directly.

use crate::cliprdr as cliprdr_module;
use crate::cliprdr::CliprdrAction;
use crate::frame_ws::{FrameSender, FrameServerShutdown};
use crate::rdp_frame::{self, DirtyRect};
use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::{Duration, Instant};

use ironrdp::cliprdr;
use ironrdp::cliprdr::backend::CliprdrBackendFactory as _;
use ironrdp::connector::{self, ConnectionResult, ConnectorResult};
use ironrdp::displaycontrol::client::DisplayControlClient;
use ironrdp::echo::client::EchoClient;
use ironrdp::graphics::image_processing::PixelFormat;
use ironrdp::pdu::geometry::Rectangle as _;
use ironrdp::pdu::input::fast_path::FastPathInputEvent;
use ironrdp::pdu::input::mouse::{MousePdu, PointerFlags};
use ironrdp::session::image::DecodedImage;
use ironrdp::session::{ActiveStage, ActiveStageOutput, GracefulDisconnectReason, SessionResult};
use ironrdp::{rdpdr, rdpsnd, session};
use ironrdp_core::{decode, impl_as_any, WriteBuf};
use ironrdp_egfx::client::{GraphicsPipelineClient, GraphicsPipelineHandler};
use ironrdp_egfx::pdu::{
    Avc420BitmapStream, Avc444BitmapStream, CapabilitiesV81Flags, CapabilitiesV8Flags,
    CapabilitySet, Codec1Type, GfxPdu, PixelFormat as GfxPixelFormat,
};
use ironrdp_graphics::rdp6::BitmapStreamDecoder;
use ironrdp_rdpsnd_native::cpal::RdpsndBackend;
use ironrdp_tokio::{single_sequence_step_read, split_tokio_framed, FramedWrite};
use rdpdr::NoopRdpdrBackend;
use serde::Serialize;
use smallvec::{smallvec, SmallVec};
use tauri::Emitter;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::TcpStream;
use tokio::sync::mpsc;

/// Binary frame header size: 6 × u16 = 12 bytes
const FRAME_HEADER_SIZE: usize = 12;
const MIN_LZ4_FRAME_BYTES: usize = 64 * 1024;
const GFX_FRAME_HEADER_SIZE: usize = 20;
const GFX_FRAME_MAGIC: u16 = 0xffff;
const GFX_FRAME_KIND_H264: u16 = 1;
const INPUT_DRAIN_LIMIT: usize = 4096;
const DEFAULT_NATIVE_RENDER_MODE: NativeRenderMode = NativeRenderMode::Bitmap;
const MIN_GFX_FALLBACK_SUPPRESS_AREA_RATIO: u32 = 4;
const VIDEO_DVC_CONTROL_CHANNEL: &str = "Microsoft::Windows::RDS::Video::Control::v08.01";
const VIDEO_DVC_DATA_CHANNEL: &str = "Microsoft::Windows::RDS::Video::Data::v08.01";
const GEOMETRY_DVC_CHANNEL: &str = "Microsoft::Windows::RDS::Geometry::v08.01";
const INPUT_DVC_CHANNEL: &str = "Microsoft::Windows::RDS::Input";
const LOGGING_DVC_MAX_PAYLOAD_LOGS: usize = 12;
const GFX_H264_UNSUPPORTED_MESSAGE: &str = "RDPGFX H.264 test mode is active, but the server did not negotiate AVC420/H.264. Disable NEXTDESK_NATIVE_GFX=h264 or enable H.264/AVC on the RDP server.";
type SharedGfxError = Arc<Mutex<Option<String>>>;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum NativeRenderMode {
    Bitmap,
    GfxH264Auto,
    GfxH264Force,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NativeFrameTransport {
    RawBitmap,
    DriftDirtyRects,
}

impl NativeFrameTransport {
    pub fn label(self) -> &'static str {
        match self {
            NativeFrameTransport::RawBitmap => "raw-bitmap",
            NativeFrameTransport::DriftDirtyRects => "drift-dirty-rect",
        }
    }
}

pub fn native_frame_transport_from_profile(profile: Option<&str>) -> NativeFrameTransport {
    match profile.map(|value| value.trim().to_ascii_lowercase()) {
        Some(value)
            if value == "native-drift"
                || value == "native-fast"
                || value == "drift"
                || value == "dirty-rect" =>
        {
            NativeFrameTransport::DriftDirtyRects
        }
        _ => NativeFrameTransport::RawBitmap,
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum NativeRdpRoute {
    Direct,
}

fn native_rdp_route_label(route: NativeRdpRoute) -> String {
    match route {
        NativeRdpRoute::Direct => "direct".to_string(),
    }
}

fn should_emit_bitmap_updates(mode: NativeRenderMode, gfx_frame_seen: bool) -> bool {
    !mode.uses_gfx_pipeline() || !gfx_frame_seen
}

impl NativeRenderMode {
    fn uses_gfx_pipeline(self) -> bool {
        matches!(
            self,
            NativeRenderMode::GfxH264Auto | NativeRenderMode::GfxH264Force
        )
    }

    fn requires_h264(self) -> bool {
        matches!(self, NativeRenderMode::GfxH264Force)
    }
}

fn native_render_mode_for_route(
    _route: NativeRdpRoute,
    _width: u16,
    _height: u16,
) -> NativeRenderMode {
    native_render_mode_from_env(std::env::var("NEXTDESK_NATIVE_GFX").ok().as_deref())
}

#[cfg(test)]
fn native_render_mode_for_route_with_env(
    _route: NativeRdpRoute,
    _width: u16,
    _height: u16,
    env_value: Option<&str>,
) -> NativeRenderMode {
    native_render_mode_from_env(env_value)
}

fn native_render_mode_from_env(value: Option<&str>) -> NativeRenderMode {
    match value.map(str::to_ascii_lowercase).as_deref() {
        Some("force" | "h264") => NativeRenderMode::GfxH264Force,
        Some("auto" | "gfx") => NativeRenderMode::GfxH264Auto,
        Some("off" | "bitmap") => NativeRenderMode::Bitmap,
        _ => DEFAULT_NATIVE_RENDER_MODE,
    }
}

fn gfx_h264_capabilities() -> Vec<CapabilitySet> {
    vec![
        // Force the AVC420 capability path while H.264 is experimental.
        // Advertising V10/V10.7 lets Windows confirm V10 but still emit RemoteFxProgressive.
        CapabilitySet::V8_1 {
            flags: CapabilitiesV81Flags::AVC420_ENABLED | CapabilitiesV81Flags::SMALL_CACHE,
        },
        CapabilitySet::V8 {
            flags: CapabilitiesV8Flags::SMALL_CACHE,
        },
    ]
}

fn build_gfx_h264_frame(
    surface_id: u16,
    codec_id: Codec1Type,
    left: u16,
    top: u16,
    right: u16,
    bottom: u16,
    payload: &[u8],
) -> Vec<u8> {
    let mut buf = Vec::with_capacity(GFX_FRAME_HEADER_SIZE + payload.len());
    buf.extend_from_slice(&GFX_FRAME_MAGIC.to_le_bytes());
    buf.extend_from_slice(&GFX_FRAME_KIND_H264.to_le_bytes());
    buf.extend_from_slice(&surface_id.to_le_bytes());
    buf.extend_from_slice(&u16::from(codec_id).to_le_bytes());
    buf.extend_from_slice(&left.to_le_bytes());
    buf.extend_from_slice(&top.to_le_bytes());
    buf.extend_from_slice(&right.to_le_bytes());
    buf.extend_from_slice(&bottom.to_le_bytes());
    buf.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    buf.extend_from_slice(payload);
    buf
}

fn gfx_capability_confirms_h264(cap: &CapabilitySet) -> bool {
    matches!(
        cap,
        CapabilitySet::V8_1 { flags }
            if flags.contains(CapabilitiesV81Flags::AVC420_ENABLED)
    )
}

fn gfx_unsupported_message(cap: &CapabilitySet) -> String {
    format!("{GFX_H264_UNSUPPORTED_MESSAGE} Confirmed capability: {cap:?}")
}

fn set_gfx_error_once(error: &SharedGfxError, message: String) {
    match error.lock() {
        Ok(mut slot) => {
            if slot.is_none() {
                *slot = Some(message);
            }
        }
        Err(err) => {
            log::error!("[rdp-native] GFX error state poisoned: {err}");
        }
    }
}

fn take_gfx_error(error: &SharedGfxError) -> Option<String> {
    match error.lock() {
        Ok(mut slot) => slot.take(),
        Err(err) => {
            log::error!("[rdp-native] GFX error state poisoned: {err}");
            Some("RDPGFX error state is unavailable after a lock failure".to_string())
        }
    }
}

fn extract_gfx_h264_payload<'a>(
    codec_id: Codec1Type,
    bitmap_data: &'a [u8],
) -> Result<&'a [u8], String> {
    match codec_id {
        Codec1Type::Avc420 => decode::<Avc420BitmapStream<'a>>(bitmap_data)
            .map(|stream| stream.data)
            .map_err(|err| format!("Avc420BitmapStream decode failed: {err}")),
        Codec1Type::Avc444 | Codec1Type::Avc444v2 => decode::<Avc444BitmapStream<'a>>(bitmap_data)
            .map(|stream| stream.stream1.data)
            .map_err(|err| format!("Avc444BitmapStream decode failed: {err}")),
        other => Err(format!("unsupported H264 codec: {other:?}")),
    }
}

fn rgb24_to_rgba(rgb: &[u8]) -> Option<Vec<u8>> {
    if rgb.len() % 3 != 0 {
        return None;
    }

    let mut rgba = Vec::with_capacity(rgb.len() / 3 * 4);
    for pixel in rgb.chunks_exact(3) {
        rgba.extend_from_slice(&[pixel[0], pixel[1], pixel[2], 0xff]);
    }
    Some(rgba)
}

fn gfx_region_dimensions(
    rect: &ironrdp::pdu::geometry::InclusiveRectangle,
    payload_len: usize,
    bytes_per_pixel: usize,
) -> Option<(u16, u16)> {
    let inclusive_w = usize::from(rect.width());
    let inclusive_h = usize::from(rect.height());
    if inclusive_w * inclusive_h * bytes_per_pixel == payload_len {
        return Some((rect.width(), rect.height()));
    }

    let exclusive_w = usize::from(rect.right.saturating_sub(rect.left));
    let exclusive_h = usize::from(rect.bottom.saturating_sub(rect.top));
    if exclusive_w > 0
        && exclusive_h > 0
        && exclusive_w * exclusive_h * bytes_per_pixel == payload_len
    {
        return Some((
            rect.right.saturating_sub(rect.left),
            rect.bottom.saturating_sub(rect.top),
        ));
    }

    None
}

fn gfx_rect_dimensions_for_codec(
    rect: &ironrdp::pdu::geometry::InclusiveRectangle,
) -> SmallVec<[(u16, u16); 2]> {
    let exclusive_w = rect.right.saturating_sub(rect.left);
    let exclusive_h = rect.bottom.saturating_sub(rect.top);
    let inclusive = (rect.width(), rect.height());
    let mut dimensions = SmallVec::new();

    if exclusive_w > 0 && exclusive_h > 0 {
        dimensions.push((exclusive_w, exclusive_h));
    }
    if dimensions.first().copied() != Some(inclusive) {
        dimensions.push(inclusive);
    }

    dimensions
}

fn gfx_region_can_suppress_bitmap_fallback(
    width: u16,
    height: u16,
    surface_width: u16,
    surface_height: u16,
) -> bool {
    let area = u32::from(width) * u32::from(height);
    let surface_area = u32::from(surface_width) * u32::from(surface_height);
    area.saturating_mul(MIN_GFX_FALLBACK_SUPPRESS_AREA_RATIO) >= surface_area
}

fn gfx_bgra_to_rgba(data: &[u8], pixel_format: GfxPixelFormat) -> Option<Vec<u8>> {
    if data.len() % 4 != 0 {
        return None;
    }

    let mut rgba = Vec::with_capacity(data.len());
    for pixel in data.chunks_exact(4) {
        let b = pixel[0];
        let g = pixel[1];
        let r = pixel[2];
        let a = match pixel_format {
            GfxPixelFormat::XRgb => 0xff,
            GfxPixelFormat::ARgb => pixel[3],
        };
        rgba.extend_from_slice(&[r, g, b, a]);
    }
    Some(rgba)
}

fn hex_prefix(bytes: &[u8], max_len: usize) -> String {
    bytes
        .iter()
        .take(max_len)
        .map(|byte| format!("{byte:02x}"))
        .collect::<Vec<_>>()
        .join(" ")
}

struct LoggingDvcListener {
    channel_name: &'static str,
}

impl LoggingDvcListener {
    fn new(channel_name: &'static str) -> Self {
        Self { channel_name }
    }
}

impl ironrdp::dvc::DvcChannelListener for LoggingDvcListener {
    fn channel_name(&self) -> &str {
        self.channel_name
    }

    fn create(&mut self) -> Option<Box<dyn ironrdp::dvc::DvcProcessor>> {
        Some(Box::new(LoggingDvcProcessor::new(self.channel_name)))
    }
}

struct LoggingDvcProcessor {
    channel_name: &'static str,
    payload_count: usize,
}

impl LoggingDvcProcessor {
    fn new(channel_name: &'static str) -> Self {
        Self {
            channel_name,
            payload_count: 0,
        }
    }
}

impl_as_any!(LoggingDvcProcessor);

impl ironrdp::dvc::DvcProcessor for LoggingDvcProcessor {
    fn channel_name(&self) -> &str {
        self.channel_name
    }

    fn start(&mut self, channel_id: u32) -> ironrdp::pdu::PduResult<Vec<ironrdp::dvc::DvcMessage>> {
        log::info!(
            "[rdp-native] Diagnostic DVC opened: '{}' id={channel_id}",
            self.channel_name
        );
        Ok(Vec::new())
    }

    fn process(
        &mut self,
        channel_id: u32,
        payload: &[u8],
    ) -> ironrdp::pdu::PduResult<Vec<ironrdp::dvc::DvcMessage>> {
        self.payload_count += 1;
        if self.payload_count <= LOGGING_DVC_MAX_PAYLOAD_LOGS {
            log::info!(
                "[rdp-native] Diagnostic DVC payload: '{}' id={channel_id} #{} {}B prefix=[{}]",
                self.channel_name,
                self.payload_count,
                payload.len(),
                hex_prefix(payload, 32)
            );
        } else if self.payload_count == LOGGING_DVC_MAX_PAYLOAD_LOGS + 1 {
            log::info!(
                "[rdp-native] Diagnostic DVC payload logging suppressed: '{}' after {} messages",
                self.channel_name,
                LOGGING_DVC_MAX_PAYLOAD_LOGS
            );
        }
        Ok(Vec::new())
    }

    fn close(&mut self, channel_id: u32) {
        log::info!(
            "[rdp-native] Diagnostic DVC closed: '{}' id={channel_id} payloads={}",
            self.channel_name,
            self.payload_count
        );
    }
}

struct NativeGfxHandler {
    frame_tx: FrameSender,
    gfx_frame_seen: Arc<AtomicBool>,
    gfx_error: SharedGfxError,
    render_mode: NativeRenderMode,
    bitmap_decoder: BitmapStreamDecoder,
    rfx_decoders: HashMap<u32, session::rfx::DecodingContext>,
    surface_images: HashMap<u16, DecodedImage>,
    surfaces: HashMap<u16, (u16, u16)>,
}

impl NativeGfxHandler {
    fn new(
        frame_tx: FrameSender,
        gfx_frame_seen: Arc<AtomicBool>,
        gfx_error: SharedGfxError,
        render_mode: NativeRenderMode,
    ) -> Self {
        Self {
            frame_tx,
            gfx_frame_seen,
            gfx_error,
            render_mode,
            bitmap_decoder: BitmapStreamDecoder::default(),
            rfx_decoders: HashMap::new(),
            surface_images: HashMap::new(),
            surfaces: HashMap::new(),
        }
    }

    fn mark_gfx_frame_seen(&self, kind: &str) {
        if !self.gfx_frame_seen.swap(true, Ordering::Relaxed) {
            log::info!("[rdp-native] GFX first drawable frame confirmed: {kind}");
        }
    }

    fn mark_gfx_frame_seen_if_large_enough(
        &self,
        kind: &str,
        width: u16,
        height: u16,
        surface_width: u16,
        surface_height: u16,
    ) {
        if gfx_region_can_suppress_bitmap_fallback(width, height, surface_width, surface_height) {
            self.mark_gfx_frame_seen(kind);
        } else if !self.gfx_frame_seen.load(Ordering::Relaxed) {
            log::debug!(
                "[rdp-native] GFX {kind} frame kept with bitmap fallback: region={}x{} surface={}x{}",
                width,
                height,
                surface_width,
                surface_height
            );
        }
    }

    fn handle_uncompressed(&mut self, w2s: ironrdp_egfx::pdu::WireToSurface1Pdu) {
        let rect = w2s.destination_rectangle;
        let Some((surface_width, surface_height)) = self.surfaces.get(&w2s.surface_id).copied()
        else {
            log::warn!(
                "[rdp-native] GFX Uncompressed skipped: unknown surface id={}",
                w2s.surface_id
            );
            return;
        };

        let Some((width, height)) = gfx_region_dimensions(&rect, w2s.bitmap_data.len(), 4) else {
            log::warn!(
                "[rdp-native] GFX Uncompressed skipped: payload length mismatch surface={} pixel_format={:?} rect={}x{}..{}x{} payload={}B",
                w2s.surface_id,
                w2s.pixel_format,
                rect.left,
                rect.top,
                rect.right,
                rect.bottom,
                w2s.bitmap_data.len(),
            );
            return;
        };

        let Some(rgba) = gfx_bgra_to_rgba(&w2s.bitmap_data, w2s.pixel_format) else {
            log::warn!(
                "[rdp-native] GFX Uncompressed skipped: invalid pixel data len={}",
                w2s.bitmap_data.len()
            );
            return;
        };

        let frame = build_raw_frame(
            surface_width,
            surface_height,
            rect.left,
            rect.top,
            width,
            height,
            &rgba,
        );
        static UNCOMPRESSED_FRAME_COUNT: std::sync::atomic::AtomicU64 =
            std::sync::atomic::AtomicU64::new(0);
        let n = UNCOMPRESSED_FRAME_COUNT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        if n < 5 || n % 100 == 0 {
            log::info!(
                "[rdp-native] GFX Uncompressed decoded #{n} surface={} rect={}x{}..{}x{} size={}x{} payload={}B",
                w2s.surface_id,
                rect.left,
                rect.top,
                rect.right,
                rect.bottom,
                width,
                height,
                w2s.bitmap_data.len()
            );
        }
        self.mark_gfx_frame_seen_if_large_enough(
            "Uncompressed",
            width,
            height,
            surface_width,
            surface_height,
        );
        let _ = self.frame_tx.send(frame);
    }

    fn handle_clearcodec(&mut self, w2s: ironrdp_egfx::pdu::WireToSurface1Pdu) {
        let rect = w2s.destination_rectangle;
        let Some((surface_width, surface_height)) = self.surfaces.get(&w2s.surface_id).copied()
        else {
            log::warn!(
                "[rdp-native] GFX ClearCodec skipped: unknown surface id={}",
                w2s.surface_id
            );
            return;
        };

        let mut rgb = Vec::new();
        let mut decoded_size = None;
        let mut last_error = None;
        for (width, height) in gfx_rect_dimensions_for_codec(&rect) {
            rgb.clear();
            match self.bitmap_decoder.decode_bitmap_stream_to_rgb24(
                &w2s.bitmap_data,
                &mut rgb,
                usize::from(width),
                usize::from(height),
            ) {
                Ok(()) => {
                    decoded_size = Some((width, height));
                    break;
                }
                Err(err) => {
                    last_error = Some(err);
                }
            }
        }

        let Some((width, height)) = decoded_size else {
            static CLEARCODEC_DECODE_ERROR_COUNT: std::sync::atomic::AtomicU64 =
                std::sync::atomic::AtomicU64::new(0);
            let n =
                CLEARCODEC_DECODE_ERROR_COUNT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            if n < 5 || n % 100 == 0 {
                let err = last_error
                    .as_ref()
                    .map(ToString::to_string)
                    .unwrap_or_else(|| "unknown decode error".to_string());
                log::warn!(
                    "[rdp-native] GFX ClearCodec decode failed #{n} surface={} pixel_format={:?} rect={}x{}..{}x{} tried={:?} payload={}B prefix=[{}]: {err}",
                    w2s.surface_id,
                    w2s.pixel_format,
                    rect.left,
                    rect.top,
                    rect.right,
                    rect.bottom,
                    gfx_rect_dimensions_for_codec(&rect),
                    w2s.bitmap_data.len(),
                    hex_prefix(&w2s.bitmap_data, 16),
                );
            }
            return;
        };

        let Some(rgba) = rgb24_to_rgba(&rgb) else {
            log::error!(
                "[rdp-native] GFX ClearCodec decode produced invalid rgb len={}",
                rgb.len()
            );
            return;
        };

        let frame = build_raw_frame(
            surface_width,
            surface_height,
            rect.left,
            rect.top,
            width,
            height,
            &rgba,
        );
        static CLEARCODEC_FRAME_COUNT: std::sync::atomic::AtomicU64 =
            std::sync::atomic::AtomicU64::new(0);
        let n = CLEARCODEC_FRAME_COUNT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        if n < 5 || n % 100 == 0 {
            log::info!(
                "[rdp-native] GFX ClearCodec decoded #{n} surface={} rect={}x{}..{}x{} rgb={}B rgba={}B",
                w2s.surface_id,
                rect.left,
                rect.top,
                rect.right,
                rect.bottom,
                rgb.len(),
                rgba.len()
            );
        }
        self.mark_gfx_frame_seen_if_large_enough(
            "ClearCodec",
            width,
            height,
            surface_width,
            surface_height,
        );
        let _ = self.frame_tx.send(frame);
    }

    fn emit_image_rect(
        &self,
        image: &DecodedImage,
        rect: ironrdp::pdu::geometry::InclusiveRectangle,
    ) {
        let rw = rect.width();
        let rh = rect.height();
        let stride = image.stride();
        let bpp = image.bytes_per_pixel();
        let src = image.data();
        let row_bytes = usize::from(rw) * bpp;
        let mut region_data = Vec::with_capacity(usize::from(rh) * row_bytes);

        for row in 0..usize::from(rh) {
            let y = usize::from(rect.top) + row;
            let start = y * stride + usize::from(rect.left) * bpp;
            region_data.extend_from_slice(&src[start..start + row_bytes]);
        }

        let frame = build_raw_frame(
            image.width(),
            image.height(),
            rect.left,
            rect.top,
            rw,
            rh,
            &region_data,
        );
        let _ = self.frame_tx.send(frame);
    }

    fn handle_remote_fx_progressive(&mut self, w2s: ironrdp_egfx::pdu::WireToSurface2Pdu) {
        let Some((surface_width, surface_height)) = self.surfaces.get(&w2s.surface_id).copied()
        else {
            log::warn!(
                "[rdp-native] GFX RemoteFxProgressive skipped: unknown surface id={}",
                w2s.surface_id
            );
            return;
        };

        let destination = ironrdp::pdu::geometry::InclusiveRectangle {
            left: 0,
            top: 0,
            right: surface_width.saturating_sub(1),
            bottom: surface_height.saturating_sub(1),
        };
        let decoder = self
            .rfx_decoders
            .entry(w2s.codec_context_id)
            .or_insert_with(session::rfx::DecodingContext::new);
        let image = self
            .surface_images
            .entry(w2s.surface_id)
            .or_insert_with(|| {
                DecodedImage::new(PixelFormat::RgbA32, surface_width, surface_height)
            });

        let mut cursor = ironrdp::pdu::ReadCursor::new(&w2s.bitmap_data);
        let mut decoded_rects = Vec::new();
        while !cursor.is_empty() {
            match decoder.decode(image, &destination, &mut cursor) {
                Ok((_frame_id, rect)) => decoded_rects.push(rect),
                Err(err) => {
                    static RFX_PROGRESSIVE_ERROR_COUNT: std::sync::atomic::AtomicU64 =
                        std::sync::atomic::AtomicU64::new(0);
                    let n = RFX_PROGRESSIVE_ERROR_COUNT
                        .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    if n < 8 || n % 100 == 0 {
                        log::warn!(
                            "[rdp-native] GFX RemoteFxProgressive decode failed #{n} surface={} context={} payload={}B prefix=[{}]: {err}",
                            w2s.surface_id,
                            w2s.codec_context_id,
                            w2s.bitmap_data.len(),
                            hex_prefix(&w2s.bitmap_data, 16),
                        );
                    }
                    break;
                }
            }
        }

        if decoded_rects.is_empty() {
            return;
        }

        static RFX_PROGRESSIVE_FRAME_COUNT: std::sync::atomic::AtomicU64 =
            std::sync::atomic::AtomicU64::new(0);
        for rect in decoded_rects {
            let n = RFX_PROGRESSIVE_FRAME_COUNT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            if n < 8 || n % 100 == 0 {
                log::info!(
                    "[rdp-native] GFX RemoteFxProgressive decoded #{n} surface={} context={} rect={}x{}..{}x{} payload={}B",
                    w2s.surface_id,
                    w2s.codec_context_id,
                    rect.left,
                    rect.top,
                    rect.right,
                    rect.bottom,
                    w2s.bitmap_data.len(),
                );
            }
            self.mark_gfx_frame_seen("RemoteFxProgressive");
            if let Some(image) = self.surface_images.get(&w2s.surface_id) {
                self.emit_image_rect(image, rect);
            }
        }
    }
}

impl GraphicsPipelineHandler for NativeGfxHandler {
    fn capabilities(&self) -> Vec<CapabilitySet> {
        gfx_h264_capabilities()
    }

    fn handle_pdu(&mut self, pdu: GfxPdu) -> Option<GfxPdu> {
        match pdu {
            GfxPdu::WireToSurface1(w2s) => {
                let is_h264 = matches!(
                    w2s.codec_id,
                    Codec1Type::Avc420 | Codec1Type::Avc444 | Codec1Type::Avc444v2
                );

                if is_h264 {
                    let rect = w2s.destination_rectangle;
                    let h264_payload = match extract_gfx_h264_payload(
                        w2s.codec_id,
                        &w2s.bitmap_data,
                    ) {
                        Ok(payload) => payload,
                        Err(err) => {
                            log::warn!(
                                    "[rdp-native] GFX H264 skipped: surface={} codec={:?} rect={}x{}..{}x{} wrapped_payload={}B prefix=[{}]: {err}",
                                    w2s.surface_id,
                                    w2s.codec_id,
                                    rect.left,
                                    rect.top,
                                    rect.right,
                                    rect.bottom,
                                    w2s.bitmap_data.len(),
                                    hex_prefix(&w2s.bitmap_data, 16),
                                );
                            return None;
                        }
                    };
                    let frame = build_gfx_h264_frame(
                        w2s.surface_id,
                        w2s.codec_id,
                        rect.left,
                        rect.top,
                        rect.right,
                        rect.bottom,
                        h264_payload,
                    );
                    static GFX_FRAME_COUNT: std::sync::atomic::AtomicU64 =
                        std::sync::atomic::AtomicU64::new(0);
                    let n = GFX_FRAME_COUNT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    if n < 5 || n % 100 == 0 {
                        log::info!(
                            "[rdp-native] GFX H264 #{n} surface={} codec={:?} rect={}x{}..{}x{} payload={}B",
                            w2s.surface_id,
                            w2s.codec_id,
                            rect.left,
	                            rect.top,
	                            rect.right,
	                            rect.bottom,
	                            h264_payload.len()
	                        );
                    }
                    self.mark_gfx_frame_seen("H264");
                    let _ = self.frame_tx.send(frame);
                } else if w2s.codec_id == Codec1Type::Uncompressed {
                    self.handle_uncompressed(w2s);
                } else if w2s.codec_id == Codec1Type::ClearCodec {
                    self.handle_clearcodec(w2s);
                } else {
                    log::warn!(
                        "[rdp-native] GFX WireToSurface1 non-H264 codec={:?} payload={}B",
                        w2s.codec_id,
                        w2s.bitmap_data.len()
                    );
                }
            }
            GfxPdu::CreateSurface(surface) => {
                self.surfaces
                    .insert(surface.surface_id, (surface.width, surface.height));
                self.surface_images.insert(
                    surface.surface_id,
                    DecodedImage::new(PixelFormat::RgbA32, surface.width, surface.height),
                );
                log::info!(
                    "[rdp-native] GFX CreateSurface id={} {}x{}",
                    surface.surface_id,
                    surface.width,
                    surface.height
                );
            }
            GfxPdu::DeleteSurface(surface) => {
                self.surfaces.remove(&surface.surface_id);
                self.surface_images.remove(&surface.surface_id);
                log::info!("[rdp-native] GFX DeleteSurface id={}", surface.surface_id);
            }
            GfxPdu::MapSurfaceToOutput(map) => {
                log::info!(
                    "[rdp-native] GFX MapSurfaceToOutput id={} origin={},{}",
                    map.surface_id,
                    map.output_origin_x,
                    map.output_origin_y
                );
            }
            GfxPdu::ResetGraphics(reset) => {
                self.surfaces.clear();
                self.surface_images.clear();
                self.rfx_decoders.clear();
                log::info!(
                    "[rdp-native] GFX ResetGraphics {}x{}",
                    reset.width,
                    reset.height
                );
            }
            GfxPdu::StartFrame(frame) => {
                log::trace!("[rdp-native] GFX StartFrame id={}", frame.frame_id);
            }
            GfxPdu::EndFrame(frame) => {
                log::trace!("[rdp-native] GFX EndFrame id={}", frame.frame_id);
            }
            GfxPdu::CapabilitiesConfirm(confirm) => {
                if gfx_capability_confirms_h264(&confirm.0) {
                    log::info!(
                        "[rdp-native] GFX H.264 capability confirmed: {:?}",
                        confirm.0
                    );
                } else if self.render_mode.requires_h264() {
                    let message = gfx_unsupported_message(&confirm.0);
                    log::error!("[rdp-native] {message}");
                    set_gfx_error_once(&self.gfx_error, message);
                } else {
                    log::warn!(
                        "[rdp-native] GFX H.264 not confirmed in auto mode; keeping bitmap fallback. Confirmed capability: {:?}",
                        confirm.0
                    );
                }
            }
            GfxPdu::WireToSurface2(w2s) => {
                static W2S2_COUNT: std::sync::atomic::AtomicU64 =
                    std::sync::atomic::AtomicU64::new(0);
                let n = W2S2_COUNT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                if n < 10 || n % 100 == 0 {
                    log::info!(
                        "[rdp-native] GFX WireToSurface2 #{n} surface={} codec={:?} context={} pixel_format={:?} payload={}B prefix=[{}]",
                        w2s.surface_id,
                        w2s.codec_id,
                        w2s.codec_context_id,
                        w2s.pixel_format,
                        w2s.bitmap_data.len(),
                        hex_prefix(&w2s.bitmap_data, 16),
                    );
                }
                if w2s.codec_id == ironrdp_egfx::pdu::Codec2Type::RemoteFxProgressive {
                    self.handle_remote_fx_progressive(w2s);
                }
            }
            GfxPdu::SurfaceToCache(cache) => {
                static SURFACE_TO_CACHE_COUNT: std::sync::atomic::AtomicU64 =
                    std::sync::atomic::AtomicU64::new(0);
                let n = SURFACE_TO_CACHE_COUNT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                if n < 10 || n % 100 == 0 {
                    log::info!(
                        "[rdp-native] GFX SurfaceToCache #{n} surface={} slot={} key={} rect={}x{}..{}x{}",
                        cache.surface_id,
                        cache.cache_slot,
                        cache.cache_key,
                        cache.source_rectangle.left,
                        cache.source_rectangle.top,
                        cache.source_rectangle.right,
                        cache.source_rectangle.bottom,
                    );
                }
            }
            GfxPdu::CacheToSurface(cache) => {
                static CACHE_TO_SURFACE_COUNT: std::sync::atomic::AtomicU64 =
                    std::sync::atomic::AtomicU64::new(0);
                let n = CACHE_TO_SURFACE_COUNT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                if n < 10 || n % 100 == 0 {
                    log::info!(
                        "[rdp-native] GFX CacheToSurface #{n} surface={} slot={} points={}",
                        cache.surface_id,
                        cache.cache_slot,
                        cache.destination_points.len(),
                    );
                }
            }
            GfxPdu::SurfaceToSurface(surface) => {
                static SURFACE_TO_SURFACE_COUNT: std::sync::atomic::AtomicU64 =
                    std::sync::atomic::AtomicU64::new(0);
                let n = SURFACE_TO_SURFACE_COUNT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                if n < 10 || n % 100 == 0 {
                    log::info!(
                        "[rdp-native] GFX SurfaceToSurface #{n} source={} destination={} rect={}x{}..{}x{} points={}",
                        surface.source_surface_id,
                        surface.destination_surface_id,
                        surface.source_rectangle.left,
                        surface.source_rectangle.top,
                        surface.source_rectangle.right,
                        surface.source_rectangle.bottom,
                        surface.destination_points.len(),
                    );
                }
            }
            GfxPdu::SolidFill(fill) => {
                static SOLID_FILL_COUNT: std::sync::atomic::AtomicU64 =
                    std::sync::atomic::AtomicU64::new(0);
                let n = SOLID_FILL_COUNT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                if n < 10 || n % 100 == 0 {
                    log::info!(
                        "[rdp-native] GFX SolidFill #{n} surface={} rects={}",
                        fill.surface_id,
                        fill.rectangles.len(),
                    );
                }
            }
            other => {
                static OTHER_GFX_PDU_COUNT: std::sync::atomic::AtomicU64 =
                    std::sync::atomic::AtomicU64::new(0);
                let n = OTHER_GFX_PDU_COUNT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                if n < 10 || n % 100 == 0 {
                    log::debug!("[rdp-native] GFX PDU skipped #{n}: {:?}", other);
                }
            }
        }

        None
    }
}

#[derive(Clone, Copy)]
struct RawFrameHeader {
    desktop_width: u16,
    desktop_height: u16,
    x: u16,
    y: u16,
    width: u16,
    height: u16,
}

fn write_raw_frame_header(buf: &mut Vec<u8>, header: RawFrameHeader) {
    buf.extend_from_slice(&header.desktop_width.to_le_bytes());
    buf.extend_from_slice(&header.desktop_height.to_le_bytes());
    buf.extend_from_slice(&header.x.to_le_bytes());
    buf.extend_from_slice(&header.y.to_le_bytes());
    buf.extend_from_slice(&header.width.to_le_bytes());
    buf.extend_from_slice(&header.height.to_le_bytes());
}

fn build_uncompressed_raw_frame(header: RawFrameHeader, pixel_data: &[u8]) -> Vec<u8> {
    let mut buf = Vec::with_capacity(FRAME_HEADER_SIZE + pixel_data.len());
    write_raw_frame_header(&mut buf, header);
    buf.extend_from_slice(pixel_data);
    buf
}

/// Build a raw binary frame packet with LZ4 compression for larger regions.
///
/// Compressed format: [12B header] + [4B uncompressed_len] + [LZ4 compressed pixels]
/// The compression flag is bit15 of desktop_width in the header.
/// Uncompressed fallback: [12B header] + [raw RGBA pixels]
fn build_raw_frame(
    desktop_width: u16,
    desktop_height: u16,
    x: u16,
    y: u16,
    width: u16,
    height: u16,
    pixel_data: &[u8],
) -> Vec<u8> {
    let header = RawFrameHeader {
        desktop_width,
        desktop_height,
        x,
        y,
        width,
        height,
    };

    // Loopback WebSocket bandwidth is cheaper than per-frame Rust compression
    // plus main-thread JS decompression for small dirty rectangles.
    if pixel_data.len() < MIN_LZ4_FRAME_BYTES {
        return build_uncompressed_raw_frame(header, pixel_data);
    }

    let compressed = lz4_flex::compress_prepend_size(pixel_data);

    // Use compressed only if it actually saves space
    if compressed.len() >= pixel_data.len() {
        return build_uncompressed_raw_frame(header, pixel_data);
    }

    // Compressed frame: set bit15 on desktop_width as flag
    let header = RawFrameHeader {
        desktop_width: desktop_width | 0x8000,
        ..header
    };
    let uncompressed_len = pixel_data.len() as u32;

    let mut buf = Vec::with_capacity(FRAME_HEADER_SIZE + 4 + compressed.len());
    write_raw_frame_header(&mut buf, header);
    buf.extend_from_slice(&uncompressed_len.to_le_bytes());
    buf.extend_from_slice(&compressed);
    buf
}

struct BitmapFrameStats {
    total_frames: u64,
    total_raw_bytes: u64,
    total_sent_bytes: u64,
    interval_frames: u64,
    interval_raw_bytes: u64,
    interval_sent_bytes: u64,
    last_log_at: Instant,
}

impl BitmapFrameStats {
    fn new() -> Self {
        Self {
            total_frames: 0,
            total_raw_bytes: 0,
            total_sent_bytes: 0,
            interval_frames: 0,
            interval_raw_bytes: 0,
            interval_sent_bytes: 0,
            last_log_at: Instant::now(),
        }
    }

    fn record(&mut self, event: BitmapFrameStatsEvent<'_>) {
        self.total_frames += 1;
        self.total_raw_bytes += event.raw_len as u64;
        self.total_sent_bytes += event.sent_len as u64;
        self.interval_frames += 1;
        self.interval_raw_bytes += event.raw_len as u64;
        self.interval_sent_bytes += event.sent_len as u64;

        let elapsed = self.last_log_at.elapsed();
        if self.total_frames <= 5 || elapsed >= Duration::from_secs(5) {
            let secs = elapsed.as_secs_f64().max(0.001);
            let compression_ratio = if event.sent_len > 0 {
                event.raw_len as f64 / event.sent_len as f64
            } else {
                0.0
            };
            log::info!(
                "[rdp-native][frame-stats] tab={} ws_port={} route={} produced_frames={} produced_fps={:.1} raw_mib_s={:.2} sent_mib_s={:.2} total_frames={} total_sent_mib={:.2} last_region={}x{} compression={:.1}x receivers={}",
                event.tab_id,
                event.ws_port,
                event.route_label,
                self.interval_frames,
                self.interval_frames as f64 / secs,
                bytes_to_mib(self.interval_raw_bytes) / secs,
                bytes_to_mib(self.interval_sent_bytes) / secs,
                self.total_frames,
                bytes_to_mib(self.total_sent_bytes),
                event.region_width,
                event.region_height,
                compression_ratio,
                event.receivers
            );
            self.interval_frames = 0;
            self.interval_raw_bytes = 0;
            self.interval_sent_bytes = 0;
            self.last_log_at = Instant::now();
        }
    }
}

struct BitmapFrameStatsEvent<'a> {
    tab_id: &'a str,
    ws_port: u16,
    route_label: &'a str,
    region_width: u16,
    region_height: u16,
    raw_len: usize,
    sent_len: usize,
    receivers: usize,
}

fn bytes_to_mib(bytes: u64) -> f64 {
    bytes as f64 / 1024.0 / 1024.0
}

fn native_resize_matches_desktop_size(
    current_width: u16,
    current_height: u16,
    requested_width: u16,
    requested_height: u16,
) -> bool {
    current_width == requested_width && current_height == requested_height
}

// ── Tauri Event Payloads (small, infrequent) ────────────────

/// Session status change event (via `emit`, not Channel).
#[derive(Clone, Serialize)]
pub struct RdpStatusEvent {
    pub tab_id: String,
    pub status: String, // "connected" | "disconnected" | "error"
    pub message: Option<String>,
}

/// Pointer (cursor) event (via `emit`, not Channel).
#[derive(Clone, Serialize, Default)]
pub struct RdpPointerEvent {
    pub tab_id: String,
    pub kind: String, // "default" | "hidden" | "position" | "bitmap"
    pub x: Option<u16>,
    pub y: Option<u16>,
    pub width: Option<u16>,
    pub height: Option<u16>,
    pub hotspot_x: Option<u16>,
    pub hotspot_y: Option<u16>,
    /// RGBA bitmap data for custom cursor
    pub bitmap: Option<Vec<u8>>,
}

// ── Input Events (Frontend → Rust) ──────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NativeRdpInput {
    FastPath(SmallVec<[FastPathInputEvent; 2]>),
    MouseMove { x: u16, y: u16 },
    Resize { width: u16, height: u16 },
    ForceClipboardCheck,
    Close,
}

fn coalesce_input_burst<I>(inputs: I) -> Vec<NativeRdpInput>
where
    I: IntoIterator<Item = NativeRdpInput>,
{
    let mut coalesced = Vec::new();
    let mut pending_move = None;

    for input in inputs {
        match input {
            NativeRdpInput::MouseMove { .. } => {
                pending_move = Some(input);
            }
            NativeRdpInput::Close => {
                if let Some(mouse_move) = pending_move.take() {
                    coalesced.push(mouse_move);
                }
                coalesced.push(NativeRdpInput::Close);
                break;
            }
            other => {
                if let Some(mouse_move) = pending_move.take() {
                    coalesced.push(mouse_move);
                }
                coalesced.push(other);
            }
        }
    }

    if let Some(mouse_move) = pending_move {
        coalesced.push(mouse_move);
    }

    coalesced
}

fn drain_coalesced_inputs(
    first: NativeRdpInput,
    input_rx: &mut mpsc::UnboundedReceiver<NativeRdpInput>,
) -> Vec<NativeRdpInput> {
    let mut inputs = Vec::with_capacity(64);
    inputs.push(first);

    for _ in 0..INPUT_DRAIN_LIMIT {
        match input_rx.try_recv() {
            Ok(input) => {
                let should_stop = matches!(input, NativeRdpInput::Close);
                inputs.push(input);
                if should_stop {
                    break;
                }
            }
            Err(_) => break,
        }
    }

    coalesce_input_burst(inputs)
}
// ── Session Management ──────────────────────────────────────

/// Handle to a running native RDP session.
pub struct SessionHandle {
    pub input_tx: mpsc::UnboundedSender<NativeRdpInput>,
    #[allow(dead_code)]
    join_handle: Option<std::thread::JoinHandle<()>>,
}

/// Manages all active native RDP sessions.
#[derive(Default)]
pub struct SessionManager {
    sessions: std::collections::HashMap<String, SessionHandle>,
}

impl SessionManager {
    pub fn get_input_tx(&self, tab_id: &str) -> Option<&mpsc::UnboundedSender<NativeRdpInput>> {
        self.sessions.get(tab_id).map(|h| &h.input_tx)
    }

    pub fn insert(&mut self, tab_id: String, handle: SessionHandle) {
        // Close existing session if any
        if let Some(old) = self.sessions.remove(&tab_id) {
            log::info!("[rdp-native] Replacing existing session: {tab_id}");
            let _ = old.input_tx.send(NativeRdpInput::Close);
        }
        self.sessions.insert(tab_id, handle);
    }

    pub fn disconnect(&mut self, tab_id: &str) {
        if let Some(handle) = self.sessions.remove(tab_id) {
            log::info!("[rdp-native] Disconnect requested: {tab_id}");
            let _ = handle.input_tx.send(NativeRdpInput::Close);
        }
    }
}

// ── Connection Configuration ────────────────────────────────

fn connect_config_for_route(
    username: &str,
    password: &str,
    domain: Option<&str>,
    width: u16,
    height: u16,
    route: NativeRdpRoute,
) -> connector::Config {
    use ironrdp::pdu::gcc;
    use ironrdp::pdu::rdp::capability_sets;
    use ironrdp::pdu::rdp::client_info;

    connector::Config {
        credentials: connector::Credentials::UsernamePassword {
            username: username.to_string(),
            password: password.to_string(),
        },
        domain: domain.map(|d| d.to_string()),
        enable_tls: true,
        enable_credssp: true,
        desktop_size: connector::DesktopSize { width, height },
        desktop_scale_factor: 0,
        client_build: 0,
        client_name: "NextDesk".to_string(),
        keyboard_type: gcc::KeyboardType::IbmEnhanced,
        keyboard_subtype: 0,
        keyboard_functional_keys_count: 12,
        keyboard_layout: 0x0409, // US English
        ime_file_name: String::new(),
        bitmap: None,
        dig_product_id: String::new(),
        client_dir: "C:\\Windows\\System32\\mstscax.dll".to_string(),
        alternate_shell: String::new(),
        work_dir: String::new(),
        platform: capability_sets::MajorPlatformType::UNSPECIFIED,
        hardware_id: None,
        request_data: None,
        autologon: true,
        enable_audio_playback: true,
        performance_flags: performance_flags_for_route(route),
        license_cache: None,
        timezone_info: client_info::TimezoneInfo::default(),
        compression_type: compression_type_for_route(route),
        enable_server_pointer: true,
        pointer_software_rendering: false,
        multitransport_flags: None,
    }
}

fn compression_type_for_route(
    route: NativeRdpRoute,
) -> Option<ironrdp::pdu::rdp::client_info::CompressionType> {
    use ironrdp::pdu::rdp::client_info;

    match route {
        NativeRdpRoute::Direct => None,
    }
}

fn to_bulk_compression_type(
    compression_type: ironrdp::pdu::rdp::client_info::CompressionType,
) -> ironrdp_bulk::CompressionType {
    use ironrdp::pdu::rdp::client_info::CompressionType;

    match compression_type {
        CompressionType::K8 => ironrdp_bulk::CompressionType::Rdp4,
        CompressionType::K64 => ironrdp_bulk::CompressionType::Rdp5,
        CompressionType::Rdp6 => ironrdp_bulk::CompressionType::Rdp6,
        CompressionType::Rdp61 => ironrdp_bulk::CompressionType::Rdp61,
    }
}

fn bulk_decompressor_for_route(route: NativeRdpRoute) -> Option<ironrdp_bulk::BulkCompressor> {
    compression_type_for_route(route).and_then(|compression_type| {
        let bulk_type = to_bulk_compression_type(compression_type);
        match ironrdp_bulk::BulkCompressor::new(bulk_type) {
            Ok(decompressor) => {
                log::info!(
                    "[rdp-native] Bulk decompressor initialized for reactivation: {:?}",
                    bulk_type
                );
                Some(decompressor)
            }
            Err(error) => {
                log::error!(
                    "[rdp-native] Failed to create reactivation bulk decompressor: {error}"
                );
                None
            }
        }
    })
}

fn performance_flags_for_route(
    route: NativeRdpRoute,
) -> ironrdp::pdu::rdp::client_info::PerformanceFlags {
    use ironrdp::pdu::rdp::client_info;

    match route {
        NativeRdpRoute::Direct => {
            client_info::PerformanceFlags::ENABLE_FONT_SMOOTHING
                | client_info::PerformanceFlags::ENABLE_DESKTOP_COMPOSITION
        }
    }
}

/// Spawn a native RDP session as a background OS thread.
///
/// The `frame_channel` is a Tauri `Channel` passed from the frontend
/// `invoke('rdp_native_connect', { onFrame: channel })` call.
/// It provides high-performance streaming — no global event broadcast,
/// no JSON array-of-numbers serialization.
///
/// Returns a `SessionHandle` for sending input and managing lifecycle.
pub fn spawn_session(
    app: tauri::AppHandle,
    tab_id: String,
    host: String,
    port: u16,
    username: String,
    password: String,
    domain: Option<String>,
    width: u16,
    height: u16,
    frame_tx: FrameSender,
    frame_ws_port: u16,
    frame_ws_shutdown: FrameServerShutdown,
    frame_transport: NativeFrameTransport,
) -> SessionHandle {
    let (input_tx, input_rx) = mpsc::unbounded_channel::<NativeRdpInput>();

    // Spawn on a dedicated OS thread with its own tokio runtime.
    // This avoids the Send bound issues with ironrdp_tokio::connect_finalize
    // which uses &NetworkRequest with non-general lifetimes.
    let join_handle = std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("failed to build tokio runtime for RDP session");

        rt.block_on(async move {
            let tab_id_inner = tab_id.clone();
            let app_inner = app.clone();
            let result = run_session(
                app_inner,
                tab_id_inner,
                host,
                port,
                username,
                password,
                domain,
                width,
                height,
                input_rx,
                frame_tx,
                frame_ws_port,
                frame_transport,
            )
            .await;

            let _ = frame_ws_shutdown.send(());

            match &result {
                Ok(reason) => {
                    log::info!("[rdp-native] Session {tab_id} ended: {reason:?}");
                    let _ = app.emit(
                        "rdp://status",
                        RdpStatusEvent {
                            tab_id,
                            status: "disconnected".into(),
                            message: Some(format!("{reason:?}")),
                        },
                    );
                }
                Err(e) => {
                    log::error!("[rdp-native] Session {tab_id} error: {e}");
                    let _ = app.emit(
                        "rdp://status",
                        RdpStatusEvent {
                            tab_id,
                            status: "error".into(),
                            message: Some(format!("{e}")),
                        },
                    );
                }
            }
        });
    });

    SessionHandle {
        input_tx,
        join_handle: Some(join_handle),
    }
}

// ── Session Runner ──────────────────────────────────────────

trait AsyncReadWrite: AsyncRead + AsyncWrite {}
impl<T> AsyncReadWrite for T where T: AsyncRead + AsyncWrite {}

type UpgradedFramed = ironrdp_tokio::TokioFramed<Box<dyn AsyncReadWrite + Unpin + Send + Sync>>;

/// Main session lifecycle: connect → active loop → disconnect.
async fn run_session(
    app: tauri::AppHandle,
    tab_id: String,
    host: String,
    port: u16,
    username: String,
    password: String,
    domain: Option<String>,
    width: u16,
    height: u16,
    mut input_rx: mpsc::UnboundedReceiver<NativeRdpInput>,
    frame_tx: FrameSender,
    frame_ws_port: u16,
    frame_transport: NativeFrameTransport,
) -> Result<GracefulDisconnectReason, String> {
    let route = NativeRdpRoute::Direct;
    let render_mode = native_render_mode_for_route(route, width, height);
    let route_label = native_rdp_route_label(route);
    log::info!(
        "[rdp-native] Session starting tab={tab_id} ws_port={frame_ws_port} host={host}:{port} route={route_label} size={width}x{height} render={render_mode:?} transport={}",
        frame_transport.label()
    );
    let config = connect_config_for_route(
        &username,
        &password,
        domain.as_deref(),
        width,
        height,
        route,
    );

    // Create cliprdr action channel (backend → session loop)
    let (cliprdr_tx, mut cliprdr_rx) = mpsc::unbounded_channel::<CliprdrAction>();
    let temp_dir = dirs::cache_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("NextDesk")
        .join("cliprdr");
    let _ = std::fs::create_dir_all(&temp_dir);
    let temp_dir_str = temp_dir.to_string_lossy().to_string();
    let gfx_frame_seen = Arc::new(AtomicBool::new(false));
    let gfx_error: SharedGfxError = Arc::new(Mutex::new(None));

    // The shared resolver has already selected either the requested target or
    // a cloud relay endpoint. Both are reached with a direct TCP connection.
    let (connection_result, framed) = connect_tcp(
        &host,
        port,
        route,
        &config,
        cliprdr_tx,
        &temp_dir_str,
        &tab_id,
        frame_tx.clone(),
        gfx_frame_seen.clone(),
        gfx_error.clone(),
        render_mode,
        app.clone(),
    )
    .await
    .map_err(|e| format!("Connect failed: {e}"))?;

    log::info!(
        "[rdp-native] Connected: {}x{}",
        connection_result.desktop_size.width,
        connection_result.desktop_size.height,
    );

    // Notify frontend: connected
    let _ = app.emit(
        "rdp://status",
        RdpStatusEvent {
            tab_id: tab_id.clone(),
            status: "connected".into(),
            message: None,
        },
    );

    // Run active session loop
    active_session(
        app,
        &tab_id,
        framed,
        connection_result,
        &mut input_rx,
        &mut cliprdr_rx,
        frame_tx,
        gfx_frame_seen,
        gfx_error,
        render_mode,
        frame_ws_port,
        route,
        frame_transport,
    )
    .await
    .map_err(|e| format!("Session error: {e}"))
}

// ── TCP Accelerated Connection ───────────────────────────────

/// Connect directly to the resolved RDP target, then upgrade to TLS.
///
/// Flow: TCP connect → X.224 negotiate → TLS upgrade → NLA/CredSSP → channel join
async fn connect_tcp(
    host: &str,
    port: u16,
    route: NativeRdpRoute,
    config: &connector::Config,
    cliprdr_action_tx: mpsc::UnboundedSender<CliprdrAction>,
    temp_dir: &str,
    session_id: &str,
    frame_tx: FrameSender,
    gfx_frame_seen: Arc<AtomicBool>,
    gfx_error: SharedGfxError,
    render_mode: NativeRenderMode,
    app_handle: tauri::AppHandle,
) -> ConnectorResult<(ConnectionResult, UpgradedFramed)> {
    let stream = connect_rdp_transport(host, port).await?;

    stream
        .set_nodelay(true)
        .map_err(|e| connector::custom_err!("TCP_NODELAY", e))?;

    let client_addr = stream
        .local_addr()
        .map_err(|e| connector::custom_err!("local address", e))?;

    let mut framed = ironrdp_tokio::TokioFramed::new(stream);

    match render_mode {
        NativeRenderMode::Bitmap => {
            log::info!("[rdp-native] Using ActiveStage bitmap dirty-rect pipeline");
        }
        NativeRenderMode::GfxH264Auto => {
            log::info!("[rdp-native] Using RDPGFX auto-probe with bitmap fallback");
        }
        NativeRenderMode::GfxH264Force => {
            log::info!("[rdp-native] Using forced RDPGFX + H.264/WebCodecs pipeline");
        }
    }

    let drdynvc = build_dynamic_virtual_channels(
        frame_tx.clone(),
        render_mode,
        gfx_frame_seen.clone(),
        gfx_error,
    );
    log::info!("[rdp-native] DrdynvcClient channels: {:?}", drdynvc);

    let cliprdr_factory = cliprdr_module::build_factory(
        cliprdr_action_tx,
        app_handle.clone(),
        temp_dir.to_string(),
        session_id.to_string(),
    );
    let cliprdr = cliprdr::Cliprdr::new(cliprdr_factory.build_cliprdr_backend());

    let mut connector = connector::ClientConnector::new(config.clone(), client_addr)
        .with_static_channel(drdynvc)
        .with_static_channel(rdpsnd::client::Rdpsnd::new(Box::new(RdpsndBackend::new())))
        .with_static_channel(
            rdpdr::Rdpdr::new(Box::new(NoopRdpdrBackend {}), "NextDesk".to_owned())
                .with_smartcard(0),
        );
    connector.attach_static_channel(cliprdr);

    // Phase 1: X.224 Connection Request/Confirm
    let should_upgrade = ironrdp_tokio::connect_begin(&mut framed, &mut connector).await?;

    // Phase 2: TLS upgrade
    log::debug!("[rdp-native] TLS upgrade");
    let (initial_stream, leftover_bytes) = framed.into_inner();

    let (upgraded_stream, tls_cert) = ironrdp_tls::upgrade(initial_stream, host)
        .await
        .map_err(|e| connector::custom_err!("TLS upgrade", e))?;

    let upgraded = ironrdp_tokio::mark_as_upgraded(should_upgrade, &mut connector);

    let erased_stream: Box<dyn AsyncReadWrite + Unpin + Send + Sync> = Box::new(upgraded_stream);
    let mut upgraded_framed =
        ironrdp_tokio::TokioFramed::new_with_leftover(erased_stream, leftover_bytes);

    // Phase 3: NLA/CredSSP + Channel Join + Capabilities
    let server_public_key = ironrdp_tls::extract_tls_server_public_key(&tls_cert)
        .ok_or_else(|| connector::general_err!("extract TLS server public key"))?;

    let connection_result = ironrdp_tokio::connect_finalize(
        upgraded,
        connector,
        &mut upgraded_framed,
        &mut ironrdp_tokio::reqwest::ReqwestNetworkClient::new(),
        connector::ServerName::new(host.to_string()),
        server_public_key.to_owned(),
        None,
    )
    .await?;

    // Diagnostic: list all joined static channels
    eprintln!(
        "[rdp-native] RDP handshake complete: {:?}, io={}, user={}",
        connection_result.desktop_size,
        connection_result.io_channel_id,
        connection_result.user_channel_id,
    );
    for (type_id, channel) in connection_result.static_channels.iter() {
        let ch_id = connection_result
            .static_channels
            .get_channel_id_by_type_id(type_id);
        eprintln!(
            "[rdp-native] Joined channel: '{:?}' id={:?}",
            channel.channel_name(),
            ch_id,
        );
    }

    Ok((connection_result, upgraded_framed))
}

async fn connect_rdp_transport(host: &str, port: u16) -> ConnectorResult<TcpStream> {
    let dest = format!("{host}:{port}");
    log::info!("[rdp-native] Direct TCP -> {dest}");
    TcpStream::connect(&dest)
        .await
        .map_err(|e| connector::custom_err!("TCP connect direct", e))
}

fn build_dynamic_virtual_channels(
    frame_tx: FrameSender,
    mode: NativeRenderMode,
    gfx_frame_seen: Arc<AtomicBool>,
    gfx_error: SharedGfxError,
) -> ironrdp::dvc::DrdynvcClient {
    let mut drdynvc = ironrdp::dvc::DrdynvcClient::new()
        .with_dynamic_channel(DisplayControlClient::new(|_| Ok(Vec::new())))
        .with_dynamic_channel(EchoClient::new());

    if mode.uses_gfx_pipeline() {
        drdynvc = drdynvc
            .with_dynamic_channel(GraphicsPipelineClient::new(Box::new(
                NativeGfxHandler::new(frame_tx, gfx_frame_seen, gfx_error, mode),
            )))
            .with_listener(LoggingDvcListener::new(VIDEO_DVC_CONTROL_CHANNEL))
            .with_listener(LoggingDvcListener::new(VIDEO_DVC_DATA_CHANNEL))
            .with_listener(LoggingDvcListener::new(GEOMETRY_DVC_CHANNEL))
            .with_listener(LoggingDvcListener::new(INPUT_DVC_CHANNEL));
        log::info!("[rdp-native] GFX graphics pipeline channel registered");
    }

    drdynvc
}

fn process_native_input(
    active_stage: &mut ActiveStage,
    image: &mut DecodedImage,
    input: NativeRdpInput,
    tab_id: &str,
    frame_ws_port: u16,
) -> SessionResult<Vec<ActiveStageOutput>> {
    match input {
        NativeRdpInput::FastPath(events) => active_stage.process_fastpath_input(image, &events),
        NativeRdpInput::MouseMove { x, y } => {
            let event = FastPathInputEvent::MouseEvent(MousePdu {
                flags: PointerFlags::MOVE,
                number_of_wheel_rotation_units: 0,
                x_position: x,
                y_position: y,
            });
            let events: SmallVec<[FastPathInputEvent; 2]> = smallvec![event];
            active_stage.process_fastpath_input(image, &events)
        }
        NativeRdpInput::Resize { width, height } => {
            if native_resize_matches_desktop_size(image.width(), image.height(), width, height) {
                log::debug!(
                    "[rdp-native] DVC resize skipped current desktop size tab={tab_id} ws_port={frame_ws_port} size={width}x{height}"
                );
                return Ok(Vec::new());
            }

            if let Some(result) =
                active_stage.encode_resize(width as u32, height as u32, None, None)
            {
                match result {
                    Ok(frame) => {
                        log::info!(
                            "[rdp-native] DVC resize tab={tab_id} ws_port={frame_ws_port} size={width}x{height}"
                        );
                        Ok(vec![ActiveStageOutput::ResponseFrame(frame)])
                    }
                    Err(e) => {
                        log::warn!("[rdp-native] DVC resize encode error: {e}");
                        Ok(Vec::new())
                    }
                }
            } else {
                log::debug!("[rdp-native] DVC not ready, resize {width}x{height} ignored");
                Ok(Vec::new())
            }
        }
        NativeRdpInput::ForceClipboardCheck => Ok(Vec::new()),
        NativeRdpInput::Close => active_stage.graceful_shutdown(),
    }
}

// ── Active Session Event Loop ───────────────────────────────

/// Drive the active RDP session: process server frames + frontend input + clipboard.
async fn active_session(
    app: tauri::AppHandle,
    tab_id: &str,
    framed: UpgradedFramed,
    connection_result: ConnectionResult,
    input_rx: &mut mpsc::UnboundedReceiver<NativeRdpInput>,
    cliprdr_rx: &mut mpsc::UnboundedReceiver<CliprdrAction>,
    frame_tx: FrameSender,
    gfx_frame_seen: Arc<AtomicBool>,
    gfx_error: SharedGfxError,
    render_mode: NativeRenderMode,
    frame_ws_port: u16,
    route: NativeRdpRoute,
    frame_transport: NativeFrameTransport,
) -> SessionResult<GracefulDisconnectReason> {
    use ironrdp::connector::connection_activation::ConnectionActivationState;
    use ironrdp::session::fast_path;

    let (mut reader, mut writer) = split_tokio_framed(framed);

    // ── Writer task ───────────────────────────────────────────────────
    // The main `tokio::select!` loop must NOT block on `writer.write_all`.
    // During a Mac→Win large file paste, ~1500 chunks (50–65ms each)
    // produce a steady stream of `SubmitFileContents` actions. If each one's
    // resulting `ResponseFrame` is awaited inline, the `input_rx` arm gets
    // starved and the user can't click anything in the RDP canvas.
    //
    // Solution: drain `frame_out_rx` in a dedicated task that owns the
    // socket writer. The main loop only does `frame_out_tx.send(frame)`,
    // which is synchronous and ~free.
    let (frame_out_tx, mut frame_out_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    tokio::spawn(async move {
        while let Some(frame) = frame_out_rx.recv().await {
            let frame_len = frame.len();
            let start = std::time::Instant::now();
            if frame_len >= 64 * 1024 {
                log::info!("[rdp-native] writer large frame start: {frame_len} bytes");
            }
            if let Err(e) = writer.write_all(&frame).await {
                log::warn!("[rdp-native] writer task failed: {e}");
                return;
            }
            let elapsed = start.elapsed();
            if frame_len >= 64 * 1024 || elapsed >= std::time::Duration::from_millis(250) {
                log::info!(
                    "[rdp-native] writer frame done: {frame_len} bytes in {} ms",
                    elapsed.as_millis()
                );
            }
        }
        log::debug!("[rdp-native] writer task ended (channel closed)");
    });
    let mut image = DecodedImage::new(
        PixelFormat::RgbA32,
        connection_result.desktop_size.width,
        connection_result.desktop_size.height,
    );

    let mut active_stage = ActiveStage::new(connection_result);
    let route_label = native_rdp_route_label(route);
    let mut bitmap_frame_stats = BitmapFrameStats::new();
    let session_started_at = Instant::now();
    let mut last_pdu_at = session_started_at;
    let mut last_graphics_at: Option<Instant> = None;
    let mut last_frame_sent_at: Option<Instant> = None;
    let mut total_pdu_count: u64 = 0;
    let mut total_graphics_updates: u64 = 0;
    let mut total_frames_sent: u64 = 0;
    let mut total_response_frames: u64 = 0;
    let mut loop_heartbeat = tokio::time::interval(Duration::from_secs(5));
    loop_heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop_heartbeat.tick().await;

    let disconnect_reason = 'outer: loop {
        let outputs = tokio::select! {
            input_event = input_rx.recv() => {
                let Some(ev) = input_event else {
                    log::warn!("[rdp-native] input channel closed; treating as user disconnect");
                    break 'outer GracefulDisconnectReason::UserInitiated;
                };

                let inputs = drain_coalesced_inputs(ev, input_rx);
                let mut outputs = Vec::new();
                for input in inputs {
                    if matches!(input, NativeRdpInput::ForceClipboardCheck) {
                        use ironrdp::cliprdr::Cliprdr;
                        use ironrdp::cliprdr::Client as CliprdrClient;

                        if let Some(cliprdr) =
                            active_stage.get_svc_processor_mut::<Cliprdr<CliprdrClient>>()
                        {
                            if let Some(backend) = cliprdr.downcast_backend_mut::<
                                cliprdr_module::backend::NextDeskCliprdrBackend,
                            >() {
                                backend.force_local_clipboard_check().await;
                            } else {
                                log::warn!(
                                    "[cliprdr] force clipboard check skipped: backend downcast failed"
                                );
                            }
                        } else {
                            log::debug!(
                                "[cliprdr] force clipboard check skipped: processor not ready"
                            );
                        }
                        continue;
                    }
                    outputs.extend(process_native_input(
                        &mut active_stage,
                        &mut image,
                        input,
                        tab_id,
                        frame_ws_port,
                    )?);
                }
                outputs
            }
            frame = reader.read_pdu() => {
                let (action, payload) = match frame {
                    Ok(v) => v,
                    Err(e) => {
                        eprintln!("[rdp-native] read_pdu error: {e:?}");
                        return Err(session::custom_err!("read frame", e));
                    }
                };
                last_pdu_at = Instant::now();
                total_pdu_count += 1;
                match active_stage.process(&mut image, action, &payload) {
                    Ok(outputs) => outputs,
                    Err(e) => {
                        eprintln!("[rdp-native] process error: {e:?}");
                        return Err(e);
                    }
                }
            }
            cliprdr_action = cliprdr_rx.recv() => {
                if let Some(action) = cliprdr_action {
                    use ironrdp::cliprdr::Cliprdr;
                    use ironrdp::cliprdr::Client as CliprdrClient;

                    let cliprdr = active_stage
                        .get_svc_processor::<Cliprdr<CliprdrClient>>()
                        .expect("CLIPRDR processor not found");

                    let svc_messages = match action {
                        CliprdrAction::InitiateCopy(formats) => {
                            let format_summary = formats
                                .iter()
                                .map(|format| {
                                    let name = format
                                        .name()
                                        .map(|name| name.value().to_string())
                                        .unwrap_or_else(|| "-".to_string());
                                    format!("id={} name={}", format.id().value(), name)
                                })
                                .collect::<Vec<_>>()
                                .join(", ");
                            log::info!(
                                "[cliprdr] tab={tab_id} Sending FormatList ({} formats) [{}]",
                                formats.len(),
                                format_summary
                            );
                            cliprdr.initiate_copy(&formats)
                                .map_err(|e| session::custom_err!("cliprdr initiate_copy", e))?
                        }
                        CliprdrAction::InitiatePaste(format_id) => {
                            log::info!("[cliprdr] tab={tab_id} Requesting format {:?}", format_id);
                            cliprdr.initiate_paste(format_id)
                                .map_err(|e| session::custom_err!("cliprdr initiate_paste", e))?
                        }
                        CliprdrAction::SubmitFormatData(response) => {
                            log::info!("[cliprdr] tab={tab_id} Submitting format data");
                            cliprdr.submit_format_data(response)
                                .map_err(|e| session::custom_err!("cliprdr submit_format_data", e))?
                        }
                        CliprdrAction::SubmitFileContents(response) => {
                            let stream_id = response.stream_id();
                            let data_len = response.data().len();
                            log::info!(
                                "[cliprdr] tab={tab_id} Submitting file contents stream_id={stream_id} data_len={data_len}"
                            );
                            cliprdr.submit_file_contents(response)
                                .map_err(|e| session::custom_err!("cliprdr submit_file_contents", e))?
                        }
                        CliprdrAction::RequestFileContents(request) => {
                            log::info!("[cliprdr] tab={tab_id} Requesting file contents");
                            cliprdr.request_file_contents(request)
                                .map_err(|e| session::custom_err!("cliprdr request_file_contents", e))?
                        }
                    };

                    // Encode SVC messages into wire frames
                    let frame = active_stage
                        .process_svc_processor_messages(svc_messages)
                        .map_err(|e| session::custom_err!("cliprdr encode", e))?;

                    vec![ActiveStageOutput::ResponseFrame(frame)]
                } else {
                    Vec::new()
                }
            }
            _ = loop_heartbeat.tick() => {
                let now = Instant::now();
                let since_graphics_ms = last_graphics_at
                    .map(|t| now.duration_since(t).as_millis().to_string())
                    .unwrap_or_else(|| "never".to_string());
                let since_frame_ms = last_frame_sent_at
                    .map(|t| now.duration_since(t).as_millis().to_string())
                    .unwrap_or_else(|| "never".to_string());
                log::info!(
                    "[rdp-native][loop-heartbeat] tab={tab_id} ws_port={frame_ws_port} route={route_label} render={:?} transport={} uptime_s={} since_pdu_ms={} since_graphics_ms={} since_frame_ms={} total_pdu={} total_graphics={} total_frames_sent={} total_response_frames={} receivers={} desktop={}x{}",
                    render_mode,
                    frame_transport.label(),
                    now.duration_since(session_started_at).as_secs(),
                    now.duration_since(last_pdu_at).as_millis(),
                    since_graphics_ms,
                    since_frame_ms,
                    total_pdu_count,
                    total_graphics_updates,
                    total_frames_sent,
                    total_response_frames,
                    frame_tx.receiver_count(),
                    image.width(),
                    image.height()
                );
                Vec::new()
            }
        };

        if let Some(message) = take_gfx_error(&gfx_error) {
            log::error!("[rdp-native] ending session because GFX H.264 is unavailable: {message}");
            return Err(session::reason_err!("RDPGFX", "{}", message));
        }

        for out in outputs {
            match out {
                ActiveStageOutput::ResponseFrame(frame) => {
                    // Hand the frame to the writer task; never block the
                    // main select loop on socket writes (see writer task above).
                    total_response_frames += 1;
                    if frame_out_tx.send(frame).is_err() {
                        return Err(session::general_err!("writer task ended"));
                    }
                }

                ActiveStageOutput::GraphicsUpdate(region) => {
                    last_graphics_at = Some(Instant::now());
                    total_graphics_updates += 1;
                    if !should_emit_bitmap_updates(
                        render_mode,
                        gfx_frame_seen.load(Ordering::Relaxed),
                    ) {
                        static SUPPRESSED_BITMAP_COUNT: std::sync::atomic::AtomicU64 =
                            std::sync::atomic::AtomicU64::new(0);
                        let n = SUPPRESSED_BITMAP_COUNT
                            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                        if n < 5 || n % 100 == 0 {
                            eprintln!(
                                "[rdp-native] bitmap dirty-rect suppressed while GFX/H264 mode is active"
                            );
                        }
                        continue;
                    }

                    // Extract dirty region pixels from DecodedImage
                    let rw = region.width();
                    let rh = region.height();
                    let stride = image.stride();
                    let bpp = image.bytes_per_pixel();
                    let src = image.data();

                    // Copy dirty rect into contiguous buffer
                    let row_bytes = usize::from(rw) * bpp;
                    let mut region_data = Vec::with_capacity(usize::from(rh) * row_bytes);
                    for row in 0..usize::from(rh) {
                        let y = usize::from(region.top) + row;
                        let off = y * stride + usize::from(region.left) * bpp;
                        let end = off + row_bytes;
                        if end <= src.len() {
                            region_data.extend_from_slice(&src[off..end]);
                        }
                    }

                    // Send via Channel as LZ4-compressed binary frame
                    let raw_len = region_data.len();
                    let frame = match frame_transport {
                        NativeFrameTransport::RawBitmap => build_raw_frame(
                            image.width(),
                            image.height(),
                            region.left,
                            region.top,
                            rw,
                            rh,
                            &region_data,
                        ),
                        NativeFrameTransport::DriftDirtyRects => rdp_frame::encode_dirty_rects(
                            image.width(),
                            image.height(),
                            &[DirtyRect {
                                x: region.left,
                                y: region.top,
                                width: rw,
                                height: rh,
                                stride: row_bytes,
                                rgba: &region_data,
                            }],
                        )
                        .map_err(|e| {
                            session::reason_err!(
                                "RDP frame",
                                "encode drift dirty rect frame failed: {}",
                                e
                            )
                        })?,
                    };

                    bitmap_frame_stats.record(BitmapFrameStatsEvent {
                        tab_id,
                        ws_port: frame_ws_port,
                        route_label: &route_label,
                        region_width: rw,
                        region_height: rh,
                        raw_len,
                        sent_len: frame.len(),
                        receivers: frame_tx.receiver_count(),
                    });
                    if frame_tx.send(frame).is_ok() {
                        last_frame_sent_at = Some(Instant::now());
                        total_frames_sent += 1;
                    }
                }

                ActiveStageOutput::PointerDefault => {
                    let _ = app.emit(
                        "rdp://pointer",
                        RdpPointerEvent {
                            tab_id: tab_id.to_string(),
                            kind: "default".into(),
                            ..Default::default()
                        },
                    );
                }

                ActiveStageOutput::PointerHidden => {
                    let _ = app.emit(
                        "rdp://pointer",
                        RdpPointerEvent {
                            tab_id: tab_id.to_string(),
                            kind: "hidden".into(),
                            ..Default::default()
                        },
                    );
                }

                ActiveStageOutput::PointerPosition { x, y } => {
                    let _ = app.emit(
                        "rdp://pointer",
                        RdpPointerEvent {
                            tab_id: tab_id.to_string(),
                            kind: "position".into(),
                            x: Some(x),
                            y: Some(y),
                            ..Default::default()
                        },
                    );
                }

                ActiveStageOutput::PointerBitmap(pointer) => {
                    let _ = app.emit(
                        "rdp://pointer",
                        RdpPointerEvent {
                            tab_id: tab_id.to_string(),
                            kind: "bitmap".into(),
                            width: Some(pointer.width),
                            height: Some(pointer.height),
                            hotspot_x: Some(pointer.hotspot_x),
                            hotspot_y: Some(pointer.hotspot_y),
                            bitmap: Some(pointer.bitmap_data.clone()),
                            ..Default::default()
                        },
                    );
                }

                ActiveStageOutput::DeactivateAll(mut ca) => {
                    log::debug!("[rdp-native] Deactivation-Reactivation");
                    let mut buf = WriteBuf::new();
                    'reactivate: loop {
                        let written = single_sequence_step_read(&mut reader, &mut *ca, &mut buf)
                            .await
                            .map_err(|e| session::custom_err!("reactivation", e))?;

                        if written.size().is_some() {
                            frame_out_tx.send(buf.filled().to_vec()).map_err(|_| {
                                session::general_err!("writer task ended during reactivation")
                            })?;
                        }

                        if let ConnectionActivationState::Finalized {
                            io_channel_id,
                            user_channel_id,
                            desktop_size,
                            share_id,
                            enable_server_pointer,
                            pointer_software_rendering,
                        } = ca.connection_activation_state()
                        {
                            log::debug!("[rdp-native] Reactivated: {desktop_size:?}");
                            image = DecodedImage::new(
                                PixelFormat::RgbA32,
                                desktop_size.width,
                                desktop_size.height,
                            );
                            active_stage.set_fastpath_processor(
                                fast_path::ProcessorBuilder {
                                    io_channel_id,
                                    user_channel_id,
                                    share_id,
                                    enable_server_pointer,
                                    pointer_software_rendering,
                                    bulk_decompressor: bulk_decompressor_for_route(route),
                                }
                                .build(),
                            );
                            active_stage.set_share_id(share_id);
                            active_stage.set_enable_server_pointer(enable_server_pointer);
                            break 'reactivate;
                        }
                    }
                }

                ActiveStageOutput::MultitransportRequest(_pdu) => {
                    log::debug!("[rdp-native] Multitransport request (UDP not impl)");
                }

                ActiveStageOutput::Terminate(reason) => break 'outer reason,
            }
        }
    };

    Ok(disconnect_reason)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ironrdp::pdu::rdp::client_info;

    #[test]
    fn native_rdp_requests_rich_visual_effects() {
        let config =
            connect_config_for_route("user", "pass", None, 1280, 720, NativeRdpRoute::Direct);

        assert_eq!(config.compression_type, None);
        assert!(config
            .performance_flags
            .contains(client_info::PerformanceFlags::ENABLE_DESKTOP_COMPOSITION));
        assert!(config
            .performance_flags
            .contains(client_info::PerformanceFlags::ENABLE_FONT_SMOOTHING));
        assert!(!config
            .performance_flags
            .contains(client_info::PerformanceFlags::DISABLE_FULLWINDOWDRAG));
        assert!(!config
            .performance_flags
            .contains(client_info::PerformanceFlags::DISABLE_THEMING));
    }

    #[test]
    fn native_rdp_direct_route_disables_bulk_compression() {
        assert_eq!(compression_type_for_route(NativeRdpRoute::Direct), None);
    }

    #[test]
    fn native_rdp_direct_route_needs_no_bulk_decompressor() {
        assert!(bulk_decompressor_for_route(NativeRdpRoute::Direct).is_none());
    }

    #[test]
    fn coalesce_input_burst_keeps_latest_consecutive_mouse_move() {
        let inputs = vec![
            NativeRdpInput::MouseMove { x: 10, y: 20 },
            NativeRdpInput::MouseMove { x: 11, y: 21 },
            NativeRdpInput::MouseMove { x: 12, y: 22 },
            NativeRdpInput::Resize {
                width: 1280,
                height: 720,
            },
            NativeRdpInput::MouseMove { x: 30, y: 40 },
            NativeRdpInput::MouseMove { x: 31, y: 41 },
            NativeRdpInput::Close,
        ];

        let coalesced = coalesce_input_burst(inputs);

        assert_eq!(
            coalesced,
            vec![
                NativeRdpInput::MouseMove { x: 12, y: 22 },
                NativeRdpInput::Resize {
                    width: 1280,
                    height: 720,
                },
                NativeRdpInput::MouseMove { x: 31, y: 41 },
                NativeRdpInput::Close,
            ]
        );
    }

    #[test]
    fn native_resize_skips_current_desktop_size_only() {
        assert!(native_resize_matches_desktop_size(1200, 700, 1200, 700));
        assert!(!native_resize_matches_desktop_size(1200, 700, 1216, 731));
        assert!(!native_resize_matches_desktop_size(1200, 700, 1200, 731));
    }

    #[test]
    fn gfx_h264_mode_keeps_bitmap_fallback_until_first_gfx_frame() {
        assert!(should_emit_bitmap_updates(NativeRenderMode::Bitmap, false));
        assert!(should_emit_bitmap_updates(NativeRenderMode::Bitmap, true));
        assert!(should_emit_bitmap_updates(
            NativeRenderMode::GfxH264Auto,
            false
        ));
        assert!(!should_emit_bitmap_updates(
            NativeRenderMode::GfxH264Auto,
            true
        ));
        assert!(should_emit_bitmap_updates(
            NativeRenderMode::GfxH264Force,
            false
        ));
        assert!(!should_emit_bitmap_updates(
            NativeRenderMode::GfxH264Force,
            true
        ));
    }

    #[test]
    fn gfx_h264_mode_env_tokens_split_auto_and_force() {
        assert_eq!(native_render_mode_from_env(None), NativeRenderMode::Bitmap);
        assert_eq!(
            native_render_mode_from_env(Some("")),
            NativeRenderMode::Bitmap
        );
        assert_eq!(
            native_render_mode_from_env(Some("1")),
            NativeRenderMode::Bitmap
        );
        assert_eq!(
            native_render_mode_from_env(Some("true")),
            NativeRenderMode::Bitmap
        );
        assert_eq!(
            native_render_mode_from_env(Some("yes")),
            NativeRenderMode::Bitmap
        );
        assert_eq!(
            native_render_mode_from_env(Some("h264")),
            NativeRenderMode::GfxH264Force
        );
        assert_eq!(
            native_render_mode_from_env(Some("gfx")),
            NativeRenderMode::GfxH264Auto
        );
        assert_eq!(
            native_render_mode_from_env(Some("force")),
            NativeRenderMode::GfxH264Force
        );
        assert_eq!(
            native_render_mode_from_env(Some("auto")),
            NativeRenderMode::GfxH264Auto
        );
        assert_eq!(
            native_render_mode_from_env(Some("bitmap")),
            NativeRenderMode::Bitmap
        );
    }

    #[test]
    fn high_resolution_direct_route_keeps_bitmap_unless_gfx_env_enabled() {
        assert_eq!(
            native_render_mode_for_route_with_env(NativeRdpRoute::Direct, 1536, 1003, None),
            NativeRenderMode::Bitmap
        );
        assert_eq!(
            native_render_mode_for_route_with_env(NativeRdpRoute::Direct, 1536, 1003, Some("auto"),),
            NativeRenderMode::GfxH264Auto
        );
        assert_eq!(
            native_render_mode_for_route_with_env(NativeRdpRoute::Direct, 1536, 1003, Some("h264"),),
            NativeRenderMode::GfxH264Force
        );
    }

    #[test]
    fn gfx_small_dirty_rects_do_not_suppress_bitmap_fallback() {
        assert!(!gfx_region_can_suppress_bitmap_fallback(1, 1, 1194, 731));
        assert!(!gfx_region_can_suppress_bitmap_fallback(42, 64, 1194, 731));
        assert!(gfx_region_can_suppress_bitmap_fallback(
            1194, 731, 1194, 731
        ));
        assert!(gfx_region_can_suppress_bitmap_fallback(600, 400, 1194, 731));
    }

    #[test]
    fn gfx_h264_capabilities_force_v81_avc420_path() {
        let caps = gfx_h264_capabilities();

        assert_eq!(caps.len(), 2);
        assert!(matches!(
            caps.first(),
            Some(ironrdp_egfx::pdu::CapabilitySet::V8_1 { flags })
                if flags.contains(ironrdp_egfx::pdu::CapabilitiesV81Flags::AVC420_ENABLED)
        ));
        assert!(caps.iter().any(|cap| matches!(
            cap,
            ironrdp_egfx::pdu::CapabilitySet::V8_1 { flags }
                if flags.contains(ironrdp_egfx::pdu::CapabilitiesV81Flags::AVC420_ENABLED)
        )));
        assert!(caps.iter().all(|cap| !matches!(
            cap,
            ironrdp_egfx::pdu::CapabilitySet::V10 { .. }
                | ironrdp_egfx::pdu::CapabilitySet::V10_7 { .. }
        )));
    }

    #[test]
    fn gfx_capability_confirm_requires_avc420_flag() {
        let confirmed_without_h264 = CapabilitySet::V8_1 {
            flags: CapabilitiesV81Flags::SMALL_CACHE,
        };
        let confirmed_with_h264 = CapabilitySet::V8_1 {
            flags: CapabilitiesV81Flags::SMALL_CACHE | CapabilitiesV81Flags::AVC420_ENABLED,
        };

        assert!(!gfx_capability_confirms_h264(&confirmed_without_h264));
        assert!(gfx_capability_confirms_h264(&confirmed_with_h264));
    }

    #[test]
    fn gfx_unsupported_message_includes_confirmed_capability() {
        let confirmed_without_h264 = CapabilitySet::V8_1 {
            flags: CapabilitiesV81Flags::SMALL_CACHE,
        };

        let message = gfx_unsupported_message(&confirmed_without_h264);

        assert!(message.contains("did not negotiate AVC420/H.264"));
        assert!(message.contains("SMALL_CACHE"));
    }

    #[test]
    fn rgb24_to_rgba_appends_opaque_alpha() {
        let rgba = rgb24_to_rgba(&[1, 2, 3, 4, 5, 6]).expect("valid rgb24");

        assert_eq!(rgba, vec![1, 2, 3, 0xff, 4, 5, 6, 0xff]);
    }

    #[test]
    fn rgb24_to_rgba_rejects_partial_pixel() {
        assert!(rgb24_to_rgba(&[1, 2, 3, 4]).is_none());
    }

    #[test]
    fn gfx_region_dimensions_accepts_inclusive_and_exclusive_rectangles() {
        let rect = ironrdp::pdu::geometry::InclusiveRectangle {
            left: 10,
            top: 20,
            right: 12,
            bottom: 22,
        };
        assert_eq!(gfx_region_dimensions(&rect, 3 * 3 * 4, 4), Some((3, 3)));
        assert_eq!(gfx_region_dimensions(&rect, 2 * 2 * 4, 4), Some((2, 2)));
        assert_eq!(gfx_region_dimensions(&rect, 5, 4), None);
    }

    #[test]
    fn gfx_rect_dimensions_for_codec_prefers_exclusive_rectangles() {
        let rect = ironrdp::pdu::geometry::InclusiveRectangle {
            left: 1152,
            top: 0,
            right: 1192,
            bottom: 64,
        };

        assert_eq!(
            gfx_rect_dimensions_for_codec(&rect).as_slice(),
            &[(40, 64), (41, 65)]
        );
    }

    #[test]
    fn gfx_bgra_to_rgba_converts_xrgb_and_argb() {
        let xrgb = gfx_bgra_to_rgba(&[1, 2, 3, 0], GfxPixelFormat::XRgb).expect("valid xrgb");
        assert_eq!(xrgb, vec![3, 2, 1, 0xff]);

        let argb = gfx_bgra_to_rgba(&[4, 5, 6, 7], GfxPixelFormat::ARgb).expect("valid argb");
        assert_eq!(argb, vec![6, 5, 4, 7]);
        assert!(gfx_bgra_to_rgba(&[1, 2, 3], GfxPixelFormat::XRgb).is_none());
    }

    #[test]
    fn build_raw_frame_keeps_small_regions_uncompressed() {
        let pixels = vec![7; MIN_LZ4_FRAME_BYTES - 1];
        let frame = build_raw_frame(800, 600, 1, 2, 128, 128, &pixels);
        let desktop_width = u16::from_le_bytes([frame[0], frame[1]]);

        assert_eq!(desktop_width & 0x8000, 0);
        assert_eq!(frame.len(), FRAME_HEADER_SIZE + pixels.len());
        assert_eq!(&frame[FRAME_HEADER_SIZE..], pixels.as_slice());
    }

    #[test]
    fn build_raw_frame_compresses_large_repetitive_regions() {
        let pixels = vec![0; MIN_LZ4_FRAME_BYTES];
        let frame = build_raw_frame(800, 600, 1, 2, 128, 128, &pixels);
        let desktop_width = u16::from_le_bytes([frame[0], frame[1]]);

        assert_ne!(desktop_width & 0x8000, 0);
        assert!(frame.len() < FRAME_HEADER_SIZE + pixels.len());
    }

    #[test]
    fn build_gfx_h264_frame_matches_frontend_wire_header() {
        let payload = [0x00, 0x00, 0x00, 0x01, 0x67, 0x42, 0x00, 0x1f];
        let frame = build_gfx_h264_frame(
            7,
            ironrdp_egfx::pdu::Codec1Type::Avc420,
            10,
            20,
            630,
            470,
            &payload,
        );

        assert_eq!(&frame[0..2], &0xffffu16.to_le_bytes());
        assert_eq!(&frame[2..4], &1u16.to_le_bytes());
        assert_eq!(&frame[4..6], &7u16.to_le_bytes());
        assert_eq!(&frame[6..8], &0x000bu16.to_le_bytes());
        assert_eq!(&frame[8..10], &10u16.to_le_bytes());
        assert_eq!(&frame[10..12], &20u16.to_le_bytes());
        assert_eq!(&frame[12..14], &630u16.to_le_bytes());
        assert_eq!(&frame[14..16], &470u16.to_le_bytes());
        assert_eq!(&frame[16..20], &(payload.len() as u32).to_le_bytes());
        assert_eq!(&frame[20..], &payload);
    }
}
