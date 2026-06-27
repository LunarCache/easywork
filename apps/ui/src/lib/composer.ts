const MAX_COMPOSER_HEIGHT = 160;
const MIN_COMPOSER_HEIGHT = "24px";

export function autoGrowComposer(el: HTMLTextAreaElement) {
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, MAX_COMPOSER_HEIGHT)}px`;
  el.style.overflowY = el.scrollHeight > MAX_COMPOSER_HEIGHT ? "auto" : "hidden";
}

export function resetComposer(el: HTMLTextAreaElement | null) {
  if (!el) return;
  el.style.height = MIN_COMPOSER_HEIGHT;
  el.style.overflowY = "hidden";
}

export function focusComposerEnd(el: HTMLTextAreaElement | null) {
  if (!el) return;
  el.focus();
  el.setSelectionRange(el.value.length, el.value.length);
  autoGrowComposer(el);
}
