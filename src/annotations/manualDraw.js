import * as Cesium from 'cesium';

const MODES = Object.freeze(['pin', 'route', 'area']);

function worldPoint(viewer, event) {
  const canvas = viewer?.scene?.canvas;
  if (!canvas) return null;
  const rect = canvas.getBoundingClientRect();
  const position = new Cesium.Cartesian2(event.clientX - rect.left, event.clientY - rect.top);
  let cartesian = null;
  try { cartesian = viewer.scene.pickPosition(position); } catch { /* fall through */ }
  if (!cartesian) {
    try { cartesian = viewer.camera.pickEllipsoid(position, Cesium.Ellipsoid.WGS84); } catch { /* no-op */ }
  }
  if (!cartesian) return null;
  const cartographic = Cesium.Cartographic.fromCartesian(cartesian);
  if (!cartographic || !Number.isFinite(cartographic.longitude) || !Number.isFinite(cartographic.latitude)) return null;
  return [Cesium.Math.toDegrees(cartographic.longitude), Cesium.Math.toDegrees(cartographic.latitude)];
}

export function createManualDrawController({ viewer, annotations, button, status, documentRef = globalThis.document } = {}) {
  let mode = null;
  let points = [];
  let destroyed = false;
  const canvas = viewer?.scene?.canvas;
  if (!canvas || !annotations?.annotate || !button) return { setMode() {}, destroy() {} };

  const update = () => {
    button.dataset.active = String(Boolean(mode));
    button.setAttribute('aria-pressed', String(Boolean(mode)));
    const label = button.querySelector('.map-draw-label');
    const text = mode ? `${mode === 'pin' ? '点' : mode === 'route' ? '路线' : '区域'}（${points.length}）` : '绘制';
    if (label) label.textContent = text; else button.setAttribute('aria-label', text);
    if (status) status.textContent = mode ? `绘制模式：${text}` : '';
  };
  const finish = async () => {
    if (!mode || !points.length || destroyed) return;
    const current = mode; const collected = points;
    points = [];
    if (current === 'pin') await annotations.annotate([{ type: 'pin', longitude: collected[0][0], latitude: collected[0][1], label: '手动标记', color: 'cyan' }], { persist: true });
    else if (current === 'route' && collected.length >= 2) {
      // Keep route waypoints in the resolver's canonical field order. The
      // resolver accepts both names, but using latitude first here prevents
      // hand-drawn paths from depending on object-property ordering in any
      // downstream adapter.
      await annotations.annotate([{
        type: 'route',
        points: collected.map(([longitude, latitude]) => ({ latitude, longitude })),
        label: '手动画线',
        color: 'amber',
      }], { persist: true });
    }
    else if (current === 'area' && collected.length >= 3) await annotations.annotate([{ type: 'area', ring: collected, label: '手动区域', color: 'green' }], { persist: true });
    mode = null;
    update();
  };
  const onClick = (event) => {
    if (!mode || destroyed) return;
    const point = worldPoint(viewer, event);
    if (!point) return;
    points = [...points, point];
    if (mode === 'pin') void finish();
    else update();
  };
  const onDoubleClick = (event) => {
    if (!mode || mode === 'pin') return;
    event.preventDefault();
    void finish();
  };
  const setMode = (next) => {
    mode = MODES.includes(next) ? next : null;
    points = [];
    update();
  };
  const onButtonClick = () => {
    const next = mode ? MODES[(MODES.indexOf(mode) + 1) % MODES.length] : 'pin';
    setMode(mode === 'area' ? null : next);
  };
  button.addEventListener('click', onButtonClick);
  canvas.addEventListener('click', onClick);
  canvas.addEventListener('dblclick', onDoubleClick);
  update();
  return {
    setMode,
    destroy() {
      destroyed = true;
      canvas.removeEventListener('click', onClick);
      canvas.removeEventListener('dblclick', onDoubleClick);
      button.removeEventListener('click', onButtonClick);
    },
  };
}
