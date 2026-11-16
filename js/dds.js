// DDS-avkodare: DXT1/3/5 som komprimerade GPU-texturer, okomprimerade 24/32-bit som RGBA.
import * as THREE from './lib/three.module.js';

const DDPF_ALPHAPIXELS = 0x1, DDPF_FOURCC = 0x4;

function fourCC(v) { return String.fromCharCode(v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >> 24) & 255); }

export function isDDS(bytes) {
  return bytes.length > 128 && bytes[0] === 0x44 && bytes[1] === 0x44 && bytes[2] === 0x53 && bytes[3] === 0x20;
}

// Returnerar en THREE.Texture eller null om formatet inte stöds.
export function decodeDDS(bytes, hasS3TC) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const height = dv.getUint32(12, true), width = dv.getUint32(16, true);
  const mipCount = Math.max(1, dv.getUint32(28, true));
  const pfFlags = dv.getUint32(80, true);
  const fcc = fourCC(dv.getUint32(84, true));
  let offset = 128;

  if (pfFlags & DDPF_FOURCC) {
    let format, blockBytes;
    if (fcc === 'DXT1') { format = THREE.RGBA_S3TC_DXT1_Format; blockBytes = 8; }
    else if (fcc === 'DXT3') { format = THREE.RGBA_S3TC_DXT3_Format; blockBytes = 16; }
    else if (fcc === 'DXT5') { format = THREE.RGBA_S3TC_DXT5_Format; blockBytes = 16; }
    else return null;
    if (!hasS3TC) return softwareDXT(bytes, width, height, fcc, blockBytes);
    const mipmaps = [];
    let w = width, h = height;
    for (let i = 0; i < mipCount; i++) {
      const size = Math.max(4, w) / 4 * Math.max(4, h) / 4 * blockBytes;
      if (offset + size > bytes.length) break;
      mipmaps.push({ data: new Uint8Array(bytes.buffer, bytes.byteOffset + offset, size), width: w, height: h });
      offset += size; w = Math.max(1, w >> 1); h = Math.max(1, h >> 1);
    }
    // WebGL kräver fullständig mipkedja ned till 1x1 – annars använd bara nivå 0.
    const complete = mipmaps.length && mipmaps[mipmaps.length - 1].width === 1 && mipmaps[mipmaps.length - 1].height === 1;
    const tex = new THREE.CompressedTexture(complete ? mipmaps : [mipmaps[0]], width, height, format);
    tex.minFilter = complete ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
    return tex;
  }

  // Okomprimerat
  const bits = dv.getUint32(88, true);
  const rMask = dv.getUint32(92, true), gMask = dv.getUint32(96, true), bMask = dv.getUint32(100, true);
  const aMask = (pfFlags & DDPF_ALPHAPIXELS) ? dv.getUint32(104, true) : 0;
  const bpp = bits / 8;
  if (bpp !== 3 && bpp !== 4 && bpp !== 1 && bpp !== 2) return null;
  const shift = m => { if (!m) return 0; let s = 0; while (!((m >>> s) & 1)) s++; return s; };
  const scale = m => { if (!m) return 0; return 255 / (m >>> shift(m)); };
  const rs = shift(rMask), gs = shift(gMask), bs = shift(bMask), as = shift(aMask);
  const rk = scale(rMask), gk = scale(gMask), bk = scale(bMask), ak = scale(aMask);
  const n = width * height;
  const out = new Uint8Array(n * 4);
  const src = bytes;
  let p = offset;
  for (let i = 0, o = 0; i < n; i++, o += 4) {
    let v;
    if (bpp === 4) v = (src[p] | (src[p + 1] << 8) | (src[p + 2] << 16) | (src[p + 3] << 24)) >>> 0;
    else if (bpp === 3) v = src[p] | (src[p + 1] << 8) | (src[p + 2] << 16);
    else if (bpp === 2) v = src[p] | (src[p + 1] << 8);
    else v = src[p];
    p += bpp;
    if (bpp === 1 && !rMask) { out[o] = out[o + 1] = out[o + 2] = v; out[o + 3] = 255; continue; }
    out[o] = ((v & rMask) >>> rs) * rk;
    out[o + 1] = ((v & gMask) >>> gs) * gk;
    out[o + 2] = ((v & bMask) >>> bs) * bk;
    out[o + 3] = aMask ? ((v & aMask) >>> as) * ak : 255;
  }
  const tex = new THREE.DataTexture(out, width, height, THREE.RGBAFormat);
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

