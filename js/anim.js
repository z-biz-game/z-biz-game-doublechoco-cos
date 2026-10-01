// 动效时钟：全仓**唯一**被允许读帧 dt 的地方。
//
// 为什么要有这一份，而不是像原先那样 setTimeout(1600) 清一个 pulse 标志：
//  * 墙钟定时器与画面无关。它说"1.6 秒后消失"，但那一层回显到底还剩多少不透明，
//    在 30Hz 与 120Hz 上是两次不同的采样序列——包络必须由累计的 dt 给，帧率才只是采样率。
//  * 暂停要能真的停住动效。定时器停不住（清档、回选档、后台标签都会让它继续跑），
//    而这一份在 anim.step() 不被调用时就不推进：不推进 == 不变化，这是行为不是说法。
//  * prefers-reduced-motion 有一个真分支：不是"把动画调快"，而是**不推进包络**，
//    回显退化成一张静图（画与不画由调用方判，这里只保证时间不走）。
//
// 帧率无关的写法只有一种：所有量都是 `x += v * dt`。这里没有粒子，被积的分钟
// 是每条回显自己的寿命 it.t 与总时钟 this.time；两者都只吃 dt，不吃帧数。

export const PULSE_SEC = 1.6;      // 落子回显的寿命（与原先那句 setTimeout(1600) 同值，改的是实现）
const MAX_DT = 0.05;               // 一帧最多算 50ms：切后台回来那一大跳不该把回显整条吞掉

export class Anim {
  // reduced 是一个**取值函数**而不是一个布尔：系统偏好可以在运行中改，
  // 而这一份时钟不该为了知道这件事去 import DOM。
  constructor({ reduced = () => false, nowMs = 0 } = {}) {
    this.reduced = reduced;
    this.last = nowMs;
    this.time = 0;
    this.frames = 0;
    this.items = new Map();
  }

  // nowMs 来自 requestAnimationFrame 的 timestamp（或闸里喂的假表）。
  // 第一帧只登记时间源、不产生 dt：否则起步那一步会凭空造出一个 dt=nowMs 的假帧。
  step(nowMs) {
    this.frames++;
    if (!this.last) {
      this.last = nowMs;
      return 0;
    }
    const dt = Math.min(MAX_DT, (nowMs - this.last) / 1000);
    this.last = nowMs;
    if (dt <= 0) return 0;
    if (this.reduced()) {
      // 省动效：时间不推进，回显当场清掉（留着就是一张永远不退的静图压在盘上）
      if (this.items.size) this.items.clear();
      return 0;
    }
    this.time += dt;
    for (const [key, it] of this.items) {
      it.t += dt;
      if (it.t >= it.life) this.items.delete(key);
    }
    return dt;
  }

  add(key, { life = PULSE_SEC, seg = null, cell = null, color = null } = {}) {
    this.items.set(key, { key, t: 0, life, seg, cell, color });
    return this.items.get(key);
  }

  get(key) {
    return this.items.get(key) || null;
  }

  first() {
    for (const it of this.items.values()) return it;
    return null;
  }

  clear() {
    this.items.clear();
    return this;
  }

  // 只把时间源指针挪到现在，不推进任何累计量。暂停期间 loop 不调 step 而调这一条：
  // 少了它，恢复后的第一帧会把整段暂停的墙钟当成一帧 dt 吞进来（MAX_DT 只是把它截成 50ms，
  // 截断后的错误仍然是错误——回显会在玩家不在的那段时间里偷偷退掉一截）。
  reanchor(nowMs) {
    this.last = nowMs;
    return this;
  }

  // 重开/换一局：包络与累计时钟一起归零。只清 items 不清 time 的话，
  // "这一局看了多久动效"这个读数会跨局渗下去。
  reset() {
    this.clear();
    this.time = 0;
    this.frames = 0;
    this.last = 0;
    return this;
  }

  // 0→1 的进度。t 是累计 dt 出来的，所以同一虚拟时长在任何帧率上都一样。
  progress(it) {
    if (!it) return 1;
    return Math.max(0, Math.min(1, it.t / it.life));
  }

  // 包络：前 40% 保持全量，之后按剩余寿命线性退到 0。全部由 progress 给，没有第二套时间源。
  // 为什么不以 0 起步（原先那一版 attack 写法）：落子的第一帧就是玩家要看的那一眼，
  // alpha=0 等于按下没反应——回显的作用是确认落点，先满后褪才成立。
  alpha(it) {
    if (!it) return 0;
    const p = this.progress(it);
    return p <= 0.4 ? 1 : 1 - (p - 0.4) / 0.6;
  }

  active() {
    return this.items.size > 0;
  }

  // 挂给窗口，供探针读数：没有这一份，任何外部判尺都看不见这个时钟在不在推进。
  state() {
    return {
      time: this.time,
      frames: this.frames,
      active: this.items.size,
      items: [...this.items.values()].map((it) => ({ key: it.key, t: it.t, life: it.life, seg: it.seg })),
    };
  }
}
