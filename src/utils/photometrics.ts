import { LightFixture, MAP_HALF_X, MAP_HALF_Z, ScenePreset, SHIELD_SECTORS, StreetTarget } from '../types/lighting';

export interface RgbColor {
  r: number; // 0..1
  g: number; // 0..1
  b: number; // 0..1
}

export function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

export function degToRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/**
 * Converts Kelvin color temperature (1800K - 10000K) into normalized linear-ish RGB [0..1]
 * using Tanner Helland's blackbody Planckian locus approximation.
 */
export function kelvinToRgb(kelvin: number): RgbColor {
  const temp = clamp(kelvin, 1000, 40000) / 100;
  let r: number;
  let g: number;
  let b: number;

  if (temp <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(temp) - 161.1195681661;
    if (temp <= 19) {
      b = 0;
    } else {
      b = 138.5177312231 * Math.log(temp - 10) - 305.0447927307;
    }
  } else {
    r = 329.698727446 * Math.pow(temp - 60, -0.1332047592);
    g = 288.1221695283 * Math.pow(temp - 60, -0.0755148492);
    b = 255;
  }

  return {
    r: clamp(r, 0, 255) / 255,
    g: clamp(g, 0, 255) / 255,
    b: clamp(b, 0, 255) / 255,
  };
}

export function hexToRgb(hex: string): RgbColor {
  const clean = hex.replace('#', '');
  if (clean.length === 3) {
    const r = parseInt(clean[0] + clean[0], 16);
    const g = parseInt(clean[1] + clean[1], 16);
    const b = parseInt(clean[2] + clean[2], 16);
    return { r: r / 255, g: g / 255, b: b / 255 };
  }
  const num = parseInt(clean, 16);
  if (Number.isNaN(num)) return { r: 1, g: 0.95, b: 0.85 };
  return {
    r: ((num >> 16) & 255) / 255,
    g: ((num >> 8) & 255) / 255,
    b: (num & 255) / 255,
  };
}

export function rgbToHex(rgb: RgbColor): string {
  const toHex = (c: number) =>
    clamp(Math.round(c * 255), 0, 255)
      .toString(16)
      .padStart(2, '0');
  return `#${toHex(rgb.r)}${toHex(rgb.g)}${toHex(rgb.b)}`;
}

export function getFixtureRgb(fixture: LightFixture): RgbColor {
  return fixture.useCustomColor ? hexToRgb(fixture.customColor) : kelvinToRgb(fixture.kelvin);
}

export function getFixtureHex(fixture: LightFixture): string {
  return fixture.useCustomColor ? fixture.customColor : rgbToHex(kelvinToRgb(fixture.kelvin));
}

/**
 * Unit aim direction vector for a fixture:
 * - tiltAngle = 0 deg -> (0, -1, 0) straight down nadir
 * - tiltAngle = 90 deg, yawAngle = 0 deg -> (0, 0, 1) horizontal across street (+Z)
 * - tiltAngle = 90 deg, yawAngle = 90 deg -> (1, 0, 0) horizontal along street (+X)
 * - tiltAngle = 180 deg -> (0, +1, 0) straight up zenith
 */
export function getAimDirection(tiltAngleDeg: number, yawAngleDeg: number): { x: number; y: number; z: number } {
  const tilt = degToRad(clamp(tiltAngleDeg, 0, 180));
  const yaw = degToRad(yawAngleDeg);
  const sinT = Math.sin(tilt);
  return {
    x: Math.sin(yaw) * sinT,
    y: -Math.cos(tilt),
    z: Math.cos(yaw) * sinT,
  };
}

/**
 * Effective beam half-angle in radians.
 * Clamped to >= 0.85 deg so 0 deg straight beam produces a crisp concentrated ray without division by zero.
 */
export function getEffectiveHalfAngleRad(angleRangeDeg: number): number {
  return degToRad(clamp(angleRangeDeg, 0.85, 180));
}

/**
 * Computes peak axial luminous intensity (candela) from luminous flux (lumens) and beam half-angle.
 * Uses solid angle Omega = 2 * PI * (1 - cos(theta_max)), smoothly transitioning to 4 * PI at 180 deg.
 */
export function computePeakCandela(lumens: number, angleRangeDeg: number): number {
  const halfAngle = getEffectiveHalfAngleRad(angleRangeDeg);
  const solidAngle = Math.max(2 * Math.PI * (1 - Math.cos(halfAngle)), 0.0014);
  // Slight axial weighting boost for directional optics, converging cleanly to 1.0 at 180 deg (isotropic point source)
  const directionality = 1 + 0.35 * (1 - clamp(angleRangeDeg, 0, 180) / 180);
  return (lumens / solidAngle) * directionality;
}

const SECTOR_DEG = 360 / SHIELD_SECTORS;

/**
 * Returns optical transmittance [0..1] for a given world compass azimuth in degrees
 * (0° = North -Z, 90° = East +X, 180° = South +Z, 270° = West -X) with smooth 2.5° baffle edges.
 */
export function getShieldTransmittanceAtDeg(
  shieldMask: number | undefined,
  azimuthDeg: number,
): number {
  const mask = (shieldMask ?? 0) & ((1 << SHIELD_SECTORS) - 1);
  if (mask === 0) return 1;

  const deg = ((azimuthDeg % 360) + 360) % 360;
  const sector = Math.floor(deg / SECTOR_DEG) % SHIELD_SECTORS;
  const f = deg - sector * SECTOR_DEG;
  const curBlocked = ((mask >> sector) & 1) !== 0;
  const baseVal = curBlocked ? 0 : 1;

  const edgeWidth = 2.5;
  if (f < edgeWidth) {
    const prev = (sector + SHIELD_SECTORS - 1) % SHIELD_SECTORS;
    const prevBlocked = ((mask >> prev) & 1) !== 0;
    if (prevBlocked !== curBlocked) {
      const t = (f / edgeWidth + 1) * 0.5; // 0.5 at boundary -> 1.0 inside sector
      const smooth = t * t * (3 - 2 * t);
      return curBlocked ? 1 - smooth : smooth;
    }
  } else if (f > SECTOR_DEG - edgeWidth) {
    const next = (sector + 1) % SHIELD_SECTORS;
    const nextBlocked = ((mask >> next) & 1) !== 0;
    if (nextBlocked !== curBlocked) {
      const t = ((SECTOR_DEG - f) / edgeWidth + 1) * 0.5;
      const smooth = t * t * (3 - 2 * t);
      return curBlocked ? 1 - smooth : smooth;
    }
  }

  return baseVal;
}

export function getShieldTransmittance(
  fixture: LightFixture,
  dx: number,
  dz: number,
): number {
  const mask = (fixture.shieldSectors ?? 0) & ((1 << SHIELD_SECTORS) - 1);
  if (mask === 0) return 1;
  const horiz = Math.hypot(dx, dz);
  if (horiz < 0.06) {
    // Avoid singularity directly below luminaire nadir unless completely covered
    let openCount = 0;
    for (let i = 0; i < SHIELD_SECTORS; i++) {
      if (((mask >> i) & 1) === 0) openCount++;
    }
    return openCount / SHIELD_SECTORS;
  }
  const azimDeg = (Math.atan2(dx, -dz) * 180) / Math.PI;
  return getShieldTransmittanceAtDeg(mask, azimDeg);
}

