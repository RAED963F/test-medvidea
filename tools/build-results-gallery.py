#!/usr/bin/env python3
"""Build the web-optimised Doctor Results gallery from work-photo/.

    python tools/build-results-gallery.py            # incremental
    python tools/build-results-gallery.py --force    # re-encode everything

Reads   work-photo/<Category>/<Specialty>/<Doctor>/[<Procedure>/]<images>   (never modified)
Writes  work-photo-web/<category>/<specialty>/<doctor>/<procedure>/NN-<width>.webp
        work-photo-web/manifest.js    (window.MEDIVIA_RESULTS, loaded by the site)

Wording (English / Arabic) and ASCII slugs for the Russian folder names come
from tools/results-gallery.config.json. A folder that is not in the config is
reported and skipped, so untranslated Russian text can never reach the page.
Requires Pillow with WebP support.
"""
import json
import re
import sys
import unicodedata
from datetime import datetime, timezone
from pathlib import Path

from PIL import Image, ImageOps

Image.MAX_IMAGE_PIXELS = None  # the originals are large; they are trusted local files

ROOT = Path(__file__).resolve().parent.parent
CONFIG = ROOT / "tools" / "results-gallery.config.json"
IMAGE_EXT = {".jpg", ".jpeg", ".png"}


def norm(name: str) -> str:
    return re.sub(r"\s+", " ", unicodedata.normalize("NFC", name)).strip().casefold()


def natural_key(name: str):
    return [int(p) if p.isdigit() else p.casefold() for p in re.split(r"(\d+)", name)]


def lookup(table: dict, name: str):
    wanted = norm(name)
    for key, value in table.items():
        if norm(key) == wanted:
            return value
    return None


def images_in(folder: Path, ignore_prefixes):
    files = [p for p in folder.iterdir() if p.is_file() and p.suffix.lower() in IMAGE_EXT]
    kept, ignored = [], []
    for p in sorted(files, key=lambda p: natural_key(p.name)):
        if any(norm(p.name).startswith(norm(pre)) for pre in ignore_prefixes):
            ignored.append(p)
        else:
            kept.append(p)
    return kept, ignored


def encode(src: Path, out_base: Path, cfg: dict, force: bool):
    """Write NN-<w>.webp variants for one original. Returns (large_w, large_h, widths, written, skipped)."""
    thumbs = cfg["thumbWidths"]
    large = cfg["largeWidth"]
    with Image.open(src) as im:
        im = ImageOps.exif_transpose(im)
        ow, oh = im.size
        widths = sorted({min(w, ow) for w in [*thumbs, large]})
        icc = im.info.get("icc_profile")
        written = skipped = 0
        rgb = None
        for w in widths:
            out = out_base.parent / f"{out_base.name}-{w}.webp"
            if not force and out.exists() and out.stat().st_mtime >= src.stat().st_mtime:
                skipped += 1
                continue
            if rgb is None:
                # alpha in these PNGs is a 254/255 edge artefact; drop it (colour untouched)
                rgb = im.convert("RGB")
            h = round(oh * w / ow)
            frame = rgb if w == ow else rgb.resize((w, h), Image.LANCZOS)
            out.parent.mkdir(parents=True, exist_ok=True)
            frame.save(
                out, "WEBP",
                quality=cfg["largeQuality"] if w == widths[-1] else cfg["thumbQuality"],
                method=6, icc_profile=icc,
            )
            written += 1
    lw = widths[-1]
    return lw, round(oh * lw / ow), widths, written, skipped


