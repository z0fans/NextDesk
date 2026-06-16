#![allow(dead_code)]

use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc, Condvar, Mutex, MutexGuard,
};
use std::time::Duration;

const BYTES_PER_PIXEL: usize = 4;

#[derive(Debug)]
pub struct FrameSnapshot {
    pub width: u32,
    pub height: u32,
    pub data: Vec<u8>,
}

struct SharedFrameInner {
    width: u32,
    height: u32,
    write_buf: Vec<u8>,
    read_snapshot: Arc<FrameSnapshot>,
}

pub struct SharedFrame {
    inner: Mutex<SharedFrameInner>,
    dirty: AtomicBool,
    version: AtomicU64,
    notify: Condvar,
}

pub struct SharedFrameWriteGuard<'a> {
    inner: MutexGuard<'a, SharedFrameInner>,
}

impl SharedFrame {
    pub fn new(width: u32, height: u32) -> Self {
        let size = frame_byte_len(width, height).unwrap_or(0);
        Self {
            inner: Mutex::new(SharedFrameInner {
                width,
                height,
                write_buf: vec![0; size],
                read_snapshot: Arc::new(FrameSnapshot {
                    width,
                    height,
                    data: vec![0; size],
                }),
            }),
            dirty: AtomicBool::new(false),
            version: AtomicU64::new(0),
            notify: Condvar::new(),
        }
    }

    pub fn resize(&self, width: u32, height: u32) -> Result<(), String> {
        let size = frame_byte_len(width, height)?;
        let mut inner = self.lock_inner()?;
        inner.width = width;
        inner.height = height;
        inner.write_buf.resize(size, 0);
        inner.read_snapshot = Arc::new(FrameSnapshot {
            width,
            height,
            data: vec![0; size],
        });
        self.dirty.store(false, Ordering::Release);
        Ok(())
    }

    pub fn begin_write(&self) -> Result<SharedFrameWriteGuard<'_>, String> {
        Ok(SharedFrameWriteGuard {
            inner: self.lock_inner()?,
        })
    }

    pub fn mark_dirty(&self) {
        self.dirty.store(true, Ordering::Release);
        self.version.fetch_add(1, Ordering::Relaxed);
        self.notify.notify_one();
    }

    pub fn update_full(&self, width: u32, height: u32, rgba: &[u8]) -> Result<(), String> {
        let expected = frame_byte_len(width, height)?;
        if rgba.len() < expected {
            return Err(format!(
                "full frame payload too short: expected {expected}, got {}",
                rgba.len()
            ));
        }

        let mut inner = self.lock_inner()?;
        if inner.width != width || inner.height != height {
            inner.width = width;
            inner.height = height;
            inner.write_buf.resize(expected, 0);
        }
        inner.write_buf[..expected].copy_from_slice(&rgba[..expected]);
        drop(inner);
        self.mark_dirty();
        Ok(())
    }

    pub fn update_rect(
        &self,
        x: u32,
        y: u32,
        width: u32,
        height: u32,
        rgba: &[u8],
        stride: usize,
    ) -> Result<(), String> {
        let mut guard = self.begin_write()?;
        guard.update_rect(x, y, width, height, rgba, stride)?;
        drop(guard);
        self.mark_dirty();
        Ok(())
    }

    pub fn publish(&self) -> Option<Arc<FrameSnapshot>> {
        if !self.dirty.swap(false, Ordering::AcqRel) {
            return None;
        }
        let Ok(mut inner) = self.lock_inner() else {
            return None;
        };

        let mut snapshot_data = Vec::new();
        std::mem::swap(&mut inner.write_buf, &mut snapshot_data);

        let snapshot = Arc::new(FrameSnapshot {
            width: inner.width,
            height: inner.height,
            data: snapshot_data,
        });

        let old_snapshot = std::mem::replace(&mut inner.read_snapshot, snapshot.clone());
        let expected = frame_byte_len(inner.width, inner.height).unwrap_or(0);
        match Arc::try_unwrap(old_snapshot) {
            Ok(old) => {
                inner.write_buf = old.data;
                inner.write_buf.resize(expected, 0);
            }
            Err(_) => {
                inner.write_buf = vec![0; expected];
            }
        }

        Some(snapshot)
    }

    pub fn wait_for_frame(&self, timeout: Duration) -> Option<Arc<FrameSnapshot>> {
        if self.dirty.load(Ordering::Acquire) {
            return self.publish();
        }

        let guard = self.lock_inner().ok()?;
        let (_guard, _wait_result) = self.notify.wait_timeout(guard, timeout).ok()?;
        if self.dirty.load(Ordering::Acquire) {
            self.publish()
        } else {
            None
        }
    }

    pub fn dimensions(&self) -> Result<(u32, u32), String> {
        let inner = self.lock_inner()?;
        Ok((inner.width, inner.height))
    }

    pub fn version(&self) -> u64 {
        self.version.load(Ordering::Relaxed)
    }

    fn lock_inner(&self) -> Result<MutexGuard<'_, SharedFrameInner>, String> {
        self.inner
            .lock()
            .map_err(|_| "shared frame mutex poisoned".to_string())
    }
}

