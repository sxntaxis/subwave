// Read-only, bounded playlist examples for director context. No eligibility
// decisions: playlist union membership != a playable track at the next seam.
export function getPlaylistMusicFacts(
  tracks: readonly any[], lookup: (id: string) => any,
): Array<{ title: string; artist: string | null; genre?: string; energy?: string;
  bpm?: number; key?: string }> {
  return tracks.slice(0, 8).filter(t => t && typeof t.id === 'string').map(t => {
    let row: any = null;
    try { row = lookup(t.id); } catch { /* optional metadata */ }
    const title = String(t.title ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 100);
    const artist = typeof t.artist === 'string' ? t.artist.slice(0, 100) : null;
    return { title, artist,
      ...(typeof row?.genre === 'string' ? { genre: row.genre.slice(0, 80) } : {}),
      ...(row?.energy === 'low' || row?.energy === 'medium' || row?.energy === 'high' ? { energy: row.energy } : {}),
      ...(Number.isFinite(row?.bpm) && row.bpm > 0 ? { bpm: row.bpm } : {}),
      ...(typeof row?.musicalKey === 'string' ? { key: row.musicalKey.slice(0, 12) } : {}),
    };
  }).filter(t => t.title);
}

/** A controlled catalogue sample for shows without pinned playlists. This is
 * neither exhaustive search nor a set of guaranteed future picks. The real
 * picker still applies all hard locks, recency and airtime constraints. */
export function sampledShowMusic(show: any, library: {
  songsByMood: (mood: string) => any[];
  songsByEnergy: (energy: string) => any[];
  getPlaybackMeta: (id: string) => any;
}, cap = 8) {
  if (!show) return { origin: 'none', sample: [], scanned: 0 };
  const songs: any[] = [];
  const seen = new Set<string>();
  const append = (items: any[]) => {
    for (const track of items.slice(0, 48)) {
      if (!track?.id || seen.has(track.id)) continue;
      seen.add(track.id);
      songs.push(track);
      if (songs.length >= 64) return;
    }
  };
  for (const mood of (show.moods ?? []).slice(0, 2)) {
    if (songs.length >= 64) break;
    try { append(library.songsByMood(mood)); } catch { /* unavailable sample */ }
  }
  for (const energy of (show.energies ?? []).slice(0, 2)) {
    if (songs.length >= 64) break;
    try { append(library.songsByEnergy(energy)); } catch { /* unavailable sample */ }
  }
  // No extrapolation from an empty or incomplete sample. Full show eligibility
  // remains controlled by the existing picker, not this read-only briefing.
  return { origin: 'mood_energy_library_sample', scanned: songs.length,
    sample: getPlaylistMusicFacts(songs.slice(0, cap), library.getPlaybackMeta) };
}
