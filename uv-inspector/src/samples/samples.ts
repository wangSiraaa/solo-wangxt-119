import { MeshBuilder } from '../model/builder';
import type { MeshData, Vec3 } from '../model/types';

export interface SampleDef {
  id: string;
  label: string;
  description: string;
  build: () => MeshData;
}

/**
 * UV 绕序契约：**从面外侧观察**，几何面与 UV 绕序一致即为正常。
 *
 * 对平面面，给定其屏幕右手对 (ip,iq)（满足 e_ip×e_iq = +外向法线主轴），
 * 从外侧 CCW 的角点直接取 UV = (位置[ip], 位置[iq]) 的归一化映射，即可保证
 * UV 有符号面积与几何屏幕投影严格同号。法线朝负轴时得到的就是
 * "负面积正常" UV（不是翻转）。flipU 沿 u 反射以制造镜像岛。
 */
function uvFromPlane(
  b: MeshBuilder,
  pts: Vec3[],
  ip: number,
  iq: number,
  oU = 0,
  oV = 0,
  scaleU = 1,
  scaleV = 1,
  flipU = false,
): number[] {
  let loIp = Infinity; let hiIp = -Infinity; let loIq = Infinity; let hiIq = -Infinity;
  for (const p of pts) {
    loIp = Math.min(loIp, p[ip]); hiIp = Math.max(hiIp, p[ip]);
    loIq = Math.min(loIq, p[iq]); hiIq = Math.max(hiIq, p[iq]);
  }
  const sIp = hiIp - loIp || 1;
  const sIq = hiIq - loIq || 1;
  return pts.map((p) => {
    const u = oU + ((p[ip] - loIp) / sIp) * scaleU;
    const v = oV + ((p[iq] - loIq) / sIq) * scaleV;
    return b.addUv(flipU ? oU + scaleU - (u - oU) : u, v);
  });
}

/** 对一组 (位置,UV) 角点添加两个三角形（四角 CCW）。 */
function quad4(b: MeshBuilder, c: Array<[number, number]>): void {
  b.tri(c[0], c[1], c[2]);
  b.tri(c[0], c[2], c[3]);
}

/**
 * 样例 1：镜像岛 + 共享边接缝
 * 两张四方面片沿位置边 AB 折成 90°（翻开的书）。
 * - 岛 1：y=0 水平面，外向法线 -y，屏幕右手对 ip=2(z),iq=0(x)，正常负面积绕序。
 * - 岛 2：z=0 竖直面，外向法线 -z，屏幕右手对 ip=0(x),iq=1(y)，UV 沿 u 镜像
 *   -> 两三角面翻转，岛标为 mirrored。
 * - AB 为共享位置边、UV 切开 -> 1 条接缝。
 */
function buildMirroredSeam(): MeshData {
  const b = new MeshBuilder();
  const A: Vec3 = [0, 0, 0];
  const B: Vec3 = [1, 0, 0];
  const C: Vec3 = [0, 0, 1];
  const D: Vec3 = [1, 0, 1];
  const E: Vec3 = [0, 1, 0];
  const F: Vec3 = [1, 1, 0];
  const [iA, iB, iC, iD] = [A, B, C, D].map((p) => b.addPosV(p));
  const [iE, iF] = [E, F].map((p) => b.addPosV(p));

  // 岛 1（正常，y=0，朝 -y）：四角按从 -y 外侧 CCW：A,B,D,C
  {
    const [ua, ub, ud, uc] = uvFromPlane(b, [A, B, D, C], 2, 0);
    quad4(b, [[iA, ua], [iB, ub], [iD, ud], [iC, uc]]);
  }
  // 岛 2（镜像，z=0，朝 -z）：角按从 -z 外侧 CCW：E,F,B,A，UV 放到 [1.2,2.2] 并镜像
  {
    const [ue, uf, ub2, ua2] = uvFromPlane(b, [E, F, B, A], 0, 1, 1.2, 0, 1, 1, true);
    quad4(b, [[iE, ue], [iF, uf], [iB, ub2], [iA, ua2]]);
  }
  return b.build('mirror-island-seam');
}

/**
 * 样例 2：立方体 UV 接缝网
 * 8 个位置顶点、12 个三角面；每条几何边都是"共享位置边 + UV 切开"的接缝，
 * 6 个 UV 岛排在 3×2 网格。各面 UV 由外侧投影生成，绕序全部正常
 * （负轴面为负面积正常绕序），无翻转、无重叠。
 */
