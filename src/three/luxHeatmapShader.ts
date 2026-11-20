import * as THREE from 'three';
import { LightFixture, SHIELD_SECTORS } from '../types/lighting';
import {
  computePeakCandela,
  degToRad,
  getAimDirection,
  getEffectiveAngleAtDeg,
  getEffectiveHalfAngleRad,
  getNadirEffectiveAngle,
  getShieldTransmittanceAtDeg,
  hasCustomSectorAngles,
} from '../utils/photometrics';

export const MAX_HEATMAP_LIGHTS = 8;
const SHIELD_LUT_WIDTH = 256;

export interface LuxOverlayUniformState {
  uLuxOverlayEnabled: { value: number };
  uLightPos: { value: THREE.Vector3[] };
  uLightAim: { value: THREE.Vector3[] };
  uLightParams: { value: THREE.Vector4[] };
  uLightHasShield: { value: Float32Array };
  uLightNadirAngle: { value: Float32Array };
  uShieldTex: { value: THREE.DataTexture };
  uLuxThreshold: { value: number };
}

export function createLuxOverlayUniformState(): LuxOverlayUniformState {
  const lightPos = Array.from({ length: MAX_HEATMAP_LIGHTS }, () => new THREE.Vector3());
  const lightAim = Array.from({ length: MAX_HEATMAP_LIGHTS }, () => new THREE.Vector3(0, -1, 0));
  const lightParams = Array.from({ length: MAX_HEATMAP_LIGHTS }, () => new THREE.Vector4(0, 0, 0, 0));
  const lightHasShield = new Float32Array(MAX_HEATMAP_LIGHTS);
  const lightNadirAngle = new Float32Array(MAX_HEATMAP_LIGHTS);

  const shieldData = new Uint8Array(SHIELD_LUT_WIDTH * MAX_HEATMAP_LIGHTS * 4);
  shieldData.fill(255);
  const shieldTex = new THREE.DataTexture(
    shieldData,
    SHIELD_LUT_WIDTH,
    MAX_HEATMAP_LIGHTS,
    THREE.RGBAFormat,
  );
  shieldTex.wrapS = THREE.RepeatWrapping;
  shieldTex.wrapT = THREE.ClampToEdgeWrapping;
  shieldTex.minFilter = THREE.LinearFilter;
  shieldTex.magFilter = THREE.LinearFilter;
  shieldTex.needsUpdate = true;

  return {
    uLuxOverlayEnabled: { value: 0 },
    uLightPos: { value: lightPos },
    uLightAim: { value: lightAim },
    uLightParams: { value: lightParams },
    uLightHasShield: { value: lightHasShield },
    uLightNadirAngle: { value: lightNadirAngle },
    uShieldTex: { value: shieldTex },
    uLuxThreshold: { value: 2.0 },
  };
}

export function disposeLuxOverlayState(state: LuxOverlayUniformState): void {
  state.uShieldTex.value.dispose();
}

const LUX_OVERLAY_VERT_PARS = /* glsl */ `
#include <normal_pars_vertex>
varying vec3 vLuxWorldPos;
varying vec3 vLuxWorldNormal;
`;

const LUX_OVERLAY_VERT_BODY = /* glsl */ `
#include <project_vertex>
vec4 luxWp = modelMatrix * vec4( transformed, 1.0 );
vLuxWorldPos = luxWp.xyz;
vec3 luxVn = normalize( transformedNormal + vec3( 0.0, 1e-5, 0.0 ) );
vLuxWorldNormal = normalize( vec3(
  dot( viewMatrix[0].xyz, luxVn ),
  dot( viewMatrix[1].xyz, luxVn ),
  dot( viewMatrix[2].xyz, luxVn )
) );
`;