// Reserv om GPU:n saknar S3TC-stöd: avkoda DXT i mjukvara (endast nivå 0).
function softwareDXT(bytes, width, height, fcc, blockBytes) {
  const out = new Uint8Array(width * height * 4);
  let p = 128;
  const c = new Uint8Array(16);
  const bw = Math.max(1, width >> 2), bh = Math.max(1, height >> 2);
  for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
    const alpha = new Uint8Array(16).fill(255);
    if (fcc === 'DXT3') {
      for (let i = 0; i < 8; i++) { const b = bytes[p + i]; alpha[i * 2] = (b & 15) * 17; alpha[i * 2 + 1] = (b >> 4) * 17; }
      p += 8;
    } else if (fcc === 'DXT5') {
      const a0 = bytes[p], a1 = bytes[p + 1];
      const av = [a0, a1];
      if (a0 > a1) for (let i = 1; i < 7; i++) av.push(((7 - i) * a0 + i * a1) / 7 | 0);
      else { for (let i = 1; i < 5; i++) av.push(((5 - i) * a0 + i * a1) / 5 | 0); av.push(0, 255); }
      let bitsLo = bytes[p + 2] | (bytes[p + 3] << 8) | (bytes[p + 4] << 16);
      let bitsHi = bytes[p + 5] | (bytes[p + 6] << 8) | (bytes[p + 7] << 16);
      for (let i = 0; i < 8; i++) { alpha[i] = av[(bitsLo >> (3 * i)) & 7]; alpha[i + 8] = av[(bitsHi >> (3 * i)) & 7]; }
      p += 8;
    }
    const c0 = bytes[p] | (bytes[p + 1] << 8), c1 = bytes[p + 2] | (bytes[p + 3] << 8);
    const rgb = (v) => [((v >> 11) & 31) * 255 / 31, ((v >> 5) & 63) * 255 / 63, (v & 31) * 255 / 31];
    const k0 = rgb(c0), k1 = rgb(c1);
    const cols = [k0, k1];
    if (c0 > c1 || fcc !== 'DXT1') {
      cols.push(k0.map((v, i) => (2 * v + k1[i]) / 3), k0.map((v, i) => (v + 2 * k1[i]) / 3));
    } else {
      cols.push(k0.map((v, i) => (v + k1[i]) / 2), [0, 0, 0]);
    }
    const idx = bytes[p + 4] | (bytes[p + 5] << 8) | (bytes[p + 6] << 16) | (bytes[p + 7] << 24);
    p += 8;
    for (let i = 0; i < 16; i++) {
      const x = bx * 4 + (i & 3), y = by * 4 + (i >> 2);
      if (x >= width || y >= height) continue;
      const ci = (idx >>> (2 * i)) & 3;
      const o = (y * width + x) * 4;
      out[o] = cols[ci][0]; out[o + 1] = cols[ci][1]; out[o + 2] = cols[ci][2];
      out[o + 3] = (fcc === 'DXT1' && c0 <= c1 && ci === 3) ? 0 : alpha[i];
    }
    void blockBytes; void c;
  }
  const tex = new THREE.DataTexture(out, width, height, THREE.RGBAFormat);
  tex.generateMipmaps = true; tex.minFilter = THREE.LinearMipmapLinearFilter; tex.needsUpdate = true;
  return tex;
}
