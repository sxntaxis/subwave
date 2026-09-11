#!/usr/bin/env python3
"""Dry-run-first native Navidrome smart-crate projection for The Lab."""
import argparse, hashlib, json, os, secrets, sys, unicodedata
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.parse import urlencode

EXPECTED = "0.63.2 (be10f89c)"
STRUCTURAL = {"STRUCTURAL_DYNAMIC"}

def normalized(value):
    return " ".join(unicodedata.normalize("NFKC", value).casefold().split())

def resolve_all(canonical, live_genres):
    matches = sorted({value for value in live_genres if normalized(value) == normalized(canonical)})
    if not matches: raise SystemExit(f"genre resolution failed: {canonical}")
    return matches

def require_evaluated(playlist):
    if not playlist.get("evaluatedAt"):
        raise SystemExit(f"smart playlist is not evaluated: {playlist.get('name', '<unknown>')}")

def require_membership(reference_ids, native_ids):
    if set(reference_ids) != set(native_ids):
        raise SystemExit("native smart membership does not equal reference")

def call(url, method="GET", body=None, headers=None):
    data = None if body is None else json.dumps(body, ensure_ascii=False).encode()
    h = {"Accept": "application/json", **(headers or {})}
    if data: h["Content-Type"] = "application/json"
    with urlopen(Request(url, data=data, headers=h, method=method), timeout=30) as r:
        return r.status, json.loads(r.read() or b"{}")

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--apply", action="store_true"); ap.add_argument("--check", action="store_true")
    args = ap.parse_args()
    if args.apply and args.check: ap.error("choose --apply or --check")
    base = Path(__file__).parent; manifest = json.loads((base / "show-manifest.json").read_text()); modern_values = json.loads((base / "modern-genre-values.json").read_text())
    url, user, password = (os.environ.get(k, "") for k in ("NAVIDROME_URL", "NAVIDROME_USER", "NAVIDROME_PASS"))
    if not all((url, user, password)): raise SystemExit("missing Navidrome environment")
    _, login = call(url.rstrip("/") + "/auth/login", "POST", {"username": user, "password": password})
    if not login.get("token") or login.get("isAdmin") is not True: raise SystemExit("Navidrome login/admin guard failed")
    headers = {"X-ND-Authorization": "Bearer " + login["token"]}
    salt = secrets.token_hex(8)
    token = hashlib.md5((password + salt).encode()).hexdigest()
    _, ping = call(url.rstrip("/") + "/rest/ping.view?" + urlencode({"u":user,"t":token,"s":salt,"v":"1.16.1","c":"the-lab-sync","f":"json"}))
    response = ping.get("subsonic-response", {})
    version = response.get("serverVersion")
    if version != EXPECTED: raise SystemExit(f"contract drift: {version!r}")
    salt = secrets.token_hex(8); token = hashlib.md5((password + salt).encode()).hexdigest()
    _, genres_response = call(url.rstrip("/") + "/rest/getGenres.view?" + urlencode({"u":user,"t":token,"s":salt,"v":"1.16.1","c":"the-lab-sync","f":"json"}))
    live_genres = [x["value"] for x in genres_response.get("subsonic-response", {}).get("genres", {}).get("genre", []) if x.get("value")]
    _, playlists = call(url.rstrip("/") + "/api/playlist", headers=headers)
    existing = {p["name"]: p for p in playlists}
    plans = []
    for show in manifest["shows"]:
        if show["runtime"]["binding"] in STRUCTURAL: continue
        name = "The Lab — " + show["name"]
        if any(not modern_values.get(canonical) for canonical in show["genres"]): raise SystemExit(f"modern tag variant missing for {name}")
        resolved = [value for canonical in show["genres"] for value in modern_values[canonical]]
        rules = {"all": [{"any": [{"is": {"genre": g}} for g in dict.fromkeys(resolved)]}]}
        drift = {canonical: resolve_all(canonical, live_genres) for canonical in show["genres"] if set(resolve_all(canonical, live_genres)) != set(modern_values[canonical])}
        current = existing.get(name)
        if current and current.get("ownerName") != "radio": raise SystemExit(f"refusing non-radio playlist: {name}")
        if current: require_evaluated(current)
        same = current and current.get("public") is True and current.get("rules") == rules
        plans.append({"name": name, "action": "noop" if same else ("update" if current else "create"), "rules": rules, "subsonic_surface_drift": drift})
        if args.apply:
            if same: continue
            body = {"name": name, "comment": "The Lab / Show Manifest R3", "public": True, "rules": rules}
            if current: call(url.rstrip("/") + "/api/playlist/" + current["id"], "PUT", body, headers)
            else: call(url.rstrip("/") + "/api/playlist", "POST", body, headers)
    print(json.dumps({"mode": "apply" if args.apply else "check", "contract": EXPECTED, "plans": plans}, ensure_ascii=False, indent=2))

if __name__ == "__main__":
    main()
