import type { MeshData, Triangle } from '../model/types';
import { XAtlasApi } from './api';
import type { XAtlasFactory } from './types';

export interface UnwrapResult {
  mesh: MeshData;
  atlasWidth: number;
  atlasHeight: number;
}

/** xatlas WASM 构建使用 Uint16 索引，输入规模上限。 */
export const XATLAS_LIMIT = 65535;

export function validateUnwrapSize(mesh: MeshData): void {
  const vCount = mesh.positions.length / 3;
  const indexCount = mesh.faces.length * 3;
  if (vCount > XATLAS_LIMIT || indexCount > XATLAS_LIMIT) {
    throw new Error(
      `xatlas WASM 构建索引为 Uint16，顶点/角点数超过 ${XATLAS_LIMIT}（${vCount} 顶点 / ${indexCount} 角点），无法自动展开`,
    );
  }
}

let apiPromise: Promise<XAtlasApi> | null = null;

/** WASM 单例；首次调用时从本地静态资源加载（wasm 与工厂都按需分包，不占首屏）。 */
export async function loadXAtlas(onProgress?: (msg: string) => void): Promise<XAtlasApi> {
  if (!apiPromise) {
    // 两个资源都动态导入：Vite 把 wasm 产出为带哈希的本地静态资源，工厂进独立 chunk
    const [{ default: factory }, { default: wasmUrl }] = await Promise.all([
      import('../../vendor/xatlas/xatlas.js'),
      import('../../vendor/xatlas/xatlas.wasm?url'),
    ]);
    apiPromise = XAtlasApi.create(factory as unknown as XAtlasFactory, wasmUrl, onProgress);
  }
  return apiPromise;
}

/**
 * 用 xatlas 自动展开。
 *
 * 重要：xatlas 不会按空间坐标焊接顶点（这正合要求——我们也绝不按坐标合并）。
 * 它依据**输入索引的共享关系**建立邻接，因此这里喂入的是：
 * - 每个稳定位置顶点 id 对应一个输入顶点（OBJ 里重复 `v` 即便同坐标也保留为不同顶点）；
 * - 三角索引直接引用这些稳定 id。
 * xatlas 会在需要处（接缝）复制顶点；返回的 `oldIndexes` 把每个新顶点映射回
 * 稳定位置 id，从而完整恢复身份。输出位置数组复用输入，面身份顺序保持不变。
 *
 * 任何失败都向上抛出，由调用方保留原模型（本函数不修改入参）。
 */
export async function unwrapMesh(mesh: MeshData): Promise<UnwrapResult> {
  validateUnwrapSize(mesh);
  const indexCount = mesh.faces.length * 3;

  // 1) 稳定位置顶点直接作为 xatlas 输入顶点；索引即稳定 id
  const flatPositions = new Float32Array(mesh.positions); // Float64 -> Float32 拷贝
  const flatIndex = new Uint16Array(indexCount);
  mesh.faces.forEach((f, fid) => {
    flatIndex[fid * 3] = f.v[0];
    flatIndex[fid * 3 + 1] = f.v[1];
    flatIndex[fid * 3 + 2] = f.v[2];
  });

  // 2) 运行 xatlas
  const api = await loadXAtlas();
  api.createAtlas();
  try {
    api.addMesh(flatIndex, flatPositions, null);
    const result = api.generateAtlas(
      // 不喂法线；fixWinding 保持 false 以保留与面朝向一致的 UV 绕序
      // （若开启，xatlas 会把所有 chart 强行统一成 CCW，反而把朝 -X/-Y/-Z
      // 的面变成翻转）。接缝权重偏向角度/法线变化。
      { fixWinding: false, normalSeamWeight: 4, textureSeamWeight: 0.5 },
      { padding: 2, rotateChartsToAxis: true },
    );
    const out = result.meshes[0];
    if (!out) throw new Error('xatlas 未返回网格');

    // 3) 新顶点 -> 稳定位置 id（直接来自 oldIndexes）。
    //    输出复用输入位置数组，稳定身份完整保留，绝不按坐标合并。
    const newVCount = out.oldIndexes.length;
    const posIndex = new Int32Array(newVCount);
    for (let i = 0; i < newVCount; i++) {
      posIndex[i] = out.oldIndexes[i];
    }

    // 4) 新 UV 顶点（每个输出顶点都是独立 UV 身份——接缝两侧天然分离）
    const uvs: number[] = [];
    const uvIdByNewVertex: number[] = [];
    for (let i = 0; i < newVCount; i++) {
      uvIdByNewVertex.push(uvs.length / 2);
      uvs.push(out.uv[i * 2], out.uv[i * 2 + 1]);
    }

    // 5) 重建三角面；面身份沿用输入顺序（xatlas 不改三角数量与对应关系）
    if (out.index.length !== indexCount) {
      throw new Error('xatlas 返回的三角数量与输入不一致');
    }
    const faces: Triangle[] = [];
    for (let t = 0; t < out.index.length / 3; t++) {
      const ia = out.index[t * 3];
      const ib = out.index[t * 3 + 1];
      const ic = out.index[t * 3 + 2];
      faces.push({
        v: [posIndex[ia], posIndex[ib], posIndex[ic]],
        uv: [uvIdByNewVertex[ia], uvIdByNewVertex[ib], uvIdByNewVertex[ic]],
        sourceFace: mesh.faces[t].sourceFace,
      });
    }

    return {
      mesh: {
        name: `${mesh.name} (xatlas)`,
        positions: mesh.positions,
        uvs: Float64Array.from(uvs),
        faces,
      },
      atlasWidth: result.width,
      atlasHeight: result.height,
    };
  } finally {
    api.destroyAtlas();
  }
}