const LUX_OVERLAY_FRAG_PARS = /* glsl */ `
#include <fog_pars_fragment>
uniform float uLuxOverlayEnabled;
uniform vec3 uLightPos[${MAX_HEATMAP_LIGHTS}];
uniform vec3 uLightAim[${MAX_HEATMAP_LIGHTS}];
uniform vec4 uLightParams[${MAX_HEATMAP_LIGHTS}];
uniform float uLightHasShield[${MAX_HEATMAP_LIGHTS}];
uniform float uLightNadirAngle[${MAX_HEATMAP_LIGHTS}];
uniform sampler2D uShieldTex;
uniform float uLuxThreshold;
varying vec3 vLuxWorldPos;
varying vec3 vLuxWorldNormal;

vec3 luxOverlayPalette(float t) {
  vec3 c0 = vec3(0.06, 0.42, 0.88); // ~1 lx vibrant cerulean
  vec3 c1 = vec3(0.04, 0.78, 0.90); // ~10 lx cyan
  vec3 c2 = vec3(0.14, 0.84, 0.48); // ~35 lx emerald
  vec3 c3 = vec3(0.98, 0.66, 0.08); // ~90 lx amber
  vec3 c4 = vec3(1.00, 0.95, 0.78); // ~250+ lx warm white

  if (t < 0.25) return mix(c0, c1, t / 0.25);
  if (t < 0.50) return mix(c1, c2, (t - 0.25) / 0.25);
  if (t < 0.75) return mix(c2, c3, (t - 0.50) / 0.25);
  return mix(c3, c4, (t - 0.75) / 0.25);
}

float luxOverlaySectorAngular(float cosTheta, float degAngle) {
  if (degAngle >= 179.5) return 1.0;
  float halfRad = radians(clamp(degAngle, 0.85, 180.0));
  float coneCos = cos(halfRad);
  float penAngle = max(halfRad * 0.82, halfRad - 0.078539816);
  float penCos = cos(max(0.0, penAngle));
  return smoothstep(coneCos, penCos, cosTheta);
}
`;

const LUX_OVERLAY_FRAG_BODY = /* glsl */ `
if (uLuxOverlayEnabled > 0.5) {
  float luxTotal = 0.0;
  vec3 luxSurfNormal = normalize(vLuxWorldNormal + vec3(0.0, 1e-5, 0.0));

  for (int i = 0; i < ${MAX_HEATMAP_LIGHTS}; i++) {
    vec4 params = uLightParams[i];
    if (params.x < 0.5) continue;

    vec3 delta = vLuxWorldPos - uLightPos[i];
    float distSq = max(dot(delta, delta), 0.09);
    vec3 ray = delta / sqrt(distSq);

    float cosIncidence = max(0.0, dot(luxSurfNormal, -ray));
    if (cosIncidence <= 0.0) continue;

    float cosTheta = clamp(dot(uLightAim[i], ray), -1.0, 1.0);
    float angular = 1.0;
    float shield = 1.0;
    float candelaRatio = 1.0;

    if (uLightHasShield[i] > 0.5) {
      float horiz = length(delta.xz);
      float rowV = (float(i) + 0.5) / float(${MAX_HEATMAP_LIGHTS});
      if (horiz < 0.06) {
        shield = texture2D(uShieldTex, vec2(0.0, rowV)).g;
        if (uLightHasShield[i] > 1.5) {
          angular = luxOverlaySectorAngular(cosTheta, uLightNadirAngle[i]);
        } else if (params.y > -1.5) {
          angular = smoothstep(params.y, params.z, cosTheta);
        }
      } else {
        float azimU = atan(delta.x, -delta.z) / 6.28318530718;
        vec4 lut = texture2D(uShieldTex, vec2(azimU, rowV));
        shield = lut.r;
        if (uLightHasShield[i] > 1.5) {
          angular = luxOverlaySectorAngular(cosTheta, lut.b * 180.0);
          candelaRatio = lut.a;
        } else if (params.y > -1.5) {
          angular = smoothstep(params.y, params.z, cosTheta);
        }
      }
    } else if (params.y > -1.5) {
      angular = smoothstep(params.y, params.z, cosTheta);
    }

    luxTotal += (params.w * candelaRatio * angular * shield * cosIncidence) / distSq;
  }

  float threshold = max(0.1, uLuxThreshold);
  if (luxTotal >= threshold * 0.99) {
    float minLog = log2(threshold);
    float maxLog = log2(max(threshold * 16.0, 250.0));
    float curLog = log2(max(luxTotal, threshold));
    float t = clamp((curLog - minLog) / max(maxLog - minLog, 0.5), 0.0, 1.0);
    vec3 col = luxOverlayPalette(t);

    // Subtle photometric contour isolines every 1.0 log2 step inside the highlighted footprint
    float frac = abs(fract(log2(luxTotal + 1.0)) - 0.5);
    float isoline = 1.0 - smoothstep(0.43, 0.485, frac);
    col = mix(col, vec3(1.0), isoline * 0.24);

    // Crisp cyan perimeter contour right at the active Lux Threshold boundary
    float threshDist = abs(log2(max(luxTotal, 0.01)) - minLog);
    float threshMask = smoothstep(threshold * 0.99, threshold * 1.005, luxTotal);
    float threshContour = (1.0 - smoothstep(0.015, 0.08, threshDist)) * threshMask;

    float edgeFade = smoothstep(threshold * 0.992, threshold * 1.012, luxTotal);
    float fillBlend = clamp((0.44 + 0.14 * t) * edgeFade, 0.0, 0.58);
    gl_FragColor.rgb = mix(gl_FragColor.rgb, col, fillBlend);
    gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(0.55, 0.98, 1.0), threshContour * 0.72);
  }
}
#include <fog_fragment>
`;

