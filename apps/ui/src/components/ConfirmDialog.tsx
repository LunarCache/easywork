// 应用内确认弹窗（替代 window.confirm —— Tauri WKWebView 的 window.confirm 不可靠、不阻塞）。
// 用法：const { confirm, dialog } = useConfirm(); ... if (!(await confirm({title, body, danger}))) return; 并在 JSX 里渲染 {dialog}。
import { useCallback, useState, type ReactNode } from "react";

interface ConfirmOpts {
  title: string;
  body?: ReactNode;
  danger?: boolean;
  okLabel?: string;
}
interface PendingConfirm extends ConfirmOpts {
  resolve: (v: boolean) => void;
}

export function useConfirm(): { confirm: (opts: ConfirmOpts) => Promise<boolean>; dialog: ReactNode } {
  const [pending, setPending] = useState<PendingConfirm | null>(null);

  const confirm = useCallback(
    (opts: ConfirmOpts) =>
      new Promise<boolean>((resolve) => {
        setPending((prev) => {
          prev?.resolve(false); // 重入：放弃前一个确认（视为取消），避免其 promise 永不 resolve 而泄漏
          return { ...opts, resolve };
        });
      }),
    [],
  );

  const close = (v: boolean) => {
    setPending((p) => {
      p?.resolve(v);
      return null;
    });
  };

  const dialog: ReactNode = pending ? (
    <div className="confirm-mask" onClick={() => close(false)}>
      <div
        className="confirm-box"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") close(false);
          else if (e.key === "Enter") close(true);
        }}
      >
        <div className="confirm-title">{pending.title}</div>
        {pending.body != null && <div className="confirm-body">{pending.body}</div>}
        <div className="confirm-actions">
          <button className="confirm-cancel" onClick={() => close(false)}>
            取消
          </button>
          <button className={`confirm-ok ${pending.danger ? "danger" : ""}`} autoFocus onClick={() => close(true)}>
            {pending.okLabel ?? (pending.danger ? "删除" : "确定")}
          </button>
        </div>
      </div>
    </div>
  ) : null;

  return { confirm, dialog };
}