export function getBlockedDegrees(shieldMask: number | undefined): number {
  const mask = (shieldMask ?? 0) & ((1 << SHIELD_SECTORS) - 1);
  let count = 0;
  for (let i = 0; i < SHIELD_SECTORS; i++) {
    if (((mask >> i) & 1) !== 0) count++;
  }
  return Math.round(count * SECTOR_DEG);
}

export function hasCustomSectorAngles(
  sectorAngles: Record<number, number> | undefined,
): boolean {
  if (!sectorAngles) return false;
  for (let i = 0; i < SHIELD_SECTORS; i++) {
    if (sectorAngles[i] !== undefined) return true;
  }
  return false;
}

export function getSectorAnglesSignature(
  sectorAngles: Record<number, number> | undefined,
): string {
  if (!sectorAngles) return '';
  let sig = '';
  for (let i = 0; i < SHIELD_SECTORS; i++) {
    const v = sectorAngles[i];
    if (v !== undefined) {
      sig += `${sig ? ',' : ''}${i}:${Math.round(clamp(v, 0, 180))}`;
    }
  }
  return sig;
}

export function getSectorAngle(
  baseAngleDeg: number,
  sectorAngles: Record<number, number> | undefined,
  sector: number,
): number {
  const raw = sectorAngles?.[sector];
  return raw !== undefined ? clamp(raw, 0, 180) : baseAngleDeg;
}

export function getMaxEffectiveAngle(
  fixture: Pick<LightFixture, 'angleRange' | 'shieldSectors' | 'sectorAngles'>,
): number {
  let maxA = fixture.angleRange;
  if (!fixture.sectorAngles) return maxA;
  const mask = (fixture.shieldSectors ?? 0) & ((1 << SHIELD_SECTORS) - 1);
  for (let i = 0; i < SHIELD_SECTORS; i++) {
    if (((mask >> i) & 1) !== 0) continue;
    const v = fixture.sectorAngles[i];
    if (v !== undefined && v > maxA) {
      maxA = clamp(v, 0, 180);
    }
  }
  return maxA;
}

export function getNadirEffectiveAngle(
  fixture: Pick<LightFixture, 'angleRange' | 'shieldSectors' | 'sectorAngles'>,
): number {
  if (!fixture.sectorAngles) return fixture.angleRange;
  const mask = (fixture.shieldSectors ?? 0) & ((1 << SHIELD_SECTORS) - 1);
  let sum = 0;
  let count = 0;
  for (let i = 0; i < SHIELD_SECTORS; i++) {
    if (((mask >> i) & 1) !== 0) continue;
    sum += getSectorAngle(fixture.angleRange, fixture.sectorAngles, i);
    count++;
  }
  return count > 0 ? sum / count : fixture.angleRange;
}

/**
 * Returns effective beam half-angle [0..180 deg] for a given world compass azimuth in degrees
 * with smooth 2.5° boundary blending between adjacent shield sectors.
 */
export function getEffectiveAngleAtDeg(
  baseAngleDeg: number,
  sectorAngles: Record<number, number> | undefined,
  azimuthDeg: number,
): number {
  if (!sectorAngles) return baseAngleDeg;
  const deg = ((azimuthDeg % 360) + 360) % 360;
  const sector = Math.floor(deg / SECTOR_DEG) % SHIELD_SECTORS;
  const f = deg - sector * SECTOR_DEG;
  const curAngle = getSectorAngle(baseAngleDeg, sectorAngles, sector);

  const edgeWidth = 2.5;
  if (f < edgeWidth) {
    const prev = (sector + SHIELD_SECTORS - 1) % SHIELD_SECTORS;
    const prevAngle = getSectorAngle(baseAngleDeg, sectorAngles, prev);
    if (Math.abs(prevAngle - curAngle) > 0.05) {
      const t = (f / edgeWidth + 1) * 0.5;
      const smooth = t * t * (3 - 2 * t);
      return prevAngle + (curAngle - prevAngle) * smooth;
    }
  } else if (f > SECTOR_DEG - edgeWidth) {
    const next = (sector + 1) % SHIELD_SECTORS;
    const nextAngle = getSectorAngle(baseAngleDeg, sectorAngles, next);
    if (Math.abs(nextAngle - curAngle) > 0.05) {
      const t = ((SECTOR_DEG - f) / edgeWidth + 1) * 0.5;
      const smooth = t * t * (3 - 2 * t);
      return nextAngle + (curAngle - nextAngle) * smooth;
    }
  }

  return curAngle;
}

export function computeAngularFactorFromDeg(cosTheta: number, angleDeg: number): number {
  if (angleDeg >= 179.5) return 1;
  const halfAngleRad = getEffectiveHalfAngleRad(angleDeg);
  const coneCos = Math.cos(halfAngleRad);
  if (cosTheta <= coneCos) return 0;
  const penumbraAngle = Math.max(halfAngleRad * 0.82, halfAngleRad - degToRad(4.5));
  const penumbraCos = Math.cos(Math.max(0, penumbraAngle));
  if (cosTheta < penumbraCos && penumbraCos > coneCos) {
    const t = (cosTheta - coneCos) / (penumbraCos - coneCos);
    return t * t * (3 - 2 * t);
  }
  return 1;
}

/**
 * Computes analytical inverse-square illuminance (in Lux = lm/m^2) at a 3D surface point with surface normal
 * across all enabled fixtures. Matches the GLSL ground lux overlay math.
 */
export function computeIlluminanceAtPoint(
  point: { x: number; y: number; z: number },
  normal: { x: number; y: number; z: number },
  fixtures: LightFixture[],
): number {
  let totalLux = 0;

  for (const f of fixtures) {
    if (!f.enabled) continue;

    const dx = point.x - f.position.x;
    const dy = point.y - f.height;
    const dz = point.z - f.position.z;
    const distSq = Math.max(dx * dx + dy * dy + dz * dz, 0.09);
    const dist = Math.sqrt(distSq);

    // Ray from fixture to surface point
    const ux = dx / dist;
    const uy = dy / dist;
    const uz = dz / dist;

    // Cosine of angle between surface normal and incoming light vector (-u)
    const cosIncidence = normal.x * -ux + normal.y * -uy + normal.z * -uz;
    if (cosIncidence <= 0) continue;

    const aim = getAimDirection(f.tiltAngle, f.yawAngle);
    const cosTheta = clamp(aim.x * ux + aim.y * uy + aim.z * uz, -1, 1);

    const hasCustom = hasCustomSectorAngles(f.sectorAngles);
    const horiz = Math.hypot(dx, dz);
    const azimDeg = horiz >= 0.06 ? (Math.atan2(dx, -dz) * 180) / Math.PI : 0;
    const effAngle = hasCustom
      ? horiz >= 0.06
        ? getEffectiveAngleAtDeg(f.angleRange, f.sectorAngles, azimDeg)
        : getNadirEffectiveAngle(f)
      : f.angleRange;

    const angularFactor = computeAngularFactorFromDeg(cosTheta, effAngle);
    if (angularFactor <= 0) continue;

    const shieldFactor = getShieldTransmittance(f, dx, dz);
    if (shieldFactor <= 0) continue;

    const peakCandela =
      effAngle > f.angleRange
        ? computePeakCandela(f.lumens, effAngle)
        : computePeakCandela(f.lumens, f.angleRange);
    totalLux += (peakCandela * angularFactor * shieldFactor * cosIncidence) / distSq;
  }

  return totalLux;
}

