'use strict';
// Procedural game music + sound effects using the Web Audio API (no audio files).
// Usage: GameSound.init() from a user gesture, then GameSound.setMode('lobby'|'vote'|'guess'|'results'|'end'|null).
window.GameSound = (() => {
  let ctx = null;
  let master, music, sfx, noiseBuf;
  let mode = null;
  let bpm = 110;
  let step = 0;
  let nextTime = 0;
  let intensity = 0; // 0..1, raised during the last seconds of the countdown
  let muted = false;
  let musicLevel = 0.5;

  const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

  // Chord progressions (MIDI notes). Minor for tension, major for celebration.
  const PROG_MINOR = [[50, 53, 57], [46, 50, 53], [48, 52, 55], [45, 49, 52]]; // Dm Bb C A
  const PROG_MAJOR = [[50, 54, 57], [47, 50, 54], [43, 47, 50], [45, 49, 52]]; // D Bm G A
  const PROG_DARK = [[50, 53, 57], [50, 53, 58], [49, 52, 57], [50, 53, 57]];

  const MODES = {
    lobby: { bpm: 104, prog: PROG_MINOR, level: 0.5 },
    vote: { bpm: 126, prog: PROG_MINOR, level: 0.55 },
    guess: { bpm: 84, prog: PROG_DARK, level: 0.45 },
    results: { bpm: 112, prog: PROG_MAJOR, level: 0.5 },
    end: { bpm: 118, prog: PROG_MAJOR, level: 0.55 },
  };

  function init() {
    if (ctx) {
      if (ctx.state === 'suspended') ctx.resume();
      return;
    }
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    master = ctx.createGain();
    master.gain.value = muted ? 0 : 0.9;
    master.connect(comp).connect(ctx.destination);
    music = ctx.createGain();
    music.gain.value = musicLevel;
    music.connect(master);
    sfx = ctx.createGain();
    sfx.gain.value = 0.9;
    sfx.connect(master);

    noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;

    nextTime = ctx.currentTime + 0.1;
    setInterval(scheduler, 25);
  }

  // ---------- instruments ----------
  function env(gainNode, t, peak, attack, decay) {
    const g = gainNode.gain;
    g.setValueAtTime(0.0001, t);
    g.exponentialRampToValueAtTime(peak, t + attack);
    g.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  }

  function noise(t, dur, out) {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    src.connect(out);
    src.start(t, Math.random() * 0.5, dur + 0.05);
    return src;
  }

  function kick(t, vol = 1, out = music) {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.setValueAtTime(150, t);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.13);
    env(g, t, vol, 0.002, 0.38);
    o.connect(g).connect(out);
    o.start(t);
    o.stop(t + 0.45);
  }

  function snare(t, vol = 0.5, out = music) {
    const f = ctx.createBiquadFilter();
    f.type = 'highpass';
    f.frequency.value = 1200;
    const g = ctx.createGain();
    env(g, t, vol, 0.001, 0.16);
    noise(t, 0.2, f);
    f.connect(g).connect(out);
    const o = ctx.createOscillator();
    const og = ctx.createGain();
    o.type = 'triangle';
    o.frequency.setValueAtTime(220, t);
    o.frequency.exponentialRampToValueAtTime(140, t + 0.08);
    env(og, t, vol * 0.5, 0.001, 0.08);
    o.connect(og).connect(out);
    o.start(t);
    o.stop(t + 0.12);
  }

  function hat(t, vol = 0.12, open = false) {
    const f = ctx.createBiquadFilter();
    f.type = 'highpass';
    f.frequency.value = 7500;
    const g = ctx.createGain();
    env(g, t, vol, 0.001, open ? 0.22 : 0.035);
    noise(t, open ? 0.3 : 0.06, f);
    f.connect(g).connect(music);
  }

  function bass(t, midi, dur, vol = 0.32) {
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = mtof(midi);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.Q.value = 6;
    f.frequency.setValueAtTime(260 + intensity * 500, t);
    f.frequency.exponentialRampToValueAtTime(900 + intensity * 1200, t + 0.02);
    f.frequency.exponentialRampToValueAtTime(220, t + dur);
    const g = ctx.createGain();
    env(g, t, vol, 0.005, dur);
    o.connect(f).connect(g).connect(music);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  function pluck(t, midi, dur = 0.25, vol = 0.09, type = 'square', out = music) {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = mtof(midi);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(3200, t);
    f.frequency.exponentialRampToValueAtTime(500, t + dur);
    const g = ctx.createGain();
    env(g, t, vol, 0.004, dur);
    o.connect(f).connect(g).connect(out);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  function pad(t, notes, dur, vol = 0.05) {
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 1100;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + dur * 0.3);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    f.connect(g).connect(music);
    for (const n of notes) {
      for (const det of [-7, 7]) {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = mtof(n + 12);
        o.detune.value = det;
        o.connect(f);
        o.start(t);
        o.stop(t + dur + 0.05);
      }
    }
  }

  // ---------- sequencer ----------
  function playStep(s, bar, t) {
    const m = MODES[mode];
    if (!m) return;
    const chord = m.prog[bar % m.prog.length];
    const root = chord[0] - 12;
    const sixteenth = 60 / bpm / 4;

    if (mode === 'lobby') {
      if (s === 0 || s === 8 || s === 10) kick(t, 0.9);
      if (s === 4 || s === 12) snare(t, 0.35);
      if (s % 2 === 1) hat(t, 0.07);
      if ([0, 3, 6, 8, 11, 14].includes(s)) bass(t, root, sixteenth * 2.2);
      if (s % 2 === 0) pluck(t, chord[(s / 2) % 3] + 12, 0.2, 0.05, 'triangle');
    } else if (mode === 'vote') {
      if (s % 4 === 0) kick(t, 1);
      if (s === 4 || s === 12) snare(t, 0.45);
      hat(t, s % 2 ? 0.1 : 0.05);
      if (intensity > 0.4 && s % 4 === 2) hat(t, 0.08, true);
      if (s % 2 === 0) bass(t, root + (s % 8 === 6 ? 12 : 0), sixteenth * 1.6, 0.3);
      if ([0, 3, 6, 10, 12].includes(s)) pluck(t, chord[[0, 3, 6, 10, 12].indexOf(s) % 3] + 24, 0.12, 0.04 + intensity * 0.03);
      if (intensity > 0.7 && s % 2 === 1) snare(t, 0.12 * intensity);
    } else if (mode === 'guess') {
      if (s === 0) kick(t, 0.7);
      if (s === 10) kick(t, 0.45);
      if (s % 4 === 2) hat(t, 0.05);
      if (s === 0) pad(t, chord, sixteenth * 16, 0.045);
      if (s === 0 || s === 6 || s === 8) bass(t, root, sixteenth * 3, 0.22);
      if ([3, 7, 11, 14].includes(s)) pluck(t, chord[[3, 7, 11, 14].indexOf(s) % 3] + 24, 0.3, 0.035, 'sine');
    } else if (mode === 'results' || mode === 'end') {
      if (s % 4 === 0) kick(t, 0.95);
      if (s === 4 || s === 12) snare(t, 0.4);
      if (s % 2 === 1) hat(t, 0.08);
      if (mode === 'end' && s % 4 === 2) hat(t, 0.06, true);
      if ([0, 2, 6, 8, 10, 14].includes(s)) bass(t, root, sixteenth * 1.8, 0.28);
      if (s % 2 === 0) pluck(t, chord[(s / 2) % 3] + 24, 0.14, 0.045, 'triangle');
    }
  }

  function scheduler() {
    if (!ctx || !mode) return;
    const sixteenth = 60 / bpm / 4;
    if (nextTime < ctx.currentTime) nextTime = ctx.currentTime + 0.02;
    while (nextTime < ctx.currentTime + 0.12) {
      playStep(step % 16, Math.floor(step / 16), nextTime);
      nextTime += sixteenth;
      step++;
    }
  }

  function fadeMusic(to, time = 0.4) {
    if (!ctx) return;
    const t = ctx.currentTime;
    music.gain.cancelScheduledValues(t);
    music.gain.setValueAtTime(music.gain.value, t);
    music.gain.linearRampToValueAtTime(to, t + time);
  }

  function setMode(next) {
    if (next === mode) return;
    mode = next;
    intensity = 0;
    if (MODES[next]) {
      bpm = MODES[next].bpm;
      musicLevel = MODES[next].level;
    }
    if (!ctx) return;
    if (!MODES[next]) return fadeMusic(0, 0.3);
    step = 0;
    nextTime = ctx.currentTime + 0.06;
    fadeMusic(musicLevel, 0.25);
  }

  // ---------- sound effects ----------
  function tick(urgent) {
    if (!ctx) return;
    const t = ctx.currentTime;
    pluck(t, urgent ? 96 : 84, 0.08, urgent ? 0.18 : 0.1, 'sine', sfx);
  }

  function blip() {
    if (!ctx) return;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(900, t);
    o.frequency.exponentialRampToValueAtTime(1500, t + 0.06);
    env(g, t, 0.07, 0.003, 0.09);
    o.connect(g).connect(sfx);
    o.start(t);
    o.stop(t + 0.12);
  }

  function whoosh() {
    if (!ctx) return;
    const t = ctx.currentTime;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.Q.value = 1.5;
    f.frequency.setValueAtTime(300, t);
    f.frequency.exponentialRampToValueAtTime(4000, t + 0.35);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.35, t + 0.18);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
    noise(t, 0.55, f);
    f.connect(g).connect(sfx);
  }

  function buzzer() {
    if (!ctx) return;
    const t = ctx.currentTime;
    for (const freq of [110, 116]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = freq;
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = 900;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
      g.gain.setValueAtTime(0.25, t + 0.5);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.7);
      o.connect(f).connect(g).connect(sfx);
      o.start(t);
      o.stop(t + 0.75);
    }
  }

  /** Accelerating snare roll with a crescendo; music is muted while it plays. */
  function drumroll(duration = 2.4) {
    if (!ctx) return;
    mode = 'drumroll';
    fadeMusic(0, 0.15);
    const t0 = ctx.currentTime + 0.05;
    let t = t0;
    while (t < t0 + duration) {
      const p = (t - t0) / duration;
      snare(t, 0.08 + p * 0.4, sfx);
      t += 0.07 - p * 0.035;
    }
  }

  /** Big reveal hit: kick + crash + chord stab. */
  function reveal() {
    if (!ctx) return;
    const t = ctx.currentTime + 0.02;
    kick(t, 1.2, sfx);
    const f = ctx.createBiquadFilter();
    f.type = 'highpass';
    f.frequency.value = 3000;
    const g = ctx.createGain();
    env(g, t, 0.35, 0.003, 1.6);
    noise(t, 1.7, f);
    f.connect(g).connect(sfx);
    for (const n of [62, 66, 69, 74]) pluck(t, n, 1.1, 0.06, 'sawtooth', sfx);
  }

  function fanfare() {
    if (!ctx) return;
    const t = ctx.currentTime + 0.02;
    [62, 66, 69, 74, 78, 81].forEach((n, i) => pluck(t + i * 0.09, n, 0.5, 0.08, 'square', sfx));
    for (const n of [62, 66, 69, 74]) pluck(t + 0.6, n, 1.4, 0.06, 'sawtooth', sfx);
  }

  function setIntensity(v) {
    intensity = Math.max(0, Math.min(1, v));
  }

  function toggleMute() {
    muted = !muted;
    if (master) master.gain.setTargetAtTime(muted ? 0 : 0.9, ctx.currentTime, 0.05);
    return muted;
  }

  return {
    init, setMode, setIntensity, tick, blip, whoosh, buzzer, drumroll, reveal, fanfare, toggleMute,
    get muted() { return muted; },
    get mode() { return mode; },
  };
})();
