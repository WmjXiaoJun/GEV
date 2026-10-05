import * as Cesium from 'cesium';
import { terrainRouteColor, terrainRole, terrainDetailVisible } from './terrainStyle.js';
import { t } from '../i18n.js';

/**
 * World-space annotation renderer (Direction A).
 *
 * Draws annotations as native Cesium entities anchored to lon/lat. Because they
 * live in the 3D scene they track the camera, sit at the right depth, and are
 * occluded by the photoreal buildings the way a real marker would be.
 *
 * IMPORTANT — drawing on Google Photorealistic 3D Tiles:
 *   The Cesium globe is hidden, so there is no terrain to clamp to. Ground
 *   geometry (areas, rings, connectors) is draped onto the photoreal tiles with
 *   `classificationType: CESIUM_3D_TILE`; points and labels clamp to the tile
 *   surface with `heightReference: CLAMP_TO_GROUND` (which requires the tileset
 *   to have `enableCollision = true`, set in initAnnotations). This keeps marks
 *   sitting ON the world instead of buried at sea level.
 *
 * Live alpha (fade in/out) and pulsing are driven by CallbackProperty so they
 * animate every render without the engine touching them per frame.
 *
 * Renderer contract (shared with the screen-space renderer):
 *   add(anno) / remove(anno) / sync(map) / destroy()
 */

const PALETTE = {
  primary: '#8be9ff',
  amber: '#ffb547',
  cyan: '#39d0ff',
  green: '#5dff9f',
  red: '#ff6b6b',
};


const CLASSIFY = Cesium.ClassificationType.CESIUM_3D_TILE;
const CLAMP = Cesium.HeightReference.CLAMP_TO_GROUND;

