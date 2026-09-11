import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as showCandidates from '../src/music/show-candidates.js';
import { applyStrictLocks } from '../src/music/show-filter.js';

const { buildShowCandidateDiagnostic } = showCandidates;

const rows = [
  { id: 'jazz-calm', title: 'One', artist: 'A', genre: 'Jazz', year: 1994, moods: ['calm'], audioMoods: [], energy: 'low' },
  { id: 'jazz-loud', title: 'Two', artist: 'B', genre: 'Jazz', year: 1994, moods: ['calm'], audioMoods: [], energy: 'high' },
  { id: 'rock-calm', title: 'Three', artist: 'C', genre: 'Rock', year: 1994, moods: ['calm'], audioMoods: [], energy: 'low' },
  { id: 'jazz-calm-2', title: 'Four', artist: 'D', genre: 'Jazz', year: 1994, moods: ['calm'], audioMoods: [], energy: 'low' },
];
const locks = { genres: ['Jazz'], eras: [], moods: ['calm'], energies: ['low'], vocals: null };

test('candidate funnel shows the strict playlist intersection and exclusions', () => {
  const result = buildShowCandidateDiagnostic({
    show: { filtersStrict: true, genres: ['Jazz'], playlistStrict: true },
    libraryRows: rows,
    playlistRows: [rows[0]!, rows[1]!],
    excludedIds: new Set(['jazz-calm']),
    locks,
  });
  assert.equal(result.strict, true);
  assert.deepEqual(result.library, { indexed: 4, matchingFilters: 2, afterExclusions: 1, effective: 0 });
  assert.deepEqual(result.playlist, { total: 2, matchingFilters: 1, afterExclusions: 0, effective: 0 });
});

test('resolved strict playlist is authoritative for genre but not other locks', () => {
  const playlist = [
    { id: 'mariachi', genre: 'Mariachi', year: 1994, moods: ['calm'], energy: 'low' },
    { id: 'old-mariachi', genre: 'Mariachi', year: 1980, moods: ['calm'], energy: 'low' },
  ];
  const result = buildShowCandidateDiagnostic({
    show: { filtersStrict: true, genres: ['Mariachi'], playlistStrict: true },
    libraryRows: playlist,
    playlistRows: playlist,
    excludedIds: null,
    locks: { genres: ['Ranchera'], eras: [{ fromYear: 1990 }], moods: ['calm'], energies: ['low'], vocals: null },
  });
  assert.deepEqual(result.playlist, { total: 2, matchingFilters: 1, afterExclusions: 1, effective: 1 });
});

test('strict-lock authority skips only genre filtering for a resolved crate', () => {
  const tracks = [
    { id: 'crate-mariachi', genre: 'Mariachi', year: 2020, moods: ['calm'], energy: 'low' },
    { id: 'crate-old', genre: 'Mariachi', year: 1980, moods: ['calm'], energy: 'low' },
  ];
  const result = applyStrictLocks(tracks, {
    genres: ['Ranchera'], eras: [{ fromYear: 1990 }], moods: ['calm'], energies: ['low'], vocals: null,
  }, { starve: true, skipGenres: true });
  assert.deepEqual(result.map((track) => track.id), ['crate-mariachi']);
});

test('missing strict playlist keeps native strict fallback bounded', () => {
  const result = buildShowCandidateDiagnostic({
    show: { filtersStrict: true, genres: ['Jazz'], playlistStrict: true },
    libraryRows: rows,
    playlistRows: null,
    excludedIds: null,
    locks,
  });
  assert.equal(result.library.effective, 2);
  assert.equal(result.playlist, null);
});

test('missing playlist with non-strict filters remains the broad control', () => {
  const result = buildShowCandidateDiagnostic({
    show: { filtersStrict: false, genres: ['Jazz'], playlistStrict: true },
    libraryRows: rows,
    playlistRows: null,
    excludedIds: null,
    locks,
  });
  assert.equal(result.library.effective, 4);
});

test('soft filters remain advisory while the filter-fit count stays visible', () => {
  const result = buildShowCandidateDiagnostic({
    show: { filtersStrict: false, genres: ['Jazz'], playlistStrict: false },
    libraryRows: rows,
    playlistRows: [rows[0]!, rows[1]!],
    excludedIds: new Set(['rock-calm']),
    locks,
  });
  assert.equal(result.library.matchingFilters, 2);
  assert.equal(result.library.effective, 3);
  assert.equal(result.playlist?.effective, 2);
});

test('candidate coverage includes audio-derived moods and preserves vocal tri-state', () => {
  const coverage = showCandidates.candidateCoverage([
    { id: 'audio-calm', moods: [], audioMoods: ['calm'], energy: null, vocalRanges: null },
    { id: 'sung', moods: [], audioMoods: [], energy: 'medium', vocalRanges: [{ startMs: 1_000, endMs: 9_000 }] },
  ]);

  assert.deepEqual(coverage, { mood: true, energy: true, vocal: true });
});
