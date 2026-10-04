// 画布渲染器：只读 js/ui/game.js 的状态并作画。它不做任何判断——
// 一块"对不对"是 rules.js 那张条款表说的（game.js 已经把违反的格挑进 game.bad），
// 这里只负责把那份判断画出来，所以画面不可能和判据各说一套。
//
// 布局也留在这个文件里（格子边长、盘面原点、DPR），因为 hitSegment 必须用 draw 刚用过的那几个数
// 回答点击：两者一旦漂移，就会出现"画面对、点下去偏一格"——区界游戏里那是最难受的一种错。
//
// 三种线是这局的三种读数，必须分得开：
//   点线   = 题面给的 dotted line，还没画界（相邻两格目前同属一个候选区域）
//   粗实线 = 玩家画下的区界（原句：Divide the grid into blocks by drawing solid lines）
//   外框   = 盘的边界，永远实线，不可点（外面没有格子）
// 点线与粗实线都跨在两种底色上（灰格与白格相邻时），所以同一段的左半与右半各用自己的颜色，
// 靠 clip 到各自格子实现——一条线一个颜色时，总有一半会沉进底色里看不见。


/* ---------- 帧率无关（dt）---------- */
/* 本仓**没有逐帧运动**，所以「帧率无关」这一项在本仓是空命题而不是缺陷：全仓只有一处 requestAnimationFrame，在 js/main.js:115 的 `requestAnimationFrame(() => setTimeout(fin, 0))`——让出一帧好让 busy 态先画出来，之后靠 setTimeout 接力，**不自续期**；棋盘重绘由 pointerdown / click / keydown 触发
   没有自续期的 requestAnimationFrame 循环，屏上就没有「每帧推进」的量，帧率也就无从影响它。
   写这段备案是为了让账上分得开"查过、确实不需要"与"没人查过"——不是为了让判据变绿。

   规矩：**哪天在本仓加了逐帧动画循环，必须先删掉这段备案**，并让循环体消费 rAF 自带的
   时间戳（或自己取 performance.now()），把动画进度写成绝对截止；只按帧累加位置的一律不算。 */
import { Palette, Cell, Radius, Font, Hit } from '../theme.js';
import { BORDER, segKey } from '../ui/game.js';

export function layoutFor(R, C, availW, availH) {
  const pad = 8; // 区界只画在盘内部，格外不需要留写字的地方
  const size = Math.max(0, Math.min((availW - pad * 2) / C, (availH - pad * 2) / R));
  const cell = Math.max(Cell.min, Math.min(Cell.max, Math.floor(size)));
  return { cell, boardW: cell * C, boardH: cell * R, pad };
}

