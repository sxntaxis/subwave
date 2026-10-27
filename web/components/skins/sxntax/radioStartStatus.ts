import type { PlayerStatus } from '@/hooks/usePlayer';

export type RadioStartStatus = {
  text: string;
  tone: 'ok' | 'wait' | 'warn';
  showTuneAction: boolean;
} | null;

export type RadioStartEvidence = {
  tunedIn: boolean;
  playerStatus: PlayerStatus | 'error';
  idleStopped: boolean;
  streamIdle: boolean;
  stateSampleStartedAt: number;
  attemptStartedAt: number | null;
  attemptStartedIdle: boolean;
  clockAdvanced: boolean;
  mediaWaiting: boolean;
  playFailure: string | null;
  connectingForMs: number;
};

function gateSampleIsFresh(input: RadioStartEvidence): boolean {
  return input.attemptStartedAt != null && input.stateSampleStartedAt >= input.attemptStartedAt;
}

function idleWasReported(input: RadioStartEvidence): boolean {
  return input.attemptStartedIdle || input.streamIdle;
}

export function radioPlaybackConfirmed(input: RadioStartEvidence): boolean {
  if (
    !input.tunedIn ||
    input.playerStatus !== 'playing' ||
    !input.clockAdvanced ||
    input.mediaWaiting ||
    input.playFailure != null
  ) return false;
  if (!idleWasReported(input)) return true;
  return gateSampleIsFresh(input) && !input.streamIdle;
}

export function radioStartStatus(input: RadioStartEvidence): RadioStartStatus {
  if (!input.tunedIn) {
    if (input.idleStopped) return { text: 'LISTENING TIMED OUT — TUNE IN', tone: 'warn', showTuneAction: true };
    if (input.streamIdle) return { text: 'RADIO IDLE — TUNE IN TO LISTEN', tone: 'wait', showTuneAction: true };
    return null;
  }

  if (input.playFailure === 'NotAllowedError') {
    return { text: 'AUDIO NEEDS USER ACTION — TUNE OUT, THEN TUNE IN', tone: 'warn', showTuneAction: true };
  }
  if (input.playFailure) {
    return { text: 'CONNECTION INTERRUPTED — TUNE OUT, THEN TUNE IN TO RETRY', tone: 'warn', showTuneAction: true };
  }
  if (input.playerStatus === 'connecting' && input.connectingForMs >= 15_000) {
    return { text: 'STILL CONNECTING — TUNE OUT, THEN TUNE IN TO RETRY', tone: 'warn', showTuneAction: true };
  }
  const sampleFresh = gateSampleIsFresh(input);
  const knownIdle = idleWasReported(input);
  if (radioPlaybackConfirmed(input)) return null;
  if (input.mediaWaiting) return { text: '[ WAIT ] BUFFERING AUDIO', tone: 'wait', showTuneAction: false };
  if (input.playerStatus === 'error') return { text: 'CONNECTION INTERRUPTED', tone: 'warn', showTuneAction: true };
  if (input.playerStatus === 'idle') return { text: 'CONNECTING TO RADIO', tone: 'wait', showTuneAction: false };
  if (knownIdle) {
    if (input.streamIdle && input.clockAdvanced) {
      return { text: '[ WAIT ] STREAM CONNECTED · WAITING FOR PROGRAMME', tone: 'wait', showTuneAction: false };
    }
    if (input.streamIdle) {
      return { text: '[ WAIT ] BROADCAST REPORTED IDLE · WAITING FOR RESUME', tone: 'wait', showTuneAction: false };
    }
    if (!sampleFresh && input.clockAdvanced) {
      return { text: 'STREAM CONNECTED · VERIFYING PROGRAMME STATE', tone: 'wait', showTuneAction: false };
    }
    if (sampleFresh && !input.clockAdvanced) {
      return { text: 'BROADCAST RESUMED · CONNECTING AUDIO', tone: 'wait', showTuneAction: false };
    }
  }
  if (
    input.playerStatus === 'connecting' &&
    sampleFresh &&
    !input.streamIdle
  ) {
    return { text: '[ OK ] IDLE GATE CLEAR', tone: 'ok', showTuneAction: false };
  }
  if (input.playerStatus === 'connecting') return { text: 'CONNECTING TO RADIO', tone: 'wait', showTuneAction: false };
  if (input.playerStatus === 'playing') return { text: 'CONNECTING TO RADIO', tone: 'wait', showTuneAction: false };
  return null;
}
