// Synthesised feedback, no sample files. A puzzle game's sound is a *state* readout —
// "a mark went down", "that mark breaks a clause", "every block is closed and congruent" — and
// each of those is one short envelope, so a synth keeps the artifact small and the vocabulary
// honest.

let ctx = null;
let master = null;
// 静音与"暂停把声音按住"是两件事：前者是玩家的设定（跨局、存档里带着走），
// 后者是这一局的会话状态（恢复时必须按前者的结论决定要不要继续响）。
let muted = false;
let held = false;

function audioIdle() {
  return muted || held;
}

function audio() {
  // 静音/暂停态**连上下文都不新建**：新建一个 running 的 AudioContext 比新建一个振荡器
  // 更糟——它会在后台一直走表，而"静音"这件事在页面上看起来像做了其实没做。
  if (audioIdle()) return null;
  if (typeof AudioContext === 'undefined' && typeof webkitAudioContext === 'undefined') return null;
  if (!ctx) {
    const Ctor = typeof AudioContext !== 'undefined' ? AudioContext : webkitAudioContext;
    try {
      ctx = new Ctor();
      master = ctx.createGain();
      master.gain.value = 0.5;
      master.connect(ctx.destination);
    } catch {
      return null;
    }
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

// 该不该挂起，只由 muted/held 两个标志决定；两处入口各自只改自己那一个，再走同一条 apply。
function apply() {
  if (!ctx || typeof ctx.suspend !== 'function') return;
  try {
    if (muted || held) ctx.suspend().catch(() => {});
    else ctx.resume().catch(() => {});
  } catch {
    /* 老 WebKit 上 suspend 可能是同步的或不存在 */
  }
}

function hold(on) {
  held = on;
  apply();
}

// One oscillator with a two-point pitch glide and an exponential decay. Everything below is
// a call to this; adding a second voice shape is how a game ends up with sounds that do not
// belong to the same instrument.
function tone({ f0, f1 = f0, dur = 0.12, type = 'sine', gain = 0.22, delay = 0 }) {
  if (audioIdle()) return false;      // 静音/暂停：一个节点都不许建（下面那台计数器就是它的证人）
  const ac = audio();
  if (!ac) return false;
  const t = ac.currentTime + delay;
  const osc = ac.createOscillator();
  const vol = ac.createGain();
  voices++;
  osc.type = type;
  osc.frequency.setValueAtTime(f0, t);
  osc.frequency.exponentialRampToValueAtTime(Math.max(40, f1), t + dur);
  vol.gain.setValueAtTime(0.0001, t);
  vol.gain.exponentialRampToValueAtTime(gain, t + 0.012);
  vol.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(vol).connect(master);
  osc.start(t);
  osc.stop(t + dur + 0.02);
  return true;
}

let voices = 0;

export const Sound = {
  // 静音是**挂起上下文**，不是把 master 拧到 0：前者可以被外部读成 ctx.state === 'suspended'，
  // 后者只是让玩家以为没声音了，而振荡器还在建、表还在走。
  setMuted(v) {
    muted = !!v;
    apply();
    return muted;
  },
  isMuted: () => muted,
  toggleMute() {
    return Sound.setMuted(!muted);
  },

  // 会话级按住（暂停用这一条）：恢复时仍尊重静音设定
  pauseAudio: () => hold(true),
  resumeAudio: () => hold(false),
  held: () => held,

  // 没有上下文就是 none：静音态下点十个键也应该是 none，而不是 suspended 之后一路 running
  ctxState: () => (ctx ? ctx.state : 'none'),
  voices: () => voices,
  resetVoices() {
    voices = 0;
    return voices;
  },

  // 1..5 climb a pentatonic: the pitch tells you which mark went down without looking.
  // DC-HOOK: hebi 的 v 是格里的数字 1–5；DOUBLE CHOCO 的 v 是 game.js 定义的落子值
  // （见 js/main.js 的 write(i,v)），这一条只是把"第几档动作"读成一个音高。
  digit(v) {
    const scale = [0, 523, 587, 698, 784, 932];
    const f = scale[v] || 523;
    tone({ f0: f, f1: f * 1.06, dur: 0.12, type: 'triangle', gain: 0.19 });
  },
  place() {
    tone({ f0: 520, f1: 880, dur: 0.14, type: 'triangle', gain: 0.2 });
  },
  // 清掉一格标记（hebi 叫"钉成留空"）：往下走的一小步，不是错误。
  blank() {
    tone({ f0: 330, f1: 300, dur: 0.09, type: 'sine', gain: 0.12 });
  },
  erase() {
    tone({ f0: 240, f1: 180, dur: 0.08, type: 'sine', gain: 0.1 });
  },
  undo() {
    tone({ f0: 420, f1: 300, dur: 0.11, type: 'triangle', gain: 0.13 });
  },
  // Two detuned voices: an interval that is deliberately unpleasant, for the one thing the
  // player must notice without looking.
  conflict() {
    tone({ f0: 200, f1: 150, dur: 0.16, type: 'sawtooth', gain: 0.11 });
    tone({ f0: 214, f1: 158, dur: 0.16, type: 'sawtooth', gain: 0.09, delay: 0.01 });
  },
  refuse() {
    tone({ f0: 150, f1: 120, dur: 0.07, type: 'square', gain: 0.07 });
  },
  hint() {
    tone({ f0: 760, f1: 1020, dur: 0.16, type: 'sine', gain: 0.16 });
    tone({ f0: 1140, dur: 0.1, type: 'sine', gain: 0.07, delay: 0.06 });
  },
  win() {
    [523, 659, 784, 1046].forEach((f, i) => tone({ f0: f, dur: 0.26, type: 'triangle', gain: 0.17, delay: i * 0.09 }));
  },
};
