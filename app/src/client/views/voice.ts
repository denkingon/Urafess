import type { GameClient } from '../core/game-client';
import type { SoundListener } from '../sound/listener';
import { say } from '../ui';

const VOICE_RATE = 8_000;

function encode(samples: Float32Array, rate: number): string {
  const ratio = rate / VOICE_RATE;
  const length = Math.floor(samples.length / ratio);
  let bytes = '';
  for (let i = 0; i < length; i++) {
    const from = Math.floor(i * ratio);
    const to = Math.min(samples.length, Math.max(from + 1, Math.floor((i + 1) * ratio)));
    let sum = 0;
    for (let j = from; j < to; j++) sum += samples[j];
    const mean = Math.min(1, Math.max(-1, sum / (to - from)));
    bytes += String.fromCharCode(Math.round(128 + mean * 127));
  }
  return btoa(bytes);
}

export function createVoice(client: GameClient, listener: SoundListener) {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'voice-hold';
  el.hidden = true;
  el.innerHTML = say(['鬼の通話：押して話す', 'HOLD TO TALK TO CHASERS']);
  el.setAttribute('aria-pressed', 'false');

  let ctx: AudioContext | null = null;
  let held = false;
  let pointer: number | null = null;
  let assignId = 0;
  const outputs = new Set<AudioBufferSourceNode>();
  const nextBySender = new Map<number, number>();

  const unlock = () => {
    const AC = window.AudioContext ?? (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    ctx ??= new AC();
    if (ctx.state !== 'running') void ctx.resume().catch(() => undefined);
  };

  const clearPlayback = () => {
    for (const source of outputs) source.stop();
    outputs.clear();
    nextBySender.clear();
  };

  const stop = () => {
    if (!held) return;
    held = false;
    pointer = null;
    listener.stopVoice();
    el.setAttribute('aria-pressed', 'false');
  };
  const start = () => {
    if (!assignId || held) return;
    unlock();
    clearPlayback();
    held = true;
    el.setAttribute('aria-pressed', 'true');
    listener.listenVoice((samples, rate) => {
      if (held && assignId) client.sendVoice(assignId, encode(samples, rate));
    });
  };

  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || held) return;
    e.preventDefault();
    pointer = e.pointerId;
    el.setPointerCapture(e.pointerId);
    start();
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) {
    el.addEventListener(type, (e) => {
      if (e.pointerId === pointer) stop();
    });
  }
  const isHoldKey = (e: KeyboardEvent) => e.key === ' ' || e.key === 'Enter';
  el.addEventListener('keydown', (e) => {
    if (!isHoldKey(e)) return;
    e.preventDefault();
    if (!e.repeat) start();
  });
  el.addEventListener('keyup', (e) => {
    if (isHoldKey(e) && pointer === null) stop();
  });
  el.addEventListener('blur', stop);
  el.addEventListener('contextmenu', (e) => e.preventDefault());
  window.addEventListener('blur', stop);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      stop();
      clearPlayback();
    }
  });

  client.onVoice = (packet) => {
    if (held || document.hidden || !assignId || packet.assignId !== assignId || ctx?.state !== 'running') return;
    let bytes: string;
    try {
      bytes = atob(packet.audio);
    } catch {
      return;
    }
    if (!bytes.length || bytes.length > 1536) return;
    const now = ctx.currentTime;
    const at = Math.max(now + 0.03, nextBySender.get(packet.from) ?? 0);
    if (at - now > 0.35) return;
    const buffer = ctx.createBuffer(1, bytes.length, VOICE_RATE);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < bytes.length; i++) channel[i] = (bytes.charCodeAt(i) - 128) / 128;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    outputs.add(source);
    source.onended = () => {
      outputs.delete(source);
      source.disconnect();
    };
    source.start(at);
    nextBySender.set(packet.from, at + buffer.duration);
  };

  return {
    el,
    unlock,
    update(activeAssignId: number) {
      if (activeAssignId === assignId) return;
      stop();
      clearPlayback();
      assignId = activeAssignId;
      el.hidden = !assignId;
    },
  };
}
