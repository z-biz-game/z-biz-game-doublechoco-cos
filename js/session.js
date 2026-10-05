// 一局的时间与会话状态：唯一被允许说"这一局跑了多久"的地方。
//
// 为什么单独成一个文件而不是留在 js/main.js 里：main.js 是 DOM 接线，node 侧的闸读不到它，
// 于是"暂停期间计时不许走"这种承诺就只能靠浏览器那一腿量——而那一腿慢、且只在主编那边跑。
// 抽出来之后它是可判的：注入一个假时钟，pause() 之后 elapsed() 必须逐毫秒冻住。
//
// 三条口径：
//  * elapsed = base + (startedAt ? now() - startedAt : 0)。暂停与停表共用这一条，
//    区别只在 paused 这个标志：停表是"这一局结束了"，暂停是"这一局还没结束但先不动"。
//  * 时间源可注入（构造参数 now）：默认 Date.now，闸里给一个从 1000ms 起步的假表。
//    从 0 起步会被"startedAt 为 0 表示没跑"这个哨兵吃掉第一帧，凭空造出一段假误差。
//  * 这一局唯一的时间读数就是它。js/main.js 里不再留第二份 startedAt/baseElapsed。

class Session {
  constructor(now = () => Date.now()) {
    this.now = now;
    this.base = 0;
    this.startedAt = 0;
    this.paused = false;
  }

  elapsed() {
    return this.base + (this.startedAt ? this.now() - this.startedAt : 0);
  }

  running() {
    return this.startedAt !== 0 && !this.paused;
  }

  // 开新局 / 续局：from 是已经跑过的毫秒（续局从存档里带来）
  start(from = 0) {
    this.base = Math.max(0, from) || 0;
    this.startedAt = this.now();
    this.paused = false;
    return this;
  }

  // 停表（通关、回选档）：把读数结算进 base，之后 elapsed() 恒定
  stop() {
    this.base = this.elapsed();
    this.startedAt = 0;
    this.paused = false;
    return this.base;
  }

  pause() {
    if (this.paused || !this.startedAt) return false;
    this.base = this.elapsed();
    this.startedAt = 0;
    this.paused = true;
    return true;
  }

  resume() {
    if (!this.paused) return false;
    this.paused = false;
    this.startedAt = this.now();
    return true;
  }

  // 重开/换一局要把时间清干净：留着 base 就等于让上一局的耗时渗进这一局的纪录。
  reset() {
    this.base = 0;
    this.startedAt = 0;
    this.paused = false;
    return this;
  }

  state() {
    return { elapsedMs: this.elapsed(), running: this.running(), paused: this.paused, base: this.base };
  }
}