interface CompiledFixture {
  px: number;
  py: number;
  pz: number;
  aimX: number;
  aimY: number;
  aimZ: number;
  lumens: number;
  baseAngleDeg: number;
  isNarrowCone: boolean;
  coneCos: number;
  penumbraCos: number;
  hasPenumbraSpan: boolean;
  shieldMask: number;
  nadirOpen: number;
  hasCustomAngles: boolean;
  sectorAngles?: Record<number, number>;
  nadirAngle: number;
  peakCandela: number;
  maxRangeSq: number;
}

const FULL_SHIELD_BITS = (1 << SHIELD_SECTORS) - 1;

function compileFixtureForGrid(f: LightFixture): CompiledFixture {
  const aim = getAimDirection(f.tiltAngle, f.yawAngle);
  const isNarrowCone = f.angleRange < 179.5;
  const halfAngleRad = getEffectiveHalfAngleRad(f.angleRange);
  const coneCos = Math.cos(halfAngleRad);
  const penumbraAngle = Math.max(halfAngleRad * 0.82, halfAngleRad - degToRad(4.5));
  const penumbraCos = Math.cos(Math.max(0, penumbraAngle));
  const shieldMask = (f.shieldSectors ?? 0) & FULL_SHIELD_BITS;
  const hasCustom = hasCustomSectorAngles(f.sectorAngles);
  let openCount = 0;
  if (shieldMask !== 0) {
    for (let i = 0; i < SHIELD_SECTORS; i++) {
      if (((shieldMask >> i) & 1) === 0) openCount++;
    }
  }
  const peakCandela = computePeakCandela(f.lumens, f.angleRange);
  const minSampleLux = 0.02;
  const maxRangeSq = Math.pow(Math.max(1, (peakCandela * Math.max(f.height, 0.25)) / minSampleLux), 2 / 3);
  return {
    px: f.position.x,
    py: f.height,
    pz: f.position.z,
    aimX: aim.x,
    aimY: aim.y,
    aimZ: aim.z,
    lumens: f.lumens,
    baseAngleDeg: f.angleRange,
    isNarrowCone,
    coneCos,
    penumbraCos,
    hasPenumbraSpan: penumbraCos > coneCos,
    shieldMask,
    nadirOpen: shieldMask === 0 ? 1 : openCount / SHIELD_SECTORS,
    hasCustomAngles: hasCustom,
    sectorAngles: hasCustom ? f.sectorAngles : undefined,
    nadirAngle: hasCustom ? getNadirEffectiveAngle(f) : f.angleRange,
    peakCandela,
    maxRangeSq,
  };
}

/**
 * Samples a fine 0.5m grid across the street corridor to report peak ground lux,
 * illuminated area (>= luxThreshold), and beam center ground throw distance.
 */
export function computeScenePhotometrics(
  fixtures: LightFixture[],
  activeFixture: LightFixture | undefined,
  luxThreshold = 2.0,
): {
  peakGroundLux: number;
  footprintAreaSqM: number;
  centerThrowDistM: number | null;
} {
  let peakGroundLux = 0;
  let litCells = 0;
  const threshold = Math.max(0.1, luxThreshold);
  const step = 0.5;
  const compiled: CompiledFixture[] = [];
  for (const f of fixtures) {
    if (f.enabled && f.lumens > 0) {
      compiled.push(compileFixtureForGrid(f));
    }
  }

  if (compiled.length > 0) {
    const radToDeg = 180 / Math.PI;
    for (let x = -MAP_HALF_X; x <= MAP_HALF_X; x += step) {
      for (let z = -MAP_HALF_Z; z <= MAP_HALF_Z; z += step) {
        let lux = 0;
        for (let i = 0; i < compiled.length; i++) {
          const cf = compiled[i];
          const dx = x - cf.px;
          const dy = -cf.py;
          const dz = z - cf.pz;
          const rawDistSq = dx * dx + dy * dy + dz * dz;
          if (rawDistSq > cf.maxRangeSq) continue;
          const distSq = Math.max(rawDistSq, 0.09);
          const invDist = 1 / Math.sqrt(distSq);
          const ux = dx * invDist;
          const uy = dy * invDist;
          const uz = dz * invDist;

          const cosIncidence = -uy;
          if (cosIncidence <= 0) continue;

          const cosTheta = clamp(cf.aimX * ux + cf.aimY * uy + cf.aimZ * uz, -1, 1);
          const needAzim = cf.shieldMask !== 0 || cf.hasCustomAngles;
          const horizSq = needAzim ? dx * dx + dz * dz : 1;
          const azimDeg =
            needAzim && horizSq >= 0.0036 ? Math.atan2(dx, -dz) * radToDeg : 0;

          let angularFactor = 1;
          let effPeakCandela = cf.peakCandela;
          if (cf.hasCustomAngles) {
            const effAngle =
              horizSq < 0.0036
                ? cf.nadirAngle
                : getEffectiveAngleAtDeg(cf.baseAngleDeg, cf.sectorAngles, azimDeg);
            angularFactor = computeAngularFactorFromDeg(cosTheta, effAngle);
            if (angularFactor <= 0) continue;
            if (effAngle > cf.baseAngleDeg) {
              effPeakCandela = computePeakCandela(cf.lumens, effAngle);
            }
          } else if (cf.isNarrowCone) {
            if (cosTheta <= cf.coneCos) {
              continue;
            } else if (cosTheta < cf.penumbraCos && cf.hasPenumbraSpan) {
              const t = (cosTheta - cf.coneCos) / (cf.penumbraCos - cf.coneCos);
              angularFactor = t * t * (3 - 2 * t);
            }
          }

          let shieldFactor = 1;
          if (cf.shieldMask !== 0) {
            shieldFactor =
              horizSq < 0.0036
                ? cf.nadirOpen
                : getShieldTransmittanceAtDeg(cf.shieldMask, azimDeg);
            if (shieldFactor <= 0) continue;
          }

          lux += (effPeakCandela * angularFactor * shieldFactor * cosIncidence) / distSq;
        }
        if (lux > peakGroundLux) peakGroundLux = lux;
        if (lux >= threshold) litCells++;
      }
    }
  }

  let centerThrowDistM: number | null = null;
  if (activeFixture && activeFixture.enabled) {
    const aim = getAimDirection(activeFixture.tiltAngle, activeFixture.yawAngle);
    if (aim.y < -0.02) {
      // Intersect center ray with ground y = 0
      centerThrowDistM = activeFixture.height / -aim.y;
    }
  }

  return {
    peakGroundLux,
    footprintAreaSqM: Math.round(litCells * step * step),
    centerThrowDistM,
  };
}

