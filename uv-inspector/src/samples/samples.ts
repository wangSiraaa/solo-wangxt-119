import { MeshBuilder } from '../model/builder';
import type { MeshData } from '../model/types';

export interface SampleDef {
  id: string;
  label: string;
  description: string;
  build: () => MeshData;
}

/**
 * 样例 1：镜像岛 + 共享边接缝
 * 两张四方面片沿位置边 AB 折成 90°（像翻开的书）。
 * - 位置面身份：8 个位置顶点，A/B 被两侧面共享（接缝位置边）。
 * - UV 身份：两侧各自独立的 UV 顶点（接缝处不共享），岛 2 的 U 被镜像，
 *   其两个三角面都会被标为翻转，岛整体标为 mirrored。
 */
function buildMirroredSeam(): MeshData {
  const b = new MeshBuilder();
  // 位置：y=0 面片 A B C D；z=0 面片 E F A B
  const A = b.addPos(0, 0, 0);
  const B = b.addPos(1, 0, 0);
  const C = b.addPos(0, 0, 1);
  const D = b.addPos(1, 0, 1);
  const E = b.addPos(0, 1, 0);
  const F = b.addPos(1, 1, 0);

  // 岛 1（正常朝向）：A(0,0) B(1,0) C(0,1) D(1,1)，对角 B-D 在两三角形间焊接
  const a1 = b.addUv(0, 0);
  const b1 = b.addUv(1, 0);
  const c1 = b.addUv(0, 1);
  const d1 = b.addUv(1, 1);
  b.tri([A, a1], [B, b1], [D, d1]);
  b.tri([B, b1], [D, d1], [C, c1]);

  // 岛 2（镜像 U），放到 u ∈ [1.2, 2.2]；对角 E-B 焊接
  const e2 = b.addUv(2.2, 0);
  const a2 = b.addUv(1.2, 0);
  const b2 = b.addUv(1.2, 1);
  const f2 = b.addUv(2.2, 1);
  b.tri([E, e2], [A, a2], [B, b2]);
  b.tri([E, e2], [B, b2], [F, f2]);

  return b.build('mirror-island-seam');
}

/**
 * 样例 2：立方体 UV 接缝网
 * 8 个位置顶点、12 个三角面；每条几何边都是"共享位置边 + UV 切开"的接缝，
 * 6 个 UV 岛排在 3×2 网格内，绕序全部正确（无翻转、无重叠）。
 */
function buildCubeSeams(): MeshData {
  const b = new MeshBuilder();
  const v = [
    b.addPos(-0.5, -0.5, -0.5), // 0
    b.addPos(0.5, -0.5, -0.5), // 1
    b.addPos(0.5, 0.5, -0.5), // 2
    b.addPos(-0.5, 0.5, -0.5), // 3
    b.addPos(-0.5, -0.5, 0.5), // 4
    b.addPos(0.5, -0.5, 0.5), // 5
    b.addPos(0.5, 0.5, 0.5), // 6
    b.addPos(-0.5, 0.5, 0.5), // 7
  ];
  // 每个面独立 4 个 UV，3 列 × 2 行摆放，留 0.1 间隔
  const face = (
    corners: [number, number, number, number],
    col: number,
    row: number,
  ) => {
    const ox = col * 1.1;
    const oy = row * 1.1;
    const u = [
      b.addUv(ox, oy),
      b.addUv(ox + 1, oy),
      b.addUv(ox + 1, oy + 1),
      b.addUv(ox, oy + 1),
    ];
    b.tri([corners[0], u[0]], [corners[1], u[1]], [corners[2], u[2]]);
    b.tri([corners[0], u[0]], [corners[2], u[2]], [corners[3], u[3]]);
  };
  // 三角面顶点顺序均朝外，相邻面共享真实位置边
  face([v[0], v[3], v[2], v[1]], 0, 1); // -z
  face([v[4], v[5], v[6], v[7]], 1, 1); // +z
  face([v[0], v[1], v[5], v[4]], 2, 1); // -x
  face([v[3], v[7], v[6], v[2]], 0, 0); // +x
  face([v[0], v[4], v[7], v[3]], 1, 0); // -y
  face([v[1], v[2], v[6], v[5]], 2, 0); // +y
  return b.build('cube-seams');
}

