import { useMemo, useState } from 'react';
import {
  diffTwoRevisions,
  garbageCollectUnreachable,
  getHistory,
  previewRevision,
  restoreToRevision,
  useAppState,
  type Revision,
} from '../store/appStore';

const KIND_LABEL: Record<Revision['kind'], string> = {
  import: '导入',
  mirror: '镜像',
  fixflip: '修正翻转',
  xatlas: 'xatlas',
  restore: '恢复',
  initial: '初始',
};

const KIND_COLOR: Record<Revision['kind'], string> = {
  import: '#7fa8c9',
  mirror: '#ffc83d',
  fixflip: '#5fd08a',
  xatlas: '#5d9ef7',
  restore: '#d08bff',
  initial: '#8a94a0',
};

/** 从根做 DFS，得到带深度与分支信息的节点序列。 */
function layout(graph: NonNullable<ReturnType<typeof getHistory>>['graph']) {
  const children = new Map<string | null, Revision[]>();
  for (const rev of Object.values(graph.revisions)) {
    const key = rev.parentId;
    const arr = children.get(key) ?? [];
    arr.push(rev);
    children.set(key, arr);
  }
  for (const arr of children.values()) arr.sort((a, b) => a.seq - b.seq);
  const rows: Array<{ rev: Revision; depth: number; branch: number; isLeaf: boolean }> = [];
  const walk = (id: string | null, depth: number, branch: number) => {
    const arr = children.get(id) ?? [];
    arr.forEach((rev, i) => {
      const kidCount = (children.get(rev.id) ?? []).length;
      rows.push({ rev, depth, branch: branch * 10 + i, isLeaf: kidCount === 0 });
      walk(rev.id, depth + 1, branch * 10 + i);
    });
  };
  walk(null, 0, 0);
  return rows;
}

function fmtDelta(n: number): string {
  if (n === 0) return '0';
  return (n > 0 ? '+' : '') + n;
}

