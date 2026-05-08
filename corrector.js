/**
 * corrector.js — Perspective correction math + warp orchestration.
 * Ports the homography logic from the Python version.
 */
const EPS = 1e-10;

/** Convert a guide (two points) to a homogeneous line [a,b,c]. */
function lineFromGuide(guide) {
  const [p1, p2] = guide;
  const hp1 = new Float64Array([p1[0], p1[1], 1]);
  const hp2 = new Float64Array([p2[0], p2[1], 1]);
  const line = vec3Cross(hp1, hp2);
  const n = Math.hypot(line[0], line[1]);
  if (n <= 1e-12) throw new Error('Guide has zero length.');
  line[0] /= n; line[1] /= n; line[2] /= n;
  return line;
}

/** Build projective homography whose third row is the line at infinity. */
function homographyWithThirdRow(line) {
  const [a, b, c] = line;
  let row1, row2;
  if (Math.abs(c) > EPS) { row1 = [1,0,0]; row2 = [0,1,0]; }
  else if (Math.abs(b) > EPS) { row1 = [1,0,0]; row2 = [0,0,1]; }
  else if (Math.abs(a) > EPS) { row1 = [0,1,0]; row2 = [0,0,1]; }
  else throw new Error('Invalid line at infinity.');
  const H = mat3(row1[0],row1[1],row1[2], row2[0],row2[1],row2[2], a,b,c);
  if (Math.abs(mat3Det(H)) <= EPS) throw new Error('Projective matrix is singular.');
  return H;
}

function normalize2d(x, y) {
  const n = Math.hypot(x, y);
  return n <= 1e-12 ? [x, y] : [x/n, y/n];
}

/**
 * Compute the rectification homography from 4 guides.
 * Identical algorithm to the Python version.
 */
function computeRectificationHomography(guides) {
  const lv1 = lineFromGuide(guides.v1);
  const lv2 = lineFromGuide(guides.v2);
  const lh1 = lineFromGuide(guides.h1);
  const lh2 = lineFromGuide(guides.h2);

  const vv = vec3Cross(lv1, lv2);
  const vh = vec3Cross(lh1, lh2);
  if (vec3Norm(vv) < EPS || vec3Norm(vh) < EPS)
    throw new Error('Guide pairs are degenerate.');

  let lineInf = vec3Cross(vv, vh);
  if (vec3Norm(lineInf) < EPS) throw new Error('Cannot estimate line at infinity.');
  const n = vec3Norm(lineInf);
  lineInf[0] /= n; lineInf[1] /= n; lineInf[2] /= n;

  const projective = homographyWithThirdRow(lineInf);

  function transformedDirection(key) {
    const [p1, p2] = guides[key];
    const q1 = mat3TransformPoint(projective, p1[0], p1[1]);
    const q2 = mat3TransformPoint(projective, p2[0], p2[1]);
    if (!q1 || !q2) throw new Error(`Guide ${key} collapsed.`);
    const dx = q2[0]-q1[0], dy = q2[1]-q1[1];
    const len = Math.hypot(dx, dy);
    if (len < EPS) throw new Error(`Guide ${key} collapsed after projective stage.`);
    return { dir: [dx/len, dy/len], len };
  }

  const dv1 = transformedDirection('v1'), dv2 = transformedDirection('v2');
  const dh1 = transformedDirection('h1'), dh2 = transformedDirection('h2');

  let dVert = normalize2d(dv1.dir[0]+dv2.dir[0], dv1.dir[1]+dv2.dir[1]);
  let dHoriz = normalize2d(dh1.dir[0]+dh2.dir[0], dh1.dir[1]+dh2.dir[1]);

  // Build affine correction: basis = [dHoriz | dVert], then invert and scale
  const det2 = dHoriz[0]*dVert[1] - dHoriz[1]*dVert[0];
  if (Math.abs(det2) < EPS) throw new Error('Guides became nearly parallel.');

  const scaleH = Math.max(1, (dh1.len + dh2.len) * 0.5);
  const scaleV = Math.max(1, (dv1.len + dv2.len) * 0.5);

  // inv(basis) where basis columns are dHoriz, dVert
  const invDet = 1.0 / det2;
  const invBasis = [
    dVert[1]*invDet, -dVert[0]*invDet,
    -dHoriz[1]*invDet, dHoriz[0]*invDet
  ];

  const aff00 = scaleH * invBasis[0], aff01 = scaleH * invBasis[1];
  const aff10 = scaleV * invBasis[2], aff11 = scaleV * invBasis[3];

  const affine = mat3(aff00,aff01,0, aff10,aff11,0, 0,0,1);
  return mat3Multiply(affine, projective);
}

/**
 * Compute the full output transform matrix and output dimensions.
 * @param {object} guides - { v1, v2, h1, h2 } each [[x1,y1],[x2,y2]]
 * @param {number} imgW - source image width
 * @param {number} imgH - source image height
 * @param {number} aspectH - user horizontal distance (0 = disabled)
 * @param {number} aspectV - user vertical distance (0 = disabled)
 * @returns {{ transform: Float64Array, outW: number, outH: number }}
 */
