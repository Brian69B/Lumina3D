import * as THREE from 'three';

function fillSpeckledBase(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  baseR: number,
  baseG: number,
  baseB: number,
  specks: number,
  minV: number,
  rangeV: number,
  gDelta: number,
  bDelta: number,
  scaleR = 1,
  scaleG = 1,
  scaleB = 1,
): void {
  const img = ctx.createImageData(w, h);
  const data = img.data;
  for (let i = 0; i < data.length; i += 4) {
    data[i] = baseR;
    data[i + 1] = baseG;
    data[i + 2] = baseB;
    data[i + 3] = 255;
  }
  for (let i = 0; i < specks; i++) {
    const x = (Math.random() * (w - 1)) | 0;
    const y = (Math.random() * (h - 1)) | 0;
    const v = minV + ((Math.random() * rangeV) | 0);
    const r = Math.min(255, Math.floor(v * scaleR));
    const g = Math.min(255, Math.floor((v + gDelta) * scaleG));
    const b = Math.min(255, Math.floor((v + bDelta) * scaleB));
    const p0 = (y * w + x) * 4;
    data[p0] = r;
    data[p0 + 1] = g;
    data[p0 + 2] = b;
    // Stamp 2x1 or 2x2 subtle grain for same visual density as 1.5px rect
    const p1 = p0 + 4;
    data[p1] = r;
    data[p1 + 1] = g;
    data[p1 + 2] = b;
    const p2 = p0 + w * 4;
    if (p2 + 2 < data.length) {
      data[p2] = r;
      data[p2 + 1] = g;
      data[p2 + 2] = b;
    }
  }
  ctx.putImageData(img, 0, 0);
}

