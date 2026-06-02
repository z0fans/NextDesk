//! Format conversions between OS clipboard data and RDP wire formats.
//!
//! All functions are pure (no side effects) and operate on byte slices.

use std::io::Cursor;

/// Convert UTF-8 text to UTF-16LE with null terminator (for CF_UNICODETEXT).
pub fn text_to_utf16le(text: &str) -> Vec<u8> {
    let mut buf: Vec<u8> = text.encode_utf16().flat_map(|c| c.to_le_bytes()).collect();
    // Append null terminator (U+0000 as UTF-16LE)
    buf.push(0);
    buf.push(0);
    buf
}

/// Convert UTF-16LE bytes to UTF-8 String, stripping null terminator.
pub fn utf16le_to_text(data: &[u8]) -> Option<String> {
    if data.len() % 2 != 0 {
        return None;
    }

    let u16s: Vec<u16> = data
        .chunks_exact(2)
        .map(|c| u16::from_le_bytes([c[0], c[1]]))
        .collect();

    // Strip trailing null(s)
    let end = u16s.iter().position(|&c| c == 0).unwrap_or(u16s.len());
    String::from_utf16(&u16s[..end]).ok()
}

/// Convert plain HTML to CF_HTML format (with header containing byte offsets).
///
/// CF_HTML format uses a text header with 8-digit zero-padded byte offsets,
/// followed by the HTML content wrapped in standard markers.
pub fn html_to_cf_html(html: &str) -> Vec<u8> {
    // Build the template with placeholder offsets to measure sizes.
    // Header lines use \r\n as per CF_HTML spec.
    let header_template = "Version:0.9\r\n\
                           StartHTML:XXXXXXXX\r\n\
                           EndHTML:XXXXXXXX\r\n\
                           StartFragment:XXXXXXXX\r\n\
                           EndFragment:XXXXXXXX\r\n";

    let prefix = "<html><body>\r\n<!--StartFragment-->";
    let suffix = "<!--EndFragment-->\r\n</body></html>";

    let header_len = header_template.len();
    let start_html = header_len;
    let start_fragment = header_len + prefix.len();
    let end_fragment = start_fragment + html.len();
    let end_html = end_fragment + suffix.len();

    let header = format!(
        "Version:0.9\r\n\
         StartHTML:{:08}\r\n\
         EndHTML:{:08}\r\n\
         StartFragment:{:08}\r\n\
         EndFragment:{:08}\r\n",
        start_html, end_html, start_fragment, end_fragment
    );

    let mut result = Vec::with_capacity(end_html);
    result.extend_from_slice(header.as_bytes());
    result.extend_from_slice(prefix.as_bytes());
    result.extend_from_slice(html.as_bytes());
    result.extend_from_slice(suffix.as_bytes());
    result
}

/// Extract plain HTML from CF_HTML format data.
///
/// Parses the header to find StartFragment/EndFragment byte offsets,
/// then extracts the content between those offsets.
pub fn cf_html_to_html(data: &[u8]) -> Option<String> {
    let text = std::str::from_utf8(data).ok()?;

    let start_frag = parse_cf_html_field(text, "StartFragment:")?;
    let end_frag = parse_cf_html_field(text, "EndFragment:")?;

    if start_frag > end_frag || end_frag > data.len() {
        return None;
    }

    let fragment = &data[start_frag..end_frag];
    String::from_utf8(fragment.to_vec()).ok()
}

/// Parse a numeric field from CF_HTML header (e.g., "StartFragment:00000131").
fn parse_cf_html_field(text: &str, field: &str) -> Option<usize> {
    let pos = text.find(field)?;
    let start = pos + field.len();
    // Read until \r or \n
    let end = text[start..]
        .find(|c: char| c == '\r' || c == '\n')
        .map(|i| start + i)
        .unwrap_or(text.len());
    text[start..end].trim().parse::<usize>().ok()
}

