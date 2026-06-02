//! RDP Audio Backend — per-session native audio playback via cpal.
//!
//! Each RDP session gets an isolated [`SessionAudioPlayer`] that receives
//! PCM data from the WASM frontend (via Tauri invoke) and outputs it
//! through the system's default audio device using `cpal`.
//!
//! Supported input formats:
//! - PCM 8-bit unsigned / 16-bit signed LE
//! - A-law / µ-law (G.711) — decoded to 16-bit PCM internally
//!
//! # Architecture
//! ```text
//! WASM rdpsnd → JS callback → invoke("rdp_audio_push") → SessionAudioPlayer
//!                                                            ├─ format thread (cpal::Stream owner)
//!                                                            └─ mpsc channel → RxBuffer → cpal callback
//! ```

use std::collections::HashMap;
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::Duration;

use cpal::traits::{DeviceTrait as _, HostTrait as _, StreamTrait as _};
use cpal::{SampleFormat, StreamConfig};

// ── Public API ──────────────────────────────────────────────

/// Manages audio players for all active RDP sessions.
///
/// Thread-safe: wrapped in `Arc<Mutex<...>>` inside `AppState`.
#[derive(Default)]
pub struct AudioManager {
    players: HashMap<String, SessionAudioPlayer>,
}

impl AudioManager {
    /// Set the audio format for a session, creating a player if needed.
    pub fn set_format(
        &mut self,
        tab_id: &str,
        channels: u16,
        sample_rate: u32,
        bits_per_sample: u16,
        format_tag: &str,
    ) -> Result<(), String> {
        // Close existing player if format changed
        self.close(tab_id);

        let player = SessionAudioPlayer::new(channels, sample_rate, bits_per_sample, format_tag)?;
        self.players.insert(tab_id.to_string(), player);
        log::info!(
            "[rdp-audio] Session {tab_id}: format set \
             ({channels}ch, {sample_rate}Hz, {bits_per_sample}bit, {format_tag})"
        );
        Ok(())
    }

    /// Push raw audio data for a session.
    pub fn push(&self, tab_id: &str, data: Vec<u8>) -> Result<(), String> {
        let player = self
            .players
            .get(tab_id)
            .ok_or_else(|| format!("No audio player for session {tab_id}"))?;
        player.push(data);
        Ok(())
    }

    /// Close and remove the audio player for a session.
    pub fn close(&mut self, tab_id: &str) {
        if let Some(player) = self.players.remove(tab_id) {
            drop(player); // triggers Drop → thread join
            log::info!("[rdp-audio] Session {tab_id}: closed");
        }
    }
}

// ── Session Player ──────────────────────────────────────────

/// A single RDP session's audio playback instance.
///
/// Owns a dedicated thread that holds the `cpal::Stream`.
/// Audio data is sent via an `mpsc` channel.
struct SessionAudioPlayer {
    tx: Sender<Vec<u8>>,
    stream_thread: Option<JoinHandle<()>>,
    stop_flag: Arc<std::sync::atomic::AtomicBool>,
    format_tag: String,
}

impl SessionAudioPlayer {
    fn new(
        channels: u16,
        sample_rate: u32,
        bits_per_sample: u16,
        format_tag: &str,
    ) -> Result<Self, String> {
        let (tx, rx) = mpsc::channel::<Vec<u8>>();
        let stop_flag = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let stop_clone = Arc::clone(&stop_flag);
        let tag = format_tag.to_string();
        let tag_for_thread = tag.clone();

        let stream_thread = thread::Builder::new()
            .name(format!("rdp-audio-{sample_rate}"))
            .spawn(move || {
                if let Err(e) = run_audio_stream(
                    channels,
                    sample_rate,
                    bits_per_sample,
                    &tag_for_thread,
                    rx,
                    stop_clone,
                ) {
                    log::error!("[rdp-audio] Stream error: {e}");
                }
            })
            .map_err(|e| format!("Failed to spawn audio thread: {e}"))?;

        Ok(Self {
            tx,
            stream_thread: Some(stream_thread),
            stop_flag,
            format_tag: tag,
        })
    }

    fn push(&self, data: Vec<u8>) {
        // Pre-decode non-PCM formats to 16-bit signed PCM before sending
        let pcm = match self.format_tag.as_str() {
            "alaw" => decode_alaw(&data),
            "mulaw" => decode_mulaw(&data),
            _ => data, // PCM / float — pass through
        };
        // Fire-and-forget: drop errors silently if stream ended
        let _ = self.tx.send(pcm);
    }
}

impl Drop for SessionAudioPlayer {
    fn drop(&mut self) {
        self.stop_flag
            .store(true, std::sync::atomic::Ordering::Relaxed);
        // Drop the sender to unblock the receiver
        // (tx is dropped automatically when Self is dropped)
        if let Some(handle) = self.stream_thread.take() {
            let _ = handle.join();
        }
    }
}

// ── cpal Stream Runner ──────────────────────────────────────