const CORRIDOR_SCENERY_TARGETS: StreetTarget[] = [
  // Organized 4-Avenue × 3-Street Downtown City Grid (zero-gap modular grid alignment)
  // Horizontal corridors: North Blvd (z = -25.0), Main Street (z = 0.0), South Blvd (z = +25.0)
  // Vertical avenues: 1st Ave W (x = -47.5), West Central (x = -22.5), East Central (x = +22.5), 4th Ave E (x = +47.5)

  // 1. Main Street (z = 0.0) — full removable modular corridor across all 4 Avenues
  { id: 'env-road-main-w2', kind: 'road-2lane', label: 'Main St West Approach 2', position: { x: -61.0, z: 0 }, rotationY: 0, length: 6.0 },
  { id: 'env-road-main-w1', kind: 'road-2lane', label: 'Main St West Approach 1', position: { x: -55.0, z: 0 }, rotationY: 0, length: 6.0 },
  { id: 'env-road-1w-int', kind: 'road-intersection', label: '1st Ave & Main St', position: { x: -47.5, z: 0 }, rotationY: 0 },
  { id: 'env-road-main-wm1', kind: 'road-2lane', label: 'Main St West Block 1', position: { x: -39.0, z: 0 }, rotationY: 0 },
  { id: 'env-road-main-wm2', kind: 'road-2lane', label: 'Main St West Block 2', position: { x: -31.0, z: 0 }, rotationY: 0 },
  { id: 'env-road-w-int', kind: 'road-intersection', label: 'West Central & Main St', position: { x: -22.5, z: 0 }, rotationY: 0 },
  { id: 'env-road-main-cw1', kind: 'road-2lane', label: 'Main St Civic West 1', position: { x: -15.375, z: 0 }, rotationY: 0, length: 5.25 },
  { id: 'env-road-main-cw2', kind: 'road-2lane', label: 'Main St Civic West 2', position: { x: -10.125, z: 0 }, rotationY: 0, length: 5.25 },
  { id: 'env-road-main-cw', kind: 'road-2lane', label: 'Main St Civic Mid', position: { x: -4.5, z: 0 }, rotationY: 0, length: 6.0 },
  { id: 'env-road-main-ce1', kind: 'road-2lane', label: 'Main St Civic Center', position: { x: 1.75, z: 0 }, rotationY: 0, length: 6.5 },
  { id: 'env-road-main-ce2', kind: 'road-2lane', label: 'Main St Civic East 1', position: { x: 8.25, z: 0 }, rotationY: 0, length: 6.5 },
  { id: 'env-road-main-ce3', kind: 'road-2lane', label: 'Main St Civic East 2', position: { x: 14.75, z: 0 }, rotationY: 0, length: 6.5 },
  { id: 'env-road-e-int', kind: 'road-intersection', label: 'East Central & Main St', position: { x: 22.5, z: 0 }, rotationY: 0 },
  { id: 'env-road-main-em1', kind: 'road-2lane', label: 'Main St East Block 1', position: { x: 31.0, z: 0 }, rotationY: 0 },
  { id: 'env-road-main-em2', kind: 'road-2lane', label: 'Main St East Block 2', position: { x: 39.0, z: 0 }, rotationY: 0 },
  { id: 'env-road-4e-int', kind: 'road-intersection', label: '4th Ave & Main St', position: { x: 47.5, z: 0 }, rotationY: 0 },
  { id: 'env-road-main-e1', kind: 'road-2lane', label: 'Main St East Approach 1', position: { x: 55.0, z: 0 }, rotationY: 0, length: 6.0 },
  { id: 'env-road-main-e2', kind: 'road-2lane', label: 'Main St East Approach 2', position: { x: 61.0, z: 0 }, rotationY: 0, length: 6.0 },

  // 2. North Boulevard (z = -25.0) across all 4 Avenues & North Grand Roundabout
  { id: 'env-road-nw-t', kind: 'road-t-junction', label: '1st Ave & North Blvd', position: { x: -47.5, z: -25.0 }, rotationY: Math.PI / 2 },
  { id: 'env-road-nb-w1', kind: 'road-2lane', label: 'North Blvd West 1', position: { x: -39.0, z: -25.0 }, rotationY: 0 },
  { id: 'env-road-nb-w2', kind: 'road-2lane', label: 'North Blvd West 2', position: { x: -31.0, z: -25.0 }, rotationY: 0 },
  { id: 'env-road-wc-n-int', kind: 'road-intersection', label: 'West Central & North Blvd', position: { x: -22.5, z: -25.0 }, rotationY: 0 },
  { id: 'env-road-n-1', kind: 'road-2lane', label: 'North Blvd Civic W', position: { x: -14.0, z: -25.0 }, rotationY: 0 },
  { id: 'env-road-n-roundabout', kind: 'road-roundabout', label: 'North Grand Roundabout', position: { x: 0, z: -25.0 }, rotationY: 0 },
  { id: 'env-road-n-2', kind: 'road-2lane', label: 'North Blvd Civic E', position: { x: 14.0, z: -25.0 }, rotationY: 0 },
  { id: 'env-road-ec-n-int', kind: 'road-intersection', label: 'East Central & North Blvd', position: { x: 22.5, z: -25.0 }, rotationY: 0 },
  { id: 'env-road-nb-e1', kind: 'road-2lane', label: 'North Blvd East 1', position: { x: 31.0, z: -25.0 }, rotationY: 0 },
  { id: 'env-road-nb-e2', kind: 'road-2lane', label: 'North Blvd East 2', position: { x: 39.0, z: -25.0 }, rotationY: 0 },
  { id: 'env-road-ne-t', kind: 'road-t-junction', label: '4th Ave & North Blvd', position: { x: 47.5, z: -25.0 }, rotationY: -Math.PI / 2 },

  // 3. South Boulevard (z = +25.0) across all 4 Avenues
  { id: 'env-road-sw-t', kind: 'road-t-junction', label: '1st Ave & South Blvd', position: { x: -47.5, z: 25.0 }, rotationY: Math.PI / 2 },
  { id: 'env-road-sb-w1', kind: 'road-2lane', label: 'South Blvd West 1', position: { x: -39.0, z: 25.0 }, rotationY: 0 },
  { id: 'env-road-sb-w2', kind: 'road-2lane', label: 'South Blvd West 2', position: { x: -31.0, z: 25.0 }, rotationY: 0 },
  { id: 'env-road-wc-s-int', kind: 'road-intersection', label: 'West Central & South Blvd', position: { x: -22.5, z: 25.0 }, rotationY: 0 },
  { id: 'env-road-s-cw-w', kind: 'road-2lane', label: 'South Blvd West Mid', position: { x: -15.0, z: 25.0 }, rotationY: 0, length: 6.0 },
  { id: 'env-road-s-1', kind: 'road-2lane', label: 'South Blvd Civic W', position: { x: -8.0, z: 25.0 }, rotationY: 0 },
  { id: 'env-road-s-2', kind: 'road-2lane', label: 'South Blvd Civic Mid', position: { x: 0, z: 25.0 }, rotationY: 0 },
  { id: 'env-road-s-3', kind: 'road-2lane', label: 'South Blvd Civic E', position: { x: 8.0, z: 25.0 }, rotationY: 0 },
  { id: 'env-road-s-cw', kind: 'road-2lane', label: 'South Blvd East Mid', position: { x: 15.0, z: 25.0 }, rotationY: 0, length: 6.0 },
  { id: 'env-road-ec-s-int', kind: 'road-intersection', label: 'East Central & South Blvd', position: { x: 22.5, z: 25.0 }, rotationY: 0 },
  { id: 'env-road-sb-e1', kind: 'road-2lane', label: 'South Blvd East 1', position: { x: 31.0, z: 25.0 }, rotationY: 0 },
  { id: 'env-road-sb-e2', kind: 'road-2lane', label: 'South Blvd East 2', position: { x: 39.0, z: 25.0 }, rotationY: 0 },
  { id: 'env-road-se-t', kind: 'road-t-junction', label: '4th Ave & South Blvd', position: { x: 47.5, z: 25.0 }, rotationY: -Math.PI / 2 },

  // 4. Vertical Avenues (continuous edge-to-edge corridors along x = -47.5, -22.5, +22.5, +47.5)
  // 1st Ave West (x = -47.5)
  { id: 'env-road-1w-n3', kind: 'road-2lane', label: '1st Ave W North Exit', position: { x: -47.5, z: -41.5 }, rotationY: Math.PI / 2 },
  { id: 'env-road-1w-n2', kind: 'road-2lane', label: '1st Ave W North 2', position: { x: -47.5, z: -33.5 }, rotationY: Math.PI / 2 },
  { id: 'env-road-1w-n1', kind: 'road-2lane', label: '1st Ave W Midtown N1', position: { x: -47.5, z: -16.5 }, rotationY: Math.PI / 2 },
  { id: 'env-road-1w-n0', kind: 'road-2lane', label: '1st Ave W Midtown N2', position: { x: -47.5, z: -8.5 }, rotationY: Math.PI / 2 },
  { id: 'env-road-1w-s0', kind: 'road-2lane', label: '1st Ave W Midtown S1', position: { x: -47.5, z: 8.5 }, rotationY: Math.PI / 2 },
  { id: 'env-road-1w-s1', kind: 'road-2lane', label: '1st Ave W Midtown S2', position: { x: -47.5, z: 16.5 }, rotationY: Math.PI / 2 },
  { id: 'env-road-1w-s2', kind: 'road-2lane', label: '1st Ave W South 2', position: { x: -47.5, z: 33.5 }, rotationY: Math.PI / 2 },
  { id: 'env-road-1w-s3', kind: 'road-2lane', label: '1st Ave W South Exit', position: { x: -47.5, z: 41.5 }, rotationY: Math.PI / 2 },

  // West Central Ave (x = -22.5)
  { id: 'env-road-wc-n3', kind: 'road-2lane', label: 'West Central North Exit', position: { x: -22.5, z: -41.5 }, rotationY: Math.PI / 2 },
  { id: 'env-road-wc-n2', kind: 'road-2lane', label: 'West Central North 2', position: { x: -22.5, z: -33.5 }, rotationY: Math.PI / 2 },
  { id: 'env-road-wn-2', kind: 'road-2lane', label: 'West Central Midtown N2', position: { x: -22.5, z: -16.5 }, rotationY: Math.PI / 2 },
  { id: 'env-road-wn-1', kind: 'road-2lane', label: 'West Central Midtown N1', position: { x: -22.5, z: -8.5 }, rotationY: Math.PI / 2 },
  { id: 'env-road-ws-1', kind: 'road-2lane', label: 'West Central Midtown S1', position: { x: -22.5, z: 8.5 }, rotationY: Math.PI / 2 },
  { id: 'env-road-ws-2', kind: 'road-2lane', label: 'West Central Midtown S2', position: { x: -22.5, z: 16.5 }, rotationY: Math.PI / 2 },
  { id: 'env-road-wc-s2', kind: 'road-2lane', label: 'West Central South 2', position: { x: -22.5, z: 33.5 }, rotationY: Math.PI / 2 },
  { id: 'env-road-wc-s3', kind: 'road-2lane', label: 'West Central South Exit', position: { x: -22.5, z: 41.5 }, rotationY: Math.PI / 2 },

  // East Central Ave (x = +22.5)
  { id: 'env-road-ec-n3', kind: 'road-2lane', label: 'East Central North Exit', position: { x: 22.5, z: -41.5 }, rotationY: Math.PI / 2 },
  { id: 'env-road-ec-n2', kind: 'road-2lane', label: 'East Central North 2', position: { x: 22.5, z: -33.5 }, rotationY: Math.PI / 2 },
  { id: 'env-road-en-2', kind: 'road-2lane', label: 'East Central Midtown N2', position: { x: 22.5, z: -16.5 }, rotationY: Math.PI / 2 },
  { id: 'env-road-en-1', kind: 'road-2lane', label: 'East Central Midtown N1', position: { x: 22.5, z: -8.5 }, rotationY: Math.PI / 2 },
  { id: 'env-road-es-1', kind: 'road-2lane', label: 'East Central Midtown S1', position: { x: 22.5, z: 8.5 }, rotationY: Math.PI / 2 },
  { id: 'env-road-es-2', kind: 'road-2lane', label: 'East Central Midtown S2', position: { x: 22.5, z: 16.5 }, rotationY: Math.PI / 2 },
  { id: 'env-road-ec-s2', kind: 'road-2lane', label: 'East Central South 2', position: { x: 22.5, z: 33.5 }, rotationY: Math.PI / 2 },
  { id: 'env-road-ec-s3', kind: 'road-2lane', label: 'East Central South Exit', position: { x: 22.5, z: 41.5 }, rotationY: Math.PI / 2 },

  // 4th Ave East (x = +47.5)
  { id: 'env-road-4e-n3', kind: 'road-2lane', label: '4th Ave E North Exit', position: { x: 47.5, z: -41.5 }, rotationY: Math.PI / 2 },
  { id: 'env-road-4e-n2', kind: 'road-2lane', label: '4th Ave E North 2', position: { x: 47.5, z: -33.5 }, rotationY: Math.PI / 2 },
  { id: 'env-road-4e-n1', kind: 'road-2lane', label: '4th Ave E Midtown N2', position: { x: 47.5, z: -16.5 }, rotationY: Math.PI / 2 },
  { id: 'env-road-4e-n0', kind: 'road-2lane', label: '4th Ave E Midtown N1', position: { x: 47.5, z: -8.5 }, rotationY: Math.PI / 2 },
  { id: 'env-road-4e-s0', kind: 'road-2lane', label: '4th Ave E Midtown S1', position: { x: 47.5, z: 8.5 }, rotationY: Math.PI / 2 },
  { id: 'env-road-4e-s1', kind: 'road-2lane', label: '4th Ave E Midtown S2', position: { x: 47.5, z: 16.5 }, rotationY: Math.PI / 2 },
  { id: 'env-road-4e-s2', kind: 'road-2lane', label: '4th Ave E South 2', position: { x: 47.5, z: 33.5 }, rotationY: Math.PI / 2 },
  { id: 'env-road-4e-s3', kind: 'road-2lane', label: '4th Ave E South Exit', position: { x: 47.5, z: 41.5 }, rotationY: Math.PI / 2 },

  // 5. Organized City Block Architecture (varied widths, lengths, heights & architectural styles clear of sidewalks)
  // North-Side Midtown Blocks (z: -18.0 .. -7.0)
  { id: 'env-bldg-fw-n', kind: 'building-rowhouse', label: '1st Ave Brownstones', position: { x: -59.0, z: -12.6 }, rotationY: Math.PI / 2, width: 9.0, length: 4.8, height: 8.4 },
  { id: 'env-bldg-0', kind: 'building-apartments', label: 'Midtown West Courtyard', position: { x: -35.0, z: -12.8 }, rotationY: 0, width: 9.8, length: 6.8, height: 15.8 },
  { id: 'env-bldg-1', kind: 'building-apartments', label: 'Civic Plaza West Lofts', position: { x: -12.2, z: -13.2 }, rotationY: 0, width: 6.8, length: 5.8, height: 14.5 },
  { id: 'env-bldg-civic-n', kind: 'building-civic', label: 'Civic Center Library', position: { x: 0.0, z: -10.2 }, rotationY: 0, width: 9.6, length: 4.5, height: 9.8 },
  { id: 'env-bldg-4', kind: 'building-skyscraper', label: 'Civic Plaza Landmark Tower', position: { x: 12.0, z: -13.0 }, rotationY: 0, width: 7.2, length: 6.0, height: 31.0 },
  { id: 'env-bldg-5', kind: 'building-skyscraper', label: 'Midtown East Exchange', position: { x: 35.0, z: -13.0 }, rotationY: 0, width: 7.8, length: 6.2, height: 26.0 },
  { id: 'env-bldg-fe-n', kind: 'building-highrise', label: '4th Ave Financial Tower', position: { x: 59.0, z: -12.8 }, rotationY: -Math.PI / 2, width: 7.4, length: 5.8, height: 23.5 },

  // North Outer Edge Blocks (z: -44.0 .. -32.2)
  { id: 'env-bldg-nw', kind: 'building-warehouse', label: 'West Depot Logistics Hall', position: { x: -59.0, z: -38.0 }, rotationY: Math.PI / 2, width: 9.8, length: 6.2, height: 7.6 },
  { id: 'env-bldg-wn', kind: 'building-warehouse', label: 'North Blvd Freight Hall', position: { x: -35.0, z: -38.0 }, rotationY: Math.PI, width: 10.2, length: 6.4, height: 7.2 },
  { id: 'env-bldg-6', kind: 'building-small', label: 'Roundabout North-W Shop', position: { x: -12.6, z: -39.8 }, rotationY: Math.PI, width: 5.2, length: 4.6, height: 7.0 },
  { id: 'env-bldg-7', kind: 'building-tall', label: 'Roundabout North-E Plaza', position: { x: 12.6, z: -39.8 }, rotationY: Math.PI, width: 5.8, length: 5.0, height: 13.4 },
  { id: 'env-bldg-en', kind: 'building-rowhouse', label: 'North Blvd East Terrace', position: { x: 35.0, z: -38.0 }, rotationY: Math.PI, width: 9.8, length: 4.8, height: 8.6 },
  { id: 'env-bldg-ne', kind: 'building-tall', label: 'North-East Corner Tower', position: { x: 59.0, z: -38.0 }, rotationY: -Math.PI / 2, width: 6.8, length: 5.2, height: 12.8 },

  // South-Side Midtown Blocks (z: +7.0 .. +18.0, clear behind trees at z = 8.6)
  { id: 'env-bldg-fw-s', kind: 'building-commercial', label: '1st Ave Corner Market', position: { x: -59.0, z: 12.6 }, rotationY: -Math.PI / 2, width: 9.2, length: 4.6, height: 4.9 },
  { id: 'env-bldg-12', kind: 'building-rowhouse', label: 'West Ave Brick Rowhouses', position: { x: -35.0, z: 14.0 }, rotationY: Math.PI, width: 10.2, length: 4.8, height: 8.4 },
  { id: 'env-bldg-10', kind: 'building-tall', label: 'South Block Mid-Rise', position: { x: -10.8, z: 14.2 }, rotationY: Math.PI, width: 6.8, length: 5.2, height: 13.8 },
  { id: 'env-bldg-11', kind: 'building-commercial', label: 'South Block Retail Strip', position: { x: 0.4, z: 14.2 }, rotationY: Math.PI, width: 9.6, length: 4.8, height: 4.8 },
  { id: 'env-bldg-3', kind: 'building-kiosk', label: 'South Block Pavilion', position: { x: 11.4, z: 14.2 }, rotationY: Math.PI, width: 4.4, length: 4.0, height: 3.9 },
  { id: 'env-bldg-8', kind: 'building-warehouse', label: 'East Ave Artisan Depot', position: { x: 35.0, z: 13.8 }, rotationY: Math.PI, width: 9.8, length: 5.8, height: 7.6 },
  { id: 'env-bldg-fe-s', kind: 'building-rowhouse', label: '4th Ave South Rowhouses', position: { x: 59.0, z: 12.6 }, rotationY: -Math.PI / 2, width: 9.0, length: 4.6, height: 8.0 },

  // South Outer Edge Blocks (z: +32.2 .. +44.0)
  { id: 'env-bldg-sw', kind: 'building-apartments', label: 'Westgate Outer Residences', position: { x: -59.0, z: 38.0 }, rotationY: Math.PI / 2, width: 9.6, length: 6.2, height: 14.6 },
  { id: 'env-bldg-ws', kind: 'building-commercial', label: 'South Blvd Retail Plaza', position: { x: -35.0, z: 38.0 }, rotationY: 0, width: 10.4, length: 5.0, height: 5.2 },
  { id: 'env-bldg-9', kind: 'building-rowhouse', label: 'South District Townhomes', position: { x: -9.6, z: 38.0 }, rotationY: 0, width: 10.2, length: 4.8, height: 8.8 },
  { id: 'env-bldg-cs2', kind: 'building-civic', label: 'South Promenade Courthouse', position: { x: 2.6, z: 38.0 }, rotationY: 0, width: 9.8, length: 6.6, height: 11.0 },
  { id: 'env-bldg-cs3', kind: 'building-small', label: 'South Promenade Annex', position: { x: 12.4, z: 38.0 }, rotationY: 0, width: 5.0, length: 4.8, height: 6.6 },
  { id: 'env-bldg-es', kind: 'building-apartments', label: 'South Blvd East Lofts', position: { x: 35.0, z: 38.0 }, rotationY: 0, width: 9.4, length: 6.6, height: 15.0 },
  { id: 'env-bldg-se', kind: 'building-commercial', label: '4th Ave South Plaza', position: { x: 59.0, z: 38.0 }, rotationY: Math.PI / 2, width: 9.6, length: 4.8, height: 5.0 },

  // 6. Symmetrical Street Trees & Park Plazas
  { id: 'env-tree-0', kind: 'tree', label: 'South Boulevard Tree W1', position: { x: -35.0, z: 8.6 }, rotationY: 0.4 },
  { id: 'env-tree-1', kind: 'tree', label: 'Main St Tree West', position: { x: -13.5, z: 8.6 }, rotationY: 0 },
  { id: 'env-tree-2', kind: 'tree', label: 'Main St Tree Mid-W', position: { x: -4.5, z: 8.6 }, rotationY: 0.6 },
  { id: 'env-tree-3', kind: 'tree', label: 'Main St Tree Mid-E', position: { x: 4.5, z: 8.6 }, rotationY: 1.2 },
  { id: 'env-tree-4', kind: 'tree', label: 'Main St Tree East', position: { x: 13.5, z: 8.6 }, rotationY: 2.1 },
  { id: 'env-tree-5', kind: 'tree', label: 'South Boulevard Tree E1', position: { x: 35.0, z: 8.6 }, rotationY: 1.5 },
  { id: 'env-tree-6', kind: 'tree', label: 'Promenade Park Tree W', position: { x: -6.5, z: -12.5 }, rotationY: 0.9 },
  { id: 'env-tree-7', kind: 'tree', label: 'Promenade Park Tree E', position: { x: 6.5, z: -12.5 }, rotationY: 2.4 },
  { id: 'env-tree-8', kind: 'tree', label: 'North Park Tree West', position: { x: -4.5, z: -40.0 }, rotationY: 0.3 },
  { id: 'env-tree-9', kind: 'tree', label: 'North Park Tree East', position: { x: 4.5, z: -40.0 }, rotationY: 1.7 },

  // 7. Synchronized Intersection Traffic Signals (corner sidewalk mounted dual mast-arms)
  { id: 'env-tl-1w-main', kind: 'traffic-light', label: 'Signal · 1st Ave & Main', position: { x: -42.4, z: 5.1 }, rotationY: 0 },
  { id: 'env-tl-wc-main', kind: 'traffic-light', label: 'Signal · West Central & Main', position: { x: -17.4, z: 5.1 }, rotationY: 0 },
  { id: 'env-tl-ec-main', kind: 'traffic-light', label: 'Signal · East Central & Main', position: { x: 27.6, z: 5.1 }, rotationY: 0 },
  { id: 'env-tl-4e-main', kind: 'traffic-light', label: 'Signal · 4th Ave & Main', position: { x: 52.6, z: 5.1 }, rotationY: 0 },
  { id: 'env-tl-wc-north', kind: 'traffic-light', label: 'Signal · West Central & North', position: { x: -17.4, z: -19.9 }, rotationY: 0 },
  { id: 'env-tl-ec-north', kind: 'traffic-light', label: 'Signal · East Central & North', position: { x: 27.6, z: -19.9 }, rotationY: 0 },
  { id: 'env-tl-wc-south', kind: 'traffic-light', label: 'Signal · West Central & South', position: { x: -17.4, z: 30.1 }, rotationY: 0 },
  { id: 'env-tl-ec-south', kind: 'traffic-light', label: 'Signal · East Central & South', position: { x: 27.6, z: 30.1 }, rotationY: 0 },
];