/// Convert PNG bytes to CF_DIBV5 format.
///
/// Decodes PNG → raw BGRA pixels → prepends BITMAPV5HEADER (124 bytes).
/// Uses bottom-up row order (standard DIB).
pub fn png_to_dibv5(png_data: &[u8]) -> Result<Vec<u8>, String> {
    let decoder = png::Decoder::new(Cursor::new(png_data));
    let mut reader = decoder
        .read_info()
        .map_err(|e| format!("PNG decode error: {e}"))?;

    let info = reader.info();
    let width = info.width;
    let height = info.height;
    let color_type = info.color_type;
    let bit_depth = info.bit_depth;

    if bit_depth != png::BitDepth::Eight {
        return Err(format!("Unsupported bit depth: {:?}", bit_depth));
    }

    let mut img_data = vec![0u8; reader.output_buffer_size()];
    let frame_info = reader
        .next_frame(&mut img_data)
        .map_err(|e| format!("PNG frame error: {e}"))?;
    let img_data = &img_data[..frame_info.buffer_size()];

    // Convert to BGRA
    let bgra_pixels = match color_type {
        png::ColorType::Rgba => {
            // RGBA → BGRA
            let mut bgra = Vec::with_capacity(img_data.len());
            for chunk in img_data.chunks_exact(4) {
                bgra.push(chunk[2]); // B
                bgra.push(chunk[1]); // G
                bgra.push(chunk[0]); // R
                bgra.push(chunk[3]); // A
            }
            bgra
        }
        png::ColorType::Rgb => {
            // RGB → BGRA (alpha = 255)
            let pixel_count = img_data.len() / 3;
            let mut bgra = Vec::with_capacity(pixel_count * 4);
            for chunk in img_data.chunks_exact(3) {
                bgra.push(chunk[2]); // B
                bgra.push(chunk[1]); // G
                bgra.push(chunk[0]); // R
                bgra.push(255u8); // A
            }
            bgra
        }
        png::ColorType::GrayscaleAlpha => {
            let mut bgra = Vec::with_capacity(img_data.len() * 2);
            for chunk in img_data.chunks_exact(2) {
                let gray = chunk[0];
                bgra.push(gray); // B
                bgra.push(gray); // G
                bgra.push(gray); // R
                bgra.push(chunk[1]); // A
            }
            bgra
        }
        png::ColorType::Grayscale => {
            let mut bgra = Vec::with_capacity(img_data.len() * 4);
            for &gray in img_data {
                bgra.push(gray); // B
                bgra.push(gray); // G
                bgra.push(gray); // R
                bgra.push(255u8); // A
            }
            bgra
        }
        _ => return Err(format!("Unsupported PNG color type: {:?}", color_type)),
    };

    let row_size = (width as usize) * 4;
    let image_size = row_size * (height as usize);

    // Flip rows for bottom-up DIB order (PNG is top-down)
    let mut flipped = Vec::with_capacity(image_size);
    for y in (0..height as usize).rev() {
        let row_start = y * row_size;
        flipped.extend_from_slice(&bgra_pixels[row_start..row_start + row_size]);
    }

    // Build BITMAPV5HEADER (124 bytes)
    let mut header = vec![0u8; 124];
    write_u32_le(&mut header, 0, 124); // bV5Size
    write_i32_le(&mut header, 4, width as i32); // bV5Width
    write_i32_le(&mut header, 8, height as i32); // bV5Height (positive = bottom-up)
    write_u16_le(&mut header, 12, 1); // bV5Planes
    write_u16_le(&mut header, 14, 32); // bV5BitCount
    write_u32_le(&mut header, 16, 3); // bV5Compression = BI_BITFIELDS
    write_u32_le(&mut header, 20, image_size as u32); // bV5SizeImage
    write_i32_le(&mut header, 24, 2835); // bV5XPelsPerMeter (72 DPI)
    write_i32_le(&mut header, 28, 2835); // bV5YPelsPerMeter
    write_u32_le(&mut header, 32, 0); // bV5ClrUsed
    write_u32_le(&mut header, 36, 0); // bV5ClrImportant
    write_u32_le(&mut header, 40, 0x00FF0000); // bV5RedMask
    write_u32_le(&mut header, 44, 0x0000FF00); // bV5GreenMask
    write_u32_le(&mut header, 48, 0x000000FF); // bV5BlueMask
    write_u32_le(&mut header, 52, 0xFF000000); // bV5AlphaMask
    write_u32_le(&mut header, 56, 0x73524742); // bV5CSType = "sRGB"
                                               // bV5Endpoints: 36 bytes of zeros at offset 60..96 (already zeroed)
                                               // bV5GammaRed/Green/Blue: 3x u32 zeros at offset 96..108 (already zeroed)
    write_u32_le(&mut header, 108, 4); // bV5Intent = LCS_GM_IMAGES
    write_u32_le(&mut header, 112, 0); // bV5ProfileData
    write_u32_le(&mut header, 116, 0); // bV5ProfileSize
    write_u32_le(&mut header, 120, 0); // bV5Reserved

    let mut result = Vec::with_capacity(124 + image_size);
    result.extend_from_slice(&header);
    result.extend_from_slice(&flipped);
    Ok(result)
}

