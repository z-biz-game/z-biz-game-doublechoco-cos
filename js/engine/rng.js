// 种子随机。两条硬约束（都是被实测咬过的）：
//   1) 确定性必须跨引擎成立：随机性只放在**置换**里，不放在比较器里。
//      sort 的比较器里抽随机数会让 node 和 chrome 画出两张不同的盘，"同一 seed 同一盘"就是谎。
//   2) 默认 seed 不能按日期/时间算：那会让界面上印着的 seed 明天就对不上号（存档里带游标）。
export function rng(seed) {
  let a = (seed >>> 0) || 1;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: n => Math.floor(next() * n),
    // Fisher-Yates：打乱的是数组本身，不是"带随机数的比较器"
    shuffle(arr) {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
      }
      return arr;
    },
  };
}
