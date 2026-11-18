// Single aggregate definition for maintenance and the read-only stats worker.
export function computeLibraryStats(d, hasMoods) {
  const total = d.prepare(`SELECT COUNT(*) AS n FROM tracks WHERE ${hasMoods}`).get().n;
  const mirrorTotal = d.prepare('SELECT COUNT(*) AS n FROM tracks').get().n;
  const distinctArtists = d.prepare(`SELECT COUNT(DISTINCT LOWER(TRIM(artist))) AS n
    FROM tracks WHERE ${hasMoods} AND artist IS NOT NULL AND TRIM(artist) != ''`).get().n;
  const byMood = {};
  for (const r of d.prepare(`SELECT value AS mood, COUNT(*) AS n FROM tracks, json_each(tracks.moods)
    WHERE tracks.moods IS NOT NULL GROUP BY value`).all()) byMood[r.mood] = r.n;
  const byEnergy = {};
  for (const r of d.prepare('SELECT energy, COUNT(*) AS n FROM tracks WHERE energy IS NOT NULL GROUP BY energy').all()) byEnergy[r.energy] = r.n;
  const byGenre = {};
  for (const r of d.prepare(`SELECT value AS genre, COUNT(*) AS n FROM tracks, json_each(tracks.genres)
    WHERE tracks.genres IS NOT NULL GROUP BY value`).all()) byGenre[r.genre] = r.n;
  const bySource = {};
  for (const r of d.prepare('SELECT source, COUNT(*) AS n FROM tracks WHERE source IS NOT NULL GROUP BY source').all()) bySource[r.source] = r.n;
  const withEmbedding = d.prepare('SELECT COUNT(*) AS n FROM track_vectors').get().n;
  const withAudioEmbedding = d.prepare('SELECT COUNT(*) AS n FROM track_audio_vectors').get().n;
  const updatedAt = d.prepare('SELECT MAX(tagged_at) AS t FROM tracks').get().t || null;
  return { total, mirrorTotal, distinctArtists, byMood, byEnergy, byGenre, bySource,
    withEmbedding, withAudioEmbedding, updatedAt };
}
