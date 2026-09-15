import type { MeshData, Triangle, Vec2, Vec3 } from './types';

/**
 * 以"显式稳定 id"方式构造样例网格：
 * - `addPos` 返回位置顶点 id；即便坐标重复，每次调用也是不同身份（不焊接）。
 * - `addUv` 返回 UV 顶点 id；接缝两侧分别 addUv，即便坐标相同也保持不同身份。
 */
export class MeshBuilder {
  private positions: number[] = [];
  private uvs: number[] = [];
  private faces: Triangle[] = [];
  private sourceFace = 0;

  addPos(x: number, y: number, z: number): number {
    const id = this.positions.length / 3;
    this.positions.push(x, y, z);
    return id;
  }

  addPosV(p: Vec3): number {
    return this.addPos(p[0], p[1], p[2]);
  }

  addUv(u: number, v: number): number {
    const id = this.uvs.length / 2;
    this.uvs.push(u, v);
    return id;
  }

  addUvV(p: Vec2): number {
    return this.addUv(p[0], p[1]);
  }

  /** 添加三角面；参数为 [[位置id, UVid], ...] 三个角 */
  tri(c0: [number, number], c1: [number, number], c2: [number, number]): number {
    const id = this.faces.length;
    this.faces.push({
      v: [c0[0], c1[0], c2[0]],
      uv: [c0[1], c1[1], c2[1]],
      sourceFace: this.sourceFace,
    });
    this.sourceFace++;
    return id;
  }

  /** 四边形（两个三角形，共享一条对角位置边与 UV 边） */
  quad(
    c0: [number, number],
    c1: [number, number],
    c2: [number, number],
    c3: [number, number],
  ): [number, number] {
    const a = this.tri(c0, c1, c2);
    const b = this.tri(c0, c2, c3);
    return [a, b];
  }

  build(name: string): MeshData {
    return {
      name,
      positions: Float64Array.from(this.positions),
      uvs: Float64Array.from(this.uvs),
      faces: this.faces,
    };
  }
}