export function HistoryPanel({ onClose }: { onClose: () => void }): JSX.Element | null {
  const state = useAppState();
  const [compareA, setCompareA] = useState<string | null>(null);
  const [compareB, setCompareB] = useState<string | null>(null);

  const hist = useMemo(() => getHistory(), [state.graph, state.headId]);
  const diff = useMemo(
    () => (compareA && compareB ? diffTwoRevisions(compareA, compareB) : null),
    [compareA, compareB, state.graph],
  );

  if (!hist) return null;
  const rows = layout(hist.graph);

  const toggleCompare = (id: string) => {
    if (compareA === id) {
      setCompareA(compareB);
      setCompareB(null);
      return;
    }
    if (compareB === id) {
      setCompareB(null);
      return;
    }
    if (!compareA) setCompareA(id);
    else if (!compareB) setCompareB(id);
    else {
      setCompareA(compareB);
      setCompareB(id);
    }
  };

  return (
    <div className="history-panel">
      <div className="history-head">
        <strong>UV 修订图谱</strong>
        <span className="muted">
          {rows.length} 个版本 · 从任意节点恢复会形成分支，不覆盖原历史
        </span>
        <span style={{ flex: 1 }} />
        <button
          onClick={async () => {
            const n = await garbageCollectUnreachable();
            if (n.length === 0) alert('没有不可达草稿节点');
          }}
        >
          清理草稿
        </button>
        <button onClick={onClose}>关闭</button>
      </div>

      <div className="history-body">
        <div className="history-tree">
          {rows.map(({ rev, depth }) => {
            const isHead = rev.id === hist.headId;
            const isPreview = rev.id === state.previewId;
            const inCompare = rev.id === compareA || rev.id === compareB;
            return (
              <div
                key={rev.id}
                className={
                  'hist-row' +
                  (isHead ? ' head' : '') +
                  (isPreview ? ' preview' : '') +
                  (inCompare ? ' compare' : '')
                }
                style={{ paddingLeft: 10 + depth * 22 }}
              >
                <span className="hist-tag" style={{ background: KIND_COLOR[rev.kind] }}>
                  {KIND_LABEL[rev.kind]}
                </span>
                <button className="hist-main" title={rev.label} onClick={() => previewRevision(isPreview ? null : rev.id)}>
                  <b>v{rev.seq}</b> {rev.label}
                </button>
                <span className="muted hist-time">{new Date(rev.createdAt).toLocaleTimeString()}</span>
                <span className="hist-sum">
                  翻转 {rev.summary.flipped} · 岛 {rev.summary.islandCount} · 缝 {rev.summary.seamEdgeCount}
                </span>
                <button
                  className={'hist-cmp' + (inCompare ? ' active' : '')}
                  onClick={() => toggleCompare(rev.id)}
                  title="选择用于比较的版本"
                >
                  {rev.id === compareA ? 'A' : rev.id === compareB ? 'B' : '比'}
                </button>
                {!isHead && (
                  <button
                    className="hist-restore"
                    onClick={() => {
                      restoreToRevision(rev.id);
                    }}
                    title="以此版本为父创建恢复节点（形成分支）"
                  >
                    恢复
                  </button>
                )}
                {isHead && <span className="hist-badge">当前</span>}
              </div>
            );
          })}
        </div>

        <div className="history-side">
          {state.previewId && (
            <div className="panel">
              <h3>预览中（不移动当前版本）</h3>
              <div className="muted">视图显示所选历史版本的网格与分析；导出 OBJ 也对应此版本。</div>
              <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                <button
                  className="primary"
                  onClick={() => restoreToRevision(state.previewId!)}
                >
                  从此版本恢复（建分支）
                </button>
                <button onClick={() => previewRevision(null)}>回到当前</button>
              </div>
            </div>
          )}

          <div className="panel">
            <h3>版本比较 {compareA && compareB ? '' : '（选两个版本）'}</h3>
            {!diff && <div className="muted">点击行尾「比」选择 A、B 两个版本查看翻转/岛/接缝差异。</div>}
            {diff && (
              <table className="diff-table">
                <thead>
                  <tr><th>指标</th><th>A</th><th>B</th><th>变化</th></tr>
                </thead>
                <tbody>
                  <DiffRow name="翻转面" v={diff.flipped} bad />
                  <DiffRow name="UV 岛" v={diff.islands} />
                  <DiffRow name="接缝边" v={diff.seams} />
                  <DiffRow name="重叠面" v={diff.overlaps} bad />
                  <DiffRow name="UV 退化面" v={diff.degenerateUv} bad />
                  <DiffRow name="最大角度畸变°" v={diff.maxAngle} digits={1} />
                  <DiffRow name="面积 log2 倍率" v={diff.maxAreaLog} digits={2} />
                </tbody>
              </table>
            )}
            {diff && (diff.flippedFaceIds.added.length > 0 || diff.flippedFaceIds.removed.length > 0) && (
              <div className="muted" style={{ marginTop: 6, fontSize: 11 }}>
                {diff.flippedFaceIds.added.length > 0 && (
                  <div className="bad">新增翻转面：{diff.flippedFaceIds.added.join(', ')}</div>
                )}
                {diff.flippedFaceIds.removed.length > 0 && (
                  <div className="ok">消除翻转面：{diff.flippedFaceIds.removed.join(', ')}</div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function DiffRow({
  name,
  v,
  digits = 0,
  bad = false,
}: {
  name: string;
  v: { before: number; after: number; delta: number };
  digits?: number;
  bad?: boolean;
}): JSX.Element {
  const f = (x: number) => x.toFixed(digits);
  const cls = v.delta === 0 ? '' : bad ? (v.delta > 0 ? 'bad' : 'ok') : '';
  return (
    <tr>
      <td>{name}</td>
      <td>{f(v.before)}</td>
      <td>{f(v.after)}</td>
      <td className={cls}>{fmtDelta(Number(v.delta.toFixed(digits)))}</td>
    </tr>
  );
}
