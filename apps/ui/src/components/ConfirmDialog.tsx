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

interface AlertOpts {
  title: string;
  body?: ReactNode;
}
interface PendingAlert extends AlertOpts {
  resolve: () => void;
}

export function useConfirm(): {
  confirm: (opts: ConfirmOpts) => Promise<boolean>;
  alert: (opts: AlertOpts) => Promise<void>;
  dialog: ReactNode;
} {
  const [pending, setPending] = useState<PendingConfirm | null>(null);
  const [pendingAlert, setPendingAlert] = useState<PendingAlert | null>(null);

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

  const alert = useCallback(
    (opts: AlertOpts) =>
      new Promise<void>((resolve) => {
        setPendingAlert((prev) => {
          prev?.resolve();
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

  const closeAlert = () => {
    setPendingAlert((p) => {
      p?.resolve();
      return null;
    });
  };

  const dialog: ReactNode =
    pending || pendingAlert ? (
      <div
        className="confirm-mask"
        onClick={() => {
          if (pending) close(false);
          else closeAlert();
        }}
      >
        <div
          className="confirm-box"
          role="dialog"
          aria-modal="true"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (pending) {
              if (e.key === "Escape") close(false);
              else if (e.key === "Enter") close(true);
            } else if (e.key === "Escape" || e.key === "Enter") closeAlert();
          }}
        >
          <div className="confirm-title">{pending?.title ?? pendingAlert?.title}</div>
          {(pending?.body != null || pendingAlert?.body != null) && (
            <div className="confirm-body">{pending?.body ?? pendingAlert?.body}</div>
          )}
          <div className="confirm-actions">
            {pending ? (
              <>
                <button className="confirm-cancel" onClick={() => close(false)}>
                  取消
                </button>
                <button className={`confirm-ok ${pending.danger ? "danger" : ""}`} autoFocus onClick={() => close(true)}>
                  {pending.okLabel ?? (pending.danger ? "删除" : "确定")}
                </button>
              </>
            ) : (
              <button className="confirm-ok" autoFocus onClick={closeAlert}>
                知道了
              </button>
            )}
          </div>
        </div>
      </div>
    ) : null;

  return { confirm, alert, dialog };
}
