import { memo, useState } from 'react';
import {
  Armchair,
  Bike,
  Box,
  Building2,
  Bus,
  Camera,
  Car,
  ChevronDown,
  ChevronUp,
  CircleDot,
  Copy,
  CornerDownRight,
  Eye,
  EyeOff,
  Footprints,
  GitFork,
  Hammer,
  Keyboard,
  LayoutGrid,
  Lightbulb,
  Milestone,
  Moon,
  MousePointer2,
  Plus,
  RotateCw,
  Route,
  Sliders,
  Sprout,
  Spline,
  Sun,
  Sunrise,
  Sunset,
  Trash2,
  Trees,
  Truck,
  User,
  X,
} from 'lucide-react';
import {
  BUILDING_DEFAULT_HEIGHTS,
  BuilderTool,
  CameraPresetId,
  FIXTURE_MAX_X,
  FIXTURE_MAX_Z,
  formatKeyCode,
  formatMouseButton,
  getRoadSidewalkPartKeys,
  InputControlsConfig,
  isBuildingKind,
  LightFixture,
  MAX_FIXTURES,
  PhotometricStats,
  StreetTarget,
  TargetKind,
  TIME_OF_DAY_OPTIONS,
  ViewportSettings,
} from '../types/lighting';
import { getFixtureHex, kelvinToRgb, rgbToHex, SCENE_PRESETS } from '../utils/photometrics';
import { ControlsTabPanel } from './ControlsTabPanel';
import { LightShieldDial } from './LightShieldDial';

type DockTab = 'lighting' | 'builder' | 'fixtures' | 'presets' | 'controls';

interface ControlDockProps {
  collapsed: boolean;
  onToggleCollapse: () => void;
  fixtures: LightFixture[];
  activeFixtureId: string;
  onSelectFixture: (id: string) => void;
  onUpdateFixture: (id: string, patch: Partial<LightFixture>) => void;
  onRotateFixture: (id: string, deltaDeg: number) => void;
  onAddFixture: () => void;
  onDuplicateFixture: (id: string) => void;
  onRemoveFixture: (id: string) => void;
  targets: StreetTarget[];
  selectedTargetId: string | null;
  onSelectTarget: (id: string | null) => void;
  onAddTarget: (kind: TargetKind) => void;
  onRotateTarget: (id: string, deltaRad?: number) => void;
  onRemoveTarget: (id: string) => void;
  onClearTargets: () => void;
  onRemoveAllSidewalks: () => void;
  builderTool: BuilderTool;
  builderRotationY: number;
  onSelectBuilderTool: (tool: BuilderTool) => void;
  onRotateBuilderTool: () => void;
  onDragStartBuilderTool?: (tool: Exclude<BuilderTool, null>) => void;
  onDragEndBuilderTool?: () => void;
  settings: ViewportSettings;
  onUpdateSettings: (patch: Partial<ViewportSettings>) => void;
  stats: PhotometricStats;
  activePresetId: string;
  onApplyPreset: (presetId: string) => void;
  onCameraPreset: (preset: CameraPresetId) => void;
  controlsConfig: InputControlsConfig;
  onUpdateControlsConfig: (next: InputControlsConfig) => void;
  onResetControlsConfig: () => void;
}

const ANGLE_QUICK_STOPS = [
  { label: '0° Beam', value: 0 },
  { label: '25° Spot', value: 25 },
  { label: '60° Flood', value: 60 },
  { label: '90° Hemi', value: 90 },
  { label: '180° Sphere', value: 180 },
];

const KELVIN_STOPS = [
  { label: '2000K HPS', value: 2000 },
  { label: '3000K Warm', value: 3000 },
  { label: '4000K Neutral', value: 4000 },
  { label: '5700K Daylight', value: 5700 },
  { label: '8000K Cool', value: 8000 },
];

const CUSTOM_SWATCHES = ['#fff4e0', '#38bdf8', '#f59e0b', '#34d399', '#f43f5e', '#a78bfa'];

const LUX_THRESHOLD_STOPS = [1, 2, 5, 10, 20, 50];

type BuilderCategory =
  | 'Roads & Paths'
  | 'Buildings & Scenery'
  | 'People & Vehicles'
  | 'Props & Lights';