/// Convert CF_DIBV5 data to PNG bytes.
///
/// Reads BITMAPV5HEADER → extracts pixel data → encodes as PNG.
pub fn dibv5_to_png(data: &[u8]) -> Result<Vec<u8>, String> {
    if data.len() < 124 {
        return Err("DIBV5 data too short for header".into());
    }

    let header_size = read_u32_le(data, 0) as usize;
    if header_size < 124 {
        return Err(format!("Invalid DIBV5 header size: {header_size}"));
    }

    let width = read_i32_le(data, 4);
    let height = read_i32_le(data, 8);
    let bit_count = read_u16_le(data, 14);

    if width <= 0 {
        return Err(format!("Invalid width: {width}"));
    }
    if bit_count != 32 {
        return Err(format!(
            "Unsupported DIBV5 bit count: {bit_count} (only 32-bit supported)"
        ));
    }

    let (abs_height, bottom_up) = if height > 0 {
        (height as u32, true)
    } else {
        ((-height) as u32, false)
    };

    let width = width as u32;
    let row_size = (width as usize) * 4;
    let pixel_offset = header_size;
    let pixel_data = &data[pixel_offset..];

    let expected_size = row_size * (abs_height as usize);
    if pixel_data.len() < expected_size {
        return Err(format!(
            "DIBV5 pixel data too short: got {}, expected {expected_size}",
            pixel_data.len()
        ));
    }

    // Convert BGRA → RGBA, handling row order
    let mut rgba = Vec::with_capacity(expected_size);
    for y in 0..abs_height as usize {
        let src_y = if bottom_up {
            (abs_height as usize) - 1 - y
        } else {
            y
        };
        let row_start = src_y * row_size;
        let row = &pixel_data[row_start..row_start + row_size];
        for chunk in row.chunks_exact(4) {
            rgba.push(chunk[2]); // R (from B position)
            rgba.push(chunk[1]); // G
            rgba.push(chunk[0]); // B (from R position)
            rgba.push(chunk[3]); // A
        }
    }

    encode_rgba_to_png(width, abs_height, &rgba)
}

