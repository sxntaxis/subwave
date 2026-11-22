'use client';

// A compact operator surface for the station's *actual* durable direction.
// Read-only polling never invokes the DJ or a pick. All writes use the existing
// admin credential, validated by the controller's /dj/steer route.
import { useEffect, useState } from 'react';
import { useAdminAuth } from '../../../lib/adminAuth';
import { useAdminQuery, useAdminMutation } from '../../../lib/admin-query';
import { errorMessage, notify } from '../../../lib/notify';
import { Card, Btn, Pill } from '../ui';

type Movement = {
  movement: string; destination: string; next: string; energy: string | null;
  startedAt: string; expiresAt: string; plannedBy?: 'director-v3';
  lastDecision?: { decision: 'seed' | 'continue' | 'resolve' | 'reroute'; at: string;
    starts: number; reason: string };
  progress?: { starts: number; elapsedMinutes: number; phase: string;
    distinctArtists: number; alternate: string | null };
};
type Steering = { kind: string; intent: string; scope: string;
  expiresAt: string | null; remainingStarts: number | null; source: string };
type DirectionEnvelope = {
  enabled: boolean; directorV2?: boolean; directorV3?: boolean; show: string | null;
  showPhase: { phase: string; minutesRemaining: number | null } | null;
  trajectoryV1?: boolean;
  acousticObservation?: { status: 'measured' | 'insufficient' | 'unavailable' | 'not_measured' | 'stale';
    verifiedStarts: number; observedAt: string | null; note: string;
    measured: { status: 'measured' | 'insufficient'; observed: number; missing: number;
      arousal: { change: number; alignment: string } | null } | null } | null;
  measuredTrajectory?: { status: 'measured' | 'insufficient'; observed: number; missing: number;
    arousal: { change: number; alignment: string } | null; note: string; observedAt?: string } | null;
  direction: { revision: number; steering: Steering | null; movement: Movement | null;
    replanDue: boolean; memory?: { showStarts: number; distinctArtists: number; taggedEnergyTrend: string | null; artistConcentration: string | null;
      recentMovements: { movement: string; outcome: string; followOn?: string; reason?: string }[] } } | null;
};
const KINDS = ['pivot', 'hold', 'lift', 'release'] as const;
const SCOPES = ['current-show', 'fixed-duration', 'station'] as const;

