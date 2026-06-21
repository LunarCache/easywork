import { Memory } from "../pages/Memory.js";
import { XIcon } from "../icons.js";

/** Agent Desk 记忆浮层：复用既有 Memory 页内容。 */
export function MemoryOverlay({ onClose }: { onClose: () => void }) {
  return (
    <div className="ad-overlay" onClick={onClose}>
      <div className="ad-overlay-card" onClick={(e) => e.stopPropagation()}>
        <div className="ad-ov-head">
          <span className="ad-ov-title">记忆</span>
          <span className="ad-spacer" />
          <button className="ad-ov-close" title="关闭" onClick={onClose}>
            <XIcon size={15} />
          </button>
        </div>
        <div className="ad-ov-content solo">
          <Memory />
        </div>
      </div>
    </div>
  );
}
