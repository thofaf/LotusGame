// Läsare för Assetto Corsa .kn5-modeller. Bygger Three.js-scengraf med material som
// efterliknar AC:s shaders (ksPerPixel*, ksPerPixelMultiMap*, ksMultilayer*).
// AC använder vänsterhänt koordinatsystem; vi speglar X-axeln så att banan blir rättvänd.
import * as THREE from './lib/three.module.js';
import { isDDS, decodeDDS } from './dds.js';

const td = new TextDecoder('utf-8');

export function parseKN5(buffer) {
  const dv = new DataView(buffer);
  const u8 = new Uint8Array(buffer);
  let p = 0;
  const i32 = () => { const v = dv.getInt32(p, true); p += 4; return v; };
  const u32 = () => { const v = dv.getUint32(p, true); p += 4; return v; };
  const f32 = () => { const v = dv.getFloat32(p, true); p += 4; return v; };
  const byte = () => u8[p++];
  const str = () => { const n = i32(); const s = td.decode(u8.subarray(p, p + n)); p += n; return s; };

  const magic = String.fromCharCode(...u8.subarray(0, 6)); p = 6;
  if (magic !== 'sc6969') throw new Error('Inte en KN5-fil');
  const version = i32();
  if (version > 5) i32();

  const textures = new Map();
  const texCount = i32();
  for (let i = 0; i < texCount; i++) {
    i32();
    const name = str();
    const size = u32();
    textures.set(name, u8.subarray(p, p + size));
    p += size;
  }

  const materials = [];
  const matCount = i32();
  for (let i = 0; i < matCount; i++) {
    const m = { name: str(), shader: str(), blend: byte(), alphaTested: !!byte(), depthMode: i32(), props: {}, tex: {} };
    const pc = i32();
    for (let k = 0; k < pc; k++) {
      const n = str();
      const a = f32();
      const b = [f32(), f32()], c = [f32(), f32(), f32()], d = [f32(), f32(), f32(), f32()];
      m.props[n] = a; void b; void c; void d;
    }
    const tc = i32();
    for (let k = 0; k < tc; k++) { const n = str(); i32(); m.tex[n] = str(); }
    materials.push(m);
  }

  function readNode() {
    const cls = i32();
    const name = str();
    const childCount = i32();
    const active = !!byte();
    const node = { cls, name, active, children: [], matrix: null, mesh: null };
    if (cls === 1) {
      const e = new Float32Array(16);
      for (let k = 0; k < 16; k++) e[k] = f32();
      // spegla X: M' = S M S
      e[1] = -e[1]; e[2] = -e[2]; e[3] = -e[3]; e[4] = -e[4]; e[8] = -e[8]; e[12] = -e[12];
      node.matrix = e;
    } else if (cls === 2 || cls === 3) {
      const castShadows = !!byte(), isVisible = !!byte(); byte();
      if (cls === 3) { const bc = i32(); for (let b = 0; b < bc; b++) { str(); p += 64; } }
      const vc = u32();
      const stride = cls === 2 ? 44 : 76;
      const pos = new Float32Array(vc * 3), nor = new Float32Array(vc * 3), uv = new Float32Array(vc * 2);
      for (let v = 0; v < vc; v++) {
        const o = p + v * stride;
        pos[v * 3] = -dv.getFloat32(o, true);
        pos[v * 3 + 1] = dv.getFloat32(o + 4, true);
        pos[v * 3 + 2] = dv.getFloat32(o + 8, true);
        nor[v * 3] = -dv.getFloat32(o + 12, true);
        nor[v * 3 + 1] = dv.getFloat32(o + 16, true);
        nor[v * 3 + 2] = dv.getFloat32(o + 20, true);
        uv[v * 2] = dv.getFloat32(o + 24, true);
        uv[v * 2 + 1] = dv.getFloat32(o + 28, true);
      }
      p += vc * stride;
      const ic = u32();
      const idx = new Uint16Array(ic);
      for (let k = 0; k < ic; k += 3) { // vänd vindningsordning p.g.a. speglingen
        idx[k] = dv.getUint16(p + k * 2, true);
        idx[k + 1] = dv.getUint16(p + k * 2 + 4, true);
        idx[k + 2] = dv.getUint16(p + k * 2 + 2, true);
      }
      p += ic * 2;
      const materialId = u32();
      let isRenderable = true;
      if (cls === 2) { u32(); f32(); f32(); p += 16; isRenderable = !!byte(); }
      else { u32(); p += 8; }
      node.mesh = { pos, nor, uv, idx, materialId, isVisible, isRenderable, castShadows };
    } else {
      throw new Error('Okänd nodklass ' + cls + ' vid ' + p);
    }
    for (let c = 0; c < childCount; c++) node.children.push(readNode());
    return node;
  }

  const root = readNode();
  return { textures, materials, root };
}

