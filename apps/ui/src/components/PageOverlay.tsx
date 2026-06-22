import type { ReactNode } from "react";
import { XIcon } from "../icons.js";

/** 通用浮层外壳：标题 + 关闭 + 单页内容（复用既有页面组件）。 */
export function PageOverlay({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div className="ad-overlay" onClick={onClose}>
      <div className="ad-overlay-card" onClick={(e) => e.stopPropagation()}>
        <div className="ad-ov-head">
          <span className="ad-ov-title">{title}</span>
          <span className="ad-spacer" />
          <button className="ad-ov-close" title="关闭" onClick={onClose}>
            <XIcon size={15} />
          </button>
        </div>
        <div className="ad-ov-content solo">{children}</div>
      </div>
    </div>
  );
}
