// Pure interpretation of a bounded Essentia evidence record. These are model
// outputs, not editorial tags or calibrated probabilities.
export interface EssentiaEvidence {
  arousal?: number;
  valence?: number;
  danceable?: number;
  voice?: number;
  bright?: number;
  moods?: Record<string, number>;
  instruments?: Record<string, number>;
}

export interface TraitPreferences {
  arousal?: 'low' | 'high';
  valence?: 'low' | 'high';
  danceability?: 'low' | 'high';
  voice?: 'voice' | 'instrumental';
  timbre?: 'bright' | 'dark';
  mood?: string;
  instrument?: string;
}

function valid(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

// A mean over only requested, actually available dimensions. Missing evidence
// is unknown rather than zero; no dimensions means the record is not a match.
export function traitScore(e: EssentiaEvidence, p: TraitPreferences): number | null {
  const values: number[] = [];
  const add = (value: unknown, min: number, max: number, invert: boolean) => {
    if (!valid(value, min, max)) return;
    const unit = (value - min) / (max - min);
    values.push(invert ? 1 - unit : unit);
  };
  if (p.arousal) add(e.arousal, 1, 9, p.arousal === 'low');
  if (p.valence) add(e.valence, 1, 9, p.valence === 'low');
  if (p.danceability) add(e.danceable, 0, 1, p.danceability === 'low');
  if (p.voice) add(e.voice, 0, 1, p.voice === 'instrumental');
  if (p.timbre) add(e.bright, 0, 1, p.timbre === 'dark');
  if (p.mood) add(e.moods?.[p.mood], 0, 1, false);
  if (p.instrument) add(e.instruments?.[p.instrument], 0, 1, false);
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

export interface AudioProfile {
  source: 'essentia_estimate';
  arousal_1_9?: number;
  valence_1_9?: number;
  danceable_score?: number;
  voice_score?: number;
  bright_timbre_score?: number;
  mood_model_top?: { label: string; score: number };
  instrument_model_top?: { label: string; score: number };
}

// Native model scores rather than invented categorical assertions. Round for a
// compact prompt and omit invalid/missing heads instead of supplying zero.
export function audioProfile(e: EssentiaEvidence): AudioProfile | null {
  const profile: AudioProfile = { source: 'essentia_estimate' };
  if (valid(e.arousal, 1, 9)) profile.arousal_1_9 = Math.round(e.arousal * 10) / 10;
  if (valid(e.valence, 1, 9)) profile.valence_1_9 = Math.round(e.valence * 10) / 10;
  if (valid(e.danceable, 0, 1)) profile.danceable_score = Math.round(e.danceable * 100) / 100;
  if (valid(e.voice, 0, 1)) profile.voice_score = Math.round(e.voice * 100) / 100;
  if (valid(e.bright, 0, 1)) profile.bright_timbre_score = Math.round(e.bright * 100) / 100;
  const top = (values: Record<string, number> | undefined) => {
    const entries = Object.entries(values ?? {})
      .filter(([label, value]) => /^[a-z]{1,32}$/.test(label) && valid(value, 0, 1))
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    return entries.length ? { label: entries[0][0], score: Math.round(entries[0][1] * 100) / 100 } : undefined;
  };
  const mood = top(e.moods);
  const instrument = top(e.instruments);
  if (mood) profile.mood_model_top = mood;
  if (instrument) profile.instrument_model_top = instrument;
  return Object.keys(profile).length > 1 ? profile : null;
}