export function attachLuxOverlayToMaterial(
  mat: THREE.Material,
  state: LuxOverlayUniformState,
): void {
  if (!(mat as THREE.MeshStandardMaterial).isMeshStandardMaterial) return;
  if (mat.transparent || mat.userData.skipLuxOverlay) return;

  if (mat.userData.luxOverlayTargetState === state) return;
  mat.userData.luxOverlayTargetState = state;

  if (mat.userData.luxOverlayAttached) {
    mat.needsUpdate = true;
    return;
  }

  mat.userData.luxOverlayAttached = true;

  const prevOnBeforeCompile = mat.onBeforeCompile;
  const prevCacheKey = mat.customProgramCacheKey;

  mat.customProgramCacheKey = () => {
    const base = prevCacheKey ? prevCacheKey.call(mat) : '';
    return base ? `${base}|lux-overlay-v1` : 'lux-overlay-v1';
  };

  mat.onBeforeCompile = (shader, renderer) => {
    if (prevOnBeforeCompile) {
      prevOnBeforeCompile.call(mat, shader, renderer);
    }

    const activeState = (mat.userData.luxOverlayTargetState as LuxOverlayUniformState | undefined) ?? state;
    shader.uniforms.uLuxOverlayEnabled = activeState.uLuxOverlayEnabled;
    shader.uniforms.uLightPos = activeState.uLightPos;
    shader.uniforms.uLightAim = activeState.uLightAim;
    shader.uniforms.uLightParams = activeState.uLightParams;
    shader.uniforms.uLightHasShield = activeState.uLightHasShield;
    shader.uniforms.uLightNadirAngle = activeState.uLightNadirAngle;
    shader.uniforms.uShieldTex = activeState.uShieldTex;
    shader.uniforms.uLuxThreshold = activeState.uLuxThreshold;

    shader.vertexShader = shader.vertexShader
      .replace('#include <normal_pars_vertex>', LUX_OVERLAY_VERT_PARS)
      .replace('#include <project_vertex>', LUX_OVERLAY_VERT_BODY);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <fog_pars_fragment>', LUX_OVERLAY_FRAG_PARS)
      .replace('#include <fog_fragment>', LUX_OVERLAY_FRAG_BODY);
  };

  mat.needsUpdate = true;
}

export function attachLuxOverlayToObject(
  root: THREE.Object3D,
  state: LuxOverlayUniformState,
): void {
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh || mesh.userData.skipLuxOverlay) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const mat of mats) {
      if (mat) {
        attachLuxOverlayToMaterial(mat, state);
      }
    }
  });
}

