#!/usr/bin/env python3
"""
NextDesk Icon Generator
Converts SVG logo to ICO format for Windows packaging.

Requirements:
    pip install cairosvg pillow

Usage:
    python scripts/generate_icons.py
"""

import struct
import sys
from pathlib import Path

try:
    import cairosvg
    from PIL import Image
    import io
except ImportError:
    print("Missing dependencies. Please install:")
    print("  pip install cairosvg pillow")
    sys.exit(1)


def svg_to_png_data(svg_path: Path, size: int) -> bytes:
    """Convert SVG to PNG bytes at specified size."""
    return cairosvg.svg2png(url=str(svg_path), output_width=size, output_height=size)


def svg_to_png(svg_path: Path, size: int) -> Image.Image:
    """Convert SVG to PIL Image at specified size."""
    png_data = svg_to_png_data(svg_path, size)
    return Image.open(io.BytesIO(png_data))


def build_ico_manually(sizes_and_data: list[tuple[int, bytes]]) -> bytes:
    """
    Build ICO file manually to ensure proper multi-size support.

    ICO format:
    - Header: 6 bytes (reserved=0, type=1, count=N)
    - Directory entries: 16 bytes each
    - Image data: PNG format
    """
    num_images = len(sizes_and_data)

    # Header: reserved (2 bytes), type (2 bytes), count (2 bytes)
    header = struct.pack("<HHH", 0, 1, num_images)

    # Calculate where image data starts
    dir_size = 16 * num_images
    data_offset = 6 + dir_size

    directory = b""
    image_data = b""

    for size, png_data in sizes_and_data:
        # For sizes >= 256, use 0 in the directory entry (ICO spec)
        w = 0 if size >= 256 else size
        h = 0 if size >= 256 else size

        # Directory entry format:
        # width (1), height (1), colors (1), reserved (1),
        # planes (2), bits_per_pixel (2), size (4), offset (4)
        entry = struct.pack(
            "<BBBBHHII",
            w,
            h,
            0,
            0,  # width, height, colors, reserved
            1,
            32,  # planes, bits per pixel (32 for RGBA)
            len(png_data),  # size of image data
            data_offset + len(image_data),  # offset to image data
        )
        directory += entry
        image_data += png_data

    return header + directory + image_data


def create_ico(svg_path: Path, ico_path: Path, sizes: list[int]) -> None:
    """Create ICO file with multiple sizes from SVG."""
    png_data_list = []

    for size in sizes:
        png_data = svg_to_png_data(svg_path, size)
        png_data_list.append((size, png_data))
        print(f"  Generated {size}x{size} ({len(png_data)} bytes)")

    # Build ICO file manually for reliable multi-size support
    ico_data = build_ico_manually(png_data_list)

    with open(ico_path, "wb") as f:
        f.write(ico_data)

    print(f"  Created: {ico_path} ({len(sizes)} sizes, {len(ico_data)} bytes)")


def main():
    # Paths
    project_root = Path(__file__).parent.parent
    svg_path = project_root / "frontend" / "src" / "assets" / "logo.svg"
    icons_dir = project_root / "assets" / "icons"

    # Create output directory
    icons_dir.mkdir(parents=True, exist_ok=True)

    # Check SVG exists
    if not svg_path.exists():
        print(f"Error: SVG not found at {svg_path}")
        sys.exit(1)

    print(f"Source: {svg_path}")
    print()

    # Windows ICO sizes (standard for exe icons)
    ico_sizes = [16, 24, 32, 48, 64, 128, 256]

    # Generate main application icon
    print("Generating NextDesk.ico...")
    create_ico(svg_path, icons_dir / "NextDesk.ico", ico_sizes)

    # Also generate individual PNGs for other uses
    print()
    print("Generating PNG variants...")
    png_sizes = [16, 32, 48, 64, 128, 256, 512]

    for size in png_sizes:
        png_path = icons_dir / f"icon-{size}.png"
        img = svg_to_png(svg_path, size)
        img.save(png_path, "PNG")
        print(f"  Created: {png_path}")

    print()
    print("Done! Icon files generated in:", icons_dir)
    print()
    print("=" * 50)
    print("IMPORTANT: To apply the new icon, you must:")
    print("  1. Re-run: pyinstaller build.spec --clean")
    print("  2. Re-run: iscc setup.iss")
    print("  3. Delete old shortcuts and create new ones")
    print("=" * 50)


if __name__ == "__main__":
    main()
