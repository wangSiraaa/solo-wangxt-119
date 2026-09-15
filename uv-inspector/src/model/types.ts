/**
 * 核心网格数据结构。
 *
 * 身份（identity）规则——这是本工具与普通 Three.js 加载器最关键的区别：
 *
 * - `positions[i]`：位置顶点 i，索引即**稳定顶点身份**（对应 OBJ 里 `v` 的序号）。
 *   两个位置相同的位置顶点也可能是不同身份（OBJ 里允许重复 `v`），
 *   因此**绝不能按空间坐标焊接顶点**。
 * - `uvs[k]`：UV 顶点 k，索引即**稳定 UV 顶点身份**（对应 OBJ 里 `vt` 的序号）。
 *   接缝两侧是不同的 UV 顶点，允许坐标相同也允许不同。
 * - `faces[f]`：三角面 f，索引即**稳定面身份**。OBJ 中的多边形在解析时扇面三角化，
 *   所有派生三角形共享同一个 `sourceFace`（OBJ 行号），导出/选择时仍按三角面操作，
 *   但报告里可按源面聚合。
 * - 每个角点 `corner = f*3+c` 同时持有一个位置顶点 id 与一个 UV 顶点 id，
 *   二者是两个独立的索引空间，与 OBJ 的 `f v/vt` 双重索引一致。
 */

export interface Triangle {
  /** 三个位置顶点 id（进入 positions 的索引） */
  v: [number, number, number];
  /** 三个 UV 顶点 id（进入 uvs 的索引），-1 表示该角无 UV */
  uv: [number, number, number];
  /** 三角化前的 OBJ 面身份（文件内行号，从 0 开始） */
  sourceFace: number;
}

export interface MeshData {
  name: string;
  /** 长度 = 位置顶点数 * 3，id 即 index/3 */
  positions: Float64Array;
  /** 长度 = UV 顶点数 * 2，id 即 index/2 */
  uvs: Float64Array;
  faces: Triangle[];
  /** 面的材质分组（可选，仅用于展示） */
  groups?: { name: string; startFace: number; endFace: number }[];
}

export type Vec2 = [number, number];
export type Vec3 = [number, number, number];

// ---------------------------------------------------------------------------
// 分析结果
// ---------------------------------------------------------------------------

export interface FaceMetrics {
  faceId: number;
  /** 3D 三角形面积（<= EPS 表示位置退化） */
  area3d: number;
  /** 2D 有符号面积；负值 = UV 翻转，0 = UV 退化 */
  signedUvArea: number;
  uvArea: number;
  /**
   * 面积畸变：|signedUvArea| / area3d 相对全网格尺度归一化后的倍率。
   * 1 = 与网格平均密度一致，>1 拉伸（纹理被放大），<1 压缩。
   * 退化面为 null。
   */
  areaRatio: number | null;
  /** 角度畸变（度）：三个对应内角的最大偏差。退化面为 null。 */
  angleDistortion: number | null;
  /** 角度畸变 RMS（度），用于整体统计 */
  angleRms: number | null;
  /** 3D 退化（共线/重合顶点） */
  degenerate3d: boolean;
  /** UV 退化（零面积，含塌成点/线） */
  degenerateUv: boolean;
  /** UV 朝向与 3D 面相反（需要 3D 法线参与；用绕序一致性近似） */
  flipped: boolean;
  /** 与其它面在 UV 空间重叠（含自重叠/共面，不含共享边） */
  overlaps: number[];
}

export interface EdgeInfo {
  /** 边的位置顶点 id 对（规范序，小 id 在前） */
  key: string;
  a: number;
  b: number;
  faces: number[];
  /** 出现次数 > 2（或 2 次但四个角不构成拓扑邻接的 T 型接头） */
  nonManifold: boolean;
  /** 恰好两个面共享位置边，但 UV 在该边被切开（角点 UV id 不一致） */
  seam: boolean;
  /** 接缝两侧 UV 坐标是否一致（未焊但坐标相同的"假缝"） */
  seamWeldedCoords: boolean;
  boundary: boolean;
}

export interface IslandInfo {
  id: number;
  uvVertices: number[];
  faces: number[];
  /** 岛的有符号 UV 面积和；<0 表示整个岛主要朝向为翻转 */
  signedArea: number;
  /** 相对参考岛是否疑似镜像（翻转面占多数） */
  mirrored: boolean;
  min: Vec2;
  max: Vec2;
}

export interface AnalysisResult {
  faces: FaceMetrics[];
  edges: EdgeInfo[];
  islands: IslandInfo[];
  /** key: `${faceA}-${faceB}` 重叠面对（无序、去重、排除共享边） */
  overlapPairs: Array<[number, number]>;
  /** 非退化面的面积比率中位值（1 附近） */
  medianAreaRatio: number;
  summary: {
    faceCount: number;
    degenerate3d: number;
    degenerateUv: number;
    flipped: number;
    overlappingFaces: number;
    seamEdgeCount: number;
    nonManifoldEdgeCount: number;
    islandCount: number;
    /** 非退化面参与的角度畸变统计 */
    maxAngleDistortion: number;
    meanAngleDistortion: number;
    maxAreaRatioLog: number;
  };
}

/** 面选择集合：以稳定面 id 为准，三视图共享。 */
export type Selection = ReadonlySet<number>;
