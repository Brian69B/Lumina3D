import * as THREE from 'three';
import { BuilderTool, isRoadOrPathKind, SHIELD_SECTORS, TargetKind } from '../types/lighting';
import {
  clamp,
  degToRad,
  getEffectiveAngleAtDeg,
  getShieldTransmittanceAtDeg,
  hasCustomSectorAngles,
} from '../utils/photometrics';
import {
  getRoadPathTexture,
  getTrafficArrowTexture,
  getTrafficCountdownTexture,
} from './textures';

export interface PoleVisualRefs {
  root: THREE.Group;
  polePivot: THREE.Group;
  mastGroup: THREE.Group;
  flange: THREE.Mesh;
  lowerColumn: THREE.Mesh;
  upperColumn: THREE.Mesh;
  collar: THREE.Mesh;
  armMesh: THREE.Mesh;
  gimbalGroup: THREE.Group;
  shieldGroup: THREE.Group;
  shieldHoodMesh: THREE.Mesh;
  shieldTex: THREE.DataTexture;
  lensMaterial: THREE.MeshStandardMaterial;
  selectionRing: THREE.Mesh;
  beamPivot: THREE.Group;
  beamMesh: THREE.Mesh;
  beamMaterial: THREE.ShaderMaterial;
  baseHitbox: THREE.Mesh;
  lastAngleRange: number;
  lastBeamSig: string;
  lastHeight: number;
  lastArmDrop: number;
  lastShieldMask: number;
}

export interface TrafficSignalLensMaterials {
  red: THREE.MeshStandardMaterial[];
  yellow: THREE.MeshStandardMaterial[];
  green: THREE.MeshStandardMaterial[];
  countdown: THREE.MeshStandardMaterial;
}

export interface TrafficSignalMaterials {
  axisZ: TrafficSignalLensMaterials;
  axisX: TrafficSignalLensMaterials;
}

const geoCache = new Map<string, THREE.BufferGeometry>();
const stdMatCache = new Map<string, THREE.MeshStandardMaterial>();
const basicMatCache = new Map<string, THREE.MeshBasicMaterial>();

function sharedGeo<T extends THREE.BufferGeometry>(key: string, create: () => T): T {
  const existing = geoCache.get(key) as T | undefined;
  if (existing) return existing;
  const geo = create();
  geo.userData.shared = true;
  geoCache.set(key, geo);
  return geo;
}

function getSharedBoxGeo(w: number, h: number, d: number): THREE.BoxGeometry {
  return sharedGeo(`box:${w}:${h}:${d}`, () => new THREE.BoxGeometry(w, h, d));
}

function getSharedPlaneGeo(w: number, h: number): THREE.PlaneGeometry {
  return sharedGeo(`plane:${w}:${h}`, () => new THREE.PlaneGeometry(w, h));
}

function getSharedCylinderGeo(
  rt: number,
  rb: number,
  h: number,
  seg = 12,
  openEnded = false,
  thetaStart = 0,
  thetaLength = Math.PI * 2,
): THREE.CylinderGeometry {
  return sharedGeo(
    `cyl:${rt}:${rb}:${h}:${seg}:${openEnded ? 1 : 0}:${thetaStart}:${thetaLength}`,
    () => new THREE.CylinderGeometry(rt, rb, h, seg, 1, openEnded, thetaStart, thetaLength),
  );
}

function getSharedDodecaGeo(r: number, detail = 1): THREE.DodecahedronGeometry {
  return sharedGeo(`dodec:${r}:${detail}`, () => new THREE.DodecahedronGeometry(r, detail));
}

function getSharedRingGeo(rIn: number, rOut: number, seg = 40): THREE.RingGeometry {
  return sharedGeo(`ring:${rIn}:${rOut}:${seg}`, () => new THREE.RingGeometry(rIn, rOut, seg));
}

function getSharedStdMat(
  key: string,
  params: THREE.MeshStandardMaterialParameters,
): THREE.MeshStandardMaterial {
  const existing = stdMatCache.get(key);
  if (existing) return existing;
  const mat = new THREE.MeshStandardMaterial(params);
  mat.userData.shared = true;
  stdMatCache.set(key, mat);
  return mat;
}

function getSharedBasicMat(
  key: string,
  params: THREE.MeshBasicMaterialParameters,
): THREE.MeshBasicMaterial {
  const existing = basicMatCache.get(key);
  if (existing) return existing;
  const mat = new THREE.MeshBasicMaterial(params);
  mat.userData.shared = true;
  basicMatCache.set(key, mat);
  return mat;
}

function getSharedRoadSurfaceMat(
  kind: Parameters<typeof getRoadPathTexture>[0],
  maxAnisotropy: number,
  roughness = 0.84,
  metalness = 0.04,
): THREE.MeshStandardMaterial {
  return getSharedStdMat(`roadSurface:${kind}:${roughness}:${metalness}`, {
    map: getRoadPathTexture(kind, maxAnisotropy),
    roughness,
    metalness,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });
}

export function disposeObject3DResources(root: THREE.Object3D): void {
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (mesh.geometry && !mesh.geometry.userData?.shared) {
      mesh.geometry.dispose();
    }
    if (mesh.material) {
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const m of mats) {
        if (m && !m.userData?.shared) {
          m.dispose();
        }
      }
    }
  });
}

function createCurvedRoadStripGeometry(
  pivotX: number,
  pivotZ: number,
  rIn: number,
  rOut: number,
  startAngle: number,
  endAngle: number,
  arcSegs: number,
  uRepeats: number,
): THREE.BufferGeometry {
  const radialSteps = 2; // inner, center, outer
  const cols = radialSteps + 1;
  const rows = arcSegs + 1;
  const positions = new Float32Array(rows * cols * 3);
  const normals = new Float32Array(rows * cols * 3);
  const uvs = new Float32Array(rows * cols * 2);
  const indices: number[] = [];

  for (let i = 0; i <= arcSegs; i++) {
    const t = i / arcSegs;
    const angle = startAngle + (endAngle - startAngle) * t;
    const cosA = Math.cos(angle);
    const sinA = Math.sin(angle);
    for (let j = 0; j <= radialSteps; j++) {
      const v = j / radialSteps;
      const r = rIn + (rOut - rIn) * v;
      const idx = i * cols + j;
      positions[idx * 3] = pivotX + r * cosA;
      positions[idx * 3 + 1] = 0;
      positions[idx * 3 + 2] = pivotZ - r * sinA;
      normals[idx * 3] = 0;
      normals[idx * 3 + 1] = 1;
      normals[idx * 3 + 2] = 0;
      uvs[idx * 2] = t * uRepeats;
      uvs[idx * 2 + 1] = v;
    }
  }

  for (let i = 0; i < arcSegs; i++) {
    for (let j = 0; j < radialSteps; j++) {
      const a = i * cols + j;
      const b = a + 1;
      const c = (i + 1) * cols + j;
      const d = c + 1;
      indices.push(a, b, c, b, d, c);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  return geo;
}

function smoothstepNum(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function buildDualSphereBeamGeometry(outerR: number): THREE.BufferGeometry {
  const radii = [outerR, outerR * 0.44];
  const latSteps = 24;
  const lonSteps = 40;
  const positions: number[] = [];
  const normals: number[] = [];
  const edgeFades: number[] = [];
  const sphereGlows: number[] = [];
  const indices: number[] = [];

  for (const r of radii) {
    const baseVert = positions.length / 3;
    for (let i = 0; i <= latSteps; i++) {
      const theta = (i / latSteps) * Math.PI;
      const sinT = Math.sin(theta);
      const cosT = Math.cos(theta);
      for (let j = 0; j <= lonSteps; j++) {
        const phi = (j / lonSteps) * Math.PI * 2;
        const sinP = Math.sin(phi);
        const cosP = Math.cos(phi);
        const nx = sinT * sinP;
        const ny = -cosT;
        const nz = sinT * cosP;
        positions.push(nx * r, ny * r, nz * r);
        normals.push(nx, ny, nz);
        edgeFades.push(1.0);
        sphereGlows.push(1.0);
      }
    }
    const stride = lonSteps + 1;
    for (let i = 0; i < latSteps; i++) {
      for (let j = 0; j < lonSteps; j++) {
        const a = baseVert + i * stride + j;
        const b = a + stride;
        const c = a + 1;
        const d = b + 1;
        indices.push(a, b, c, c, b, d);
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geo.setAttribute('aEdgeFade', new THREE.Float32BufferAttribute(edgeFades, 1));
  geo.setAttribute('aSphereGlow', new THREE.Float32BufferAttribute(sphereGlows, 1));
  geo.setIndex(indices);
  geo.userData.actualReach = outerR;
  return geo;
}

/**
 * Generates a volumetric beam shell geometry oriented along local -Y (aim direction).
 * - angleRangeDeg = 0 -> tight collimated pencil beam
 * - angleRangeDeg = 90 -> wide hemisphere
 * - angleRangeDeg = 180 -> full 360° dual-shell volumetric orb around emitter
 */
export function buildBeamEnvelopeGeometry(
  angleRangeDeg: number,
  reachRadius = 18,
  sectorAngles?: Record<number, number>,
  tiltAngleDeg = 0,
  yawAngleDeg = 0,
): THREE.BufferGeometry {
  if (hasCustomSectorAngles(sectorAngles)) {
    const azimSteps = 192;
    const capRings = 14;
    const positions: number[] = [];
    const normals: number[] = [];
    const edgeFades: number[] = [];
    const sphereGlows: number[] = [];
    const indices: number[] = [];

    const pivotQuat = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(-degToRad(tiltAngleDeg), degToRad(yawAngleDeg), 0, 'YXZ'),
    );
    const tmpDir = new THREE.Vector3();
    const rawSliceAngles = new Float32Array(azimSteps);
    const hasTilt = Math.abs(tiltAngleDeg) >= 0.25;
    const fallbackDeg = clamp(angleRangeDeg, 0.85, 180);

    const evalEffAt = (thetaDeg: number, sinP: number, cosP: number): number => {
      const rad = degToRad(thetaDeg);
      tmpDir
        .set(Math.sin(rad) * sinP, -Math.cos(rad), Math.sin(rad) * cosP)
        .applyQuaternion(pivotQuat);
      const horiz = Math.hypot(tmpDir.x, tmpDir.z);
      if (horiz < 0.01) return fallbackDeg;
      const azimDeg = (Math.atan2(tmpDir.x, -tmpDir.z) * 180) / Math.PI;
      return clamp(getEffectiveAngleAtDeg(angleRangeDeg, sectorAngles, azimDeg), 0.85, 180);
    };

    for (let i = 0; i < azimSteps; i++) {
      const phi = (i / azimSteps) * Math.PI * 2;
      const sinP = Math.sin(phi);
      const cosP = Math.cos(phi);

      if (!hasTilt) {
        rawSliceAngles[i] = evalEffAt(45, sinP, cosP);
      } else {
        let lo = 0.85;
        let hi = 10;
        let found = -1;
        for (let probe = 180; probe >= 10; probe -= 10) {
          const eff = evalEffAt(probe, sinP, cosP);
          if (probe <= eff) {
            if (probe === 180 && eff >= 179.5) {
              found = 180;
            } else {
              lo = probe;
              hi = Math.min(180, probe + 10);
            }
            break;
          }
        }
        if (found < 0) {
          for (let step = 0; step < 6; step++) {
            const mid = (lo + hi) * 0.5;
            if (mid <= evalEffAt(mid, sinP, cosP)) {
              lo = mid;
            } else {
              hi = mid;
            }
          }
          found = lo;
        }
        rawSliceAngles[i] = clamp(found, 0.85, 180);
      }
    }

    let rawMin = 180;
    let rawMax = 0;
    for (let i = 0; i < azimSteps; i++) {
      if (rawSliceAngles[i] < rawMin) rawMin = rawSliceAngles[i];
      if (rawSliceAngles[i] > rawMax) rawMax = rawSliceAngles[i];
    }

    // If all sectors are near 180°, render a pure dual-shell volumetric sphere with zero internal spoke
    if (rawMin >= 176) {
      return buildDualSphereBeamGeometry(Math.min(reachRadius, 9.5));
    }

    // Smooth corner transitions cleanly while keeping sector centers intact
    let sliceAngles = new Float32Array(rawSliceAngles);
    if (rawMax - rawMin > 1) {
      for (let pass = 0; pass < 2; pass++) {
        const nextArr = new Float32Array(azimSteps);
        for (let i = 0; i < azimSteps; i++) {
          const prev = sliceAngles[(i - 1 + azimSteps) % azimSteps];
          const cur = sliceAngles[i];
          const next = sliceAngles[(i + 1) % azimSteps];
          nextArr[i] = prev * 0.2 + cur * 0.6 + next * 0.2;
        }
        sliceAngles = nextArr;
      }
    }

    let minSliceDeg = 180;
    let maxSliceDeg = 0;
    for (let i = 0; i < azimSteps; i++) {
      if (sliceAngles[i] < minSliceDeg) minSliceDeg = sliceAngles[i];
      if (sliceAngles[i] > maxSliceDeg) maxSliceDeg = sliceAngles[i];
    }

    const wideBlend = smoothstepNum(90, 175, maxSliceDeg);
    const wideCapR = Math.min(reachRadius, 10.5);
    const r = reachRadius * (1 - wideBlend) + wideCapR * wideBlend;

    // 1. Outer Spherical Cap (separate vertices so normals and full-cap glow are never corrupted)
    const capStride = capRings + 1;
    for (let i = 0; i <= azimSteps; i++) {
      const idx = i % azimSteps;
      const effDeg = sliceAngles[idx];
      const halfRad = degToRad(effDeg);
      const sGlow = smoothstepNum(95, 165, effDeg);
      const phi = (i / azimSteps) * Math.PI * 2;
      const sinP = Math.sin(phi);
      const cosP = Math.cos(phi);

      for (let c = 0; c <= capRings; c++) {
        const theta = halfRad * (1 - c / capRings);
        const sinT = Math.sin(theta);
        const cosT = Math.cos(theta);
        positions.push(sinT * r * sinP, -cosT * r, sinT * r * cosP);
        normals.push(sinT * sinP, -cosT, sinT * cosP);
        edgeFades.push(1.0);
        sphereGlows.push(sGlow);
      }
    }

    for (let i = 0; i < azimSteps; i++) {
      const rowA = i * capStride;
      const rowB = (i + 1) * capStride;
      for (let c = 0; c < capRings; c++) {
        const a = rowA + c;
        const b = a + 1;
        const d = rowB + c;
        const e = d + 1;
        indices.push(a, d, b, b, d, e);
      }
    }

    // 2. Conical Side Envelope with true parametric surface normals and zero needle at 180°
    const coneBase = positions.length / 3;
    const dPhi = (Math.PI * 4) / azimSteps;
    for (let i = 0; i <= azimSteps; i++) {
      const idx = i % azimSteps;
      const prevIdx = (idx - 1 + azimSteps) % azimSteps;
      const nextIdx = (idx + 1) % azimSteps;
      const effDeg = sliceAngles[idx];
      const halfRad = degToRad(effDeg);
      const sinH = Math.sin(halfRad);
      const cosH = Math.cos(halfRad);
      const phi = (i / azimSteps) * Math.PI * 2;
      const sinP = Math.sin(phi);
      const cosP = Math.cos(phi);

      const angleSpan = sliceAngles[nextIdx] - sliceAngles[prevIdx];
      const dThetaDPhi = degToRad(angleSpan) / dPhi;

      const tux = sinH * sinP;
      const tuy = -cosH;
      const tuz = sinH * cosP;

      const tpx = sinH * cosP + dThetaDPhi * cosH * sinP;
      const tpy = dThetaDPhi * sinH;
      const tpz = -sinH * sinP + dThetaDPhi * cosH * cosP;

      let nx = tuy * tpz - tuz * tpy;
      let ny = tuz * tpx - tux * tpz;
      let nz = tux * tpy - tuy * tpx;
      const nLen = Math.hypot(nx, ny, nz);
      if (nLen > 1e-6) {
        nx /= nLen;
        ny /= nLen;
        nz /= nLen;
      } else {
        nx = cosH * sinP;
        ny = sinH;
        nz = cosH * cosP;
      }

      const poleFade = effDeg >= 162 ? clamp((175 - effDeg) / 13, 0, 1) : 1;
      const maxSlope = Math.max(
        Math.abs(effDeg - sliceAngles[prevIdx]),
        Math.abs(sliceAngles[nextIdx] - effDeg),
      );
      const transitionFade = 0.52 + 0.48 * Math.exp(-maxSlope * 0.14);
      const wallFade = poleFade * transitionFade;
      const sGlow = smoothstepNum(95, 165, effDeg);

      // Apex ring vertex (r = 0.06)
      positions.push(0.06 * sinP, 0, 0.06 * cosP);
      normals.push(nx, ny, nz);
      edgeFades.push(wallFade);
      sphereGlows.push(0);

      // Rim ring vertex (r = shell radius)
      positions.push(sinH * r * sinP, -cosH * r, sinH * r * cosP);
      normals.push(nx, ny, nz);
      edgeFades.push(wallFade);
      sphereGlows.push(sGlow);
    }

    for (let i = 0; i < azimSteps; i++) {
      const degA = sliceAngles[i];
      const degB = sliceAngles[(i + 1) % azimSteps];
      if (degA >= 175 && degB >= 175) continue;
      const a = coneBase + i * 2;
      const b = a + 1;
      const c = coneBase + (i + 1) * 2;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }

    // 3. Inner Volumetric Core Sphere on wide/180° sectors so spherical regions retain their dual-orb look
    if (maxSliceDeg >= 145) {
      const innerR = r * 0.44;
      const innerBase = positions.length / 3;
      for (let i = 0; i <= azimSteps; i++) {
        const idx = i % azimSteps;
        const effDeg = sliceAngles[idx];
        const halfRad = degToRad(effDeg);
        const coreFade = smoothstepNum(138, 175, effDeg);
        const phi = (i / azimSteps) * Math.PI * 2;
        const sinP = Math.sin(phi);
        const cosP = Math.cos(phi);

        for (let c = 0; c <= capRings; c++) {
          const theta = halfRad * (1 - c / capRings);
          const sinT = Math.sin(theta);
          const cosT = Math.cos(theta);
          positions.push(sinT * innerR * sinP, -cosT * innerR, sinT * innerR * cosP);
          normals.push(sinT * sinP, -cosT, sinT * cosP);
          edgeFades.push(coreFade);
          sphereGlows.push(1.0);
        }
      }

      for (let i = 0; i < azimSteps; i++) {
        const rowA = innerBase + i * capStride;
        const rowB = innerBase + (i + 1) * capStride;
        for (let c = 0; c < capRings; c++) {
          const a = rowA + c;
          const b = a + 1;
          const d = rowB + c;
          const e = d + 1;
          indices.push(a, d, b, b, d, e);
        }
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geo.setAttribute('aEdgeFade', new THREE.Float32BufferAttribute(edgeFades, 1));
    geo.setAttribute('aSphereGlow', new THREE.Float32BufferAttribute(sphereGlows, 1));
    geo.setIndex(indices);
    geo.userData.actualReach = r;
    return geo;
  }

  const clampedAngle = clamp(angleRangeDeg, 0, 180);

  if (clampedAngle >= 178.5) {
    return buildDualSphereBeamGeometry(Math.min(reachRadius, 9.5));
  }

  const points: THREE.Vector2[] = [];
  let actualReach = reachRadius;

  if (clampedAngle <= 2.5) {
    // Straight collimated laser-like beam expanding minimally
    const topR = 0.08;
    const endR = Math.max(0.14, Math.tan(degToRad(Math.max(clampedAngle, 0.6))) * reachRadius);
    points.push(new THREE.Vector2(0.001, 0.05));
    points.push(new THREE.Vector2(topR, 0));
    points.push(new THREE.Vector2(endR, -reachRadius));
    points.push(new THREE.Vector2(0.001, -reachRadius));
  } else {
    // Spherical sector cone from emitter (0, 0) out to reachRadius
    const halfRad = degToRad(clampedAngle);
    actualReach = Math.min(reachRadius, clampedAngle > 90 ? 11.5 : reachRadius);
    points.push(new THREE.Vector2(0.06, 0));

    // Side ray out to spherical cap rim
    const rimX = Math.sin(halfRad) * actualReach;
    const rimY = -Math.cos(halfRad) * actualReach;
    points.push(new THREE.Vector2(rimX, rimY));

    // Spherical cap arc back to center axis (-Y)
    const capSteps = Math.max(10, Math.round((clampedAngle / 180) * 28));
    for (let i = 1; i <= capSteps; i++) {
      const theta = halfRad * (1 - i / capSteps);
      points.push(new THREE.Vector2(Math.sin(theta) * actualReach, -Math.cos(theta) * actualReach));
    }
  }

  const geo = new THREE.LatheGeometry(points, 44);
  geo.computeVertexNormals();
  const posAttr = geo.getAttribute('position') as THREE.BufferAttribute;
  const vertCount = posAttr.count;
  const edgeFades = new Float32Array(vertCount);
  const sphereGlows = new Float32Array(vertCount);
  const wideGlow = smoothstepNum(95, 165, clampedAngle);

  for (let i = 0; i < vertCount; i++) {
    edgeFades[i] = 1.0;
    const px = posAttr.getX(i);
    const py = posAttr.getY(i);
    const pz = posAttr.getZ(i);
    const dist = Math.hypot(px, py, pz);
    sphereGlows[i] = dist >= actualReach * 0.96 ? wideGlow : 0;
  }

  geo.setAttribute('aEdgeFade', new THREE.Float32BufferAttribute(edgeFades, 1));
  geo.setAttribute('aSphereGlow', new THREE.Float32BufferAttribute(sphereGlows, 1));
  geo.userData.actualReach = actualReach;
  return geo;
}

const SHIELD_BEAM_TEX_W = 256;

function createShieldMaskTexture(): THREE.DataTexture {
  const data = new Uint8Array(SHIELD_BEAM_TEX_W * 4);
  data.fill(255);
  const tex = new THREE.DataTexture(data, SHIELD_BEAM_TEX_W, 1, THREE.RGBAFormat);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

function updateShieldMaskTexture(tex: THREE.DataTexture, mask: number): void {
  const data = tex.image.data as Uint8Array;
  let openCount = 0;
  for (let s = 0; s < SHIELD_SECTORS; s++) {
    if (((mask >> s) & 1) === 0) openCount++;
  }
  const avgByte = Math.round((openCount / SHIELD_SECTORS) * 255);
  for (let i = 0; i < SHIELD_BEAM_TEX_W; i++) {
    const deg = (i / SHIELD_BEAM_TEX_W) * 360;
    const val = Math.round(getShieldTransmittanceAtDeg(mask, deg) * 255);
    const idx = i * 4;
    data[idx] = val;
    data[idx + 1] = avgByte;
    data[idx + 2] = val;
    data[idx + 3] = 255;
  }
  tex.needsUpdate = true;
}

/**
 * Builds a physical dark-anodized metal optical glare-shield skirt around (0, 0, 0)
 * matching world compass sectors (0° = North -Z, 90° = East +X, 180° = South +Z, 270° = West -X).
 */
function buildShieldHoodGeometry(mask: number): THREE.BufferGeometry {
  const cleanMask = mask & ((1 << SHIELD_SECTORS) - 1);
  if (cleanMask === 0) return new THREE.BufferGeometry();

  const sectorDeg = 360 / SHIELD_SECTORS;
  const profile: Array<[number, number]> = [
    [0.17, 0.08],
    [0.29, 0.05],
    [0.29, -0.09],
    [0.09, -0.21],
    [0.035, -0.235],
  ];
  const rows = profile.length;

  const positions: number[] = [];
  const indices: number[] = [];

  let runStart = -1;
  for (let s = 0; s <= SHIELD_SECTORS; s++) {
    const blocked = s < SHIELD_SECTORS && ((cleanMask >> s) & 1) !== 0;
    if (blocked && runStart === -1) {
      runStart = s;
    } else if (!blocked && runStart !== -1) {
      const runEnd = s - 1;
      const spanSectors = runEnd - runStart + 1;
      const arcSteps = spanSectors * 2;
      const startDeg = runStart * sectorDeg;
      const spanDeg = spanSectors * sectorDeg;
      const baseVertex = positions.length / 3;

      for (let i = 0; i <= arcSteps; i++) {
        const rad = degToRad(startDeg + (i / arcSteps) * spanDeg);
        const dirX = Math.sin(rad);
        const dirZ = -Math.cos(rad);
        for (let j = 0; j < rows; j++) {
          const [r, py] = profile[j];
          positions.push(r * dirX, py, r * dirZ);
        }
      }

      for (let i = 0; i < arcSteps; i++) {
        for (let j = 0; j < rows - 1; j++) {
          const a = baseVertex + i * rows + j;
          const b = a + 1;
          const c = baseVertex + (i + 1) * rows + j;
          const d = c + 1;
          indices.push(a, c, b, b, c, d);
        }
      }
      runStart = -1;
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

export function createVolumetricBeamMaterial(shieldTex: THREE.DataTexture): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color('#fff2dc') },
      uIntensity: { value: 0.4125 },
      uMaxDist: { value: 18.0 },
      uLightOrigin: { value: new THREE.Vector3() },
      uHasShield: { value: 0.0 },
      uHasCustomAngles: { value: 0.0 },
      uShieldTex: { value: shieldTex },
    },
    vertexShader: `
      attribute float aEdgeFade;
      attribute float aSphereGlow;
      varying vec3 vNormalView;
      varying vec3 vViewPos;
      varying vec3 vLocalPos;
      varying vec3 vWorldPos;
      varying float vEdgeFade;
      varying float vSphereGlow;

      void main() {
        vLocalPos = position;
        vEdgeFade = aEdgeFade;
        vSphereGlow = aSphereGlow;
        vec4 worldPos = modelMatrix * vec4(position, 1.0);
        vWorldPos = worldPos.xyz;
        vec4 mvPosition = viewMatrix * worldPos;
        vViewPos = -mvPosition.xyz;
        vNormalView = normalize(normalMatrix * normal);
        gl_Position = projectionMatrix * mvPosition;
      }
    `,
    fragmentShader: `
      uniform vec3 uColor;
      uniform float uIntensity;
      uniform float uMaxDist;
      uniform vec3 uLightOrigin;
      uniform float uHasShield;
      uniform sampler2D uShieldTex;
      varying vec3 vNormalView;
      varying vec3 vViewPos;
      varying vec3 vLocalPos;
      varying vec3 vWorldPos;
      varying float vEdgeFade;
      varying float vSphereGlow;

      void main() {
        float dist = length(vLocalPos);
        float distFade = pow(clamp(1.0 - dist / (uMaxDist * 1.24), 0.0, 1.0), 1.2);
        vec3 viewDir = normalize(vViewPos);
        float ndotv = abs(dot(normalize(vNormalView), viewDir));
        float fresnel = pow(ndotv, 1.25);
        float rimBias = mix(0.08, 0.38, smoothstep(0.65, 0.98, vEdgeFade));
        float coneTerm = distFade * (rimBias + 0.88 * fresnel);
        float sphereTerm = pow(ndotv, 1.55) * 0.82;
        float shapeTerm = mix(coneTerm, sphereTerm, clamp(vSphereGlow, 0.0, 1.0));

        float shield = 1.0;
        if (uHasShield > 0.5) {
          vec2 d = vWorldPos.xz - uLightOrigin.xz;
          float horiz = length(d);
          if (horiz > 0.06) {
            float azimU = atan(d.x, -d.y) / 6.28318530718;
            shield = texture2D(uShieldTex, vec2(azimU, 0.5)).r;
          } else {
            shield = texture2D(uShieldTex, vec2(0.0, 0.5)).g;
          }
        }

        float alpha = clamp(uIntensity * shapeTerm * shield * vEdgeFade, 0.0, 0.51);
        if (alpha <= 0.002) discard;
        gl_FragColor = vec4(uColor * 1.22, alpha);
      }
    `,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  });
}

function buildCantileverArmGeometry(armOffsetZ: number, armDrop = 0.35): THREE.TubeGeometry {
  const curve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, -armDrop, armOffsetZ),
    new THREE.Vector3(0, -armDrop * 0.14, armOffsetZ * 0.65),
    new THREE.Vector3(0, 0.06, armOffsetZ * 0.25),
    new THREE.Vector3(0, 0.06, 0),
  ]);
  return new THREE.TubeGeometry(curve, 16, 0.055, 10, false);
}

/**
 * Creates a composite multi-part articulated street pole & luminaire assembly.
 * Origin (0, 0, 0) is the ground projection directly below the luminaire optical center (0, height, 0).
 */
export function createStreetPoleRig(fixtureId: string): PoleVisualRefs {
  const root = new THREE.Group();
  root.userData.fixtureId = fixtureId;

  const poleMetal = new THREE.MeshStandardMaterial({
    color: 0x475569,
    metalness: 0.78,
    roughness: 0.34,
  });

  const darkCastIron = new THREE.MeshStandardMaterial({
    color: 0x1e293b,
    metalness: 0.65,
    roughness: 0.58,
  });

  const polePivot = new THREE.Group();
  root.add(polePivot);

  const mastGroup = new THREE.Group();
  mastGroup.position.z = -1.05;
  polePivot.add(mastGroup);

  // 1. Anchor base plate + octagonal flange
  const basePlate = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.04, 0.46), darkCastIron);
  basePlate.position.y = 0.02;
  basePlate.castShadow = false;
  basePlate.receiveShadow = true;
  mastGroup.add(basePlate);

  const flange = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.19, 0.22, 8), darkCastIron);
  flange.position.y = 0.15;
  flange.castShadow = false;
  mastGroup.add(flange);

  // 2. Lower tapered pole shaft (unit height 1m, scaled dynamically)
  const lowerColumn = new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.11, 1, 14), poleMetal);
  lowerColumn.castShadow = false;
  lowerColumn.receiveShadow = true;
  mastGroup.add(lowerColumn);

  // 3. Mid telescoping collar
  const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.14, 14), darkCastIron);
  collar.castShadow = false;
  mastGroup.add(collar);

  // 4. Upper mast extension (unit height 1m, scaled dynamically)
  const upperColumn = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, 1, 14), poleMetal);
  upperColumn.castShadow = false;
  mastGroup.add(upperColumn);

  // 5. Curved cantilever arm (inside polePivot so rotating light yaw rotates pole + arm together)
  const armMesh = new THREE.Mesh(buildCantileverArmGeometry(-1.05), poleMetal);
  armMesh.castShadow = false;
  polePivot.add(armMesh);

  // 6. Articulated luminaire gimbal + cobra-head housing + optical lens (centered at (0, height, 0))
  const gimbalGroup = new THREE.Group();
  root.add(gimbalGroup);

  const yoke = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.14, 12), darkCastIron);
  yoke.position.y = 0.08;
  gimbalGroup.add(yoke);

  const housing = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.1, 0.46), darkCastIron);
  housing.position.set(0, 0.05, 0.06);
  housing.castShadow = false;
  gimbalGroup.add(housing);

  // Cooling fins accent on top of housing
  for (let i = -1; i <= 1; i++) {
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.025, 0.04), poleMetal);
    fin.position.set(0, 0.11, -0.02 + i * 0.09);
    gimbalGroup.add(fin);
  }

  const lensMaterial = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    emissive: new THREE.Color('#fff2dc'),
    emissiveIntensity: 2.2,
    roughness: 0.15,
    metalness: 0.1,
  });
  lensMaterial.userData.skipLuxOverlay = true;
  const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.13, 0.04, 18), lensMaterial);
  lens.position.set(0, -0.005, 0);
  lens.userData.skipLuxOverlay = true;
  gimbalGroup.add(lens);

  // 6b. World-azimuth 360° luminaire optical glare shield baffle (casts real directional shadow cutoff)
  const shieldGroup = new THREE.Group();
  root.add(shieldGroup);

  const shieldMat = new THREE.MeshStandardMaterial({
    color: 0x0f172a,
    metalness: 0.62,
    roughness: 0.68,
    side: THREE.DoubleSide,
  });
  shieldMat.userData.skipLuxOverlay = true;
  const shieldHoodMesh = new THREE.Mesh(new THREE.BufferGeometry(), shieldMat);
  shieldHoodMesh.castShadow = false;
  shieldHoodMesh.receiveShadow = false;
  shieldHoodMesh.visible = false;
  shieldHoodMesh.userData.selectFixtureId = fixtureId;
  shieldHoodMesh.userData.skipLuxOverlay = true;
  shieldHoodMesh.layers.enable(1);
  shieldGroup.add(shieldHoodMesh);

  // Selection ring on ground around luminaire footprint center
  const selectionRing = new THREE.Mesh(
    new THREE.RingGeometry(0.42, 0.52, 32),
    new THREE.MeshBasicMaterial({
      color: 0xf59e0b,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
    }),
  );
  selectionRing.rotation.x = -Math.PI / 2;
  selectionRing.position.y = 0.025;
  selectionRing.visible = false;
  root.add(selectionRing);

  // Invisible click hitbox at pole base for easy selection
  const baseHitbox = new THREE.Mesh(
    new THREE.CylinderGeometry(0.6, 0.6, 2.4, 10),
    new THREE.MeshBasicMaterial({ visible: false }),
  );
  baseHitbox.position.y = 1.2;
  mastGroup.add(baseHitbox);

  // Make all physical pole parts (mast, arm, luminaire, base hitbox) selectable in 3D
  for (const part of [mastGroup, armMesh, gimbalGroup]) {
    part.traverse((obj) => {
      if ((obj as THREE.Mesh).isMesh) {
        obj.userData.selectFixtureId = fixtureId;
        obj.layers.enable(1);
      }
    });
  }

  // Volumetric beam shell pivot at (0, height, 0)
  const beamPivot = new THREE.Group();
  root.add(beamPivot);

  const shieldTex = createShieldMaskTexture();
  const beamMaterial = createVolumetricBeamMaterial(shieldTex);
  const beamMesh = new THREE.Mesh(buildBeamEnvelopeGeometry(48, 18), beamMaterial);
  beamMesh.renderOrder = 4;
  beamMesh.layers.set(2);
  beamPivot.add(beamMesh);

  return {
    root,
    polePivot,
    mastGroup,
    flange,
    lowerColumn,
    upperColumn,
    collar,
    armMesh,
    gimbalGroup,
    shieldGroup,
    shieldHoodMesh,
    shieldTex,
    lensMaterial,
    selectionRing,
    beamPivot,
    beamMesh,
    beamMaterial,
    baseHitbox,
    lastAngleRange: 48,
    lastBeamSig: '48:',
    lastHeight: -1,
    lastArmDrop: 0.35,
    lastShieldMask: -1,
  };
}

