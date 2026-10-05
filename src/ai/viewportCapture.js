export function viewportFrameKey(viewer) {
  const camera = viewer?.camera;
  const canvas = viewer?.scene?.canvas;
  const values = [camera?.positionWC?.x, camera?.positionWC?.y, camera?.positionWC?.z,
    camera?.heading, camera?.pitch, camera?.roll, canvas?.width, canvas?.height];
  if (!values.every(Number.isFinite) || !canvas.width || !canvas.height) return null;
  return JSON.stringify([viewer.scene.mode, ...values]);
}

function copyFrame(source, documentRef, maxDimension = 1600) {
  const budget = Number.isFinite(maxDimension) ? Math.max(1, Math.min(4096, maxDimension)) : 1600;
  const scale = Math.min(1, budget / Math.max(source.width, source.height));
  const width = Math.max(1, Math.round(source.width * scale));
  const height = Math.max(1, Math.round(source.height * scale));
  const canvas = documentRef.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return null;
  context.drawImage(source, 0, 0, width, height);
  const pixels = context.getImageData(0, 0, width, height).data;
  let light = 0;
  // Empty WebGL buffers must not become evidence of an empty scene.
  for (let i = 0; i < pixels.length; i += 4 * 97) {
    if (pixels[i + 3] > 8) light += pixels[i] + pixels[i + 1] + pixels[i + 2];
  }
  if (light < (pixels.length / (4 * 97)) * 6) return null;
  const image = canvas.toDataURL('image/jpeg', 0.9);
  if (!image.startsWith('data:image/jpeg;base64,') || image.length > 7_000_000) return null;
  return { image, width, height };
}

/** Copy inside postRender, before a non-preserved WebGL buffer can be cleared. */
export function captureViewportFrame(viewer, {
  documentRef = globalThis.document, signal, now = Date.now, timeoutMs = 8000, maxDimension = 1600,
} = {}) {
  const scene = viewer?.scene;
  if (!viewportFrameKey(viewer) || documentRef?.hidden || signal?.aborted
    || !documentRef?.createElement || !scene?.postRender?.addEventListener) return Promise.resolve(null);
  return new Promise((resolve) => {
    let remove = () => {};
    let timer;
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      remove();
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      resolve(result);
    };
    const abort = () => done(null);
    timer = setTimeout(abort, timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    try {
      remove = scene.postRender.addEventListener(() => {
        if (documentRef.hidden || signal?.aborted) return done(null);
        if (scene.globe?.tilesLoaded === false) return;
        try {
          const frame = copyFrame(scene.canvas, documentRef, maxDimension);
          done(frame ? { ...frame, capturedAt: now(), viewKey: viewportFrameKey(viewer) } : null);
        } catch { done(null); }
      });
      scene.requestRender?.();
    } catch { done(null); }
  });
}
