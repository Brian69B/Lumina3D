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
  | 'building-rowhouse'
  | 'building-commercial'
  | 'building-warehouse'
  | 'building-civic'
  | 'building-apartments'
  | 'building-skyscraper'
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
  | 'path-gravel'
  | 'parking-lot';

export type BuilderTool = TargetKind | 'light' | null;

export interface BuildingDimensions {
  width: number;
  length: number;
  height: number;
}

export const BUILDING_DEFAULT_DIMENSIONS: Partial<Record<TargetKind, BuildingDimensions>> = {
  'building-kiosk': { width: 3.8, length: 3.8, height: 3.8 },
  'building-small': { width: 4.4, length: 4.4, height: 6.3 },
  'building-tall': { width: 5.2, length: 5.2, height: 11.6 },
  'building-highrise': { width: 5.6, length: 5.6, height: 22.0 },
  'building-rowhouse': { width: 9.4, length: 4.6, height: 8.2 },
  'building-commercial': { width: 10.6, length: 4.8, height: 4.8 },
  'building-warehouse': { width: 10.2, length: 6.4, height: 7.4 },
  'building-civic': { width: 10.4, length: 6.8, height: 10.4 },
  'building-apartments': { width: 9.0, length: 7.0, height: 15.2 },
  'building-skyscraper': { width: 7.8, length: 6.2, height: 30.0 },
};

export const BUILDING_DEFAULT_HEIGHTS: Partial<Record<TargetKind, number>> = {
  'building-kiosk': 3.8,
  'building-small': 6.3,
  'building-tall': 11.6,
  'building-highrise': 22.0,
  'building-rowhouse': 8.2,
  'building-commercial': 4.8,
  'building-warehouse': 7.4,
  'building-civic': 10.4,
  'building-apartments': 15.2,
  'building-skyscraper': 30.0,
};

export function isBuildingKind(kind: TargetKind): boolean {
  return kind in BUILDING_DEFAULT_HEIGHTS;
}

export function isRoadOrPathKind(kind: TargetKind): boolean {
  return kind.startsWith('road-') || kind.startsWith('path-') || kind === 'parking-lot';
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
  | 'Crossing'
  | 'north-loop'
  | 'roundabout-cw'
  | 'south-shuttle'
  | 'ped-south';

export interface CrossingWaypoint {
  x: number;
  z: number;
  action: 'walk' | 'pause-at-curb' | 'cross';
  pauseSec?: number;
}

export interface StreetTarget {
  id: string;
  kind: TargetKind;
  label: string;
  position: { x: number; z: number };
  rotationY: number; // Radians
  width?: number; // Custom width (X) in meters for building targets
  height?: number; // Custom height (Y) in meters for building targets
  length?: number; // Custom depth (Z) for buildings or segment length (X) for modular roads
  hiddenSidewalks?: string[]; // Removed attached sidewalk part keys for road targets
  motion?: 'walk' | 'drive';
  routeId?: StreetRouteId;
  crossingPath?: CrossingWaypoint[];
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
export type AmbientMode =
  | 'dawn'
  | 'morning'
  | 'noon'
  | 'sunset'
  | 'twilight'
  | 'night';

export const TIME_OF_DAY_OPTIONS: ReadonlyArray<{
  id: AmbientMode;
  label: string;
  timeLabel: string;
}> = [
  { id: 'dawn', label: 'Dawn', timeLabel: '06:00' },
  { id: 'morning', label: 'Morning', timeLabel: '09:30' },
  { id: 'noon', label: 'Midday', timeLabel: '13:00' },
  { id: 'sunset', label: 'Sunset', timeLabel: '18:30' },
  { id: 'twilight', label: 'Twilight', timeLabel: '20:00' },
  { id: 'night', label: 'Night', timeLabel: '23:00' },
];

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

