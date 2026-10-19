"""Build the project-page assets for the GigaBench images.

For every image listed in tools/images.json it writes:
    <out>/tiles/<id>.dzi + <id>_files/   Deep Zoom pyramid (WebP tiles), uploaded to R2
    <out>/previews/<id>.webp             carousel card, 4:3 (landscape) or 3:4 (portrait) crop
    <out>/images.json                    metadata read by the page (always covers all images)

An image entry may set "focus": [fx, fy] (fractions of width/height) to move the card crop
away from the centre.

Usage:
    python tools/make_tiles.py --src /path/to/Gigadataset --out /path/to/web
    python tools/make_tiles.py --src ... --out ... --only venice --no-previews
"""
import argparse
import json
import time
from pathlib import Path

import pyvips

HERE = Path(__file__).parent
PREVIEW_HEIGHT = 480   # 2x the card height on the page
PREVIEW_QUALITY = 82
TILE_SIZE = 512
TILE_QUALITY = 85


def crop_box(w, h, focus):
    """Largest 4:3 (landscape) or 3:4 (portrait) box inside a w x h image, centred on focus."""
    ratio = 4 / 3 if w >= h else 3 / 4
    if w / h > ratio:
        cw, ch = round(h * ratio), h
    else:
        cw, ch = w, round(w / ratio)
    fx, fy = focus
    left = min(max(round(fx * w - cw / 2), 0), w - cw)
    top = min(max(round(fy * h - ch / 2), 0), h - ch)
    return left, top, cw, ch


def make_preview(path, out_path, focus):
    # Shrink the whole image first (thumbnail reads TIFF pyramid levels when present), then crop.
    header = pyvips.Image.new_from_file(str(path))
    _, _, cw, ch = crop_box(header.width, header.height, focus)
    scale = PREVIEW_HEIGHT / ch
    small = pyvips.Image.thumbnail(str(path), round(header.width * scale), height=round(header.height * scale) + 1)
    left, top, cw, ch = crop_box(small.width, small.height, focus)
    small.crop(left, top, cw, ch).webpsave(str(out_path), Q=PREVIEW_QUALITY, strip=True)


def make_tiles(path, out_base):
    img = pyvips.Image.new_from_file(str(path), access="sequential")
    img.dzsave(str(out_base), suffix=f".webp[Q={TILE_QUALITY}]", tile_size=TILE_SIZE, overlap=1)


def page_entry(meta, path):
    """Metadata the page needs; sizes follow the paper (GPx and GB in powers of 2)."""
    img = pyvips.Image.new_from_file(str(path))
    entry = {k: v for k, v in meta.items() if k not in ("file", "focus")}
    entry["width"], entry["height"] = img.width, img.height
    entry["gpx"] = round(img.width * img.height / 2**30, 2)
    entry["size_gb"] = round(img.width * img.height * img.bands / 2**30, 2)
    entry["orientation"] = "landscape" if img.width >= img.height else "portrait"
    return entry


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--src", required=True, type=Path, help="folder with the GigaBench .tif files")
    parser.add_argument("--out", required=True, type=Path, help="output folder for tiles, previews and images.json")
    parser.add_argument("--only", nargs="+", help="image ids to process (default: all)")
    parser.add_argument("--no-tiles", action="store_true", help="skip the Deep Zoom pyramids")
    parser.add_argument("--no-previews", action="store_true", help="skip the carousel cards")
    parser.add_argument("--force", action="store_true", help="rebuild tiles that already exist")
    args = parser.parse_args()

    images = json.loads((HERE / "images.json").read_text())
    (args.out / "tiles").mkdir(parents=True, exist_ok=True)
    (args.out / "previews").mkdir(parents=True, exist_ok=True)

    for meta in images:
        if args.only and meta["id"] not in args.only:
            continue
        path = args.src / meta["file"]
        if not args.no_previews:
            t = time.time()
            make_preview(path, args.out / "previews" / f"{meta['id']}.webp", meta.get("focus", (0.5, 0.5)))
            print(f"[preview] {meta['id']} in {time.time() - t:.0f}s", flush=True)
        if not args.no_tiles:
            out_base = args.out / "tiles" / meta["id"]
            if out_base.with_suffix(".dzi").exists() and not args.force:
                print(f"[tiles]   {meta['id']} exists, skipped (use --force)", flush=True)
            else:
                t = time.time()
                make_tiles(path, out_base)
                print(f"[tiles]   {meta['id']} in {time.time() - t:.0f}s", flush=True)

    manifest = [page_entry(meta, args.src / meta["file"]) for meta in images]
    (args.out / "images.json").write_text(json.dumps(manifest, indent=2))
    print(f"[manifest] {args.out / 'images.json'}", flush=True)


if __name__ == "__main__":
    main()
