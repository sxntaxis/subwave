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
  expiresAt: string | null; remainingStarts: number | null; source: string;
  listenerExpression?: string;
  listenerReading?: { interpretation: string; next: string; energy: string | null;
    reason: string; at: string };
};
type DirectionEnvelope = {
  enabled: boolean; directorV2?: boolean; directorV3?: boolean; show: string | null;
  showPhase: { phase: string; minutesRemaining: number | null } | null;
  trajectoryV1?: boolean;
  acousticObservation?: { status: 'measured' | 'insufficient' | 'unavailable' | 'not_measured' | 'stale';
    verifiedStarts: number; observedAt: string | null; note: string;
    measured: { status: 'measured' | 'insufficient'; observed: number; missing: number;
      arousal: { change: number; alignment: string } | null;
      valenceChange: number | null; danceabilityChange: number | null } | null } | null;
  measuredTrajectory?: { status: 'measured' | 'insufficient'; observed: number; missing: number;
    arousal: { change: number; alignment: string } | null;
    valenceChange: number | null; danceabilityChange: number | null;
    note: string; observedAt?: string } | null;
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

  const acoustic = data?.directorV3 ? data.acousticObservation?.measured : data?.measuredTrajectory;
  const acousticState = data?.directorV3
    ? data.acousticObservation?.status ?? 'not_measured'
    : acoustic?.status ?? 'not_measured';
  const checked = data?.acousticObservation?.observedAt
    || data?.measuredTrajectory?.observedAt;
  const checkedTime = checked && Number.isFinite(Date.parse(checked))
    ? new Date(checked).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : null;
  const signed = (value: number | null | undefined) => value == null || !Number.isFinite(value)
    ? '—' : `${value > 0 ? '+' : ''}${value.toFixed(3)}`;
  const latestArc = data?.direction?.memory?.recentMovements?.[0];
  const steerReading = steering?.source === 'listener' ? steering.listenerReading : null;
  const expires = now !== null && steering?.expiresAt && Number.isFinite(Date.parse(steering.expiresAt))
    ? Math.max(0, Math.ceil((Date.parse(steering.expiresAt) - now) / 60_000)) : null;

  return <Card title="Musical direction" sub={data?.directorV3 ? 'director / live' : 'live'}>
    {query.isError ? <p className="text-[12px] text-muted">Unable to read direction: {errorMessage(query.error)}</p>
      : !data ? <p className="text-[12px] text-muted">Loading direction…</p>
      : !enabled ? <p className="text-[12px] text-muted">Direction disabled</p>
      : <div className="grid min-w-0 gap-3 text-[12px]">
        <div className="flex flex-wrap items-center gap-1.5">
          <Pill tone={steering ? 'accent' : movement ? 'accent' : 'default'}>
            {steering ? `${steering.source} steer` : movement ? 'movement active' : 'no active movement'}
          </Pill>
          <Pill>{data.show || 'default programming'}</Pill>
          {data.showPhase?.phase && <Pill>{data.showPhase.phase}</Pill>}
          {data.showPhase?.minutesRemaining != null && <Pill>{data.showPhase.minutesRemaining}m to handoff</Pill>}
        </div>

        {steering && <section className="grid gap-2 border-l-2 border-vermilion pl-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-[10px] font-bold tracking-wider text-vermilion uppercase">
              {steering.source === 'listener' ? 'Listener cue' : `Operator · ${steering.kind}`}
            </span>
            <span className="text-[10px] text-muted tabular-nums">
              {steering.remainingStarts != null ? `${steering.remainingStarts} starts left` : steering.scope}
              {expires != null ? ` · ${expires}m left` : ''}
            </span>
          </div>
          <p className="font-medium wrap-break-word text-ink">{steering.listenerExpression || steering.intent}</p>
          {steerReading ? <div className="grid gap-1.5 border-t border-separator-strong pt-2">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[10px] font-bold tracking-wider text-muted uppercase">Director reading</span>
              {steerReading.energy && <Pill>{steerReading.energy}</Pill>}
            </div>
            <p className="wrap-break-word text-ink">{steerReading.interpretation}</p>
            <p><span className="text-muted">Next · </span>{steerReading.next}</p>
            <p className="text-[11px] text-muted">{steerReading.reason}</p>
          </div> : steering.source === 'listener' && data.directorV3
            ? <span className="text-[10px] text-muted">Director reading · pending</span> : null}
        </section>}

        {movement && !steering && <section className="grid gap-2 border border-separator-strong p-2.5">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <strong className="text-[13px] leading-snug wrap-break-word text-ink">{movement.movement}</strong>
            {movement.lastDecision && <Pill tone="accent">{movement.lastDecision.decision}</Pill>}
          </div>
          <div className="flex flex-wrap items-center gap-1.5 text-[10px]">
            <Pill>Energy · {movement.energy || 'open'}</Pill>
            {movement.progress?.phase && <Pill>{movement.progress.phase}</Pill>}
          </div>
          {movementClock && <div className="grid gap-1">
            <div className="flex items-center justify-between text-[10px] text-muted">
              <span>Movement time</span>
              <span className="tabular-nums">{Math.floor(movementClock.elapsed)} / {movementClock.total}m</span>
            </div>
            <progress className="h-1.5 w-full accent-vermilion" aria-label="Elapsed movement time"
              max={100} value={Math.round(movementClock.percent)} />
          </div>}
          <div className="grid grid-cols-3 gap-1.5 border-y border-separator-strong py-2">
            <div><div className="text-[10px] text-muted">Remaining</div><strong className="tabular-nums">{movementClock ? `${Math.ceil(movementClock.remaining)}m` : '—'}</strong></div>
            <div><div className="text-[10px] text-muted">Starts</div><strong className="tabular-nums">{movement.progress?.starts ?? '—'}</strong></div>
            <div><div className="text-[10px] text-muted">Artists</div><strong className="tabular-nums">{movement.progress?.distinctArtists ?? '—'}</strong></div>
          </div>
          <div className="grid gap-1">
            <div><span className="text-muted">Toward · </span><span className="text-ink">{movement.destination}</span></div>
            <div><span className="text-muted">Next · </span><span className="text-ink">{movement.next}</span></div>
            {movement.progress?.alternate && <div><span className="text-muted">Alternate · </span>{movement.progress.alternate}</div>}
            {movement.lastDecision?.reason && <div className="min-w-0 pt-1 text-[11px] [overflow-wrap:anywhere] text-muted">
              <span className="font-semibold">Decision evidence · </span>{movement.lastDecision.reason}
            </div>}
          </div>
        </section>}

        {!movement && !steering && latestArc && <section className="grid gap-1 border border-separator-strong p-2.5">
          <div className="text-[10px] font-bold tracking-wide text-muted uppercase">Last movement · {latestArc.outcome}</div>
          <div className="font-medium">{latestArc.movement}</div>
          {latestArc.followOn && <div><span className="text-muted">Handoff · </span>{latestArc.followOn}</div>}
        </section>}

        {movement && !steering && data.trajectoryV1 && <section className="grid gap-2 border border-separator-strong p-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-[10px] font-bold tracking-wider uppercase">Acoustic trajectory</span>
            <Pill tone={acousticState === 'measured' ? 'accent' : 'default'}>{acousticState.replace(/_/g, ' ')}</Pill>
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted">
            <span>{data.acousticObservation?.verifiedStarts ?? movement.progress?.starts ?? '—'} verified starts</span>
            {acoustic && <span>{acoustic.observed} measured · {acoustic.missing} missing</span>}
            {checkedTime && <span>Checked {checkedTime}</span>}
          </div>
          {acoustic?.status === 'measured' && <div className="grid grid-cols-3 gap-1.5">
            <div className="border-r border-separator-strong pr-1">
              <div className="text-[10px] text-muted">Arousal Δ</div>
              <div className="font-semibold tabular-nums">{signed(acoustic.arousal?.change)}</div>
              <div className="text-[10px] text-muted">{acoustic.arousal?.alignment || '—'}</div>
            </div>
            <div className="border-r border-separator-strong pr-1">
              <div className="text-[10px] text-muted">Valence Δ</div>
              <div className="font-semibold tabular-nums">{signed(acoustic.valenceChange)}</div>
            </div>
            <div>
              <div className="text-[10px] text-muted">Danceability Δ</div>
              <div className="font-semibold tabular-nums">{signed(acoustic.danceabilityChange)}</div>
            </div>
          </div>}
        </section>}

        {data.direction?.memory && <div className="flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-muted">
          <span>{data.direction.memory.showStarts} recent show starts</span>
          <span>{data.direction.memory.distinctArtists} artists</span>
          {data.direction.memory.taggedEnergyTrend && <span>Energy tags · {data.direction.memory.taggedEnergyTrend}</span>}
          {data.direction.memory.artistConcentration && <span>Artist mix · {data.direction.memory.artistConcentration}</span>}
        </div>}

        <div className="grid gap-2 border-t border-separator-strong pt-3">
          <label className="text-[10px] font-bold tracking-wide uppercase" htmlFor="music-direction-intent">Operator guidance</label>
          <textarea id="music-direction-intent" value={intent} maxLength={180} rows={2}
            onChange={e => setIntent(e.target.value)} placeholder="Steer the next musical movement…"
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
        </div>
      </div>}
  </Card>;
}
