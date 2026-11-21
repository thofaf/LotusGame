// Banans mittlinje (AC fast_lane.ai) och kollisionsgeometri (väg, terräng, räcken).
import * as THREE from './lib/three.module.js';

// ---------------------------------------------------------------------------
export function parseAI(buffer) {
  const dv = new DataView(buffer);
  let p = 0;
  const i32 = () => { const v = dv.getInt32(p, true); p += 4; return v; };
  const f32 = () => { const v = dv.getFloat32(p, true); p += 4; return v; };
  i32(); const n = i32(); i32(); i32();
  const pts = new Float32Array(n * 3), dist = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    pts[i * 3] = -f32(); pts[i * 3 + 1] = f32(); pts[i * 3 + 2] = f32();
    dist[i] = f32(); i32();
  }
  const left = new Float32Array(n), right = new Float32Array(n);
  try {
    const ec = i32();
    for (let i = 0; i < ec && i < n; i++) {
      const f = []; for (let k = 0; k < 18; k++) f.push(f32());
      // speglat: AC:s vänster blir vår höger
      left[i] = f[6]; right[i] = f[5];
    }
  } catch { /* extra data saknas */ }
  return new Spline(pts, dist, left, right);
}

export class Spline {
  constructor(pts, dist, left, right) {
    this.pts = pts; this.dist = dist; this.left = left; this.right = right;
    this.n = dist.length; this.length = dist[this.n - 1];
    // rutnät för snabb närmaste-punkt-sökning
    this.cell = 50; this.grid = new Map();
    for (let i = 0; i < this.n; i++) {
      const k = this.key(pts[i * 3], pts[i * 3 + 2]);
      let a = this.grid.get(k); if (!a) this.grid.set(k, a = []); a.push(i);
    }
  }
  key(x, z) { return Math.floor(x / this.cell) * 100003 + Math.floor(z / this.cell); }
  // Rundbana: ny spline som börjar vid index `begin` och fortsätter `total` punkter runt slingan (modulo n).
  // Punkt i och i + n i resultatet ligger på samma ställe, så ett helt varv blir en sträcka från A till B.
  unrolled(begin, total) {
    const n = this.n, pts = new Float32Array(total * 3), dist = new Float32Array(total);
    const left = new Float32Array(total), right = new Float32Array(total);
    for (let k = 0; k < total; k++) {
      const j = (((begin + k) % n) + n) % n;
      pts[k * 3] = this.pts[j * 3]; pts[k * 3 + 1] = this.pts[j * 3 + 1]; pts[k * 3 + 2] = this.pts[j * 3 + 2];
      left[k] = this.left[j]; right[k] = this.right[j];
      if (k > 0) dist[k] = dist[k - 1] + Math.hypot(pts[k * 3] - pts[k * 3 - 3], pts[k * 3 + 1] - pts[k * 3 - 2], pts[k * 3 + 2] - pts[k * 3 - 1]);
    }
    const s = new Spline(pts, dist, left, right);
    s.lapPoints = n;
    return s;
  }
  point(i, out = new THREE.Vector3()) { i = Math.max(0, Math.min(this.n - 1, i)); return out.set(this.pts[i * 3], this.pts[i * 3 + 1], this.pts[i * 3 + 2]); }
  tangent(i, out = new THREE.Vector3()) {
    const a = Math.max(0, i - 3), b = Math.min(this.n - 1, i + 3);
    return out.set(this.pts[b * 3] - this.pts[a * 3], this.pts[b * 3 + 1] - this.pts[a * 3 + 1], this.pts[b * 3 + 2] - this.pts[a * 3 + 2]).normalize();
  }
  // Närmaste index. hint = föregående index för lokal sökning.
  nearest(x, z, hint = -1, y = null) {
    let best = -1, bd = Infinity;
    const test = (i) => {
      const dx = this.pts[i * 3] - x, dz = this.pts[i * 3 + 2] - z;
      let d = dx * dx + dz * dz;
      if (y !== null) { const dy = this.pts[i * 3 + 1] - y; d += dy * dy * 4; }
      if (d < bd) { bd = d; best = i; }
    };
    if (hint >= 0) {
      for (let i = Math.max(0, hint - 60); i < Math.min(this.n, hint + 60); i++) test(i);
      if (bd < 400) return best;
    }
    const cx = Math.floor(x / this.cell), cz = Math.floor(z / this.cell);
    for (let r = 0; r < 6 && (best < 0 || r < 2); r++) {
      for (let gx = cx - r; gx <= cx + r; gx++) for (let gz = cz - r; gz <= cz + r; gz++) {
        if (Math.max(Math.abs(gx - cx), Math.abs(gz - cz)) !== r) continue;
        const a = this.grid.get(gx * 100003 + gz); if (a) for (const i of a) test(i);
      }
    }
    if (best < 0) for (let i = 0; i < this.n; i++) test(i);
    return best;
  }
}