// ---------------------------------------------------------------------------
// Texturer
export async function buildTextures(kn5, renderer, names) {
  const hasS3TC = !!renderer.extensions.get('WEBGL_compressed_texture_s3tc');
  const maxAniso = renderer.capabilities.getMaxAnisotropy();
  const out = new Map();
  const jobs = [];
  for (const name of names) {
    const bytes = kn5.textures.get(name);
    if (!bytes) continue;
    if (isDDS(bytes)) {
      const t = decodeDDS(bytes, hasS3TC);
      if (t) out.set(name, t);
    } else {
      jobs.push(createImageBitmap(new Blob([bytes]), { imageOrientation: 'none', premultiplyAlpha: 'none', colorSpaceConversion: 'none' })
        .then(bmp => {
          const t = new THREE.Texture(bmp);
          t.flipY = false; t.generateMipmaps = true;
          t.minFilter = THREE.LinearMipmapLinearFilter;
          t.needsUpdate = true;
          out.set(name, t);
        }).catch(e => console.warn('Textur kunde inte avkodas', name, e)));
    }
  }
  await Promise.all(jobs);
  for (const t of out.values()) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = Math.min(8, maxAniso);
  }
  return out;
}

function usedTextureNames(kn5) {
  const s = new Set();
  for (const m of kn5.materials) for (const k in m.tex) s.add(m.tex[k]);
  return s;
}

// ---------------------------------------------------------------------------
// Material
const DETAIL_HEAD = `
uniform sampler2D txMask; uniform sampler2D txDR; uniform sampler2D txDG; uniform sampler2D txDB; uniform sampler2D txDA;
uniform vec4 detailMul; uniform sampler2D txDetail; uniform float detailUV; uniform float diffUV;
`;