/**
 * Updates pole telescoping, cantilever arm drop, luminaire gimbal pitch/yaw, 360° glare shield baffle, and volumetric shell.
 */
export function updateStreetPoleRig(
  refs: PoleVisualRefs,
  height: number,
  tiltAngleDeg: number,
  yawAngleDeg: number,
  angleRangeDeg: number,
  lumens: number,
  colorHex: string,
  enabled: boolean,
  isSelected: boolean,
  showBeamEnvelope: boolean,
  worldX: number,
  worldZ: number,
  shieldSectors = 0,
  sectorAngles?: Record<number, number>,
  sectorAnglesSig = '',
  poleYawAngleDeg?: number,
): void {
  // Keep pole anchored at z = -1.05 in polePivot space at all heights so lowering the light never shifts the pole
  const armOffsetZ = -1.05;

  if (refs.lastHeight !== height) {
    const usableH = Math.max(0.18, height - 0.04);
    const flangeScaleY = Math.min(1, usableH / 0.32);
    refs.flange.scale.set(1, flangeScaleY, 1);
    refs.flange.position.y = 0.04 + 0.11 * flangeScaleY;

    const lowerH = usableH * 0.55;
    const upperH = Math.max(0.08, usableH - lowerH);

    refs.lowerColumn.scale.set(1, lowerH, 1);
    refs.lowerColumn.position.y = 0.04 + lowerH * 0.5;

    const collarScaleY = Math.min(1, usableH / 0.45);
    refs.collar.scale.set(1, collarScaleY, 1);
    refs.collar.position.y = 0.04 + lowerH;

    refs.upperColumn.scale.set(1, upperH, 1);
    refs.upperColumn.position.y = 0.04 + lowerH + upperH * 0.5;

    const armDrop = Math.min(0.35, height * 0.45);
    if (Math.abs(armDrop - refs.lastArmDrop) > 0.002) {
      refs.armMesh.geometry.dispose();
      refs.armMesh.geometry = buildCantileverArmGeometry(armOffsetZ, armDrop);
      refs.lastArmDrop = armDrop;
    }
    refs.armMesh.visible = true;
    refs.armMesh.position.y = height;

    const hitboxH = Math.min(2.4, Math.max(0.8, height + 0.25));
    refs.baseHitbox.scale.y = hitboxH / 2.4;
    refs.baseHitbox.position.y = hitboxH * 0.5;

    refs.gimbalGroup.position.y = height;
    refs.shieldGroup.position.y = height;
    refs.beamPivot.position.y = height;
    refs.lastHeight = height;
  }

  // Pole turns only with poleYawAngleDeg; luminaire head + beam turn with yawAngleDeg
  const tiltRad = degToRad(tiltAngleDeg);
  const yawRad = degToRad(yawAngleDeg);
  const poleYawRad = degToRad(poleYawAngleDeg ?? yawAngleDeg);
  refs.polePivot.rotation.y = poleYawRad;
  refs.gimbalGroup.rotation.set(-tiltRad, yawRad, 0, 'YXZ');
  refs.beamPivot.rotation.set(-tiltRad, yawRad, 0, 'YXZ');

  // Update physical 360° optical shield baffle & volumetric mask texture when mask changes
  const cleanMask = shieldSectors & ((1 << SHIELD_SECTORS) - 1);
  if (refs.lastShieldMask !== cleanMask) {
    refs.lastShieldMask = cleanMask;
    refs.shieldHoodMesh.geometry.dispose();
    if (cleanMask === 0) {
      refs.shieldHoodMesh.geometry = new THREE.BufferGeometry();
      refs.shieldHoodMesh.visible = false;
      refs.beamMaterial.uniforms.uHasShield.value = 0.0;
    } else {
      refs.shieldHoodMesh.geometry = buildShieldHoodGeometry(cleanMask);
      refs.shieldHoodMesh.visible = true;
      updateShieldMaskTexture(refs.shieldTex, cleanMask);
      refs.beamMaterial.uniforms.uHasShield.value = 1.0;
    }
  }

  refs.beamMaterial.uniforms.uLightOrigin.value.set(worldX, height, worldZ);
  refs.beamMaterial.uniforms.uHasCustomAngles.value = sectorAnglesSig ? 1.0 : 0.0;

  // Rebuild beam shell when angleRange, height reach, or custom sector angles change
  const beamSig = sectorAnglesSig
    ? `${angleRangeDeg}:${sectorAnglesSig}:${tiltAngleDeg}:${yawAngleDeg}:${height.toFixed(1)}`
    : `${angleRangeDeg}:${height.toFixed(1)}`;
  if (refs.lastBeamSig !== beamSig) {
    const reach = Math.max(12, Math.min(24, height * 2.4));
    refs.beamMesh.geometry.dispose();
    const nextBeamGeo = buildBeamEnvelopeGeometry(
      angleRangeDeg,
      reach,
      sectorAngles,
      tiltAngleDeg,
      yawAngleDeg,
    );
    refs.beamMesh.geometry = nextBeamGeo;
    refs.beamMaterial.uniforms.uMaxDist.value =
      (nextBeamGeo.userData.actualReach as number | undefined) ??
      Math.min(reach, angleRangeDeg > 90 ? 11.5 : reach);
    refs.lastAngleRange = angleRangeDeg;
    refs.lastBeamSig = beamSig;
  }

  refs.lensMaterial.emissive.set(colorHex);
  refs.lensMaterial.emissiveIntensity = enabled ? 1.2 + (lumens / 30000) * 2.2 : 0.05;

  refs.beamMesh.visible = enabled && showBeamEnvelope;
  refs.beamMaterial.uniforms.uColor.value.set(colorHex);
  refs.beamMaterial.uniforms.uIntensity.value = enabled
    ? clamp(0.21 + (lumens / 30000) * 0.42, 0.18, 0.645)
    : 0;

  refs.selectionRing.visible = isSelected;
}

/**
 * Builds composite 3–9 part movable shadow-casting street targets.
 * Bottom-center pivoted at y = 0 so every object rests flush on the street/sidewalk.
 */
export interface PedestrianRigRefs {
  legL: THREE.Group;
  legR: THREE.Group;
  kneeL: THREE.Group;
  kneeR: THREE.Group;
  armL: THREE.Group;
  armR: THREE.Group;
  elbowL: THREE.Group;
  elbowR: THREE.Group;
  upperBody: THREE.Group;
  head: THREE.Group;
  heightScale: number;
}

export interface BikeRiderRefs {
  crankGroup: THREE.Group;
  pedalL: THREE.Group;
  pedalR: THREE.Group;
  legL: THREE.Group;
  kneeL: THREE.Group;
  legR: THREE.Group;
  kneeR: THREE.Group;
  upperBody: THREE.Group;
  head: THREE.Group;
  pedalPhase: number;
}

export interface MotoRiderRefs {
  upperBody: THREE.Group;
  head: THREE.Group;
}

const BIKE_HIP_X = -0.25;
const BIKE_HIP_Y = 0.93;
const BIKE_CRANK_X = -0.04;
const BIKE_CRANK_Y = 0.35;
const BIKE_CRANK_R = 0.13;
const BIKE_THIGH_LEN = 0.39;
const BIKE_SHIN_LEN = 0.38;

function solveLegPoseXY(
  hipX: number,
  hipY: number,
  footX: number,
  footY: number,
  l1: number,
  l2: number,
): { hipZ: number; kneeZ: number } {
  const dx = footX - hipX;
  const dy = footY - hipY;
  const maxD = l1 + l2 - 0.015;
  const minD = Math.abs(l1 - l2) + 0.02;
  const d = clamp(Math.hypot(dx, dy), minD, maxD);
  const baseAngle = Math.atan2(dx, -dy);
  const cosAlpha = clamp((l1 * l1 + d * d - l2 * l2) / (2 * l1 * d), -1, 1);
  const cosBeta = clamp((l1 * l1 + l2 * l2 - d * d) / (2 * l1 * l2), -1, 1);
  return {
    hipZ: baseAngle + Math.acos(cosAlpha),
    kneeZ: -(Math.PI - Math.acos(cosBeta)),
  };
}

export function poseBikeRiderPedaling(refs: BikeRiderRefs, phase: number): void {
  refs.crankGroup.rotation.z = -phase;
  refs.pedalR.rotation.z = phase;
  refs.pedalL.rotation.z = phase;

  const rFootX = BIKE_CRANK_X + BIKE_CRANK_R * Math.cos(-phase);
  const rFootY = BIKE_CRANK_Y + BIKE_CRANK_R * Math.sin(-phase) + 0.032;
  const lFootX = BIKE_CRANK_X - BIKE_CRANK_R * Math.cos(-phase);
  const lFootY = BIKE_CRANK_Y - BIKE_CRANK_R * Math.sin(-phase) + 0.032;

  const rPose = solveLegPoseXY(
    BIKE_HIP_X,
    BIKE_HIP_Y,
    rFootX,
    rFootY,
    BIKE_THIGH_LEN,
    BIKE_SHIN_LEN,
  );
  const lPose = solveLegPoseXY(
    BIKE_HIP_X,
    BIKE_HIP_Y,
    lFootX,
    lFootY,
    BIKE_THIGH_LEN,
    BIKE_SHIN_LEN,
  );

  refs.legR.rotation.z = rPose.hipZ;
  refs.kneeR.rotation.z = rPose.kneeZ;
  refs.legL.rotation.z = lPose.hipZ;
  refs.kneeL.rotation.z = lPose.kneeZ;
}

export interface ParkingStallSpec {
  idx: number;
  x: number;
  z: number;
  inwardYaw: number;
}

export const PARKING_STALL_SPECS: readonly ParkingStallSpec[] = [
  { idx: 0, x: -4.15, z: -2.85, inwardYaw: Math.PI },
  { idx: 1, x: -4.15, z: 0.0, inwardYaw: Math.PI },
  { idx: 2, x: -4.15, z: 2.85, inwardYaw: Math.PI },
  { idx: 3, x: 4.15, z: -2.85, inwardYaw: 0 },
  { idx: 4, x: 4.15, z: 0.0, inwardYaw: 0 },
  { idx: 5, x: 4.15, z: 2.85, inwardYaw: 0 },
];

export function getParkingLotSeed(lotId: string): number {
  let lotHash = 0;
  for (let i = 0; i < lotId.length; i++) {
    lotHash = (lotHash * 31 + lotId.charCodeAt(i)) | 0;
  }
  return Math.abs(lotHash);
}

export function getParkingLotOpenStalls(_lotId?: string): ParkingStallSpec[] {
  return [...PARKING_STALL_SPECS];
}

