import { useEffect } from 'react';
import { Toolbar } from './Toolbar';
import { Viewport } from './Viewport';
import { StatsPanel } from './StatsPanel';
import { SAMPLES } from '../samples/samples';
import { clearNotice, loadMesh, notify, pick, useAppState } from '../store/appStore';

export function App(): JSX.Element {
  const state = useAppState();

  // 启动时载入第一个样例，避免空白视图
  useEffect(() => {
    loadMesh(SAMPLES[0].build(), SAMPLES[0].label);
    notify('info', SAMPLES[0].description);
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
        onPick={pick}
      />
      <StatsPanel />
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
