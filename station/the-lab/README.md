# The Lab Native Smart Crates

This station pack projects the frozen show manifest onto Navidrome native smart
playlists. It is dry-run by default; pass `--apply` to mutate playlists.

The tool requires `NAVIDROME_URL`, `NAVIDROME_USER`, and `NAVIDROME_PASS`, and
refuses Navidrome versions other than `0.63.2 (be10f89c)`. It uses
`modern-genre-values.json` as the explicit modern multi-value tag inventory and
reports Subsonic surface drift instead of silently substituting it. It never
writes `.nsp` files and excludes structural shows.

Usage:

```sh
python native-smart-crate-sync.py --check
python native-smart-crate-sync.py --apply
```