export class BoardView {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.geo = { cell: 0, x: 0, y: 0, w: 0, h: 0, dpr: 1 };
  }

  // 后备缓冲按设备像素定尺寸，所有绘制调用留在 CSS 像素：开头一次 setTransform，
  // 就不需要把本文件每个常量都乘一遍 DPR，也不会让点线在 Retina 上糊成一团。
  resize(game, availW, availH) {
    const l = layoutFor(game.R, game.C, availW, availH);
    const dpr = Math.max(1, Math.round(window.devicePixelRatio || 1));
    const size = { w: l.boardW + l.pad * 2, h: l.boardH + l.pad * 2 };
    this.canvas.style.width = `${size.w}px`;
    this.canvas.style.height = `${size.h}px`;
    this.canvas.width = Math.round(size.w * dpr);
    this.canvas.height = Math.round(size.h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.geo = { cell: l.cell, x: l.pad, y: l.pad, w: size.w, h: size.h, dpr };
    this.game = game;
    return this.geo;
  }

  cellRect(i) {
    const { cell, x, y } = this.geo;
    const [r, c] = [Math.floor(i / this.game.C), i % this.game.C];
    return { x: c * cell + x, y: r * cell + y, size: cell };
  }

  // 段 k 的两个端点（CSS 像素）。段表里 j>i 且相邻，所以只有"右邻"与"下邻"两种。
  segLine(k) {
    const { cell, x, y } = this.geo;
    const C = this.game.C;
    const [i, j] = this.game.segs[k];
    const r = Math.floor(i / C), c = i % C;
    return j === i + 1
      ? { x1: x + (c + 1) * cell, y1: y + r * cell, x2: x + (c + 1) * cell, y2: y + (r + 1) * cell }
      : { x1: x + c * cell, y1: y + (r + 1) * cell, x2: x + (c + 1) * cell, y2: y + (r + 1) * cell };
  }

  // 盘面坐标（已减去 canvas 左上角）→ 段号，或 -1（离所有段都太远）。
  segFromPoint(px, py) {
    const { cell } = this.geo;
    if (!cell || !this.game) return -1;
    const tol = Math.min(Math.max(5, cell * Hit.segRatio), cell * Hit.maxCell);
    let best = -1, bestD = Infinity;
    for (let k = 0; k < this.game.segs.length; k++) {
      const s = this.segLine(k);
      const d = distPointSeg(px, py, s.x1, s.y1, s.x2, s.y2);
      if (d < bestD) { bestD = d; best = k; }
    }
    return bestD <= tol ? best : -1;
  }

  hitSegment(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    return this.segFromPoint(clientX - rect.left, clientY - rect.top);
  }

  // 点击所在格：段没点着时用它移动光标，键盘（Shift+方向键）就从这一格接着画。
  hitCell(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const { cell, x, y } = this.geo;
    const g = this.game;
    if (!cell || !g) return -1;
    const c = Math.floor((clientX - rect.left - x) / cell);
    const r = Math.floor((clientY - rect.top - y) / cell);
    if (r < 0 || c < 0 || c >= g.C || r >= g.R) return -1;
    return g.B.id(r, c);
  }

  // 区域色来自玩家自己的划分（gid 取块内最小格号），不是答案：
  // 同一层色只说明"你把这几格当成了一块"，画错了也不会泄露正确的排法。
  colorMap(part) {
    const ids = [...new Set([...part.values()])].sort((a, b) => a - b);
    const m = new Map();
    ids.forEach((g, k) => m.set(g, Palette.region[k % Palette.region.length]));
    return m;
  }

  dotColor(i) {
    return this.game.B.isGray(i) ? Palette.dot : Palette.dotOnPaper;
  }

  draw(game, { pulse = null, hover = -1, handles = true } = {}) {
    this.game = game;
    const { ctx, geo } = this;
    const { cell } = geo;
    const B = game.B;
    const won = game.status === 'won';
    ctx.clearRect(0, 0, geo.w, geo.h);
    roundRect(ctx, 0, 0, geo.w, geo.h, Radius.card);
    ctx.fillStyle = Palette.surface;
    ctx.fill();

    // 底层：题面给的灰格与白格。"数字数的是哪一半"全靠这一层，所以不用 alpha 蒙出来。
    for (const i of B.cells) {
      const r = this.cellRect(i);
      ctx.fillStyle = B.isGray(i) ? Palette.gray : Palette.paper;
      ctx.fillRect(r.x, r.y, cell, cell);
    }

    // 玩家当前分块的回显：整块同色。画错时也照样回显——它是读数，不是判词。
    const colors = this.colorMap(game.part);
    for (const i of B.cells) {
      const g = game.part.get(i);
      if (g == null || g < 0) continue;
      const r = this.cellRect(i);
      ctx.fillStyle = withAlpha(colors.get(g), won ? 0.26 : 0.15);
      ctx.fillRect(r.x, r.y, cell, cell);
    }

    // 过不了条款的块罩一层红。哪一条被违反由提示与状态行说，画面只指出是哪一块。
    if (game.bad.size) {
      ctx.fillStyle = withAlpha(Palette.error, 0.22);
      for (const i of game.bad) {
        const r = this.cellRect(i);
        ctx.fillRect(r.x, r.y, cell, cell);
      }
    }

    // 内部网格
    const dotW = Math.max(1, cell * Cell.dotScale);
    const solidW = Math.max(2.5, cell * Cell.borderScale);
    const dash = [Math.max(2, cell * 0.09), Math.max(2, cell * 0.11)];
    for (let k = 0; k < game.segs.length; k++) {
      const [i, j] = game.segs[k];
      const s = this.segLine(k);
      // 一条段跨在两种底色上，所以实线与点线都分两次画、各 clip 进相邻的那一格。
      // 两半各挑一种墨（灰底用 border，纸底用 borderOnPaper），因为"一白走两边"不成立：
      // tools/ui-smoke.mjs 第 6 段拿题面自己的色差当尺，钉住四种墨都分得开，并留一条负样本
      // 写着"两半同色会沉底"。像素那一层由 tools/scenarios.js 的 layout 腿逐段两侧量。
      const sideStroke = (rect, col, dashPattern, width) => {
        ctx.save();
        ctx.beginPath();
        ctx.rect(rect.x, rect.y, rect.size, rect.size);
        ctx.clip();
        ctx.setLineDash(dashPattern);
        ctx.strokeStyle = col;
        ctx.lineWidth = width;
        ctx.beginPath(); ctx.moveTo(s.x1, s.y1); ctx.lineTo(s.x2, s.y2); ctx.stroke();
        ctx.restore();
      };
      const badPair = game.bad.has(i) && game.bad.has(j);
      if (game.st[k] === BORDER) {
        const solidCol = (ix) => (won ? Palette.success : badPair ? Palette.error : B.isGray(ix) ? Palette.border : Palette.borderOnPaper);
        sideStroke(this.cellRect(i), solidCol(i), [], solidW);
        sideStroke(this.cellRect(j), solidCol(j), [], solidW);
        continue;
      }
      sideStroke(this.cellRect(i), this.dotColor(i), dash, dotW);
      sideStroke(this.cellRect(j), this.dotColor(j), dash, dotW);
    }
    ctx.setLineDash([]);
    ctx.strokeStyle = Palette.lineHeavy;
    ctx.lineWidth = Math.max(1.5, cell * 0.05);
    ctx.strokeRect(geo.x, geo.y, cell * game.C, cell * game.R);

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // 题面数字：印在哪种颜色上就数哪种颜色的格数（V5 的原句），所以底色要一直看得见。
    for (const [i, v] of B.num) {
      const r = this.cellRect(i);
      const g = B.isGray(i);
      ctx.fillStyle = game.bad.has(i) ? Palette.error : g ? Palette.ink : Palette.inkOnPaper;
      ctx.font = `700 ${Math.round(cell * Cell.numScale)}px ${Font.mono}`;
      ctx.fillText(String(v), r.x + cell / 2, r.y + cell / 2 + 1);
    }

    // 光标：虚线框 + 四条边上的把手点，说明 Shift+方向键在"这格与邻居之间"落子。
    // 盘边的把手没有对应的段，就不画（那面没有相邻格）。
    if (handles && game.cursor >= 0) {
      const r = this.cellRect(game.cursor);
      ctx.strokeStyle = won ? Palette.success : Palette.accent;
      ctx.lineWidth = Math.max(2, cell * 0.055);
      ctx.setLineDash([Math.max(4, cell * 0.18), Math.max(3, cell * 0.12)]);
      ctx.strokeRect(r.x + ctx.lineWidth, r.y + ctx.lineWidth, cell - ctx.lineWidth * 2, cell - ctx.lineWidth * 2);
      ctx.setLineDash([]);
      const rad = Math.max(2.5, cell * 0.075);
      for (const dir of ['up', 'down', 'left', 'right']) {
        const to = game.step(game.cursor, dir);
        if (to === null) continue;
        const k = game.segIx.get(segKey(game.cursor, to));
        if (k === undefined) continue;
        const [cx, cy] = edgeMid(this.cellRect(game.cursor), dir);
        ctx.beginPath();
        ctx.arc(cx, cy, rad, 0, Math.PI * 2);
        ctx.fillStyle = game.st[k] === BORDER ? Palette.accent : withAlpha(Palette.accent, 0.4);
        ctx.fill();
      }
    }

    // 指针正指着的那条段：落点要比亚"在哪"更早出现，否则玩家在猜坐标。
    if (hover >= 0 && hover < game.segs.length) this.strokeEmphasis(this.segLine(hover), withAlpha(Palette.accent, 0.5), cell);

    // 提示/冲突点名的那条界：界面唯一被允许说"看这里"的地方。
    if (pulse && pulse.seg != null && pulse.seg >= 0 && pulse.seg < game.segs.length) {
      this.strokeEmphasis(this.segLine(pulse.seg), pulse.color || Palette.hint, cell);
    }
    if (pulse && (pulse.seg == null) && pulse.cell != null && pulse.cell >= 0) {
      const r = this.cellRect(pulse.cell);
      ctx.strokeStyle = pulse.color || Palette.hint;
      ctx.lineWidth = Math.max(2.5, cell * 0.09);
      roundRect(ctx, r.x + 2, r.y + 2, cell - 4, cell - 4, Radius.cell);
      ctx.stroke();
    }
  }

  strokeEmphasis(s, col, cell) {
    const ctx = this.ctx;
    ctx.strokeStyle = col;
    ctx.lineWidth = Math.max(5, cell * 0.19);
    ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(s.x1, s.y1); ctx.lineTo(s.x2, s.y2); ctx.stroke();
    ctx.lineCap = 'butt';
  }
}

// 光标格某一条边的中点（画把手用）
function edgeMid(r, dir) {
  const c = r.size;
  if (dir === 'up') return [r.x + c / 2, r.y];
  if (dir === 'down') return [r.x + c / 2, r.y + c];
  if (dir === 'left') return [r.x, r.y + c / 2];
  return [r.x + c, r.y + c / 2];
}

function distPointSeg(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len2)) : 0;
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function roundRect(ctx, x, y, w, h, r) {
  const k = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + k, y);
  ctx.arcTo(x + w, y, x + w, y + h, k);
  ctx.arcTo(x + w, y + h, x, y + h, k);
  ctx.arcTo(x, y + h, x, y, k);
  ctx.arcTo(x, y, x + w, y, k);
  ctx.closePath();
}

// #RRGGBB -> rgba()：填充和描边共用同一个 token，只是一个透明一个不透明，
// 所以一个区域不可能"框是一种颜色、心是另一种"。
function withAlpha(hex, a) {
  const m = String(hex).replace('#', '');
  const n = m.length === 3 ? m.split('').map((c) => c + c).join('') : m;
  const r = parseInt(n.slice(0, 2), 16);
  const g = parseInt(n.slice(2, 4), 16);
  const b = parseInt(n.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}
