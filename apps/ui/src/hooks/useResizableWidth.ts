import { useCallback, useState, type MouseEvent as ReactMouseEvent } from "react";

interface ResizableWidthOptions {
  storageKey: string;
  min: number;
  max: number;
  defaultValue: number;
  /** 1 表示向右拖动时变宽，-1 表示向左拖动时变宽。 */
  dragDirection?: 1 | -1;
}

function clampWidth(width: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, width));
}

function readWidth({ storageKey, min, max, defaultValue }: ResizableWidthOptions): number {
  try {
    const stored = Number(localStorage.getItem(storageKey));
    return Number.isFinite(stored) && stored >= min && stored <= max ? stored : defaultValue;
  } catch {
    return defaultValue;
  }
}

function persistWidth(storageKey: string, width: number): void {
  try {
    localStorage.setItem(storageKey, String(width));
  } catch {
    /* ignore */
  }
}

/** 统一可调宽布局的读取、拖拽、键盘调整与持久化规则。 */
export function useResizableWidth(options: ResizableWidthOptions) {
  const { storageKey, min, max, dragDirection = 1 } = options;
  const [width, setWidth] = useState(() => readWidth(options));

  const onResizeStart = useCallback((event: ReactMouseEvent<HTMLElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = width;
    let nextWidth = startWidth;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const move = (moveEvent: MouseEvent) => {
      nextWidth = clampWidth(startWidth + (moveEvent.clientX - startX) * dragDirection, min, max);
      setWidth(nextWidth);
    };
    const up = () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      persistWidth(storageKey, nextWidth);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }, [dragDirection, max, min, storageKey, width]);

  const resizeByKeyboard = useCallback((delta: number) => {
    setWidth((current) => {
      const nextWidth = clampWidth(current + delta, min, max);
      persistWidth(storageKey, nextWidth);
      return nextWidth;
    });
  }, [max, min, storageKey]);

  return { width, onResizeStart, resizeByKeyboard };
}