function makeMaterial(def, tex) {
  const P = def.props;
  const get = k => tex.get(def.tex[k]);
  const diffuse = get('txDiffuse');
  const light = THREE.MathUtils.clamp(((P.ksAmbient ?? 0.4) + (P.ksDiffuse ?? 0.4)) / 0.75, 0.45, 1.35);
  const mat = new THREE.MeshLambertMaterial({ color: new THREE.Color(light, light, light) });
  mat.name = def.name;
  if (diffuse) mat.map = diffuse;
  const sh = def.shader;
  const uniforms = {};
  let fragCode = null;

  if (sh.startsWith('ksMultilayer') && get('txMask')) {
    const m = k => { const v = P[k]; return v ? v : 1; };
    const fallback = diffuse;
    Object.assign(uniforms, {
      txMask: { value: get('txMask') },
      txDR: { value: get('txDetailR') || fallback }, txDG: { value: get('txDetailG') || fallback },
      txDB: { value: get('txDetailB') || fallback }, txDA: { value: get('txDetailA') || fallback },
      detailMul: { value: new THREE.Vector4(m('multR'), m('multG'), m('multB'), m('multA')) },
    });
    fragCode = `
#ifdef USE_MAP
  vec4 baseC = texture2D(map, vMapUv);
  vec4 msk = texture2D(txMask, vMapUv);
  vec3 det = texture2D(txDR, vMapUv * detailMul.x).rgb * msk.r
           + texture2D(txDG, vMapUv * detailMul.y).rgb * msk.g
           + texture2D(txDB, vMapUv * detailMul.z).rgb * msk.b
           + texture2D(txDA, vMapUv * detailMul.w).rgb * msk.a;
  diffuseColor.rgb *= baseC.rgb * det;
#endif`;
  } else if (sh.startsWith('ksPerPixelMultiMap') && P.useDetail && get('txDetail')) {
    uniforms.txDetail = { value: get('txDetail') };
    uniforms.detailUV = { value: P.detailUVMultiplier || 1 };
    fragCode = `
#ifdef USE_MAP
  vec4 baseC = texture2D(map, vMapUv);
  vec3 det = texture2D(txDetail, vMapUv * detailUV).rgb;
  diffuseColor.rgb *= mix(baseC.rgb * det, baseC.rgb, baseC.a);
#endif`;
  } else if (sh === 'ksPerPixelNM_UVMult') {
    uniforms.diffUV = { value: P.diffuseMult || 1 };
    fragCode = `
#ifdef USE_MAP
  diffuseColor *= texture2D(map, vMapUv * diffUV);
#endif`;
  }

  const nm = get('txNormal');
  if (nm && (sh === 'ksPerPixelNM' || sh === 'ksPerPixelNM_UVMult' || sh.startsWith('ksPerPixelMultiMap'))) {
    let n = nm;
    if (sh === 'ksPerPixelNM_UVMult' && (P.normalMult || 1) !== 1) { n = nm.clone(); n.repeat.set(P.normalMult, P.normalMult); n.needsUpdate = true; }
    mat.normalMap = n;
    const gl = /opengl/i.test(def.tex.txNormal);
    mat.normalScale = new THREE.Vector2(1, gl ? 1 : -1);
  }

  if (fragCode) {
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\n' + DETAIL_HEAD)
        .replace('#include <map_fragment>', fragCode);
    };
    mat.customProgramCacheKey = () => def.shader + '|' + Object.keys(uniforms).join(',');
  }

  if (def.blend === 1) {
    mat.transparent = true; mat.depthWrite = false;
    mat.polygonOffset = true; mat.polygonOffsetFactor = -2; mat.polygonOffsetUnits = -2;
    mat.side = THREE.DoubleSide;
  } else if (def.alphaTested) {
    mat.alphaTest = 0.5; mat.side = THREE.DoubleSide;
  }
  if ((P.ksEmissive || 0) > 0) mat.emissive = new THREE.Color(P.ksEmissive, P.ksEmissive, P.ksEmissive);
  return mat;
}

// ---------------------------------------------------------------------------
// Bygg scengraf. opts.visual=false ger bara geometri (för fysik), utan texturer.
export async function buildKN5(kn5, renderer, opts = {}) {
  const visual = opts.visual !== false;
  let mats = [];
  if (visual) {
    const tex = await buildTextures(kn5, renderer, usedTextureNames(kn5));
    mats = kn5.materials.map(m => makeMaterial(m, tex));
  }
  const meshes = [];
  function build(node) {
    let obj;
    if (node.cls === 1) {
      obj = new THREE.Group();
      obj.matrix.fromArray(node.matrix);
      obj.matrix.decompose(obj.position, obj.quaternion, obj.scale);
    } else {
      const m = node.mesh;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(m.pos, 3));
      g.setAttribute('normal', new THREE.BufferAttribute(m.nor, 3));
      g.setAttribute('uv', new THREE.BufferAttribute(m.uv, 2));
      g.setIndex(new THREE.BufferAttribute(m.idx, 1));
      g.computeBoundingSphere();
      const def = kn5.materials[m.materialId];
      obj = new THREE.Mesh(g, visual ? mats[m.materialId] : undefined);
      obj.visible = visual && m.isRenderable && m.isVisible && node.active && !node.name.startsWith('AC_');
      obj.castShadow = m.castShadows && def && def.blend !== 1;
      obj.receiveShadow = true;
      obj.userData.matDef = def;
      meshes.push(obj);
    }
    obj.name = node.name;
    for (const c of node.children) obj.add(build(c));
    return obj;
  }
  const root = build(kn5.root);
  root.updateMatrixWorld(true);
  return { root, meshes, materials: mats };
}