export function createStreetTargetGroup(
  id: string,
  kind: TargetKind,
  contactShadowTex: THREE.Texture,
  maxAnisotropy = 8,
  customColor?: string,
  length?: number,
): THREE.Group {
  const group = new THREE.Group();
  group.userData.targetId = id;
  const isGroundSegment = isRoadOrPathKind(kind);

  const footprintMap: Record<TargetKind, { sx: number; sz: number; ringR: number }> = {
    bike: { sx: 2.2, sz: 1.2, ringR: 1.05 },
    motorcycle: { sx: 2.6, sz: 1.4, ringR: 1.25 },
    sedan: { sx: 5.0, sz: 2.6, ringR: 2.35 },
    van: { sx: 5.8, sz: 2.8, ringR: 2.85 },
    truck: { sx: 7.6, sz: 3.1, ringR: 3.7 },
    bus: { sx: 10.0, sz: 3.3, ringR: 4.8 },
    pedestrian: { sx: 1.6, sz: 1.6, ringR: 0.72 },
    bollard: { sx: 1.2, sz: 1.2, ringR: 0.55 },
    crate: { sx: 2.0, sz: 2.0, ringR: 0.95 },
    'traffic-light': { sx: 1.8, sz: 1.8, ringR: 0.85 },
    'building-kiosk': { sx: 5.0, sz: 5.0, ringR: 2.65 },
    'building-small': { sx: 5.8, sz: 5.8, ringR: 3.15 },
    'building-tall': { sx: 6.6, sz: 6.6, ringR: 3.65 },
    'building-highrise': { sx: 7.4, sz: 7.4, ringR: 4.05 },
    'building-rowhouse': { sx: 11.2, sz: 6.0, ringR: 5.4 },
    'building-commercial': { sx: 12.2, sz: 6.2, ringR: 5.8 },
    'building-warehouse': { sx: 11.8, sz: 7.8, ringR: 6.2 },
    'building-civic': { sx: 12.0, sz: 8.2, ringR: 6.4 },
    'building-apartments': { sx: 10.6, sz: 8.4, ringR: 6.0 },
    'building-skyscraper': { sx: 9.4, sz: 7.6, ringR: 5.2 },
    tree: { sx: 2.8, sz: 2.8, ringR: 1.35 },
    hedge: { sx: 3.1, sz: 1.5, ringR: 1.45 },
    bench: { sx: 2.6, sz: 1.6, ringR: 1.15 },
    'road-2lane': { sx: 8.0, sz: 9.0, ringR: 4.85 },
    'road-intersection': { sx: 9.0, sz: 9.0, ringR: 5.2 },
    'road-t-junction': { sx: 9.0, sz: 9.0, ringR: 5.2 },
    'road-turn-90': { sx: 12.0, sz: 12.0, ringR: 6.4 },
    'road-curve-45': { sx: 14.0, sz: 10.0, ringR: 6.6 },
    'road-crosswalk': { sx: 6.0, sz: 9.0, ringR: 4.6 },
    'road-roundabout': { sx: 20.0, sz: 20.0, ringR: 10.4 },
    'road-culdesac': { sx: 12.0, sz: 12.0, ringR: 6.2 },
    'road-deadend': { sx: 12.0, sz: 12.0, ringR: 6.2 },
    'path-sidewalk': { sx: 8.0, sz: 3.0, ringR: 3.2 },
    'path-bike': { sx: 8.0, sz: 2.4, ringR: 3.0 },
    'path-cobble': { sx: 6.0, sz: 6.0, ringR: 3.6 },
    'path-gravel': { sx: 8.0, sz: 2.2, ringR: 2.9 },
    'parking-lot': { sx: 13.0, sz: 9.6, ringR: 7.1 },
  };
  const fp = footprintMap[kind];
  const segLen2Lane = kind === 'road-2lane' && length && length > 0 ? length : 8.0;
  const ringRadius =
    kind === 'road-2lane' ? Math.max(4.6, segLen2Lane * 0.52) : fp.ringR;

  // Grounding contact shadow plane (disabled for flat modular road/path segments)
  const contactPlane = new THREE.Mesh(
    getSharedPlaneGeo(fp.sx, fp.sz),
    getSharedBasicMat('contactShadow', {
      map: contactShadowTex,
      transparent: true,
      opacity: 0.48,
      depthWrite: false,
    }),
  );
  contactPlane.rotation.x = -Math.PI / 2;
  contactPlane.position.y = 0.014;
  contactPlane.visible = !isGroundSegment;
  group.userData.contactPlane = contactPlane;
  group.add(contactPlane);

  // Selection highlight ring
  const selectRing = new THREE.Mesh(
    getSharedRingGeo(ringRadius, ringRadius + 0.18, 40),
    getSharedBasicMat('selectionRing', {
      color: 0x06b6d4,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
    }),
  );
  selectRing.rotation.x = -Math.PI / 2;
  selectRing.position.y = isGroundSegment ? 0.036 : 0.028;
  selectRing.name = 'selectionRing';
  selectRing.visible = false;
  group.userData.selectionRing = selectRing;
  group.add(selectRing);

  if (kind === 'bike') {
    let bHash = 2166136261;
    for (let i = 0; i < id.length; i++) {
      bHash ^= id.charCodeAt(i);
      bHash = Math.imul(bHash, 16777619);
    }
    const bRand01 = (salt: number) => {
      let x = bHash ^ (salt * 0x9e3779b9);
      x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
      x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
      return ((x ^ (x >>> 16)) >>> 0) / 4294967295;
    };

    const BIKE_FRAME_COLORS = [0x0ea5e9, 0x10b981, 0xe11d48, 0xf59e0b, 0x6366f1, 0x14b8a6];
    const JERSEY_COLORS = [0x0284c7, 0xd97706, 0x059669, 0xdc2626, 0x7c3aed, 0x334155, 0xdb2777];
    const HELMET_COLORS = [0xf8fafc, 0x0ea5e9, 0xfacc15, 0xef4444, 0x1e293b, 0x10b981];
    const SKIN_TONES = [0xf2cbb0, 0xe2b290, 0xd49c79, 0xb87d59, 0x8d583b, 0x613a26];

    const frameColor = customColor
      ? new THREE.Color(customColor)
      : new THREE.Color(BIKE_FRAME_COLORS[Math.floor(bRand01(1) * BIKE_FRAME_COLORS.length)]);
    const frameMat = new THREE.MeshStandardMaterial({ color: frameColor, metalness: 0.65, roughness: 0.28 });
    const tireMat = new THREE.MeshStandardMaterial({ color: 0x16181d, roughness: 0.88, metalness: 0.05 });
    const metalMat = new THREE.MeshStandardMaterial({ color: 0xcbd5e1, roughness: 0.28, metalness: 0.88 });
    const saddleMat = new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.72, metalness: 0.08 });

    const addTube = (ax: number, ay: number, bx: number, by: number, radius: number, mat: THREE.Material) => {
      const dx = bx - ax;
      const dy = by - ay;
      const len = Math.hypot(dx, dy);
      const tube = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, len, 8), mat);
      tube.position.set((ax + bx) * 0.5, (ay + by) * 0.5, 0);
      tube.rotation.z = Math.atan2(dy, dx) - Math.PI / 2;
      tube.castShadow = true;
      group.add(tube);
    };

    const bikeWheelPivots: THREE.Group[] = [];
    for (const wx of [-0.56, 0.56]) {
      const wheelPivot = new THREE.Group();
      wheelPivot.position.set(wx, 0.34, 0);

      const tire = new THREE.Mesh(new THREE.TorusGeometry(0.31, 0.032, 10, 24), tireMat);
      tire.castShadow = true;
      tire.receiveShadow = true;
      wheelPivot.add(tire);

      const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.09, 10), metalMat);
      hub.rotation.x = Math.PI / 2;
      wheelPivot.add(hub);

      group.add(wheelPivot);
      bikeWheelPivots.push(wheelPivot);
    }
    group.userData.wheelPivots = bikeWheelPivots;
    group.userData.wheelRadius = 0.34;

    // Diamond bicycle frame + fork
    addTube(-0.56, 0.34, -0.04, 0.34, 0.02, frameMat);
    addTube(-0.56, 0.34, -0.2, 0.74, 0.018, frameMat);
    addTube(-0.04, 0.34, -0.2, 0.74, 0.022, frameMat);
    addTube(-0.2, 0.74, 0.34, 0.78, 0.022, frameMat);
    addTube(-0.04, 0.34, 0.34, 0.72, 0.024, frameMat);
    addTube(0.32, 0.86, 0.56, 0.34, 0.022, metalMat);

    // Seatpost + saddle
    addTube(-0.2, 0.74, -0.25, 0.9, 0.016, metalMat);
    const saddle = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.06, 0.13), saddleMat);
    saddle.position.set(-0.26, 0.92, 0);
    saddle.castShadow = true;
    group.add(saddle);

    // Crankset, arms & horizontal pedals
    const crankGroup = new THREE.Group();
    crankGroup.position.set(BIKE_CRANK_X, BIKE_CRANK_Y, 0);

    const chainring = new THREE.Mesh(new THREE.CylinderGeometry(0.095, 0.095, 0.016, 16), metalMat);
    chainring.rotation.x = Math.PI / 2;
    crankGroup.add(chainring);

    const crankArmGeo = new THREE.BoxGeometry(BIKE_CRANK_R, 0.022, 0.018);
    const crankArmR = new THREE.Mesh(crankArmGeo, metalMat);
    crankArmR.position.set(BIKE_CRANK_R * 0.5, 0, 0.07);
    crankGroup.add(crankArmR);

    const crankArmL = new THREE.Mesh(crankArmGeo, metalMat);
    crankArmL.position.set(-BIKE_CRANK_R * 0.5, 0, -0.07);
    crankGroup.add(crankArmL);

    const pedalGeo = new THREE.BoxGeometry(0.095, 0.022, 0.075);
    const pedalR = new THREE.Group();
    pedalR.position.set(BIKE_CRANK_R, 0, 0.115);
    const pedalRMesh = new THREE.Mesh(pedalGeo, saddleMat);
    pedalR.add(pedalRMesh);
    crankGroup.add(pedalR);

    const pedalL = new THREE.Group();
    pedalL.position.set(-BIKE_CRANK_R, 0, -0.115);
    const pedalLMesh = new THREE.Mesh(pedalGeo, saddleMat);
    pedalL.add(pedalLMesh);
    crankGroup.add(pedalL);

    group.add(crankGroup);

    // Handlebars
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.12, 8), metalMat);
    stem.position.set(0.31, 0.92, 0);
    group.add(stem);
    const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.016, 0.52, 8), saddleMat);
    bar.rotation.x = Math.PI / 2;
    bar.position.set(0.31, 0.97, 0);
    bar.castShadow = true;
    group.add(bar);

    const headLamp = new THREE.Mesh(
      new THREE.BoxGeometry(0.06, 0.05, 0.06),
      new THREE.MeshStandardMaterial({ color: 0xfef3c7, emissive: 0xfde68a, emissiveIntensity: 0.7 }),
    );
    headLamp.position.set(0.37, 0.92, 0);
    group.add(headLamp);

    // Seated cyclist rider gripping handlebars & pedaling
    const jerseyMat = new THREE.MeshStandardMaterial({
      color: JERSEY_COLORS[Math.floor(bRand01(2) * JERSEY_COLORS.length)],
      roughness: 0.65,
      metalness: 0.06,
    });
    const shortMat = new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.84, metalness: 0.04 });
    const shoeMat = new THREE.MeshStandardMaterial({ color: 0x111827, roughness: 0.82, metalness: 0.05 });
    const skinMat = new THREE.MeshStandardMaterial({
      color: SKIN_TONES[Math.floor(bRand01(3) * SKIN_TONES.length)],
      roughness: 0.58,
      metalness: 0.02,
    });
    const helmetMat = new THREE.MeshPhysicalMaterial({
      color: HELMET_COLORS[Math.floor(bRand01(4) * HELMET_COLORS.length)],
      roughness: 0.28,
      metalness: 0.2,
      clearcoat: 0.7,
    });

    const pelvis = new THREE.Mesh(new THREE.CapsuleGeometry(0.115, 0.14, 4, 10), shortMat);
    pelvis.rotation.x = Math.PI / 2;
    pelvis.scale.set(0.85, 1, 0.76);
    pelvis.position.set(BIKE_HIP_X, 0.96, 0);
    pelvis.castShadow = true;
    group.add(pelvis);

    const makeBikeLeg = (sideZ: number) => {
      const hip = new THREE.Group();
      hip.position.set(BIKE_HIP_X, BIKE_HIP_Y, sideZ);

      const thigh = new THREE.Mesh(new THREE.CapsuleGeometry(0.058, 0.27, 4, 10), shortMat);
      thigh.position.set(0, -BIKE_THIGH_LEN * 0.5, 0);
      thigh.castShadow = true;
      hip.add(thigh);

      const knee = new THREE.Group();
      knee.position.set(0, -BIKE_THIGH_LEN, 0);

      const shin = new THREE.Mesh(new THREE.CapsuleGeometry(0.046, 0.26, 4, 10), skinMat);
      shin.position.set(0, -BIKE_SHIN_LEN * 0.5, 0);
      shin.castShadow = true;
      knee.add(shin);

      const shoe = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.072, 0.1), shoeMat);
      shoe.position.set(0.04, -BIKE_SHIN_LEN, 0);
      shoe.castShadow = true;
      knee.add(shoe);

      hip.add(knee);
      group.add(hip);
      return { hip, knee };
    };

    const bikeLegL = makeBikeLeg(-0.115);
    const bikeLegR = makeBikeLeg(0.115);

    const riderUpper = new THREE.Group();
    riderUpper.position.set(-0.26, 0.96, 0);
    riderUpper.rotation.z = -0.46;
    group.add(riderUpper);

    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.155, 0.36, 6, 12), jerseyMat);
    torso.scale.set(0.7, 1, 1.04);
    torso.position.set(0, 0.26, 0);
    torso.castShadow = true;
    torso.receiveShadow = true;
    riderUpper.add(torso);

    if (bRand01(5) < 0.45) {
      const pack = new THREE.Mesh(
        new THREE.BoxGeometry(0.13, 0.3, 0.22),
        new THREE.MeshStandardMaterial({ color: 0x334155, roughness: 0.78 }),
      );
      pack.position.set(-0.145, 0.27, 0);
      pack.castShadow = true;
      riderUpper.add(pack);
    }

    const head = new THREE.Group();
    head.position.set(0.02, 0.53, 0);
    head.rotation.z = 0.38;

    const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.044, 0.052, 0.08, 10), skinMat);
    neck.position.set(0, 0.035, 0);
    neck.castShadow = true;
    head.add(neck);

    const skull = new THREE.Mesh(new THREE.SphereGeometry(0.112, 14, 12), skinMat);
    skull.scale.set(0.98, 1.05, 0.94);
    skull.position.set(0.01, 0.14, 0);
    skull.castShadow = true;
    head.add(skull);

    const helmetShell = new THREE.Mesh(
      new THREE.SphereGeometry(0.13, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.56),
      helmetMat,
    );
    helmetShell.scale.set(1.12, 0.96, 0.98);
    helmetShell.position.set(0.01, 0.148, 0);
    helmetShell.rotation.z = -0.14;
    helmetShell.castShadow = true;
    head.add(helmetShell);

    const helmetVisor = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.02, 0.16), shortMat);
    helmetVisor.position.set(0.135, 0.175, 0);
    helmetVisor.rotation.z = -0.22;
    head.add(helmetVisor);

    riderUpper.add(head);

    // Connect shoulders smoothly through elbows onto the handlebar grips
    const addSegmentMesh = (
      parent: THREE.Object3D,
      a: THREE.Vector3,
      b: THREE.Vector3,
      r: number,
      mat: THREE.Material,
    ) => {
      const dir = new THREE.Vector3().subVectors(b, a);
      const len = dir.length();
      const seg = new THREE.Mesh(new THREE.CapsuleGeometry(r, Math.max(0.02, len - r * 1.4), 4, 8), mat);
      seg.position.copy(a).add(b).multiplyScalar(0.5);
      seg.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
      seg.castShadow = true;
      parent.add(seg);
    };

    for (const side of [-1, 1]) {
      const shoulder = new THREE.Vector3(-0.07, 1.33, side * 0.17);
      const elbow = new THREE.Vector3(0.12, 1.13, side * 0.215);
      const grip = new THREE.Vector3(0.31, 0.975, side * 0.21);
      addSegmentMesh(group, shoulder, elbow, 0.046, jerseyMat);
      addSegmentMesh(group, elbow, grip, 0.04, skinMat);
      const hand = new THREE.Mesh(new THREE.SphereGeometry(0.042, 8, 8), saddleMat);
      hand.position.copy(grip);
      hand.castShadow = true;
      group.add(hand);
    }

    const initialPhase = bRand01(6) * Math.PI * 2;
    const bikeRiderRefs: BikeRiderRefs = {
      crankGroup,
      pedalL,
      pedalR,
      legL: bikeLegL.hip,
      kneeL: bikeLegL.knee,
      legR: bikeLegR.hip,
      kneeR: bikeLegR.knee,
      upperBody: riderUpper,
      head,
      pedalPhase: initialPhase,
    };
    poseBikeRiderPedaling(bikeRiderRefs, initialPhase);
    group.userData.bikeRiderRefs = bikeRiderRefs;
  } else if (kind === 'motorcycle') {
    let mHash = 2166136261;
    for (let i = 0; i < id.length; i++) {
      mHash ^= id.charCodeAt(i);
      mHash = Math.imul(mHash, 16777619);
    }
    const mRand01 = (salt: number) => {
      let x = mHash ^ (salt * 0x9e3779b9);
      x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
      x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
      return ((x ^ (x >>> 16)) >>> 0) / 4294967295;
    };

    const MOTO_PAINTS = [0xb91c1c, 0x1d4ed8, 0x0f766e, 0xd97706, 0x475569, 0x7c3aed];
    const JACKET_TONES = [0x18181b, 0x1e293b, 0x3b1d1d, 0x273449, 0x2f3e34, 0x3f3f46];
    const HELMET_TONES = [0xf8fafc, 0x111827, 0xdc2626, 0x0284c7, 0xeab308, 0x64748b];

    const paintMat = new THREE.MeshPhysicalMaterial({
      color: customColor
        ? new THREE.Color(customColor)
        : MOTO_PAINTS[Math.floor(mRand01(1) * MOTO_PAINTS.length)],
      metalness: 0.65,
      roughness: 0.25,
      clearcoat: 0.9,
      clearcoatRoughness: 0.12,
    });
    const tireMat = new THREE.MeshStandardMaterial({ color: 0x16181d, roughness: 0.88, metalness: 0.05 });
    const metalMat = new THREE.MeshStandardMaterial({ color: 0xcbd5e1, roughness: 0.28, metalness: 0.88 });
    const darkTrimMat = new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.72, metalness: 0.18 });

    const motoWheelPivots: THREE.Group[] = [];
    for (const wx of [-0.7, 0.72]) {
      const wheelPivot = new THREE.Group();
      wheelPivot.position.set(wx, 0.34, 0);

      const tire = new THREE.Mesh(new THREE.TorusGeometry(0.26, 0.082, 12, 24), tireMat);
      tire.castShadow = true;
      tire.receiveShadow = true;
      wheelPivot.add(tire);

      const disc = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.1, 14), metalMat);
      disc.rotation.x = Math.PI / 2;
      wheelPivot.add(disc);

      group.add(wheelPivot);
      motoWheelPivots.push(wheelPivot);
    }
    group.userData.wheelPivots = motoWheelPivots;
    group.userData.wheelRadius = 0.34;

    // Engine & chassis core
    const engine = new THREE.Mesh(new THREE.BoxGeometry(0.68, 0.42, 0.36), darkTrimMat);
    engine.position.set(-0.02, 0.44, 0);
    engine.castShadow = true;
    group.add(engine);

    const exhaust = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.055, 0.95, 10), metalMat);
    exhaust.rotation.z = Math.PI / 2 - 0.08;
    exhaust.position.set(-0.36, 0.32, 0.2);
    exhaust.castShadow = true;
    group.add(exhaust);

    // Sculpted tank + saddle + tail
    const tank = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.26, 0.34), paintMat);
    tank.position.set(0.14, 0.78, 0);
    tank.rotation.z = -0.1;
    tank.castShadow = true;
    group.add(tank);

    const seat = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.14, 0.28), darkTrimMat);
    seat.position.set(-0.36, 0.72, 0);
    seat.rotation.z = 0.08;
    seat.castShadow = true;
    group.add(seat);

    // Footpegs for rider boots
    for (const side of [-1, 1]) {
      const peg = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.11, 8), metalMat);
      peg.rotation.x = Math.PI / 2;
      peg.position.set(-0.16, 0.36, side * 0.22);
      group.add(peg);
    }

    // Front forks, fairing & handlebars
    const fork = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.72, 10), metalMat);
    fork.position.set(0.54, 0.64, 0);
    fork.rotation.z = 0.42;
    fork.castShadow = true;
    group.add(fork);

    const fairing = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.32, 0.3), paintMat);
    fairing.position.set(0.52, 0.88, 0);
    fairing.rotation.z = -0.35;
    fairing.castShadow = true;
    group.add(fairing);

    const handlebar = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.68, 8), darkTrimMat);
    handlebar.rotation.x = Math.PI / 2;
    handlebar.position.set(0.38, 1.02, 0);
    handlebar.castShadow = true;
    group.add(handlebar);

    const headlight = new THREE.Mesh(
      new THREE.BoxGeometry(0.08, 0.12, 0.16),
      new THREE.MeshStandardMaterial({ color: 0xfef3c7, emissive: 0xfde68a, emissiveIntensity: 0.75 }),
    );
    headlight.position.set(0.68, 0.86, 0);
    group.add(headlight);

    const taillight = new THREE.Mesh(
      new THREE.BoxGeometry(0.06, 0.08, 0.16),
      new THREE.MeshStandardMaterial({ color: 0x991b1b, emissive: 0xef4444, emissiveIntensity: 0.55 }),
    );
    taillight.position.set(-0.74, 0.72, 0);
    group.add(taillight);

    // Full-gear motorcyclist rider seated on bike gripping bars
    const jacketMat = new THREE.MeshStandardMaterial({
      color: JACKET_TONES[Math.floor(mRand01(2) * JACKET_TONES.length)],
      roughness: 0.55,
      metalness: 0.12,
    });
    const pantsMat = new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.84, metalness: 0.06 });
    const bootMat = new THREE.MeshStandardMaterial({ color: 0x0f172a, roughness: 0.75, metalness: 0.1 });
    const helmetMat = new THREE.MeshPhysicalMaterial({
      color: HELMET_TONES[Math.floor(mRand01(3) * HELMET_TONES.length)],
      roughness: 0.18,
      metalness: 0.35,
      clearcoat: 0.95,
      clearcoatRoughness: 0.08,
    });
    const visorMat = new THREE.MeshStandardMaterial({
      color: 0x090d16,
      metalness: 0.9,
      roughness: 0.06,
    });

    const pelvis = new THREE.Mesh(new THREE.CapsuleGeometry(0.135, 0.16, 4, 10), pantsMat);
    pelvis.rotation.x = Math.PI / 2;
    pelvis.scale.set(0.88, 1, 0.78);
    pelvis.position.set(-0.31, 0.85, 0);
    pelvis.castShadow = true;
    group.add(pelvis);

    const addMotoSegment = (a: THREE.Vector3, b: THREE.Vector3, r: number, mat: THREE.Material) => {
      const dir = new THREE.Vector3().subVectors(b, a);
      const len = dir.length();
      const mesh = new THREE.Mesh(new THREE.CapsuleGeometry(r, Math.max(0.02, len - r * 1.4), 4, 8), mat);
      mesh.position.copy(a).add(b).multiplyScalar(0.5);
      mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
      mesh.castShadow = true;
      group.add(mesh);
    };

    // Legs straddling tank onto footpegs
    for (const side of [-1, 1]) {
      const hip = new THREE.Vector3(-0.3, 0.83, side * 0.135);
      const knee = new THREE.Vector3(0.0, 0.62, side * 0.225);
      const ankle = new THREE.Vector3(-0.16, 0.4, side * 0.215);
      addMotoSegment(hip, knee, 0.068, pantsMat);
      addMotoSegment(knee, ankle, 0.056, pantsMat);
      const boot = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.09, 0.11), bootMat);
      boot.position.set(-0.12, 0.38, side * 0.22);
      boot.castShadow = true;
      group.add(boot);
    }

    const motoUpper = new THREE.Group();
    motoUpper.position.set(-0.31, 0.85, 0);
    motoUpper.rotation.z = -0.34;
    group.add(motoUpper);

    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.17, 0.38, 6, 12), jacketMat);
    torso.scale.set(0.74, 1, 1.08);
    torso.position.set(0, 0.27, 0);
    torso.castShadow = true;
    torso.receiveShadow = true;
    motoUpper.add(torso);

    const motoHead = new THREE.Group();
    motoHead.position.set(0.02, 0.54, 0);
    motoHead.rotation.z = 0.28;

    const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.052, 0.06, 0.07, 10), jacketMat);
    neck.position.set(0, 0.03, 0);
    motoHead.add(neck);

    const helmetShell = new THREE.Mesh(new THREE.SphereGeometry(0.145, 16, 14), helmetMat);
    helmetShell.scale.set(1.12, 1.02, 0.96);
    helmetShell.position.set(0.015, 0.16, 0);
    helmetShell.castShadow = true;
    motoHead.add(helmetShell);

    const chinGuard = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.085, 0.17), helmetMat);
    chinGuard.position.set(0.115, 0.105, 0);
    chinGuard.castShadow = true;
    motoHead.add(chinGuard);

    const visor = new THREE.Mesh(
      new THREE.CylinderGeometry(0.148, 0.148, 0.078, 16, 1, false, Math.PI * 0.16, Math.PI * 0.68),
      visorMat,
    );
    visor.scale.set(1.13, 1, 0.98);
    visor.position.set(0.022, 0.17, 0);
    motoHead.add(visor);

    motoUpper.add(motoHead);

    // Arms reaching handlebar grips cleanly
    for (const side of [-1, 1]) {
      const shoulder = new THREE.Vector3(-0.16, 1.25, side * 0.19);
      const elbow = new THREE.Vector3(0.09, 1.1, side * 0.265);
      const grip = new THREE.Vector3(0.38, 1.02, side * 0.295);
      addMotoSegment(shoulder, elbow, 0.052, jacketMat);
      addMotoSegment(elbow, grip, 0.044, jacketMat);
      const glove = new THREE.Mesh(new THREE.SphereGeometry(0.046, 8, 8), bootMat);
      glove.position.copy(grip);
      glove.castShadow = true;
      group.add(glove);
    }

    const motoRiderRefs: MotoRiderRefs = {
      upperBody: motoUpper,
      head: motoHead,
    };
    group.userData.motoRiderRefs = motoRiderRefs;
  } else if (kind === 'sedan') {
    const paintMat = new THREE.MeshPhysicalMaterial({
      color: customColor ? new THREE.Color(customColor) : new THREE.Color(0x3b526b),
      metalness: 0.72,
      roughness: 0.24,
      clearcoat: 0.9,
      clearcoatRoughness: 0.12,
    });
    const cabinGlassMat = new THREE.MeshStandardMaterial({
      color: 0x0f172a,
      metalness: 0.85,
      roughness: 0.08,
    });
    const tireMat = new THREE.MeshStandardMaterial({ color: 0x16181d, roughness: 0.88, metalness: 0.05 });
    const rimMat = new THREE.MeshStandardMaterial({ color: 0xcbd5e1, roughness: 0.25, metalness: 0.9 });
    const trimMat = new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.7, metalness: 0.15 });

    // Lower chassis extruded side profile
    const carShape = new THREE.Shape();
    carShape.moveTo(-2.15, 0.24);
    carShape.lineTo(2.15, 0.24);
    carShape.lineTo(2.12, 0.68);
    carShape.lineTo(1.35, 0.82);
    carShape.lineTo(0.65, 1.32);
    carShape.lineTo(-0.85, 1.32);
    carShape.lineTo(-1.55, 0.84);
    carShape.lineTo(-2.12, 0.76);
    carShape.closePath();

    const bodyGeo = new THREE.ExtrudeGeometry(carShape, {
      depth: 1.66,
      bevelEnabled: true,
      bevelThickness: 0.08,
      bevelSize: 0.06,
      bevelSegments: 2,
    });
    bodyGeo.translate(0, 0, -0.83);
    const bodyMesh = new THREE.Mesh(bodyGeo, paintMat);
    bodyMesh.castShadow = true;
    bodyMesh.receiveShadow = true;
    group.add(bodyMesh);

    // Greenhouse tinted glass wrap
    const glassMesh = new THREE.Mesh(new THREE.BoxGeometry(1.68, 0.42, 1.54), cabinGlassMat);
    glassMesh.position.set(-0.1, 1.06, 0);
    glassMesh.castShadow = true;
    group.add(glassMesh);

    // Front & rear bumpers
    const frontBumper = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.22, 1.76), trimMat);
    frontBumper.position.set(2.18, 0.34, 0);
    frontBumper.castShadow = true;
    group.add(frontBumper);

    const rearBumper = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.22, 1.76), trimMat);
    rearBumper.position.set(-2.18, 0.34, 0);
    rearBumper.castShadow = true;
    group.add(rearBumper);

    // 4 wheels with alloy rims inside spinning wheel pivots
    const wheelOffsets: [number, number][] = [
      [1.32, 0.82],
      [1.32, -0.82],
      [-1.32, 0.82],
      [-1.32, -0.82],
    ];
    const wheelPivots: THREE.Group[] = [];
    for (const [wx, wz] of wheelOffsets) {
      const wheelPivot = new THREE.Group();
      wheelPivot.position.set(wx, 0.32, wz);

      const tire = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.32, 0.24, 18), tireMat);
      tire.rotation.x = Math.PI / 2;
      tire.castShadow = true;
      tire.receiveShadow = true;
      wheelPivot.add(tire);

      const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 0.25, 8), rimMat);
      hub.rotation.x = Math.PI / 2;
      wheelPivot.add(hub);

      group.add(wheelPivot);
      wheelPivots.push(wheelPivot);
    }
    group.userData.wheelPivots = wheelPivots;
    group.userData.wheelRadius = 0.32;

    // Headlight accents
    const headMat = new THREE.MeshStandardMaterial({
      color: 0xfef9c3,
      emissive: 0xfde68a,
      emissiveIntensity: 0.85,
      roughness: 0.2,
    });
    for (const hz of [-0.62, 0.62]) {
      const headLamp = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.1, 0.28), headMat);
      headLamp.position.set(2.18, 0.56, hz);
      group.add(headLamp);
    }

    // Subtle taillight bar accent
    const tailMat = new THREE.MeshStandardMaterial({
      color: 0x991b1b,
      emissive: 0xef4444,
      emissiveIntensity: 0.55,
      roughness: 0.25,
    });
    const tailBar = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.08, 1.48), tailMat);
    tailBar.position.set(-2.2, 0.66, 0);
    group.add(tailBar);
  } else if (kind === 'van') {
    const paintMat = new THREE.MeshPhysicalMaterial({
      color: customColor ? new THREE.Color(customColor) : 0xcbd5e1,
      metalness: 0.35,
      roughness: 0.32,
      clearcoat: 0.7,
      clearcoatRoughness: 0.18,
    });
    const glassMat = new THREE.MeshStandardMaterial({ color: 0x0f172a, metalness: 0.85, roughness: 0.08 });
    const tireMat = new THREE.MeshStandardMaterial({ color: 0x16181d, roughness: 0.88, metalness: 0.05 });
    const rimMat = new THREE.MeshStandardMaterial({ color: 0x94a3b8, roughness: 0.35, metalness: 0.8 });
    const trimMat = new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.72, metalness: 0.15 });

    // Extruded high-roof delivery van side profile
    const vanShape = new THREE.Shape();
    vanShape.moveTo(-2.5, 0.28);
    vanShape.lineTo(2.52, 0.28);
    vanShape.lineTo(2.52, 0.92);
    vanShape.lineTo(2.05, 1.15);
    vanShape.lineTo(1.38, 2.22);
    vanShape.lineTo(-2.45, 2.28);
    vanShape.lineTo(-2.5, 0.28);
    vanShape.closePath();

    const vanGeo = new THREE.ExtrudeGeometry(vanShape, {
      depth: 1.88,
      bevelEnabled: true,
      bevelThickness: 0.06,
      bevelSize: 0.05,
      bevelSegments: 2,
    });
    vanGeo.translate(0, 0, -0.94);
    const vanBody = new THREE.Mesh(vanGeo, paintMat);
    vanBody.castShadow = true;
    vanBody.receiveShadow = true;
    group.add(vanBody);

    // Front windshield & cab side windows
    const windshield = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.88, 1.72), glassMat);
    windshield.position.set(1.74, 1.65, 0);
    windshield.rotation.z = 0.52;
    group.add(windshield);

    const cabSideGlass = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.62, 1.98), glassMat);
    cabSideGlass.position.set(1.22, 1.68, 0);
    group.add(cabSideGlass);

    // Front & rear bumpers + grille
    const frontBumper = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.26, 1.96), trimMat);
    frontBumper.position.set(2.56, 0.38, 0);
    frontBumper.castShadow = true;
    group.add(frontBumper);

    const rearBumper = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.26, 1.96), trimMat);
    rearBumper.position.set(-2.54, 0.38, 0);
    rearBumper.castShadow = true;
    group.add(rearBumper);

    const vanWheelPivots: THREE.Group[] = [];
    for (const [wx, wz] of [
      [1.56, 0.95],
      [1.56, -0.95],
      [-1.56, 0.95],
      [-1.56, -0.95],
    ] as [number, number][]) {
      const wheelPivot = new THREE.Group();
      wheelPivot.position.set(wx, 0.36, wz);

      const tire = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.36, 0.26, 18), tireMat);
      tire.rotation.x = Math.PI / 2;
      tire.castShadow = true;
      tire.receiveShadow = true;
      wheelPivot.add(tire);

      const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.27, 12), rimMat);
      hub.rotation.x = Math.PI / 2;
      wheelPivot.add(hub);

      group.add(wheelPivot);
      vanWheelPivots.push(wheelPivot);
    }
    group.userData.wheelPivots = vanWheelPivots;
    group.userData.wheelRadius = 0.36;

    const headMat = new THREE.MeshStandardMaterial({
      color: 0xfef3c7,
      emissive: 0xfde68a,
      emissiveIntensity: 0.65,
    });
    for (const hz of [-0.68, 0.68]) {
      const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.16, 0.28), headMat);
      lamp.position.set(2.56, 0.76, hz);
      group.add(lamp);
    }

    const tailMat = new THREE.MeshStandardMaterial({
      color: 0x991b1b,
      emissive: 0xef4444,
      emissiveIntensity: 0.5,
    });
    for (const tz of [-0.76, 0.76]) {
      const tail = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.42, 0.16), tailMat);
      tail.position.set(-2.55, 0.95, tz);
      group.add(tail);
    }
  } else if (kind === 'truck') {
    const cabMat = new THREE.MeshPhysicalMaterial({
      color: customColor ? new THREE.Color(customColor) : 0x2b4c7e,
      metalness: 0.52,
      roughness: 0.3,
      clearcoat: 0.75,
    });
    const cargoMat = new THREE.MeshStandardMaterial({ color: 0xe2e8f0, roughness: 0.6, metalness: 0.18 });
    const frameMat = new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.75, metalness: 0.35 });
    const glassMat = new THREE.MeshStandardMaterial({ color: 0x0f172a, metalness: 0.85, roughness: 0.08 });
    const tireMat = new THREE.MeshStandardMaterial({ color: 0x16181d, roughness: 0.88, metalness: 0.05 });
    const rimMat = new THREE.MeshStandardMaterial({ color: 0xcbd5e1, roughness: 0.3, metalness: 0.85 });

    // Steel chassis rail deck
    const chassis = new THREE.Mesh(new THREE.BoxGeometry(6.6, 0.28, 1.95), frameMat);
    chassis.position.set(-0.05, 0.58, 0);
    chassis.castShadow = true;
    chassis.receiveShadow = true;
    group.add(chassis);

    // Cab-forward truck cab
    const cab = new THREE.Mesh(new THREE.BoxGeometry(1.75, 1.98, 2.08), cabMat);
    cab.position.set(2.42, 1.65, 0);
    cab.castShadow = true;
    cab.receiveShadow = true;
    group.add(cab);

    const windshield = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.78, 1.88), glassMat);
    windshield.position.set(3.28, 2.02, 0);
    group.add(windshield);

    const cabGlassSide = new THREE.Mesh(new THREE.BoxGeometry(0.85, 0.62, 2.12), glassMat);
    cabGlassSide.position.set(2.58, 2.04, 0);
    group.add(cabGlassSide);

    const grille = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.52, 1.38), frameMat);
    grille.position.set(3.31, 1.15, 0);
    group.add(grille);

    const frontBumper = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.28, 2.14), frameMat);
    frontBumper.position.set(3.32, 0.52, 0);
    frontBumper.castShadow = true;
    group.add(frontBumper);

    // Tall aluminum cargo box
    const cargoBox = new THREE.Mesh(new THREE.BoxGeometry(4.75, 2.42, 2.26), cargoMat);
    cargoBox.position.set(-0.98, 1.98, 0);
    cargoBox.castShadow = true;
    cargoBox.receiveShadow = true;
    group.add(cargoBox);

    const cargoRoofTrim = new THREE.Mesh(new THREE.BoxGeometry(4.8, 0.12, 2.3), frameMat);
    cargoRoofTrim.position.set(-0.98, 3.21, 0);
    cargoRoofTrim.castShadow = true;
    group.add(cargoRoofTrim);

    const rearStep = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.24, 2.18), frameMat);
    rearStep.position.set(-3.36, 0.5, 0);
    rearStep.castShadow = true;
    group.add(rearStep);

    const truckWheelPivots: THREE.Group[] = [];
    for (const [wx, wz] of [
      [2.28, 1.04],
      [2.28, -1.04],
      [-1.95, 1.06],
      [-1.95, -1.06],
    ] as [number, number][]) {
      const wheelPivot = new THREE.Group();
      wheelPivot.position.set(wx, 0.44, wz);

      const tire = new THREE.Mesh(new THREE.CylinderGeometry(0.44, 0.44, 0.32, 20), tireMat);
      tire.rotation.x = Math.PI / 2;
      tire.castShadow = true;
      tire.receiveShadow = true;
      wheelPivot.add(tire);

      const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.24, 0.33, 12), rimMat);
      hub.rotation.x = Math.PI / 2;
      wheelPivot.add(hub);

      group.add(wheelPivot);
      truckWheelPivots.push(wheelPivot);
    }
    group.userData.wheelPivots = truckWheelPivots;
    group.userData.wheelRadius = 0.44;

    const headMat = new THREE.MeshStandardMaterial({
      color: 0xfef3c7,
      emissive: 0xfde68a,
      emissiveIntensity: 0.7,
    });
    for (const hz of [-0.76, 0.76]) {
      const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.16, 0.28), headMat);
      lamp.position.set(3.32, 0.88, hz);
      group.add(lamp);
    }

    const tailMat = new THREE.MeshStandardMaterial({
      color: 0x991b1b,
      emissive: 0xef4444,
      emissiveIntensity: 0.55,
    });
    for (const tz of [-0.88, 0.88]) {
      const tail = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.16, 0.34), tailMat);
      tail.position.set(-3.38, 0.68, tz);
      group.add(tail);
    }
  } else if (kind === 'bus') {
    const bodyMat = new THREE.MeshPhysicalMaterial({
      color: 0x1e40af,
      metalness: 0.45,
      roughness: 0.32,
      clearcoat: 0.75,
    });
    const stripeMat = new THREE.MeshStandardMaterial({ color: 0xf59e0b, roughness: 0.4, metalness: 0.15 });
    const roofMat = new THREE.MeshStandardMaterial({ color: 0xdbeafe, roughness: 0.6, metalness: 0.12 });
    const glassMat = new THREE.MeshStandardMaterial({ color: 0x0b1526, metalness: 0.88, roughness: 0.08 });
    const trimMat = new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.72, metalness: 0.2 });
    const tireMat = new THREE.MeshStandardMaterial({ color: 0x16181d, roughness: 0.88, metalness: 0.05 });
    const rimMat = new THREE.MeshStandardMaterial({ color: 0xcbd5e1, roughness: 0.3, metalness: 0.85 });

    // Lower chassis body
    const lowerBody = new THREE.Mesh(new THREE.BoxGeometry(9.1, 1.15, 2.38), bodyMat);
    lowerBody.position.set(0, 0.94, 0);
    lowerBody.castShadow = true;
    lowerBody.receiveShadow = true;
    group.add(lowerBody);

    // Amber transit belt stripe
    const belt = new THREE.Mesh(new THREE.BoxGeometry(9.14, 0.12, 2.41), stripeMat);
    belt.position.set(0, 1.46, 0);
    group.add(belt);

    // Upper passenger cabin & dark continuous window ribbon
    const upperCabin = new THREE.Mesh(new THREE.BoxGeometry(8.98, 1.24, 2.34), glassMat);
    upperCabin.position.set(-0.04, 2.12, 0);
    upperCabin.castShadow = true;
    group.add(upperCabin);

    // Window mullions along sides
    for (let mx = -3.8; mx <= 3.6; mx += 1.25) {
      const pillar = new THREE.Mesh(new THREE.BoxGeometry(0.14, 1.24, 2.38), trimMat);
      pillar.position.set(mx, 2.12, 0);
      pillar.castShadow = true;
      group.add(pillar);
    }

    // Roof cap + twin HVAC pods
    const roof = new THREE.Mesh(new THREE.BoxGeometry(9.08, 0.22, 2.36), roofMat);
    roof.position.set(0, 2.84, 0);
    roof.castShadow = true;
    roof.receiveShadow = true;
    group.add(roof);

    for (const ax of [-1.8, 1.6]) {
      const hvac = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.26, 1.38), trimMat);
      hvac.position.set(ax, 3.06, 0);
      hvac.castShadow = true;
      group.add(hvac);
    }

    // Bumpers & LED route header
    const frontBumper = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.28, 2.42), trimMat);
    frontBumper.position.set(4.58, 0.44, 0);
    frontBumper.castShadow = true;
    group.add(frontBumper);

    const rearBumper = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.28, 2.42), trimMat);
    rearBumper.position.set(-4.58, 0.44, 0);
    rearBumper.castShadow = true;
    group.add(rearBumper);

    const routeSign = new THREE.Mesh(
      new THREE.BoxGeometry(0.06, 0.2, 1.45),
      new THREE.MeshStandardMaterial({ color: 0xf59e0b, emissive: 0xf59e0b, emissiveIntensity: 0.7 }),
    );
    routeSign.position.set(4.54, 2.66, 0);
    group.add(routeSign);

    const busWheelPivots: THREE.Group[] = [];
    for (const [wx, wz] of [
      [2.85, 1.12],
      [2.85, -1.12],
      [-2.75, 1.12],
      [-2.75, -1.12],
    ] as [number, number][]) {
      const wheelPivot = new THREE.Group();
      wheelPivot.position.set(wx, 0.45, wz);

      const tire = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.45, 0.32, 20), tireMat);
      tire.rotation.x = Math.PI / 2;
      tire.castShadow = true;
      tire.receiveShadow = true;
      wheelPivot.add(tire);

      const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.24, 0.33, 12), rimMat);
      hub.rotation.x = Math.PI / 2;
      wheelPivot.add(hub);

      group.add(wheelPivot);
      busWheelPivots.push(wheelPivot);
    }
    group.userData.wheelPivots = busWheelPivots;
    group.userData.wheelRadius = 0.45;

    const headMat = new THREE.MeshStandardMaterial({
      color: 0xfef3c7,
      emissive: 0xfde68a,
      emissiveIntensity: 0.7,
    });
    for (const hz of [-0.85, 0.85]) {
      const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.16, 0.34), headMat);
      lamp.position.set(4.56, 0.74, hz);
      group.add(lamp);
    }

    const tailMat = new THREE.MeshStandardMaterial({
      color: 0x991b1b,
      emissive: 0xef4444,
      emissiveIntensity: 0.55,
    });
    for (const tz of [-0.94, 0.94]) {
      const tail = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.48, 0.18), tailMat);
      tail.position.set(-4.56, 0.96, tz);
      group.add(tail);
    }
  } else if (kind === 'pedestrian') {
    // Deterministic per-person appearance hash so each pedestrian keeps consistent build, skin, hair, trousers & accessories
    let hash = 2166136261;
    for (let i = 0; i < id.length; i++) {
      hash ^= id.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    const rand01 = (salt: number) => {
      let x = hash ^ (salt * 0x9e3779b9);
      x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
      x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
      return ((x ^ (x >>> 16)) >>> 0) / 4294967295;
    };

    const SKIN_TONES = [0xf2cbb0, 0xe2b290, 0xd49c79, 0xb87d59, 0x8d583b, 0x613a26];
    const TROUSER_TONES = [0x1e293b, 0x334155, 0x273449, 0x3f3f46, 0x57534e, 0x6b5b45, 0x2f3e34];
    const HAIR_TONES = [0x171412, 0x2e1e14, 0x4a2e1b, 0x6e4226, 0x9c7440, 0x8c8c94];
    const SHOE_TONES = [0x111827, 0x1e293b, 0x3b2f2f, 0x475569];
    const BAG_TONES = [0x1e293b, 0x374151, 0x475569, 0x7c2d12, 0x1e3a5f];

    const skinColor = SKIN_TONES[Math.floor(rand01(1) * SKIN_TONES.length)];
    const trouserColor = TROUSER_TONES[Math.floor(rand01(2) * TROUSER_TONES.length)];
    const hairColor = HAIR_TONES[Math.floor(rand01(3) * HAIR_TONES.length)];
    const shoeColor = SHOE_TONES[Math.floor(rand01(4) * SHOE_TONES.length)];
    const bagColor = BAG_TONES[Math.floor(rand01(5) * BAG_TONES.length)];
    const heightScale = 0.93 + rand01(6) * 0.14;
    const widthScale = 0.94 + rand01(7) * 0.12;
    const hasBackpack = rand01(8) < 0.36;
    const hasCap = rand01(9) < 0.22;

    const shoeMat = new THREE.MeshStandardMaterial({ color: shoeColor, roughness: 0.85, metalness: 0.05 });
    const trouserMat = new THREE.MeshStandardMaterial({ color: trouserColor, roughness: 0.84, metalness: 0.04 });
    const jacketMat = new THREE.MeshStandardMaterial({
      color: customColor ? new THREE.Color(customColor) : 0xc26d38,
      roughness: 0.65,
      metalness: 0.06,
    });
    const skinMat = new THREE.MeshStandardMaterial({ color: skinColor, roughness: 0.58, metalness: 0.02 });
    const hairMat = new THREE.MeshStandardMaterial({ color: hairColor, roughness: 0.82, metalness: 0.04 });

    const bodyRoot = new THREE.Group();
    bodyRoot.scale.set(widthScale, heightScale, widthScale);
    group.add(bodyRoot);

    // Articulated leg hip + knee pivots (hip at y = 0.80, knee at -0.38, shoe sole at y = 0)
    const makeLegRig = (sideX: number) => {
      const hip = new THREE.Group();
      hip.position.set(sideX, 0.8, 0);

      const thigh = new THREE.Mesh(new THREE.CapsuleGeometry(0.068, 0.28, 4, 10), trouserMat);
      thigh.position.set(0, -0.19, 0);
      thigh.castShadow = true;
      thigh.receiveShadow = true;
      hip.add(thigh);

      const knee = new THREE.Group();
      knee.position.set(0, -0.38, 0);

      const shin = new THREE.Mesh(new THREE.CapsuleGeometry(0.055, 0.28, 4, 10), trouserMat);
      shin.position.set(0, -0.19, 0);
      shin.castShadow = true;
      shin.receiveShadow = true;
      knee.add(shin);

      const shoe = new THREE.Mesh(new THREE.BoxGeometry(0.115, 0.075, 0.22), shoeMat);
      shoe.position.set(0, -0.382, 0.032);
      shoe.castShadow = true;
      knee.add(shoe);

      hip.add(knee);
      bodyRoot.add(hip);
      return { hip, knee };
    };

    const leftLeg = makeLegRig(-0.105);
    const rightLeg = makeLegRig(0.105);

    const upperBody = new THREE.Group();
    bodyRoot.add(upperBody);

    // Subtle pelvis bridge so hip joint gap is filled cleanly
    const hips = new THREE.Mesh(new THREE.CapsuleGeometry(0.145, 0.14, 4, 10), trouserMat);
    hips.rotation.z = Math.PI / 2;
    hips.scale.set(0.82, 1, 0.72);
    hips.position.set(0, 0.83, 0);
    hips.castShadow = true;
    upperBody.add(hips);

    // Torso jacket
    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.175, 0.44, 6, 12), jacketMat);
    torso.scale.set(1.08, 1, 0.66);
    torso.position.set(0, 1.14, 0);
    torso.castShadow = true;
    torso.receiveShadow = true;
    upperBody.add(torso);

    // Optional casual backpack
    if (hasBackpack) {
      const bagMat = new THREE.MeshStandardMaterial({ color: bagColor, roughness: 0.78, metalness: 0.06 });
      const pack = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.34, 0.13), bagMat);
      pack.position.set(0, 1.15, -0.15);
      pack.castShadow = true;
      pack.receiveShadow = true;
      upperBody.add(pack);
    }

    // Articulated shoulder + elbow + hand pivots
    const makeArmRig = (sideX: number) => {
      const shoulder = new THREE.Group();
      shoulder.position.set(sideX, 1.32, 0);
      shoulder.rotation.z = sideX < 0 ? 0.08 : -0.08;

      const upperArm = new THREE.Mesh(new THREE.CapsuleGeometry(0.052, 0.16, 4, 8), jacketMat);
      upperArm.position.set(0, -0.12, 0);
      upperArm.castShadow = true;
      shoulder.add(upperArm);

      const elbow = new THREE.Group();
      elbow.position.set(0, -0.23, 0);

      const forearm = new THREE.Mesh(new THREE.CapsuleGeometry(0.044, 0.16, 4, 8), jacketMat);
      forearm.position.set(0, -0.11, 0);
      forearm.castShadow = true;
      elbow.add(forearm);

      const hand = new THREE.Mesh(new THREE.SphereGeometry(0.042, 8, 8), skinMat);
      hand.position.set(0, -0.23, 0);
      hand.castShadow = true;
      elbow.add(hand);

      shoulder.add(elbow);
      upperBody.add(shoulder);
      return { shoulder, elbow };
    };

    const leftArm = makeArmRig(-0.255);
    const rightArm = makeArmRig(0.255);

    // Neck + pivoting head group + hair/cap
    const head = new THREE.Group();
    head.position.set(0, 1.46, 0);

    const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.048, 0.056, 0.09, 10), skinMat);
    neck.position.set(0, 0.04, 0);
    neck.castShadow = true;
    head.add(neck);

    const skull = new THREE.Mesh(new THREE.SphereGeometry(0.12, 16, 14), skinMat);
    skull.scale.set(0.94, 1.06, 0.98);
    skull.position.set(0, 0.155, 0);
    skull.castShadow = true;
    skull.receiveShadow = true;
    head.add(skull);

    if (hasCap) {
      const capMat = new THREE.MeshStandardMaterial({ color: bagColor, roughness: 0.72, metalness: 0.05 });
      const crown = new THREE.Mesh(
        new THREE.SphereGeometry(0.126, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.52),
        capMat,
      );
      crown.position.set(0, 0.162, 0);
      crown.rotation.x = -0.14;
      crown.castShadow = true;
      head.add(crown);

      const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.125, 0.018, 12, 1, false, -0.9, 1.8), capMat);
      brim.position.set(0, 0.185, 0.075);
      brim.rotation.x = 0.15;
      brim.castShadow = true;
      head.add(brim);
    } else {
      const hairCap = new THREE.Mesh(
        new THREE.SphereGeometry(0.125, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.58),
        hairMat,
      );
      hairCap.scale.set(0.96, 1.06, 1.02);
      hairCap.position.set(0, 0.16, -0.01);
      hairCap.rotation.x = -0.3;
      hairCap.castShadow = true;
      head.add(hairCap);
    }

    upperBody.add(head);

    const pedRefs: PedestrianRigRefs = {
      legL: leftLeg.hip,
      legR: rightLeg.hip,
      kneeL: leftLeg.knee,
      kneeR: rightLeg.knee,
      armL: leftArm.shoulder,
      armR: rightArm.shoulder,
      elbowL: leftArm.elbow,
      elbowR: rightArm.elbow,
      upperBody,
      head,
      heightScale,
    };
    group.userData.pedestrianRefs = pedRefs;
  } else if (kind === 'bollard') {
    const ironMat = getSharedStdMat('bollard:iron', { color: 0x334155, metalness: 0.72, roughness: 0.36 });
    const stripeMat = getSharedStdMat('bollard:stripe', {
      color: 0xf59e0b,
      roughness: 0.28,
      metalness: 0.2,
    });

    const base = new THREE.Mesh(getSharedCylinderGeo(0.18, 0.22, 0.08, 16), ironMat);
    base.position.y = 0.04;
    base.castShadow = true;
    base.receiveShadow = true;
    group.add(base);

    const shaft = new THREE.Mesh(getSharedCylinderGeo(0.11, 0.12, 0.84, 16), ironMat);
    shaft.position.y = 0.5;
    shaft.castShadow = true;
    shaft.receiveShadow = true;
    group.add(shaft);

    const reflector = new THREE.Mesh(getSharedCylinderGeo(0.116, 0.116, 0.12, 16), stripeMat);
    reflector.position.y = 0.78;
    group.add(reflector);

    const dome = new THREE.Mesh(
      sharedGeo('bollard:dome', () => new THREE.SphereGeometry(0.11, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2)),
      ironMat,
    );
    dome.position.y = 0.92;
    dome.castShadow = true;
    group.add(dome);
  } else if (kind === 'crate') {
    // Ribbed industrial utility crate (1.2m x 1.1m x 1.2m)
    const bodyMat = getSharedStdMat('crate:body', { color: 0x4b5563, roughness: 0.76, metalness: 0.12 });
    const frameMat = getSharedStdMat('crate:frame', { color: 0x1f2937, roughness: 0.42, metalness: 0.72 });
    const hazardMat = getSharedStdMat('crate:hazard', { color: 0xd97706, roughness: 0.45, metalness: 0.15 });

    const core = new THREE.Mesh(getSharedBoxGeo(1.14, 1.06, 1.14), bodyMat);
    core.position.y = 0.55;
    core.castShadow = true;
    core.receiveShadow = true;
    group.add(core);

    const topCap = new THREE.Mesh(getSharedBoxGeo(1.24, 0.08, 1.24), frameMat);
    topCap.position.y = 1.1;
    topCap.castShadow = true;
    group.add(topCap);

    const baseSkid = new THREE.Mesh(getSharedBoxGeo(1.24, 0.06, 1.24), frameMat);
    baseSkid.position.y = 0.03;
    baseSkid.castShadow = true;
    group.add(baseSkid);

    const hazardBand = new THREE.Mesh(getSharedBoxGeo(1.18, 0.09, 1.18), hazardMat);
    hazardBand.position.y = 0.84;
    group.add(hazardBand);
  } else if (kind === 'traffic-light') {
    // Sleek black 4-pole intersection traffic signal system:
    // 4 corner vertical poles (SE, SW, NW, NE), each connecting to 1 horizontal cantilever bar
    const blackPoleMat = getSharedStdMat('tl:blackPole', {
      color: 0x11151c,
      metalness: 0.44,
      roughness: 0.44,
    });
    const collarMat = getSharedStdMat('tl:blackCollar', {
      color: 0x1d232e,
      metalness: 0.56,
      roughness: 0.34,
    });
    const housingMat = getSharedStdMat('tl:housing', {
      color: 0x090c11,
      metalness: 0.3,
      roughness: 0.62,
    });
    const frameMat = getSharedStdMat('tl:blackFrame', {
      color: 0x161b24,
      metalness: 0.34,
      roughness: 0.48,
    });
    const visorMat = getSharedStdMat('tl:visor', {
      color: 0x0b0e14,
      metalness: 0.25,
      roughness: 0.72,
    });

    const createCountdownMat = () => {
      const initTex = getTrafficCountdownTexture('red', 8);
      const mat = new THREE.MeshStandardMaterial({
        map: initTex,
        emissiveMap: initTex,
        color: 0xffffff,
        emissive: 0xffffff,
        emissiveIntensity: 1.9,
        roughness: 0.25,
        metalness: 0.05,
      });
      mat.userData.skipLuxOverlay = true;
      return mat;
    };

    const signalMaterials: TrafficSignalMaterials = {
      axisZ: { red: [], yellow: [], green: [], countdown: createCountdownMat() },
      axisX: { red: [], yellow: [], green: [], countdown: createCountdownMat() },
    };

    const basePlateGeo = getSharedBoxGeo(0.54, 0.07, 0.54);
    const pedestalGeo = getSharedCylinderGeo(0.17, 0.22, 0.56, 12);
    const mastGeo = getSharedCylinderGeo(0.11, 0.15, 5.45, 14);
    const finialGeo = sharedGeo('tl:finial', () => new THREE.SphereGeometry(0.125, 12, 8));
    const topStubGeo = getSharedCylinderGeo(0.026, 0.034, 0.85, 8);
    const armGeo = getSharedCylinderGeo(0.068, 0.095, 8.6, 12);
    const clampGeo = getSharedCylinderGeo(0.16, 0.16, 0.24, 12);

    const headBoxGeo = getSharedBoxGeo(0.36, 1.0, 0.28);
    const headFrameGeo = getSharedBoxGeo(0.45, 1.09, 0.05);
    const hangerGeo = getSharedCylinderGeo(0.022, 0.022, 0.28, 6);
    const lensDiscGeo = sharedGeo('tl:lensDisc', () => new THREE.CircleGeometry(0.112, 24));
    const visorGeo = getSharedCylinderGeo(0.122, 0.122, 0.15, 14, true, -Math.PI * 0.45, Math.PI * 0.9);
    const cdBoxGeo = getSharedBoxGeo(0.46, 0.42, 0.24);
    const cdFrameGeo = getSharedBoxGeo(0.54, 0.5, 0.05);
    const cdScreenGeo = getSharedPlaneGeo(0.4, 0.36);

    const addSignalHead = (
      parent: THREE.Group,
      px: number,
      py: number,
      pz: number,
      targetBucket: TrafficSignalLensMaterials,
      arrow: 'left' | 'up' | 'right',
      scale = 1.0,
      doubleSided = true,
      attachToBar = true,
    ) => {
      const head = new THREE.Group();
      head.position.set(px, py, pz);
      head.scale.setScalar(scale);

      const box = new THREE.Mesh(headBoxGeo, housingMat);
      box.castShadow = true;
      head.add(box);

      const borderFrame = new THREE.Mesh(headFrameGeo, frameMat);
      head.add(borderFrame);

      if (attachToBar) {
        const strutL = new THREE.Mesh(hangerGeo, collarMat);
        strutL.position.set(-0.08, 0.54, 0);
        head.add(strutL);
        const strutR = new THREE.Mesh(hangerGeo, collarMat);
        strutR.position.set(0.08, 0.54, 0);
        head.add(strutR);
      }

      const arrowTex = getTrafficArrowTexture(arrow);
      const redMat = new THREE.MeshStandardMaterial({
        map: arrowTex,
        emissiveMap: arrowTex,
        color: 0x7f1d1d,
        emissive: 0xff2d20,
        emissiveIntensity: 0.08,
        roughness: 0.22,
      });
      redMat.userData.skipLuxOverlay = true;
      const yellowMat = new THREE.MeshStandardMaterial({
        map: arrowTex,
        emissiveMap: arrowTex,
        color: 0x78350f,
        emissive: 0xf59e0b,
        emissiveIntensity: 0.08,
        roughness: 0.22,
      });
      yellowMat.userData.skipLuxOverlay = true;
      const greenMat = new THREE.MeshStandardMaterial({
        map: arrowTex,
        emissiveMap: arrowTex,
        color: 0x14532d,
        emissive: 0x22c55e,
        emissiveIntensity: 0.08,
        roughness: 0.22,
      });
      greenMat.userData.skipLuxOverlay = true;

      targetBucket.red.push(redMat);
      targetBucket.yellow.push(yellowMat);
      targetBucket.green.push(greenMat);

      const lensSpecs: Array<[number, THREE.MeshStandardMaterial]> = [
        [0.3, redMat],
        [0.0, yellowMat],
        [-0.3, greenMat],
      ];

      const s = -1; // Single-sided facing into the intersection (-Z local) toward approaching drivers
      for (const [ly, lMat] of lensSpecs) {
        const lens = new THREE.Mesh(lensDiscGeo, lMat);
        lens.rotation.y = Math.PI;
        lens.position.set(0, ly, s * 0.145);
        head.add(lens);

        const visor = new THREE.Mesh(visorGeo, visorMat);
        visor.rotation.x = -Math.PI / 2;
        visor.rotation.z = Math.PI;
        visor.position.set(0, ly + 0.015, s * 0.21);
        head.add(visor);
      }

      parent.add(head);
    };

    const addCountdownBox = (
      parent: THREE.Group,
      px: number,
      py: number,
      pz: number,
      cdMat: THREE.MeshStandardMaterial,
    ) => {
      const cd = new THREE.Group();
      cd.position.set(px, py, pz);

      const box = new THREE.Mesh(cdBoxGeo, housingMat);
      box.castShadow = true;
      cd.add(box);

      const borderFrame = new THREE.Mesh(cdFrameGeo, frameMat);
      cd.add(borderFrame);

      const screen = new THREE.Mesh(cdScreenGeo, cdMat);
      screen.rotation.y = Math.PI;
      screen.position.z = -0.125;
      cd.add(screen);

      parent.add(cd);
    };

    // 4 intersection corners: SE (0,0), SW (-10.2,0), NW (-10.2,-10.2), NE (0,-10.2)
    // Each pole connects to 1 single horizontal black cantilever bar over its approach roadway
    const cornerSpecs: Array<{
      x: number;
      z: number;
      rotY: number;
      bucket: TrafficSignalLensMaterials;
    }> = [
      { x: 0, z: 0, rotY: 0, bucket: signalMaterials.axisZ },
      { x: -10.2, z: 0, rotY: -Math.PI / 2, bucket: signalMaterials.axisX },
      { x: -10.2, z: -10.2, rotY: Math.PI, bucket: signalMaterials.axisZ },
      { x: 0, z: -10.2, rotY: Math.PI / 2, bucket: signalMaterials.axisX },
    ];

    for (const corner of cornerSpecs) {
      const rig = new THREE.Group();
      rig.position.set(corner.x, 0, corner.z);
      rig.rotation.y = corner.rotY;

      const basePlate = new THREE.Mesh(basePlateGeo, collarMat);
      basePlate.position.y = 0.035;
      basePlate.castShadow = true;
      basePlate.receiveShadow = true;
      rig.add(basePlate);

      const pedestal = new THREE.Mesh(pedestalGeo, blackPoleMat);
      pedestal.position.y = 0.35;
      pedestal.castShadow = true;
      rig.add(pedestal);

      const mast = new THREE.Mesh(mastGeo, blackPoleMat);
      mast.position.y = 3.35;
      mast.castShadow = true;
      mast.receiveShadow = true;
      rig.add(mast);

      const finial = new THREE.Mesh(finialGeo, collarMat);
      finial.position.y = 6.1;
      rig.add(finial);

      const topStub = new THREE.Mesh(topStubGeo, blackPoleMat);
      topStub.position.set(-0.36, 5.94, 0);
      topStub.rotation.z = Math.PI * 0.42;
      rig.add(topStub);

      const clamp = new THREE.Mesh(clampGeo, collarMat);
      clamp.position.y = 5.42;
      rig.add(clamp);

      const armBar = new THREE.Mesh(armGeo, blackPoleMat);
      armBar.rotation.z = Math.PI / 2;
      armBar.position.set(-4.3, 5.42, 0);
      armBar.castShadow = true;
      rig.add(armBar);

      // 4 single-sided black arrow heads + central digital countdown facing approaching drivers
      // From approaching driver's left to right: Left <- | Up | Countdown | Up | Right ->
      addSignalHead(rig, -1.95, 4.9, 0, corner.bucket, 'left', 1.0, false, true);
      addSignalHead(rig, -3.4, 4.9, 0, corner.bucket, 'up', 1.0, false, true);
      addCountdownBox(rig, -4.75, 5.42, 0, corner.bucket.countdown);
      addSignalHead(rig, -6.1, 4.9, 0, corner.bucket, 'up', 1.0, false, true);
      addSignalHead(rig, -7.8, 4.9, 0, corner.bucket, 'right', 1.0, false, true);

      // Secondary lower post-mounted head (single-sided facing approaching drivers)
      addSignalHead(rig, 0, 2.9, -0.24, corner.bucket, 'up', 0.82, false, false);

      group.add(rig);
    }

    group.userData.trafficSignalMaterials = signalMaterials;
  } else if (
    kind === 'building-kiosk' ||
    kind === 'building-small' ||
    kind === 'building-tall' ||
    kind === 'building-highrise' ||
    kind === 'building-rowhouse' ||
    kind === 'building-commercial' ||
    kind === 'building-warehouse' ||
    kind === 'building-civic' ||
    kind === 'building-apartments' ||
    kind === 'building-skyscraper'
  ) {
    type DoorStyle = 'wood' | 'glass-metal' | 'steel' | 'civic-bronze' | 'artdeco';
    const addBuildingDoor = (
      parent: THREE.Group,
      opts: {
        x: number;
        y: number;
        z: number;
        rotY?: number;
        width: number;
        height: number;
        style: DoorStyle;
        doubleLeaf?: boolean;
        hasCanopy?: boolean;
        hasStep?: boolean;
        leafColorHex?: number;
      },
    ) => {
      const doorGrp = new THREE.Group();
      doorGrp.position.set(opts.x, opts.y, opts.z);
      if (opts.rotY) doorGrp.rotation.y = opts.rotY;

      const w = opts.width;
      const h = opts.height;
      const fThick = opts.style === 'artdeco' || opts.style === 'civic-bronze' ? 0.11 : 0.08;
      const fDepth = 0.12;

      const frameMat =
        opts.style === 'civic-bronze' || opts.style === 'artdeco'
          ? getSharedStdMat('bdoor:frameBronze', { color: 0x4b3d2b, roughness: 0.42, metalness: 0.65 })
          : opts.style === 'wood'
            ? getSharedStdMat('bdoor:frameStone', { color: 0x2f343d, roughness: 0.72, metalness: 0.15 })
            : getSharedStdMat('bdoor:frameDark', { color: 0x161d29, roughness: 0.44, metalness: 0.58 });

      const hardwareMat =
        opts.style === 'wood' || opts.style === 'civic-bronze' || opts.style === 'artdeco'
          ? getSharedStdMat('bdoor:brass', { color: 0xd4a853, roughness: 0.24, metalness: 0.88 })
          : getSharedStdMat('bdoor:chrome', { color: 0xcbd5e1, roughness: 0.22, metalness: 0.9 });

      const glassMatDoor = getSharedStdMat(`bdoor:glass:${opts.style}`, {
        color: 0x0e1a2b,
        emissive: opts.style === 'steel' ? 0xfef3c7 : 0xfde68a,
        emissiveIntensity: opts.style === 'steel' ? 0.12 : 0.28,
        roughness: 0.09,
        metalness: 0.86,
      });

      const leafHex =
        opts.leafColorHex ??
        (opts.style === 'wood'
          ? 0x5c3624
          : opts.style === 'steel'
            ? 0x3b4859
            : opts.style === 'civic-bronze'
              ? 0x5a4632
              : 0x1e293b);
      const leafMat = getSharedStdMat(`bdoor:leaf:${opts.style}:${leafHex}`, {
        color: leafHex,
        roughness: opts.style === 'wood' ? 0.62 : 0.46,
        metalness: opts.style === 'wood' ? 0.05 : opts.style === 'glass-metal' ? 0.55 : 0.38,
      });

      // Left, right & top frame jambs
      const jambGeo = getSharedBoxGeo(fThick, h, fDepth);
      const jambL = new THREE.Mesh(jambGeo, frameMat);
      jambL.position.set(-w * 0.5 + fThick * 0.5, h * 0.5, fDepth * 0.5 - 0.02);
      jambL.castShadow = true;
      doorGrp.add(jambL);

      const jambR = new THREE.Mesh(jambGeo, frameMat);
      jambR.position.set(w * 0.5 - fThick * 0.5, h * 0.5, fDepth * 0.5 - 0.02);
      jambR.castShadow = true;
      doorGrp.add(jambR);

      const header = new THREE.Mesh(getSharedBoxGeo(w + 0.08, fThick * 1.15, fDepth + 0.03), frameMat);
      header.position.set(0, h - fThick * 0.5, fDepth * 0.5 - 0.01);
      header.castShadow = true;
      doorGrp.add(header);

      const innerW = Math.max(0.45, w - fThick * 2);
      const innerH = Math.max(1.2, h - fThick);

      if (opts.style === 'glass-metal' || opts.style === 'artdeco' || opts.style === 'civic-bronze') {
        const hasTransom = innerH >= 2.25;
        const transomH = hasTransom ? innerH * 0.22 : 0;
        const leafH = innerH - transomH;

        if (hasTransom) {
          const transomGlass = new THREE.Mesh(
            getSharedBoxGeo(innerW, transomH - 0.04, 0.04),
            glassMatDoor,
          );
          transomGlass.position.set(0, leafH + transomH * 0.5, 0.04);
          doorGrp.add(transomGlass);

          const transomBar = new THREE.Mesh(
            getSharedBoxGeo(innerW + 0.04, 0.06, fDepth),
            frameMat,
          );
          transomBar.position.set(0, leafH, fDepth * 0.5 - 0.02);
          doorGrp.add(transomBar);
        }

        // Glazed door leaves with bottom kickplate
        const glassBackdrop = new THREE.Mesh(
          getSharedBoxGeo(innerW, leafH, 0.04),
          glassMatDoor,
        );
        glassBackdrop.position.set(0, leafH * 0.5, 0.035);
        doorGrp.add(glassBackdrop);

        const kickH = Math.min(0.32, leafH * 0.16);
        const kickPlate = new THREE.Mesh(
          getSharedBoxGeo(innerW, kickH, 0.065),
          leafMat,
        );
        kickPlate.position.set(0, kickH * 0.5, 0.05);
        doorGrp.add(kickPlate);

        if (opts.doubleLeaf) {
          const mullion = new THREE.Mesh(
            getSharedBoxGeo(0.065, leafH, 0.07),
            frameMat,
          );
          mullion.position.set(0, leafH * 0.5, 0.05);
          doorGrp.add(mullion);

          const barGeo = getSharedBoxGeo(0.035, 0.42, 0.04);
          for (const hx of [-0.14, 0.14]) {
            const handle = new THREE.Mesh(barGeo, hardwareMat);
            handle.position.set(hx, Math.min(1.06, leafH * 0.52), 0.095);
            doorGrp.add(handle);
          }
        } else {
          const pushBar = new THREE.Mesh(
            getSharedBoxGeo(innerW * 0.72, 0.04, 0.04),
            hardwareMat,
          );
          pushBar.position.set(0, Math.min(1.02, leafH * 0.48), 0.09);
          doorGrp.add(pushBar);
        }
      } else if (opts.style === 'wood') {
        const panel = new THREE.Mesh(getSharedBoxGeo(innerW, innerH, 0.065), leafMat);
        panel.position.set(0, innerH * 0.5, 0.04);
        doorGrp.add(panel);

        // Recessed upper glass pane in wood door
        const upperGlass = new THREE.Mesh(
          getSharedBoxGeo(innerW * 0.62, innerH * 0.34, 0.075),
          glassMatDoor,
        );
        upperGlass.position.set(0, innerH * 0.68, 0.045);
        doorGrp.add(upperGlass);

        // Brass doorknob
        const knob = new THREE.Mesh(getSharedBoxGeo(0.065, 0.065, 0.065), hardwareMat);
        knob.position.set(innerW * 0.34, Math.min(0.98, innerH * 0.48), 0.09);
        doorGrp.add(knob);
      } else {
        // Steel utility/service door with safety vision pane & panic bar
        const panel = new THREE.Mesh(getSharedBoxGeo(innerW, innerH, 0.065), leafMat);
        panel.position.set(0, innerH * 0.5, 0.04);
        doorGrp.add(panel);

        const vision = new THREE.Mesh(
          getSharedBoxGeo(innerW * 0.36, innerH * 0.24, 0.075),
          glassMatDoor,
        );
        vision.position.set(0, innerH * 0.72, 0.045);
        doorGrp.add(vision);

        const panicBar = new THREE.Mesh(
          getSharedBoxGeo(innerW * 0.76, 0.05, 0.04),
          hardwareMat,
        );
        panicBar.position.set(0, Math.min(1.02, innerH * 0.48), 0.09);
        doorGrp.add(panicBar);
      }

      if (opts.hasStep) {
        const step = new THREE.Mesh(
          getSharedBoxGeo(w + 0.16, 0.07, 0.2),
          getSharedStdMat('bdoor:step', { color: 0x334155, roughness: 0.82, metalness: 0.1 }),
        );
        step.position.set(0, 0.035, 0.11);
        step.receiveShadow = true;
        doorGrp.add(step);
      }

      if (opts.hasCanopy) {
        const canopy = new THREE.Mesh(
          getSharedBoxGeo(w + 0.38, 0.11, 0.46),
          frameMat,
        );
        canopy.position.set(0, h + 0.08, 0.23);
        canopy.castShadow = true;
        doorGrp.add(canopy);
      }

      parent.add(doorGrp);
    };

    if (kind === 'building-kiosk') {
      // 1-story modern pavilion / cafe (3.8m x 3.8m x 3.8m)
      const bodyGroup = new THREE.Group();
      bodyGroup.name = 'buildingBody';
      group.userData.buildingBody = bodyGroup;
      group.add(bodyGroup);

      const baseMat = getSharedStdMat('bk:base', { color: 0x28313e, roughness: 0.85, metalness: 0.1 });
      const facadeMat = getSharedStdMat('bk:facade', { color: 0x475569, roughness: 0.78, metalness: 0.08 });
      const glassMat = getSharedStdMat('bk:glass', { color: 0x0f172a, roughness: 0.08, metalness: 0.88 });
      const roofMat = getSharedStdMat('bk:roof', { color: 0x1e293b, roughness: 0.5, metalness: 0.42 });

      const plinth = new THREE.Mesh(getSharedBoxGeo(3.92, 0.35, 3.92), baseMat);
      plinth.position.y = 0.175;
      plinth.castShadow = true;
      plinth.receiveShadow = true;
      bodyGroup.add(plinth);

      const core = new THREE.Mesh(getSharedBoxGeo(3.64, 2.75, 3.64), facadeMat);
      core.position.y = 1.725;
      core.castShadow = true;
      core.receiveShadow = true;
      bodyGroup.add(core);

      const frontGlass = new THREE.Mesh(getSharedBoxGeo(1.72, 1.95, 0.08), glassMat);
      frontGlass.position.set(-0.68, 1.52, 1.83);
      bodyGroup.add(frontGlass);

      // Front cafe glazed entry door + rear service door
      addBuildingDoor(bodyGroup, {
        x: 0.88,
        y: 0.35,
        z: 1.83,
        width: 0.96,
        height: 2.15,
        style: 'glass-metal',
        hasStep: true,
      });
      addBuildingDoor(bodyGroup, {
        x: 0,
        y: 0.35,
        z: -1.83,
        rotY: Math.PI,
        width: 0.86,
        height: 2.05,
        style: 'steel',
      });

      const canopy = new THREE.Mesh(getSharedBoxGeo(4.28, 0.24, 4.42), roofMat);
      canopy.position.set(0, 3.22, 0.2);
      canopy.castShadow = true;
      canopy.receiveShadow = true;
      bodyGroup.add(canopy);

      const roofUnit = new THREE.Mesh(getSharedBoxGeo(1.3, 0.44, 1.1), baseMat);
      roofUnit.position.set(-0.6, 3.56, -0.4);
      roofUnit.castShadow = true;
      bodyGroup.add(roofUnit);
    } else if (kind === 'building-small') {
      // 2-story storefront / townhouse building (4.4m x 4.4m x 6.3m)
      const bodyGroup = new THREE.Group();
      bodyGroup.name = 'buildingBody';
      group.userData.buildingBody = bodyGroup;
      group.add(bodyGroup);

      const plinthMat = getSharedStdMat('bs:plinth', { color: 0x28313e, roughness: 0.88, metalness: 0.08 });
      const facadeMat = getSharedStdMat('bs:facade', { color: 0x475569, roughness: 0.82, metalness: 0.06 });
      const trimMat = getSharedStdMat('bs:trim', { color: 0x1e293b, roughness: 0.55, metalness: 0.35 });
      const glassMat = getSharedStdMat('bs:glass', { color: 0x0f172a, roughness: 0.08, metalness: 0.88 });
      const awningMat = getSharedStdMat('bs:awning', { color: 0x9a3412, roughness: 0.68, metalness: 0.1 });

      const plinth = new THREE.Mesh(getSharedBoxGeo(4.56, 0.55, 4.56), plinthMat);
      plinth.position.y = 0.275;
      plinth.castShadow = true;
      plinth.receiveShadow = true;
      bodyGroup.add(plinth);

      const body = new THREE.Mesh(getSharedBoxGeo(4.36, 5.4, 4.36), facadeMat);
      body.position.y = 3.25;
      body.castShadow = true;
      body.receiveShadow = true;
      bodyGroup.add(body);

      // Ground storefront window bay + shop entry door under awning facing +Z
      const storeGlass = new THREE.Mesh(getSharedBoxGeo(2.05, 1.85, 0.08), glassMat);
      storeGlass.position.set(-0.56, 1.5, 2.18);
      bodyGroup.add(storeGlass);

      addBuildingDoor(bodyGroup, {
        x: 1.08,
        y: 0.55,
        z: 2.19,
        width: 0.96,
        height: 1.96,
        style: 'wood',
        hasStep: true,
        leafColorHex: 0x7c2d12,
      });
      addBuildingDoor(bodyGroup, {
        x: 0,
        y: 0.55,
        z: -2.19,
        rotY: Math.PI,
        width: 0.92,
        height: 2.05,
        style: 'wood',
        hasStep: true,
      });

      const awning = new THREE.Mesh(getSharedBoxGeo(3.5, 0.16, 0.95), awningMat);
      awning.position.set(0, 2.55, 2.55);
      awning.rotation.x = 0.22;
      awning.castShadow = true;
      bodyGroup.add(awning);

      // Upper floor windows on front & back
      const upperWinGeo = getSharedBoxGeo(0.76, 1.25, 0.08);
      for (const wx of [-1.25, 0, 1.25]) {
        const winF = new THREE.Mesh(upperWinGeo, glassMat);
        winF.position.set(wx, 4.4, 2.18);
        bodyGroup.add(winF);

        const winB = new THREE.Mesh(upperWinGeo, glassMat);
        winB.position.set(wx, 4.4, -2.18);
        bodyGroup.add(winB);
      }

      const cornice = new THREE.Mesh(getSharedBoxGeo(4.64, 0.34, 4.64), trimMat);
      cornice.position.y = 6.12;
      cornice.castShadow = true;
      bodyGroup.add(cornice);
    } else if (kind === 'building-tall') {
      // 4-story mid-rise architectural tower (5.2m x 5.2m x 11.6m)
      const bodyGroup = new THREE.Group();
      bodyGroup.name = 'buildingBody';
      group.userData.buildingBody = bodyGroup;
      group.add(bodyGroup);

      const baseMat = getSharedStdMat('bt:base', { color: 0x1e293b, roughness: 0.72, metalness: 0.22 });
      const towerMat = getSharedStdMat('bt:tower', { color: 0x334155, roughness: 0.76, metalness: 0.15 });
      const glassMat = getSharedStdMat('bt:glass', { color: 0x0c1629, roughness: 0.08, metalness: 0.9 });
      const capMat = getSharedStdMat('bt:cap', { color: 0x0f172a, roughness: 0.45, metalness: 0.55 });

      const lobby = new THREE.Mesh(getSharedBoxGeo(5.36, 2.2, 5.36), baseMat);
      lobby.position.y = 1.1;
      lobby.castShadow = true;
      lobby.receiveShadow = true;
      bodyGroup.add(lobby);

      // Front & rear glazed double lobby portals
      addBuildingDoor(bodyGroup, {
        x: 0,
        y: 0,
        z: 2.68,
        width: 2.05,
        height: 2.1,
        style: 'glass-metal',
        doubleLeaf: true,
        hasCanopy: true,
        hasStep: true,
      });
      addBuildingDoor(bodyGroup, {
        x: 0,
        y: 0,
        z: -2.68,
        rotY: Math.PI,
        width: 1.75,
        height: 2.05,
        style: 'glass-metal',
        doubleLeaf: true,
        hasStep: true,
      });

      const core = new THREE.Mesh(getSharedBoxGeo(5.04, 8.2, 5.04), towerMat);
      core.position.y = 6.3;
      core.castShadow = true;
      core.receiveShadow = true;
      bodyGroup.add(core);

      // 3 horizontal curtain glass bands
      const bandGeo = getSharedBoxGeo(5.12, 1.15, 5.12);
      for (const wy of [4.0, 6.4, 8.8]) {
        const glassBand = new THREE.Mesh(bandGeo, glassMat);
        glassBand.position.y = wy;
        bodyGroup.add(glassBand);
      }

      const parapet = new THREE.Mesh(getSharedBoxGeo(5.3, 0.36, 5.3), capMat);
      parapet.position.y = 10.58;
      parapet.castShadow = true;
      bodyGroup.add(parapet);

      const penthouse = new THREE.Mesh(getSharedBoxGeo(2.4, 0.85, 2.4), baseMat);
      penthouse.position.y = 11.18;
      penthouse.castShadow = true;
      bodyGroup.add(penthouse);
    } else if (kind === 'building-highrise') {
      // 8-story high-rise tower (5.6m x 5.6m x 22.0m)
      const bodyGroup = new THREE.Group();
      bodyGroup.name = 'buildingBody';
      group.userData.buildingBody = bodyGroup;
      group.add(bodyGroup);

      const podiumMat = getSharedStdMat('bh:podium', { color: 0x1e293b, roughness: 0.7, metalness: 0.25 });
      const towerMat = getSharedStdMat('bh:tower', { color: 0x2d3b4e, roughness: 0.72, metalness: 0.18 });
      const glassMat = getSharedStdMat('bh:glass', { color: 0x0b1526, roughness: 0.08, metalness: 0.92 });
      const capMat = getSharedStdMat('bh:cap', { color: 0x0f172a, roughness: 0.42, metalness: 0.58 });

      const podium = new THREE.Mesh(getSharedBoxGeo(5.9, 3.2, 5.9), podiumMat);
      podium.position.y = 1.6;
      podium.castShadow = true;
      podium.receiveShadow = true;
      bodyGroup.add(podium);

      // Main & rear high-rise glass lobby entrances
      addBuildingDoor(bodyGroup, {
        x: 0,
        y: 0,
        z: 2.95,
        width: 2.35,
        height: 2.65,
        style: 'glass-metal',
        doubleLeaf: true,
        hasCanopy: true,
        hasStep: true,
      });
      addBuildingDoor(bodyGroup, {
        x: 0,
        y: 0,
        z: -2.95,
        rotY: Math.PI,
        width: 1.95,
        height: 2.4,
        style: 'glass-metal',
        doubleLeaf: true,
        hasStep: true,
      });

      const shaft = new THREE.Mesh(getSharedBoxGeo(5.36, 17.2, 5.36), towerMat);
      shaft.position.y = 11.8;
      shaft.castShadow = true;
      shaft.receiveShadow = true;
      bodyGroup.add(shaft);

      // 6 curtain-wall window tiers
      const bandGeo = getSharedBoxGeo(5.44, 1.35, 5.44);
      for (let floor = 0; floor < 6; floor++) {
        const band = new THREE.Mesh(bandGeo, glassMat);
        band.position.y = 5.0 + floor * 2.65;
        bodyGroup.add(band);
      }

      const crown = new THREE.Mesh(getSharedBoxGeo(5.58, 0.5, 5.58), capMat);
      crown.position.y = 20.65;
      crown.castShadow = true;
      bodyGroup.add(crown);

      const mechBox = new THREE.Mesh(getSharedBoxGeo(3.0, 1.1, 3.0), podiumMat);
      mechBox.position.y = 21.45;
      mechBox.castShadow = true;
      bodyGroup.add(mechBox);
    } else if (kind === 'building-rowhouse') {
      // 3-bay brick/brownstone rowhouse terrace (9.4m W x 4.6m D x 8.2m H)
      const bodyGroup = new THREE.Group();
      bodyGroup.name = 'buildingBody';
      group.userData.buildingBody = bodyGroup;
      group.add(bodyGroup);

      let hIdx = 0;
      for (let i = 0; i < id.length; i++) hIdx = (hIdx * 31 + id.charCodeAt(i)) >>> 0;
      const bayPalettes = [0x7c3f34, 0x855a44, 0x5c473e, 0x6c4c48, 0x475569];
      const doorPalettes = [0x2a1810, 0x1e3a2f, 0x1e293b, 0x5c231c, 0x3b2f26];
      const stoneMat = getSharedStdMat('brh:stone', { color: 0x3b3836, roughness: 0.88, metalness: 0.06 });
      const trimMat = getSharedStdMat('brh:trim', { color: 0x9ca3af, roughness: 0.72, metalness: 0.08 });
      const roofMat = getSharedStdMat('brh:roof', { color: 0x1e2430, roughness: 0.68, metalness: 0.2 });
      const glassMat = getSharedStdMat('brh:glass', {
        color: 0x17253b,
        emissive: 0xfbbf24,
        emissiveIntensity: 0.16,
        roughness: 0.15,
        metalness: 0.75,
      });

      const bayXs = [-3.1, 0, 3.1];
      const bayHeights = [6.6, 7.1, 6.4];
      for (let b = 0; b < 3; b++) {
        const bx = bayXs[b];
        const bh = bayHeights[b];
        const cHex = bayPalettes[(hIdx + b) % bayPalettes.length];
        const doorHex = doorPalettes[(hIdx + b) % doorPalettes.length];
        const wallMat = getSharedStdMat(`brh:wall:${cHex}`, { color: cHex, roughness: 0.84, metalness: 0.04 });

        const plinth = new THREE.Mesh(getSharedBoxGeo(3.06, 0.75, 4.55), stoneMat);
        plinth.position.set(bx, 0.375, 0);
        plinth.castShadow = true;
        plinth.receiveShadow = true;
        bodyGroup.add(plinth);

        const bayBody = new THREE.Mesh(getSharedBoxGeo(3.0, bh - 0.75, 4.36), wallMat);
        bayBody.position.set(bx, 0.75 + (bh - 0.75) * 0.5, 0);
        bayBody.castShadow = true;
        bayBody.receiveShadow = true;
        bodyGroup.add(bayBody);

        // Front stoop, entry steps, & brownstone doorway
        const stoop = new THREE.Mesh(getSharedBoxGeo(1.15, 0.55, 0.8), stoneMat);
        stoop.position.set(bx - 0.65, 0.275, 2.45);
        stoop.castShadow = true;
        bodyGroup.add(stoop);

        addBuildingDoor(bodyGroup, {
          x: bx - 0.65,
          y: 0.55,
          z: 2.19,
          width: 0.94,
          height: 2.02,
          style: 'wood',
          hasCanopy: true,
          leafColorHex: doorHex,
        });
        addBuildingDoor(bodyGroup, {
          x: bx - 0.65,
          y: 0.75,
          z: -2.19,
          rotY: Math.PI,
          width: 0.88,
          height: 1.96,
          style: 'wood',
          leafColorHex: doorHex,
        });

        const cornice = new THREE.Mesh(getSharedBoxGeo(3.14, 0.28, 4.55), trimMat);
        cornice.position.set(bx, bh + 0.12, 0.04);
        cornice.castShadow = true;
        bodyGroup.add(cornice);

        // Pitched slate mansard/gable crown
        const roofSlope = new THREE.Mesh(getSharedBoxGeo(2.96, 1.05, 4.18), roofMat);
        roofSlope.position.set(bx, bh + 0.72, -0.05);
        roofSlope.castShadow = true;
        bodyGroup.add(roofSlope);

        // Windows on 2 upper tiers + ground parlor right side
        for (const wy of [1.85, 3.85, 5.65]) {
          if (wy > bh - 0.4) continue;
          for (const wxOff of [-0.68, 0.68]) {
            if (wy === 1.85 && wxOff < 0) continue;
            const wF = new THREE.Mesh(getSharedBoxGeo(0.68, 1.12, 0.08), glassMat);
            wF.position.set(bx + wxOff, wy, 2.19);
            bodyGroup.add(wF);
            const wB = new THREE.Mesh(getSharedBoxGeo(0.68, 1.12, 0.08), glassMat);
            wB.position.set(bx + wxOff, wy, -2.19);
            bodyGroup.add(wB);
          }
        }
      }
    } else if (kind === 'building-commercial') {
      // Wide modern retail plaza strip (10.6m W x 4.8m D x 4.8m H)
      const bodyGroup = new THREE.Group();
      bodyGroup.name = 'buildingBody';
      group.userData.buildingBody = bodyGroup;
      group.add(bodyGroup);

      const wallMat = getSharedStdMat('bcm:wall', { color: 0x3b4454, roughness: 0.74, metalness: 0.14 });
      const woodMat = getSharedStdMat('bcm:wood', { color: 0x7c5338, roughness: 0.76, metalness: 0.04 });
      const steelMat = getSharedStdMat('bcm:steel', { color: 0x1e293b, roughness: 0.42, metalness: 0.65 });
      const glassMat = getSharedStdMat('bcm:glass', {
        color: 0x162940,
        emissive: 0xfde68a,
        emissiveIntensity: 0.24,
        roughness: 0.1,
        metalness: 0.82,
      });

      const slab = new THREE.Mesh(getSharedBoxGeo(10.6, 0.3, 4.8), steelMat);
      slab.position.y = 0.15;
      slab.castShadow = true;
      slab.receiveShadow = true;
      bodyGroup.add(slab);

      const core = new THREE.Mesh(getSharedBoxGeo(10.2, 3.9, 4.3), wallMat);
      core.position.set(0, 2.25, -0.1);
      core.castShadow = true;
      core.receiveShadow = true;
      bodyGroup.add(core);

      // 3 wide retail storefront bays + glass entry doors
      for (const sx of [-3.3, 0, 3.3]) {
        const bayGlass = new THREE.Mesh(getSharedBoxGeo(1.55, 2.45, 0.1), glassMat);
        bayGlass.position.set(sx - 0.55, 1.6, 2.06);
        bodyGroup.add(bayGlass);

        addBuildingDoor(bodyGroup, {
          x: sx + 0.78,
          y: 0.3,
          z: 2.07,
          width: 0.98,
          height: 2.25,
          style: 'glass-metal',
          hasStep: true,
        });

        const signPanel = new THREE.Mesh(getSharedBoxGeo(2.5, 0.42, 0.12), woodMat);
        signPanel.position.set(sx, 3.45, 2.1);
        bodyGroup.add(signPanel);
      }

      // Rear service exit door
      addBuildingDoor(bodyGroup, {
        x: 2.4,
        y: 0.3,
        z: -2.26,
        rotY: Math.PI,
        width: 0.95,
        height: 2.15,
        style: 'steel',
        hasStep: true,
      });

      // Overhanging cantilevered canopy
      const canopy = new THREE.Mesh(getSharedBoxGeo(10.6, 0.22, 1.35), woodMat);
      canopy.position.set(0, 3.12, 2.45);
      canopy.castShadow = true;
      bodyGroup.add(canopy);

      const fascia = new THREE.Mesh(getSharedBoxGeo(10.68, 0.42, 4.56), steelMat);
      fascia.position.set(0, 4.35, -0.05);
      fascia.castShadow = true;
      bodyGroup.add(fascia);

      const hvac = new THREE.Mesh(getSharedBoxGeo(2.8, 0.55, 1.8), steelMat);
      hvac.position.set(-2.2, 4.78, -0.4);
      hvac.castShadow = true;
      bodyGroup.add(hvac);
    } else if (kind === 'building-warehouse') {
      // Industrial brick & steel hall with sawtooth skylight bays (10.2m W x 6.4m D x 7.4m H)
      const bodyGroup = new THREE.Group();
      bodyGroup.name = 'buildingBody';
      group.userData.buildingBody = bodyGroup;
      group.add(bodyGroup);

      const brickMat = getSharedStdMat('bwh:brick', { color: 0x6b3a32, roughness: 0.88, metalness: 0.04 });
      const steelMat = getSharedStdMat('bwh:steel', { color: 0x263242, roughness: 0.52, metalness: 0.55 });
      const doorMat = getSharedStdMat('bwh:door', { color: 0x475569, roughness: 0.58, metalness: 0.48 });
      const skyGlassMat = getSharedStdMat('bwh:glass', {
        color: 0x1e293b,
        emissive: 0xfef3c7,
        emissiveIntensity: 0.18,
        roughness: 0.16,
        metalness: 0.72,
      });

      const base = new THREE.Mesh(getSharedBoxGeo(10.3, 0.55, 6.4), steelMat);
      base.position.y = 0.275;
      base.castShadow = true;
      base.receiveShadow = true;
      bodyGroup.add(base);

      const hall = new THREE.Mesh(getSharedBoxGeo(10.0, 5.2, 6.0), brickMat);
      hall.position.y = 3.15;
      hall.castShadow = true;
      hall.receiveShadow = true;
      bodyGroup.add(hall);

      // Exterior steel pilasters
      for (const px of [-4.6, -1.55, 1.55, 4.6]) {
        const pilaster = new THREE.Mesh(getSharedBoxGeo(0.32, 5.3, 6.22), steelMat);
        pilaster.position.set(px, 3.18, 0);
        pilaster.castShadow = true;
        bodyGroup.add(pilaster);
      }

      // Loading dock bays on front + front & rear steel personnel doors
      for (const dx of [-3.1, 0]) {
        const dock = new THREE.Mesh(getSharedBoxGeo(2.3, 2.8, 0.14), doorMat);
        dock.position.set(dx, 1.95, 3.02);
        bodyGroup.add(dock);
      }
      addBuildingDoor(bodyGroup, {
        x: 3.1,
        y: 0.55,
        z: 3.02,
        width: 1.05,
        height: 2.2,
        style: 'steel',
        hasCanopy: true,
        hasStep: true,
      });
      addBuildingDoor(bodyGroup, {
        x: -3.1,
        y: 0.55,
        z: -3.02,
        rotY: Math.PI,
        width: 1.0,
        height: 2.15,
        style: 'steel',
        hasCanopy: true,
        hasStep: true,
      });

      // Upper clerestory industrial windows
      for (const wx of [-3.1, 0, 3.1]) {
        const cWin = new THREE.Mesh(getSharedBoxGeo(2.3, 1.05, 0.1), skyGlassMat);
        cWin.position.set(wx, 4.55, 3.02);
        bodyGroup.add(cWin);
        const cWinB = new THREE.Mesh(getSharedBoxGeo(2.3, 1.05, 0.1), skyGlassMat);
        cWinB.position.set(wx, 4.55, -3.02);
        bodyGroup.add(cWinB);
      }

      // 3-bay sawtooth industrial roof ridges
      for (const sx of [-3.2, 0, 3.2]) {
        const ridge = new THREE.Mesh(getSharedBoxGeo(2.9, 1.55, 5.8), steelMat);
        ridge.position.set(sx, 6.45, 0);
        ridge.rotation.z = 0.22;
        ridge.castShadow = true;
        bodyGroup.add(ridge);

        const skylight = new THREE.Mesh(getSharedBoxGeo(0.14, 1.1, 5.4), skyGlassMat);
        skylight.position.set(sx + 1.38, 6.45, 0);
        bodyGroup.add(skylight);
      }
    } else if (kind === 'building-civic') {
      // Neoclassical limestone civic hall with colonnade & cupola (10.4m W x 6.8m D x 10.4m H)
      const bodyGroup = new THREE.Group();
      bodyGroup.name = 'buildingBody';
      group.userData.buildingBody = bodyGroup;
      group.add(bodyGroup);

      const stoneMat = getSharedStdMat('bcv:stone', { color: 0x8f887d, roughness: 0.8, metalness: 0.06 });
      const darkStoneMat = getSharedStdMat('bcv:dark', { color: 0x474540, roughness: 0.85, metalness: 0.08 });
      const roofMat = getSharedStdMat('bcv:roof', { color: 0x283546, roughness: 0.55, metalness: 0.35 });
      const glassMat = getSharedStdMat('bcv:glass', {
        color: 0x162436,
        emissive: 0xfde68a,
        emissiveIntensity: 0.2,
        roughness: 0.14,
        metalness: 0.78,
      });

      // Grand entrance steps / podium
      const step1 = new THREE.Mesh(getSharedBoxGeo(10.4, 0.42, 6.8), darkStoneMat);
      step1.position.y = 0.21;
      step1.castShadow = true;
      step1.receiveShadow = true;
      bodyGroup.add(step1);

      const step2 = new THREE.Mesh(getSharedBoxGeo(9.8, 0.42, 6.1), stoneMat);
      step2.position.y = 0.63;
      step2.castShadow = true;
      step2.receiveShadow = true;
      bodyGroup.add(step2);

      // Main civic mass
      const hall = new THREE.Mesh(getSharedBoxGeo(9.4, 6.6, 4.9), stoneMat);
      hall.position.set(0, 4.14, -0.35);
      hall.castShadow = true;
      hall.receiveShadow = true;
      bodyGroup.add(hall);

      // Grand front & rear bronze civic double portals
      addBuildingDoor(bodyGroup, {
        x: 0,
        y: 0.84,
        z: 2.11,
        width: 1.48,
        height: 2.6,
        style: 'civic-bronze',
        doubleLeaf: true,
        hasCanopy: true,
      });
      addBuildingDoor(bodyGroup, {
        x: 0,
        y: 0.84,
        z: -2.81,
        rotY: Math.PI,
        width: 1.35,
        height: 2.4,
        style: 'civic-bronze',
        doubleLeaf: true,
      });

      // Front classical colonnade pillars
      const colGeo = getSharedCylinderGeo(0.24, 0.28, 6.3, 12);
      for (const cx of [-3.9, -2.35, -0.8, 0.8, 2.35, 3.9]) {
        const col = new THREE.Mesh(colGeo, stoneMat);
        col.position.set(cx, 3.99, 2.52);
        col.castShadow = true;
        col.receiveShadow = true;
        bodyGroup.add(col);
      }

      // Tall recessed civic windows (upper clear above center portal)
      for (const wx of [-3.1, -1.55, 0, 1.55, 3.1]) {
        const isCenter = wx === 0;
        const winH = isCenter ? 2.1 : 3.6;
        const winY = isCenter ? 4.95 : 4.2;
        const winF = new THREE.Mesh(getSharedBoxGeo(0.85, winH, 0.12), glassMat);
        winF.position.set(wx, winY, 2.12);
        bodyGroup.add(winF);
        const winB = new THREE.Mesh(getSharedBoxGeo(0.85, winH, 0.12), glassMat);
        winB.position.set(wx, winY, -2.82);
        bodyGroup.add(winB);
      }

      // Entablature & stepped pediment roof
      const entablature = new THREE.Mesh(getSharedBoxGeo(10.0, 0.72, 6.0), stoneMat);
      entablature.position.set(0, 7.6, -0.05);
      entablature.castShadow = true;
      bodyGroup.add(entablature);

      const roofTier = new THREE.Mesh(getSharedBoxGeo(8.8, 0.85, 4.8), roofMat);
      roofTier.position.set(0, 8.38, -0.15);
      roofTier.castShadow = true;
      bodyGroup.add(roofTier);

      const cupolaBase = new THREE.Mesh(getSharedCylinderGeo(1.15, 1.28, 1.15, 16), stoneMat);
      cupolaBase.position.set(0, 9.35, -0.2);
      cupolaBase.castShadow = true;
      bodyGroup.add(cupolaBase);

      const cupolaDome = new THREE.Mesh(
        sharedGeo('civicDome', () => new THREE.SphereGeometry(1.12, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.55)),
        roofMat,
      );
      cupolaDome.position.set(0, 9.88, -0.2);
      cupolaDome.castShadow = true;
      bodyGroup.add(cupolaDome);
    } else if (kind === 'building-apartments') {
      // Stepped L-wing mid-rise apartment complex with balconies (9.0m W x 7.0m D x 15.2m H)
      const bodyGroup = new THREE.Group();
      bodyGroup.name = 'buildingBody';
      group.userData.buildingBody = bodyGroup;
      group.add(bodyGroup);

      const podiumMat = getSharedStdMat('bap:podium', { color: 0x262e3d, roughness: 0.78, metalness: 0.16 });
      const facadeMat = getSharedStdMat('bap:facade', { color: 0x6a6e75, roughness: 0.76, metalness: 0.08 });
      const wingMat = getSharedStdMat('bap:wing', { color: 0x4b5563, roughness: 0.74, metalness: 0.12 });
      const balcMat = getSharedStdMat('bap:balc', { color: 0x1e293b, roughness: 0.55, metalness: 0.4 });
      const glassMat = getSharedStdMat('bap:glass', {
        color: 0x111c2d,
        emissive: 0xfef08a,
        emissiveIntensity: 0.15,
        roughness: 0.12,
        metalness: 0.85,
      });

      // Ground commercial podium
      const podium = new THREE.Mesh(getSharedBoxGeo(9.0, 2.5, 6.8), podiumMat);
      podium.position.y = 1.25;
      podium.castShadow = true;
      podium.receiveShadow = true;
      bodyGroup.add(podium);

      // Front main apartment lobby double door, side retail door, & rear entrance
      addBuildingDoor(bodyGroup, {
        x: 1.9,
        y: 0,
        z: 3.41,
        width: 2.05,
        height: 2.25,
        style: 'glass-metal',
        doubleLeaf: true,
        hasCanopy: true,
        hasStep: true,
      });
      addBuildingDoor(bodyGroup, {
        x: -2.3,
        y: 0,
        z: 3.41,
        width: 1.05,
        height: 2.15,
        style: 'glass-metal',
        hasStep: true,
      });
      addBuildingDoor(bodyGroup, {
        x: 0,
        y: 0,
        z: -3.41,
        rotY: Math.PI,
        width: 1.65,
        height: 2.18,
        style: 'glass-metal',
        doubleLeaf: true,
        hasStep: true,
      });

      // Tall main L-spine wing (15.2m)
      const mainWing = new THREE.Mesh(getSharedBoxGeo(8.6, 11.8, 3.6), facadeMat);
      mainWing.position.set(0, 8.4, -1.4);
      mainWing.castShadow = true;
      mainWing.receiveShadow = true;
      bodyGroup.add(mainWing);

      // Lower forward projecting wing (10.6m)
      const sideWing = new THREE.Mesh(getSharedBoxGeo(4.0, 8.2, 3.4), wingMat);
      sideWing.position.set(-2.3, 6.6, 1.5);
      sideWing.castShadow = true;
      sideWing.receiveShadow = true;
      bodyGroup.add(sideWing);

      // Projecting balcony slabs + window bands
      for (let fl = 0; fl < 4; fl++) {
        const fy = 4.2 + fl * 2.55;
        const winBand = new THREE.Mesh(getSharedBoxGeo(8.72, 1.15, 3.72), glassMat);
        winBand.position.set(0, fy, -1.4);
        bodyGroup.add(winBand);

        const balc = new THREE.Mesh(getSharedBoxGeo(3.8, 0.2, 0.9), balcMat);
        balc.position.set(2.1, fy - 0.58, 0.8);
        balc.castShadow = true;
        bodyGroup.add(balc);

        if (fl < 3) {
          const wingGlass = new THREE.Mesh(getSharedBoxGeo(4.12, 1.1, 3.52), glassMat);
          wingGlass.position.set(-2.3, fy, 1.5);
          bodyGroup.add(wingGlass);
        }
      }

      // Rooftop crown & penthouse pergola
      const crown = new THREE.Mesh(getSharedBoxGeo(8.8, 0.35, 3.8), balcMat);
      crown.position.set(0, 14.48, -1.4);
      crown.castShadow = true;
      bodyGroup.add(crown);

      const penthouse = new THREE.Mesh(getSharedBoxGeo(3.6, 0.9, 2.2), podiumMat);
      penthouse.position.set(-1.5, 14.95, -1.4);
      penthouse.castShadow = true;
      bodyGroup.add(penthouse);
    } else if (kind === 'building-skyscraper') {
      // Tall setback Art-Deco glass skyscraper with podium & spire (7.8m W x 6.2m D x 30.0m H)
      const bodyGroup = new THREE.Group();
      bodyGroup.name = 'buildingBody';
      group.userData.buildingBody = bodyGroup;
      group.add(bodyGroup);

      const podiumMat = getSharedStdMat('bsk:podium', { color: 0x1b2230, roughness: 0.68, metalness: 0.25 });
      const stoneMat = getSharedStdMat('bsk:stone', { color: 0x3b485e, roughness: 0.64, metalness: 0.22 });
      const glassMat = getSharedStdMat('bsk:glass', {
        color: 0x0d1b2e,
        emissive: 0xfde68a,
        emissiveIntensity: 0.14,
        roughness: 0.08,
        metalness: 0.92,
      });
      const spireMat = getSharedStdMat('bsk:spire', {
        color: 0x94a3b8,
        emissive: 0x38bdf8,
        emissiveIntensity: 0.22,
        roughness: 0.3,
        metalness: 0.85,
      });

      const podium = new THREE.Mesh(getSharedBoxGeo(7.8, 4.2, 6.2), podiumMat);
      podium.position.y = 2.1;
      podium.castShadow = true;
      podium.receiveShadow = true;
      bodyGroup.add(podium);

      // Grand front Art-Deco portal + Avenue side & rear entrances
      addBuildingDoor(bodyGroup, {
        x: 0,
        y: 0,
        z: 3.11,
        width: 2.55,
        height: 3.1,
        style: 'artdeco',
        doubleLeaf: true,
        hasCanopy: true,
        hasStep: true,
      });
      addBuildingDoor(bodyGroup, {
        x: 3.91,
        y: 0,
        z: 0,
        rotY: Math.PI / 2,
        width: 1.85,
        height: 2.85,
        style: 'artdeco',
        doubleLeaf: true,
        hasCanopy: true,
      });
      addBuildingDoor(bodyGroup, {
        x: 0,
        y: 0,
        z: -3.11,
        rotY: Math.PI,
        width: 2.1,
        height: 2.85,
        style: 'artdeco',
        doubleLeaf: true,
        hasStep: true,
      });

      // Lower tower shaft
      const shaft1 = new THREE.Mesh(getSharedBoxGeo(6.8, 13.5, 5.4), glassMat);
      shaft1.position.y = 10.95;
      shaft1.castShadow = true;
      shaft1.receiveShadow = true;
      bodyGroup.add(shaft1);

      // Vertical stone piers along shaft1
      for (const px of [-3.25, -1.1, 1.1, 3.25]) {
        const pier = new THREE.Mesh(getSharedBoxGeo(0.42, 13.8, 5.65), stoneMat);
        pier.position.set(px, 11.0, 0);
        pier.castShadow = true;
        bodyGroup.add(pier);
      }

      // Mid setback tier
      const shaft2 = new THREE.Mesh(getSharedBoxGeo(5.2, 6.6, 4.2), stoneMat);
      shaft2.position.y = 21.0;
      shaft2.castShadow = true;
      shaft2.receiveShadow = true;
      bodyGroup.add(shaft2);

      const band2 = new THREE.Mesh(getSharedBoxGeo(5.35, 4.8, 4.35), glassMat);
      band2.position.y = 21.0;
      bodyGroup.add(band2);

      // Upper crown & lantern spire (reaching 30.0m)
      const crown = new THREE.Mesh(getSharedBoxGeo(3.4, 2.8, 3.0), podiumMat);
      crown.position.y = 25.7;
      crown.castShadow = true;
      bodyGroup.add(crown);

      const spire = new THREE.Mesh(getSharedCylinderGeo(0.06, 0.28, 3.0, 10), spireMat);
      spire.position.y = 28.5;
      spire.castShadow = true;
      bodyGroup.add(spire);
    }
  } else if (kind === 'tree') {
    const trunkMat = getSharedStdMat('tree:trunk', { color: 0x45352b, roughness: 0.92, metalness: 0.0 });
    const leafMat1 = getSharedStdMat('tree:leaf1', { color: 0x224131, roughness: 0.85, metalness: 0.0 });
    const leafMat2 = getSharedStdMat('tree:leaf2', { color: 0x2c523d, roughness: 0.82, metalness: 0.0 });

    const rootCollar = new THREE.Mesh(getSharedCylinderGeo(0.18, 0.3, 0.28, 10), trunkMat);
    rootCollar.position.y = 0.14;
    rootCollar.castShadow = true;
    group.add(rootCollar);

    const trunk = new THREE.Mesh(getSharedCylinderGeo(0.12, 0.19, 2.3, 10), trunkMat);
    trunk.position.y = 1.3;
    trunk.castShadow = true;
    trunk.receiveShadow = true;
    group.add(trunk);

    const crownMain = new THREE.Mesh(getSharedDodecaGeo(1.18, 1), leafMat1);
    crownMain.position.y = 2.95;
    crownMain.castShadow = true;
    crownMain.receiveShadow = true;
    group.add(crownMain);

    const crownTop = new THREE.Mesh(getSharedDodecaGeo(0.84, 1), leafMat2);
    crownTop.position.set(0.28, 3.65, -0.18);
    crownTop.castShadow = true;
    group.add(crownTop);

    const crownSide = new THREE.Mesh(getSharedDodecaGeo(0.76, 1), leafMat2);
    crownSide.position.set(-0.48, 2.75, 0.32);
    crownSide.castShadow = true;
    group.add(crownSide);
  } else if (kind === 'hedge') {
    // Architectural street hedgerow in stone curb planter (2.6m x 0.88m x 1.08m)
    const curbMat = getSharedStdMat('hedge:curb', { color: 0x334155, roughness: 0.78, metalness: 0.14 });
    const soilMat = getSharedStdMat('hedge:soil', { color: 0x2a211b, roughness: 0.95, metalness: 0.0 });
    const hedgeBaseMat = getSharedStdMat('hedge:base', { color: 0x1a3a27, roughness: 0.88, metalness: 0.02 });
    const hedgeTrimMat = getSharedStdMat('hedge:trim', { color: 0x244d34, roughness: 0.84, metalness: 0.02 });

    const planter = new THREE.Mesh(getSharedBoxGeo(2.6, 0.16, 0.88), curbMat);
    planter.position.y = 0.08;
    planter.castShadow = true;
    planter.receiveShadow = true;
    group.add(planter);

    const soil = new THREE.Mesh(getSharedBoxGeo(2.44, 0.04, 0.72), soilMat);
    soil.position.y = 0.16;
    soil.receiveShadow = true;
    group.add(soil);

    const hedgeCore = new THREE.Mesh(getSharedBoxGeo(2.4, 0.82, 0.68), hedgeBaseMat);
    hedgeCore.position.y = 0.57;
    hedgeCore.castShadow = true;
    hedgeCore.receiveShadow = true;
    group.add(hedgeCore);

    const hedgeCrest = new THREE.Mesh(getSharedBoxGeo(2.3, 0.14, 0.56), hedgeTrimMat);
    hedgeCrest.position.y = 1.01;
    hedgeCrest.castShadow = true;
    hedgeCrest.receiveShadow = true;
    group.add(hedgeCrest);

    const tuftGeo = getSharedDodecaGeo(0.32, 1);
    for (const hx of [-0.85, -0.3, 0.3, 0.85]) {
      const tuft = new THREE.Mesh(tuftGeo, hedgeTrimMat);
      tuft.scale.set(1.15, 0.9, 1.08);
      tuft.position.set(hx, 0.86, 0);
      tuft.castShadow = true;
      tuft.receiveShadow = true;
      group.add(tuft);
    }
  } else if (kind === 'bench') {
    // Park Bench (1.9m x 0.65m x 0.86m)
    const ironMat = getSharedStdMat('bench:iron', { color: 0x1e293b, roughness: 0.45, metalness: 0.72 });
    const woodMat = getSharedStdMat('bench:wood', { color: 0x7c4a2d, roughness: 0.78, metalness: 0.04 });

    const legGeo = getSharedBoxGeo(0.08, 0.44, 0.56);
    const postGeo = getSharedBoxGeo(0.08, 0.48, 0.08);
    for (const lx of [-0.74, 0.74]) {
      const legFront = new THREE.Mesh(legGeo, ironMat);
      legFront.position.set(lx, 0.22, 0);
      legFront.castShadow = true;
      group.add(legFront);

      const postBack = new THREE.Mesh(postGeo, ironMat);
      postBack.position.set(lx, 0.62, -0.24);
      postBack.rotation.x = -0.12;
      postBack.castShadow = true;
      group.add(postBack);
    }

    const seatGeo = getSharedBoxGeo(1.86, 0.045, 0.12);
    for (const sz of [-0.14, 0.04, 0.2]) {
      const slat = new THREE.Mesh(seatGeo, woodMat);
      slat.position.set(0, 0.46, sz);
      slat.castShadow = true;
      slat.receiveShadow = true;
      group.add(slat);
    }

    const backGeo = getSharedBoxGeo(1.86, 0.1, 0.045);
    for (const by of [0.64, 0.8]) {
      const backSlat = new THREE.Mesh(backGeo, woodMat);
      backSlat.position.set(0, by, -0.24);
      backSlat.rotation.x = -0.12;
      backSlat.castShadow = true;
      group.add(backSlat);
    }
  } else if (kind === 'road-2lane') {
    const roadMat = getSharedRoadSurfaceMat('road-2lane', maxAnisotropy);
    const curbMat = getSharedStdMat('road:curb', { color: 0x475569, roughness: 0.78, metalness: 0.06 });

    let deckGeo: THREE.PlaneGeometry;
    if (segLen2Lane === 8.0) {
      deckGeo = getSharedPlaneGeo(8.0, 9.0);
    } else {
      deckGeo = sharedGeo(`road2laneDeck:${segLen2Lane}`, () => {
        const g = new THREE.PlaneGeometry(segLen2Lane, 9.0);
        const uv = g.attributes.uv;
        const uScale = segLen2Lane / 8.0;
        for (let i = 0; i < uv.count; i++) {
          uv.setX(i, uv.getX(i) * uScale);
        }
        uv.needsUpdate = true;
        return g;
      });
    }
    const deck = new THREE.Mesh(deckGeo, roadMat);
    deck.rotation.x = -Math.PI / 2;
    deck.position.y = 0.012;
    deck.receiveShadow = true;
    group.add(deck);

    const curbGeo = getSharedBoxGeo(segLen2Lane, 0.135, 0.24);
    for (const side of [-1, 1]) {
      const curb = new THREE.Mesh(curbGeo, curbMat);
      curb.position.set(0, 0.0675, side * 4.62);
      curb.receiveShadow = true;
      curb.userData.roadCurbSide = side;
      curb.userData.roadSegLen = segLen2Lane;
      group.add(curb);
    }
  } else if (kind === 'road-intersection') {
    const roadMat = getSharedRoadSurfaceMat('road-intersection', maxAnisotropy);
    const crosswalkApronMat = getSharedRoadSurfaceMat('road-intersection-crosswalk', maxAnisotropy);
    const curbMat = getSharedStdMat('road:curb', { color: 0x475569, roughness: 0.78, metalness: 0.06 });

    const deck = new THREE.Mesh(getSharedPlaneGeo(9.0, 9.0), roadMat);
    deck.rotation.x = -Math.PI / 2;
    deck.position.y = 0.013;
    deck.receiveShadow = true;
    group.add(deck);

    // 4 sidewalk-aligned crosswalk aprons spanning 4.5m..7.9m along each approach leg
    const apronGeo = getSharedPlaneGeo(8.88, 3.4);
    for (const yaw of [0, Math.PI, Math.PI / 2, -Math.PI / 2]) {
      const apron = new THREE.Mesh(apronGeo, crosswalkApronMat);
      apron.rotation.order = 'YXZ';
      apron.rotation.x = -Math.PI / 2;
      apron.rotation.y = yaw;
      apron.position.set(Math.sin(yaw) * 6.2, 0.0145, Math.cos(yaw) * 6.2);
      apron.receiveShadow = true;
      group.add(apron);
    }

    const cornerGeo = getSharedBoxGeo(0.7, 0.135, 0.7);
    const capGeo = getSharedBoxGeo(0.24, 0.135, 0.24);
    for (const cx of [-4.15, 4.15]) {
      for (const cz of [-4.15, 4.15]) {
        const corner = new THREE.Mesh(cornerGeo, curbMat);
        corner.position.set(cx, 0.0675, cz);
        corner.receiveShadow = true;
        group.add(corner);
      }
    }
    for (const cx of [-4.62, 4.62]) {
      for (const cz of [-4.62, 4.62]) {
        const cap = new THREE.Mesh(capGeo, curbMat);
        cap.position.set(cx, 0.0675, cz);
        cap.receiveShadow = true;
        group.add(cap);
      }
    }
  } else if (kind === 'road-t-junction') {
    const roadMat = getSharedRoadSurfaceMat('road-t-junction', maxAnisotropy);
    const curbMat = getSharedStdMat('road:curb', { color: 0x475569, roughness: 0.78, metalness: 0.06 });

    const deck = new THREE.Mesh(getSharedPlaneGeo(9.0, 9.0), roadMat);
    deck.rotation.x = -Math.PI / 2;
    deck.position.y = 0.013;
    deck.receiveShadow = true;
    group.add(deck);

    // Continuous back curb along North edge
    const northCurb = new THREE.Mesh(getSharedBoxGeo(9.0, 0.135, 0.24), curbMat);
    northCurb.position.set(0, 0.0675, -4.62);
    northCurb.receiveShadow = true;
    group.add(northCurb);

    // Two South corner curb aprons framing the branch turn
    const cornerGeo = getSharedBoxGeo(0.7, 0.135, 0.7);
    const capGeo = getSharedBoxGeo(0.24, 0.135, 0.24);
    for (const cx of [-4.15, 4.15]) {
      const corner = new THREE.Mesh(cornerGeo, curbMat);
      corner.position.set(cx, 0.0675, 4.15);
      corner.receiveShadow = true;
      group.add(corner);

      const cap = new THREE.Mesh(capGeo, curbMat);
      cap.position.set(Math.sign(cx) * 4.62, 0.0675, 4.62);
      cap.receiveShadow = true;
      group.add(cap);
    }
  } else if (kind === 'road-turn-90') {
    const roadMat = getSharedRoadSurfaceMat('road-2lane', maxAnisotropy);
    const curbMat = getSharedStdMat('road:curb', { color: 0x475569, roughness: 0.78, metalness: 0.06 });

    const deckGeo = sharedGeo('turn90Deck', () =>
      createCurvedRoadStripGeometry(-6, 6, 1.5, 10.5, 0, Math.PI / 2, 28, 1.18),
    );
    const deck = new THREE.Mesh(deckGeo, roadMat);
    deck.position.y = 0.013;
    deck.receiveShadow = true;
    group.add(deck);

    const innerCurb = new THREE.Mesh(
      sharedGeo('turn90InnerCurb', () => new THREE.TorusGeometry(1.38, 0.12, 8, 24, Math.PI / 2)),
      curbMat,
    );
    innerCurb.rotation.x = -Math.PI / 2;
    innerCurb.scale.z = 0.68;
    innerCurb.position.set(-6, 0.055, 6);
    innerCurb.receiveShadow = true;
    group.add(innerCurb);

    const outerCurb = new THREE.Mesh(
      sharedGeo('turn90OuterCurb', () => new THREE.TorusGeometry(10.62, 0.12, 8, 32, Math.PI / 2)),
      curbMat,
    );
    outerCurb.rotation.x = -Math.PI / 2;
    outerCurb.scale.z = 0.68;
    outerCurb.position.set(-6, 0.055, 6);
    outerCurb.receiveShadow = true;
    group.add(outerCurb);
  } else if (kind === 'road-curve-45') {
    const roadMat = getSharedRoadSurfaceMat('road-2lane', maxAnisotropy);
    const curbMat = getSharedStdMat('road:curb', { color: 0x475569, roughness: 0.78, metalness: 0.06 });

    const deckGeo = sharedGeo('curve45Deck', () =>
      createCurvedRoadStripGeometry(
        -4.95,
        11.95,
        9.5,
        18.5,
        Math.PI / 4,
        Math.PI / 2,
        22,
        1.375,
      ),
    );
    const deck = new THREE.Mesh(deckGeo, roadMat);
    deck.position.y = 0.013;
    deck.receiveShadow = true;
    group.add(deck);

    for (const curbR of [9.38, 18.62]) {
      const curb = new THREE.Mesh(
        sharedGeo(`curve45Curb:${curbR}`, () => new THREE.TorusGeometry(curbR, 0.12, 8, 22, Math.PI / 4)),
        curbMat,
      );
      curb.rotation.x = -Math.PI / 2;
      curb.rotation.z = Math.PI / 4;
      curb.scale.z = 0.68;
      curb.position.set(-4.95, 0.055, 11.95);
      curb.receiveShadow = true;
      group.add(curb);
    }
  } else if (kind === 'road-crosswalk') {
    const roadMat = getSharedRoadSurfaceMat('road-crosswalk', maxAnisotropy);
    const curbMat = getSharedStdMat('road:curb', { color: 0x475569, roughness: 0.78, metalness: 0.06 });
    const stripMat = getSharedStdMat('road:tactile', { color: 0xf59e0b, roughness: 0.45, metalness: 0.12 });

    const deck = new THREE.Mesh(getSharedPlaneGeo(6.0, 9.0), roadMat);
    deck.rotation.x = -Math.PI / 2;
    deck.position.y = 0.014;
    deck.receiveShadow = true;
    group.add(deck);

    const curbGeo = getSharedBoxGeo(6.0, 0.135, 0.24);
    const tactileGeo = getSharedBoxGeo(3.4, 0.03, 0.36);
    for (const side of [-1, 1]) {
      const curb = new THREE.Mesh(curbGeo, curbMat);
      curb.position.set(0, 0.0675, side * 4.62);
      curb.receiveShadow = true;
      group.add(curb);

      const tactile = new THREE.Mesh(tactileGeo, stripMat);
      tactile.position.set(0, 0.128, side * 4.64);
      tactile.receiveShadow = true;
      group.add(tactile);
    }
  } else if (kind === 'road-roundabout') {
    const ringMat = getSharedRoadSurfaceMat('road-roundabout', maxAnisotropy);
    const armMat = getSharedRoadSurfaceMat('road-2lane', maxAnisotropy);
    const curbMat = getSharedStdMat('road:curb', { color: 0x475569, roughness: 0.78, metalness: 0.06 });
    const turfMat = getSharedStdMat('road:turf', { color: 0x1d3b29, roughness: 0.9, metalness: 0.0 });
    const shrubMat = getSharedStdMat('road:shrub', { color: 0x245437, roughness: 0.86, metalness: 0.0 });
    const stoneMat = getSharedStdMat('road:stone', { color: 0x64748b, roughness: 0.72, metalness: 0.08 });

    const edgeAngle = Math.asin(4.5 / 9.6);
    const quadSpan = Math.PI / 2 - 2 * edgeAngle;

    const armPlaneGeo = getSharedPlaneGeo(5.5, 9.0);
    const armCurbGeoX = getSharedBoxGeo(1.52, 0.135, 0.24);
    const armCurbGeoZ = getSharedBoxGeo(0.24, 0.135, 1.52);
    const capCurbGeo = sharedGeo('rbCapCurb', () => new THREE.TorusGeometry(9.72, 0.13, 8, 12, 2 * edgeAngle));

    const armDefs: Array<{
      dir: 'E' | 'N' | 'W' | 'S';
      ax: number;
      az: number;
      rot: number;
      centerAngle: number;
      isHorizontalArm: boolean;
      curbs: Array<[number, number]>;
    }> = [
      { dir: 'E', ax: 7.25, az: 0, rot: 0, centerAngle: 0, isHorizontalArm: true, curbs: [[9.24, -4.62], [9.24, 4.62]] },
      { dir: 'N', ax: 0, az: -7.25, rot: Math.PI / 2, centerAngle: Math.PI / 2, isHorizontalArm: false, curbs: [[-4.62, -9.24], [4.62, -9.24]] },
      { dir: 'W', ax: -7.25, az: 0, rot: 0, centerAngle: Math.PI, isHorizontalArm: true, curbs: [[-9.24, -4.62], [-9.24, 4.62]] },
      { dir: 'S', ax: 0, az: 7.25, rot: Math.PI / 2, centerAngle: (3 * Math.PI) / 2, isHorizontalArm: false, curbs: [[-4.62, 9.24], [4.62, 9.24]] },
    ];

    const armGroups: Record<string, THREE.Group> = {};
    const capCurbs: Record<string, THREE.Mesh> = {};

    for (const def of armDefs) {
      const armGroup = new THREE.Group();
      armGroup.name = `armGroup_${def.dir}`;
      armGroups[def.dir] = armGroup;

      const arm = new THREE.Mesh(armPlaneGeo, armMat);
      arm.rotation.x = -Math.PI / 2;
      arm.rotation.z = def.rot;
      arm.position.set(def.ax, 0.011, def.az);
      arm.receiveShadow = true;
      armGroup.add(arm);

      const cGeo = def.isHorizontalArm ? armCurbGeoX : armCurbGeoZ;
      for (const [cx, cz] of def.curbs) {
        const curb = new THREE.Mesh(cGeo, curbMat);
        curb.position.set(cx, 0.0675, cz);
        curb.receiveShadow = true;
        armGroup.add(curb);
      }

      group.add(armGroup);

      const capCurb = new THREE.Mesh(capCurbGeo, curbMat);
      capCurb.name = `capCurb_${def.dir}`;
      capCurb.rotation.x = -Math.PI / 2;
      capCurb.rotation.z = def.centerAngle - edgeAngle;
      capCurb.scale.z = 0.65;
      capCurb.position.y = 0.055;
      capCurb.receiveShadow = true;
      capCurb.visible = false;
      capCurbs[def.dir] = capCurb;
      group.add(capCurb);
    }
    group.userData.roundaboutArmGroups = armGroups;
    group.userData.roundaboutCapCurbs = capCurbs;

    const circleDeck = new THREE.Mesh(
      sharedGeo('rbCircleDeck', () => new THREE.CircleGeometry(9.6, 48)),
      ringMat,
    );
    circleDeck.rotation.x = -Math.PI / 2;
    circleDeck.position.y = 0.014;
    circleDeck.receiveShadow = true;
    group.add(circleDeck);

    const quadCurbGeo = sharedGeo('rbQuadCurb', () => new THREE.TorusGeometry(9.72, 0.13, 8, 16, quadSpan));
    for (let q = 0; q < 4; q++) {
      const quadCurb = new THREE.Mesh(quadCurbGeo, curbMat);
      quadCurb.rotation.x = -Math.PI / 2;
      quadCurb.rotation.z = q * (Math.PI / 2) + edgeAngle;
      quadCurb.scale.z = 0.65;
      quadCurb.position.y = 0.055;
      quadCurb.receiveShadow = true;
      group.add(quadCurb);
    }

    const islandCurb = new THREE.Mesh(getSharedCylinderGeo(4.35, 4.5, 0.2, 36), curbMat);
    islandCurb.position.y = 0.1;
    islandCurb.castShadow = true;
    islandCurb.receiveShadow = true;
    group.add(islandCurb);

    const islandTurf = new THREE.Mesh(getSharedCylinderGeo(4.12, 4.18, 0.08, 32), turfMat);
    islandTurf.position.y = 0.22;
    islandTurf.receiveShadow = true;
    group.add(islandTurf);

    const plinth = new THREE.Mesh(getSharedCylinderGeo(1.15, 1.35, 0.28, 20), stoneMat);
    plinth.position.y = 0.36;
    plinth.castShadow = true;
    plinth.receiveShadow = true;
    group.add(plinth);

    const shrubGeo = getSharedDodecaGeo(0.55, 1);
    for (let s = 0; s < 4; s++) {
      const a = (s * Math.PI) / 2 + Math.PI / 4;
      const shrub = new THREE.Mesh(shrubGeo, shrubMat);
      shrub.scale.set(1.1, 0.72, 1.1);
      shrub.position.set(Math.cos(a) * 2.55, 0.45, Math.sin(a) * 2.55);
      shrub.castShadow = true;
      shrub.receiveShadow = true;
      group.add(shrub);
    }
  } else if (kind === 'road-culdesac') {
    const roadMat = getSharedRoadSurfaceMat('road-culdesac', maxAnisotropy);
    const curbMat = getSharedStdMat('road:curb', { color: 0x475569, roughness: 0.78, metalness: 0.06 });
    const turfMat = getSharedStdMat('road:turf', { color: 0x1d3b29, roughness: 0.9, metalness: 0.0 });

    const circleDeck = new THREE.Mesh(
      sharedGeo('circleDeck6', () => new THREE.CircleGeometry(6.0, 40)),
      roadMat,
    );
    circleDeck.rotation.x = -Math.PI / 2;
    circleDeck.position.y = 0.012;
    circleDeck.receiveShadow = true;
    group.add(circleDeck);

    const outerCurb = new THREE.Mesh(
      sharedGeo('culdesacCurb', () => new THREE.TorusGeometry(6.05, 0.14, 8, 44)),
      curbMat,
    );
    outerCurb.rotation.x = Math.PI / 2;
    outerCurb.scale.z = 0.6;
    outerCurb.position.y = 0.05;
    outerCurb.receiveShadow = true;
    group.add(outerCurb);

    const islandCurb = new THREE.Mesh(getSharedCylinderGeo(2.05, 2.2, 0.18, 28), curbMat);
    islandCurb.position.y = 0.09;
    islandCurb.castShadow = true;
    islandCurb.receiveShadow = true;
    group.add(islandCurb);

    const islandTurf = new THREE.Mesh(getSharedCylinderGeo(1.88, 1.92, 0.08, 24), turfMat);
    islandTurf.position.y = 0.19;
    islandTurf.receiveShadow = true;
    group.add(islandTurf);
  } else if (kind === 'road-deadend') {
    const roadMat = getSharedRoadSurfaceMat('road-deadend', maxAnisotropy);
    const neckMat = getSharedRoadSurfaceMat('road-2lane', maxAnisotropy);
    const curbMat = getSharedStdMat('road:curb', { color: 0x475569, roughness: 0.78, metalness: 0.06 });
    const turfMat = getSharedStdMat('road:turf', { color: 0x1d3b29, roughness: 0.9, metalness: 0.0 });

    const neck = new THREE.Mesh(getSharedPlaneGeo(6.0, 9.0), neckMat);
    neck.rotation.x = -Math.PI / 2;
    neck.position.set(-3.0, 0.011, 0);
    neck.receiveShadow = true;
    group.add(neck);

    const bulb = new THREE.Mesh(
      sharedGeo('circleDeck6', () => new THREE.CircleGeometry(6.0, 40)),
      roadMat,
    );
    bulb.rotation.x = -Math.PI / 2;
    bulb.position.y = 0.013;
    bulb.receiveShadow = true;
    group.add(bulb);

    const neckCurbGeo = getSharedBoxGeo(2.04, 0.135, 0.24);
    for (const side of [-1, 1]) {
      const neckCurb = new THREE.Mesh(neckCurbGeo, curbMat);
      neckCurb.position.set(-4.98, 0.0675, side * 4.62);
      neckCurb.receiveShadow = true;
      group.add(neckCurb);
    }

    const gapAngle = Math.asin(4.5 / 6.0);
    const arcLen = 2 * (Math.PI - gapAngle);
    const outerCurb = new THREE.Mesh(
      sharedGeo('deadendCurb', () => new THREE.TorusGeometry(6.05, 0.13, 8, 36, arcLen)),
      curbMat,
    );
    outerCurb.rotation.x = -Math.PI / 2;
    outerCurb.rotation.z = -(Math.PI - gapAngle);
    outerCurb.scale.z = 0.62;
    outerCurb.position.y = 0.055;
    outerCurb.receiveShadow = true;
    group.add(outerCurb);

    const islandCurb = new THREE.Mesh(getSharedCylinderGeo(1.9, 2.05, 0.18, 28), curbMat);
    islandCurb.position.y = 0.09;
    islandCurb.castShadow = true;
    islandCurb.receiveShadow = true;
    group.add(islandCurb);

    const islandTurf = new THREE.Mesh(getSharedCylinderGeo(1.74, 1.78, 0.08, 24), turfMat);
    islandTurf.position.y = 0.19;
    islandTurf.receiveShadow = true;
    group.add(islandTurf);
  } else if (kind === 'path-sidewalk') {
    const walkMat = getSharedRoadSurfaceMat('path-sidewalk', maxAnisotropy, 0.86, 0.02);
    const edgeMat = getSharedStdMat('path:edge', { color: 0x475569, roughness: 0.76, metalness: 0.08 });

    const baseSlab = new THREE.Mesh(getSharedBoxGeo(8.0, 0.05, 3.0), edgeMat);
    baseSlab.position.y = 0.005;
    baseSlab.receiveShadow = true;
    group.add(baseSlab);

    const topSurface = new THREE.Mesh(getSharedPlaneGeo(7.92, 2.74), walkMat);
    topSurface.rotation.x = -Math.PI / 2;
    topSurface.position.y = 0.032;
    topSurface.receiveShadow = true;
    group.add(topSurface);

    const borderGeo = getSharedBoxGeo(8.0, 0.06, 0.13);
    for (const side of [-1, 1]) {
      const border = new THREE.Mesh(borderGeo, edgeMat);
      border.position.set(0, 0.03, side * 1.44);
      border.receiveShadow = true;
      group.add(border);
    }
  } else if (kind === 'path-bike') {
    const bikeMat = getSharedRoadSurfaceMat('path-bike', maxAnisotropy, 0.8, 0.04);
    const curbMat = getSharedStdMat('bike:curb', { color: 0x334155, roughness: 0.72, metalness: 0.1 });
    const studMat = getSharedStdMat('bike:stud', {
      color: 0xfef3c7,
      emissive: 0xfbbf24,
      emissiveIntensity: 0.35,
      roughness: 0.3,
    });

    const deck = new THREE.Mesh(getSharedPlaneGeo(8.0, 2.4), bikeMat);
    deck.rotation.x = -Math.PI / 2;
    deck.position.y = 0.015;
    deck.receiveShadow = true;
    group.add(deck);

    const curbGeo = getSharedBoxGeo(8.0, 0.08, 0.14);
    const studGeo = getSharedBoxGeo(0.18, 0.025, 0.08);
    for (const side of [-1, 1]) {
      const curb = new THREE.Mesh(curbGeo, curbMat);
      curb.position.set(0, 0.04, side * 1.25);
      curb.receiveShadow = true;
      group.add(curb);

      for (const sx of [-2.8, 0, 2.8]) {
        const stud = new THREE.Mesh(studGeo, studMat);
        stud.position.set(sx, 0.085, side * 1.25);
        group.add(stud);
      }
    }
  } else if (kind === 'path-cobble') {
    const cobbleMat = getSharedRoadSurfaceMat('path-cobble', maxAnisotropy, 0.88, 0.03);
    const borderMat = getSharedStdMat('path:edge', { color: 0x475569, roughness: 0.74, metalness: 0.08 });

    const deck = new THREE.Mesh(getSharedPlaneGeo(6.0, 6.0), cobbleMat);
    deck.rotation.x = -Math.PI / 2;
    deck.position.y = 0.016;
    deck.receiveShadow = true;
    group.add(deck);

    const trimZGeo = getSharedBoxGeo(6.24, 0.055, 0.16);
    const trimXGeo = getSharedBoxGeo(0.16, 0.055, 6.0);
    for (const side of [-1, 1]) {
      const trimZ = new THREE.Mesh(trimZGeo, borderMat);
      trimZ.position.set(0, 0.027, side * 3.04);
      trimZ.receiveShadow = true;
      group.add(trimZ);

      const trimX = new THREE.Mesh(trimXGeo, borderMat);
      trimX.position.set(side * 3.04, 0.027, 0);
      trimX.receiveShadow = true;
      group.add(trimX);
    }
  } else if (kind === 'parking-lot') {
    const asphaltMat = getSharedStdMat('parking:asphalt', {
      color: 0x1e242d,
      roughness: 0.9,
      metalness: 0.05,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });
    const curbMat = getSharedStdMat('parking:curb', {
      color: 0x64748b,
      roughness: 0.78,
      metalness: 0.08,
    });
    const wheelStopMat = getSharedStdMat('parking:wheelStop', {
      color: 0x94a3b8,
      roughness: 0.8,
      metalness: 0.06,
    });
    const stripeMat = getSharedStdMat('parking:stripe', {
      color: 0xe2e8f0,
      roughness: 0.7,
      metalness: 0.04,
    });
    const adaBlueMat = getSharedStdMat('parking:adaBlue', {
      color: 0x2563eb,
      roughness: 0.68,
      metalness: 0.06,
    });
    const safetyYellowMat = getSharedStdMat('parking:safetyYellow', {
      color: 0xeab308,
      roughness: 0.55,
      metalness: 0.12,
    });

    // Main lot asphalt deck (12.6m x 9.2m) + flush road-connecting entrance apron (4.08m x 2.96m)
    const lotPad = new THREE.Mesh(getSharedPlaneGeo(12.6, 9.2), asphaltMat);
    lotPad.rotation.x = -Math.PI / 2;
    lotPad.position.y = 0.015;
    lotPad.receiveShadow = true;
    group.add(lotPad);

    const apron = new THREE.Mesh(getSharedPlaneGeo(4.08, 2.96), asphaltMat);
    apron.rotation.x = -Math.PI / 2;
    apron.position.set(0, 0.0135, 6.04);
    apron.receiveShadow = true;
    group.add(apron);

    // Concrete perimeter curbs with open entrance mouth on +Z
    const backCurb = new THREE.Mesh(getSharedBoxGeo(12.84, 0.12, 0.24), curbMat);
    backCurb.position.set(0, 0.06, -4.6);
    backCurb.castShadow = true;
    backCurb.receiveShadow = true;
    group.add(backCurb);

    const sideCurbGeo = getSharedBoxGeo(0.24, 0.12, 9.32);
    for (const sx of [-6.3, 6.3]) {
      const sCurb = new THREE.Mesh(sideCurbGeo, curbMat);
      sCurb.position.set(sx, 0.06, 0);
      sCurb.castShadow = true;
      sCurb.receiveShadow = true;
      group.add(sCurb);
    }

    const frontWingGeo = getSharedBoxGeo(4.36, 0.12, 0.24);
    for (const sx of [-4.22, 4.22]) {
      const fCurb = new THREE.Mesh(frontWingGeo, curbMat);
      fCurb.position.set(sx, 0.06, 4.6);
      fCurb.castShadow = true;
      fCurb.receiveShadow = true;
      group.add(fCurb);
    }

    // Yellow curb tips + entrance safety bollards flanking the driveway apron
    const tipGeo = getSharedBoxGeo(0.42, 0.124, 0.25);
    const bollardPostGeo = getSharedCylinderGeo(0.09, 0.1, 0.72, 10);
    const bollardBandGeo = getSharedCylinderGeo(0.094, 0.094, 0.14, 10);
    for (const sx of [-2.18, 2.18]) {
      const tip = new THREE.Mesh(tipGeo, safetyYellowMat);
      tip.position.set(sx, 0.062, 4.6);
      tip.receiveShadow = true;
      group.add(tip);

      const post = new THREE.Mesh(bollardPostGeo, curbMat);
      post.position.set(sx, 0.36, 4.6);
      post.castShadow = true;
      post.receiveShadow = true;
      group.add(post);

      const band = new THREE.Mesh(bollardBandGeo, safetyYellowMat);
      band.position.set(sx, 0.56, 4.6);
      group.add(band);
    }

    // Painted stall stripes (6 perpendicular bays: 3 west, 3 east, 4.0m deep x 2.85m wide)
    const stallLineGeo = getSharedPlaneGeo(4.0, 0.11);
    const endRailGeo = getSharedPlaneGeo(0.11, 8.66);
    const stallZBounds = [-4.275, -1.425, 1.425, 4.275];
    for (const colX of [-4.15, 4.15]) {
      const rail = new THREE.Mesh(endRailGeo, stripeMat);
      rail.rotation.x = -Math.PI / 2;
      rail.position.set(colX < 0 ? -6.12 : 6.12, 0.021, 0);
      rail.receiveShadow = true;
      group.add(rail);

      for (const lz of stallZBounds) {
        const isAdaEdge = colX > 0 && lz >= 1.4;
        const stripe = new THREE.Mesh(stallLineGeo, isAdaEdge ? adaBlueMat : stripeMat);
        stripe.rotation.x = -Math.PI / 2;
        stripe.position.set(colX, 0.021, lz);
        stripe.receiveShadow = true;
        group.add(stripe);
      }
    }

    // Accessible parking emblem in front-right stall (+4.15, +2.85)
    const adaBadge = new THREE.Mesh(getSharedPlaneGeo(0.92, 0.92), adaBlueMat);
    adaBadge.rotation.x = -Math.PI / 2;
    adaBadge.position.set(3.2, 0.021, 2.85);
    adaBadge.receiveShadow = true;
    group.add(adaBadge);

    const adaGlyph = new THREE.Mesh(getSharedPlaneGeo(0.46, 0.46), stripeMat);
    adaGlyph.rotation.x = -Math.PI / 2;
    adaGlyph.position.set(3.2, 0.022, 2.85);
    group.add(adaGlyph);

    // Center aisle entrance guide dashes
    const aisleDashGeo = getSharedPlaneGeo(0.11, 0.85);
    for (const dz of [2.1, 3.8]) {
      const dash = new THREE.Mesh(aisleDashGeo, stripeMat);
      dash.rotation.x = -Math.PI / 2;
      dash.position.set(0, 0.021, dz);
      dash.receiveShadow = true;
      group.add(dash);
    }

    // Concrete wheel-stop bumpers at back of all 6 stalls
    const wheelStopGeo = getSharedBoxGeo(0.18, 0.13, 1.55);
    const stallZs = [-2.85, 0.0, 2.85];
    for (const sz of stallZs) {
      for (const wx of [-5.65, 5.65]) {
        const stop = new THREE.Mesh(wheelStopGeo, wheelStopMat);
        stop.position.set(wx, 0.065, sz);
        stop.castShadow = true;
        stop.receiveShadow = true;
        group.add(stop);
      }
    }
  } else {
    // path-gravel
    const gravelMat = getSharedRoadSurfaceMat('path-gravel', maxAnisotropy, 0.94, 0.0);
    const timberMat = getSharedStdMat('gravel:timber', { color: 0x5c3d28, roughness: 0.88, metalness: 0.02 });
    const stoneMat = getSharedStdMat('gravel:stone', { color: 0x4b5563, roughness: 0.86, metalness: 0.04 });

    const trail = new THREE.Mesh(getSharedPlaneGeo(8.0, 2.2), gravelMat);
    trail.rotation.x = -Math.PI / 2;
    trail.position.y = 0.012;
    trail.receiveShadow = true;
    group.add(trail);

    const beamGeo = getSharedBoxGeo(8.0, 0.08, 0.11);
    for (const side of [-1, 1]) {
      const beam = new THREE.Mesh(beamGeo, timberMat);
      beam.position.set(0, 0.04, side * 1.14);
      beam.receiveShadow = true;
      group.add(beam);
    }

    const stoneGeo = sharedGeo('gravel:stoneGeo', () => new THREE.DodecahedronGeometry(0.14, 0));
    for (const [sx, sz] of [
      [-2.6, -0.92],
      [0.4, 0.9],
      [2.9, -0.9],
    ] as [number, number][]) {
      const stone = new THREE.Mesh(stoneGeo, stoneMat);
      stone.scale.set(1.3, 0.55, 1.0);
      stone.position.set(sx, 0.04, sz);
      stone.receiveShadow = true;
      group.add(stone);
    }
  }

  // Add a generous invisible click hitbox for slender street props & two-wheelers
  const hitboxInvisibleMat = getSharedBasicMat('hitbox:invisible', { visible: false });
  if (kind === 'traffic-light') {
    const hitGeo = getSharedCylinderGeo(0.65, 0.65, 3.2, 10);
    for (const [hx, hz] of [
      [0, 0],
      [-10.2, 0],
      [-10.2, -10.2],
      [0, -10.2],
    ] as [number, number][]) {
      const hitMesh = new THREE.Mesh(hitGeo, hitboxInvisibleMat);
      hitMesh.position.set(hx, 1.6, hz);
      hitMesh.name = 'targetHitbox';
      group.add(hitMesh);
    }
  } else if (kind === 'pedestrian' || kind === 'bollard') {
    const hitGeo =
      kind === 'pedestrian'
        ? getSharedCylinderGeo(0.45, 0.45, 1.85, 10)
        : getSharedCylinderGeo(0.35, 0.35, 1.15, 10);
    const hitMesh = new THREE.Mesh(hitGeo, hitboxInvisibleMat);
    hitMesh.position.y = kind === 'pedestrian' ? 0.92 : 0.58;
    hitMesh.name = 'targetHitbox';
    group.add(hitMesh);
  } else if (kind === 'bike' || kind === 'motorcycle') {
    const hitGeo =
      kind === 'bike'
        ? getSharedBoxGeo(1.9, 1.72, 0.72)
        : getSharedBoxGeo(2.2, 1.65, 0.88);
    const hitMesh = new THREE.Mesh(hitGeo, hitboxInvisibleMat);
    hitMesh.position.y = kind === 'bike' ? 0.86 : 0.82;
    hitMesh.name = 'targetHitbox';
    group.add(hitMesh);
  }

  // Assign interactive target metadata and raycast layer 1 to object meshes (excluding ground rings/shadows)
  group.traverse((obj) => {
    if ((obj as THREE.Mesh).isMesh && obj !== contactPlane && obj !== selectRing) {
      obj.userData.selectTargetId = id;
      obj.layers.enable(1);
    }
  });

  return group;
}