const BUILDER_CATALOG: Array<{
  id: Exclude<BuilderTool, null>;
  label: string;
  detail: string;
  category: BuilderCategory;
  icon: typeof Building2;
}> = [
  {
    id: 'road-2lane',
    label: '2-Lane Street',
    detail: '8×9m asphalt',
    category: 'Roads & Paths',
    icon: Route,
  },
  {
    id: 'road-intersection',
    label: '4-Way Junction',
    detail: '9×9m intersection',
    category: 'Roads & Paths',
    icon: LayoutGrid,
  },
  {
    id: 'road-t-junction',
    label: 'T-Junction',
    detail: '9×9m 3-way branch',
    category: 'Roads & Paths',
    icon: GitFork,
  },
  {
    id: 'road-turn-90',
    label: '90° Road Turn',
    detail: '12×12m curved corner',
    category: 'Roads & Paths',
    icon: CornerDownRight,
  },
  {
    id: 'road-curve-45',
    label: '45° Gentle Curve',
    detail: '16m diagonal bend',
    category: 'Roads & Paths',
    icon: Spline,
  },
  {
    id: 'road-crosswalk',
    label: 'Crosswalk Road',
    detail: '6×9m zebra stripes',
    category: 'Roads & Paths',
    icon: Route,
  },
  {
    id: 'road-roundabout',
    label: 'Grand Roundabout',
    detail: '20m 4-way island',
    category: 'Roads & Paths',
    icon: CircleDot,
  },
  {
    id: 'road-culdesac',
    label: 'Mini Roundabout',
    detail: '12m plaza ring',
    category: 'Roads & Paths',
    icon: CircleDot,
  },
  {
    id: 'road-deadend',
    label: 'Cul-de-Sac End',
    detail: '12m turnaround bulb',
    category: 'Roads & Paths',
    icon: CircleDot,
  },
  {
    id: 'path-sidewalk',
    label: 'Concrete Path',
    detail: '8×3m walkway',
    category: 'Roads & Paths',
    icon: Footprints,
  },
  {
    id: 'path-bike',
    label: 'Bike Lane',
    detail: '8×2.4m cycle path',
    category: 'Roads & Paths',
    icon: Bike,
  },
  {
    id: 'path-cobble',
    label: 'Cobble Plaza',
    detail: '6×6m stone pavers',
    category: 'Roads & Paths',
    icon: LayoutGrid,
  },
  {
    id: 'path-gravel',
    label: 'Park Trail',
    detail: '8×2.2m gravel',
    category: 'Roads & Paths',
    icon: Footprints,
  },
  {
    id: 'parking-lot',
    label: 'Parking Lot',
    detail: '12.8×9.4m · 6 stalls · Road link',
    category: 'Roads & Paths',
    icon: Car,
  },
  {
    id: 'building-kiosk',
    label: '1-Story',
    detail: 'Pavilion · 3.8×3.8×3.8m',
    category: 'Buildings & Scenery',
    icon: Building2,
  },
  {
    id: 'building-small',
    label: '2-Story',
    detail: 'Storefront · 4.4×4.4×6.3m',
    category: 'Buildings & Scenery',
    icon: Building2,
  },
  {
    id: 'building-tall',
    label: '4-Story',
    detail: 'Mid-Rise · 5.2×5.2×11.6m',
    category: 'Buildings & Scenery',
    icon: Building2,
  },
  {
    id: 'building-highrise',
    label: '8-Story',
    detail: 'Tower · 5.6×5.6×22m',
    category: 'Buildings & Scenery',
    icon: Building2,
  },
  {
    id: 'building-rowhouse',
    label: 'Rowhouse',
    detail: 'Brownstone · 9.4×4.6×8.2m',
    category: 'Buildings & Scenery',
    icon: Building2,
  },
  {
    id: 'building-commercial',
    label: 'Retail Strip',
    detail: 'Canopy Plaza · 10.6×4.8×4.8m',
    category: 'Buildings & Scenery',
    icon: Building2,
  },
  {
    id: 'building-warehouse',
    label: 'Industrial Hall',
    detail: 'Sawtooth · 10.2×6.4×7.4m',
    category: 'Buildings & Scenery',
    icon: Building2,
  },
  {
    id: 'building-civic',
    label: 'Civic Hall',
    detail: 'Colonnade · 10.4×6.8×10.4m',
    category: 'Buildings & Scenery',
    icon: Building2,
  },
  {
    id: 'building-apartments',
    label: 'L-Apartments',
    detail: 'Balcony · 9.0×7.0×15.2m',
    category: 'Buildings & Scenery',
    icon: Building2,
  },
  {
    id: 'building-skyscraper',
    label: 'Skyscraper',
    detail: 'Setback · 7.8×6.2×30m',
    category: 'Buildings & Scenery',
    icon: Building2,
  },
  {
    id: 'tree',
    label: 'Street Tree',
    detail: 'Canopy · 4.2m',
    category: 'Buildings & Scenery',
    icon: Trees,
  },
  {
    id: 'hedge',
    label: 'Hedge',
    detail: 'Planter · 2.6×0.9m',
    category: 'Buildings & Scenery',
    icon: Sprout,
  },
  {
    id: 'bench',
    label: 'Park Bench',
    detail: 'Timber · 1.9m',
    category: 'Buildings & Scenery',
    icon: Armchair,
  },
  {
    id: 'pedestrian',
    label: 'Person',
    detail: 'Pedestrian · 1.75m',
    category: 'People & Vehicles',
    icon: User,
  },
  {
    id: 'bike',
    label: 'Bicycle',
    detail: 'Cycle · 1.8m',
    category: 'People & Vehicles',
    icon: Bike,
  },
  {
    id: 'motorcycle',
    label: 'Motorcycle',
    detail: 'Moto · 2.1m',
    category: 'People & Vehicles',
    icon: Bike,
  },
  {
    id: 'sedan',
    label: 'Sedan',
    detail: 'Car · 4.3m',
    category: 'People & Vehicles',
    icon: Car,
  },
  {
    id: 'van',
    label: 'Delivery Van',
    detail: 'Van · 5.1m',
    category: 'People & Vehicles',
    icon: Truck,
  },
  {
    id: 'truck',
    label: 'Box Truck',
    detail: 'Freight · 6.8m',
    category: 'People & Vehicles',
    icon: Truck,
  },
  {
    id: 'bus',
    label: 'City Bus',
    detail: 'Transit · 9.2m',
    category: 'People & Vehicles',
    icon: Bus,
  },
  {
    id: 'bollard',
    label: 'Bollard',
    detail: 'Safety post · 1.0m',
    category: 'Props & Lights',
    icon: Milestone,
  },
  {
    id: 'crate',
    label: 'Cargo Crate',
    detail: 'Utility · 1.2m',
    category: 'Props & Lights',
    icon: Box,
  },
  {
    id: 'traffic-light',
    label: 'Traffic Light',
    detail: '4-way intersection signal',
    category: 'Props & Lights',
    icon: CircleDot,
  },
  {
    id: 'light',
    label: 'Light Pole',
    detail: 'New 8m fixture',
    category: 'Props & Lights',
    icon: Lightbulb,
  },
];

function getBuilderLabel(tool: BuilderTool): string {
  return BUILDER_CATALOG.find((item) => item.id === tool)?.label ?? '';
}

