/**
 * matrix.js — Lightweight 3×3 matrix math for homography computations.
 * Matrices are stored as flat Float64Array(9) in row-major order:
 *   [m00, m01, m02, m10, m11, m12, m20, m21, m22]
 */

function mat3Identity() {
  return new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
}

function mat3(
  m00, m01, m02,
  m10, m11, m12,
  m20, m21, m22
) {
  return new Float64Array([m00, m01, m02, m10, m11, m12, m20, m21, m22]);
}

function mat3Multiply(A, B) {
  const R = new Float64Array(9);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      R[i * 3 + j] =
        A[i * 3 + 0] * B[0 * 3 + j] +
        A[i * 3 + 1] * B[1 * 3 + j] +
        A[i * 3 + 2] * B[2 * 3 + j];
    }
  }
  return R;
}

function mat3Det(M) {
  return (
    M[0] * (M[4] * M[8] - M[5] * M[7]) -
    M[1] * (M[3] * M[8] - M[5] * M[6]) +
    M[2] * (M[3] * M[7] - M[4] * M[6])
  );
}

function mat3Inverse(M) {
  const det = mat3Det(M);
  if (Math.abs(det) < 1e-12) return null;

  const id = 1.0 / det;
  return new Float64Array([
    (M[4] * M[8] - M[5] * M[7]) * id,
    (M[2] * M[7] - M[1] * M[8]) * id,
    (M[1] * M[5] - M[2] * M[4]) * id,
    (M[5] * M[6] - M[3] * M[8]) * id,
    (M[0] * M[8] - M[2] * M[6]) * id,
    (M[2] * M[3] - M[0] * M[5]) * id,
    (M[3] * M[7] - M[4] * M[6]) * id,
    (M[1] * M[6] - M[0] * M[7]) * id,
    (M[0] * M[4] - M[1] * M[3]) * id,
  ]);
}

function vec3Cross(a, b) {
  return new Float64Array([
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ]);
}

function vec3Norm(v) {
  return Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
}

function vec2Norm(x, y) {
  return Math.sqrt(x * x + y * y);
}

function mat3TransformPoint(M, x, y) {
  const w = M[6] * x + M[7] * y + M[8];
  if (Math.abs(w) < 1e-12) return null;
  return [
    (M[0] * x + M[1] * y + M[2]) / w,
    (M[3] * x + M[4] * y + M[5]) / w,
  ];
}

function mat3Translate(tx, ty) {
  return new Float64Array([1, 0, tx, 0, 1, ty, 0, 0, 1]);
}

function mat3Scale(sx, sy) {
  return new Float64Array([sx, 0, 0, 0, sy, 0, 0, 0, 1]);
}
