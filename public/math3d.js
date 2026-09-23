// Minimal 3D math for Airpane (quaternions + 4x4 matrices, column-major like three.js).
// Verified against three.js in tests/math.test.js.

export const deg = (d) => (d * Math.PI) / 180;
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// ---- quaternions [x, y, z, w] ----
export const quat = () => [0, 0, 0, 1];

// Euler order YXZ (x = pitch, y = yaw, z = roll)
export function quatFromEulerYXZ(x, y, z) {
  const c1 = Math.cos(x / 2), c2 = Math.cos(y / 2), c3 = Math.cos(z / 2);
  const s1 = Math.sin(x / 2), s2 = Math.sin(y / 2), s3 = Math.sin(z / 2);
  return [
    s1 * c2 * c3 + c1 * s2 * s3,
    c1 * s2 * c3 - s1 * c2 * s3,
    c1 * c2 * s3 - s1 * s2 * c3,
    c1 * c2 * c3 + s1 * s2 * s3,
  ];
}

export function quatMul(a, b) {
  const [ax, ay, az, aw] = a, [bx, by, bz, bw] = b;
  return [
    ax * bw + aw * bx + ay * bz - az * by,
    ay * bw + aw * by + az * bx - ax * bz,
    az * bw + aw * bz + ax * by - ay * bx,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

export function quatAxisAngle(ax, ay, az, angle) {
  const s = Math.sin(angle / 2);
  return [ax * s, ay * s, az * s, Math.cos(angle / 2)];
}

// Smooth step toward b (normalised lerp, shortest path). Fine for per-frame smoothing.
export function quatNlerp(a, b, t) {
  const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  const s = dot < 0 ? -1 : 1;
  const q = a.map((v, i) => v + (s * b[i] - v) * t);
  const n = Math.hypot(...q) || 1;
  return q.map((v) => v / n);
}

// Rotate vector v by quaternion q
export function rotate(v, q) {
  const [x, y, z] = v, [qx, qy, qz, qw] = q;
  const tx = 2 * (qy * z - qz * y), ty = 2 * (qz * x - qx * z), tz = 2 * (qx * y - qy * x);
  return [
    x + qw * tx + qy * tz - qz * ty,
    y + qw * ty + qz * tx - qx * tz,
    z + qw * tz + qx * ty - qy * tx,
  ];
}

// Device orientation (degrees) -> camera quaternion, same maths as three.js DeviceOrientationControls
const Q1 = [-Math.SQRT1_2, 0, 0, Math.SQRT1_2]; // -90 deg around X: camera looks out the back of the device
export function deviceQuat(alpha, beta, gamma, screenAngle) {
  let q = quatFromEulerYXZ(deg(beta), deg(alpha), -deg(gamma));
  q = quatMul(q, Q1);
  return quatMul(q, quatAxisAngle(0, 0, 1, -deg(screenAngle)));
}

// ---- vectors ----
export const len = (v) => Math.hypot(v[0], v[1], v[2]);
export const scale = (v, s) => [v[0] * s, v[1] * s, v[2] * s];
export const norm = (v) => scale(v, 1 / (len(v) || 1));
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

// ---- matrices (column-major, 16 numbers) ----
export function matFromQuat(q, pos = [0, 0, 0]) {
  const [x, y, z, w] = q;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  return [
    1 - (yy + zz), xy + wz, xz - wy, 0,
    xy - wz, 1 - (xx + zz), yz + wx, 0,
    xz + wy, yz - wx, 1 - (xx + yy), 0,
    pos[0], pos[1], pos[2], 1,
  ];
}

// World matrix of an object at `pos` whose +Z faces `target` (upright, world up = +Y)
export function matFacing(pos, target = [0, 0, 0]) {
  let z = norm([target[0] - pos[0], target[1] - pos[1], target[2] - pos[2]]);
  let x = cross([0, 1, 0], z);
  if (len(x) < 1e-6) x = cross([0, 0, 1], z); // looking straight up/down
  x = norm(x);
  const y = cross(z, x);
  return [x[0], x[1], x[2], 0, y[0], y[1], y[2], 0, z[0], z[1], z[2], 0, pos[0], pos[1], pos[2], 1];
}

export function applyMat(m, v) {
  const [x, y, z] = v;
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ];
}

// Camera sits at the origin, so its view matrix is just the inverse rotation.
export const viewMatrix = (camQuat) => matFromQuat([-camQuat[0], -camQuat[1], -camQuat[2], camQuat[3]]);

// ---- CSS conversions (flip Y, as three.js CSS3DRenderer does) ----
const e = (v) => (Math.abs(v) < 1e-10 ? 0 : +v.toFixed(8));
export function cameraCSS(m) {
  return `matrix3d(${[m[0], -m[1], m[2], m[3], m[4], -m[5], m[6], m[7], m[8], -m[9], m[10], m[11], m[12], -m[13], m[14], m[15]].map(e).join(",")})`;
}
export function objectCSS(m) {
  return `matrix3d(${[m[0], m[1], m[2], m[3], -m[4], -m[5], -m[6], -m[7], m[8], m[9], m[10], m[11], m[12], m[13], m[14], m[15]].map(e).join(",")})`;
}