/// Runs on a dedicated thread. Creates a cpal output stream and feeds
/// it from the mpsc channel until the stop flag is set.
fn run_audio_stream(
    channels: u16,
    sample_rate: u32,
    bits_per_sample: u16,
    _format_tag: &str,
    rx: Receiver<Vec<u8>>,
    stop_flag: Arc<std::sync::atomic::AtomicBool>,
) -> Result<(), String> {
    let sample_format = match bits_per_sample {
        8 => SampleFormat::U8,
        16 => SampleFormat::I16,
        32 => SampleFormat::F32,
        _ => return Err(format!("Unsupported bits_per_sample: {bits_per_sample}")),
    };

    let host = cpal::default_host();
    let device = host
        .default_output_device()
        .ok_or("No default audio output device found")?;

    let config = StreamConfig {
        channels,
        sample_rate,
        buffer_size: cpal::BufferSize::Default,
    };

    log::info!(
        "[rdp-audio] Opening cpal stream: {}ch {}Hz {}bit {:?}",
        channels,
        sample_rate,
        bits_per_sample,
        sample_format,
    );

    let mut rx_buf = RxBuffer::new(rx);

    let stream = device
        .build_output_stream_raw(
            &config,
            sample_format,
            move |data, _info: &cpal::OutputCallbackInfo| {
                rx_buf.fill(data.bytes_mut());
            },
            |err| log::error!("[rdp-audio] cpal stream error: {err}"),
            None,
        )
        .map_err(|e| format!("Failed to build cpal stream: {e}"))?;

    stream
        .play()
        .map_err(|e| format!("Failed to start cpal stream: {e}"))?;

    log::info!("[rdp-audio] cpal stream started, parking thread");

    // Park the thread — cpal runs its callback on its own audio thread.
    // We keep this thread alive to own the Stream (prevent Drop).
    while !stop_flag.load(std::sync::atomic::Ordering::Relaxed) {
        thread::park_timeout(Duration::from_millis(500));
    }

    log::info!("[rdp-audio] cpal stream stopping");
    drop(stream);
    Ok(())
}

// ── Ring Buffer ─────────────────────────────────────────────

/// Receives audio chunks from the mpsc channel and fills the cpal
/// output buffer. Inserts silence on underrun.
struct RxBuffer {
    receiver: Receiver<Vec<u8>>,
    pending: Option<Vec<u8>>,
    offset: usize,
}

impl RxBuffer {
    fn new(receiver: Receiver<Vec<u8>>) -> Self {
        Self {
            receiver,
            pending: None,
            offset: 0,
        }
    }

    fn fill(&mut self, output: &mut [u8]) {
        let mut filled = 0;

        while filled < output.len() {
            // Try to get more data if we've exhausted the current chunk
            if self.pending.is_none() {
                match self.receiver.recv_timeout(Duration::from_millis(20)) {
                    Ok(chunk) => {
                        self.pending = Some(chunk);
                        self.offset = 0;
                    }
                    Err(_) => {
                        // Underrun: fill remainder with silence
                        output[filled..].fill(0);
                        return;
                    }
                }
            }

            if let Some(ref chunk) = self.pending {
                let remaining_in_chunk = chunk.len() - self.offset;
                let remaining_in_output = output.len() - filled;
                let copy_len = remaining_in_chunk.min(remaining_in_output);

                output[filled..filled + copy_len]
                    .copy_from_slice(&chunk[self.offset..self.offset + copy_len]);

                filled += copy_len;
                self.offset += copy_len;

                if self.offset >= chunk.len() {
                    self.pending = None;
                    self.offset = 0;
                }
            }
        }
    }
}

// ── G.711 Decoders ──────────────────────────────────────────

/// Decode A-law (ITU-T G.711) to 16-bit signed PCM (little-endian).
fn decode_alaw(data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len() * 2);
    for &byte in data {
        let sample = alaw_to_linear(byte);
        out.extend_from_slice(&sample.to_le_bytes());
    }
    out
}

/// Decode µ-law (ITU-T G.711) to 16-bit signed PCM (little-endian).
fn decode_mulaw(data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len() * 2);
    for &byte in data {
        let sample = ulaw_to_linear(byte);
        out.extend_from_slice(&sample.to_le_bytes());
    }
    out
}

fn alaw_to_linear(alaw: u8) -> i16 {
    let a = alaw ^ 0x55;
    let sign: i32 = if a & 0x80 != 0 { -1 } else { 1 };
    let magnitude = a & 0x7F;
    let seg = (magnitude >> 4) & 0x07;
    let quant = magnitude & 0x0F;
    let val: i32 = if seg == 0 {
        (i32::from(quant) * 2 + 1) * 2
    } else {
        ((i32::from(quant) * 2 + 33) << (seg - 1)) * 2
    };
    (sign * val) as i16
}

fn ulaw_to_linear(ulaw: u8) -> i16 {
    let u = !ulaw & 0xFF;
    let sign: i32 = if u & 0x80 != 0 { -1 } else { 1 };
    let magnitude = u & 0x7F;
    let seg = (magnitude >> 4) & 0x07;
    let quant = magnitude & 0x0F;
    let val = ((i32::from(quant) * 2 + 33) << seg) - 33;
    (sign * val) as i16
}
