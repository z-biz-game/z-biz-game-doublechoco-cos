// 最小 PNG 解码器（node 标准库 only：fs + zlib）。
//
// 为什么仓里要自己有一份：闸必须读**盘上像素**，不能只读文件名与 IHDR。
// "纹理真的能用吗"这件事，只有把 IDAT 解出来算一遍才知道——gen_art.py 写的时候
// 认为自己出的是"亮度在底数 ±20 内的可平铺颗粒"，那句话由这解码器在另一侧复算，
// 两边各写一次才算对表（只信生成器自己的断言，等于让写答案的人批自己的卷子）。
//
// 支持：8-bit 灰度/灰+alpha/RGB/RGBA/Palette(ct=3，配合 PLTE+tRNS)，五种 filter 全支持。
// 不支持隔行（Adam7）——gen_art.py 只出 filter 0–4 的非隔行图，出现隔行就抛，不静默降级。
import fs from 'node:fs';
import zlib from 'node:zlib';

const SIG = '89504e470d0a1a0a';

export function decodePNG(abs) {
  const buf = fs.readFileSync(abs);
  if (buf.slice(0, 8).toString('hex') !== SIG) throw new Error(`${abs} 不是 PNG`);
  let off = 8, ihdr = null, plte = null, trns = null;
  const idat = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    const body = buf.slice(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      ihdr = { w: body.readUInt32BE(0), h: body.readUInt32BE(4), depth: body[8], ct: body[9], interlace: body[12] };
    } else if (type === 'PLTE') plte = body;
    else if (type === 'tRNS') trns = body;
    else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (!ihdr) throw new Error(`${abs} 没有 IHDR`);
  if (ihdr.interlace) throw new Error(`${abs} 是隔行 PNG，本解码器不支持（闸会把它判成读不出来）`);
  if (ihdr.depth !== 8) throw new Error(`${abs} 位深 ${ihdr.depth}，本解码器只按 8-bit 算`);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const { w, h, ct } = ihdr;
  const channelsOf = () => (ct === 0 ? 1 : ct === 2 ? 3 : ct === 3 ? 1 : ct === 4 ? 2 : ct === 6 ? 4 : 0);
  const ch = channelsOf();
  if (!ch) throw new Error(`${abs} 颜色类型 ct=${ct} 不认识`);
  const bpp = ch;
  const stride = w * bpp;
  const out = Buffer.alloc(h * stride);
  let pos = 0, prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const ft = raw[pos++];
    const line = Buffer.from(raw.slice(pos, pos + stride));
    pos += stride;
    if (ft === 1) for (let x = bpp; x < stride; x++) line[x] = (line[x] + line[x - bpp]) & 255;
    else if (ft === 2) for (let x = 0; x < stride; x++) line[x] = (line[x] + prev[x]) & 255;
    else if (ft === 3) for (let x = 0; x < stride; x++) line[x] = (line[x] + (((x >= bpp ? line[x - bpp] : 0) + prev[x]) >> 1)) & 255;
    else if (ft === 4) {
      for (let x = 0; x < stride; x++) {
        const a = x >= bpp ? line[x - bpp] : 0, b = prev[x], c = x >= bpp ? prev[x - bpp] : 0;
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        const pr = (pa <= pb && pa <= pc) ? a : pb <= pc ? b : c;
        line[x] = (line[x] + pr) & 255;
      }
    } else if (ft !== 0) throw new Error(`${abs} 第 ${y} 行 filter=${ft} 不支持`);
    line.copy(out, y * stride);
    prev = line;
  }
  // Palette 图统一展开成 RGBA，调用方只需要一种形状。
  let rgba = out, rch = ch;
  if (ct === 3) {
    rgba = Buffer.alloc(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      const p = out[i] * 3, t = trns && trns[out[i]] !== undefined ? trns[out[i]] : 255;
      rgba[i * 4] = plte[p]; rgba[i * 4 + 1] = plte[p + 1]; rgba[i * 4 + 2] = plte[p + 2]; rgba[i * 4 + 3] = t;
    }
    rch = 4;
  } else if (ct === 0 || ct === 4) {
    rgba = Buffer.alloc(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      const g = out[i * ch];
      rgba[i * 4] = g; rgba[i * 4 + 1] = g; rgba[i * 4 + 2] = g;
      rgba[i * 4 + 3] = ch === 2 ? out[i * 2 + 1] : 255;
    }
    rch = 4;
  } else if (ct === 2) {
    rgba = Buffer.alloc(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      rgba[i * 4] = out[i * 3]; rgba[i * 4 + 1] = out[i * 3 + 1]; rgba[i * 4 + 2] = out[i * 3 + 2]; rgba[i * 4 + 3] = 255;
    }
    rch = 4;
  }
  return { w, h, ct, bpp: rch, stride: w * rch, data: rgba };
}

export function pixelAt(img, x, y) {
  const o = y * img.stride + x * img.bpp;
  return [img.data[o], img.data[o + 1], img.data[o + 2], img.data[o + 3]];
}

// 把整张图逐像素合成到给定底色上，返回**去重之后**的合成色集合。
// 算式与两处消费端一致：CSS 的 `background: url(x) repeat, var(--y)` 就是这个 alpha 合成，
// 画布上 fillRect(纯色) 之后 fillRect(pattern) 也是同一个。
// 这里只给"这块底色因此可能取到哪些 RGB"，最坏情况由调用方按自己的墨去比——
// 判据的形状要留在闸里可读，不能塞进工具函数的一行 return。
export function composites(img, base) {
  const seen = new Set(), out = [];
  for (let i = 0; i < img.w * img.h; i++) {
    const o = i * img.bpp;
    const al = img.data[o + 3] / 255;
    const c = [0, 1, 2].map((k) => Math.round(al * img.data[o + k] + (1 - al) * base[k]));
    const key = c.join(',');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}