/**
 * Translucent cyan preview mesh used while placing items in Builder Mode.
 */
export function createBuilderGhostGroup(tool: Exclude<BuilderTool, null>): THREE.Group {
  const ghost = new THREE.Group();
  const ghostMat = new THREE.MeshBasicMaterial({
    color: 0x22d3ee,
    transparent: true,
    opacity: 0.32,
    depthWrite: false,
    wireframe: false,
  });
  const edgeMat = new THREE.MeshBasicMaterial({
    color: 0x67e8f9,
    transparent: true,
    opacity: 0.8,
    depthWrite: false,
  });

  const addBox = (w: number, h: number, d: number, x = 0, y = h * 0.5, z = 0) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), ghostMat);
    mesh.position.set(x, y, z);
    ghost.add(mesh);
  };

  if (tool === 'light') {
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.13, 8.0, 12), ghostMat);
    pole.position.set(0, 4.0, -1.0);
    ghost.add(pole);
    addBox(0.32, 0.14, 0.5, 0, 8.0, 0);
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.45, 0.6, 28), edgeMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.04;
    ghost.add(ring);
  } else if (tool === 'building-kiosk') {
    addBox(3.8, 3.8, 3.8);
  } else if (tool === 'building-small') {
    addBox(4.4, 6.3, 4.4);
  } else if (tool === 'building-tall') {
    addBox(5.1, 11.6, 5.1);
  } else if (tool === 'building-highrise') {
    addBox(5.6, 22.0, 5.6);
  } else if (tool === 'building-rowhouse') {
    addBox(9.4, 8.2, 4.6);
  } else if (tool === 'building-commercial') {
    addBox(10.6, 4.8, 4.8);
  } else if (tool === 'building-warehouse') {
    addBox(10.2, 7.4, 6.4);
  } else if (tool === 'building-civic') {
    addBox(10.4, 10.4, 6.8);
  } else if (tool === 'building-apartments') {
    addBox(9.0, 15.2, 7.0);
  } else if (tool === 'building-skyscraper') {
    addBox(7.8, 30.0, 6.2);
  } else if (tool === 'bike') {
    addBox(1.8, 1.62, 0.55);
  } else if (tool === 'motorcycle') {
    addBox(2.1, 1.56, 0.72);
  } else if (tool === 'sedan') {
    addBox(4.3, 1.3, 1.75);
  } else if (tool === 'van') {
    addBox(5.05, 2.32, 1.98);
  } else if (tool === 'truck') {
    addBox(6.75, 3.22, 2.26);
  } else if (tool === 'bus') {
    addBox(9.15, 3.05, 2.38);
  } else if (tool === 'pedestrian') {
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.24, 1.25, 4, 10), ghostMat);
    body.position.y = 0.88;
    ghost.add(body);
  } else if (tool === 'tree') {
    const crown = new THREE.Mesh(new THREE.DodecahedronGeometry(1.18, 1), ghostMat);
    crown.position.y = 2.9;
    ghost.add(crown);
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.2, 2.2, 8), ghostMat);
    trunk.position.y = 1.1;
    ghost.add(trunk);
  } else if (tool === 'hedge') {
    addBox(2.55, 1.08, 0.82);
  } else if (tool === 'bench') {
    addBox(1.86, 0.85, 0.6);
  } else if (tool === 'bollard') {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.16, 1.0, 12), ghostMat);
    post.position.y = 0.5;
    ghost.add(post);
  } else if (tool === 'traffic-light') {
    const poleGeo = new THREE.CylinderGeometry(0.11, 0.15, 6.0, 10);
    const barGeo = new THREE.BoxGeometry(8.6, 0.16, 0.16);
    const headGeo = new THREE.BoxGeometry(0.42, 1.05, 0.28);
    const cdGeo = new THREE.BoxGeometry(0.5, 0.46, 0.24);
    for (const [cx, cz, ry] of [
      [0, 0, 0],
      [-10.2, 0, -Math.PI / 2],
      [-10.2, -10.2, Math.PI],
      [0, -10.2, Math.PI / 2],
    ] as [number, number, number][]) {
      const rig = new THREE.Group();
      rig.position.set(cx, 0, cz);
      rig.rotation.y = ry;
      const mast = new THREE.Mesh(poleGeo, ghostMat);
      mast.position.y = 3.0;
      rig.add(mast);
      const bar = new THREE.Mesh(barGeo, ghostMat);
      bar.position.set(-4.3, 5.42, 0);
      rig.add(bar);
      for (const hx of [-7.8, -6.1, -3.4, -1.95]) {
        const h = new THREE.Mesh(headGeo, ghostMat);
        h.position.set(hx, 4.9, 0);
        rig.add(h);
      }
      const cd = new THREE.Mesh(cdGeo, ghostMat);
      cd.position.set(-4.75, 5.42, 0);
      rig.add(cd);
      ghost.add(rig);
    }
  } else if (tool === 'road-2lane') {
    addBox(8.0, 0.06, 9.0, 0, 0.03, 0);
  } else if (tool === 'road-intersection') {
    addBox(9.0, 0.06, 9.0, 0, 0.03, 0);
    addBox(8.88, 0.05, 3.0, 0, 0.025, 6.0);
    addBox(8.88, 0.05, 3.0, 0, 0.025, -6.0);
    addBox(3.0, 0.05, 8.88, 6.0, 0.025, 0);
    addBox(3.0, 0.05, 8.88, -6.0, 0.025, 0);
  } else if (tool === 'road-t-junction') {
    addBox(9.0, 0.06, 9.0, 0, 0.03, 0);
  } else if (tool === 'road-turn-90') {
    const curveGeo = createCurvedRoadStripGeometry(-6, 6, 1.5, 10.5, 0, Math.PI / 2, 20, 1);
    const curveMesh = new THREE.Mesh(curveGeo, ghostMat);
    curveMesh.position.y = 0.04;
    ghost.add(curveMesh);
  } else if (tool === 'road-curve-45') {
    const curveGeo = createCurvedRoadStripGeometry(
      -4.95,
      11.95,
      9.5,
      18.5,
      Math.PI / 4,
      Math.PI / 2,
      16,
      1,
    );
    const curveMesh = new THREE.Mesh(curveGeo, ghostMat);
    curveMesh.position.y = 0.04;
    ghost.add(curveMesh);
  } else if (tool === 'road-crosswalk') {
    addBox(6.0, 0.06, 9.0, 0, 0.03, 0);
  } else if (tool === 'road-roundabout') {
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(9.6, 9.6, 0.06, 36), ghostMat);
    disc.position.y = 0.03;
    ghost.add(disc);
    addBox(20.0, 0.05, 9.0, 0, 0.025, 0);
    addBox(9.0, 0.05, 20.0, 0, 0.025, 0);
  } else if (tool === 'road-culdesac' || tool === 'road-deadend') {
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(6.0, 6.0, 0.06, 32), ghostMat);
    disc.position.y = 0.03;
    ghost.add(disc);
    if (tool === 'road-deadend') {
      addBox(6.0, 0.05, 9.0, -3.0, 0.025, 0);
    }
  } else if (tool === 'path-sidewalk') {
    addBox(8.0, 0.06, 3.0, 0, 0.03, 0);
  } else if (tool === 'path-bike') {
    addBox(8.0, 0.06, 2.4, 0, 0.03, 0);
  } else if (tool === 'path-cobble') {
    addBox(6.0, 0.06, 6.0, 0, 0.03, 0);
  } else if (tool === 'path-gravel') {
    addBox(8.0, 0.06, 2.2, 0, 0.03, 0);
  } else if (tool === 'parking-lot') {
    addBox(12.8, 0.08, 9.4, 0, 0.04, 0);
    addBox(4.08, 0.08, 2.96, 0, 0.04, 6.04);
  } else {
    addBox(1.2, 1.12, 1.2);
  }

  // Base footprint outline ring
  const ringR =
    tool === 'road-roundabout'
      ? 10.4
      : tool === 'parking-lot'
        ? 7.1
        : tool === 'road-curve-45'
          ? 6.6
          : tool === 'road-turn-90'
            ? 6.4
            : tool === 'road-culdesac' || tool === 'road-deadend'
              ? 6.2
              : tool === 'road-intersection' || tool === 'road-t-junction'
                ? 5.2
                : tool === 'road-2lane'
                  ? 4.85
                  : tool === 'bus'
                    ? 4.8
                    : tool === 'road-crosswalk'
                      ? 4.6
                      : tool === 'building-civic'
                        ? 6.4
                        : tool === 'building-warehouse'
                          ? 6.2
                          : tool === 'building-apartments'
                            ? 6.0
                            : tool === 'building-commercial'
                              ? 5.8
                              : tool === 'building-rowhouse'
                                ? 5.4
                                : tool === 'building-skyscraper'
                                  ? 5.2
                                  : tool === 'building-highrise'
                                    ? 4.05
                                    : tool === 'truck'
                                      ? 3.7
                                      : tool === 'building-tall'
                                        ? 3.65
                                        : tool === 'path-cobble'
                                          ? 3.6
                                          : tool === 'path-sidewalk'
                                            ? 3.2
                                            : tool === 'building-small'
                                              ? 3.15
                                              : tool === 'path-bike'
                                                ? 3.0
                                                : tool === 'path-gravel'
                                                  ? 2.9
                                                  : tool === 'van'
                                                    ? 2.85
                                                    : tool === 'building-kiosk'
                                                      ? 2.65
                                                      : tool === 'sedan'
                                                        ? 2.35
                                            : tool === 'hedge'
                                              ? 1.45
                                              : tool === 'tree'
                                                ? 1.35
                                                : tool === 'motorcycle'
                                                  ? 1.25
                                                  : tool === 'bench'
                                                    ? 1.1
                                                    : tool === 'bike'
                                                      ? 1.05
                                                      : 0.72;
  const baseRing = new THREE.Mesh(new THREE.RingGeometry(ringR, ringR + 0.14, 36), edgeMat);
  baseRing.rotation.x = -Math.PI / 2;
  baseRing.position.y = 0.04;
  ghost.add(baseRing);

  return ghost;
}
