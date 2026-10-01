#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""DOUBLE CHOCO 的美术资产生成器（仓内、可复跑、只用 python3 标准库）。

为什么手写 PNG 而不依赖 Pillow：这一仓是零构建静态站，资产的生产必须能在任何一台
只装了 python3 的机器上复跑（CI 里 pip 不到 Pillow 也要能重新出货）。PNG 编码用
zlib + struct 自己写，像素用一张 RGBA bytearray 自己画。

视觉母题**由玩法决定**，不是凭空挑一张图：
  DOUBLE CHOCO 的唯一事实是「一块 = 一格巧克力 + 一格同形的白纸」，
  玩家唯一的落子是把这两种颜色之间钉出界。所以母题就是那张 2×2 的棋盘：
  对角同色（巧克力灰 / 纸白），中间一道琥珀色的十字 = 玩家画下的区界。
  颜色一个都不新编：全部取自 js/theme.js 的 Palette（bg/gray/paper/accent 那批），
  读回来的表写进 assets/gen/palette.json，页面上的画布与图标因此不可能各说一套。

产物（全部是真位图，路径由 --report 打出来）：
  icons/         1024 母图 + 各尺寸派生 + maskable + apple-touch + favicon
  icons/og-cover.png  社交卡（1200x630），标题用仓内手写的 5x7 位图字体排（不依赖系统字体）
  assets/texture/     游戏内用的两张可平铺纹理（巧克力细磨纹、纸纤维）
  assets/sprite/      画布用的精灵（琥珀脉冲光点、通关星点）

用法:  python3 assets/gen/gen_art.py            # 生成到仓根
       python3 assets/gen/gen_art.py --report    # 只打印产物清单与 IHDR 实测
