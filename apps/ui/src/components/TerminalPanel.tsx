import { useMemo } from "react";
import { getTerminalRuntime } from "../lib/terminal-runtime.js";
import { useTerminalPanelSession } from "../hooks/useTerminalPanelSession.js";
import { useConfirm } from "./ConfirmDialog.js";
import { TerminalView } from "./TerminalView.js";
import { PlusIcon, TerminalIcon, XIcon } from "../icons.js";

export function TerminalPanel({
  open,
  onClose,
  previewScope,
  previewId,
}: {
  open: boolean;
  onClose(): void;
  previewScope: "workspace" | "chat";
  previewId: string;
}) {
  const runtime = useMemo(() => getTerminalRuntime(), []);
  const { confirm, dialog } = useConfirm();
  const {
    sessions,
    activeSessionId,
    activeSession,
    error,
    create,
    activate,
    close,
    reportError,
  } = useTerminalPanelSession({
    visible: open,
    previewScope,
    previewId,
    runtime,
    confirmClose: () => confirm({
      title: "终端中仍有前台任务",
      body: "关闭标签会结束该终端及其中正在运行的进程。",
      danger: true,
      okLabel: "结束终端",
    }),
  });

  if (!runtime.available) return null;

  return (
    <>
      <div className={`terminal-panel ${open ? "open" : ""}`} data-testid="terminal-panel" aria-hidden={!open}>
        <header className="terminal-panel-bar">
          <div className="terminal-panel-tabs" role="tablist" aria-label="终端会话">
            {sessions.map((session) => (
              <div key={session.sessionId} className={`terminal-panel-tab-shell ${activeSessionId === session.sessionId ? "on" : ""}`}>
                <button
                  type="button"
                  className="terminal-panel-tab"
                  role="tab"
                  aria-selected={activeSessionId === session.sessionId}
                  onClick={() => activate(session.sessionId)}
                >
                  <TerminalIcon size={14} />
                  <span>{session.title}</span>
                </button>
                <button
                  type="button"
                  className="terminal-panel-tab-close"
                  title={`关闭${session.title}标签`}
                  aria-label={`关闭${session.title}标签`}
                  onClick={() => void close(session.sessionId)}
                >
                  <XIcon size={11} />
                </button>
              </div>
            ))}
          </div>
          <button className="terminal-panel-action" data-testid="terminal-panel-new" title="新建终端" onClick={() => void create()}>
            <PlusIcon size={16} />
          </button>
          <span className="terminal-panel-spacer" />
          <button className="terminal-panel-action" title="收起终端" onClick={onClose}>
            <XIcon size={15} />
          </button>
        </header>
        {error && <div className="wpv-error">无法启动终端：{error}</div>}
        <div className="terminal-panel-body">
          {activeSession ? (
            <TerminalView runtime={runtime} session={activeSession} onError={reportError} />
          ) : (
            <button className="terminal-panel-empty" onClick={() => void create()}>
              <TerminalIcon size={16} /> 新建终端
            </button>
          )}
        </div>
      </div>
      {dialog}
    </>
  );
}
