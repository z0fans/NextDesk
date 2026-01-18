#!/usr/bin/env python3
"""
NextDesk Icon Generator
Converts SVG logo to ICO format for Windows packaging.

Requirements:
    pip install cairosvg pillow

Usage:
    python scripts/generate_icons.py
"""

import os
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


def svg_to_png(svg_path: Path, size: int) -> Image.Image:
    """Convert SVG to PNG at specified size."""
    png_data = cairosvg.svg2png(
        url=str(svg_path), output_width=size, output_height=size
    )
    return Image.open(io.BytesIO(png_data))


def create_ico(svg_path: Path, ico_path: Path, sizes: list[int]) -> None:
    """Create ICO file with multiple sizes from SVG."""
    images = []

    for size in sizes:
        print(f"  Generating {size}x{size}...")
        img = svg_to_png(svg_path, size)
        # Ensure RGBA mode for transparency
        if img.mode != "RGBA":
            img = img.convert("RGBA")
        images.append(img)

    # Save as ICO with all sizes
    # Pillow ICO plugin needs images passed correctly
    # Use the largest image as base and pass all sizes
    largest = max(images, key=lambda x: x.width)
    largest.save(
        ico_path,
        format="ICO",
        sizes=[(img.width, img.height) for img in images],
    )
    print(f"  Created: {ico_path} ({len(images)} sizes embedded)")


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
    print("Next steps:")
    print("  1. Update build.spec: icon='assets/icons/NextDesk.ico'")
    print("  2. Update setup.iss: SetupIconFile=assets\\icons\\NextDesk.ico")


if __name__ == "__main__":
    main()