/// Convert CF_DIB (BITMAPINFOHEADER) data to PNG bytes.
///
/// Similar to dibv5_to_png but with 40-byte header. Supports 24-bit and 32-bit.
pub fn dib_to_png(data: &[u8]) -> Result<Vec<u8>, String> {
    if data.len() < 40 {
        return Err("DIB data too short for BITMAPINFOHEADER".into());
    }

    let header_size = read_u32_le(data, 0) as usize;
    if header_size < 40 {
        return Err(format!("Invalid DIB header size: {header_size}"));
    }

    let width = read_i32_le(data, 4);
    let height = read_i32_le(data, 8);
    let bit_count = read_u16_le(data, 14);
    let compression = read_u32_le(data, 16);

    if width <= 0 {
        return Err(format!("Invalid width: {width}"));
    }
    if bit_count != 24 && bit_count != 32 {
        return Err(format!(
            "Unsupported DIB bit count: {bit_count} (only 24/32 supported)"
        ));
    }

    let (abs_height, bottom_up) = if height > 0 {
        (height as u32, true)
    } else {
        ((-height) as u32, false)
    };

    let width = width as u32;

    // Calculate pixel data offset (header + optional color masks for BI_BITFIELDS)
    let color_table_size = if compression == 3 && bit_count == 32 {
        // BI_BITFIELDS: 3 DWORD color masks follow the header
        12
    } else {
        0
    };
    let pixel_offset = header_size + color_table_size;
    let pixel_data = if pixel_offset <= data.len() {
        &data[pixel_offset..]
    } else {
        return Err("DIB pixel data offset beyond data length".into());
    };

    // Row size is padded to 4-byte boundary
    let bytes_per_pixel = (bit_count as usize) / 8;
    let raw_row_size = (width as usize) * bytes_per_pixel;
    let row_stride = (raw_row_size + 3) & !3; // Align to 4 bytes

    let expected_size = row_stride * (abs_height as usize);
    if pixel_data.len() < expected_size {
        return Err(format!(
            "DIB pixel data too short: got {}, expected {expected_size}",
            pixel_data.len()
        ));
    }

    // Convert to RGBA
    let out_size = (width as usize) * (abs_height as usize) * 4;
    let mut rgba = Vec::with_capacity(out_size);

    for y in 0..abs_height as usize {
        let src_y = if bottom_up {
            (abs_height as usize) - 1 - y
        } else {
            y
        };
        let row_start = src_y * row_stride;
        let row = &pixel_data[row_start..row_start + raw_row_size];

        match bit_count {
            32 => {
                for chunk in row.chunks_exact(4) {
                    rgba.push(chunk[2]); // R
                    rgba.push(chunk[1]); // G
                    rgba.push(chunk[0]); // B
                    rgba.push(chunk[3]); // A
                }
            }
            24 => {
                for chunk in row.chunks_exact(3) {
                    rgba.push(chunk[2]); // R
                    rgba.push(chunk[1]); // G
                    rgba.push(chunk[0]); // B
                    rgba.push(255u8); // A
                }
            }
            _ => unreachable!(),
        }
    }

    encode_rgba_to_png(width, abs_height, &rgba)
}

// ── Helper functions ──

/// Encode RGBA pixel data to PNG bytes.
fn encode_rgba_to_png(width: u32, height: u32, rgba: &[u8]) -> Result<Vec<u8>, String> {
    let mut buf = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut buf, width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder
            .write_header()
            .map_err(|e| format!("PNG encode header error: {e}"))?;
        writer
            .write_image_data(rgba)
            .map_err(|e| format!("PNG encode data error: {e}"))?;
    }
    Ok(buf)
}

#[inline]
fn write_u32_le(buf: &mut [u8], offset: usize, val: u32) {
    buf[offset..offset + 4].copy_from_slice(&val.to_le_bytes());
}

#[inline]
fn write_i32_le(buf: &mut [u8], offset: usize, val: i32) {
    buf[offset..offset + 4].copy_from_slice(&val.to_le_bytes());
}

#[inline]
fn write_u16_le(buf: &mut [u8], offset: usize, val: u16) {
    buf[offset..offset + 2].copy_from_slice(&val.to_le_bytes());
}

#[inline]
fn read_u32_le(buf: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes([
        buf[offset],
        buf[offset + 1],
        buf[offset + 2],
        buf[offset + 3],
    ])
}

#[inline]
fn read_i32_le(buf: &[u8], offset: usize) -> i32 {
    i32::from_le_bytes([
        buf[offset],
        buf[offset + 1],
        buf[offset + 2],
        buf[offset + 3],
    ])
}

#[inline]
fn read_u16_le(buf: &[u8], offset: usize) -> u16 {
    u16::from_le_bytes([buf[offset], buf[offset + 1]])
}

