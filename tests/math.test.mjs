// Cross-checks public/math3d.js against three.js for random inputs.
import assert from "node:assert/strict";
import * as M from "../public/math3d.js";
import { Quaternion, Euler, Vector3, Matrix4, Object3D, MathUtils } from "three";

const close = (a, b, tol = 1e-9, what = "") => a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < tol, `${what} [${i}] ${v} vs ${b[i]}`));
const r = (lo, hi) => lo + Math.random() * (hi - lo);
let n = 0;
for (let i = 0; i < 500; i++) {
  const [x, y, z] = [r(-3, 3), r(-3, 3), r(-3, 3)];
  const q3 = new Quaternion().setFromEuler(new Euler(x, y, z, "YXZ"));
  close(M.quatFromEulerYXZ(x, y, z), q3.toArray(), 1e-9, "euler"); n++;

  // device orientation -> quaternion (three's DeviceOrientationControls formula)
  const [al, be, ga, sa] = [r(0, 360), r(-180, 180), r(-90, 90), [0, 90, 180, 270][i % 4]];
  const e = new Euler(MathUtils.degToRad(be), MathUtils.degToRad(al), -MathUtils.degToRad(ga), "YXZ");
  const qd = new Quaternion().setFromEuler(e).multiply(new Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5)))
    .multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), -MathUtils.degToRad(sa)));
  close(M.deviceQuat(al, be, ga, sa), qd.toArray(), 1e-9, "device"); n++;

  const v = [r(-5, 5), r(-5, 5), r(-5, 5)];
  close(M.rotate(v, qd.toArray()), new Vector3(...v).applyQuaternion(qd).toArray(), 1e-9, "rotate"); n++;

  close(M.matFromQuat(qd.toArray()), new Matrix4().makeRotationFromQuaternion(qd).elements, 1e-9, "matFromQuat"); n++;
  close(M.viewMatrix(qd.toArray()), new Matrix4().makeRotationFromQuaternion(qd).invert().elements, 1e-9, "view"); n++;

  const pos = [r(-2000, 2000), r(-2000, 2000), r(-2000, 2000)];
  const o = new Object3D(); o.position.set(...pos); o.lookAt(0, 0, 0); o.updateMatrixWorld();
  close(M.matFacing(pos), o.matrixWorld.elements, 1e-9, "facing"); n++;

  const vm = new Matrix4().makeRotationFromQuaternion(qd).invert();
  close(M.applyMat(vm.elements, pos), new Vector3(...pos).applyMatrix4(vm).toArray(), 1e-6, "applyMat"); n++;
}
// nlerp converges to target and keeps unit length
let a = M.quat(); const b = M.deviceQuat(40, 80, 10, 0);
for (let i = 0; i < 40; i++) a = M.quatNlerp(a, b, 0.5);
close(a.map(Math.abs), b.map(Math.abs), 1e-6, "nlerp"); n++;
console.log(`${n} math checks passed (matches three.js)`);
