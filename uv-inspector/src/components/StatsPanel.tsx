import * as THREE from 'three';
import { COLORS } from '../three/visuals';
import { clearSelection, selectFaces, selectIslandFaces, useAppState } from '../store/appStore';
import type { FaceMetrics } from '../model/types';

const cssHex = (n: number) => `#${new THREE.Color(n).getHexString()}`;

export function StatsPanel(): JSX.Element | null {
  const { mesh, analysis, selection } = useAppState();
  if (!mesh || !analysis) return null;
  const s = analysis.summary;

  const flag = (n: number, suffix = '') =>
    n > 0 ? <span className="bad">{n}{suffix}</span> : <span className="ok">0{suffix}</span>;

  const selectedMetrics: FaceMetrics[] = [...selection]
    .filter((id) => id < analysis.faces.length)
    .map((id) => analysis.faces[id])
    .sort((a, b) => a.faceId - b.faceId);

  // 选中面所属岛
  const selectedIslands = new Set(
    selectedMetrics.map((fm) => analysis.islands.findIndex((isl) => isl.faces.includes(fm.faceId))),
  );

  return (
    <div className="side">
      <section className="panel">
        <h3>模型统计</h3>
        <div className="stat-grid">
          <span className="k">位置顶点（稳定 v 身份）</span>
          <span className="v">{mesh.positions.length / 3}</span>
          <span className="k">UV 顶点（稳定 vt 身份）</span>
          <span className="v">{mesh.uvs.length / 2}</span>
          <span className="k">三角面（稳定面身份）</span>
          <span className="v">{s.faceCount}</span>
          <span className="k">UV 岛</span>
          <span className="v">{s.islandCount}</span>
        </div>
      </section>

      <section className="panel">
        <h3>绕序 / 退化 / 重叠</h3>
        <div className="stat-grid">
          <span className="k">翻转面（UV 绕序相反）</span>
          <span className="v">{flag(s.flipped)}</span>
          <span className="k">3D 退化面（不参与比率）</span>
          <span className="v">{s.degenerate3d > 0 ? <span className="warn">{s.degenerate3d}</span> : <span className="ok">0</span>}</span>
          <span className="k">UV 退化面（不参与比率）</span>
          <span className="v">{s.degenerateUv > 0 ? <span className="warn">{s.degenerateUv}</span> : <span className="ok">0</span>}</span>
          <span className="k">UV 重叠面</span>
          <span className="v">{flag(s.overlappingFaces)}</span>
        </div>
      </section>

      <section className="panel">
        <h3>面积畸变（独立显示）</h3>
        <div className="stat-grid">
          <span className="k">最大倍率偏差 |log2|</span>
          <span className="v">{s.maxAreaRatioLog.toFixed(3)}</span>
          <span className="k">对应最大拉伸倍率</span>
          <span className="v">×{Math.pow(2, s.maxAreaRatioLog).toFixed(2)}</span>
        </div>
        <div className="heatbar" title="绿=均匀 红=严重" />
        <div className="muted" style={{ fontSize: 11 }}>
          比率 = 该面 UV 面积密度 / 全网格中位密度；1 为均匀。退化面不参与。
        </div>
      </section>

      <section className="panel">
        <h3>角度畸变（独立显示）</h3>
        <div className="stat-grid">
          <span className="k">最大内角偏差</span>
          <span className="v">{s.maxAngleDistortion.toFixed(2)}°</span>
          <span className="k">平均最大偏差</span>
          <span className="v">{s.meanAngleDistortion.toFixed(2)}°</span>
        </div>
        <div className="heatbar" title="绿=保角 红=严重" />
        <div className="muted" style={{ fontSize: 11 }}>
          逐对角比较 3D 与 UV 三角形内角。退化面不参与。
        </div>
      </section>

      <section className="panel">
        <h3>拓扑</h3>
        <div className="stat-grid">
          <span className="k">接缝边（共享位置边，UV 切开）</span>
          <span className="v" style={{ color: cssHex(COLORS.seam) }}>
            {s.seamEdgeCount}
          </span>
          <span className="k">非流形边（面数 ≠ 1/2）</span>
          <span className="v" style={{ color: s.nonManifoldEdgeCount ? cssHex(COLORS.nonManifold) : undefined }}>
            {s.nonManifoldEdgeCount}
          </span>
        </div>
        <div className="legend" style={{ marginTop: 8 }}>
          <span><span className="dot" style={{ background: cssHex(COLORS.seam) }} />接缝（UV 两侧分开）</span>
          <span><span className="dot" style={{ background: cssHex(COLORS.nonManifold) }} />非流形边</span>
          <span><span className="dot" style={{ background: cssHex(COLORS.overlap) }} />UV 重叠面</span>
          <span><span className="dot" style={{ background: cssHex(COLORS.selected) }} />当前选中</span>
        </div>
      </section>

      <section className="panel">
        <h3>UV 岛（{analysis.islands.length}）</h3>
        {analysis.islands.map((isl) => (
          <div className="metric-row" key={isl.id}>
            <span>
              岛 {isl.id} · {isl.faces.length} 面
              {isl.mirrored && <span className="bad"> · 镜像翻转</span>}
            </span>
            <button
              onClick={() => selectIslandFaces(isl.faces)}
              title="在两个视图中选中该岛"
            >
              选择
            </button>
          </div>
        ))}
      </section>

      {selectedMetrics.length > 0 && (
        <section className="panel">
          <h3>
            选中面（{selectedMetrics.length}）
            {selectedIslands.size > 0 && (
              <button style={{ marginLeft: 8, padding: '1px 7px', fontSize: 11 }} onClick={clearSelection}>
                清除
              </button>
            )}
          </h3>
          <div style={{ maxHeight: 220, overflowY: 'auto' }}>
            <table className="faces">
              <thead>
                <tr>
                  <th>面</th>
                  <th>面积倍率</th>
                  <th>角度°</th>
                  <th>状态</th>
                </tr>
              </thead>
              <tbody>
                {selectedMetrics.map((fm) => (
                  <tr
                    key={fm.faceId}
                    className="sel"
                    onClick={() => selectFaces([fm.faceId])}
                    title="点击只选此面"
                  >
                    <td>#{fm.faceId}</td>
                    <td>{fm.areaRatio === null ? '—' : fm.areaRatio.toFixed(3)}</td>
                    <td>{fm.angleDistortion === null ? '—' : fm.angleDistortion.toFixed(1)}</td>
                    <td>
                      {fm.flipped && <span className="bad" title="翻转">翻 </span>}
                      {(fm.degenerate3d || fm.degenerateUv) && (
                        <span className="warn" title="退化（不参与比率）">退 </span>
                      )}
                      {fm.overlaps.length > 0 && <span style={{ color: cssHex(COLORS.overlap) }}>叠</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