export function createWorldAnnotationRenderer(viewer) {
  const dataSource = new Cesium.CustomDataSource('gev-annotations');
  viewer.dataSources.add(dataSource);

  // Register the GevRouteFlow fabric once so Cesium's Material.fromType() can build the
  // material the route pipeline renders. The animated `time` uniform is read straight
  // from performance.now() inside FlowMaterialProperty.getValue (which Cesium calls each
  // rendered frame with the live uniforms object), so the dashes flow with no extra
  // per-frame bookkeeping.
  ensureFlowFabricRegistered();

  function colorFor(anno) {
    return Cesium.Color.fromCssColorString(PALETTE[anno.color] || PALETTE.primary);
  }

  // Classification primitives only draw where their target (3D Tiles or
  // terrain) exists. The app frequently falls back to an imagery globe;
  // forcing CESIUM_3D_TILE in that mode makes polygons disappear. Keep this
  // decision dynamic so map-stack switches affect newly-created marks.
  function hasVisibleTileset() {
    return viewer?.scene?.globe?.show === false;
  }

  function classificationType() {
    return hasVisibleTileset() ? CLASSIFY : undefined;
  }

  // Target-ring radius (meters) scaled to camera height so it reads at any
  // altitude. Read once per frame for BOTH ellipse axes — camera height is
  // constant within a frame, so semiMajor === semiMinor always holds.
  function ringRadius() {
    const h = viewer.camera.positionCartographic?.height ?? 1000;
    return Math.max(14, Math.min(170, h * 0.03));
  }

  // A live color that follows the annotation's fade alpha and an optional pulse.
  function liveColor(anno, base, { alpha = 0.9, pulse = false } = {}) {
    return new Cesium.CallbackProperty(() => {
      const a = (anno.alpha ?? 1) * alpha * (pulse ? pulseFactor() : 1);
      return base.withAlpha(Math.max(0, Math.min(1, a)));
    }, false);
  }

  // Analytical terrain overlays can contain dozens of lines/points. Cesium
  // evaluates this property while rendering, so zooming out hides the noisy
  // detail immediately without rebuilding or mutating the annotation store.
  function terrainVisible(anno) {
    return terrainDetailVisible(anno, viewer?.camera?.positionCartographic?.height);
  }

  function visibilityProperty(anno) {
    return new Cesium.CallbackProperty(() => terrainVisible(anno), false);
  }

  let activeAnnotation = null;
  function addEntity(definition) {
    // Entity.show is a boolean. Dynamic visibility belongs on each graphic.
    const show = visibilityProperty(activeAnnotation);
    return dataSource.entities.add(Object.fromEntries(Object.entries(definition).map(([key, value]) =>
      [key, ['polygon', 'polyline', 'ellipse', 'point', 'label'].includes(key) && value ? { ...value, show } : value])));
  }

  function add(anno) {
    const base = colorFor(anno);
    // Published to the mark BEFORE anything is added, and mutated in place as
    // each entity lands: a mid-add failure (bad geometry, lost context) must
    // leave the entities that DID land visible to remove(), or the rollback
    // path cannot reach them and they stay on the globe forever.
    const entities = [];
    anno._entities = entities;
    activeAnnotation = anno;

    if (anno.ring && anno.ring.length >= 3 && anno.footprintKind === 'building' && hasVisibleTileset()) {
      // Single building → the PRIMARY highlight is an extruded CLASSIFICATION
      // volume that tints the real photogrammetry mesh (dome, walls, roof —
      // everything inside the column) amber and pulses. A flat footprint
      // extrusion is only 2.5D and misses domes; classification colors the
      // actual tiles. A faint wireframe cage rides on top as a secondary cue.
      const buffered = bufferRing(anno.ring, 3);
      const positions = Cesium.Cartesian3.fromDegreesArray(buffered.flat());
      const groundH = sampleGroundOutside(viewer.scene, anno.ring)
        ?? (Number.isFinite(anno.anchor.height) ? anno.anchor.height - (anno.buildingHeight || 25) : 0);
      const baseH = groundH - 3;
      // Tall headroom is free: classification only colors where tiles exist, so
      // empty air above the roof isn't tinted — this just guarantees we cover
      // under-tagged building heights.
      const topH = groundH + Math.max(18, anno.buildingHeight || 25) + 24;
      // 1) Classification volume — tints the mesh amber, pulsing.
      entities.push(addEntity({
        polygon: {
          hierarchy: new Cesium.PolygonHierarchy(positions),
          height: baseH,
          extrudedHeight: topH,
          perPositionHeight: false,
          classificationType: classificationType(),
          material: new Cesium.ColorMaterialProperty(liveColor(anno, base, { alpha: 0.45, pulse: true })),
        },
      }));
      // 2) Faint, SIMPLIFIED wireframe cage — secondary, lower opacity. Decimate
      // the footprint so the extruded outline draws ~14 clean verticals, not one
      // per (often 100+) ring vertex.
      const cagePositions = Cesium.Cartesian3.fromDegreesArray(decimateRing(buffered, 14).flat());
      entities.push(addEntity({
        polygon: {
          hierarchy: new Cesium.PolygonHierarchy(cagePositions),
          height: baseH,
          extrudedHeight: topH,
          perPositionHeight: false,
          fill: false,
          outline: true,
          outlineColor: liveColor(anno, base, { alpha: 0.32, pulse: true }),
        },
      }));
      // 3) Crisp draped base outline so the footprint reads on the ground.
      entities.push(addEntity({
        polyline: {
          positions,
          width: 3,
          material: new Cesium.PolylineGlowMaterialProperty({ glowPower: 0.25, color: liveColor(anno, base, { alpha: 0.7 }) }),
          clampToGround: true,
          classificationType: classificationType(),
        },
      }));
      if (anno.label) entities.push(labelMarker(anno, base, { point: false }));
    } else if (anno.ring && anno.ring.length >= 3) {
      // Larger area (district / compound / park) → flat fill draped on the tiles
      // + a glowing outline. Draping is right here: you can't extrude a whole
      // neighbourhood, and the GIS overlay shows the boundary clearly.
      const fillPositions = Cesium.Cartesian3.fromDegreesArray(anno.ring.flat());
      entities.push(addEntity({
        polygon: {
          hierarchy: new Cesium.PolygonHierarchy(fillPositions),
          // A regular globe needs an explicit ground reference. Without it the
          // polygon is created at ellipsoid height zero and can be buried by
          // terrain; classification is intentionally omitted in this mode.
          ...(hasVisibleTileset() ? {} : { heightReference: CLAMP }),
          // Synthesized (approximate) areas get a fainter fill so they don't read as solid.
          material: new Cesium.ColorMaterialProperty(liveColor(anno, base, { alpha: anno.source === 'terrain-analysis' ? 0.025 : anno.synthesized ? 0.10 : 0.20, pulse: anno.source !== 'terrain-analysis' })),
          classificationType: classificationType(),
        },
      }));
      entities.push(addEntity({
        polyline: {
          positions: fillPositions,
          width: anno.source === 'terrain-analysis' ? 1.2 : 6,
          // Synthesized → DASHED outline (signals "approximate, not an authoritative
          // boundary", research §8.4/§8.6); real footprints → solid glow.
          material: anno.source === 'terrain-analysis'
            ? new Cesium.ColorMaterialProperty(liveColor(anno, base, { alpha: 0.55 }))
            : anno.synthesized
            ? new Cesium.PolylineDashMaterialProperty({ color: liveColor(anno, base, { alpha: 0.95 }), dashLength: 24 })
            : new Cesium.PolylineGlowMaterialProperty({ glowPower: 0.35, color: liveColor(anno, base, { alpha: 1 }) }),
          clampToGround: true,
          classificationType: classificationType(),
        },
      }));
      if (anno.label) entities.push(labelMarker(anno, base, { point: false }));
    } else if (anno.type === 'route' && Array.isArray(anno.path) && anno.path.length >= 2) {
      // Terrain contours use the same route primitive for ground draping, but
      // must not look like a navigable route. Keep them thin and quiet; real
      // routes retain the animated flow treatment and stronger width.
      const isTerrainContour = anno.source === 'terrain-analysis' && anno.suppressRouteMetrics === true;
      const isTerrainRoute = !isTerrainContour && anno.path.some((point) => Number.isFinite(point?.slopeDeg));
      const positions = Cesium.Cartesian3.fromDegreesArray(
        anno.path.flatMap((p) => [p.lon, p.lat]),
      );
      if (isTerrainRoute) {
        for (let i = 1; i < anno.path.length; i += 1) {
          const from = anno.path[i - 1]; const to = anno.path[i];
          const slope = to.slopeDeg;
          const color = Cesium.Color.fromCssColorString(terrainRouteColor(slope));
          entities.push(addEntity({ polyline: {
            positions: Cesium.Cartesian3.fromDegreesArray([from.lon, from.lat, to.lon, to.lat]),
            width: 4,
            material: new Cesium.PolylineOutlineMaterialProperty({ outlineWidth: 1, outlineColor: Cesium.Color.fromCssColorString('#12201e'), color: liveColor(anno, color, { alpha: 0.95 }) }),
            clampToGround: true,
            classificationType: classificationType(),
          } }));
        }
        for (let i = 0; i < anno.path.length; i += 1) {
          const point = anno.path[i];
          const slope = i === 0 ? anno.path[1]?.slopeDeg : point.slopeDeg;
          const color = Cesium.Color.fromCssColorString(terrainRouteColor(slope));
          entities.push(addEntity({ position: Cesium.Cartesian3.fromDegrees(point.lon, point.lat), point: {
            pixelSize: i === 0 || i === anno.path.length - 1 ? 12 : 8, color: liveColor(anno, color, { alpha: 1 }),
            outlineColor: liveColor(anno, Cesium.Color.WHITE, { alpha: 0.9 }), outlineWidth: 2,
            heightReference: CLAMP, disableDepthTestDistance: Number.POSITIVE_INFINITY,
          }, ...(i === 0 || i === anno.path.length - 1 ? {label: {
            ...labelGraphic(anno, color), text: new Cesium.CallbackProperty(() => t(i === 0 ? 'terrain.routeStart' : 'terrain.routeEnd'), false),
          }} : {}) }));
        }
        if (anno.label) entities.push(labelMarker(anno, base, { point: false }));
        return;
      }
      entities.push(addEntity({
        polyline: {
          positions,
          width: isTerrainContour
            ? (anno.visibilityClass === 'contour-primary' ? 1.6 : 1)
            : 9,
          material: isTerrainContour
            ? new Cesium.ColorMaterialProperty(liveColor(anno, Cesium.Color.fromCssColorString('#b1d2b9'), { alpha: anno.visibilityClass === 'contour-primary' ? 0.7 : 0.45 }))
            : hasVisibleTileset()
            ? new FlowMaterialProperty(PALETTE[anno.color] || PALETTE.primary)
            : new Cesium.PolylineGlowMaterialProperty({
              glowPower: 0.35,
              color: liveColor(anno, base, { alpha: 1 }),
            }),
          clampToGround: true,
          classificationType: classificationType(),
        },
      }));
      if (anno.label) entities.push(labelMarker(anno, base, { point: false }));
    } else if (anno.type === 'arrow' && anno.to) {
      // Connector draped across the ground from origin to destination.
      const positions = [
        Cesium.Cartesian3.fromDegrees(anno.anchor.lon, anno.anchor.lat),
        Cesium.Cartesian3.fromDegrees(anno.to.lon, anno.to.lat),
      ];
      entities.push(addEntity({
        polyline: {
          positions,
          width: 16,
          material: new Cesium.PolylineArrowMaterialProperty(liveColor(anno, base, { alpha: 0.95 })),
          clampToGround: true,
          classificationType: classificationType(),
        },
      }));
      if (anno.label) {
        const mid = {
          lon: (anno.anchor.lon + anno.to.lon) / 2,
          lat: (anno.anchor.lat + anno.to.lat) / 2,
        };
        entities.push(addEntity({
          position: Cesium.Cartesian3.fromDegrees(mid.lon, mid.lat),
          label: labelGraphic(anno, base),
        }));
      }
    } else {
      // pin / highlight / label — a camera-proportional target ring + a marker.
      if (anno.type !== 'label' && !terrainRole(anno)) {
        // Radius scales with camera height so the ring reads at any altitude.
        // semiMajor === semiMinor is required AND must hold every frame, so both
        // axes read the SAME ringRadius() (camera height is constant per frame).
        entities.push(addEntity({
          position: Cesium.Cartesian3.fromDegrees(anno.anchor.lon, anno.anchor.lat),
          ellipse: {
            semiMajorAxis: new Cesium.CallbackProperty(ringRadius, false),
            semiMinorAxis: new Cesium.CallbackProperty(ringRadius, false),
            material: new Cesium.ColorMaterialProperty(liveColor(anno, base, { alpha: 0.38, pulse: true })),
            outline: false,
            classificationType: classificationType(),
          },
        }));
      }
      entities.push(labelMarker(anno, base, { point: true }));
    }
  }

  // A clamped point + (optional) label that sits on the tile surface.
  function labelMarker(anno, base, { point }) {
    return addEntity({
      position: Cesium.Cartesian3.fromDegrees(anno.anchor.lon, anno.anchor.lat),
      point: point ? {
        pixelSize: anno.type === 'label' ? 8 : 14,
        color: liveColor(anno, base, { alpha: 1 }),
        outlineColor: liveColor(anno, Cesium.Color.WHITE, { alpha: 0.95 }),
        outlineWidth: 3,
        heightReference: CLAMP,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      } : undefined,
      label: anno.label ? labelGraphic(anno, base) : undefined,
    });
  }

  function labelGraphic(anno, base) {
    return {
      text: anno.label,
      font: '600 14px "Inter", system-ui, sans-serif',
      fillColor: liveColor(anno, Cesium.Color.WHITE, { alpha: 1 }),
      outlineColor: liveColor(anno, Cesium.Color.BLACK, { alpha: 0.85 }),
      outlineWidth: 3,
      style: Cesium.LabelStyle.FILL_AND_OUTLINE,
      verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
      pixelOffset: new Cesium.Cartesian2(0, -16),
      showBackground: true,
      backgroundColor: new Cesium.CallbackProperty(
        () => Cesium.Color.fromCssColorString('#0b1622').withAlpha(0.72 * (anno.alpha ?? 1)),
        false,
      ),
      backgroundPadding: new Cesium.Cartesian2(8, 5),
      heightReference: CLAMP,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
      scaleByDistance: new Cesium.NearFarScalar(500, 1.05, 14000, 0.55),
    };
  }

  function remove(anno) {
    if (!anno?._entities) return;
    for (const entity of anno._entities) {
      try {
        dataSource.entities.remove(entity);
      } catch {
        /* already gone */
      }
    }
    anno._entities = null;
  }

  function sync() {
    // No-op: CallbackProperty drives per-frame alpha/pulse animation.
  }

  function destroy() {
    try {
      viewer.dataSources.remove(dataSource, true);
    } catch {
      /* scene torn down */
    }
  }

  return { add, remove, sync, destroy };
}