/**
 * 样例 3：非流形边 + T 型接头 + UV 退化面
 * - 三个面共享同一条位置边 AB（非流形，面数=3）。
 * - 大三角形边 K-L 中间存在坐标重合但身份不同的顶点 M（T 型接头）：
 *   本工具不按坐标焊接，因此 K-M / M-L / K-L 会诚实地呈现为边界边。
 * - 最后一个面三个角共用同一个 UV 顶点（UV 塌缩成点），用于演示
 *   "退化面不参与普通比率计算"。
 */
function buildNonManifold(): MeshData {
  const b = new MeshBuilder();
  const A = b.addPos(0, 0, 0);
  const B = b.addPos(1, 0, 0);
  const P = b.addPos(0.5, 0, 1);
  const Q = b.addPos(0.5, 1, 0);
  const R = b.addPos(0.5, -1, 0);

  const ua = b.addUv(0, 0);
  const ub = b.addUv(1, 0);
  const up = b.addUv(0.5, 1);
  b.tri([A, ua], [B, ub], [P, up]);
  const uq = b.addUv(1.5, 1);
  b.tri([A, ua], [Q, uq], [B, ub]);
  const ur = b.addUv(0.5, -1);
  b.tri([A, ua], [R, ur], [B, ub]);

  // T 型接头：K-L 长边上"落"了一个不同身份但同坐标的 M
  const K = b.addPos(0, 0, 2);
  const L = b.addPos(2, 0, 2);
  const N = b.addPos(2, 0, 3);
  const M = b.addPos(1, 0, 2); // 坐标在 K-L 上，但身份独立、未焊接
  const uk = b.addUv(2, 0);
  const ul = b.addUv(4, 0);
  const un = b.addUv(4, 1);
  const um = b.addUv(3, 0);
  b.tri([K, uk], [L, ul], [N, un]); // 含完整边 K-L
  b.tri([K, uk], [M, um], [N, un]); // 邻面只到 M，不共享 K-L

  // UV 退化面（位置上正常，UV 三点重合）
  const X = b.addPos(-1, 0, -1);
  const Y = b.addPos(0, 0, -1);
  const Z = b.addPos(-1, 0, -2);
  const ud = b.addUv(3, 3);
  b.tri([X, ud], [Y, ud], [Z, ud]);

  return b.build('non-manifold');
}

/**
 * 样例 4：UV 重叠 + 面积畸变
 * 3D 中两张相同的方形面片，各自独立 UV 顶点，但都映射到同一个 0..1 方块
 * （第二张 U 向压缩到 0.5），用于演示重叠对检测与面积拉伸倍率。
 */
function buildOverlapStretch(): MeshData {
  const b = new MeshBuilder();
  const mkQuad = (ox: number, compress: boolean) => {
    const A = b.addPos(ox, 0, 0);
    const B = b.addPos(ox + 1, 0, 0);
    const C = b.addPos(ox, 0, 1);
    const D = b.addPos(ox + 1, 0, 1);
    const w = compress ? 0.5 : 1;
    const a = b.addUv(0, 0);
    const c = b.addUv(0, 1);
    const d = b.addUv(w, 1);
    const bv = b.addUv(w, 0);
    // (A,B,D),(A,D,C) 朝向 +y，UV 四角按 A(0,0) C(0,1) D(w,1) B(w,0) 排列
    b.tri([A, a], [B, bv], [D, d]);
    b.tri([A, a], [D, d], [C, c]);
  };
  mkQuad(0, false);
  mkQuad(2, true);
  return b.build('overlap-stretch');
}

export const SAMPLES: SampleDef[] = [
  {
    id: 'mirror',
    label: '镜像岛 / 接缝',
    description: '折页状双面片：一个正常 UV 岛 + 一个镜像岛，共享位置边被切开（接缝）。',
    build: buildMirroredSeam,
  },
  {
    id: 'cube',
    label: '立方体接缝网',
    description: '8 位置顶点 / 6 UV 岛：所有几何边都是接缝，绕序正确，无翻转重叠。',
    build: buildCubeSeams,
  },
  {
    id: 'nonmanifold',
    label: '非流形 / T 接头 / 退化',
    description: '三面共享一边（非流形）、未焊接的 T 型接头，以及一个 UV 塌缩退化面。',
    build: buildNonManifold,
  },
  {
    id: 'overlap',
    label: 'UV 重叠 / 拉伸',
    description: '两张面片重叠到同一 UV 方块，其中一张 U 向压缩，产生面积畸变。',
    build: buildOverlapStretch,
  },
];
