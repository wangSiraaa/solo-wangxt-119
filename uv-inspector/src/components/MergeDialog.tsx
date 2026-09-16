import { useMemo, useState } from 'react';
import {
  beginMerge,
  discardMerge,
  getPendingMerge,
  listBranches,
  previewMerge,
  publishMerge,
  resolveMergeConflict,
  startProposal,
  switchBranch,
  useAppState,
  notify,
} from '../store/appStore';
import { analyzeMesh } from '../analysis/analyze';
import type { MergeConflict, ResolutionKind } from '../model/revisions';

const RES_LABEL: Record<ResolutionKind, string> = {
  proposal: '采用提案',
  target: '采用目标',
  manual: '手动',
};

export function MergeDialog({ onClose }: { onClose: () => void }): JSX.Element {
  const state = useAppState();
  const [proposalName, setProposalName] = useState('提案 ' + new Date().toLocaleTimeString());

  const branches = listBranches();
  const draft = getPendingMerge();

  // 选中当前提案分支用于创建
  const currentBranch = state.graph?.currentBranchId;
  const [tab, setTab] = useState<'branches' | 'merge'>(draft ? 'merge' : 'branches');
  const [proposalId, setProposalId] = useState(draft?.proposalBranchId ?? '');
  const [targetId, setTargetId] = useState(draft?.targetBranchId ?? 'main');

  const mergedPreview = useMemo(() => {
    if (!draft || !allResolvedLocal(draft)) return null;
    const mesh = previewMerge();
    return mesh ? analyzeMesh(mesh) : null;
  }, [draft, state.graph]);

  const startMerge = () => {
    const pId = proposalId || currentBranch || '';
    if (!pId || pId === targetId) {
      notify('info', '请选择与目标不同的提案分支');
      return;
    }
    const d = beginMerge(pId, targetId);
    if (!d) {
      notify('error', '无法开始合并（分支头缺失）');
      return;
    }
    if (d.conflicts.length === 0 && d.autoFaces.length === 0) {
      notify('info', '两个分支相对共同祖先没有 UV 差异');
    } else if (d.conflicts.length === 0) {
      notify('info', `无冲突：${d.autoFaces.length} 个面可自动合并，请确认后发布`);
    } else {
      notify('info', `检测到 ${d.conflicts.length} 个冲突，请逐项决议`);
    }
  };

  const publish = () => {
    if (!draft) return;
    if (!window.confirm(
      `不可逆发布确认\n\n将把提案合并到目标分支：\n` +
      `自动合并面：${draft.autoFaces.length}\n冲突：${draft.conflicts.length}（均已决议）\n\n` +
      `合并提交不可删除（双亲节点保留双方来源）。确认发布？`,
    )) return;
    const r = publishMerge();
    if (r.ok) {
      notify('info', '合并已发布，目标分支头已更新');
      onClose();
    } else {
      notify('error', r.error || '合并失败');
    }
  };

  return (
    <div className="merge-overlay">
      <div className="merge-dialog">
        <div className="history-head">
          <strong>提案与三方合并</strong>
          <span style={{ flex: 1 }} />
          <button onClick={onClose}>关闭</button>
        </div>

        <div className="merge-tabs">
          <button className={tab === 'branches' ? 'active' : ''} onClick={() => setTab('branches')}>分支 / 提案</button>
          <button className={tab === 'merge' ? 'active' : ''} onClick={() => setTab('merge')}>
            合并{draft ? `（${draft.conflicts.filter((c) => c.resolution).length}/${draft.conflicts.length} 冲突）` : ''}
          </button>
        </div>

        {tab === 'branches' && (
          <div className="merge-body">
            <div className="panel">
              <h3>从当前版本创建提案分支</h3>
              <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                <input
                  type="text"
                  value={proposalName}
                  onChange={(e) => setProposalName(e.target.value)}
                  style={{ flex: 1, background: 'var(--bg3)', color: 'var(--text)', border: '1px solid var(--line)', borderRadius: 5, padding: '5px 8px' }}
                />
                <button
                  className="primary"
                  onClick={() => {
                    const br = startProposal(proposalName || '提案');
                    if (br) {
                      setProposalId(br.id);
                      notify('info', `已创建并切换到提案分支「${br.name}」，可在其中镜像/修正/xatlas 展开`);
                    }
                  }}
                >
                  创建提案
                </button>
              </div>
              <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
                提案从当前 head 切出，编辑提交在该分支上，不影响 main；完成后回到此面板发起合并。
              </div>
            </div>

            <div className="panel">
              <h3>分支</h3>
              <table className="diff-table">
                <thead><tr><th>分支</th><th>头版本</th><th>状态</th><th></th></tr></thead>
                <tbody>
                  {branches.map((br) => {
                    const head = state.graph!.revisions[br.headId];
                    return (
                      <tr key={br.id} style={{ background: br.id === currentBranch ? 'rgba(93,158,247,.1)' : undefined }}>
                        <td>{br.name}{br.id === 'main' ? '（主）' : ''}</td>
                        <td>v{head?.seq ?? '?'}</td>
                        <td>{br.merged ? '已合并' : br.id === currentBranch ? '当前' : ''}</td>
                        <td>
                          {br.id !== currentBranch && (
                            <button onClick={() => { switchBranch(br.id); setProposalId(br.id); }}>切换</button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {tab === 'merge' && (
          <div className="merge-body">
            {!draft && (
              <div className="panel">
                <h3>发起合并</h3>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 6 }}>
                  <label className="muted">提案分支
                    <select value={proposalId} onChange={(e) => setProposalId(e.target.value)} style={{ marginLeft: 8 }}>
                      <option value="">— 选择 —</option>
                      {branches.filter((b) => b.id !== 'main').map((b) => (
                        <option key={b.id} value={b.id}>{b.name}</option>
                      ))}
                    </select>
                  </label>
                  <label className="muted">目标分支
                    <select value={targetId} onChange={(e) => setTargetId(e.target.value)} style={{ marginLeft: 8 }}>
                      {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                    </select>
                  </label>
                  <button className="primary" onClick={startMerge} style={{ alignSelf: 'flex-start' }}>计算三方差异</button>
                </div>
              </div>
            )}

            {draft && (
              <>
                <div className="merge-conflicts">
                  <div className="panel">
                    <h3>自动合并：{draft.autoFaces.length} 面 · 冲突：{draft.conflicts.length}</h3>
                    <div className="muted" style={{ fontSize: 11 }}>
                      共同祖先 v{state.graph!.revisions[draft.baseId]?.seq}；
                      自动合并互不重叠的面改动，重叠/共享 UV 顶点的改动需逐项决议。
                    </div>
                    {draft.conflicts.map((c, i) => (
                      <ConflictRow key={c.id} index={i} conflict={c} onResolve={(r, manual) => resolveMergeConflict(c.id, r, manual)} />
                    ))}
                  </div>
                </div>

                <div className="merge-side">
                  <div className="panel">
                    <h3>合并结果预览</h3>
                    {mergedPreview ? (
                      <table className="diff-table">
                        <tbody>
                          <tr><td>翻转面</td><td>{mergedPreview.summary.flipped}</td></tr>
                          <tr><td>UV 岛</td><td>{mergedPreview.summary.islandCount}</td></tr>
                          <tr><td>接缝边</td><td>{mergedPreview.summary.seamEdgeCount}</td></tr>
                          <tr><td>重叠面</td><td>{mergedPreview.summary.overlappingFaces}</td></tr>
                          <tr><td>最大角度°</td><td>{mergedPreview.summary.maxAngleDistortion.toFixed(1)}</td></tr>
                        </tbody>
                      </table>
                    ) : (
                      <div className="muted">所有冲突决议后显示合并摘要</div>
                    )}
                    <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                      <button
                        className="primary"
                        disabled={!allResolvedLocal(draft)}
                        onClick={publish}
                      >
                        不可逆发布合并
                      </button>
                      <button onClick={() => { discardMerge(); notify('info', '已丢弃合并草稿'); }}>丢弃草稿</button>
                    </div>
                  </div>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function allResolvedLocal(draft: NonNullable<ReturnType<typeof getPendingMerge>>): boolean {
  return draft.conflicts.every((c) => c.resolution !== null);
}

function ConflictRow({
  conflict,
  index,
  onResolve,
}: {
  conflict: MergeConflict;
  index: number;
  onResolve: (r: ResolutionKind, manual?: Array<[number, number]>) => void;
}): JSX.Element {
  const [manualText, setManualText] = useState('');
  const reasonLabel = conflict.reason === 'same-face-changed' ? '同一面被双方改动' : '共享 UV 顶点冲突';
  const fmt = (c: Array<[number, number]>) => c.map((p) => `(${p[0].toFixed(2)},${p[1].toFixed(2)})`).join(' ');

  const applyManual = () => {
    // 输入 3 个 "u,v"
    const parts = manualText.trim().split(/[\s;]+/).map((s) => s.split(',').map(Number) as [number, number]);
    if (parts.length === 3 && parts.every((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]))) {
      onResolve('manual', parts);
    }
  };

  return (
    <div className={'conflict-row' + (conflict.resolution ? ' resolved' : '')}>
      <div>
        <b>#{index + 1}</b> {reasonLabel} · 面 {conflict.faceIds.join(', ')}
        {conflict.resolution && <span className="hist-badge" style={{ marginLeft: 8 }}>{RES_LABEL[conflict.resolution]}</span>}
      </div>
      <div className="muted conflict-coords">
        <span>祖先: {fmt(conflict.base.coords)}</span>
        <span>提案: {fmt(conflict.proposal.coords)}</span>
        <span>目标: {fmt(conflict.target.coords)}</span>
      </div>
      <div className="conflict-actions">
        <button
          className={conflict.resolution === 'proposal' ? 'active' : ''}
          onClick={() => onResolve('proposal')}
        >采用提案</button>
        <button
          className={conflict.resolution === 'target' ? 'active' : ''}
          onClick={() => onResolve('target')}
        >采用目标</button>
        <input
          type="text"
          placeholder="手动 u,v 三个角"
          value={manualText}
          onChange={(e) => setManualText(e.target.value)}
          style={{ flex: 1, minWidth: 160 }}
        />
        <button
          className={conflict.resolution === 'manual' ? 'active' : ''}
          onClick={applyManual}
        >手动</button>
      </div>
    </div>
  );
}