function pulseFactor() {
  // 0.6 .. 1.0 sinusoid at ~0.8 Hz
  return 0.8 + 0.2 * Math.sin(performance.now() * 0.005);
}

/**
 * A custom Fabric polyline material whose dashes flow toward the destination.
 * `materialInput.st.s` is the along-line coordinate (0 = origin, 1 = destination),
 * so `fract(s*repeat - time*speed)` scrolls the pattern toward the end. Works on
 * a clamped/classified ground polyline (PolylineMaterialAppearance supports it).
 */
function makeRouteFlowMaterial(colorCss) {
  return new Cesium.Material({
    fabric: {
      type: 'GevRouteFlow',
      uniforms: {
        color: Cesium.Color.fromCssColorString(colorCss).withAlpha(0.95),
        time: 0.0,
        repeat: 64.0, // dash cells along the whole route
        duty: 0.46, // fraction of each cell that is "on"
        speed: 0.55, // cells per second toward the destination
      },
      source: `
        czm_material czm_getMaterial(czm_materialInput materialInput) {
          czm_material m = czm_getDefaultMaterial(materialInput);
          float s = materialInput.st.s;                  // 0 origin -> 1 dest
          float flow = fract(s * repeat - time * speed); // scroll toward dest
          float on = smoothstep(duty + 0.08, duty - 0.08, flow);
          // keep a faint baseline so the whole route stays readable between dashes
          float a = max(on, 0.18);
          m.diffuse = color.rgb;
          m.emission = color.rgb * on * 0.9;             // glow on the lit cells
          m.alpha = color.a * a;
          return m;
        }`,
    },
  });
}