impl SharedFrameWriteGuard<'_> {
    pub fn update_rect(
        &mut self,
        x: u32,
        y: u32,
        width: u32,
        height: u32,
        rgba: &[u8],
        stride: usize,
    ) -> Result<(), String> {
        if width == 0 || height == 0 {
            return Err("dirty rect dimensions must be non-zero".to_string());
        }
        let row_bytes = usize::try_from(width)
            .ok()
            .and_then(|w| w.checked_mul(BYTES_PER_PIXEL))
            .ok_or_else(|| "dirty rect row size overflow".to_string())?;
        if stride < row_bytes {
            return Err(format!(
                "dirty rect stride too small: stride={stride}, row_bytes={row_bytes}"
            ));
        }
        if x.checked_add(width)
            .is_none_or(|right| right > self.inner.width)
            || y.checked_add(height)
                .is_none_or(|bottom| bottom > self.inner.height)
        {
            return Err(format!(
                "dirty rect out of bounds: rect={}x{}+{},{} surface={}x{}",
                width, height, x, y, self.inner.width, self.inner.height
            ));
        }

        let min_len = usize::try_from(height - 1)
            .ok()
            .and_then(|last_row| last_row.checked_mul(stride))
            .and_then(|last_row| last_row.checked_add(row_bytes))
            .ok_or_else(|| "dirty rect payload size overflow".to_string())?;
        if rgba.len() < min_len {
            return Err(format!(
                "dirty rect payload too short: expected at least {min_len}, got {}",
                rgba.len()
            ));
        }

        let frame_width = usize::try_from(self.inner.width)
            .map_err(|_| "frame width does not fit usize".to_string())?;
        let x = usize::try_from(x).map_err(|_| "x does not fit usize".to_string())?;
        let y = usize::try_from(y).map_err(|_| "y does not fit usize".to_string())?;
        for row in 0..usize::try_from(height).map_err(|_| "height does not fit usize")? {
            let src_start = row
                .checked_mul(stride)
                .ok_or_else(|| "dirty rect source offset overflow".to_string())?;
            let src_end = src_start + row_bytes;
            let dst_start = (y + row)
                .checked_mul(frame_width)
                .and_then(|row_start| row_start.checked_add(x))
                .and_then(|px| px.checked_mul(BYTES_PER_PIXEL))
                .ok_or_else(|| "dirty rect destination offset overflow".to_string())?;
            let dst_end = dst_start + row_bytes;
            self.inner.write_buf[dst_start..dst_end].copy_from_slice(&rgba[src_start..src_end]);
        }

        Ok(())
    }

    pub fn dimensions(&self) -> (u32, u32) {
        (self.inner.width, self.inner.height)
    }
}

fn frame_byte_len(width: u32, height: u32) -> Result<usize, String> {
    usize::try_from(width)
        .ok()
        .and_then(|w| usize::try_from(height).ok().and_then(|h| w.checked_mul(h)))
        .and_then(|px| px.checked_mul(BYTES_PER_PIXEL))
        .ok_or_else(|| format!("frame size overflow: {width}x{height}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn update_full_publishes_snapshot() {
        let shared = SharedFrame::new(2, 1);
        shared
            .update_full(2, 1, &[1, 2, 3, 255, 4, 5, 6, 255])
            .unwrap();

        let snapshot = shared.publish().unwrap();

        assert_eq!(snapshot.width, 2);
        assert_eq!(snapshot.height, 1);
        assert_eq!(snapshot.data, vec![1, 2, 3, 255, 4, 5, 6, 255]);
        assert!(shared.publish().is_none());
    }

    #[test]
    fn batches_dirty_rects_under_one_guard() {
        let shared = SharedFrame::new(4, 2);
        {
            let mut guard = shared.begin_write().unwrap();
            guard
                .update_rect(1, 0, 2, 1, &[1, 1, 1, 255, 2, 2, 2, 255], 8)
                .unwrap();
            guard.update_rect(0, 1, 1, 1, &[3, 3, 3, 255], 4).unwrap();
        }
        shared.mark_dirty();

        let snapshot = shared.publish().unwrap();

        assert_eq!(&snapshot.data[4..12], &[1, 1, 1, 255, 2, 2, 2, 255]);
        assert_eq!(&snapshot.data[16..20], &[3, 3, 3, 255]);
    }

    #[test]
    fn update_rect_respects_stride() {
        let shared = SharedFrame::new(2, 2);
        let source = [
            1, 1, 1, 255, 2, 2, 2, 255, 9, 9, 9, 255, 3, 3, 3, 255, 4, 4, 4, 255, 8, 8, 8, 255,
        ];

        shared.update_rect(0, 0, 2, 2, &source, 12).unwrap();
        let snapshot = shared.publish().unwrap();

        assert_eq!(
            snapshot.data,
            vec![1, 1, 1, 255, 2, 2, 2, 255, 3, 3, 3, 255, 4, 4, 4, 255]
        );
    }

    #[test]
    fn rejects_out_of_bounds_rect() {
        let shared = SharedFrame::new(2, 2);
        let err = shared.update_rect(1, 1, 2, 1, &[0; 8], 8).unwrap_err();

        assert!(err.contains("out of bounds"));
        assert!(shared.publish().is_none());
    }

    #[test]
    fn wait_for_frame_times_out_without_dirty_data() {
        let shared = SharedFrame::new(2, 2);

        assert!(shared.wait_for_frame(Duration::from_millis(1)).is_none());
    }

    #[test]
    fn resize_updates_dimensions_and_clears_dirty_state() {
        let shared = SharedFrame::new(2, 2);
        shared.update_rect(0, 0, 1, 1, &[1, 1, 1, 255], 4).unwrap();
        shared.resize(3, 1).unwrap();

        assert_eq!(shared.dimensions().unwrap(), (3, 1));
        assert!(shared.publish().is_none());
    }
}