def main():
    force = "--force" in sys.argv
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    conf = json.loads(CONFIG.read_text(encoding="utf-8"))
    source = ROOT / conf["sourceDir"]
    output = ROOT / conf["outputDir"]
    icfg = conf["image"]
    problems, stats = [], {"found": 0, "ignored": 0, "processed": 0, "files": 0, "skipped": 0, "bytes": 0}

    manifest = {"version": 1, "base": conf["publicBase"], "categories": {}}

    for cat_dir in sorted(p for p in source.iterdir() if p.is_dir()):
        cat = lookup(conf["categories"], cat_dir.name)
        if not cat:
            problems.append(f"Category not in config, skipped: {cat_dir.name}")
            continue
        specialties, doctors = {}, {}

        for spec_dir in sorted(p for p in cat_dir.iterdir() if p.is_dir()):
            spec = lookup(conf["specialties"], spec_dir.name)
            if not spec:
                problems.append(f"Specialty not in config, skipped: {spec_dir.name}")
                continue
            specialties[spec["slug"]] = {"id": spec["slug"], "order": spec["order"], "label": spec["label"]}

            for doc_dir in sorted(p for p in spec_dir.iterdir() if p.is_dir()):
                doc = lookup(conf["doctors"], doc_dir.name)
                if not doc:
                    problems.append(f"Doctor not in config, skipped: {spec_dir.name}/{doc_dir.name}")
                    continue

                # (procedure config, image files) — loose images sit directly in the doctor folder
                groups = []
                loose, ign = images_in(doc_dir, conf.get("ignoreFilePrefixes", []))
                stats["ignored"] += len(ign)
                for p in ign:
                    problems.append(f"Ignored (not a before/after result): {p.relative_to(source)}")
                stats["found"] += len(ign)
                if loose:
                    cfg_loose = spec.get("looseImages")
                    if cfg_loose:
                        groups.append((cfg_loose, loose))
                    else:
                        stats["found"] += len(loose)
                        problems.append(f"Loose images without 'looseImages' config, skipped: {doc_dir.relative_to(source)}")

                for proc_dir in sorted(p for p in doc_dir.iterdir() if p.is_dir()):
                    files, ign = images_in(proc_dir, conf.get("ignoreFilePrefixes", []))
                    stats["ignored"] += len(ign)
                    stats["found"] += len(ign)
                    proc = lookup(conf["procedures"], proc_dir.name)
                    if not proc:
                        stats["found"] += len(files)
                        problems.append(f"Procedure not in config, skipped: {proc_dir.relative_to(source)}")
                        continue
                    groups.append((proc, files))

                for proc, files in groups:
                    entry = {
                        "id": f"{spec['slug']}-{proc['slug']}",
                        "specialty": spec["slug"],
                        "title": proc["title"],
                        "timing": proc.get("timing"),
                        "images": [],
                    }
                    for i, src in enumerate(files, 1):
                        stats["found"] += 1
                        rel = f"{cat['slug']}/{spec['slug']}/{doc}/{proc['slug']}/{i:02d}"
                        try:
                            w, h, widths, wr, sk = encode(src, output / rel, icfg, force)
                        except Exception as exc:  # keep going, report at the end
                            problems.append(f"Could not process {src.relative_to(source)}: {exc}")
                            continue
                        stats["processed"] += 1
                        stats["files"] += len(widths)
                        stats["skipped"] += sk
                        entry["images"].append({"src": rel, "w": w, "h": h, "v": widths})
                    if entry["images"]:
                        doctors.setdefault(doc, []).append(entry)

        manifest["categories"][cat["slug"]] = {
            "specialties": sorted(specialties.values(), key=lambda s: s["order"]),
            "doctors": doctors,
        }

    output.mkdir(parents=True, exist_ok=True)
    manifest["generated"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    (output / "manifest.js").write_text(
        "/* Generated by tools/build-results-gallery.py — do not edit by hand. */\n"
        "window.MEDIVIA_RESULTS = "
        + json.dumps(manifest, ensure_ascii=False, separators=(",", ":"))
        + ";\n",
        encoding="utf-8",
    )
    total = sum(p.stat().st_size for p in output.rglob("*.webp"))

    print(f"Originals found:      {stats['found']}  (ignored non-results: {stats['ignored']})")
    print(f"Originals processed:  {stats['processed']}")
    print(f"WebP files in output: {sum(1 for _ in output.rglob('*.webp'))}  ({total / 1048576:.1f} MB)")
    print(f"  (encoded this run: {stats['files'] - stats['skipped']}, up to date: {stats['skipped']})")
    for p in problems:
        print("NOTE:", p)


if __name__ == "__main__":
    main()