let _flowFabricRegistered = false;
/** Register the GevRouteFlow fabric ONCE so Cesium's `Material.fromType('GevRouteFlow')`
 *  can build the material the render pipeline uses. Constructing one Material with the
 *  fabric caches it under its type name. */
function ensureFlowFabricRegistered() {
  if (_flowFabricRegistered) return;
  makeRouteFlowMaterial('#ffffff'); // side effect: registers the 'GevRouteFlow' type
  _flowFabricRegistered = true;
}

/**
 * MaterialProperty for the animated route. Cesium builds the rendered Material once
 * from getType() (our registered GevRouteFlow fabric), then EACH FRAME calls
 * getValue(time, material.uniforms) and uses whatever we write INTO that uniforms
 * object — it ignores the return value. So getValue writes color/time/repeat/duty/
 * speed straight onto `result` (the live uniforms). Writing the animated `time` here
 * is what actually makes the dashes flow on the GPU. (The prior versions either
 * returned a standalone Material Cesium never rendered, or treated `result` as a
 * Material — both left the real uniforms untouched, so nothing animated.)
 */
function FlowMaterialProperty(colorCss) {
  this._color = Cesium.Color.fromCssColorString(colorCss).withAlpha(0.95);
  this._definitionChanged = new Cesium.Event();
}
Object.defineProperties(FlowMaterialProperty.prototype, {
  isConstant: { get() { return false; } }, // re-evaluated each frame → it animates
  definitionChanged: { get() { return this._definitionChanged; } },
});
FlowMaterialProperty.prototype.getType = function getType() {
  return 'GevRouteFlow';
};
FlowMaterialProperty.prototype.getValue = function getValue(time, result) {
  // `result` IS the live uniforms object Cesium renders — write into it directly.
  // `time` is read straight from the wall clock so the dashes flow every rendered
  // frame (the scene renders continuously; no requestRenderMode here).
  if (!Cesium.defined(result)) result = {};
  result.color = this._color;
  result.time = performance.now() / 1000; // the per-frame animated value
  result.repeat = 64.0;
  result.duty = 0.46;
  result.speed = 0.55;
  return result;
};
FlowMaterialProperty.prototype.equals = function equals(other) {
  return this === other;
};

