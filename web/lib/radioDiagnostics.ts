const DIAGNOSTIC_KEY = 'subwave-radio-diagnostics';

export type RadioDiagnosticStage =
  | 'tune-gesture'
  | 'ui-feedback'
  | 'media-play-called'
  | 'play-resolved'
  | 'play-rejected'
  | 'loadstart'
  | 'waiting'
  | 'stalled'
  | 'canplay'
  | 'playing-event'
  | 'media-error'
  | 'clock-advanced'
  | 'audio-signal-probe';

// Opt in from this browser's devtools: localStorage.setItem('subwave-radio-diagnostics', '1').
// Records contain no station, track, URL, auth, or session data.
export function radioDiagnostic(
  attempt: number,
  stage: RadioDiagnosticStage,
  detail?: Record<string, string | number | boolean | null>,
): void {
  try {
    if (typeof window === 'undefined' || window.localStorage.getItem(DIAGNOSTIC_KEY) !== '1') return;
    const safeDetail: Record<string, string | number | boolean | null> = {};
    if (detail?.tunedIn === true || detail?.tunedIn === false) safeDetail.tunedIn = detail.tunedIn;
    if (detail?.status === 'idle' || detail?.status === 'connecting' || detail?.status === 'playing') {
      safeDetail.status = detail.status;
    }
    if (typeof detail?.mediaErrorCode === 'number' && Number.isInteger(detail.mediaErrorCode)) {
      safeDetail.mediaErrorCode = detail.mediaErrorCode;
    }
    if (typeof detail?.mediaTime === 'number' && Number.isFinite(detail.mediaTime)) {
      safeDetail.mediaTime = Number(detail.mediaTime.toFixed(3));
    }
    if (typeof detail?.graphCreated === 'boolean') safeDetail.graphCreated = detail.graphCreated;
    if (typeof detail?.sampleCount === 'number' && Number.isInteger(detail.sampleCount) && detail.sampleCount >= 0) {
      safeDetail.sampleCount = detail.sampleCount;
    }
    for (const key of ['rmsMinDbfs', 'rmsMaxDbfs', 'detectionMs'] as const) {
      const value = detail?.[key];
      if (typeof value === 'number' && Number.isFinite(value)) safeDetail[key] = Number(value.toFixed(2));
    }
    if (['running', 'suspended', 'closed', 'interrupted', 'unsupported'].includes(String(detail?.contextState))) {
      safeDetail.contextState = detail?.contextState as string;
    }
    if (['signal-detected', 'no-signal-before-gate', 'unavailable', 'cancelled'].includes(String(detail?.result))) {
      safeDetail.result = detail?.result as string;
    }
    if (['NotAllowedError', 'NotSupportedError', 'AbortError', 'NetworkError', 'SecurityError', 'OtherError'].includes(String(detail?.errorClass))) {
      safeDetail.errorClass = detail?.errorClass as string;
    }
    console.info('[radio-diagnostic]', {
      attempt,
      stage,
      monotonicMs: Number(performance.now().toFixed(1)),
      approximateWallTime: new Date().toISOString(),
      ...safeDetail,
    });
  } catch {
    // Diagnostics are best-effort and must never affect playback.
  }
}

export function playErrorClass(error: unknown): string {
  if (error && typeof error === 'object' && 'name' in error && typeof error.name === 'string') {
    const known = new Set(['NotAllowedError', 'NotSupportedError', 'AbortError', 'NetworkError', 'SecurityError']);
    return known.has(error.name) ? error.name : 'OtherError';
  }
  return 'UnknownError';
}