export function updateLuxOverlayUniforms(
  state: LuxOverlayUniformState,
  fixtures: LightFixture[],
  enabled: boolean,
  luxThreshold = 2.0,
): void {
  state.uLuxOverlayEnabled.value = enabled ? 1.0 : 0.0;
  state.uLuxThreshold.value = Math.max(0.1, luxThreshold);
  if (!enabled) return;

  const posArr = state.uLightPos.value;
  const aimArr = state.uLightAim.value;
  const paramArr = state.uLightParams.value;
  const hasShieldArr = state.uLightHasShield.value;
  const nadirAngleArr = state.uLightNadirAngle.value;
  const shieldTex = state.uShieldTex.value;
  const texData = shieldTex.image.data as Uint8Array;
  let texDirty = false;

  const activeFixtures = fixtures.filter((f) => f.enabled && f.lumens > 0);
  for (let i = 0; i < MAX_HEATMAP_LIGHTS; i++) {
    const f = activeFixtures[i];
    if (!f) {
      paramArr[i].set(0, 0, 0, 0);
      hasShieldArr[i] = 0;
      continue;
    }

    posArr[i].set(f.position.x, f.height, f.position.z);
    const aim = getAimDirection(f.tiltAngle, f.yawAngle);
    aimArr[i].set(aim.x, aim.y, aim.z).normalize();

    let coneCos = -2.0;
    let penumbraCos = -2.0;
    if (f.angleRange < 179.5) {
      const halfRad = getEffectiveHalfAngleRad(f.angleRange);
      coneCos = Math.cos(halfRad);
      const penAngle = Math.max(halfRad * 0.82, halfAngleMinusMargin(halfRad));
      penumbraCos = Math.cos(Math.max(0, penAngle));
    }

    const peakCandela = computePeakCandela(f.lumens, f.angleRange);
    paramArr[i].set(1.0, coneCos, penumbraCos, peakCandela);

    const mask = (f.shieldSectors ?? 0) & ((1 << SHIELD_SECTORS) - 1);
    const hasCustom = hasCustomSectorAngles(f.sectorAngles);

    if (mask === 0 && !hasCustom) {
      if (hasShieldArr[i] !== 0) {
        hasShieldArr[i] = 0;
      }
    } else {
      hasShieldArr[i] = hasCustom ? 2.0 : 1.0;
      nadirAngleArr[i] = hasCustom ? getNadirEffectiveAngle(f) : f.angleRange;

      let openCount = 0;
      for (let s = 0; s < SHIELD_SECTORS; s++) {
        if (((mask >> s) & 1) === 0) openCount++;
      }
      const avgByte = Math.round((openCount / SHIELD_SECTORS) * 255);
      const baseUnitCandela = computePeakCandela(1, f.angleRange);
      const rowOffset = i * SHIELD_LUT_WIDTH * 4;
      for (let col = 0; col < SHIELD_LUT_WIDTH; col++) {
        const deg = (col / SHIELD_LUT_WIDTH) * 360;
        const val = mask === 0 ? 255 : Math.round(getShieldTransmittanceAtDeg(mask, deg) * 255);
        const effAngle = hasCustom
          ? getEffectiveAngleAtDeg(f.angleRange, f.sectorAngles, deg)
          : f.angleRange;
        const angleByte = Math.round((Math.max(0, Math.min(180, effAngle)) / 180) * 255);
        const candelaRatio =
          effAngle > f.angleRange
            ? Math.min(1, computePeakCandela(1, effAngle) / baseUnitCandela)
            : 1;
        const ratioByte = Math.round(candelaRatio * 255);

        const idx = rowOffset + col * 4;
        if (
          texData[idx] !== val ||
          texData[idx + 1] !== avgByte ||
          texData[idx + 2] !== angleByte ||
          texData[idx + 3] !== ratioByte
        ) {
          texData[idx] = val;
          texData[idx + 1] = avgByte;
          texData[idx + 2] = angleByte;
          texData[idx + 3] = ratioByte;
          texDirty = true;
        }
      }
    }
  }

  if (texDirty) {
    shieldTex.needsUpdate = true;
  }
}

function halfAngleMinusMargin(halfRad: number): number {
  return halfRad - degToRad(4.5);
}