"""
import json
import math
import os
import struct
import sys
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..', '..'))

# ---------------------------------------------------------------- 调色（theme.js 同源）
# js/theme.js 里的 Palette 是七位十六进制；这里用正则读回来，不另抄一份数值，
# 否则「图标是琥珀色而画布上的区界是别的颜色」这种漂就永远测不出来。
def palette_from_theme():
    src = open(os.path.join(REPO, 'js', 'theme.js'), encoding='utf-8').read()
    import re
    out = {}
    for k, v in re.findall(r"^\s*([A-Za-z][A-Za-z0-9]*)\s*:\s*'#([0-9A-Fa-f]{6})'", src, re.M):
        out[k] = (int(v[0:2], 16), int(v[2:4], 16), int(v[4:6], 16))
    need = ['bgTop', 'bgBottom', 'surface', 'gray', 'grayDeep', 'grayEdge',
            'paper', 'paperEdge', 'inkOnPaper', 'accent', 'accentEdge', 'success', 'info']
    miss = [k for k in need if k not in out]
    if miss:
        raise SystemExit('js/theme.js 里读不到这些 token：%s —— 生成器与画布就此分家，拒绝出货' % miss)
    return out

PAL = palette_from_theme()
BG_T = PAL['bgTop']
BG_B = PAL['bgBottom']
SURF = PAL['surface']
CHOCO = PAL['gray']
CHOCO_DK = PAL['grayDeep']
CHOCO_HI = PAL['grayEdge']
PAPER = PAL['paper']
PAPER_DK = PAL['paperEdge']
INK = PAL['inkOnPaper']
AMBER = PAL['accent']
AMBER_HI = PAL['accentEdge']
GREEN = PAL['success']
BLUE = PAL['info']


def mix(a, b, t):
    return (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t)


# ---------------------------------------------------------------- 确定性噪声
class Lcg:
    """自己实现的 LCG：整条生成链不许碰 random/Math.random，否则两次跑出的资产不同，
    「可复现」就只是一句说法。"""

    def __init__(self, seed=0x2C0C0):
        self.s = seed & 0xFFFFFFFF

    def u32(self):
        self.s = (1664525 * self.s + 1013904223) & 0xFFFFFFFF
        return self.s

    def f(self):
        return self.u32() / 4294967296.0


def hash2(ix, iy, seed):
    """整数坐标 → [0,1)：value noise 的格点源。周期由调用方取模保证平铺。"""
    h = (ix * 374761393 + iy * 668265263 + seed * 1442695041) & 0xFFFFFFFF
    h = (h ^ (h >> 13)) & 0xFFFFFFFF
    h = (h * 1274126177) & 0xFFFFFFFF
    return ((h ^ (h >> 16)) & 0xFFFFFFFF) / 4294967296.0


def smooth(t):
    return t * t * (3.0 - 2.0 * t)


def value_noise(x, y, period, seed):
    """可平铺的 value noise：格点坐标对 period 取模，所以左右/上下边界接得上。"""
    xi = int(math.floor(x))
    yi = int(math.floor(y))
    tx = smooth(x - xi)
    ty = smooth(y - yi)
    m = period
    a = hash2(xi % m, yi % m, seed)
    b = hash2((xi + 1) % m, yi % m, seed)
    c = hash2(xi % m, (yi + 1) % m, seed)
    d = hash2((xi + 1) % m, (yi + 1) % m, seed)
    u = a + (b - a) * tx
    v = c + (d - c) * tx
    return u + (v - u) * ty


def fbm(x, y, period, seed, octaves=3):
    tot = 0.0
    amp = 1.0
    norm = 0.0
    p = period
    for _ in range(octaves):
        tot += amp * value_noise(x, y, p, seed)
        norm += amp
        amp *= 0.5
        p *= 2
        x *= 2.0
        y *= 2.0
    return tot / norm


# ---------------------------------------------------------------- 画布
class Buf:
    """一张 RGBA 位图。float 累加缓冲 + 一次成图：所有绘制都是 alpha 合成。"""

    def __init__(self, w, h):
        self.w = w
        self.h = h
        self.px = bytearray(w * h * 4)

    def set_px(self, x, y, r, g, b, a):
        if a <= 0.0:
            return
        if x < 0 or y < 0 or x >= self.w or y >= self.h:
            return
        k = (y * self.w + x) * 4
        px = self.px
        if a >= 1.0:
            px[k] = int(r)
            px[k + 1] = int(g)
            px[k + 2] = int(b)
            px[k + 3] = 255
            return
        da = a                                   # 源 alpha
        db = px[k + 3] / 255.0                   # 目标 alpha
        oa = da + db * (1.0 - da)
        if oa <= 0:
            return
        for i, v in enumerate((r, g, b)):
            prev = px[k + i] / 255.0
            px[k + i] = int(((v / 255.0) * da + prev * db * (1.0 - da)) / oa * 255.0 + 0.5)
        px[k + 3] = int(oa * 255.0 + 0.5)

    def fill(self, col):
        r, g, b = (int(c) for c in col)
        row = bytes((r, g, b, 255)) * self.w
        for y in range(self.h):
            self.px[y * self.w * 4:(y + 1) * self.w * 4] = row

    def vgrad(self, top, bottom):
        w, h, px = self.w, self.h, self.px
        for y in range(h):
            t = y / (h - 1.0) if h > 1 else 0.0
            r, g, b = (int(top[i] + (bottom[i] - top[i]) * t) for i in range(3))
            row = bytes((r, g, b, 255)) * w
            px[y * w * 4:(y + 1) * w * 4] = row

    def rect(self, x0, y0, x1, y1, col, a=1.0):
        for y in range(int(y0), int(y1)):
            for x in range(int(x0), int(x1)):
                self.set_px(x, y, col[0], col[1], col[2], a)

    # ---- 带圆角与柔边的形状：用 SDF + 1px 线性覆盖做抗锯齿（每像素一次判定） ----
    def round_box(self, cx, cy, bw, bh, rad, shade_fn):
        """shade_fn(x, y, coverage) -> (r,g,b,a) | None；coverage∈[0,1]。"""
        w, h = self.w, self.h
        bx = bw / 2.0
        by = bh / 2.0
        r = min(rad, bx, by)
        x0 = max(0, int(math.floor(cx - bx - 1)))
        x1 = min(w, int(math.ceil(cx + bx + 1)))
        y0 = max(0, int(math.floor(cy - by - 1)))
        y1 = min(h, int(math.ceil(cy + by + 1)))
        for y in range(y0, y1):
            dy = abs(y + 0.5 - cy) - (by - r)
            for x in range(x0, x1):
                dx = abs(x + 0.5 - cx) - (bx - r)
                ax = dx if dx > 0 else 0.0
                ay = dy if dy > 0 else 0.0
                dist = math.hypot(ax, ay) + max(dx, dy, 0.0) - r
                cov = 0.0 if dist > 0.5 else (1.0 if dist < -0.5 else 0.5 - dist)
                if cov > 0.0:
                    shade_fn(x, y, cov)

    def capsule(self, x0, y0, x1, y1, half, shade_fn):
        """两端圆的粗线段（= 玩家画下的那条区界）。"""
        vx = x1 - x0
        vy = y1 - y0
        L = math.hypot(vx, vy) or 1.0
        ux, uy = vx / L, vy / L
        nx, ny = -uy, ux
        lo_x = min(x0, x1) - half - 1
        hi_x = max(x0, x1) + half + 1
        lo_y = min(y0, y1) - half - 1
        hi_y = max(y0, y1) + half + 1
        for y in range(max(0, int(lo_y)), min(self.h, int(hi_y) + 1)):
            py = y + 0.5 - y0
            for x in range(max(0, int(lo_x)), min(self.w, int(hi_x) + 1)):
                px_ = x + 0.5 - x0
                t = px_ * ux + py * uy
                tc = 0.0 if t < 0 else (L if t > L else t)
                dx = px_ - ux * tc
                dy = py - uy * tc
                d = math.hypot(dx, dy) - half
                cov = 0.0 if d > 0.5 else (1.0 if d < -0.5 else 0.5 - d)
                if cov > 0.0:
                    shade_fn(x, y, cov, t / L)

    def disc(self, cx, cy, rad, shade_fn):
        for y in range(max(0, int(cy - rad - 1)), min(self.h, int(cy + rad + 2))):
            for x in range(max(0, int(cx - rad - 1)), min(self.w, int(cx + rad + 2))):
                d = math.hypot(x + 0.5 - cx, y + 0.5 - cy) - rad
                cov = 0.0 if d > 0.5 else (1.0 if d < -0.5 else 0.5 - d)
                if cov > 0.0:
                    shade_fn(x, y, cov)

    def downscale(self, n):
        """整数盒式降采样（2x/4x…）：派生尺寸全部由母图缩出来，不重画一遍，
        所以 16px 的 favicon 与 1024 的商店图是同一张画，只是采得稀。"""
        w, h, px = self.w, self.h, self.px
        if n <= 1:
            return self
        nw, nh = w // n, h // n
        out = Buf(nw, nh)
        op = out.px
        k = 0
        inv = 1.0 / (n * n)
        for y in range(nh):
            yb = y * n
            for x in range(nw):
                xb = x * n
                s0 = s1 = s2 = s3 = 0
                for j in range(n):
                    row = ((yb + j) * w + xb) * 4
                    for i in range(n):
                        o = row + i * 4
                        s0 += px[o]
                        s1 += px[o + 1]
                        s2 += px[o + 2]
                        s3 += px[o + 3]
                op[k] = int(s0 * inv + 0.5)
                op[k + 1] = int(s1 * inv + 0.5)
                op[k + 2] = int(s2 * inv + 0.5)
                op[k + 3] = int(s3 * inv + 0.5)
                k += 4
        return out


    def resample(self, nw, nh):
        """任意倍率的面积平均：派生尺寸一律从 1024 母图缩出来。
        只有 2 的幂能被整数盒式降采样覆盖（48/96/180/192 不能），为它们各画一遍
        会让同一套图标出现两种画法 —— 那正是「16px 认不出、1024 好看」的成因。"""
        w, h, px = self.w, self.h, self.px
        out = Buf(nw, nh)
        op = out.px
        sx = w / float(nw)
        sy = h / float(nh)
        k = 0
        for y in range(nh):
            y0 = int(math.floor(y * sy))
            y1 = max(y0 + 1, int(math.ceil((y + 1) * sy)))
            for x in range(nw):
                x0 = int(math.floor(x * sx))
                x1 = max(x0 + 1, int(math.ceil((x + 1) * sx)))
                s0 = s1 = s2 = s3 = n = 0
                for yy in range(y0, y1):
                    row = yy * w * 4
                    for xx in range(x0, x1):
                        o = row + xx * 4
                        s0 += px[o]
                        s1 += px[o + 1]
                        s2 += px[o + 2]
                        s3 += px[o + 3]
                        n += 1
                op[k] = s0 // n
                op[k + 1] = s1 // n
                op[k + 2] = s2 // n
                op[k + 3] = s3 // n
                k += 4
        return out

    def sample(self, x, y):
        o = (int(y) * self.w + int(x)) * 4
        return (self.px[o], self.px[o + 1], self.px[o + 2], self.px[o + 3])


# ---------------------------------------------------------------- PNG 编码（zlib 手写）
def write_png(path, buf):
    w, h, px = buf.w, buf.h, buf.px
    stride = w * 4
    raw = bytearray()
    for y in range(h):
        raw.append(0)                       # filter type 0 (None) —— 交给 zlib 去压
        raw += px[y * stride:(y + 1) * stride]
    def chunk(tag, data):
        return (struct.pack('>I', len(data)) + tag + data
                + struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF))
    ihdr = struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0)
    blob = (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr)
            + chunk(b'IDAT', zlib.compress(bytes(raw), 9))
            + chunk(b'IEND', b''))
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'wb') as fh:
        fh.write(blob)
    return len(blob)


# ---------------------------------------------------------------- 母题
def choco_shade(x, y, n, seed=7):
    """巧克力：竖向的脱模光泽 + 细磨颗粒。n 是格内归一化坐标。"""
    sheen = 0.5 + 0.5 * math.sin(n * math.pi)
    grain = fbm(x / 7.0, y / 7.0, 16, seed, 3)
    t = 0.30 * sheen + 0.34 * grain - 0.16
    return mix(CHOCO_DK, CHOCO_HI, max(0.0, min(1.0, 0.5 + t)))


def paper_shade(x, y, n, seed=11):
    """白纸：纤维 + 极淡的印格（题面给的虚线在这一层只是纹理，不抢戏）。"""
    fibre = fbm(x / 4.0, y / 4.0, 32, seed, 2)
    speck = 1.0 if hash2(x, y, 23) > 0.986 else 0.0
    t = 0.55 + 0.42 * fibre + 0.18 * speck - 0.30 * n * 0.3
    return mix(PAPER_DK, PAPER, max(0.0, min(1.0, t)))


def draw_board(buf, cx, cy, side, seed=7):
    """那一张 2×2：对角同色 + 中间一道琥珀十字。cell = 一格（一块巧克力或一张纸）的边长。
    排列照题面：左上灰、右上纸、左下纸、右下灰 —— 也就是「每一块都是一白加一灰」。
    逐格作图（一格一个 round_box），因为「哪一格是什么颜色」是这一盘的题面，
    不该由一整块的坐标反推出来 —— 上一版就是这么画的，出货后认不出是一张盘。"""
    cell = side / 2.0
    gap = cell * 0.055          # 格与格之间的发丝缝：题面那条没画的点线在图上的对应物
    for row in (0, 1):
        for col in (0, 1):
            grayish = (row + col) % 2 == 0
            bx = cx - side / 2.0 + col * cell + cell / 2.0
            by = cy - side / 2.0 + row * cell + cell / 2.0

            def shade(x, y, cov, bx=bx, by=by, grayish=grayish, cell=cell, seed=seed):
                fy = (y - by) / cell + 0.5          # 格内 0..1
                fx = (x - bx) / cell + 0.5
                if grayish:
                    c = choco_shade(x, y, fy, seed)
                    if fy < 0.10:                   # 巧克力有厚度：上沿受光
                        c = mix(c, CHOCO_HI, 0.55 * (0.10 - fy) / 0.10)
                    elif fy > 0.90:                 # 下沿落进影子里
                        c = mix(c, CHOCO_DK, 0.8 * (fy - 0.90) / 0.10)
                    if fx < 0.06:
                        c = mix(c, CHOCO_DK, 0.5 * (0.06 - fx) / 0.06)
                else:
                    c = paper_shade(x, y, fy, seed + 3)
                buf.set_px(x, y, c[0], c[1], c[2], cov)

            buf.round_box(bx, by, cell - gap, cell - gap, cell * 0.075, shade)

    # 琥珀十字：横竖各一条胶囊，压在缝上 —— 玩家唯一的落子就是这一条界
    half = max(1.5, side * 0.052)

    def glow(x, y, cov, _t):
        c = mix(AMBER, AMBER_HI, 0.25 + 0.5 * cov)
        buf.set_px(x, y, c[0], c[1], c[2], cov)

    def halo(x, y, cov, _t):
        buf.set_px(x, y, AMBER[0], AMBER[1], AMBER[2], cov * 0.16)

    for (x0, y0, x1, y1) in ((cx - side / 2.0, cy, cx + side / 2.0, cy),
                             (cx, cy - side / 2.0, cx, cy + side / 2.0)):
        buf.capsule(x0, y0, x1, y1, half * 2.6, halo)
        buf.capsule(x0, y0, x1, y1, half, glow)


def draw_icon(size, maskable=False):
    ss = 2 if size <= 512 else 1        # 小图超采样 2x，母图直接画（省一半时间）
    W = size * ss
    buf = Buf(W, W)
    buf.vgrad(BG_T, BG_B)
    # 卡片底：一整块圆角石板，图标在任何背景上都是一个整体
    side = W * (0.72 if maskable else 0.88)
    rad = W * 0.22

    def card(x, y, cov):
        t = (y + 0.5) / W
        base = mix(SURF, BG_B, 0.15 + 0.5 * t)
        # 顶边一条极淡的高光，卡片才不像贴上去的纸片
        if y < W * 0.06:
            base = mix(base, (255, 255, 255), 0.05 * (1 - y / (W * 0.06)))
        buf.set_px(x, y, base[0], base[1], base[2], cov)

    buf.round_box(W / 2.0, W / 2.0, side, side, rad * (side / (W * 0.88)), card)
    draw_board(buf, W / 2.0, W / 2.0, side * 0.62)
    return buf.downscale(ss)


# ---------------------------------------------------------------- 位图字体（5x7）
# 手写而非依赖系统字体：社交卡上的字必须在任何机器上都排成同一副样子。
FONT = {
    'A': '01110 10001 10001 11111 10001 10001 10001',
    'B': '11110 10001 10001 11110 10001 10001 11110',
    'C': '01110 10001 10000 10000 10000 10001 01110',
    'D': '11110 10001 10001 10001 10001 10001 11110',
    'E': '11111 10000 10000 11110 10000 10000 11111',
    'F': '11111 10000 10000 11110 10000 10000 10000',
    'G': '01110 10001 10000 10111 10001 10001 01111',
    'H': '10001 10001 10001 11111 10001 10001 10001',
    'I': '11111 00100 00100 00100 00100 00100 11111',
    'J': '00111 00010 00010 00010 00010 10010 01100',
    'K': '10001 10010 10100 11000 10100 10010 10001',
    'L': '10000 10000 10000 10000 10000 10000 11111',
    'M': '10001 11011 10101 10101 10001 10001 10001',
    'N': '10001 11001 10101 10011 10001 10001 10001',
    'O': '01110 10001 10001 10001 10001 10001 01110',
    'P': '11110 10001 10001 11110 10000 10000 10000',
    'Q': '01110 10001 10001 10001 10101 10011 01111',
    'R': '11110 10001 10001 11110 10100 10010 10001',
    'S': '01111 10000 10000 01110 00001 00001 11110',
    'T': '11111 00100 00100 00100 00100 00100 00100',
    'U': '10001 10001 10001 10001 10001 10001 01110',
    'V': '10001 10001 10001 10001 10001 01010 00100',
    'W': '10001 10001 10001 10101 10101 11011 10001',
    'X': '10001 10001 01010 00100 01010 10001 10001',
    'Y': '10001 10001 01010 00100 00100 00100 00100',
    'Z': '11111 00001 00010 00100 01000 10000 11111',
    '0': '01110 10001 10011 10101 11001 10001 01110',
    '1': '00100 01100 00100 00100 00100 00100 01110',
    '2': '01110 10001 00001 00010 00100 01000 11111',
    '3': '11110 00001 00001 01110 00001 00001 11110',
    '4': '10001 10001 10001 11111 00001 00001 00001',
    '5': '11111 10000 11110 00001 00001 10001 01110',
    '6': '01110 10000 10000 11110 10001 10001 01110',
    '7': '11111 00001 00010 00100 00100 00100 00100',
    '8': '01110 10001 10001 01110 10001 10001 01110',
    '9': '01110 10001 10001 01111 00001 00001 01110',
    ' ': '00000 00000 00000 00000 00000 00000 00000',
    '.': '00000 00000 00000 00000 00000 01100 01100',
    '-': '00000 00000 00000 11111 00000 00000 00000',
    '/': '00001 00010 00010 00100 01000 01000 10000',
    '·': '00000 00000 01100 01100 01100 00000 00000',
}


def text(buf, s, x, y, scale, col, alpha=1.0):
    """左上角排版，返回写完后的 x。字间距 1 个像素单元。"""
    for ch in s.upper():
        g = FONT.get(ch) or FONT[' ']
        rows = g.split(' ')
        for ry, bits in enumerate(rows):
            for rx, b in enumerate(bits):
                if b != '1':
                    continue
                buf.rect(x + rx * scale, y + ry * scale,
                         x + (rx + 1) * scale, y + (ry + 1) * scale, col, alpha)
        x += 6 * scale
    return x


def text_w(s, scale):
    return len(s) * 6 * scale - scale


def draw_og():
    W, H = 1200, 630
    buf = Buf(W, H)
    buf.vgrad(BG_T, mix(BG_B, (0, 0, 0), 0.25))
    rnd = Lcg(0x2C0C0)
    # 背景一层极淡的棋盘：这盘的底纹本身就是母题
    cell = 90
    for gy in range((H + cell - 1) // cell):
        for gx in range((W + cell - 1) // cell):
            if (gx + gy) % 2:
                continue
            buf.rect(gx * cell, gy * cell, gx * cell + cell, gy * cell + cell,
                     CHOCO_DK, 0.16 + 0.06 * rnd.f())
    # 右半边一块真的 2×2 盘（与图标同一张画）：圆心 W-185、边长 320 ⇒ 占 x∈[855,1175]
    draw_board(buf, W - 185, H / 2.0, 320, seed=19)
    # 左栏：字号按"最长那行不许越过 x=855"定（每字符占 6·scale，实测见 self_check）
    ty = 150
    tx = text(buf, 'DOUBLE CHOCO', 76, ty, 9, AMBER)
    text(buf, 'A BLOCK IS ONE PAPER', 76, ty + 104, 4, PAPER, 0.92)
    text(buf, 'PLUS ONE SAME-SHAPED CHOCO', 76, ty + 146, 4, CHOCO_HI, 0.95)
    text(buf, 'DRAW THE BORDERS - NO GUESSING', 76, ty + 214, 3, mix(AMBER, PAPER, 0.4), 0.85)
    text(buf, 'ONE SOLUTION · A NAMED RULE PER CUT', 76, ty + 262, 3, PAPER_DK, 0.7)
    # 底部一条琥珀的「区界」收边
    def line(x, y, cov, _t, half=4.0):
        buf.set_px(x, y, AMBER[0], AMBER[1], AMBER[2], cov * 0.8)
    buf.capsule(76, H - 96, tx - 12, H - 96, 4, line)
    return buf


def draw_tile(kind, size=256):
    """游戏内用的可平铺纹理：巧克力细磨 / 纸纤维。alpha 通道带着走，
    这样画布叠上去时只加质感、不改题面给的两色（判据 V3 数的是颜色，不能被纹理改掉）。"""
    buf = Buf(size, size)
    buf.fill((0, 0, 0))
    for y in range(size):
        for x in range(size):
            if kind == 'choco':
                v = fbm(x / 6.0, y / 6.0, 12, 31, 3)
                swirl = 0.5 + 0.5 * math.sin((x * 0.05) + 3.0 * fbm(x / 40.0, y / 40.0, 6, 33, 2))
                a = max(0.0, (v - 0.42)) * 1.7 * (0.55 + 0.45 * swirl)
                col = mix(CHOCO_HI, CHOCO_DK, v)
            else:
                v = fbm(x / 3.0, y / 3.0, 40, 41, 3)
                fibre = fbm(x / 26.0, y / 2.0, 10, 43, 2)
                a = max(0.0, (v - 0.5)) * 1.4 + max(0.0, (fibre - 0.62)) * 0.9
                col = mix(PAPER_DK, (255, 255, 255), 0.5 + 0.5 * v)
            k = (y * size + x) * 4
            buf.px[k] = int(col[0])
            buf.px[k + 1] = int(col[1])
            buf.px[k + 2] = int(col[2])
            buf.px[k + 3] = int(min(1.0, a) * 255.0)
    return buf


def draw_sprite(kind, size):
    buf = Buf(size, size)
    buf.fill((0, 0, 0))
    c = size / 2.0
    col = AMBER if kind == 'pulse' else GREEN
    for y in range(size):
        for x in range(size):
            d = math.hypot(x + 0.5 - c, y + 0.5 - c) / c
            if kind == 'pulse':
                a = max(0.0, 1.0 - d) ** 2.4
                ring = math.exp(-((d - 0.62) ** 2) / 0.012) * 0.55
                a = min(1.0, a + ring)
            else:
                arm = abs(math.sin(4.0 * math.atan2(y + 0.5 - c, x + 0.5 - c)))
                a = max(0.0, 1.0 - d) ** 3.0 * (0.25 + 0.75 * arm ** 2)
            k = (y * size + x) * 4
            buf.px[k] = col[0]
            buf.px[k + 1] = col[1]
            buf.px[k + 2] = col[2]
            buf.px[k + 3] = int(a * 255.0)
    return buf


ICON_SIZES = [1024, 512, 192, 180, 96, 64, 48, 32, 16]


def self_check():
    """资产自己报读数：图标必须真的能读出一张 2×2 的盘。
    判据不是「文件存在」而是**采样点的位置对上了题面**：四格中心各自更接近题面给的那两种
    底色（巧克力灰 / 纸白），十字中心必须是琥珀色。任何一条不成立就非零退出——
    一张认不出玩法的图标比没有图标更糟，它会让这一项看起来像做完了。"""
    m = draw_icon(512)
    c = 256.0
    q = 512 * 0.135          # 格心偏移：盘占 0.88*0.62，一格半边 = 512*0.88*0.62/4
    def d(a, b):
        return sum((a[i] - b[i]) ** 2 for i in range(3)) ** 0.5
    rows = []
    bad = 0
    for name, (sx, sy), want, other in (
        ('TL/choco', (c - q, c - q), CHOCO, PAPER),
        ('BR/choco', (c + q, c + q), CHOCO, PAPER),
        ('TR/paper', (c + q, c - q), PAPER, CHOCO),
        ('BL/paper', (c - q, c + q), PAPER, CHOCO),
    ):
        col = m.sample(sx, sy)[:3]
        hit = d(col, want) < d(col, other)
        bad += 0 if hit else 1
        rows.append('%s=#%02X%02X%02X %s' % (name, col[0], col[1], col[2], 'ok' if hit else 'RED'))
    cross = m.sample(c, c - 5)[:3]
    okc = d(cross, AMBER) < d(cross, PAPER)
    bad += 0 if okc else 1
    rows.append('cross=#%02X%02X%02X d(amber)=%.0f d(paper)=%.0f %s'
                % (cross[0], cross[1], cross[2], d(cross, AMBER), d(cross, PAPER), 'ok' if okc else 'RED'))
    s16 = draw_icon(16)
    lum = lambda col: 0.2126 * col[0] + 0.7152 * col[1] + 0.0722 * col[2]
    d16 = abs(lum(s16.sample(5, 5)[:3]) - lum(s16.sample(10, 5)[:3]))
    ok16 = d16 >= 40
    bad += 0 if ok16 else 1
    rows.append('16px 对角亮度差=%.1f %s' % (d16, 'ok' if ok16 else 'RED'))
    # 合成自检：半透明的琥珀压在深底上必须真的改变像素。上一版公式把源色(0..255)与
    # 目标色(0..1)的量纲混在一起，结果是所有 alpha 层都不落地——图"少几笔"但不报错。
    t = Buf(4, 4)
    t.fill(BG_T)
    before = t.sample(1, 1)[:3]
    t.set_px(1, 1, AMBER[0], AMBER[1], AMBER[2], 0.5)
    after = t.sample(1, 1)[:3]
    moved = sum(abs(after[i] - before[i]) for i in range(3))
    okb = 100 <= moved <= 400
    bad += 0 if okb else 1
    rows.append('blend50%% #%02X%02X%02X→#%02X%02X%02X Δ=%d %s'
                % (before + after + (moved, 'ok' if okb else 'RED')))
    # 版式：左栏最长一行的右边界不许越过盘的左边界（上一版靠眼睛排版，副标题压在盘上）
    lines = [('DOUBLE CHOCO', 9), ('A BLOCK IS ONE PAPER', 4), ('PLUS ONE SAME-SHAPED CHOCO', 4),
             ('DRAW THE BORDERS - NO GUESSING', 3), ('ONE SOLUTION · A NAMED RULE PER CUT', 3)]
    right = max(76 + text_w(s, k) for s, k in lines)
    okl = right <= 855
    bad += 0 if okl else 1
    rows.append('og 左栏右边界=%d ≤855 %s' % (right, 'ok' if okl else 'RED'))
    print('self-check: ' + ' | '.join(rows))
    return bad == 0


def build_all(report=False, check=False):
    written = []

    def put(rel, buf):
        n = write_png(os.path.join(REPO, rel), buf)
        written.append({'path': rel, 'w': buf.w, 'h': buf.h, 'bytes': n})

    master = draw_icon(1024)
    put('icons/icon-1024.png', master)
    for s in ICON_SIZES:
        if s == 1024:
            continue
        put('icons/icon-%d.png' % s, master.resample(s, s))
    # apple-touch-icon 是 iOS 按**文件名**找的，内容仍从同一张母图缩出来（不是另画一张）
    put('icons/apple-touch-icon.png', master.resample(180, 180))
    mask = draw_icon(1024, maskable=True)
    put('icons/icon-maskable-1024.png', mask)
    for s in (512, 192):
        put('icons/icon-maskable-%d.png' % s, mask.resample(s, s))
    put('icons/og-cover.png', draw_og())
    put('assets/texture/choco-grain.png', draw_tile('choco', 256))
    put('assets/texture/paper-fibre.png', draw_tile('paper', 256))
    put('assets/sprite/pulse-glow.png', draw_sprite('pulse', 128))
    put('assets/sprite/win-spark.png', draw_sprite('spark', 96))

    man = {
        'generator': 'assets/gen/gen_art.py',
        'motif': '2x2 double-choco board: paper + same-shaped choco, amber border cross',
        'palette': {k: '#%02X%02X%02X' % v for k, v in
                    (('bgTop', BG_T), ('gray', CHOCO), ('paper', PAPER), ('accent', AMBER))},
        'files': written,
    }
    with open(os.path.join(REPO, 'assets', 'gen', 'manifest.json'), 'w', encoding='utf-8') as fh:
        json.dump(man, fh, indent=1, ensure_ascii=False)
    if report:
        for f in written:
            print('%-34s %5dx%-5d %7d B' % (f['path'], f['w'], f['h'], f['bytes']))
    print('files=%d' % len(written))
    if check and not self_check():
        return None
    return man


if __name__ == '__main__':
    sys.exit(0 if build_all(report='--report' in sys.argv, check='--verify' in sys.argv) else 1)
