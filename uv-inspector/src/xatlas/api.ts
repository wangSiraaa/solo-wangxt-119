/**
 * xatlas JS 包装（改编自 xatlasjs 的 api.mjs，MIT，Copyright Palash Bansal）。
 * 直接操作 embind 模块，不经过 Comlink / Web Worker：样例低模规模下足够快，
 * 且让"WASM 加载失败 / 展开失败"可以被调用方精确捕获并回退原模型。
 */
import type {
  ChartOptions,
  PackOptions,
  XAtlasFactory,
  XAtlasRawModule,
} from './types';

interface MeshRecord {
  meshId: number;
  vertices: Float32Array;
  coords: Float32Array | null;
}

export class XAtlasApi {
  private xatlas: XAtlasRawModule | null = null;
  loaded = false;
  private atlasCreated = false;
  private meshes: MeshRecord[] = [];

  static async create(
    factory: XAtlasFactory,
    wasmUrl: string,
    onProgress?: (msg: string) => void,
  ): Promise<XAtlasApi> {
    const api = new XAtlasApi();
    const mod = await factory({
      locateFile: (path: string) => (path === 'xatlas.wasm' ? wasmUrl : path),
      onAtlasProgress: () => {
        /* embind 进度回调；默认不打印以保持控制台安静 */
      },
      print: (m: string) => onProgress?.(m),
      printErr: (m: string) => onProgress?.(m),
    });
    api.xatlas = mod;
    api.loaded = true;
    return api;
  }

  createAtlas(): void {
    this.xatlas!.createAtlas();
    this.meshes = [];
    this.atlasCreated = true;
  }

  /**
   * 添加网格。
   * @param indexes 三角索引（Uint16，顶点数 <= 65535）
   * @param vertices 紧凑 xyz
   * @param coords 可选输入 UV
   */
  addMesh(
    indexes: Uint16Array,
    vertices: Float32Array,
    coords: Float32Array | null = null,
  ): number {
    if (!this.loaded || !this.atlasCreated) throw new Error('Create atlas first');
    const x = this.xatlas!;
    const desc = x.createMesh(vertices.length / 3, indexes.length, 0, coords ? 1 : 0);
    x.HEAPU16.set(indexes, desc.indexOffset / 2);
    x.HEAPF32.set(vertices, desc.positionOffset / 4);
    if (coords) x.HEAPF32.set(coords, desc.uvOffset / 4);
    const res = x.addMesh();
    if (res !== 0) throw new Error(`xatlas addMesh failed: code ${res}`);
    this.meshes.push({ meshId: desc.meshId, vertices, coords });
    return desc.meshId;
  }

  generateAtlas(
    chartOptions: Partial<ChartOptions> = {},
    packOptions: Partial<PackOptions> = {},
  ): XAtlasResult {
    if (!this.loaded || !this.atlasCreated) throw new Error('Create atlas first');
    const x = this.xatlas!;
    x.generateAtlas(
      { ...DEFAULT_CHART, ...chartOptions },
      { ...DEFAULT_PACK, ...packOptions },
    );

    const outputs: XAtlasMeshOutput[] = [];
    for (const rec of this.meshes) {
      const ret = x.getMeshData(rec.meshId);
      const vCount = ret.newVertexCount;
      const index = Uint16Array.from(
        x.HEAPU32.subarray(ret.indexOffset / 4, ret.indexOffset / 4 + ret.newIndexCount),
      );
      const oldIndexes = Uint16Array.from(
        x.HEAPU32.subarray(
          ret.originalIndexOffset / 4,
          ret.originalIndexOffset / 4 + vCount,
        ),
      );
      const uv = Float32Array.from(
        x.HEAPF32.subarray(ret.uvOffset / 4, ret.uvOffset / 4 + vCount * 2),
      );
      x.destroyMeshData(ret);
      outputs.push({ index, oldIndexes, uv });
    }
    const info = x.getAtlas();
    return { width: info.width, height: info.height, meshes: outputs };
  }

  destroyAtlas(): void {
    if (!this.atlasCreated) return;
    this.atlasCreated = false;
    this.xatlas!.destroyAtlas();
    this.meshes = [];
  }
}

export interface XAtlasMeshOutput {
  /** 新（焊接后）顶点的三角索引 */
  index: Uint16Array;
  /** 新顶点 i 对应的输入顶点 id */
  oldIndexes: Uint16Array;
  /** 新 UV */
  uv: Float32Array;
}

export interface XAtlasResult {
  width: number;
  height: number;
  meshes: XAtlasMeshOutput[];
}

const DEFAULT_CHART: ChartOptions = {
  fixWinding: false,
  maxBoundaryLength: 0,
  maxChartArea: 0,
  maxCost: 2,
  maxIterations: 1,
  normalDeviationWeight: 2,
  normalSeamWeight: 4,
  roundnessWeight: 0.01,
  straightnessWeight: 6,
  textureSeamWeight: 0.5,
  useInputMeshUvs: false,
};

const DEFAULT_PACK: PackOptions = {
  bilinear: true,
  blockAlign: false,
  bruteForce: false,
  createImage: false,
  maxChartSize: 0,
  padding: 1,
  resolution: 0,
  rotateCharts: true,
  rotateChartsToAxis: true,
  texelsPerUnit: 0,
};
