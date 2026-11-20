export const MAX_FIXTURES = 8;
export const SHIELD_SECTORS = 24; // 15 deg per sector around full 360 deg azimuth
export const MAP_HALF_X = 64;
export const MAP_HALF_Z = 44;
export const FIXTURE_MAX_X = 62;
export const FIXTURE_MAX_Z = 42;

export interface LightFixture {
  id: string;
  name: string;
  enabled: boolean;
  position: { x: number; z: number };
  height: number; // Mounting height above ground (meters, 0.5 - 15.0)
  tiltAngle: number; // Pitch from straight down nadir (0 = straight down, 90 = horizontal, 180 = straight up)
  yawAngle: number; // Light luminaire aim azimuth around Y axis (-180 to 180 deg, 0 = across street +Z)
  poleYawAngle?: number; // Mast & cantilever arm azimuth around Y axis (-180 to 180 deg); defaults to yawAngle
  angleRange: number; // Half-angle beam spread (0 = straight collimated beam, 90 = hemisphere, 180 = full 360° sphere)
  lumens: number; // Luminous flux (500 - 30000 lm)
  kelvin: number; // Correlated color temperature (1800 - 10000 K)
  useCustomColor: boolean;
  customColor: string;
  shieldSectors?: number; // 24-bit mask (bit k = 15 deg slice [k*15, (k+1)*15) clockwise from North -Z is shielded)
  sectorAngles?: Record<number, number>; // Optional per-sector beam half-angle overrides (0..180 deg) for each of the 24 shield parts
}

export type TargetKind =
  | 'sedan'
  | 'bike'
  | 'motorcycle'
  | 'van'
  | 'truck'
  | 'bus'
  | 'pedestrian'
  | 'bollard'
  | 'crate'
  | 'traffic-light'
  | 'building-kiosk'
  | 'building-small'
  | 'building-tall'
  | 'building-highrise'
  | 'tree'
  | 'hedge'
  | 'bench'
  | 'road-2lane'
  | 'road-intersection'
  | 'road-t-junction'
  | 'road-turn-90'
  | 'road-curve-45'
  | 'road-crosswalk'
  | 'road-roundabout'
  | 'road-culdesac'
  | 'road-deadend'
  | 'path-sidewalk'
  | 'path-bike'
  | 'path-cobble'
  | 'path-gravel';

export type BuilderTool = TargetKind | 'light' | null;

export const BUILDING_DEFAULT_HEIGHTS: Partial<Record<TargetKind, number>> = {
  'building-kiosk': 3.8,
  'building-small': 6.3,
  'building-tall': 11.6,
  'building-highrise': 22.0,
};

export function isBuildingKind(kind: TargetKind): boolean {
  return kind in BUILDING_DEFAULT_HEIGHTS;
}

export function isRoadOrPathKind(kind: TargetKind): boolean {
  return kind.startsWith('road-') || kind.startsWith('path-');
}

export function isVehicleKind(kind: TargetKind): boolean {
  return (
    kind === 'bike' ||
    kind === 'motorcycle' ||
    kind === 'sedan' ||
    kind === 'van' ||
    kind === 'truck' ||
    kind === 'bus'
  );
}

export function getRoadSidewalkPartKeys(kind: TargetKind): string[] {
  switch (kind) {
    case 'road-2lane':
    case 'road-crosswalk':
      return ['north', 'south'];
    case 'road-intersection':
      return ['nw', 'ne', 'sw', 'se'];
    case 'road-t-junction':
      return ['back', 'sw', 'se'];
    case 'road-turn-90':
    case 'road-curve-45':
      return ['inner', 'outer'];
    case 'road-roundabout':
      return ['nw', 'ne', 'sw', 'se', 'cap-E', 'cap-N', 'cap-W', 'cap-S'];
    case 'road-culdesac':
    case 'road-deadend':
      return ['ring'];
    default:
      return [];
  }
}

