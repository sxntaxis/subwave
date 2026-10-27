#!/usr/bin/env python3
"""Build the compact SXNTAX 3270 Nerd Font subset.

Keeps the 3270 text face useful for SXNTAX system copy while retaining only
Nerd Font private-use glyphs that are actually referenced by source code.
Additional scan roots may be supplied so sxntax.shop and radio.sxntax.shop can
share the same tuned font contract without carrying the full Nerd Font.
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

try:
    from fontTools import subset
    from fontTools.ttLib import TTFont
except ImportError as exc:  # pragma: no cover - build-environment guard
    raise SystemExit(
        "fontTools is required. Install pinned build deps with: "
        "python3 -m pip install 'fonttools==4.63.0' 'brotli==1.1.0'"
    ) from exc

# System copy is deliberately broader than the literal strings in radio: this
# is the reusable SXNTAX text core for radio + sxntax.shop. Dynamic content may
# include accented Latin names, punctuation, weather symbols and arrows.
TEXT_RANGES = (
    (0x0020, 0x007E),  # Basic Latin
    (0x00A0, 0x017F),  # Latin-1 + Latin Extended-A
    (0x2000, 0x206F),  # General punctuation
    (0x20AC, 0x20AC),  # Euro sign
    (0x2190, 0x21FF),  # Arrows
)

TEXT_EXTENSIONS = {
    ".css", ".html", ".js", ".jsx", ".json", ".md", ".mjs", ".ts", ".tsx",
}
SKIP_PARTS = {".git", ".next", "node_modules", "dist", "build"}
ESCAPED_UNICODE = re.compile(r"\\u(?:\{([0-9A-Fa-f]{1,6})\}|([0-9A-Fa-f]{4}))")
MAX_SUBSET_BYTES = 64 * 1024


def is_private_use(codepoint: int) -> bool:
    return (
        0xE000 <= codepoint <= 0xF8FF
        or 0xF0000 <= codepoint <= 0xFFFFD
        or 0x100000 <= codepoint <= 0x10FFFD
    )


def iter_source_files(root: Path):
    if root.is_file():
        yield root
        return
    for path in root.rglob("*"):
        if not path.is_file() or path.suffix.lower() not in TEXT_EXTENSIONS:
            continue
        if any(part in SKIP_PARTS for part in path.parts):
            continue
        # Font assets and generated/static payloads should not teach the subset
        # about their own binary/private-use contents.
        if "public" in path.parts and "fonts" in path.parts:
            continue
        yield path


def discover_private_use(roots: list[Path]) -> set[int]:
    codepoints: set[int] = set()
    for root in roots:
        if not root.exists():
            continue
        for path in iter_source_files(root):
            try:
                text = path.read_text(encoding="utf-8", errors="ignore")
            except OSError:
                continue
            for char in text:
                cp = ord(char)
                if is_private_use(cp):
                    codepoints.add(cp)
            for match in ESCAPED_UNICODE.finditer(text):
                cp = int(match.group(1) or match.group(2), 16)
                if is_private_use(cp):
                    codepoints.add(cp)
    return codepoints


def text_core() -> set[int]:
    result: set[int] = set()
    for start, end in TEXT_RANGES:
        result.update(range(start, end + 1))
    return result


def cmap_codepoints(font: TTFont) -> set[int]:
    return {cp for table in font["cmap"].tables for cp in table.cmap}


def build(source: Path, output: Path, scan_roots: list[Path]) -> tuple[int, int, set[int]]:
    icons = discover_private_use(scan_roots)
    wanted = text_core() | icons

    font = TTFont(source)
    source_cmap = cmap_codepoints(font)
    missing_icons = sorted(cp for cp in icons if cp not in source_cmap)
    if missing_icons:
        formatted = ", ".join(f"U+{cp:X}" for cp in missing_icons)
        raise SystemExit(f"source font is missing referenced Nerd glyph(s): {formatted}")

    options = subset.Options()
    options.flavor = "woff2"
    options.hinting = True
    options.layout_features = ["*"]
    options.name_IDs = [0, 1, 2, 3, 4, 5, 6, 13, 14]
    options.name_legacy = True
    options.name_languages = [0x409]
    options.notdef_glyph = True
    options.notdef_outline = True
    options.recommended_glyphs = True

    subsetter = subset.Subsetter(options=options)
    subsetter.populate(unicodes=wanted)
    subsetter.subset(font)
    font.flavor = "woff2"
    output.parent.mkdir(parents=True, exist_ok=True)
    font.save(output)

    size = output.stat().st_size
    if size > MAX_SUBSET_BYTES:
        raise SystemExit(
            f"SXNTAX Nerd Font budget exceeded: {size} bytes > {MAX_SUBSET_BYTES}. "
            "Audit newly referenced glyphs before raising the budget."
        )

    verify = TTFont(output)
    output_cmap = cmap_codepoints(verify)
    lost_icons = sorted(cp for cp in icons if cp not in output_cmap)
    if lost_icons:
        formatted = ", ".join(f"U+{cp:X}" for cp in lost_icons)
        raise SystemExit(f"subset lost referenced Nerd glyph(s): {formatted}")

    return source.stat().st_size, size, icons


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--scan-root", action="append", type=Path, default=[])
    args = parser.parse_args()

    roots = args.scan_root or [Path("web")]
    before, after, icons = build(args.source, args.output, roots)
    reduction = (1.0 - after / before) * 100 if before else 0.0
    icon_list = ",".join(f"U+{cp:X}" for cp in sorted(icons)) or "none"
    print(
        f"SXNTAX_NERDFONT source={before} subset={after} "
        f"reduction={reduction:.2f}% icons={icon_list}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