function withCorridorScenery(targets: StreetTarget[]): StreetTarget[] {
  return [
    ...targets.map((t) => ({
      ...t,
      position: { ...t.position },
      hiddenSidewalks: t.hiddenSidewalks ? [...t.hiddenSidewalks] : undefined,
    })),
    ...CORRIDOR_SCENERY_TARGETS.map((t) => ({
      ...t,
      position: { ...t.position },
      hiddenSidewalks: t.hiddenSidewalks ? [...t.hiddenSidewalks] : undefined,
    })),
  ];
}

export const SCENE_PRESETS: ScenePreset[] = [
  {
    id: 'highway-cobra',
    name: 'Highway Cobra-Head',
    subtitle: '8m pole · 22° tilt · 48° cone · 4000K LED',
    cameraPreset: 'perspective',
    fixtures: [
      {
        id: 'fix-1',
        name: 'Pole North-1',
        enabled: true,
        position: { x: -2.0, z: -3.2 },
        height: 8.0,
        tiltAngle: 22,
        yawAngle: 0,
        angleRange: 48,
        lumens: 14000,
        kelvin: 4000,
        useCustomColor: false,
        customColor: '#fff2e0',
      },
    ],
    targets: withCorridorScenery([
      { id: 'tgt-1', kind: 'sedan', label: 'Sedan Eastbound', position: { x: 1.6, z: 2.2 }, rotationY: 0, motion: 'drive', color: '#3b526b' },
      { id: 'tgt-4', kind: 'sedan', label: 'Sedan Westbound', position: { x: 14.5, z: -2.2 }, rotationY: Math.PI, motion: 'drive', color: '#8a2b32' },
      { id: 'tgt-5', kind: 'van', label: 'Roundabout Van', position: { x: 0, z: -18.25 }, rotationY: 0, motion: 'drive' },
      { id: 'tgt-6', kind: 'bus', label: 'City Transit Bus', position: { x: -20.4, z: -13.0 }, rotationY: Math.PI / 2, motion: 'drive' },
      { id: 'tgt-7', kind: 'motorcycle', label: 'South Blvd Moto', position: { x: 0, z: 22.9 }, rotationY: Math.PI, motion: 'drive' },
      { id: 'tgt-2', kind: 'pedestrian', label: 'West Central Walker', position: { x: -16.5, z: -5.95 }, rotationY: 0, motion: 'walk', color: '#c26d38' },
      { id: 'tgt-8', kind: 'pedestrian', label: 'South Blvd Walker', position: { x: 16.5, z: 19.05 }, rotationY: Math.PI, motion: 'walk', color: '#2563eb' },
      { id: 'tgt-9', kind: 'pedestrian', label: 'Main St South Stroller', position: { x: -4.5, z: 5.95 }, rotationY: Math.PI / 2, motion: 'walk', color: '#0d9488' },
      { id: 'tgt-10', kind: 'pedestrian', label: 'Main St North Pedestrian', position: { x: 8.5, z: -5.95 }, rotationY: -Math.PI / 2, motion: 'walk', color: '#b91c1c' },
      { id: 'tgt-11', kind: 'pedestrian', label: 'East Central NW Walker', position: { x: 16.5, z: -5.95 }, rotationY: 0, motion: 'walk', color: '#7c3aed' },
      { id: 'tgt-12', kind: 'pedestrian', label: 'West Central NW Walker', position: { x: -28.45, z: -5.95 }, rotationY: Math.PI / 2, motion: 'walk', color: '#ca8a04' },
      { id: 'tgt-13', kind: 'pedestrian', label: 'East Central SE Walker', position: { x: 28.45, z: 5.95 }, rotationY: -Math.PI / 2, motion: 'walk', color: '#059669' },
      { id: 'tgt-14', kind: 'pedestrian', label: 'West Midtown Walker', position: { x: -16.5, z: 12.0 }, rotationY: Math.PI, motion: 'walk', color: '#475569' },
      { id: 'tgt-15', kind: 'pedestrian', label: 'East Midtown Walker', position: { x: 16.5, z: -12.5 }, rotationY: 0, motion: 'walk', color: '#db2777' },
      { id: 'tgt-16', kind: 'pedestrian', label: 'Roundabout NE Walker', position: { x: 7.85, z: -32.85 }, rotationY: -Math.PI / 4, motion: 'walk', color: '#ea580c' },
      { id: 'tgt-17', kind: 'pedestrian', label: 'Roundabout SW Walker', position: { x: -7.85, z: -17.15 }, rotationY: Math.PI * 0.75, motion: 'walk', color: '#0284c7' },
      { id: 'tgt-18', kind: 'pedestrian', label: 'South Promenade Walker', position: { x: -12.0, z: 30.95 }, rotationY: Math.PI / 2, motion: 'walk', color: '#65a30d' },
      { id: 'tgt-19', kind: 'pedestrian', label: '1st Ave SE Walker', position: { x: -41.55, z: 5.95 }, rotationY: 0, motion: 'walk', color: '#9333ea' },
      { id: 'tgt-20', kind: 'pedestrian', label: '4th Ave NW Walker', position: { x: 41.55, z: -5.95 }, rotationY: Math.PI, motion: 'walk', color: '#dc2626' },
      { id: 'tgt-3', kind: 'bollard', label: 'Curb Bollard', position: { x: -6.5, z: -4.6 }, rotationY: 0 },
    ]),
  },
  {
    id: 'narrow-beam',
    name: 'Collimated Spot (0–6°)',
    subtitle: '10m mast · 26° tilt · 5° beam · 5600K',
    cameraPreset: 'perspective',
    fixtures: [
      {
        id: 'fix-1',
        name: 'Spot Mast',
        enabled: true,
        position: { x: -4.0, z: -3.4 },
        height: 10.0,
        tiltAngle: 26,
        yawAngle: 25,
        angleRange: 5,
        lumens: 7500,
        kelvin: 5600,
        useCustomColor: false,
        customColor: '#eef5ff',
      },
    ],
    targets: withCorridorScenery([
      { id: 'tgt-1', kind: 'sedan', label: 'Target Vehicle', position: { x: -1.4, z: 1.2 }, rotationY: 0.2 },
      { id: 'tgt-2', kind: 'crate', label: 'Cargo Crate', position: { x: 2.2, z: -1.0 }, rotationY: 0.35 },
      { id: 'tgt-3', kind: 'pedestrian', label: 'Sidewalk Pedestrian 1', position: { x: -16.5, z: -5.95 }, rotationY: Math.PI / 2, motion: 'walk', color: '#2563eb' },
      { id: 'tgt-4', kind: 'pedestrian', label: 'Sidewalk Pedestrian 2', position: { x: 16.5, z: 5.95 }, rotationY: -Math.PI / 2, motion: 'walk', color: '#0d9488' },
      { id: 'tgt-5', kind: 'pedestrian', label: 'Sidewalk Pedestrian 3', position: { x: -6.0, z: 5.95 }, rotationY: 0, motion: 'walk', color: '#c26d38' },
    ]),
  },
  {
    id: 'plaza-globe',
    name: '360° Full-Sphere Globe',
    subtitle: '4.5m post · 180° range (full circle) · 2700K',
    cameraPreset: 'perspective',
    fixtures: [
      {
        id: 'fix-1',
        name: 'Plaza Globe',
        enabled: true,
        position: { x: 0, z: -4.6 },
        height: 4.5,
        tiltAngle: 0,
        yawAngle: 0,
        angleRange: 180,
        lumens: 9500,
        kelvin: 2700,
        useCustomColor: false,
        customColor: '#ffd4a3',
      },
    ],
    targets: withCorridorScenery([
      { id: 'tgt-1', kind: 'pedestrian', label: 'Sidewalk Walker', position: { x: -2.8, z: -5.8 }, rotationY: 0.8, motion: 'walk', color: '#c26d38' },
      { id: 'tgt-4', kind: 'pedestrian', label: 'South Sidewalk Walker', position: { x: 7.0, z: 5.95 }, rotationY: -Math.PI / 2, motion: 'walk', color: '#2563eb' },
      { id: 'tgt-5', kind: 'pedestrian', label: 'West Corner Walker', position: { x: -16.5, z: -5.95 }, rotationY: 0, motion: 'walk', color: '#059669' },
      { id: 'tgt-6', kind: 'pedestrian', label: 'East Corner Walker', position: { x: 16.5, z: -5.95 }, rotationY: Math.PI, motion: 'walk', color: '#7c3aed' },
      { id: 'tgt-2', kind: 'bollard', label: 'Plaza Bollard', position: { x: 3.0, z: -4.8 }, rotationY: 0 },
      { id: 'tgt-3', kind: 'sedan', label: 'Street Sedan', position: { x: 1.5, z: 1.6 }, rotationY: 0 },
    ]),
  },
  {
    id: 'dual-corridor',
    name: 'Dual Opposing Poles',
    subtitle: 'Warm 2800K vs Cool 5200K overlapping beams',
    cameraPreset: 'top',
    fixtures: [
      {
        id: 'fix-1',
        name: 'West Pole (Warm)',
        enabled: true,
        position: { x: -7.5, z: -3.2 },
        height: 7.5,
        tiltAngle: 24,
        yawAngle: 12,
        angleRange: 54,
        lumens: 11500,
        kelvin: 2800,
        useCustomColor: false,
        customColor: '#ffd9b0',
      },
      {
        id: 'fix-2',
        name: 'East Pole (Cool)',
        enabled: true,
        position: { x: 7.5, z: 3.2 },
        height: 8.5,
        tiltAngle: 24,
        yawAngle: -168,
        angleRange: 54,
        lumens: 12500,
        kelvin: 5200,
        useCustomColor: false,
        customColor: '#edf4ff',
      },
    ],
    targets: withCorridorScenery([
      { id: 'tgt-1', kind: 'sedan', label: 'Center Sedan', position: { x: 0.2, z: -1.4 }, rotationY: 0 },
      { id: 'tgt-2', kind: 'pedestrian', label: 'Pedestrian', position: { x: -2.5, z: 2.0 }, rotationY: -0.6 },
      { id: 'tgt-4', kind: 'pedestrian', label: 'North Sidewalk Walker', position: { x: -11.0, z: -5.95 }, rotationY: Math.PI / 2, motion: 'walk', color: '#2563eb' },
      { id: 'tgt-5', kind: 'pedestrian', label: 'South Sidewalk Walker', position: { x: 11.5, z: 5.95 }, rotationY: -Math.PI / 2, motion: 'walk', color: '#0d9488' },
      { id: 'tgt-6', kind: 'pedestrian', label: 'Junction Walker', position: { x: 16.5, z: -5.95 }, rotationY: 0, motion: 'walk', color: '#b91c1c' },
      { id: 'tgt-3', kind: 'crate', label: 'Utility Box', position: { x: 3.8, z: 4.8 }, rotationY: 0.1 },
    ]),
  },
  {
    id: 'low-bollard',
    name: 'Low Grazing Bollard',
    subtitle: '1.3m height · 62° tilt · long dramatic shadows',
    cameraPreset: 'side',
    fixtures: [
      {
        id: 'fix-1',
        name: 'Sidewalk Bollard',
        enabled: true,
        position: { x: -6.0, z: -4.4 },
        height: 1.3,
        tiltAngle: 62,
        yawAngle: 35,
        angleRange: 42,
        lumens: 3200,
        kelvin: 2200,
        useCustomColor: false,
        customColor: '#ffb870',
      },
    ],
    targets: withCorridorScenery([
      { id: 'tgt-1', kind: 'pedestrian', label: 'Pedestrian', position: { x: -2.5, z: -1.8 }, rotationY: 0.5 },
      { id: 'tgt-4', kind: 'pedestrian', label: 'West Corner Walker', position: { x: -16.5, z: -5.95 }, rotationY: Math.PI / 2, motion: 'walk', color: '#2563eb' },
      { id: 'tgt-5', kind: 'pedestrian', label: 'South Sidewalk Walker', position: { x: 6.5, z: 5.95 }, rotationY: -Math.PI / 2, motion: 'walk', color: '#059669' },
      { id: 'tgt-6', kind: 'pedestrian', label: 'East Corner Walker', position: { x: 16.5, z: -5.95 }, rotationY: 0, motion: 'walk', color: '#7c3aed' },
      { id: 'tgt-2', kind: 'crate', label: 'Delivery Crate', position: { x: 0.5, z: 0.2 }, rotationY: 0.25 },
      { id: 'tgt-3', kind: 'bollard', label: 'Bollard 2', position: { x: -1.5, z: -4.6 }, rotationY: 0 },
    ]),
  },
];
