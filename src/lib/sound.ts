// New-mail chime, synthesized with the Web Audio API (no audio file to load).
//
// Browsers only let a page start audio after a user gesture, so the AudioContext is created
// on the first click or key press anywhere on the page and reused afterwards.

let ctx: AudioContext | null = null;

function unlock() {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === "suspended") void ctx.resume();
  } catch {
    // Web Audio unavailable: the chime is silently skipped.
  }
}

if (typeof window !== "undefined") {
  for (const type of ["pointerdown", "keydown"] as const) {
    window.addEventListener(type, unlock, { capture: true, passive: true });
  }
}

/** Plays a short two-note chime. A no-op until the user has interacted with the page. */
export function playChime(): void {
  if (!ctx || ctx.state !== "running") return;
  const start = ctx.currentTime;
  const out = ctx.createGain();
  out.gain.value = 0.15;
  out.connect(ctx.destination);
  [880, 1318.5].forEach((freq, i) => {
    const t = start + i * 0.14;
    const osc = ctx!.createOscillator();
    const env = ctx!.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(1, t + 0.02);
    env.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
    osc.connect(env).connect(out);
    osc.start(t);
    osc.stop(t + 0.4);
  });
}