// ── Tests ──

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_text_roundtrip() {
        let original = "Hello, 世界! 🌍";
        let utf16 = text_to_utf16le(original);
        let decoded = utf16le_to_text(&utf16).unwrap();
        assert_eq!(decoded, original);
    }

    #[test]
    fn test_text_empty() {
        let utf16 = text_to_utf16le("");
        // Should be just null terminator (2 bytes)
        assert_eq!(utf16, vec![0, 0]);
        let decoded = utf16le_to_text(&utf16).unwrap();
        assert_eq!(decoded, "");
    }

    #[test]
    fn test_utf16le_odd_bytes() {
        // Odd number of bytes should return None
        assert_eq!(utf16le_to_text(&[0x41, 0x00, 0x42]), None);
    }

    #[test]
    fn test_html_roundtrip() {
        let html = "<b>Hello</b>";
        let cf_html = html_to_cf_html(html);
        let decoded = cf_html_to_html(&cf_html).unwrap();
        assert_eq!(decoded, html);
    }

    #[test]
    fn test_cf_html_parse() {
        // Test with a real CF_HTML sample — offsets must match actual byte positions.
        // Header (97 bytes) + "<html><body>\r\n" (14) + "<!--StartFragment-->" (20) = 131
        // Fragment "<b>test</b>" ends at 131 + 11 = 142
        let cf_html = b"Version:0.9\r\nStartHTML:00000097\r\nEndHTML:00000175\r\nStartFragment:00000131\r\nEndFragment:00000142\r\n<html><body>\r\n<!--StartFragment--><b>test</b><!--EndFragment-->\r\n</body></html>";
        let result = cf_html_to_html(cf_html).unwrap();
        assert_eq!(result, "<b>test</b>");
    }

    #[test]
    fn test_html_with_special_chars() {
        let html = "<p>Price: $100 &amp; €50</p>";
        let cf_html = html_to_cf_html(html);
        let decoded = cf_html_to_html(&cf_html).unwrap();
        assert_eq!(decoded, html);
    }

    #[test]
    fn test_png_dibv5_roundtrip() {
        // Create a minimal 2x2 PNG
        let mut buf = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut buf, 2, 2);
            encoder.set_color(png::ColorType::Rgba);
            encoder.set_depth(png::BitDepth::Eight);
            let mut writer = encoder.write_header().unwrap();
            // 2x2 RGBA: red, green, blue, white
            let data: Vec<u8> = vec![
                255, 0, 0, 255, 0, 255, 0, 255, // row 0
                0, 0, 255, 255, 255, 255, 255, 255, // row 1
            ];
            writer.write_image_data(&data).unwrap();
        }

        let dibv5 = png_to_dibv5(&buf).unwrap();
        assert!(dibv5.len() > 124); // header + pixel data

        // Verify header fields
        assert_eq!(read_u32_le(&dibv5, 0), 124); // bV5Size
        assert_eq!(read_i32_le(&dibv5, 4), 2); // width
        assert_eq!(read_i32_le(&dibv5, 8), 2); // height (positive = bottom-up)
        assert_eq!(read_u16_le(&dibv5, 14), 32); // bit count

        let png_back = dibv5_to_png(&dibv5).unwrap();
        // Verify it's a valid PNG (magic bytes)
        assert_eq!(&png_back[0..8], &[137, 80, 78, 71, 13, 10, 26, 10]);
    }

    #[test]
    fn test_dib_24bit() {
        // Create a 2x2 24-bit DIB (BI_RGB, bottom-up)
        let width: u32 = 2;
        let height: u32 = 2;
        let row_stride = 8; // 2 pixels * 3 bytes = 6, padded to 8
        let header_size = 40;

        let mut data = vec![0u8; header_size + row_stride * 2];
        write_u32_le(&mut data, 0, 40); // biSize
        write_i32_le(&mut data, 4, width as i32);
        write_i32_le(&mut data, 8, height as i32); // positive = bottom-up
        write_u16_le(&mut data, 12, 1); // biPlanes
        write_u16_le(&mut data, 14, 24); // biBitCount
        write_u32_le(&mut data, 16, 0); // biCompression = BI_RGB

        // Bottom row (row 0 in DIB = bottom of image): blue, green
        let pixel_start = header_size;
        data[pixel_start] = 255;
        data[pixel_start + 1] = 0;
        data[pixel_start + 2] = 0; // BGR = blue
        data[pixel_start + 3] = 0;
        data[pixel_start + 4] = 255;
        data[pixel_start + 5] = 0; // BGR = green

        // Top row (row 1 in DIB = top of image): red, white
        let row1_start = pixel_start + row_stride;
        data[row1_start] = 0;
        data[row1_start + 1] = 0;
        data[row1_start + 2] = 255; // BGR = red
        data[row1_start + 3] = 255;
        data[row1_start + 4] = 255;
        data[row1_start + 5] = 255; // BGR = white

        let png_data = dib_to_png(&data).unwrap();
        // Verify valid PNG
        assert_eq!(&png_data[0..8], &[137, 80, 78, 71, 13, 10, 26, 10]);
    }
}
