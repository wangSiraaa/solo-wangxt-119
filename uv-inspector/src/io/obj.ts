import type { MeshData, Triangle } from '../model/types';

/**
 * OBJ 子集解析器。
 *
 * 支持：`v`、`vt`、`f`（`v`、`v/vt`、`v//vn`、`v/vt/vn` 形式，含负索引），
 * 以及作为分组提示的 `o` / `g` / `usemtl`。
 *
 * 关键不变量：
 * - OBJ 的 `v` 索引 -> 位置顶点稳定身份，**不做空间焊接**（重复 `v` 保留）。
 * - OBJ 的 `vt` 索引 -> UV 顶点稳定身份；接缝两侧天然是不同 vt。
 * - 多边形按 0号角点扇面三角化；每个三角形保留 `sourceFace`（OBJ 面行序）。
 * - 没有 UV 的面角 uv id 置 -1，由后续 `ensureUvs` 为其生成独立角点 UV。
 */

export interface ParseResult {
  mesh: MeshData;
  warnings: string[];
}

interface RawFaceCorner {
  v: number; // 0-based position id
  vt: number; // 0-based uv id, -1 if absent
}

export function parseOBJ(text: string, name = 'imported.obj'): ParseResult {
  const warnings: string[] = [];
  const pos: number[] = [];
  const uv: number[] = [];
  const faces: Triangle[] = [];
  const groups: NonNullable<MeshData['groups']> = [];

  let currentGroup = 'default';
  let groupStartFace = 0;
  let sourceFace = 0;

  const lines = text.split(/\r\n|\n|\r/);
  const flushGroup = (endFace: number) => {
    if (endFace > groupStartFace || groups.length === 0) {
      const last = groups[groups.length - 1];
      if (last && last.name === currentGroup) last.endFace = endFace;
      else groups.push({ name: currentGroup, startFace: groupStartFace, endFace });
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const tokens = line.split(/\s+/);
    const cmd = tokens[0];

    if (cmd === 'v') {
      const x = Number(tokens[1]);
      const y = Number(tokens[2]);
      const z = Number(tokens[3] ?? 0);
      if (![x, y, z].every(Number.isFinite)) {
        warnings.push(`无法解析的 v 行: ${line}`);
        continue;
      }
      pos.push(x, y, z);
    } else if (cmd === 'vt') {
      const u = Number(tokens[1]);
      const v = Number(tokens[2] ?? 0);
      if (!Number.isFinite(u) || !Number.isFinite(v)) {
        warnings.push(`无法解析的 vt 行: ${line}`);
        continue;
      }
      uv.push(u, v);
    } else if (cmd === 'f') {
      const corners = parseFace(tokens.slice(1), pos.length / 3, uv.length / 2, line, warnings);
      if (!corners || corners.length < 3) {
        warnings.push(`忽略顶点不足或引用越界的面: ${line}`);
        sourceFace++;
        continue;
      }
      // 扇面三角化；所有三角形共享同一 sourceFace 身份。
      for (let i = 1; i < corners.length - 1; i++) {
        const tri: Triangle = {
          v: [corners[0].v, corners[i].v, corners[i + 1].v],
          uv: [corners[0].vt, corners[i].vt, corners[i + 1].vt],
          sourceFace,
        };
        faces.push(tri);
      }
      sourceFace++;
    } else if (cmd === 'g' || cmd === 'o' || cmd === 'usemtl') {
      const gName = tokens.slice(1).join(' ') || currentGroup;
      if (gName !== currentGroup) {
        flushGroup(faces.length);
        currentGroup = gName;
        groupStartFace = faces.length;
      }
    }
    // vn / s / mtllib 等在子集中忽略（vn 不参与 UV 检查）。
  }
  flushGroup(faces.length);

  return {
    mesh: {
      name,
      positions: Float64Array.from(pos),
      uvs: Float64Array.from(uv),
      faces,
      groups: groups.length ? groups : undefined,
    },
    warnings,
  };
}

function parseFace(
  tokens: string[],
  vCount: number,
  vtCount: number,
  line: string,
  warnings: string[],
): RawFaceCorner[] | null {
  const corners: RawFaceCorner[] = [];
  for (const tok of tokens) {
    const parts = tok.split('/');
    const resolve = (s: string | undefined, count: number): number => {
      if (s === undefined || s === '') return -1;
      let n = Number(s);
      if (!Number.isInteger(n)) {
        warnings.push(`面索引不是整数: ${line}`);
        return -1;
      }
      if (n < 0) n = count + n + 1; // OBJ 负索引相对当前末尾
      if (n < 1 || n > count) {
        warnings.push(`面引用越界（已声明 ${count} 个，引用 ${s}）: ${line}`);
        return -2;
      }
      return n - 1;
    };
    const v = resolve(parts[0], vCount);
    const vt = resolve(parts[1], vtCount);
    if (v < 0) return null; // -2 越界或 -1 缺失/非法
    corners.push({ v, vt: vt < 0 ? -1 : vt }); // UV 允许缺失，但越界视为缺失
  }
  return corners;
}

/**
 * 写出标准 OBJ。
 * 位置顶点与 UV 顶点各自编号（与解析时的双索引空间一致），
 * 任意标准工具（Blender / Maya / assimp 等）都可重新载入验证。
 */
export function writeOBJ(mesh: MeshData): string {
  const out: string[] = ['# UV Inspector export — positions and UVs keep independent indices'];
  const p = mesh.positions;
  const u = mesh.uvs;
  for (let i = 0; i < p.length; i += 3) {
    out.push(`v ${fmt(p[i])} ${fmt(p[i + 1])} ${fmt(p[i + 2])}`);
  }
  for (let i = 0; i < u.length; i += 2) {
    out.push(`vt ${fmt(u[i])} ${fmt(u[i + 1])}`);
  }
  for (const f of mesh.faces) {
    const c = (ci: 0 | 1 | 2) => `${f.v[ci] + 1}/${f.uv[ci] + 1}`;
    out.push(`f ${c(0)} ${c(1)} ${c(2)}`);
  }
  return out.join('\n') + '\n';
}

function fmt(n: number): string {
  // 足够精度，同时去掉无意义的长尾
  return Number(n.toFixed(7)).toString();
}
