export function calculateThemeMenuPosition(rect, viewport, contentHeight = 260) {
  const margin = 12;
  const viewportWidth = Math.max(1, Number(viewport.width) || 1);
  const viewportHeight = Math.max(1, Number(viewport.height) || 1);
  const width = Math.min(200, Math.max(1, viewportWidth - margin * 2));
  const maxHeight = Math.max(120, Math.min(390, viewportHeight - margin * 2));
  const height = Math.min(Math.max(0, Number(contentHeight) || 0), maxHeight);
  const left = Math.max(margin, Math.min(rect.right - width, viewportWidth - width - margin));
  let top = rect.bottom + 9;
  if (top + height > viewportHeight - margin) top = Math.max(margin, rect.top - height - 9);
  return { position: 'fixed', top, left, width, maxHeight, zIndex: 20000 };
}
