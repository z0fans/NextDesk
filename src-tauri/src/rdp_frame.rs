#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u8)]
pub enum NativeFrameKind {
    FullFrame = 1,
    DirtyRects = 2,
    H264 = 3,
}

impl NativeFrameKind {
    fn from_u8(value: u8) -> Option<Self> {
        match value {
            1 => Some(Self::FullFrame),
            2 => Some(Self::DirtyRects),
            3 => Some(Self::H264),
            _ => None,
        }
    }
}

pub struct DirtyRect<'a> {
    pub x: u16,
    pub y: u16,
    pub width: u16,
    pub height: u16,
    pub stride: usize,
    pub rgba: &'a [u8],
}

const FRAME_HEADER_SIZE: usize = 7;
const RECT_HEADER_SIZE: usize = 8;
const BYTES_PER_PIXEL: usize = 4;

#[allow(dead_code)]
pub fn encode_full_frame(width: u16, height: u16, rgba: &[u8]) -> Result<Vec<u8>, String> {
    let expected = usize::from(width)
        .checked_mul(usize::from(height))
        .and_then(|px| px.checked_mul(BYTES_PER_PIXEL))
        .ok_or_else(|| "full frame size overflow".to_string())?;
    if rgba.len() < expected {
        return Err(format!(
            "full frame payload too short: expected {expected}, got {}",
            rgba.len()
        ));
    }

    let mut buf = Vec::with_capacity(FRAME_HEADER_SIZE + expected);
    write_frame_header(&mut buf, NativeFrameKind::FullFrame, width, height, 0);
    buf.extend_from_slice(&rgba[..expected]);
    Ok(buf)
}

#[allow(dead_code)]
pub fn encode_h264_frame(width: u16, height: u16, payload: &[u8]) -> Vec<u8> {
    let mut buf = Vec::with_capacity(FRAME_HEADER_SIZE + payload.len());
    write_frame_header(&mut buf, NativeFrameKind::H264, width, height, 0);
    buf.extend_from_slice(payload);
    buf
}

pub fn encode_dirty_rects(
    surface_width: u16,
    surface_height: u16,
    rects: &[DirtyRect<'_>],
) -> Result<Vec<u8>, String> {
    let rect_count = u16::try_from(rects.len()).map_err(|_| "too many dirty rects".to_string())?;
    if rect_count == 0 {
        return Err("dirty frame requires at least one rect".to_string());
    }

    let mut capacity = FRAME_HEADER_SIZE + rects.len() * RECT_HEADER_SIZE;
    for rect in rects {
        validate_dirty_rect(surface_width, surface_height, rect)?;
        capacity = capacity
            .checked_add(usize::from(rect.width) * usize::from(rect.height) * BYTES_PER_PIXEL)
            .ok_or_else(|| "dirty frame size overflow".to_string())?;
    }

    let mut buf = Vec::with_capacity(capacity);
    write_frame_header(
        &mut buf,
        NativeFrameKind::DirtyRects,
        surface_width,
        surface_height,
        rect_count,
    );

    for rect in rects {
        buf.extend_from_slice(&rect.x.to_le_bytes());
        buf.extend_from_slice(&rect.y.to_le_bytes());
        buf.extend_from_slice(&rect.width.to_le_bytes());
        buf.extend_from_slice(&rect.height.to_le_bytes());

        let row_bytes = usize::from(rect.width) * BYTES_PER_PIXEL;
        for row in 0..usize::from(rect.height) {
            let start = row
                .checked_mul(rect.stride)
                .ok_or_else(|| "dirty rect row offset overflow".to_string())?;
            let end = start + row_bytes;
            buf.extend_from_slice(&rect.rgba[start..end]);
        }
    }

    Ok(buf)
}

fn write_frame_header(
    buf: &mut Vec<u8>,
    kind: NativeFrameKind,
    width: u16,
    height: u16,
    rect_count: u16,
) {
    buf.push(kind as u8);
    buf.extend_from_slice(&width.to_le_bytes());
    buf.extend_from_slice(&height.to_le_bytes());
    buf.extend_from_slice(&rect_count.to_le_bytes());
}

fn validate_dirty_rect(
    surface_width: u16,
    surface_height: u16,
    rect: &DirtyRect<'_>,
) -> Result<(), String> {
    let Some(_) = NativeFrameKind::from_u8(NativeFrameKind::DirtyRects as u8) else {
        return Err("invalid dirty frame kind".to_string());
    };
    if rect.width == 0 || rect.height == 0 {
        return Err("dirty rect dimensions must be non-zero".to_string());
    }
    if rect
        .x
        .checked_add(rect.width)
        .is_none_or(|right| right > surface_width)
        || rect
            .y
            .checked_add(rect.height)
            .is_none_or(|bottom| bottom > surface_height)
    {
        return Err(format!(
            "dirty rect out of bounds: rect={}x{}+{},{} surface={}x{}",
            rect.width, rect.height, rect.x, rect.y, surface_width, surface_height
        ));
    }

    let row_bytes = usize::from(rect.width) * BYTES_PER_PIXEL;
    if rect.stride < row_bytes {
        return Err(format!(
            "dirty rect stride too small: stride={}, row_bytes={row_bytes}",
            rect.stride
        ));
    }

    let min_len = usize::from(rect.height.saturating_sub(1))
        .checked_mul(rect.stride)
        .and_then(|last_row| last_row.checked_add(row_bytes))
        .ok_or_else(|| "dirty rect payload size overflow".to_string())?;
    if rect.rgba.len() < min_len {
        return Err(format!(
            "dirty rect payload too short: expected at least {min_len}, got {}",
            rect.rgba.len()
        ));
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_full_frame() {
        let rgba = vec![7u8; 2 * 2 * 4];
        let frame = encode_full_frame(2, 2, &rgba).unwrap();

        assert_eq!(frame[0], NativeFrameKind::FullFrame as u8);
        assert_eq!(u16::from_le_bytes([frame[1], frame[2]]), 2);
        assert_eq!(u16::from_le_bytes([frame[3], frame[4]]), 2);
        assert_eq!(u16::from_le_bytes([frame[5], frame[6]]), 0);
        assert_eq!(&frame[7..], rgba.as_slice());
    }

    #[test]
    fn encodes_dirty_rect_rows_with_stride() {
        let source = [
            1, 1, 1, 255, 2, 2, 2, 255, 9, 9, 9, 255, 3, 3, 3, 255, 4, 4, 4, 255, 8, 8, 8, 255,
        ];
        let rect = DirtyRect {
            x: 1,
            y: 2,
            width: 2,
            height: 2,
            stride: 12,
            rgba: &source,
        };

        let frame = encode_dirty_rects(10, 10, &[rect]).unwrap();

        assert_eq!(frame[0], NativeFrameKind::DirtyRects as u8);
        assert_eq!(u16::from_le_bytes([frame[5], frame[6]]), 1);
        assert_eq!(&frame[15..23], &[1, 1, 1, 255, 2, 2, 2, 255]);
        assert_eq!(&frame[23..31], &[3, 3, 3, 255, 4, 4, 4, 255]);
    }

    #[test]
    fn rejects_out_of_bounds_dirty_rect() {
        let rgba = vec![0u8; 4 * 4 * 4];
        let rect = DirtyRect {
            x: 9,
            y: 9,
            width: 2,
            height: 2,
            stride: 8,
            rgba: &rgba,
        };

        assert!(encode_dirty_rects(10, 10, &[rect]).is_err());
    }
}
