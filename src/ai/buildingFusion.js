const MAX_POLYGONS = 500;
const copy = (item) => ({ ...item, points: item.points.map((p) => [...p]) });

function geometry(item) {
  const p = item.points;
  const xs = p.map(([x]) => x); const ys = p.map(([, y]) => y);
  const x0 = Math.min(...xs); const x1 = Math.max(...xs);
  const y0 = Math.min(...ys); const y1 = Math.max(...ys);
  const area = Math.abs(p.reduce((s, a, i) => {
    const b = p[(i + 1) % p.length];
    return s + a[0] * b[1] - a[1] * b[0];
  }, 0)) / 2;
  return { item, x0, x1, y0, y1, area, width: x1 - x0, height: y1 - y0 };
}

function intervals(points, y) {
  const cuts = points.flatMap((a, i) => {
    const b = points[(i + 1) % points.length];
    return (a[1] > y) !== (b[1] > y) ? [a[0] + (y - a[1]) * (b[0] - a[0]) / (b[1] - a[1])] : [];
  }).sort((a, b) => a - b);
  return cuts.filter((_, i) => i % 2 === 0).map((x, i) => [x, cuts[i * 2 + 1]]);
}

// Bounded scanline integration measures the filled polygons, including concave
// cut-outs. Bbox-only overlap would erase a separate roof inside a C-shaped one.
function overlap(a, b) {
  const lo = Math.max(a.y0, b.y0); const hi = Math.min(a.y1, b.y1);
  if (hi <= lo || Math.min(a.x1, b.x1) <= Math.max(a.x0, b.x0)) return { iou: 0, containment: 0 };
  const steps = 64;
  const ys = [...new Set([lo, hi, ...a.item.points.map((p) => p[1]), ...b.item.points.map((p) => p[1]),
    ...Array.from({ length: steps - 1 }, (_, i) => lo + (hi - lo) * (i + 1) / steps)])]
    .filter((y) => y >= lo && y <= hi).sort((x, y) => x - y);
  const integral = ys.slice(1).reduce((sum, y, i) => {
    const middle = (ys[i] + y) / 2;
    const left = intervals(a.item.points, middle); const right = intervals(b.item.points, middle);
    const width = left.reduce((total, p) => total + right.reduce((s, q) =>
      s + Math.max(0, Math.min(p[1], q[1]) - Math.max(p[0], q[0])), 0), 0);
    return sum + width * (y - ys[i]);
  }, 0);
  const intersection = Math.max(0, Math.min(a.area, b.area, integral));
  return { iou: intersection / Math.max(1e-9, a.area + b.area - intersection),
    containment: intersection / Math.max(1e-9, Math.min(a.area, b.area)) };
}

function matchScore(candidate, proposal) {
  const ratio = proposal.area / Math.max(1e-9, candidate.area);
  const distance = Math.hypot((proposal.x0 + proposal.x1 - candidate.x0 - candidate.x1) / (2 * Math.max(1, candidate.width)),
    (proposal.y0 + proposal.y1 - candidate.y0 - candidate.y1) / (2 * Math.max(1, candidate.height)));
  if (ratio < 0.65 || ratio > 1.6 || distance > 0.3) return null;
  const intersection = overlap(candidate, proposal);
  if (intersection.iou < 0.55 || intersection.containment < 0.8) return null;
  // A simplified polygon may have far fewer vertices and still describe the
  // same roof. Check the actual filled area, not the number of mask pixels.
  const filled = (g) => g.area / Math.max(1, g.width * g.height);
  if (filled(candidate) < 0.75 && filled(proposal) > 0.9) return null;
  if (candidate.item.points.length >= 8 && proposal.item.points.length / candidate.item.points.length < 0.35) return null;
  return intersection.iou - distance * 0.1;
}

function isDuplicate(a, b) {
  const values = overlap(a, b);
  return values.iou >= 0.18 || values.containment >= 0.45;
}

/** Fuse validated same-frame results; confidence is an uncalibrated model score. */
export function fuseBuildingPolygons(segmentation, refinement, { minSupplementConfidence = 0.72 } = {}) {
  if (!segmentation?.ok || !Array.isArray(segmentation.polygons)) return segmentation;
  const base = segmentation.polygons.map(copy);
  const unchanged = { ...segmentation, polygons: base, refinedCount: 0, supplementedCount: 0,
    rejectedRefinements: refinement?.polygons?.length || 0, refinementModel: null };
  if (!refinement?.ok || !Array.isArray(refinement.polygons)
    || refinement.image?.width !== segmentation.image?.width || refinement.image?.height !== segmentation.image?.height) return unchanged;

  const originals = base.map(geometry); const proposals = refinement.polygons.map(geometry);
  const pairs = originals.flatMap((candidate, ci) => proposals.flatMap((proposal, pi) => {
    const score = matchScore(candidate, proposal);
    return score === null ? [] : [{ ci, pi, score }];
  })).sort((a, b) => b.score - a.score);
  const matches = pairs.reduce((state, pair) => state.some((p) => p.ci === pair.ci || p.pi === pair.pi) ? state : [...state, pair], []);
  const fused = base.map((candidate, ci) => {
    const match = matches.find((p) => p.ci === ci);
    return match ? copy(proposals[match.pi].item) : candidate;
  });
  const existing = [...originals, ...fused.map(geometry)];
  const additions = proposals.map((p, pi) => ({ ...p, pi }))
    .filter((p) => !matches.some((m) => m.pi === p.pi))
    .sort((a, b) => (b.item.confidence ?? 0) - (a.item.confidence ?? 0))
    .reduce((accepted, proposal) => {
      if (!Number.isFinite(proposal.item.confidence) || proposal.item.confidence < minSupplementConfidence
        || proposal.area < 16 || proposal.width < 3 || proposal.height < 3
        || [...existing, ...accepted].some((prior) => isDuplicate(prior, proposal))) return accepted;
      return [...accepted, proposal];
    }, []);
  const supplements = additions.slice(0, Math.max(0, MAX_POLYGONS - fused.length));
  const modelUsed = matches.length + supplements.length > 0;
  return { ...segmentation, task: 'buildings', model: modelUsed ? refinement.model : segmentation.model,
    polygons: [...fused, ...supplements.map((p) => copy(p.item))], refinedCount: matches.length,
    supplementedCount: supplements.length, rejectedRefinements: proposals.length - matches.length - supplements.length,
    refinementModel: modelUsed ? refinement.model : null,
    truncated: Boolean(segmentation.truncated || refinement.truncated || additions.length > supplements.length) };
}