// ---------------------------------------------------------------------------
// Kollisionsvärld: triangelrutnät i XZ-planet.
export const SURF_ROAD = 0, SURF_GRASS = 1, SURF_WALL = 2;

export class CollisionWorld {
  constructor() {
    this.cell = 6;
    this.tris = [];      // platt lista: 9 floats per triangel
    this.surf = [];
    this.ground = new Map();
    this.walls = new Map();
  }
  key(cx, cz) { return cx * 73856093 ^ cz * 19349663; }

  // opts.minNy: brantaste lutning som räknas som mark. opts.steepWallNy: brantare än så blir vägg.
  addMesh(mesh, surface, opts = {}) {
    const minNy = opts.minNy ?? 0.25, steepWallNy = opts.steepWallNy ?? -1;
    const g = mesh.geometry, pos = g.attributes.position.array, idx = g.index.array;
    const m = mesh.matrixWorld;
    const v = new THREE.Vector3();
    const wp = new Float32Array(pos.length);
    for (let i = 0; i < pos.length; i += 3) {
      v.set(pos[i], pos[i + 1], pos[i + 2]).applyMatrix4(m);
      wp[i] = v.x; wp[i + 1] = v.y; wp[i + 2] = v.z;
    }
    const T = this.tris, cell = this.cell;
    for (let k = 0; k < idx.length; k += 3) {
      const a = idx[k] * 3, b = idx[k + 1] * 3, c = idx[k + 2] * 3;
      const ax = wp[a], ay = wp[a + 1], az = wp[a + 2], bx = wp[b], by = wp[b + 1], bz = wp[b + 2], cx = wp[c], cy = wp[c + 1], cz = wp[c + 2];
      // normal
      const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az;
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const nl = Math.hypot(nx, ny, nz); if (nl < 1e-9) continue;
      nx /= nl; ny /= nl; nz /= nl;
      let surf = surface;
      if (surface !== SURF_WALL && Math.abs(ny) < minNy) {
        if (Math.abs(ny) < steepWallNy) surf = SURF_WALL; // stenmur/klippa: vägg
        else continue; // för brant för mark
      }
      const target = surf === SURF_WALL ? this.walls : this.ground;
      const minx = Math.min(ax, bx, cx), maxx = Math.max(ax, bx, cx), minz = Math.min(az, bz, cz), maxz = Math.max(az, bz, cz);
      const x0 = Math.floor(minx / cell), x1 = Math.floor(maxx / cell), z0 = Math.floor(minz / cell), z1 = Math.floor(maxz / cell);
      if ((x1 - x0 + 1) * (z1 - z0 + 1) > 4000) continue; // gigantiska bakgrundstrianglar
      const id = this.surf.length;
      T.push(ax, ay, az, bx, by, bz, cx, cy, cz);
      this.surf.push(surf);
      for (let gx = x0; gx <= x1; gx++) for (let gz = z0; gz <= z1; gz++) {
        const kk = this.key(gx, gz);
        let arr = target.get(kk); if (!arr) target.set(kk, arr = []); arr.push(id);
      }
    }
  }
  finalize() { this.T = new Float32Array(this.tris); this.tris = null; }

