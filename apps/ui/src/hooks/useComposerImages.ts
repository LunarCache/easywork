import { useCallback, useRef, useState, type ClipboardEvent } from "react";
import type { UiImage } from "../lib/agent-stream.js";

async function fileToUiImage(file: File): Promise<UiImage | null> {
  if (!file.type.startsWith("image/")) return null;
  const dataUrl = await new Promise<string | null>((resolve) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => resolve(null);
    r.readAsDataURL(file);
  });
  if (!dataUrl) return null;
  return {
    mimeType: file.type || "image/png",
    data: dataUrl.replace(/^data:[^;]+;base64,/, ""),
  };
}

function clipboardImageFiles(data: DataTransfer): File[] {
  const files = Array.from(data.files).filter((file) => file.type.startsWith("image/"));
  if (files.length > 0) return files;
  return Array.from(data.items)
    .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
    .map((item) => item.getAsFile())
    .filter((file): file is File => !!file);
}

export function useComposerImages() {
  const [images, setImages] = useState<UiImage[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  const appendImageFiles = useCallback(async (files: File[] | FileList | null) => {
    if (!files) return;
    const next: UiImage[] = [];
    for (const f of Array.from(files)) {
      const image = await fileToUiImage(f);
      if (image) next.push(image);
    }
    if (next.length) setImages((current) => [...current, ...next]);
  }, []);

  const onPasteImages = useCallback((event: ClipboardEvent<HTMLElement>) => {
    const files = clipboardImageFiles(event.clipboardData);
    if (files.length === 0) return;
    event.preventDefault();
    void appendImageFiles(files);
  }, [appendImageFiles]);

  return { images, setImages, fileRef, onPickImages: appendImageFiles, onPasteImages };
}