export function MusicalDirectionCard() {
  const { adminFetch, hydrated, needsAuth } = useAdminAuth();
  const [kind, setKind] = useState<(typeof KINDS)[number]>('pivot');
  const [scope, setScope] = useState<(typeof SCOPES)[number]>('current-show');
  const [intent, setIntent] = useState('');
  const [minutes, setMinutes] = useState(40);
  const [following, setFollowing] = useState(8);
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 10_000);
    return () => window.clearInterval(timer);
  }, []);
  const [busy, setBusy] = useState(false);
  const [clearArmed, setClearArmed] = useState(false);
  const key = ['dash', 'musical-direction'];
  const query = useAdminQuery<DirectionEnvelope>({
    key, adminFetch, enabled: hydrated && !needsAuth, staleTime: 0,
    refetchInterval: () => 12_000,
    request: async (fetcher, signal) => {
      const r = await fetcher('/dj/steer', { signal });
      if (!r.ok) throw new Error(`director status (${r.status})`);
      return r.json() as Promise<DirectionEnvelope>;
    },
  });
  const data = query.data;
  const movement = data?.direction?.movement;
  const steering = data?.direction?.steering;
  const enabled = !!data?.enabled;
  const startMs = movement ? Date.parse(movement.startedAt) : NaN;
  const endMs = movement ? Date.parse(movement.expiresAt) : NaN;
  const movementClock = now !== null && Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs
    ? { total: Math.round((endMs - startMs) / 60_000),
      elapsed: Math.max(0, Math.min((endMs - startMs) / 60_000, (now - startMs) / 60_000)),
      remaining: Math.max(0, (endMs - Math.max(now, startMs)) / 60_000),
      percent: Math.max(0, Math.min(100, (now - startMs) / (endMs - startMs) * 100)) }
    : null;
  const mutation = useAdminMutation<unknown, { clear: boolean; kind: string; scope: string;
    intent: string; durationMinutes: number; followingTracks: number }>({
    adminFetch, toastOnError: false,
    request: async (vars, fetcher) => {
      const r = await fetcher('/dj/steer', vars.clear
        ? { method: 'DELETE' }
        : { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ kind: vars.kind, scope: vars.scope, intent: vars.intent,
            durationMinutes: vars.durationMinutes, followingTracks: vars.followingTracks }) });
      const result = await r.json().catch(() => ({})) as { error?: string };
      if (!r.ok) throw new Error(result.error || `director write (${r.status})`);
      return result;
    },
    onDone: (_data, _vars, client) => client.invalidateQueries({ queryKey: ['dash', 'musical-direction'] }),
  });
  const save = async (clear: boolean) => {
    if (!enabled || busy || (!clear && !intent.trim())) return;
    setBusy(true);
    try {
      await mutation.mutateAsync({ clear, kind, scope, intent: intent.trim(),
        durationMinutes: minutes, followingTracks: following });
      if (!clear) setIntent('');
      setClearArmed(false);
      notify.ok(clear ? 'musical direction cleared' : 'musical guidance updated');

    } catch (e) { notify.err(`musical direction: ${errorMessage(e)}`); }
    finally { setBusy(false); }
  };

  return <Card title="Musical direction" sub={data?.directorV3 ? 'independent editorial director · live state'
    : data?.directorV2 ? 'adaptive director · live state' : 'current arc · owner steering'}>
    {query.isError ? <p className="text-[12px] text-muted">Unable to read direction: {errorMessage(query.error)}</p>
      : !data ? <p className="text-[12px] text-muted">Reading station direction…</p>
      : !enabled ? <p className="text-[12px] text-muted">Direction is disabled in the controller.</p>
      : <div className="grid gap-3 text-[12px]">
        <div className="flex flex-wrap items-center gap-1.5">
          <Pill tone={movement ? 'accent' : 'default'}>{movement ? 'movement active' : 'awaiting movement'}</Pill>
          <Pill>{data.show || 'default programming'}</Pill>
          {data.showPhase?.phase && <Pill>{data.showPhase.phase}</Pill>}
          {data.showPhase?.minutesRemaining != null && <Pill>{data.showPhase.minutesRemaining}m until show change</Pill>}
        </div>
        {steering && <div className="border-l-2 border-vermilion pl-2.5">
          <div className="mb-1 text-[10px] font-bold tracking-wide text-vermilion uppercase">
            {steering.source} · {steering.kind} · {steering.scope}
          </div>
          <p className="wrap-break-word">{steering.intent}</p>
          <div className="text-[10px] text-muted">
            {steering.remainingStarts != null ? `${steering.remainingStarts} subsequent starts left` : 'until cleared'}
          </div>
        </div>}
        {movement ? <div className="grid gap-1 border border-separator-strong p-2.5">
          <strong className="text-[13px]">{movement.movement}</strong>
          <div className="flex flex-wrap items-center gap-1.5 text-[10px] uppercase tracking-wide">
            <Pill>Energy intention · {movement.energy || 'open'}</Pill>
            {movement.lastDecision && <Pill>Last decision · {movement.lastDecision.decision === 'seed' ? 'seeded'
              : movement.lastDecision.decision}</Pill>}
          </div>
          {movementClock && <div className="grid gap-1 pt-2">
            <div className="flex items-center justify-between text-[10px] text-muted">
              <span>Movement elapsed time</span>
              <span className="tabular-nums">{Math.floor(movementClock.elapsed)} / {movementClock.total} min</span>
            </div>
            <div className="h-1.5 w-full overflow-hidden bg-separator-strong" role="progressbar"
              aria-label="Movement elapsed time" aria-valuemin={0} aria-valuemax={100}
              aria-valuenow={Math.round(movementClock.percent)}>
              <div className="h-full bg-vermilion transition-[width] duration-500"
                style={{ width: `${movementClock.percent}%` }} />
            </div>
            <div className="flex justify-between text-[10px] text-muted">
              <span>Started {Math.floor(movementClock.elapsed)}m ago</span>
              <span>{Math.ceil(movementClock.remaining)}m remaining</span>
            </div>
            <p className="text-[10px] text-muted">Elapsed time only · not musical destination completion</p>
          </div>}
          {movement.lastDecision?.reason && <p className="text-[11px] text-muted">
            Director decision: {movement.lastDecision.reason}
          </p>}
          <div className="text-muted">Toward: <span className="text-ink">{movement.destination}</span></div>
          <div className="text-muted">Next: <span className="text-ink">{movement.next}</span></div>
          {movement.progress && <div className="text-[10px] text-muted">
            {movement.progress.phase} · {movement.progress.starts} verified starts · {movement.progress.elapsedMinutes}m elapsed
            · {movement.progress.distinctArtists} artists
          </div>}
          {movement.progress?.alternate && <div className="text-[10px] text-muted">
            Alternative path: {movement.progress.alternate}
          </div>}
        </div> : <p className="text-muted italic">
          {steering ? 'Human steering is active; no autonomous movement supersedes it.'
            : data.directorV3 ? 'The independent Director will seed a movement after verified playback; nothing is forced.'
              : 'Next successful Agent pick may propose an arc. Nothing is forced.'}
        </p>}
        {data.directorV3 && data.trajectoryV1 && <div className="border border-separator-strong p-2.5 text-[10px] text-muted">
          <strong className="text-ink">Verified acoustic trajectory</strong>
          {data.acousticObservation?.status === 'measured' && data.acousticObservation.measured?.arousal
            ? <p>{data.acousticObservation.measured.observed} complete-window observations · arousal
              {' '}{data.acousticObservation.measured.arousal.alignment}
              {' ('}{data.acousticObservation.measured.arousal.change > 0 ? '+' : ''}
              {data.acousticObservation.measured.arousal.change.toFixed(3)}{')'}</p>
            : <p>{data.acousticObservation?.status === 'stale' ? 'Previous measurement is stale; new airplay awaits analysis.'
              : data.acousticObservation?.status === 'unavailable' ? 'Acoustic analysis unavailable.'
                : data.acousticObservation?.status === 'insufficient' ? 'Fewer than three complete acoustic observations.'
                  : 'Acoustic measurement has not yet been attempted for this movement.'}</p>}
          {data.acousticObservation && <p>{data.acousticObservation.verifiedStarts} verified starts in measurement scope
            {data.acousticObservation.observedAt ? ` · last checked ${new Date(data.acousticObservation.observedAt).toLocaleTimeString()}` : ''}</p>}
          <p>{data.acousticObservation?.note}</p>
          <p>Model estimates only · not a quality rating or a completed movement.</p>
        </div>}
        {!data.directorV3 && data.trajectoryV1 && <div className="border border-separator-strong p-2.5 text-[10px] text-muted">
          <strong className="text-ink">Verified acoustic trajectory</strong>
          {data.measuredTrajectory?.status === 'measured' && data.measuredTrajectory.arousal
            ? <p>{data.measuredTrajectory.observed} complete-window observations · arousal {data.measuredTrajectory.arousal.alignment}
              {' ('}{data.measuredTrajectory.arousal.change > 0 ? '+' : ''}{data.measuredTrajectory.arousal.change.toFixed(3)}{')'}</p>
            : <p>Insufficient complete acoustic history; no destination score is inferred.</p>}
          <p>Model estimates only · not a quality rating or a completed movement.</p>
        </div>}
        {data.direction?.memory && <div className="text-[10px] text-muted">
          {data.direction.memory.showStarts} verified recent starts in this show · {data.direction.memory.distinctArtists} distinct artists
          {data.direction.memory.taggedEnergyTrend && <span> · catalogued energy: {data.direction.memory.taggedEnergyTrend}</span>}
          {data.direction.memory.artistConcentration && <span> · artists: {data.direction.memory.artistConcentration}</span>}
          {data.direction.memory.recentMovements[0] && <span> · last arc: {data.direction.memory.recentMovements[0].outcome}</span>}
          {data.direction.memory.recentMovements[0]?.followOn && <div>Last arc handoff: {data.direction.memory.recentMovements[0].followOn}</div>}
          {data.direction.memory.recentMovements[0]?.reason && <div>Last decision: {data.direction.memory.recentMovements[0].reason}</div>}
        </div>}
        <div className="grid gap-2 border-t border-separator-strong pt-3">
          <label className="text-[10px] font-bold tracking-wide uppercase" htmlFor="music-direction-intent">Operator guidance</label>
          <textarea id="music-direction-intent" value={intent} maxLength={180} rows={2}
            onChange={e => setIntent(e.target.value)} placeholder="e.g. Explore rhythmic textures, then gradually open into brighter material"
            className="w-full resize-y border border-separator-strong bg-transparent p-2 text-ink" />
          <div className="grid grid-cols-2 gap-2">
            <label className="grid gap-1 text-[10px] text-muted">Action
              <select value={kind} onChange={e => setKind(e.target.value as typeof kind)} className="min-w-0 border border-separator-strong bg-[var(--card-bg)] p-1.5 text-ink">
                {KINDS.map(k => <option key={k} value={k}>{k}</option>)}
              </select>
            </label>
            <label className="grid gap-1 text-[10px] text-muted">Scope
              <select value={scope} onChange={e => setScope(e.target.value as typeof scope)} className="min-w-0 border border-separator-strong bg-[var(--card-bg)] p-1.5 text-ink">
                {SCOPES.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </label>
            {scope !== 'station' && <>
              <label className="grid gap-1 text-[10px] text-muted">Minutes
                <input type="number" min={1} max={180} value={minutes} onChange={e => setMinutes(Math.min(180, Math.max(1, Number(e.target.value) || 1)))}
                  className="min-w-0 border border-separator-strong bg-transparent p-1.5 text-ink" />
              </label>
              <label className="grid gap-1 text-[10px] text-muted">Following tracks
                <input type="number" min={1} max={24} value={following} onChange={e => setFollowing(Math.min(24, Math.max(1, Number(e.target.value) || 1)))}
                  className="min-w-0 border border-separator-strong bg-transparent p-1.5 text-ink" />
              </label>
            </>}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Btn sm disabled={busy || !intent.trim()} onClick={() => void save(false)}>Guide arc</Btn>
            {clearArmed ? <>
              <Btn sm tone="danger" disabled={busy} onClick={() => void save(true)}>Confirm clear</Btn>
              <Btn sm disabled={busy} onClick={() => setClearArmed(false)}>Cancel</Btn>
            </> : <Btn sm disabled={busy || (!steering && !movement)} onClick={() => setClearArmed(true)}>Clear</Btn>}
          </div>
          <p className="text-[10px] text-muted">Guidance changes future selections; it never cuts the on-air track or bypasses show restrictions.</p>
        </div>
      </div>}
  </Card>;
}
