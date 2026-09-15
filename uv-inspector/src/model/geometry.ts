import type { Vec2, Vec3 } from './types';

export const EPS = 1e-10;

export function v3sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function v3cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

export function v3len(a: Vec3): number {
  return Math.hypot(a[0], a[1], a[2]);
}

export function triArea3(a: Vec3, b: Vec3, c: Vec3): number {
  return 0.5 * v3len(v3cross(v3sub(b, a), v3sub(c, a)));
}

/** 二维有符号面积（正值 = 逆时针）。 */
export function triArea2Signed(a: Vec2, b: Vec2, c: Vec2): number {
  return 0.5 * ((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]));
}

export function angleBetween(u: Vec3, v: Vec3): number {
  const lu = v3len(u);
  const lv = v3len(v);
  if (lu < EPS || lv < EPS) return 0;
  const d = (u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) / (lu * lv);
  return Math.acos(Math.min(1, Math.max(-1, d)));
}

export function angleBetween2(u: Vec2, v: Vec2): number {
  const lu = Math.hypot(u[0], u[1]);
  const lv = Math.hypot(v[0], v[1]);
  if (lu < EPS || lv < EPS) return 0;
  const d = (u[0] * v[0] + u[1] * v[1]) / (lu * lv);
  return Math.acos(Math.min(1, Math.max(-1, d)));
}

/** 三角形三个内角（弧度），顶点顺序 (a,b,c) 返回在 a,b,c 处的角。 */
export function triAngles3(a: Vec3, b: Vec3, c: Vec3): [number, number, number] {
  return [
    angleBetween(v3sub(b, a), v3sub(c, a)),
    angleBetween(v3sub(a, b), v3sub(c, b)),
    angleBetween(v3sub(a, c), v3sub(b, c)),
  ];
}

export function triAngles2(a: Vec2, b: Vec2, c: Vec2): [number, number, number] {
  return [
    angleBetween2([b[0] - a[0], b[1] - a[1]], [c[0] - a[0], c[1] - a[1]]),
    angleBetween2([a[0] - b[0], a[1] - b[1]], [c[0] - b[0], c[1] - b[1]]),
    angleBetween2([a[0] - c[0], a[1] - c[1]], [b[0] - c[0], b[1] - c[1]]),
  ];
}

export function median(sorted: number[]): number {
  const n = sorted.length;
  if (n === 0) return 0;
  return n % 2 ? sorted[(n - 1) / 2] : 0.5 * (sorted[n / 2 - 1] + sorted[n / 2]);
}

export function bbox2(points: Vec2[]): { min: Vec2; max: Vec2 } {
  const min: Vec2 = [Infinity, Infinity];
  const max: Vec2 = [-Infinity, -Infinity];
  for (const p of points) {
    min[0] = Math.min(min[0], p[0]);
    min[1] = Math.min(min[1], p[1]);
    max[0] = Math.max(max[0], p[0]);
    max[1] = Math.max(max[1], p[1]);
  }
  return { min, max };
}
