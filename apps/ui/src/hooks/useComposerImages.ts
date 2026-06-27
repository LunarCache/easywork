import { useCallback, useRef, useState } from "react";
import type { UiImage } from "../lib/agent-stream.js";

export function useComposerImages() {
  const [images, setImages] = useState<UiImage[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  const onPickImages = useCallback(async (files: FileList | null) => {
    if (!files) return;
    const next: UiImage[] = [];
    for (const f of Array.from(files)) {
      if (!f.type.startsWith("image/")) continue;
      const dataUrl = await new Promise<string>((resolve) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result));
        r.readAsDataURL(f);
      });
      next.push({ mimeType: f.type, data: dataUrl.replace(/^data:[^;]+;base64,/, "") });
    }
    if (next.length) setImages((current) => [...current, ...next]);
  }, []);

  return { images, setImages, fileRef, onPickImages };
}
