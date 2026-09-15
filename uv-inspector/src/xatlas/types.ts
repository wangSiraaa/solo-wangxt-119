/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * xatlas 类型声明（仅覆盖我们用到的 embind 接口）。
 * 工厂由 vendored emscripten 构建提供。
 */

export interface ChartOptions {
  fixWinding?: boolean;
  maxBoundaryLength?: number;
  maxChartArea?: number;
  maxCost?: number;
  maxIterations?: number;
  normalDeviationWeight?: number;
  normalSeamWeight?: number;
  roundnessWeight?: number;
  straightnessWeight?: number;
  textureSeamWeight?: number;
  useInputMeshUvs?: boolean;
}

export interface PackOptions {
  bilinear?: boolean;
  blockAlign?: boolean;
  bruteForce?: boolean;
  createImage?: boolean;
  maxChartSize?: number;
  padding?: number;
  resolution?: number;
  rotateCharts?: boolean;
  rotateChartsToAxis?: boolean;
  texelsPerUnit?: number;
}

export interface XAtlasMeshData {
  newVertexCount: number;
  newIndexCount: number;
  indexOffset: number;
  originalIndexOffset: number;
  uvOffset: number;
}

export interface XAtlasRawModule {
  HEAPU16: Uint16Array;
  HEAPU32: Uint32Array;
  HEAPF32: Float32Array;
  createMesh(vertexCount: number, indexCount: number, hasNormals: number, hasUvs: number): {
    meshId: number;
    indexOffset: number;
    positionOffset: number;
    normalOffset: number;
    uvOffset: number;
  };
  addMesh(): number;
  createAtlas(): void;
  destroyAtlas(): void;
  generateAtlas(chart: ChartOptions, pack: PackOptions): void;
  getAtlas(): { width: number; height: number; atlasCount: number; meshCount: number };
  getMeshData(meshId: number): XAtlasMeshData;
  destroyMeshData(data: XAtlasMeshData): void;
  doLeakCheck(): void;
  setProgressLogging(on: number): void;
}

export type XAtlasFactory = (moduleArg?: Record<string, unknown>) => Promise<XAtlasRawModule>;