/** Evenly down-sample a [[lon,lat],...] ring to at most n points (keeps shape). */
function decimateRing(ring, n) {
  if (ring.length <= n) return ring;
  const out = [];
  for (let i = 0; i < n; i++) out.push(ring[Math.floor((i * ring.length) / n)]);
  return out;
}

/**
 * Sample the ground height (m) just OUTSIDE a building footprint. Sampling at
 * the centroid would clamp onto the roof, so we probe several points beyond the
 * footprint radius and take a low percentile (≈ ground). Returns null if the
 * tiles under those points aren't loaded yet.
 */
function sampleGroundOutside(scene, ring) {
  if (!scene?.clampToHeightSupported || typeof scene.clampToHeight !== 'function') return null;
  let clon = 0;
  let clat = 0;
  for (const [lon, lat] of ring) { clon += lon; clat += lat; }
  clon /= ring.length;
  clat /= ring.length;
  const latS = 111320;
  const lonS = latS * Math.cos(Cesium.Math.toRadians(clat));
  let maxR = 0;
  for (const [lon, lat] of ring) {
    maxR = Math.max(maxR, Math.hypot((lon - clon) * lonS, (lat - clat) * latS));
  }
  const out = maxR * 1.5 + 12;
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [0.7, 0.7], [-0.7, -0.7], [0.7, -0.7], [-0.7, 0.7]];
  const samples = [];
  for (const [dx, dy] of dirs) {
    const lon = clon + (dx * out) / lonS;
    const lat = clat + (dy * out) / latS;
    try {
      const c = scene.clampToHeight(Cesium.Cartesian3.fromDegrees(lon, lat, 0));
      if (c) {
        const h = Cesium.Cartographic.fromCartesian(c).height;
        if (Number.isFinite(h) && h > -430 && h < 9000) samples.push(h);
      }
    } catch { /* tile not ready */ }
  }
  if (!samples.length) return null;
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length * 0.3)];
}

/**
 * Inflate a [[lon,lat],...] ring outward from its centroid by `meters`, so an
 * extruded building volume encloses the photogrammetry mesh instead of slicing
 * through its edges. Radial buffer — fine for compact building footprints.
 */
function bufferRing(ring, meters) {
  let clon = 0;
  let clat = 0;
  for (const [lon, lat] of ring) { clon += lon; clat += lat; }
  clon /= ring.length;
  clat /= ring.length;
  const latScale = 111320;
  const lonScale = latScale * Math.cos(Cesium.Math.toRadians(clat));
  return ring.map(([lon, lat]) => {
    const dx = (lon - clon) * lonScale;
    const dy = (lat - clat) * latScale;
    const d = Math.hypot(dx, dy) || 1;
    const k = (d + meters) / d;
    return [clon + (dx * k) / lonScale, clat + (dy * k) / latScale];
  });
}