export const ControlDock = memo(function ControlDock({
  collapsed,
  onToggleCollapse,
  fixtures,
  activeFixtureId,
  onSelectFixture,
  onUpdateFixture,
  onRotateFixture,
  onAddFixture,
  onDuplicateFixture,
  onRemoveFixture,
  targets,
  selectedTargetId,
  onSelectTarget,
  onAddTarget,
  onRotateTarget,
  onRemoveTarget,
  onClearTargets,
  onRemoveAllSidewalks,
  builderTool,
  builderRotationY,
  onSelectBuilderTool,
  onRotateBuilderTool,
  onDragStartBuilderTool,
  onDragEndBuilderTool,
  settings,
  onUpdateSettings,
  stats,
  activePresetId,
  onApplyPreset,
  onCameraPreset,
  controlsConfig,
  onUpdateControlsConfig,
  onResetControlsConfig,
}: ControlDockProps) {
  const [activeTab, setActiveTab] = useState<DockTab>('lighting');
  const [builderFilter, setBuilderFilter] = useState<'All' | BuilderCategory>('All');

  const hasRemovableSidewalk = targets.some(
    (t) =>
      t.kind === 'path-sidewalk' ||
      (getRoadSidewalkPartKeys(t.kind).length > 0 &&
        (t.hiddenSidewalks?.length ?? 0) < getRoadSidewalkPartKeys(t.kind).length),
  );

  const activeFixture =
    fixtures.find((f) => f.id === activeFixtureId) ?? fixtures[0];

  const builderAngleDeg =
    ((Math.round((builderRotationY * 180) / Math.PI) % 360) + 360) % 360;

  const spreadDescription =
    activeFixture.angleRange <= 2
      ? 'Straight collimated beam'
      : activeFixture.angleRange < 88
        ? `Conical beam (${activeFixture.angleRange * 2}° total)`
        : activeFixture.angleRange <= 92
          ? '180° downward hemisphere'
          : activeFixture.angleRange < 179
            ? `Wide wrap-around (${activeFixture.angleRange * 2}°)`
            : 'Full 360° circle around';

  const handleOpenBuilder = () => {
    if (builderTool !== null) {
      onSelectBuilderTool(null);
      return;
    }
    setActiveTab('builder');
    if (collapsed) {
      onToggleCollapse();
    }
  };

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-20 flex flex-col items-center px-3">
      {/* Active Placement Strip (visible even when dock is collapsed) */}
      {builderTool !== null && (
        <div className="pointer-events-auto mb-2 flex flex-wrap items-center gap-2 rounded-lg border border-cyan-500/50 bg-[#0b0e17]/95 px-3 py-1.5 text-xs shadow-lg">
          <Hammer className="h-3.5 w-3.5 text-cyan-400 shrink-0" />
          <span className="font-medium text-cyan-100 whitespace-nowrap">
            Placing: <strong className="text-white">{getBuilderLabel(builderTool)}</strong>
          </span>
          <span className="font-mono-tabular text-[11px] text-cyan-300/80 whitespace-nowrap">
            {builderAngleDeg}°
          </span>
          <span className="hidden sm:inline text-slate-400">
            · Click street to place · {formatMouseButton(controlsConfig.rotateMouseButton)} rotates camera
          </span>
          <button
            type="button"
            onClick={onRotateBuilderTool}
            className="flex items-center gap-1 rounded border border-slate-700 bg-slate-900 px-2 py-0.5 text-[11px] font-medium text-slate-200 hover:border-cyan-500/60 hover:text-white whitespace-nowrap shrink-0"
            title={`Rotate placement 45° (${formatKeyCode(controlsConfig.keybinds.rotate)})`}
          >
            <RotateCw className="h-3 w-3 text-cyan-400" />
            <span>Rotate 45° ({formatKeyCode(controlsConfig.keybinds.rotate)})</span>
          </button>
          <button
            type="button"
            onClick={() => onSelectBuilderTool(null)}
            className="flex items-center gap-1 rounded border border-slate-700 bg-slate-900 px-2 py-0.5 text-[11px] font-medium text-slate-300 hover:border-rose-500/60 hover:text-rose-200 whitespace-nowrap shrink-0"
            title="Exit placement mode (Esc)"
          >
            <X className="h-3 w-3" />
            <span>Done (Esc)</span>
          </button>
        </div>
      )}

      {/* Dock Handle + Builder Trigger */}
      <div className="pointer-events-auto mb-1.5 flex items-center gap-2">

        <button
          type="button"
          onClick={handleOpenBuilder}
          className={`flex items-center gap-1.5 rounded-t-lg border border-b-0 px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
            builderTool !== null || (!collapsed && activeTab === 'builder')
              ? 'border-cyan-500/60 bg-cyan-500/15 text-cyan-200'
              : 'border-slate-800 bg-[#0b0e17]/95 text-slate-300 hover:bg-slate-900 hover:text-white'
          }`}
          title="Open Street Builder palette to place buildings, people, and extra lights"
        >
          <Hammer className="h-3.5 w-3.5 text-cyan-400" />
          <span>{builderTool !== null ? 'Exit Builder' : 'Builder'}</span>
        </button>

        <button
          type="button"
          onClick={onToggleCollapse}
          className="flex items-center gap-1.5 rounded-t-lg border border-b-0 border-slate-800 bg-[#0b0e17]/95 px-3.5 py-1.5 text-xs font-medium text-slate-300 transition-colors hover:bg-slate-900 hover:text-white whitespace-nowrap shrink-0"
          title={`Toggle control dock (${formatKeyCode(controlsConfig.keybinds.toggleDock)})`}
        >
          {collapsed ? (
            <>
              <ChevronUp className="h-3.5 w-3.5 text-amber-400" />
              <span>Show Controls</span>
            </>
          ) : (
            <>
              <ChevronDown className="h-3.5 w-3.5 text-amber-400" />
              <span>Hide Controls</span>
            </>
          )}
        </button>
      </div>

      {/* Main Dock Panel */}
      {!collapsed && (
        <section
          aria-label="Photometric lighting controls"
          className="pointer-events-auto w-full max-w-[1040px] rounded-xl border border-slate-800 bg-[#0b0e17]/96 shadow-2xl"
        >
          {/* Tab Bar + Quick Fixture Switcher */}
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800/90 px-4 py-2.5">
            <div className="flex flex-wrap items-center gap-1 rounded-lg bg-slate-900/90 p-1">
              {(
                [
                  { id: 'lighting', label: 'Beam & Optics', icon: Sliders },
                  { id: 'builder', label: 'Builder', icon: Hammer },
                  { id: 'fixtures', label: 'Lights & Targets', icon: Lightbulb },
                  { id: 'presets', label: 'Presets & View', icon: Camera },
                  { id: 'controls', label: 'Controls', icon: Keyboard },
                ] as const
              ).map((tab) => {
                const Icon = tab.icon;
                const isActive = activeTab === tab.id;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setActiveTab(tab.id)}
                    className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                      isActive
                        ? tab.id === 'builder'
                          ? 'bg-cyan-400 text-slate-950 font-semibold'
                          : 'bg-amber-500 text-slate-950 font-semibold'
                        : 'text-slate-300 hover:bg-slate-800 hover:text-white'
                    }`}
                  >
                    <Icon className="h-3.5 w-3.5" />
                    <span>{tab.label}</span>
                  </button>
                );
              })}
            </div>

            {/* Active fixture selector when multiple lights exist */}
            <div className="flex items-center gap-2">
              {fixtures.length > 1 && (
                <div className="flex items-center gap-1">
                  {fixtures.map((f, idx) => (
                    <button
                      key={f.id}
                      type="button"
                      onClick={() => onSelectFixture(f.id)}
                      className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                        f.id === activeFixture.id
                          ? 'border-amber-500/70 bg-amber-500/15 text-amber-200'
                          : 'border-slate-800 bg-slate-900 text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      <span
                        className="h-2 w-2 rounded-xs shrink-0"
                        style={{ backgroundColor: getFixtureHex(f) }}
                      />
                      <span>L{idx + 1}</span>
                    </button>
                  ))}
                </div>
              )}

              {/* Quick overlay toggles */}
              <div className="hidden sm:flex items-center gap-1 border-l border-slate-800 pl-2.5">
                <button
                  type="button"
                  onClick={() =>
                    onUpdateSettings({ showBeamEnvelope: !settings.showBeamEnvelope })
                  }
                  className={`rounded-md border px-2.5 py-1 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                    settings.showBeamEnvelope
                      ? 'border-cyan-500/50 bg-cyan-500/15 text-cyan-200'
                      : 'border-slate-800 bg-slate-900 text-slate-400 hover:text-slate-200'
                  }`}
                >
                  Beam Shell
                </button>
                <button
                  type="button"
                  onClick={() =>
                    onUpdateSettings({ showLuxHeatmap: !settings.showLuxHeatmap })
                  }
                  className={`rounded-md border px-2.5 py-1 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                    settings.showLuxHeatmap
                      ? 'border-cyan-500/50 bg-cyan-500/15 text-cyan-200'
                      : 'border-slate-800 bg-slate-900 text-slate-400 hover:text-slate-200'
                  }`}
                >
                  Lux Isolines
                </button>
              </div>
            </div>
          </div>

          {/* Tab Content */}
          <div className="p-4">
            {activeTab === 'lighting' && (
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-12 lg:items-stretch">
                <div className="flex flex-col justify-between gap-3 lg:col-span-8">
                  <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
                    {/* 1. Pole Mounting Height */}
                    <div className="space-y-1.5">
                      <div className="flex items-baseline justify-between">
                        <label
                          htmlFor="slider-height"
                          className="text-xs font-medium text-slate-300"
                        >
                          Light Height
                        </label>
                        <span className="font-mono-tabular text-sm font-semibold text-amber-400">
                          {activeFixture.height.toFixed(1)} m
                        </span>
                      </div>
                      <input
                        id="slider-height"
                        type="range"
                        min={0.5}
                        max={15}
                        step={0.1}
                        value={activeFixture.height}
                        onChange={(e) =>
                          onUpdateFixture(activeFixture.id, {
                            height: parseFloat(e.target.value),
                          })
                        }
                        className="instrument-slider"
                      />
                      <div className="flex justify-between text-[11px] font-mono-tabular text-slate-500">
                        <span>0.5 m bollard</span>
                        <span>15 m mast</span>
                      </div>
                    </div>

                    {/* 2. Light Tilt Angle */}
                    <div className="space-y-1.5">
                      <div className="flex items-baseline justify-between">
                        <label
                          htmlFor="slider-tilt"
                          className="text-xs font-medium text-slate-300"
                        >
                          Light Tilt Angle
                        </label>
                        <span className="font-mono-tabular text-sm font-semibold text-amber-400">
                          {activeFixture.tiltAngle}°
                        </span>
                      </div>
                      <input
                        id="slider-tilt"
                        type="range"
                        min={0}
                        max={180}
                        step={1}
                        value={activeFixture.tiltAngle}
                        onChange={(e) =>
                          onUpdateFixture(activeFixture.id, {
                            tiltAngle: parseInt(e.target.value, 10),
                          })
                        }
                        className="instrument-slider"
                      />
                      <div className="flex justify-between text-[11px] font-mono-tabular text-slate-500">
                        <span>0° down</span>
                        <span>90° horiz</span>
                        <span>180° up</span>
                      </div>
                    </div>

                    {/* 3. Beam Angle Range */}
                    <div className="space-y-1.5">
                      <div className="flex items-baseline justify-between">
                        <label
                          htmlFor="slider-range"
                          className="text-xs font-medium text-slate-300"
                        >
                          Angle Range
                        </label>
                        <span className="font-mono-tabular text-sm font-semibold text-cyan-400">
                          {activeFixture.angleRange}°
                        </span>
                      </div>
                      <input
                        id="slider-range"
                        type="range"
                        min={0}
                        max={180}
                        step={1}
                        value={activeFixture.angleRange}
                        onChange={(e) =>
                          onUpdateFixture(activeFixture.id, {
                            angleRange: parseInt(e.target.value, 10),
                          })
                        }
                        className="instrument-slider"
                      />
                      <div className="text-[11px] text-slate-400 truncate">
                        {spreadDescription}
                      </div>
                    </div>

                    {/* 4. Azimuth / Yaw + Position */}
                    <div className="space-y-1.5">
                      <div className="flex items-baseline justify-between">
                        <label
                          htmlFor="slider-yaw"
                          className="text-xs font-medium text-slate-300"
                        >
                          Aim Direction (Yaw)
                        </label>
                        <span className="font-mono-tabular text-sm font-semibold text-slate-200">
                          {activeFixture.yawAngle}°
                        </span>
                      </div>
                      <input
                        id="slider-yaw"
                        type="range"
                        min={-180}
                        max={180}
                        step={1}
                        value={activeFixture.yawAngle}
                        onChange={(e) =>
                          onUpdateFixture(activeFixture.id, {
                            yawAngle: parseInt(e.target.value, 10),
                          })
                        }
                        className="instrument-slider"
                      />
                      <div className="flex items-center gap-1.5 pt-0.5">
                        <span className="text-[11px] text-slate-500 whitespace-nowrap">
                          X/Z:
                        </span>
                        <input
                          type="number"
                          aria-label="Pole X position in meters"
                          min={-FIXTURE_MAX_X}
                          max={FIXTURE_MAX_X}
                          step={0.5}
                          value={activeFixture.position.x}
                          onChange={(e) =>
                            onUpdateFixture(activeFixture.id, {
                              position: {
                                ...activeFixture.position,
                                x: Number(e.target.value) || 0,
                              },
                            })
                          }
                          className="w-14 rounded border border-slate-700 bg-slate-900 px-1.5 py-0.5 font-mono-tabular text-xs text-slate-200"
                        />
                        <input
                          type="number"
                          aria-label="Pole Z position in meters"
                          min={-FIXTURE_MAX_Z}
                          max={FIXTURE_MAX_Z}
                          step={0.5}
                          value={activeFixture.position.z}
                          onChange={(e) =>
                            onUpdateFixture(activeFixture.id, {
                              position: {
                                ...activeFixture.position,
                                z: Number(e.target.value) || 0,
                              },
                            })
                          }
                          className="w-14 rounded border border-slate-700 bg-slate-900 px-1.5 py-0.5 font-mono-tabular text-xs text-slate-200"
                        />
                      </div>
                    </div>

                    {/* 5. Luminous Flux */}
                    <div className="space-y-1.5">
                      <div className="flex items-baseline justify-between">
                        <label
                          htmlFor="slider-lumens"
                          className="text-xs font-medium text-slate-300"
                        >
                          Luminous Flux
                        </label>
                        <span className="font-mono-tabular text-sm font-semibold text-amber-400">
                          {activeFixture.lumens.toLocaleString()} lm
                        </span>
                      </div>
                      <input
                        id="slider-lumens"
                        type="range"
                        min={500}
                        max={30000}
                        step={250}
                        value={activeFixture.lumens}
                        onChange={(e) =>
                          onUpdateFixture(activeFixture.id, {
                            lumens: parseInt(e.target.value, 10),
                          })
                        }
                        className="instrument-slider"
                      />
                      <div className="flex justify-between text-[11px] font-mono-tabular text-slate-500">
                        <span>500 lm</span>
                        <span>15k</span>
                        <span>30,000 lm</span>
                      </div>
                    </div>

                    {/* 6. Color Temperature (Kelvin) */}
                    <div className="space-y-1.5">
                      <div className="flex items-baseline justify-between">
                        <label
                          htmlFor="slider-kelvin"
                          className="text-xs font-medium text-slate-300"
                        >
                          Color Temp
                        </label>
                        <span className="font-mono-tabular text-sm font-semibold text-slate-100">
                          {activeFixture.kelvin} K
                        </span>
                      </div>
                      <input
                        id="slider-kelvin"
                        type="range"
                        min={1800}
                        max={10000}
                        step={100}
                        value={activeFixture.kelvin}
                        onChange={(e) =>
                          onUpdateFixture(activeFixture.id, {
                            kelvin: parseInt(e.target.value, 10),
                            useCustomColor: false,
                          })
                        }
                        className="instrument-slider"
                      />
                      <div
                        className="h-1.5 w-full rounded-full"
                        style={{
                          background:
                            'linear-gradient(90deg, #ff7e2e 0%, #ffb46b 25%, #fff2dc 50%, #dceaff 75%, #a8c9ff 100%)',
                        }}
                      />
                      <div className="flex flex-wrap gap-1 pt-0.5">
                        {KELVIN_STOPS.map((k) => (
                          <button
                            key={k.value}
                            type="button"
                            onClick={() =>
                              onUpdateFixture(activeFixture.id, {
                                kelvin: k.value,
                                useCustomColor: false,
                              })
                            }
                            className={`rounded border px-1.5 py-0.5 text-[10px] font-mono-tabular transition-colors whitespace-nowrap shrink-0 ${
                              !activeFixture.useCustomColor &&
                              Math.abs(activeFixture.kelvin - k.value) <= 150
                                ? 'border-amber-500 bg-amber-500/20 text-amber-200'
                                : 'border-slate-800 bg-slate-900 text-slate-400 hover:text-slate-200'
                            }`}
                            title={k.label}
                          >
                            {k.value}K
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>

                  {/* Lux Threshold Slider + Quick Presets + Live Coverage Info */}
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-slate-800/80 pt-2.5">
                    <div className="flex min-w-[200px] flex-1 items-center gap-3">
                      <label
                        htmlFor="slider-lux-threshold"
                        className="text-xs font-medium text-slate-300 whitespace-nowrap shrink-0"
                      >
                        Lux Threshold
                      </label>
                      <input
                        id="slider-lux-threshold"
                        type="range"
                        min={0.5}
                        max={50}
                        step={0.5}
                        value={settings.luxThreshold}
                        onChange={(e) =>
                          onUpdateSettings({
                            luxThreshold: parseFloat(e.target.value),
                          })
                        }
                        className="instrument-slider flex-1"
                      />
                      <span className="font-mono-tabular text-xs font-semibold text-cyan-400 whitespace-nowrap w-14 text-right">
                        {settings.luxThreshold.toFixed(1)} lx
                      </span>
                    </div>

                    <div className="flex flex-wrap items-center gap-1">
                      {LUX_THRESHOLD_STOPS.map((val) => (
                        <button
                          key={val}
                          type="button"
                          onClick={() => onUpdateSettings({ luxThreshold: val })}
                          className={`rounded border px-1.5 py-0.5 text-[10px] font-mono-tabular transition-colors whitespace-nowrap shrink-0 ${
                            Math.abs(settings.luxThreshold - val) < 0.05
                              ? 'border-cyan-500 bg-cyan-500/20 text-cyan-200'
                              : 'border-slate-800 bg-slate-900 text-slate-400 hover:text-slate-200'
                          }`}
                        >
                          {val} lx
                        </button>
                      ))}
                      <button
                        type="button"
                        onClick={() =>
                          onUpdateSettings({ showLuxHeatmap: !settings.showLuxHeatmap })
                        }
                        className={`ml-1 rounded border px-2 py-0.5 text-[10px] font-medium transition-colors whitespace-nowrap shrink-0 ${
                          settings.showLuxHeatmap
                            ? 'border-cyan-500/70 bg-cyan-500/20 text-cyan-200'
                            : 'border-slate-700 bg-slate-900 text-slate-300 hover:text-white'
                        }`}
                        title="Toggle 3D Lux Isolines overlay clipped at the lux threshold"
                      >
                        {settings.showLuxHeatmap ? 'Overlay On' : 'Show Overlay'}
                      </button>
                      <span
                        className="ml-1.5 border-l border-slate-800 pl-2 font-mono-tabular text-[11px] text-slate-300 whitespace-nowrap shrink-0"
                        title="Total corridor ground area at or above the active lux threshold, and peak ground illuminance"
                      >
                        Area{' '}
                        <strong className="text-cyan-300">
                          {stats.footprintAreaSqM.toLocaleString()} m²
                        </strong>
                        {' · Peak '}
                        <strong className="text-amber-300">
                          {stats.peakGroundLux >= 100
                            ? stats.peakGroundLux.toFixed(0)
                            : stats.peakGroundLux.toFixed(1)}{' '}
                          lx
                        </strong>
                      </span>
                    </div>
                  </div>

                  {/* Unified Bottom Controls Strip: Spread Presets, Custom Tint & Environment */}
                  <div className="flex flex-wrap items-center justify-between gap-2.5 border-t border-slate-800/80 pt-2.5">
                    <div className="flex flex-wrap items-center gap-1">
                      <span className="mr-0.5 text-[11px] font-medium text-slate-400">
                        Spread:
                      </span>
                      {ANGLE_QUICK_STOPS.map((stop) => (
                        <button
                          key={stop.value}
                          type="button"
                          onClick={() =>
                            onUpdateFixture(activeFixture.id, { angleRange: stop.value })
                          }
                          className={`rounded border px-2 py-0.5 text-[11px] font-medium transition-colors whitespace-nowrap shrink-0 ${
                            activeFixture.angleRange === stop.value
                              ? 'border-cyan-500 bg-cyan-500/20 text-cyan-200'
                              : 'border-slate-800 bg-slate-900 text-slate-300 hover:border-slate-700 hover:text-white'
                          }`}
                        >
                          {stop.label}
                        </button>
                      ))}
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() =>
                            onUpdateFixture(activeFixture.id, {
                              useCustomColor: !activeFixture.useCustomColor,
                              customColor: activeFixture.useCustomColor
                                ? activeFixture.customColor
                                : rgbToHex(kelvinToRgb(activeFixture.kelvin)),
                            })
                          }
                          className={`rounded border px-2 py-0.5 text-[11px] font-medium transition-colors whitespace-nowrap shrink-0 ${
                            activeFixture.useCustomColor
                              ? 'border-amber-500 bg-amber-500/20 text-amber-200'
                              : 'border-slate-700 bg-slate-900 text-slate-400 hover:text-slate-200'
                          }`}
                        >
                          {activeFixture.useCustomColor ? 'Custom Tint' : 'Kelvin Tint'}
                        </button>
                        <input
                          type="color"
                          aria-label="Custom beam RGB color"
                          value={activeFixture.customColor}
                          onChange={(e) =>
                            onUpdateFixture(activeFixture.id, {
                              useCustomColor: true,
                              customColor: e.target.value,
                            })
                          }
                          className="h-6 w-7 cursor-pointer rounded border border-slate-700 bg-slate-900 p-0.5"
                        />
                        <div className="flex items-center gap-1">
                          {CUSTOM_SWATCHES.map((hex) => (
                            <button
                              key={hex}
                              type="button"
                              aria-label={`Select color ${hex}`}
                              onClick={() =>
                                onUpdateFixture(activeFixture.id, {
                                  useCustomColor: true,
                                  customColor: hex,
                                })
                              }
                              className="h-4 w-4 rounded border border-white/20 transition-transform hover:scale-110"
                              style={{ backgroundColor: hex }}
                            />
                          ))}
                        </div>
                      </div>

                      <div className="flex items-center gap-1 border-l border-slate-800 pl-2">
                        <button
                          type="button"
                          onClick={() =>
                            onUpdateSettings({ showGrid: !settings.showGrid })
                          }
                          className={`rounded border px-2 py-0.5 text-[11px] font-medium whitespace-nowrap shrink-0 ${
                            settings.showGrid
                              ? 'border-slate-600 bg-slate-800 text-slate-100'
                              : 'border-slate-800 bg-slate-900 text-slate-400'
                          }`}
                        >
                          1m Grid
                        </button>
                        <label className="flex items-center gap-1 rounded border border-slate-700 bg-slate-900 px-2 py-0.5 text-[11px] font-medium text-slate-300 whitespace-nowrap shrink-0">
                          <span className="text-slate-400">Time:</span>
                          <select
                            aria-label="Time of day"
                            value={settings.ambientMode}
                            onChange={(e) =>
                              onUpdateSettings({
                                ambientMode: e.target.value as ViewportSettings['ambientMode'],
                              })
                            }
                            className="bg-transparent text-slate-100 outline-none cursor-pointer"
                          >
                            {TIME_OF_DAY_OPTIONS.map((opt) => (
                              <option
                                key={opt.id}
                                value={opt.id}
                                className="bg-slate-900 text-slate-100"
                              >
                                {opt.label}
                              </option>
                            ))}
                          </select>
                        </label>
                      </div>
                    </div>
                  </div>
                </div>

                {/* 360-degree Interactive Light Shield Circle */}
                <div className="lg:col-span-4 flex flex-col">
                  <LightShieldDial
                    fixture={activeFixture}
                    onChangeMask={(mask) =>
                      onUpdateFixture(activeFixture.id, { shieldSectors: mask })
                    }
                    onChangeSectorAngles={(sectorAngles) =>
                      onUpdateFixture(activeFixture.id, { sectorAngles })
                    }
                  />
                </div>
              </div>
            )}

            {activeTab === 'builder' && (
              <div className="space-y-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800/80 pb-2">
                  <div className="flex flex-wrap items-center gap-1">
                    {(
                      [
                        'All',
                        'Roads & Paths',
                        'Buildings & Scenery',
                        'People & Vehicles',
                        'Props & Lights',
                      ] as const
                    ).map((filter) => (
                      <button
                        key={filter}
                        type="button"
                        onClick={() => setBuilderFilter(filter)}
                        className={`rounded-md border px-2 py-1 text-[11px] font-medium transition-colors whitespace-nowrap shrink-0 ${
                          builderFilter === filter
                            ? 'border-cyan-500/70 bg-cyan-500/15 text-cyan-200'
                            : 'border-slate-800 bg-slate-900 text-slate-400 hover:text-slate-200'
                        }`}
                      >
                        {filter}
                      </button>
                    ))}
                  </div>
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => onSelectBuilderTool(null)}
                      className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                        builderTool === null
                          ? 'border-amber-500/70 bg-amber-500/15 text-amber-200'
                          : 'border-slate-700 bg-slate-900 text-slate-300 hover:text-white'
                      }`}
                    >
                      <MousePointer2 className="h-3.5 w-3.5" />
                      <span>Select / Drag</span>
                    </button>
                    <button
                      type="button"
                      onClick={onRotateBuilderTool}
                      className="flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-900 px-2.5 py-1 text-xs font-medium text-slate-200 hover:border-cyan-500/60 hover:text-white whitespace-nowrap shrink-0"
                      title="Rotate placement heading 45° (R)"
                    >
                      <RotateCw className="h-3.5 w-3.5 text-cyan-400" />
                      <span className="font-mono-tabular">Rotate ({builderAngleDeg}°)</span>
                    </button>
                    <button
                      type="button"
                      disabled={!hasRemovableSidewalk}
                      onClick={onRemoveAllSidewalks}
                      className="flex items-center gap-1 rounded-md border border-slate-800 bg-slate-900 px-2.5 py-1 text-xs font-medium text-slate-300 hover:border-amber-500/50 hover:text-amber-200 disabled:opacity-40 whitespace-nowrap shrink-0"
                      title="Remove all sidewalks and concrete paths across the map"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      <span>Remove Sidewalks</span>
                    </button>
                    <button
                      type="button"
                      disabled={targets.length === 0}
                      onClick={onClearTargets}
                      className="flex items-center gap-1 rounded-md border border-slate-800 bg-slate-900 px-2.5 py-1 text-xs font-medium text-slate-400 hover:border-rose-500/50 hover:text-rose-300 disabled:opacity-40 whitespace-nowrap shrink-0"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      <span>Clear ({targets.length})</span>
                    </button>
                  </div>
                </div>

                <div className="max-h-[210px] space-y-3 overflow-y-auto pr-1">
                  {(
                    [
                      'Roads & Paths',
                      'Buildings & Scenery',
                      'People & Vehicles',
                      'Props & Lights',
                    ] as const
                  )
                    .filter((cat) => builderFilter === 'All' || builderFilter === cat)
                    .map((category) => {
                      const items = BUILDER_CATALOG.filter((i) => i.category === category);
                      return (
                        <div key={category} className="space-y-1.5">
                          <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                            {category}
                          </div>
                          <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4 lg:grid-cols-5">
                            {items.map((item) => {
                              const Icon = item.icon;
                              const isLightLimit =
                                item.id === 'light' && fixtures.length >= MAX_FIXTURES;
                              const isArmed = builderTool === item.id;
                              return (
                                <button
                                  key={item.id}
                                  type="button"
                                  disabled={isLightLimit}
                                  draggable={!isLightLimit}
                                  onDragStart={(e) => {
                                    if (isLightLimit) return;
                                    e.dataTransfer.setData(
                                      'application/x-luminastreet-builder',
                                      item.id,
                                    );
                                    e.dataTransfer.setData('text/plain', item.id);
                                    e.dataTransfer.effectAllowed = 'copy';
                                    onDragStartBuilderTool?.(item.id);
                                  }}
                                  onDragEnd={() => onDragEndBuilderTool?.()}
                                  onClick={() =>
                                    onSelectBuilderTool(isArmed ? null : item.id)
                                  }
                                  className={`flex items-start gap-2 rounded-lg border p-2 text-left transition-colors disabled:opacity-40 ${
                                    isLightLimit ? 'cursor-not-allowed' : 'cursor-grab active:cursor-grabbing'
                                  } ${
                                    isArmed
                                      ? 'border-cyan-400 bg-cyan-500/15 text-white'
                                      : 'border-slate-800 bg-slate-900/80 text-slate-200 hover:border-slate-700 hover:bg-slate-900'
                                  }`}
                                  title={`Drag onto 3D street or click to place ${item.label}`}
                                >
                                    <Icon
                                      className={`mt-0.5 h-4 w-4 shrink-0 ${
                                        isArmed
                                          ? 'text-cyan-300'
                                          : item.id === 'light'
                                            ? 'text-amber-400'
                                            : item.id === 'traffic-light'
                                              ? 'text-emerald-400'
                                              : 'text-slate-400'
                                      }`}
                                    />
                                  <div className="min-w-0">
                                    <div className="text-xs font-semibold truncate">
                                      {item.label}
                                    </div>
                                    <div className="text-[10px] text-slate-400 truncate">
                                      {item.id === 'light'
                                        ? `${fixtures.length}/${MAX_FIXTURES} placed`
                                        : item.detail}
                                    </div>
                                  </div>
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })}
                </div>

                <p className="text-[11px] text-slate-400">
                  Tip: Drag any road, path, building, vehicle, or light pole onto the 128×88m map. Click any road, sidewalk, or object and press <span className="font-mono-tabular text-slate-200">R</span> to rotate 45° or <span className="font-mono-tabular text-slate-200">Del</span> to remove it.
                </p>
              </div>
            )}

            {activeTab === 'fixtures' && (
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                {/* Multiple Lights Column */}
                <div className="space-y-2.5">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-slate-200">
                      Light Fixtures ({fixtures.length}/{MAX_FIXTURES})
                    </span>
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => onDuplicateFixture(activeFixture.id)}
                        disabled={fixtures.length >= MAX_FIXTURES}
                        className="flex items-center gap-1 rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-200 hover:bg-slate-800 disabled:opacity-40 whitespace-nowrap shrink-0"
                      >
                        <Copy className="h-3 w-3" />
                        <span>Duplicate</span>
                      </button>
                      <button
                        type="button"
                        onClick={onAddFixture}
                        disabled={fixtures.length >= MAX_FIXTURES}
                        className="flex items-center gap-1 rounded bg-amber-500 px-2.5 py-1 text-xs font-semibold text-slate-950 hover:bg-amber-400 disabled:opacity-40 whitespace-nowrap shrink-0"
                      >
                        <Plus className="h-3.5 w-3.5" />
                        <span>Add Light</span>
                      </button>
                    </div>
                  </div>

                  <div className="space-y-1.5 max-h-36 overflow-y-auto pr-1">
                    {fixtures.map((f) => {
                      const isSel = f.id === activeFixture.id;
                      return (
                        <div
                          key={f.id}
                          className={`flex items-center justify-between gap-2 rounded-lg border px-2.5 py-1.5 ${
                            isSel
                              ? 'border-amber-500/60 bg-amber-500/10'
                              : 'border-slate-800 bg-slate-900/70'
                          }`}
                        >
                          <button
                            type="button"
                            onClick={() => onSelectFixture(f.id)}
                            className="flex flex-1 items-center gap-2 text-left min-w-0"
                          >
                            <span
                              className="h-2.5 w-2.5 rounded-xs shrink-0"
                              style={{ backgroundColor: getFixtureHex(f) }}
                            />
                            <span className="text-xs font-medium text-slate-100 truncate">
                              {f.name}
                            </span>
                            <span className="font-mono-tabular text-[11px] text-slate-400 whitespace-nowrap">
                              {f.height.toFixed(1)}m · {f.yawAngle}° · {f.angleRange}°
                            </span>
                          </button>

                          <div className="flex items-center gap-1 shrink-0">
                            <button
                              type="button"
                              title="Rotate pole 45°"
                              aria-label="Rotate pole 45 degrees"
                              onClick={() => onRotateFixture(f.id, 45)}
                              className="rounded p-1 text-slate-300 hover:bg-slate-800"
                            >
                              <RotateCw className="h-3.5 w-3.5" />
                            </button>
                            <button
                              type="button"
                              aria-label={f.enabled ? 'Disable light' : 'Enable light'}
                              onClick={() =>
                                onUpdateFixture(f.id, { enabled: !f.enabled })
                              }
                              className="rounded p-1 text-slate-300 hover:bg-slate-800"
                            >
                              {f.enabled ? (
                                <Eye className="h-3.5 w-3.5 text-amber-400" />
                              ) : (
                                <EyeOff className="h-3.5 w-3.5 text-slate-500" />
                              )}
                            </button>
                            <button
                              type="button"
                              aria-label="Remove light"
                              disabled={fixtures.length <= 1}
                              onClick={() => onRemoveFixture(f.id)}
                              className="rounded p-1 text-slate-400 hover:bg-slate-800 hover:text-rose-400 disabled:opacity-30"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Movable Shadow-Casting Targets Column */}
                <div className="space-y-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-slate-200">
                      Scene Objects ({targets.length})
                    </span>
                    <div className="flex items-center gap-1">
                      {(['pedestrian', 'sedan', 'traffic-light', 'building-small'] as TargetKind[]).map(
                        (kind) => (
                          <button
                            key={kind}
                            type="button"
                            onClick={() => onAddTarget(kind)}
                            className="rounded border border-slate-700 bg-slate-900 px-2 py-1 text-[11px] font-medium text-slate-200 hover:bg-slate-800 whitespace-nowrap shrink-0"
                          >
                            + {kind === 'building-small' ? 'Building' : kind === 'pedestrian' ? 'Person' : kind === 'sedan' ? 'Sedan' : 'Signal'}
                          </button>
                        ),
                      )}
                      <button
                        type="button"
                        onClick={() => setActiveTab('builder')}
                        className="rounded border border-cyan-500/40 bg-cyan-500/10 px-2 py-1 text-[11px] font-medium text-cyan-200 hover:bg-cyan-500/20 whitespace-nowrap shrink-0"
                      >
                        Builder…
                      </button>
                    </div>
                  </div>

                  <div className="space-y-1.5 max-h-36 overflow-y-auto pr-1">
                    {targets.map((t) => {
                      const isSel = t.id === selectedTargetId;
                      const deg =
                        ((Math.round((t.rotationY * 180) / Math.PI) % 360) + 360) % 360;
                      const bldgH = isBuildingKind(t.kind)
                        ? t.height ?? BUILDING_DEFAULT_HEIGHTS[t.kind]
                        : undefined;
                      return (
                        <div
                          key={t.id}
                          className={`flex items-center justify-between gap-2 rounded-lg border px-2.5 py-1.5 ${
                            isSel
                              ? 'border-cyan-500/60 bg-cyan-500/10'
                              : 'border-slate-800 bg-slate-900/70'
                          }`}
                        >
                          <button
                            type="button"
                            onClick={() => onSelectTarget(t.id)}
                            className="flex flex-1 items-center gap-2 text-left min-w-0"
                          >
                            <MousePointer2 className="h-3.5 w-3.5 text-cyan-400 shrink-0" />
                            <span className="text-xs font-medium text-slate-100 truncate">
                              {t.label}
                            </span>
                            {t.routeId === 'Crossing' && (
                              <span className="rounded border border-emerald-500/40 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-300 shrink-0">
                                Crossing
                              </span>
                            )}
                            <span className="font-mono-tabular text-[11px] text-slate-400 whitespace-nowrap">
                              {bldgH ? `${bldgH.toFixed(1)}m · ` : ''}({t.position.x.toFixed(1)}, {t.position.z.toFixed(1)}) · {deg}°
                            </span>
                          </button>

                          <div className="flex items-center gap-1 shrink-0">
                            <button
                              type="button"
                              title="Rotate 45° (R)"
                              aria-label="Rotate target 45 degrees"
                              onClick={() => onRotateTarget(t.id)}
                              className="rounded p-1 text-slate-300 hover:bg-slate-800"
                            >
                              <RotateCw className="h-3.5 w-3.5" />
                            </button>
                            <button
                              type="button"
                              title="Delete object (Del)"
                              aria-label="Remove target"
                              onClick={() => onRemoveTarget(t.id)}
                              className="rounded p-1 text-slate-400 hover:bg-slate-800 hover:text-rose-400"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        </div>
                      );
                    })}
                    {targets.length === 0 && (
                      <div className="rounded-lg border border-dashed border-slate-800 py-4 text-center text-xs text-slate-500">
                        No objects placed. Use Builder or the quick-add buttons above.
                      </div>
                    )}
                  </div>
                  <p className="text-[11px] text-slate-400">
                    Tip: Click any pole, road, sidewalk, building, person, car, or prop in 3D to select, drag, rotate (<span className="font-mono-tabular text-slate-200">R</span>), or delete (<span className="font-mono-tabular text-slate-200">Del</span>).
                  </p>
                </div>
              </div>
            )}

            {activeTab === 'presets' && (
              <div className="space-y-4">
                <div>
                  <div className="mb-2 text-xs font-semibold text-slate-300">
                    Street Lighting Presets
                  </div>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-5">
                    {SCENE_PRESETS.map((preset) => {
                      const active = preset.id === activePresetId;
                      return (
                        <button
                          key={preset.id}
                          type="button"
                          onClick={() => onApplyPreset(preset.id)}
                          className={`rounded-lg border p-2.5 text-left transition-colors ${
                            active
                              ? 'border-amber-500 bg-amber-500/15'
                              : 'border-slate-800 bg-slate-900/80 hover:border-slate-700 hover:bg-slate-900'
                          }`}
                        >
                          <div className="text-xs font-semibold text-slate-100 truncate">
                            {preset.name}
                          </div>
                          <div className="mt-1 text-[11px] leading-snug text-slate-400">
                            {preset.subtitle}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-800/80 pt-3">
                  <span className="text-xs font-semibold text-slate-300">
                    Time of Day
                  </span>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {TIME_OF_DAY_OPTIONS.map((opt) => {
                      const active = settings.ambientMode === opt.id;
                      const Icon =
                        opt.id === 'dawn'
                          ? Sunrise
                          : opt.id === 'morning' || opt.id === 'noon'
                            ? Sun
                            : opt.id === 'sunset'
                              ? Sunset
                              : Moon;
                      return (
                        <button
                          key={opt.id}
                          type="button"
                          onClick={() => onUpdateSettings({ ambientMode: opt.id })}
                          className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                            active
                              ? 'border-amber-500 bg-amber-500/20 text-amber-200'
                              : 'border-slate-700 bg-slate-900 text-slate-300 hover:border-slate-600 hover:bg-slate-800'
                          }`}
                        >
                          <Icon className="h-3.5 w-3.5" />
                          <span>{opt.label}</span>
                          <span className="font-mono-tabular text-[10px] text-slate-400">
                            {opt.timeLabel}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-800/80 pt-3">
                  <span className="text-xs font-semibold text-slate-300">
                    Camera: {formatMouseButton(controlsConfig.rotateMouseButton)} rotate · {formatMouseButton(controlsConfig.panMouseButton)} pan · {formatKeyCode(controlsConfig.keybinds.moveForward)}/{formatKeyCode(controlsConfig.keybinds.moveLeft)}/{formatKeyCode(controlsConfig.keybinds.moveBackward)}/{formatKeyCode(controlsConfig.keybinds.moveRight)} move · {formatKeyCode(controlsConfig.keybinds.moveUp)} up · {formatKeyCode(controlsConfig.keybinds.moveDown)} down · Scroll zoom
                  </span>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {(
                      [
                        { id: 'perspective', label: 'Perspective Street' },
                        { id: 'top', label: 'Top-Down Footprint' },
                        { id: 'side', label: 'Side Elevation' },
                        { id: 'closeup', label: 'Pole Close-Up' },
                      ] as const
                    ).map((cam) => (
                      <button
                        key={cam.id}
                        type="button"
                        onClick={() => onCameraPreset(cam.id)}
                        className="rounded-md border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs font-medium text-slate-200 transition-colors hover:border-cyan-500/60 hover:bg-slate-800 whitespace-nowrap shrink-0"
                      >
                        {cam.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {activeTab === 'controls' && (
              <ControlsTabPanel
                controlsConfig={controlsConfig}
                onUpdateControlsConfig={onUpdateControlsConfig}
                onResetControlsConfig={onResetControlsConfig}
              />
            )}
          </div>
        </section>
      )}
    </div>
  );
});