function buildCubeSeams(): MeshData {
  const b = new MeshBuilder();
  const P: Vec3[] = [
    [-0.5, -0.5, -0.5], // 0
    [0.5, -0.5, -0.5], // 1
    [0.5, 0.5, -0.5], // 2
    [-0.5, 0.5, -0.5], // 3
    [-0.5, -0.5, 0.5], // 4
    [0.5, -0.5, 0.5], // 5
    [0.5, 0.5, 0.5], // 6
    [-0.5, 0.5, 0.5], // 7
  ];
  const v = P.map((p) => b.addPosV(p));

  // corners：从该面外侧 CCW 的 4 个位置 id；(ip,iq)：屏幕右手对
  const face = (
    corners: [number, number, number, number],
    ip: number,
    iq: number,
    col: number,
    row: number,
  ) => {
    const cpos = corners.map((ci) => P[ci]);
    const u = uvFromPlane(b, cpos, ip, iq, col * 1.1, row * 1.1);
    quad4(b, corners.map((ci, k) => [ci, u[k]] as [number, number]) as Array<[number, number]>);
  };

  // 各面角序按"从外侧 CCW"给出（由固定轴取 4 角 + 平面极角排序对齐外向法线求得），
  // 屏幕右手对 (ip,iq) 满足 e_ip×e_iq 指向外侧：±z->(x,y)、±x->(y,z)、±y->(z,x)。
  face([v[3], v[0], v[1], v[2]], 0, 1, 0, 1); // -z，屏幕 (x,y)
  face([v[7], v[4], v[5], v[6]], 0, 1, 1, 1); // +z，屏幕 (x,y)
  face([v[4], v[0], v[3], v[7]], 1, 2, 2, 1); // -x，屏幕 (y,z)
  face([v[5], v[1], v[2], v[6]], 1, 2, 0, 0); // +x，屏幕 (y,z)
  face([v[1], v[0], v[4], v[5]], 2, 0, 1, 0); // -y，屏幕 (z,x)
  face([v[2], v[3], v[7], v[6]], 2, 0, 2, 0); // +y，屏幕 (z,x)
  return b.build('cube-seams');
}

/**
 * 样例 3：非流形边 + T 型接头 + UV 退化面
 * - 三个面共享同一条位置边 AB（非流形，面数=3）。
 * - 大三角形边 K-L 中间存在坐标重合但身份不同的顶点 M（T 型接头，未焊接）。
 * - 最后一个面三个角共用同一个 UV 顶点（UV 塌缩成点，退化，不参与比率）。
 */