function computeOutputTransform(guides, imgW, imgH, aspectH, aspectV) {
  if (imgW < 2 || imgH < 2) throw new Error('Image too small.');

  const homography = computeRectificationHomography(guides);

  // Warp the four source corners
  const corners = [[0,0],[imgW-1,0],[imgW-1,imgH-1],[0,imgH-1]];
  const warped = corners.map(([x,y]) => {
    const p = mat3TransformPoint(homography, x, y);
    if (!p) throw new Error('Corner warped to infinity.');
    return p;
  });

  const xs = warped.map(p => p[0]), ys = warped.map(p => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const bboxW = maxX - minX, bboxH = maxY - minY;
  if (bboxW < 2 || bboxH < 2) throw new Error('Invalid output size. Adjust guides.');

  const translate = mat3Translate(-minX, -minY);

  let outW, outH;

  if (aspectH > 0 && aspectV > 0) {
    // Measure guide distances in corrected space
    const midV1 = mat3TransformPoint(homography,
      (guides.v1[0][0]+guides.v1[1][0])/2, (guides.v1[0][1]+guides.v1[1][1])/2);
    const midV2 = mat3TransformPoint(homography,
      (guides.v2[0][0]+guides.v2[1][0])/2, (guides.v2[0][1]+guides.v2[1][1])/2);
    const midH1 = mat3TransformPoint(homography,
      (guides.h1[0][0]+guides.h1[1][0])/2, (guides.h1[0][1]+guides.h1[1][1])/2);
    const midH2 = mat3TransformPoint(homography,
      (guides.h2[0][0]+guides.h2[1][0])/2, (guides.h2[0][1]+guides.h2[1][1])/2);

    const corrH = Math.abs(midV2[0] - midV1[0]); // horizontal px distance between V guides
    const corrV = Math.abs(midH2[1] - midH1[1]); // vertical px distance between H guides

    if (corrH > EPS && corrV > EPS) {
      const desiredRatio = aspectH / aspectV;
      const currentRatio = corrH / corrV;
      const ratioAdj = desiredRatio / currentRatio;

      // Keep original pixel count, adjust proportions
      const area = imgW * imgH;
      const stretchY = Math.sqrt(area / (ratioAdj * bboxW * bboxH));
      const stretchX = ratioAdj * stretchY;
      outW = Math.round(bboxW * stretchX);
      outH = Math.round(bboxH * stretchY);
    } else {
      outW = imgW; outH = imgH;
    }
  } else {
    outW = imgW; outH = imgH;
  }

  const stretchX = (outW - 1) / bboxW;
  const stretchY = (outH - 1) / bboxH;
  const stretch = mat3Scale(stretchX, stretchY);

  const total = mat3Multiply(stretch, mat3Multiply(translate, homography));
  return { transform: total, outW, outH };
}

/**
 * Measure guide angles (deviation from true vertical/horizontal).
 */
function measureGuideAngles(guides) {
  const angles = {};
  for (const key of ['v1','v2','h1','h2']) {
    if (!guides[key]) { angles[key] = null; continue; }
    const [p1, p2] = guides[key];
    const dx = p2[0]-p1[0], dy = p2[1]-p1[1];
    if (key.startsWith('v')) {
      angles[key] = Math.atan2(Math.abs(dx), Math.abs(dy)) * 180 / Math.PI;
    } else {
      angles[key] = Math.atan2(Math.abs(dy), Math.abs(dx)) * 180 / Math.PI;
    }
  }
  return angles;
}

/**
 * Compute crop bounds in the output image space.
 * Transforms guide midpoints through the full transform, then:
 *   left  = avg X of V1 endpoints
 *   right = avg X of V2 endpoints
 *   top   = avg Y of H1 endpoints
 *   bottom= avg Y of H2 endpoints
 * Returns { x, y, w, h } in output pixel coordinates.
 */
function computeCropBounds(guides, transform, outW, outH) {
  function avgTransformed(key, coord) {
    const [p1, p2] = guides[key];
    const t1 = mat3TransformPoint(transform, p1[0], p1[1]);
    const t2 = mat3TransformPoint(transform, p2[0], p2[1]);
    if (!t1 || !t2) return coord === 'x' ? outW / 2 : outH / 2;
    return (t1[coord === 'x' ? 0 : 1] + t2[coord === 'x' ? 0 : 1]) / 2;
  }

  let left  = Math.round(avgTransformed('v1', 'x'));
  let right = Math.round(avgTransformed('v2', 'x'));
  let top   = Math.round(avgTransformed('h1', 'y'));
  let bottom= Math.round(avgTransformed('h2', 'y'));

  // Ensure left < right and top < bottom
  if (left > right) { const t = left; left = right; right = t; }
  if (top > bottom) { const t = top; top = bottom; bottom = t; }

  // Clamp to output bounds
  left   = Math.max(0, left);
  top    = Math.max(0, top);
  right  = Math.min(outW, right);
  bottom = Math.min(outH, bottom);

  return { x: left, y: top, w: right - left, h: bottom - top };
}