export type StreetRouteId =
  | 'north-loop'
  | 'roundabout-cw'
  | 'south-shuttle'
  | 'ped-south';

export interface StreetTarget {
  id: string;
  kind: TargetKind;
  label: string;
  position: { x: number; z: number };
  rotationY: number; // Radians
  height?: number; // Custom height in meters for building targets
  length?: number; // Custom segment length in meters for modular straight roads
  hiddenSidewalks?: string[]; // Removed attached sidewalk part keys for road targets
  motion?: 'walk' | 'drive';
  routeId?: StreetRouteId;
  color?: string;
}

export interface SelectedSidewalkInfo {
  key: string;
  targetId: string;
  partKey: string;
  label: string;
  position: { x: number; z: number };
}

export type CameraPresetId = 'perspective' | 'top' | 'side' | 'closeup';
export type CameraControlMode = 'orbit' | 'pan';
export type AmbientMode = 'night' | 'twilight';

export interface ViewportSettings {
  showBeamEnvelope: boolean;
  showLuxHeatmap: boolean;
  showGrid: boolean;
  ambientMode: AmbientMode;
  luxThreshold: number;
}

export interface PhotometricStats {
  cursorWorld: { x: number; y: number; z: number } | null;
  cursorLux: number | null;
  peakGroundLux: number;
  footprintAreaSqM: number;
  centerThrowDistM: number | null;
}

export interface ScenePreset {
  id: string;
  name: string;
  subtitle: string;
  fixtures: LightFixture[];
  targets: StreetTarget[];
  cameraPreset?: CameraPresetId;
}

export type MouseDragButton = 'left' | 'right' | 'middle';

export type KeybindAction =
  | 'moveForward'
  | 'moveBackward'
  | 'moveLeft'
  | 'moveRight'
  | 'moveUp'
  | 'moveDown'
  | 'rotate'
  | 'delete'
  | 'toggleDock';

export interface InputControlsConfig {
  rotateMouseButton: MouseDragButton;
  panMouseButton: MouseDragButton;
  moveSpeed: number;
  rotateSensitivity: number;
  zoomSensitivity: number;
  keybinds: Record<KeybindAction, string>;
}

export const DEFAULT_INPUT_CONTROLS: InputControlsConfig = {
  rotateMouseButton: 'right',
  panMouseButton: 'left',
  moveSpeed: 1.0,
  rotateSensitivity: 1.0,
  zoomSensitivity: 1.0,
  keybinds: {
    moveForward: 'KeyW',
    moveBackward: 'KeyS',
    moveLeft: 'KeyA',
    moveRight: 'KeyD',
    moveUp: 'Space',
    moveDown: 'ShiftLeft',
    rotate: 'KeyR',
    delete: 'Delete',
    toggleDock: 'KeyH',
  },
};

export function formatMouseButton(button: MouseDragButton): string {
  switch (button) {
    case 'left':
      return 'Left-Drag';
    case 'middle':
      return 'Middle-Drag';
    case 'right':
      return 'Right-Drag';
  }
}

export function formatKeyCode(code: string): string {
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return `Num ${code.slice(6)}`;
  switch (code) {
    case 'Space':
      return 'Space';
    case 'ShiftLeft':
    case 'ShiftRight':
      return 'Shift';
    case 'ControlLeft':
    case 'ControlRight':
      return 'Ctrl';
    case 'AltLeft':
    case 'AltRight':
      return 'Alt';
    case 'Delete':
      return 'Del';
    case 'Backspace':
      return 'Backspace';
    case 'Enter':
      return 'Enter';
    case 'Tab':
      return 'Tab';
    case 'ArrowUp':
      return '↑';
    case 'ArrowDown':
      return '↓';
    case 'ArrowLeft':
      return '←';
    case 'ArrowRight':
      return '→';
    case 'Minus':
      return '-';
    case 'Equal':
      return '=';
    case 'BracketLeft':
      return '[';
    case 'BracketRight':
      return ']';
    default:
      return code;
  }
}

