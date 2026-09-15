import type {
  AnalysisResult,
  EdgeInfo,
  FaceMetrics,
  IslandInfo,
  MeshData,
  Vec2,
  Vec3,
} from '../model/types';
import {
  EPS,
  bbox2,
  median,
  triAngles2,
  triAngles3,
  triArea2Signed,
  triArea3,
} from '../model/geometry';

/**
 * 对网格做完整 UV 质检。
 *
 * 设计要点：
 * - 所有拓扑关系都基于"稳定 id"（位置顶点 id / UV 顶点 id / 面 id），
 *   不使用空间坐标做合并，因此接缝两侧可以有不同 UV。
 * - 面积畸变与角度畸变**分别**计算、分别展示。
 * - 退化面（3D 零面积或 UV 零面积）只标记、计数，**不参与普通比率/统计**。
 */

const OVERLAP_FACE_LIMIT = 2500;

export function analyzeMesh(mesh: MeshData): AnalysisResult {
  const p3 = (vi: number): Vec3 => [
    mesh.positions[vi * 3],
    mesh.positions[vi * 3 + 1],
    mesh.positions[vi * 3 + 2],
  ];
  const p2 = (ui: number): Vec2 => [mesh.uvs[ui * 2], mesh.uvs[ui * 2 + 1]];

  const faceCount = mesh.faces.length;

  // -------------------------------------------------------------------------
  // 1. 逐面度量
  // -------------------------------------------------------------------------
  const faces: FaceMetrics[] = mesh.faces.map((f, faceId) => {
    const a3 = p3(f.v[0]);
    const b3 = p3(f.v[1]);
    const c3 = p3(f.v[2]);
    const a2 = p2(f.uv[0]);
    const b2 = p2(f.uv[1]);
    const c2 = p2(f.uv[2]);

    const area3d = triArea3(a3, b3, c3);
    const signedUvArea = triArea2Signed(a2, b2, c2);
    const uvArea = Math.abs(signedUvArea);
    const degenerate3d = area3d <= EPS;
    const degenerateUv = uvArea <= EPS;

    // UV 翻转判定。
    //
    // 绕序契约：**从面外侧观察**，几何面与 UV 绕序一致即为正常，相反即为镜像。
    // 因此需要两个相互独立的符号：
    //   1) 几何朝向——把 3D 三角形投影到垂直于其外向法线的"外侧屏幕"平面，
    //      取有符号面积 screenSign。该符号本身携带外向朝向：法线指向主轴 + 时
    //      为正，指向主轴 − 时为负（这就是"负面积正常绕序"的几何来源）。
    //   2) UV 朝向——UV 三角形有符号面积 uvSign = sign(2·signedUvArea)。
    // 两者同号 = 从面外侧看到的 UV 绕序与几何一致（正常）；异号 = 镜像翻转。
    //
    // 不能用 detUv < 0 直接判翻转：那等价于要求所有面 UV 面积都为正，会把
    // 朝 -X/-Y/-Z 的正常面（其外侧屏幕投影本身就是负的）误报。也不能把同一对
    // 边向量导出的投影符号与法线分量相乘（那得到恒正的平方项）。
    //
    // 屏幕平面的两轴取右手对，使 e_p × e_q = +e_axis：
    //   主轴 X -> (y,z)，Y -> (z,x)，Z -> (x,y)。
    let flipped = false;
    if (!degenerate3d && !degenerateUv) {
      const p01x = b3[0] - a3[0];
      const p01y = b3[1] - a3[1];
      const p01z = b3[2] - a3[2];
      const p02x = c3[0] - a3[0];
      const p02y = c3[1] - a3[1];
      const p02z = c3[2] - a3[2];
      const nx = p01y * p02z - p01z * p02y;
      const ny = p01z * p02x - p01x * p02z;
      const nz = p01x * p02y - p01y * p02x;

      // 主导轴与对应屏幕轴 (p,q)
      let ip: number;
      let iq: number;
      if (Math.abs(nx) >= Math.abs(ny) && Math.abs(nx) >= Math.abs(nz)) {
        ip = 1; iq = 2; // 主轴 X：e_y × e_z = e_x
      } else if (Math.abs(ny) >= Math.abs(nz)) {
        ip = 2; iq = 0; // 主轴 Y：e_z × e_x = e_y
      } else {
        ip = 0; iq = 1; // 主轴 Z：e_x × e_y = e_z
      }
      // 投影到外侧屏幕平面的有符号面积（右手对）。
      const screen =
        (b3[ip] - a3[ip]) * (c3[iq] - a3[iq]) -
        (c3[ip] - a3[ip]) * (b3[iq] - a3[iq]);

      const d1u = b2[0] - a2[0];
      const d1v = b2[1] - a2[1];
      const d2u = c2[0] - a2[0];
      const d2v = c2[1] - a2[1];
      const detUv = d1u * d2v - d1v * d2u; // 2*signedUvArea

      flipped = Math.sign(screen) !== Math.sign(detUv);
    }

    // 角度畸变：3D 内角与 UV 内角逐一配对后的最大偏差
    let angleDistortion: number | null = null;
    let angleRms: number | null = null;
    if (!degenerate3d && !degenerateUv) {
      const a3s = triAngles3(a3, b3, c3);
      const a2s = triAngles2(a2, b2, c2);
      let maxD = 0;
      let sumSq = 0;
      for (let i = 0; i < 3; i++) {
        const d = Math.abs(a3s[i] - a2s[i]);
        maxD = Math.max(maxD, d);
        sumSq += d * d;
      }
      angleDistortion = (maxD * 180) / Math.PI;
      angleRms = (Math.sqrt(sumSq / 3) * 180) / Math.PI;
    }

    return {
      faceId,
      area3d,
      signedUvArea,
      uvArea,
      areaRatio: null, // 第二步统一归一化后填入
      angleDistortion,
      angleRms,
      degenerate3d,
      degenerateUv,
      flipped,
      overlaps: [],
    };
  });

  // -------------------------------------------------------------------------
  // 2. 面积畸变：以"非退化面的 UV面积/3D面积"的中位数为参考密度 1
  // -------------------------------------------------------------------------
  const densities: number[] = [];
  for (const fm of faces) {
    if (!fm.degenerate3d && !fm.degenerateUv) densities.push(fm.uvArea / fm.area3d);
  }
  densities.sort((a, b) => a - b);
  const refDensity = median(densities) || 1;
  for (const fm of faces) {
    if (!fm.degenerate3d && !fm.degenerateUv) {
      fm.areaRatio = fm.uvArea / fm.area3d / refDensity;
    }
  }

  // -------------------------------------------------------------------------
  // 3. 边：非流形 / 接缝 / 边界（按位置顶点 id 建边，不按坐标焊接）
  // -------------------------------------------------------------------------
  const edgeMap = new Map<string, EdgeInfo>();
  const edgeKey = (a: number, b: number) => (a < b ? `${a}_${b}` : `${b}_${a}`);

  /** 记录某面在一条位置边上的两个 UV 角点（有序：从 a 走到 b） */
  interface EdgeUse {
    face: number;
    uvA: number;
    uvB: number;
  }
  const edgeUses = new Map<string, EdgeUse[]>();

  mesh.faces.forEach((f, faceId) => {
    for (let c = 0; c < 3; c++) {
      const c0 = c;
      const c1 = (c + 1) % 3;
      const va = f.v[c0];
      const vb = f.v[c1];
      const key = edgeKey(va, vb);
      let e = edgeMap.get(key);
      if (!e) {
        e = {
          key,
          a: Math.min(va, vb),
          b: Math.max(va, vb),
          faces: [],
          nonManifold: false,
          seam: false,
          seamWeldedCoords: false,
          boundary: false,
        };
        edgeMap.set(key, e);
      }
      e.faces.push(faceId);
      // 沿规范方向 a->b（位置顶点 id 升序）记录两端 UV。
      // 当前半边走向是 c0->c1；当 va>vb 时它与 a->b 反向，需要交换两端。
      const uvAt = (vid: number): number => {
        if (f.v[0] === vid) return f.uv[0];
        if (f.v[1] === vid) return f.uv[1];
        return f.uv[2];
      };
      const ua = uvAt(e.a);
      const ub = uvAt(e.b);
      let uses = edgeUses.get(key);
      if (!uses) {
        uses = [];
        edgeUses.set(key, uses);
      }
      uses.push({ face: faceId, uvA: ua, uvB: ub });
    }
  });

  for (const e of edgeMap.values()) {
    e.boundary = e.faces.length === 1;
    e.nonManifold = e.faces.length !== 1 && e.faces.length !== 2; // >2 非流形
    if (e.faces.length === 2) {
      // T 型接头：两侧在该边上实际使用的位置顶点 id 必须正好是 a,b（本结构天然如此，
      // 因为不做坐标焊接，落在边中间的顶点会表现为边界边，由另一条边单独标记）。
      const [u0, u1] = edgeUses.get(e.key)!;
      // 接缝：共享位置边，但沿边两侧的 UV 顶点身份不一致（无论坐标是否相同）。
      // 两条 use 都已规范到 a->b 方向，直接同位比较。
      const sameIdentity = u0.uvA === u1.uvA && u0.uvB === u1.uvB;
      if (!sameIdentity) {
        e.seam = true;
        const sameCoord =
          uvClose(mesh, u0.uvA, u1.uvA) && uvClose(mesh, u0.uvB, u1.uvB);
        e.seamWeldedCoords = sameCoord;
      }
    }
  }

  // -------------------------------------------------------------------------
  // 4. UV 岛：以 UV 顶点身份连通（接缝 = 不同岛）
  // -------------------------------------------------------------------------
  const uvCount = mesh.uvs.length / 2;
  const parent = new Int32Array(uvCount);
  for (let i = 0; i < uvCount; i++) parent[i] = i;
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };
  for (const f of mesh.faces) {
    union(f.uv[0], f.uv[1]);
    union(f.uv[1], f.uv[2]);
    union(f.uv[2], f.uv[0]);
  }
  const islandByRoot = new Map<number, IslandInfo>();
  for (const f of mesh.faces) {
    const root = find(f.uv[0]);
    let isl = islandByRoot.get(root);
    if (!isl) {
      isl = {
        id: islandByRoot.size,
        uvVertices: [],
        faces: [],
        signedArea: 0,
        mirrored: false,
        min: [Infinity, Infinity],
        max: [-Infinity, -Infinity],
      };
      islandByRoot.set(root, isl);
    }
    isl.faces.push(/* face id filled below */ 0);
  }
  // 重新遍历填面 id / 面积 / 包围盒
  islandByRoot.forEach((isl) => {
    isl.faces.length = 0;
  });
  const faceIsland = new Int32Array(faceCount);
  mesh.faces.forEach((f, fid) => {
    const isl = islandByRoot.get(find(f.uv[0]))!;
    isl.faces.push(fid);
    faceIsland[fid] = isl.id;
    const fm = faces[fid];
    isl.signedArea += fm.signedUvArea;
    for (const uid of f.uv) {
      isl.uvVertices.push(uid);
      const q = p2(uid);
      isl.min[0] = Math.min(isl.min[0], q[0]);
      isl.min[1] = Math.min(isl.min[1], q[1]);
      isl.max[0] = Math.max(isl.max[0], q[0]);
      isl.max[1] = Math.max(isl.max[1], q[1]);
    }
  });
  // 岛的镜像判定：多数非退化面被雅可比判据标为 flipped。
  // 该判据轴无关——朝 -X/-Y/-Z 的正常面（detUv>0）不计入，只有真正镜像
  // （detUv<0）的面才会让岛被标记为 mirrored。
  const islands = [...islandByRoot.values()];
  for (const isl of islands) {
    let bad = 0;
    let good = 0;
    for (const fid of isl.faces) {
      const fm = faces[fid];
      if (fm.degenerate3d || fm.degenerateUv) continue;
      if (fm.flipped) bad++;
      else good++;
    }
    isl.mirrored = bad > good;
  }

  // -------------------------------------------------------------------------
  // 5. UV 重叠（分离轴 + 多边形裁剪；排除共享 UV 顶点的相邻面）
  // -------------------------------------------------------------------------
  const overlapPairs: Array<[number, number]> = [];
  if (faceCount <= OVERLAP_FACE_LIMIT) {
    // 网格加速：先按 UV 包围盒分桶
    const boxes = mesh.faces.map((f) => {
      const q = [p2(f.uv[0]), p2(f.uv[1]), p2(f.uv[2])];
      const bb = bbox2(q);
      return bb;
    });
    for (let i = 0; i < faceCount; i++) {
      const fi = mesh.faces[i];
      if (faces[i].degenerateUv) continue;
      for (let j = i + 1; j < faceCount; j++) {
        if (faces[j].degenerateUv) continue;
        // 同一岛内共享 UV 顶点 -> 正常相邻，不算重叠
        const fj = mesh.faces[j];
        if (faceIsland[i] === faceIsland[j]) {
          const sa = new Set([fi.uv[0], fi.uv[1], fi.uv[2]]);
          if ([fj.uv[0], fj.uv[1], fj.uv[2]].some((u) => sa.has(u))) continue;
        }
        const bi = boxes[i];
        const bj = boxes[j];
        if (
          bi.max[0] <= bj.min[0] + EPS ||
          bj.max[0] <= bi.min[0] + EPS ||
          bi.max[1] <= bj.min[1] + EPS ||
          bj.max[1] <= bi.min[1] + EPS
        ) {
          continue;
        }
        if (trianglesOverlap2D(p2(fi.uv[0]), p2(fi.uv[1]), p2(fi.uv[2]), p2(fj.uv[0]), p2(fj.uv[1]), p2(fj.uv[2]))) {
          overlapPairs.push([i, j]);
          faces[i].overlaps.push(j);
          faces[j].overlaps.push(i);
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // 6. 汇总
  // -------------------------------------------------------------------------
  const valid = faces.filter((f) => !f.degenerate3d && !f.degenerateUv);
  const angles = valid.map((f) => f.angleDistortion!);
  const ratioLogs = valid.map((f) => Math.abs(Math.log2(f.areaRatio!)));

  const edges = [...edgeMap.values()];
  const summary = {
    faceCount,
    degenerate3d: faces.filter((f) => f.degenerate3d).length,
    degenerateUv: faces.filter((f) => f.degenerateUv && !f.degenerate3d).length,
    flipped: faces.filter((f) => f.flipped).length,
    overlappingFaces: new Set(overlapPairs.flat()).size,
    seamEdgeCount: edges.filter((e) => e.seam).length,
    nonManifoldEdgeCount: edges.filter((e) => e.nonManifold).length,
    islandCount: islands.length,
    maxAngleDistortion: angles.length ? Math.max(...angles) : 0,
    meanAngleDistortion: angles.length ? angles.reduce((s, x) => s + x, 0) / angles.length : 0,
    maxAreaRatioLog: ratioLogs.length ? Math.max(...ratioLogs) : 0,
  };

  return {
    faces,
    edges,
    islands,
    overlapPairs,
    medianAreaRatio: 1,
    summary,
  };
}

function uvClose(mesh: MeshData, a: number, b: number, tol = 1e-7): boolean {
  if (a === b) return true;
  return (
    Math.abs(mesh.uvs[a * 2] - mesh.uvs[b * 2]) <= tol &&
    Math.abs(mesh.uvs[a * 2 + 1] - mesh.uvs[b * 2 + 1]) <= tol
  );
}

/**
 * 两个三角形是否在二维空间有正面积交集。
 * 先用 6 条分离轴快速排除，再用 Sutherland–Hodgman 裁剪确认交集面积 > 0
 * （SAT 对"一条边完全落在另一条边上"这类零面积接触会保守判交，这里再做面积确认）。
 */
export function trianglesOverlap2D(
  a: Vec2,
  b: Vec2,
  c: Vec2,
  x: Vec2,
  y: Vec2,
  z: Vec2,
): boolean {
  const t1 = [a, b, c];
  const t2 = [x, y, z];
  const axes: Vec2[] = [];
  for (const t of [t1, t2]) {
    for (let i = 0; i < 3; i++) {
      const p = t[i];
      const q = t[(i + 1) % 3];
      const dx = q[0] - p[0];
      const dy = q[1] - p[1];
      axes.push([-dy, dx]); // 边法线
    }
  }
  for (const [nx, ny] of axes) {
    let min1 = Infinity;
    let max1 = -Infinity;
    let min2 = Infinity;
    let max2 = -Infinity;
    for (const [px, py] of t1) {
      const d = px * nx + py * ny;
      min1 = Math.min(min1, d);
      max1 = Math.max(max1, d);
    }
    for (const [px, py] of t2) {
      const d = px * nx + py * ny;
      min2 = Math.min(min2, d);
      max2 = Math.max(max2, d);
    }
    if (Math.max(min1, min2) + EPS >= Math.min(max1, max2)) {
      // 投影区间仅在边界接触 -> 交集面积为 0，不算重叠
      if (!(Math.max(min1, min2) < Math.min(max1, max2) - EPS)) return false;
    }
  }
  return polygonArea(clipTriangle(t1, t2)) > EPS;
}

function clipTriangle(subject: Vec2[], clipper: Vec2[]): Vec2[] {
  let out = subject;
  for (let i = 0; i < 3; i++) {
    const A = clipper[i];
    const B = clipper[(i + 1) % 3];
    const ex = B[0] - A[0];
    const ey = B[1] - A[1];
    const inside = (p: Vec2) => ex * (p[1] - A[1]) - ey * (p[0] - A[0]) >= -EPS;
    const input = out;
    out = [];
    if (input.length === 0) break;
    for (let k = 0; k < input.length; k++) {
      const P = input[k];
      const Q = input[(k + 1) % input.length];
      const pin = inside(P);
      const qin = inside(Q);
      if (pin && qin) {
        out.push(Q);
      } else if (pin && !qin) {
        out.push(intersectSeg(P, Q, A, B));
      } else if (!pin && qin) {
        out.push(intersectSeg(P, Q, A, B));
        out.push(Q);
      }
    }
  }
  return out;
}

function intersectSeg(p: Vec2, q: Vec2, a: Vec2, b: Vec2): Vec2 {
  const r = [q[0] - p[0], q[1] - p[1]];
  const s = [b[0] - a[0], b[1] - a[1]];
  const denom = r[0] * s[1] - r[1] * s[0];
  const t = denom === 0 ? 0 : ((a[0] - p[0]) * s[1] - (a[1] - p[1]) * s[0]) / denom;
  return [p[0] + t * r[0], p[1] + t * r[1]];
}

function polygonArea(poly: Vec2[]): number {
  if (poly.length < 3) return 0;
  let area = 0;
  for (let i = 0; i < poly.length; i++) {
    const q = poly[(i + 1) % poly.length];
    area += poly[i][0] * q[1] - q[0] * poly[i][1];
  }
  return Math.abs(area) * 0.5;
}
