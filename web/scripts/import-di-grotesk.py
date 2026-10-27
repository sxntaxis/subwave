#!/usr/bin/env python3
"""Import licensed Di Grotesk WOFF2 faces from a local owner-supplied ZIP.

No font binaries are included with the SUB/WAVE source patch or agent kit.
Usage: python3 web/scripts/import-di-grotesk.py path/to/di-grotesk.zip
"""
from __future__ import annotations

import argparse
import hashlib
import os
from pathlib import Path
import tempfile
from zipfile import ZipFile

# SHA-256 values of the eight WOFF2 cuts in the supplied archive. The existing
# Regular in SUB/WAVE is byte-identical to that cut; reject a mismatched pack.
EXPECTED = {
    "Regular": "06b97ab20f16d7688d79514fb560c775ea21f6ad801d7eabd9372f9469aab3e4",
    "Italic": "30ec0e68a16b6afb0d6cc434d383e1e8c97608151e50fa3afb0922377a8a9ec7",
    "Bold": "6b00e270f13440da683a79320505606daab248de5c3af217b21f39c8e62a4af1",
    "BoldItalic": "4910bfcadcd668dc36fd58710d8c5296d89bff3638dea38ba53ae0dee10fa308",
    "ExtraBold": "a8bbd252de5ac04f2b96f8802dc55167ca1b90442d61f4f913cbc5974dd05acc",
    "ExtraBoldItalic": "208347d5cf5461ce52f9e09ff183dc1227bee26009d0f938941eb5d5a0eaea60",
    "Black": "2b83a085a3ff5d2a7548d2630af0f6e78b6bdf2b92ac096f9f287eda5c769d93",
    "BlackItalic": "30b57779eebf41d03852df6789ab75e2db06b87b30ec2219a1f71c40c3f2fa7e",
 }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path, help="Owner-provided di-grotesk.zip")
    parser.add_argument("--web-root", type=Path, default=Path(__file__).resolve().parent.parent,
                        help="Target web/ directory (defaults to this script's web/)")
    args = parser.parse_args()
    target = args.web_root.resolve() / "public" / "fonts"
    regular = target / "DiGrotesk-Regular.woff2"
    if not regular.is_file():
        parser.error(f"Missing existing Regular face: {regular}")
    if hashlib.sha256(regular.read_bytes()).hexdigest() != EXPECTED["Regular"]:
        parser.error("Existing Regular face does not match the supplied font family; no files written")

    data: dict[str, bytes] = {}
    with ZipFile(args.archive) as archive:
        for style, checksum in EXPECTED.items():
            name = f"DiGrotesk-{style}.woff2"
            payload = archive.read(name)
            if not payload.startswith(b"wOF2") or hashlib.sha256(payload).hexdigest() != checksum:
                parser.error(f"Font cut differs from the inspected archive: {name}; no files written")
            data[name] = payload

    # Preflight ALL existing cuts before changing anything.
    for name, payload in data.items():
        existing = target / name
        if existing.exists() and existing.read_bytes() != payload:
            parser.error(f"Refusing to overwrite different existing font: {existing}")
    installed = 0
    for name, payload in data.items():
        dest = target / name
        if dest.exists():
            continue
        with tempfile.NamedTemporaryFile(prefix=".di-grotesk-", suffix=".tmp", dir=target, delete=False) as f:
            temp_path = Path(f.name)
            f.write(payload)
        try:
            os.chmod(temp_path, 0o644)
            os.replace(temp_path, dest)
        finally:
            temp_path.unlink(missing_ok=True)
        installed += 1
    print(f"Di Grotesk verified: {len(EXPECTED)} exact faces; {installed} newly installed; 0 overwritten")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