function buildNonManifold(): MeshData {
  const b = new MeshBuilder();

  // 共享位置边 A-B（同一对稳定位置 id），三个面都引用它 -> 非流形边（面数=3）
  const A = b.addPos(0, 0, 0);
  const B = b.addPos(1, 0, 0);

  // 面 P：xz 平面，顶点 P 在 +y 一侧，几何叉积 (B-A)×(P-A) 朝 -y；
  // 从 -y 外侧 CCW 顺序 A,B,P，屏幕右手对 ip=2(z),iq=0(x)
  {
    const Pp: Vec3 = [0.5, 0, 1];
    const iP = b.addPosV(Pp);
    const [ua, ub, up] = uvFromPlane(
      b,
      [[0, 0, 0], [1, 0, 0], Pp],
      2, 0, 0, 0,
    );
    b.tri([A, ua], [B, ub], [iP, up]);
  }
  // 面 Q：顶点 Q 在 +y 一侧（xy 平面），几何叉积朝 +z；从 +z 外侧 CCW：A,Q,B
  {
    const Q: Vec3 = [0.5, 1, 0];
    const iQ = b.addPosV(Q);
    const [ua, uq, ub] = uvFromPlane(
      b,
      [[0, 0, 0], Q, [1, 0, 0]],
      0, 1, 1.2, 0,
    );
    b.tri([A, ua], [iQ, uq], [B, ub]);
  }
  // 面 R：顶点 R 在 -y 一侧（xy 平面），几何叉积朝 -z；从 -z 外侧 CCW：A,B,R。
  // 屏幕右手对 ip=0(x),iq=1(y)，负面积正常绕序；映射到右侧 [2.4..3.4]。
  {
    const R: Vec3 = [0.5, -1, 0];
    const iR = b.addPosV(R);
    // A(0,0)->(2.4,1)  B(1,0)->(3.4,1)  R(0.5,-1)->(2.9,0)，使 (A,B,R) 为负面积
    const ua = b.addUv(2.4, 1);
    const ub = b.addUv(3.4, 1);
    const ur = b.addUv(2.9, 0);
    b.tri([A, ua], [B, ub], [iR, ur]);
  }

  // T 型接头：xz 平面（外向 -y，因为从 y=0 向下看），K-L 边上"落"了不同身份但同坐标的 M
  {
    const K: Vec3 = [0, 0, 2]; const L: Vec3 = [2, 0, 2]; const N: Vec3 = [2, 0, 3]; const M: Vec3 = [1, 0, 2];
    const [iK, iL, iN, iM] = [K, L, N, M].map((p) => b.addPosV(p));
    // 外向 -y -> 屏幕右手对 ip=2(z),iq=0(x)；映射到上方区域。
    // u=z（2..3 -> 0..1），v=x（0..2 -> 2..4）
    const toUv = (p: Vec3): [number, number] => [p[2] - 2, 2 + p[0]];
    const [uk, ul, un] = [toUv(K), toUv(L), toUv(N)].map(([u, v]) => b.addUv(u, v));
    b.tri([iK, uk], [iL, ul], [iN, un]);
    const um = b.addUv(...toUv(M)); // M=(1,0,2) 落在 K-L 边中点，独立 UV 身份
    b.tri([iK, uk], [iM, um], [iN, un]);
  }

  // UV 退化面（位置正常，UV 三点重合）；位置放在 y=0 平面朝 -y
  {
    const X: Vec3 = [-1, 0, -1]; const Y: Vec3 = [0, 0, -1]; const Z: Vec3 = [-1, 0, -2];
    const [iX, iY, iZ] = [X, Y, Z].map((p) => b.addPosV(p));
    const ud = b.addUv(3, 3);
    b.tri([iX, ud], [iY, ud], [iZ, ud]);
  }

  return b.build('non-manifold');
}

/**
 * 样例 4：UV 重叠 + 面积畸变
 * 两张相同的方形面片（y=0、外向 -y，屏幕 ip=2(z),iq=0(x)），各自独立 UV 顶点
 * 但映射到同一 0..1 方块（第二张沿 u 压缩到 0.5 宽）。绕序均正常（负面积正常），
 * 用于演示重叠对检测与面积拉伸倍率。
 */
function buildOverlapStretch(): MeshData {
  const b = new MeshBuilder();
  const mkQuad = (ox: number, compress: boolean) => {
    const A: Vec3 = [ox, 0, 0];
    const B: Vec3 = [ox + 1, 0, 0];
    const D: Vec3 = [ox + 1, 0, 1];
    const C: Vec3 = [ox, 0, 1];
    const [iA, iB, iD, iC] = [A, B, D, C].map((p) => b.addPosV(p));
    // 从 -y 外侧 CCW：A,B,D,C；ip=2(z),iq=0(x)
    const w = compress ? 0.5 : 1;
    const [ua, ub, ud, uc] = uvFromPlane(b, [A, B, D, C], 2, 0, 0, 0, w, 1);
    quad4(b, [[iA, ua], [iB, ub], [iD, ud], [iC, uc]]);
  };
  mkQuad(0, false);
  mkQuad(2, true);
  return b.build('overlap-stretch');
}

export const SAMPLES: SampleDef[] = [
  {
    id: 'mirror',
    label: '镜像岛 / 接缝',
    description: '折页状双面片：正常岛（负轴面负面积正常绕序）+ 镜像岛，共享位置边被切开（接缝）。',
    build: buildMirroredSeam,
  },
  {
    id: 'cube',
    label: '立方体接缝网',
    description: '8 位置顶点 / 6 UV 岛：所有几何边都是接缝，各面从外侧看绕序正确（含负面积正常面），无翻转重叠。',
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
    description: '两张面片重叠到同一 UV 方块，其中一张压缩，产生面积畸变；绕序均正常。',
    build: buildOverlapStretch,
  },
];