  // Högsta markyta under (x,z) som ligger lägre än yMax. Returnerar {y, nx,ny,nz, surf} eller null.
  groundAt(x, z, yMax, out) {
    const arr = this.ground.get(this.key(Math.floor(x / this.cell), Math.floor(z / this.cell)));
    if (!arr) return null;
    const T = this.T;
    let bestY = -Infinity, bi = -1, roadY = -Infinity, ri = -1;
    for (let k = 0; k < arr.length; k++) {
      const i = arr[k], o = i * 9;
      const ax = T[o], az = T[o + 2], bx = T[o + 3], bz = T[o + 5], cx = T[o + 6], cz = T[o + 8];
      const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
      if (Math.abs(d) < 1e-9) continue;
      const l1 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d;
      if (l1 < -1e-4) continue;
      const l2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d;
      if (l2 < -1e-4) continue;
      const l3 = 1 - l1 - l2;
      if (l3 < -1e-4) continue;
      const y = l1 * T[o + 1] + l2 * T[o + 4] + l3 * T[o + 7];
      if (y > yMax) continue;
      if (this.surf[i] === SURF_ROAD) { if (y > roadY) { roadY = y; ri = i; } }
      else if (y > bestY) { bestY = y; bi = i; }
    }
    // Vägen (fysikmeshen) har företräde framför visuell terräng som ligger strax ovanför/under den.
    if (ri >= 0 && (bi < 0 || bestY < roadY + 0.35)) { bi = ri; bestY = roadY; }
    if (bi < 0) return null;
    const o = bi * 9;
    const ux = T[o + 3] - T[o], uy = T[o + 4] - T[o + 1], uz = T[o + 5] - T[o + 2];
    const vx = T[o + 6] - T[o], vy = T[o + 7] - T[o + 1], vz = T[o + 8] - T[o + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) * (ny < 0 ? -1 : 1);
    out.y = bestY; out.nx = nx / l; out.ny = ny / l; out.nz = nz / l; out.surf = this.surf[bi];
    return out;
  }

  // Sfär mot räcken/väggar. Returnerar penetrationsvektor (skjut ut) eller null.
  wallPush(x, y, z, r, out) {
    const T = this.T;
    let found = false; out.set(0, 0, 0);
    const cx0 = Math.floor((x - r) / this.cell), cx1 = Math.floor((x + r) / this.cell);
    const cz0 = Math.floor((z - r) / this.cell), cz1 = Math.floor((z + r) / this.cell);
    const seen = this._seen || (this._seen = new Set()); seen.clear();
    for (let gx = cx0; gx <= cx1; gx++) for (let gz = cz0; gz <= cz1; gz++) {
      const arr = this.walls.get(this.key(gx, gz)); if (!arr) continue;
      for (const i of arr) {
        if (seen.has(i)) continue; seen.add(i);
        const q = closestPointTri(x, y, z, T, i * 9, _cp);
        const dx = x - q.x, dy = y - q.y, dz = z - q.z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < r * r) {
          const d = Math.sqrt(d2) || 1e-4;
          // ignorera nästan horisontella kontaktnormaler (marken hanteras av fjädringen)
          const ny = dy / d; if (Math.abs(ny) > 0.7) continue;
          const pen = r - d;
          out.x += dx / d * pen; out.z += dz / d * pen;
          found = true;
        }
      }
    }
    return found ? out : null;
  }
}

const _cp = new THREE.Vector3();
function closestPointTri(px, py, pz, T, o, out) {
  const ax = T[o], ay = T[o + 1], az = T[o + 2], bx = T[o + 3], by = T[o + 4], bz = T[o + 5], cx = T[o + 6], cy = T[o + 7], cz = T[o + 8];
  const abx = bx - ax, aby = by - ay, abz = bz - az, acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) return out.set(ax, ay, az);
  const bpx = px - bx, bpy = py - by, bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return out.set(bx, by, bz);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); return out.set(ax + v * abx, ay + v * aby, az + v * abz); }
  const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return out.set(cx, cy, cz);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); return out.set(ax + w * acx, ay + w * acy, az + w * acz); }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) { const w = (d4 - d3) / ((d4 - d3) + (d5 - d6)); return out.set(bx + w * (cx - bx), by + w * (cy - by), bz + w * (cz - bz)); }
  const denom = 1 / (va + vb + vc), v = vb * denom, w = vc * denom;
  return out.set(ax + abx * v + acx * w, ay + aby * v + acy * w, az + abz * v + acz * w);
}
