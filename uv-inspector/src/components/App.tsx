import { useEffect, useRef } from 'react';
import { Toolbar } from './Toolbar';
import { Viewport } from './Viewport';
import { StatsPanel } from './StatsPanel';
import { SAMPLES } from '../samples/samples';
import { clearNotice, loadMesh, notify, restoreLastProject, useAppState } from '../store/appStore';

export function App(): JSX.Element {
  const state = useAppState();
  const booted = useRef(false);

  // 启动：优先恢复上次保存的工程（修订图谱），无记录则载入默认样例作为根版本
  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    void (async () => {
      const restored = await restoreLastProject();
      if (!restored) {
        loadMesh(SAMPLES[0].build(), SAMPLES[0].label);
        notify('info', SAMPLES[0].description);
      } else {
        notify('info', '已恢复上次保存的工程与修订图谱');
      }
    })();
  }, []);

  // 通知自动消失
  useEffect(() => {
    if (!state.notice) return;
    const t = setTimeout(clearNotice, state.notice.kind === 'error' ? 8000 : 4500);
    return () => clearTimeout(t);
  }, [state.notice]);

  return (
    <div className="app">
      <Toolbar />
      <Viewport
        mesh={state.mesh}
        analysis={state.analysis}
        selection={state.selection}
        heat={state.heat}
        checker={state.checker}
      />
      <StatsPanel />
      {state.previewId && <div className="preview-banner">历史版本预览中 · 导出 OBJ 对应此版本 · 编辑请先退出预览</div>}
      {state.notice && <div className={`notice ${state.notice.kind}`}>{state.notice.text}</div>}
      {state.busy && (
        <div className="busy">
          <div className="box">
            <span className="spin" />
            {state.busy}
          </div>
        </div>
      )}
    </div>
  );
}