export function createAsphaltTexture(maxAnisotropy: number): THREE.CanvasTexture {
  const width = 1024;
  const height = 512;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;

  // Base dark asphalt with aggregate mineral grain noise
  fillSpeckledBase(ctx, width, height, 0x1b, 0x1f, 0x26, 26000, 22, 28, 2, 5);

  // Subtle tire-wear longitudinal tracks
  const grad1 = ctx.createLinearGradient(0, height * 0.2, 0, height * 0.45);
  grad1.addColorStop(0, 'rgba(12, 15, 20, 0)');
  grad1.addColorStop(0.5, 'rgba(12, 15, 20, 0.35)');
  grad1.addColorStop(1, 'rgba(12, 15, 20, 0)');
  ctx.fillStyle = grad1;
  ctx.fillRect(0, height * 0.18, width, height * 0.3);

  const grad2 = ctx.createLinearGradient(0, height * 0.55, 0, height * 0.8);
  grad2.addColorStop(0, 'rgba(12, 15, 20, 0)');
  grad2.addColorStop(0.5, 'rgba(12, 15, 20, 0.35)');
  grad2.addColorStop(1, 'rgba(12, 15, 20, 0)');
  ctx.fillStyle = grad2;
  ctx.fillRect(0, height * 0.52, width, height * 0.3);

  // Crisp white outer roadway edge lines
  ctx.fillStyle = 'rgba(226, 232, 240, 0.82)';
  ctx.fillRect(0, 22, width, 7);
  ctx.fillRect(0, height - 29, width, 7);

  // Double dashed amber center lane markings
  ctx.fillStyle = 'rgba(245, 158, 11, 0.86)';
  const dashW = 54;
  const gapW = 48;
  for (let x = 16; x < width; x += dashW + gapW) {
    ctx.fillRect(x, height / 2 - 7, dashW, 5);
    ctx.fillRect(x, height / 2 + 2, dashW, 5);
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.repeat.set(5, 1);
  tex.anisotropy = maxAnisotropy;
  tex.needsUpdate = true;
  return tex;
}

export function createSidewalkTexture(maxAnisotropy: number): THREE.CanvasTexture {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;

  // Concrete base + fine speckle
  fillSpeckledBase(ctx, size, size, 0x33, 0x3a, 0x45, 14000, 45, 26, 4, 8);

  // Paving expansion joints (2x4 slab pattern)
  ctx.strokeStyle = 'rgba(15, 18, 25, 0.65)';
  ctx.lineWidth = 3;
  for (let i = 0; i <= 4; i++) {
    const pos = (i * size) / 4;
    ctx.beginPath();
    ctx.moveTo(pos, 0);
    ctx.lineTo(pos, size);
    ctx.stroke();
  }
  for (let j = 0; j <= 2; j++) {
    const pos = (j * size) / 2;
    ctx.beginPath();
    ctx.moveTo(0, pos);
    ctx.lineTo(size, pos);
    ctx.stroke();
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(36, 3);
  tex.anisotropy = maxAnisotropy;
  tex.needsUpdate = true;
  return tex;
}

export function createContactShadowTexture(): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;

  const grad = ctx.createRadialGradient(size / 2, size / 2, 6, size / 2, size / 2, size / 2);
  grad.addColorStop(0, 'rgba(0, 0, 0, 0.72)');
  grad.addColorStop(0.55, 'rgba(0, 0, 0, 0.30)');
  grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

export type RoadPathTextureKind =
  | 'road-2lane'
  | 'road-intersection'
  | 'road-intersection-crosswalk'
  | 'road-t-junction'
  | 'road-crosswalk'
  | 'road-roundabout'
  | 'road-culdesac'
  | 'road-deadend'
  | 'path-sidewalk'
  | 'path-bike'
  | 'path-cobble'
  | 'path-gravel';

const roadPathTextureCache = new Map<RoadPathTextureKind, THREE.CanvasTexture>();

function paintAsphaltBase(ctx: CanvasRenderingContext2D, w: number, h: number, specks = 9000): void {
  fillSpeckledBase(ctx, w, h, 0x1b, 0x1f, 0x26, specks, 22, 26, 2, 5);
}

export function getRoadPathTexture(
  kind: RoadPathTextureKind,
  maxAnisotropy: number,
): THREE.CanvasTexture {
  const existing = roadPathTextureCache.get(kind);
  if (existing) return existing;

  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = kind === 'road-intersection-crosswalk' ? 256 : 512;
  const ctx = canvas.getContext('2d')!;
  const w = canvas.width;
  const h = canvas.height;

  if (kind === 'road-2lane') {
    paintAsphaltBase(ctx, w, h);
    // White edge lines
    ctx.fillStyle = 'rgba(226, 232, 240, 0.85)';
    ctx.fillRect(0, 18, w, 7);
    ctx.fillRect(0, h - 25, w, 7);
    // Double dashed amber center line
    ctx.fillStyle = 'rgba(245, 158, 11, 0.88)';
    for (let x = 18; x < w; x += 96) {
      ctx.fillRect(x, h / 2 - 8, 56, 5);
      ctx.fillRect(x, h / 2 + 3, 56, 5);
    }
  } else if (kind === 'road-intersection') {
    paintAsphaltBase(ctx, w, h, 11000);
    // Subtle corner curb turning arc guides inside the 9m x 9m intersection box
    ctx.strokeStyle = 'rgba(226, 232, 240, 0.34)';
    ctx.lineWidth = 3;
    ctx.setLineDash([10, 12]);
    for (const [cx, cy, a0, a1] of [
      [0, 0, 0, Math.PI / 2],
      [w, 0, Math.PI / 2, Math.PI],
      [w, h, Math.PI, Math.PI * 1.5],
      [0, h, Math.PI * 1.5, Math.PI * 2],
    ]) {
      ctx.beginPath();
      ctx.arc(cx, cy, 42, a0, a1);
      ctx.stroke();
    }
    ctx.setLineDash([]);
  } else if (kind === 'road-intersection-crosswalk') {
    // 8.88m wide x 3.4m deep approach apron (spans distance 4.5m..7.9m from intersection center)
    // Aligns zebra crosswalk directly with the 4.74m..7.24m sidewalk corridor
    paintAsphaltBase(ctx, w, h, 5200);
    // White road edge lines matching road-2lane (+/-4.06m..+/-4.184m)
    ctx.fillStyle = 'rgba(226, 232, 240, 0.85)';
    ctx.fillRect(15, 0, 7, h);
    ctx.fillRect(w - 22, 0, 7, h);

    // 10 symmetric zebra stripes across 4.85m..7.15m (aligned with sidewalks 4.74m..7.24m)
    ctx.fillStyle = 'rgba(235, 240, 248, 0.9)';
    const yStart = 26;
    const yHeight = 174;
    for (let x = 48; x <= w - 68; x += 44) {
      ctx.fillRect(x, yStart, 20, yHeight);
    }

    // White stop bar on approaching right-hand lane (7.52m..7.72m from center)
    ctx.fillStyle = 'rgba(241, 245, 249, 0.88)';
    ctx.fillRect(w / 2 + 13, 227, w / 2 - 41, 15);
  } else if (kind === 'road-t-junction') {
    paintAsphaltBase(ctx, w, h, 10500);
    // Continuous white edge line along top (North) through-border
    ctx.fillStyle = 'rgba(226, 232, 240, 0.85)';
    ctx.fillRect(0, 18, w, 7);
    // Short corner white edge tabs on bottom (South) branch corners
    ctx.fillRect(0, h - 25, 22, 7);
    ctx.fillRect(w - 22, h - 25, 22, 7);
    ctx.fillRect(18, h - 25, 7, 25);
    ctx.fillRect(w - 25, h - 25, 7, 25);

    // Double dashed amber through-centerline
    ctx.fillStyle = 'rgba(245, 158, 11, 0.88)';
    for (let x = 14; x < w; x += 86) {
      ctx.fillRect(x, h / 2 - 8, 44, 5);
      ctx.fillRect(x, h / 2 + 3, 44, 5);
    }

    // Zebra crosswalk & stop line on South side street stem
    ctx.fillStyle = 'rgba(235, 240, 248, 0.88)';
    for (let i = 44; i <= w - 68; i += 34) {
      ctx.fillRect(i, h - 76, 18, 56);
    }
    ctx.fillRect(w / 2 + 12, h - 94, w / 2 - 44, 8);
  } else if (kind === 'road-crosswalk') {
    paintAsphaltBase(ctx, w, h);
    ctx.fillStyle = 'rgba(226, 232, 240, 0.82)';
    ctx.fillRect(0, 18, w, 7);
    ctx.fillRect(0, h - 25, w, 7);
    // Bold zebra crosswalk bars + stop bars
    ctx.fillStyle = 'rgba(241, 245, 249, 0.92)';
    ctx.fillRect(72, 34, 10, h - 68);
    ctx.fillRect(w - 82, 34, 10, h - 68);
    for (let y = 44; y < h - 54; y += 36) {
      ctx.fillRect(118, y, w - 236, 20);
    }
  } else if (kind === 'road-roundabout') {
    paintAsphaltBase(ctx, w, h, 12000);
    // Outer circulatory edge ring
    ctx.strokeStyle = 'rgba(226, 232, 240, 0.84)';
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.arc(w / 2, h / 2, 232, 0, Math.PI * 2);
    ctx.stroke();

    // Inner island apron edge ring
    ctx.beginPath();
    ctx.arc(w / 2, h / 2, 118, 0, Math.PI * 2);
    ctx.stroke();

    // Dashed amber lane divider in middle of circulatory roadway
    ctx.strokeStyle = 'rgba(245, 158, 11, 0.86)';
    ctx.lineWidth = 5;
    ctx.setLineDash([18, 16]);
    ctx.beginPath();
    ctx.arc(w / 2, h / 2, 175, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);

    // Counter-clockwise circulatory lane arrows
    ctx.fillStyle = 'rgba(226, 232, 240, 0.72)';
    for (let k = 0; k < 4; k++) {
      ctx.save();
      ctx.translate(w / 2, h / 2);
      ctx.rotate(k * (Math.PI / 2) + Math.PI / 4);
      ctx.beginPath();
      ctx.moveTo(12, -198);
      ctx.lineTo(-14, -184);
      ctx.lineTo(12, -170);
      ctx.lineTo(4, -184);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
  } else if (kind === 'road-culdesac') {
    paintAsphaltBase(ctx, w, h, 11000);
    // Outer ring marking + dashed circular lane ring
    ctx.strokeStyle = 'rgba(226, 232, 240, 0.78)';
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.arc(w / 2, h / 2, 226, 0, Math.PI * 2);
    ctx.stroke();

    ctx.strokeStyle = 'rgba(245, 158, 11, 0.85)';
    ctx.lineWidth = 5;
    ctx.setLineDash([20, 18]);
    ctx.beginPath();
    ctx.arc(w / 2, h / 2, 162, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  } else if (kind === 'road-deadend') {
    paintAsphaltBase(ctx, w, h, 11000);
    ctx.strokeStyle = 'rgba(226, 232, 240, 0.78)';
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.arc(w / 2, h / 2, 224, 0, Math.PI * 2);
    ctx.stroke();

    ctx.strokeStyle = 'rgba(245, 158, 11, 0.8)';
    ctx.lineWidth = 4;
    ctx.setLineDash([18, 16]);
    ctx.beginPath();
    ctx.arc(w / 2, h / 2, 156, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  } else if (kind === 'path-sidewalk') {
    fillSpeckledBase(ctx, w, h, 0x3b, 0x43, 0x51, 10000, 52, 28, 4, 9);
    ctx.strokeStyle = 'rgba(15, 23, 42, 0.65)';
    ctx.lineWidth = 4;
    for (let i = 0; i <= 4; i++) {
      const x = (i * w) / 4;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.moveTo(0, h / 2);
    ctx.lineTo(w, h / 2);
    ctx.stroke();
  } else if (kind === 'path-bike') {
    // Rich green cycle-track asphalt
    fillSpeckledBase(ctx, w, h, 0x17, 0x42, 0x34, 8000, 55, 26, 0, 0, 0.35, 1.0, 0.78);
    // Crisp white edge lines
    ctx.fillStyle = 'rgba(241, 245, 249, 0.9)';
    ctx.fillRect(0, 14, w, 10);
    ctx.fillRect(0, h - 24, w, 10);
    // Dashed center lane line
    for (let x = 18; x < w; x += 68) {
      ctx.fillRect(x, h / 2 - 4, 34, 8);
    }
    // Painted white directional chevrons & bike icon hint
    ctx.strokeStyle = 'rgba(248, 250, 252, 0.9)';
    ctx.lineWidth = 10;
    for (const cx of [140, 370]) {
      // Two wheels + diamond frame
      ctx.beginPath();
      ctx.arc(cx - 26, h * 0.27 + 16, 16, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(cx + 26, h * 0.27 + 16, 16, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cx - 26, h * 0.27 + 16);
      ctx.lineTo(cx, h * 0.27 - 10);
      ctx.lineTo(cx + 26, h * 0.27 + 16);
      ctx.stroke();
      // Opposite lane arrow
      ctx.beginPath();
      ctx.moveTo(cx + 26, h * 0.74);
      ctx.lineTo(cx - 26, h * 0.74);
      ctx.lineTo(cx - 8, h * 0.74 - 14);
      ctx.moveTo(cx - 26, h * 0.74);
      ctx.lineTo(cx - 8, h * 0.74 + 14);
      ctx.stroke();
    }
  } else if (kind === 'path-cobble') {
    ctx.fillStyle = '#252830';
    ctx.fillRect(0, 0, w, h);
    const cols = 8;
    const rows = 12;
    const cw = w / cols;
    const ch = h / rows;
    for (let r = 0; r < rows; r++) {
      const offset = (r % 2) * (cw * 0.5);
      for (let c = -1; c <= cols; c++) {
        const shade = 52 + Math.floor(Math.random() * 24);
        const warm = Math.floor(Math.random() * 12);
        ctx.fillStyle = `rgb(${shade + warm}, ${shade + 4}, ${shade})`;
        ctx.fillRect(c * cw + offset + 3, r * ch + 3, cw - 6, ch - 6);
      }
    }
  } else {
    // path-gravel
    fillSpeckledBase(ctx, w, h, 0x4f, 0x45, 0x3b, 16000, 68, 36, 0, 0, 1.0, 0.88, 0.74);
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = kind === 'road-2lane' ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.anisotropy = maxAnisotropy;
  tex.needsUpdate = true;
  roadPathTextureCache.set(kind, tex);
  return tex;
}

const trafficArrowTexCache = new Map<'left' | 'up' | 'right', THREE.CanvasTexture>();
const trafficCountdownTexCache = new Map<string, THREE.CanvasTexture>();

export function getTrafficArrowTexture(arrow: 'left' | 'up' | 'right'): THREE.CanvasTexture {
  const existing = trafficArrowTexCache.get(arrow);
  if (existing) return existing;

  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;

  // Dark tinted polycarbonate lens background
  ctx.fillStyle = '#18181b';
  ctx.fillRect(0, 0, size, size);

  const cx = size / 2;
  const cy = size / 2;
  const grad = ctx.createRadialGradient(cx, cy, 8, cx, cy, 56);
  grad.addColorStop(0, '#3f3f46');
  grad.addColorStop(1, '#141418');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(cx, cy, 56, 0, Math.PI * 2);
  ctx.fill();

  // Crisp bright white LED arrow stencil (tinted by material color & emissive)
  ctx.save();
  ctx.translate(cx, cy);
  if (arrow === 'left') ctx.rotate(-Math.PI / 2);
  else if (arrow === 'right') ctx.rotate(Math.PI / 2);

  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.moveTo(0, -38);
  ctx.lineTo(28, -8);
  ctx.lineTo(14, -8);
  ctx.lineTo(14, 34);
  ctx.lineTo(-14, 34);
  ctx.lineTo(-14, -8);
  ctx.lineTo(-28, -8);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  trafficArrowTexCache.set(arrow, tex);
  return tex;
}

export function getTrafficCountdownTexture(
  aspect: 'red' | 'yellow' | 'green',
  seconds: number,
): THREE.CanvasTexture {
  const clamped = Math.max(1, Math.min(99, Math.round(seconds)));
  const key = `${aspect}:${clamped}`;
  const existing = trafficCountdownTexCache.get(key);
  if (existing) return existing;

  const w = 128;
  const h = 128;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = '#090b10';
  ctx.fillRect(0, 0, w, h);

  // Subtle LED matrix grid sheen
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.lineWidth = 2;
  ctx.strokeRect(6, 6, w - 12, h - 12);

  const colorHex =
    aspect === 'green' ? '#4ade80' : aspect === 'yellow' ? '#fbbf24' : '#ff3b30';
  ctx.fillStyle = colorHex;
  ctx.font = 'bold 78px "JetBrains Mono", monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(clamped), w / 2, h / 2 + 4);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  trafficCountdownTexCache.set(key, tex);
  return tex;
}

export function disposeCachedRoadTextures(): void {
  for (const tex of roadPathTextureCache.values()) {
    tex.dispose();
  }
  roadPathTextureCache.clear();
  for (const tex of trafficArrowTexCache.values()) {
    tex.dispose();
  }
  trafficArrowTexCache.clear();
  for (const tex of trafficCountdownTexCache.values()) {
    tex.dispose();
  }
  trafficCountdownTexCache.clear();
}
