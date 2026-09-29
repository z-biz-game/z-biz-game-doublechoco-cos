// 颜色、间距、动效的唯一来源：样式表把这些读成 CSS 自定义属性（applyThemeVars），
// 画布读的是同一批对象。只改一边的话，"区界那一根线是什么颜色"就会裂成四十处。
//
// 这个游戏有两个别处没有的底色：题面给的灰格（巧克力）与白格（白纸）。
// 判据 V3 数的就是这两种颜色的格数，所以"哪一格是灰的"必须在像素上一眼分得开——
// 灰白之间的对比不能靠 alpha 蒙出来，那会让半盘灰看着像半盘白加了一层雾。

export const Palette = {
  bgTop: '#0A0D14',
  bgBottom: '#141A26',
  surface: '#111722',
  surfaceLift: '#1A2231',
  line: '#26303F',
  lineHeavy: '#425168',
  ink: '#F3F6FB',
  inkDim: 'rgba(243,246,251,0.62)',
  inkFaint: 'rgba(243,246,251,0.30)',

  // 玩家的手只有一件事：画区界。所以选中态、提示态、通关横幅共用一个色相，
  // "这是你刚做的动作"在读色上是一个概念。
  accent: '#FFC46B',
  accentEdge: '#FFE0B2',
  accentSoft: 'rgba(255,196,107,0.16)',

  info: '#7BB8FF',
  pencilStrong: '#8FA6CC',
  pencil: 'rgba(243,246,251,0.28)',

  success: '#59D49C',
  error: '#FF5C7A',
  warn: '#FFC85C',
  hint: '#FFC85C',
  focus: 'rgba(255,196,107,0.16)',

  // 题面给的颜色。gray 是"巧克力"，paper 是"白纸"，数字落在哪一种上决定它数的是哪一半（V5）。
  gray: '#3B4557',
  grayDeep: '#2A3242',
  grayEdge: '#55637C',
  paper: '#EDEFF5',
  paperEdge: '#C3CAD8',
  inkOnPaper: '#0F1420',

  // 区界的两种状态：没画 = 点线（题面的 dotted lines），画了 = 粗实线（solid lines）。
  dot: 'rgba(243,246,251,0.34)',
  dotOnPaper: 'rgba(15,20,32,0.28)',
  border: '#F3F6FB',
  borderOnPaper: '#161C28',

  // 区域底色是"玩家自己分出来的块"的回显，不是答案：同一层色只说明"你现在把这几格当成一块"。
  region: ['#59D49C', '#7BB8FF', '#C792EA', '#FFC46B', '#4DD0E1', '#F06292', '#AEEA00', '#FFB74D'],
  regionFill: 'rgba(123,184,255,0.14)',
};

export const Space = { page: 20, card: 16, inner: 12, gutter: 10 };
export const Radius = { card: 18, button: 12, chip: 8, cell: 4 };

export const Font = {
  title: "700 24px/1.25 -apple-system, 'SF Pro Display', system-ui, sans-serif",
  mono: "'SF Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
  sans: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'PingFang SC', system-ui, sans-serif",
};

// 时长守 150–350ms：比这更长会挡住下一次动作，而这一局玩家下一步就在毫秒之后。
export const Motion = {
  tap: 150,
  base: 220,
  pop: 260,
  line: 300,
  win: 900,
  spring: 'cubic-bezier(0.34, 1.45, 0.64, 1)',
  ease: 'cubic-bezier(0.22, 0.61, 0.36, 1)',
};

export const Cell = { min: 30, max: 68, numScale: 0.44, borderScale: 0.13, dotScale: 0.045 };

// 命中容差：一个段只在其法线方向 ±hitRatio·cell 内可点。
// 太宽会把"点格子选光标"吃掉，太窄在 8×8（格子约 34px）上根本点不到。
export const Hit = { segRatio: 0.26, maxCell: 0.46 };

export function applyThemeVars() {
  const root = document.documentElement.style;
  const kebab = (s) => s.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase());
  for (const [k, v] of Object.entries(Palette)) {
    if (Array.isArray(v)) continue;
    root.setProperty('--' + kebab(k), v);
  }
  Palette.region.forEach((c, i) => root.setProperty('--region-' + i, c));
  for (const [k, v] of Object.entries(Space)) root.setProperty('--space-' + k, v + 'px');
  for (const [k, v] of Object.entries(Radius)) root.setProperty('--radius-' + k, v + 'px');
  for (const [k, v] of Object.entries(Motion)) {
    if (typeof v === 'number') root.setProperty('--dur-' + kebab(k), v + 'ms');
    else root.setProperty('--ease-' + kebab(k), v);
  }
  root.setProperty('--font-mono', Font.mono);
  root.setProperty('--font-sans', Font.sans);
}

// 系统偏好是下限，游戏内开关只能往上加：OS 设了"减少动效"时不该被页面上的开关否决。
let motionReduced = false;

export function setReduceMotion(v) {
  motionReduced = !!v;
}

export const systemPrefersReducedMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export const prefersReducedMotion = () => motionReduced || systemPrefersReducedMotion();
