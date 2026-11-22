/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { type DragEvent, useCallback, useEffect, useRef, useState } from 'react';
import { RotateCcw, RotateCw, Trash2, X } from 'lucide-react';
import { ControlDock } from './components/ControlDock';
import { TopTelemetryBar } from './components/TopTelemetryBar';
import { StreetSimulatorScene } from './three/StreetSimulatorScene';
import {
  BUILDING_DEFAULT_DIMENSIONS,
  BUILDING_DEFAULT_HEIGHTS,
  BuilderTool,
  CameraPresetId,
  DEFAULT_INPUT_CONTROLS,
  FIXTURE_MAX_X,
  FIXTURE_MAX_Z,
  formatKeyCode,
  getRoadSidewalkPartKeys,
  InputControlsConfig,
  isBuildingKind,
  isRoadOrPathKind,
  isVehicleKind,
  LightFixture,
  MAP_HALF_X,
  MAP_HALF_Z,
  MAX_FIXTURES,
  PhotometricStats,
  SelectedSidewalkInfo,
  StreetTarget,
  TargetKind,
  ViewportSettings,
} from './types/lighting';
import {
  clamp,
  generatePedestrianCrossingPath,
  SCENE_PRESETS,
} from './utils/photometrics';

const INITIAL_PRESET = SCENE_PRESETS[0];

const TARGET_LABELS: Record<TargetKind, string> = {
  bike: 'Bicycle',
  motorcycle: 'Motorcycle',
  sedan: 'Sedan',
  van: 'Delivery Van',
  truck: 'Box Truck',
  bus: 'City Bus',
  pedestrian: 'Pedestrian',
  bollard: 'Bollard',
  'traffic-light': 'Traffic Signal',
  crate: 'Cargo Crate',
  'building-kiosk': '1-Story Pavilion',
  'building-small': '2-Story Storefront',
  'building-tall': '4-Story Mid-Rise',
  'building-highrise': '8-Story Tower',
  'building-rowhouse': 'Rowhouse Terrace',
  'building-commercial': 'Retail Plaza Strip',
  'building-warehouse': 'Industrial Hall',
  'building-civic': 'Neoclassical Civic Hall',
  'building-apartments': 'L-Court Apartments',
  'building-skyscraper': 'Setback Skyscraper',
  tree: 'Street Tree',
  hedge: 'Hedge',
  bench: 'Park Bench',
  'road-2lane': '2-Lane Street',
  'road-intersection': '4-Way Junction',
  'road-t-junction': 'T-Junction',
  'road-turn-90': '90° Road Turn',
  'road-curve-45': '45° Gentle Curve',
  'road-crosswalk': 'Crosswalk Road',
  'road-roundabout': 'Grand Roundabout',
  'road-culdesac': 'Mini Roundabout',
  'road-deadend': 'Cul-de-Sac End',
  'path-sidewalk': 'Concrete Path',
  'path-bike': 'Bike Lane',
  'path-cobble': 'Cobble Plaza',
  'path-gravel': 'Park Trail',
  'parking-lot': 'Parking Lot',
};

const SEDAN_PAINT_PALETTE = ['#3b526b', '#8a2b32', '#1e40af', '#334155', '#0f4c5c', '#475569'];
const PEDESTRIAN_JACKET_PALETTE = [
  '#c26d38',
  '#2563eb',
  '#0d9488',
  '#b91c1c',
  '#7c3aed',
  '#ca8a04',
  '#475569',
  '#059669',
];

const VALID_DROP_TOOLS: ReadonlySet<string> = new Set([
  'bike',
  'motorcycle',
  'sedan',
  'van',
  'truck',
  'bus',
  'pedestrian',
  'bollard',
  'traffic-light',
  'crate',
  'building-kiosk',
  'building-small',
  'building-tall',
  'building-highrise',
  'building-rowhouse',
  'building-commercial',
  'building-warehouse',
  'building-civic',
  'building-apartments',
  'building-skyscraper',
  'tree',
  'hedge',
  'bench',
  'road-2lane',
  'road-intersection',
  'road-t-junction',
  'road-turn-90',
  'road-curve-45',
  'road-crosswalk',
  'road-roundabout',
  'road-culdesac',
  'road-deadend',
  'path-sidewalk',
  'path-bike',
  'path-cobble',
  'path-gravel',
  'parking-lot',
  'light',
]);

function clonePresetData(presetId: string) {
  const preset = SCENE_PRESETS.find((p) => p.id === presetId) ?? SCENE_PRESETS[0];
  return {
    preset,
    fixtures: preset.fixtures.map((f) => ({ ...f, position: { ...f.position } })),
    targets: preset.targets.map((t) => ({
      ...t,
      position: { ...t.position },
      hiddenSidewalks: t.hiddenSidewalks ? [...t.hiddenSidewalks] : undefined,
    })),
  };
}

export default function App() {
  const canvasMountRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<StreetSimulatorScene | null>(null);
  const draggedToolRef = useRef<Exclude<BuilderTool, null> | null>(null);

  const [fixtures, setFixtures] = useState<LightFixture[]>(() =>
    INITIAL_PRESET.fixtures.map((f) => ({ ...f, position: { ...f.position } })),
  );
  const [targets, setTargets] = useState<StreetTarget[]>(() =>
    INITIAL_PRESET.targets.map((t) => ({
      ...t,
      position: { ...t.position },
      hiddenSidewalks: t.hiddenSidewalks ? [...t.hiddenSidewalks] : undefined,
    })),
  );
  const [activeFixtureId, setActiveFixtureId] = useState<string>(
    INITIAL_PRESET.fixtures[0].id,
  );
  const [selectedTargetId, setSelectedTargetId] = useState<string | null>(null);
  const [selectedSidewalk, setSelectedSidewalk] = useState<SelectedSidewalkInfo | null>(null);
  const [canvasSelectedFixtureId, setCanvasSelectedFixtureId] = useState<string | null>(null);
  const [activePresetId, setActivePresetId] = useState<string>(INITIAL_PRESET.id);
  const [dockCollapsed, setDockCollapsed] = useState<boolean>(false);
  const [builderTool, setBuilderTool] = useState<BuilderTool>(null);
  const [builderRotationY, setBuilderRotationY] = useState<number>(0);
  const [contextLost, setContextLost] = useState<boolean>(false);

  const [settings, setSettings] = useState<ViewportSettings>({
    showBeamEnvelope: true,
    showLuxHeatmap: false,
    showGrid: true,
    ambientMode: 'night',
    luxThreshold: 2.0,
  });

  const [controlsConfig, setControlsConfig] = useState<InputControlsConfig>(() => {
    try {
      const raw = window.localStorage.getItem('luminastreet_controls_v1');
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<InputControlsConfig>;
        return {
          ...DEFAULT_INPUT_CONTROLS,
          ...parsed,
          keybinds: {
            ...DEFAULT_INPUT_CONTROLS.keybinds,
            ...(parsed.keybinds ?? {}),
          },
        };
      }
    } catch {
      // Ignore storage errors
    }
    return {
      ...DEFAULT_INPUT_CONTROLS,
      keybinds: { ...DEFAULT_INPUT_CONTROLS.keybinds },
    };
  });

  const [stats, setStats] = useState<PhotometricStats>({
    cursorWorld: null,
    cursorLux: null,
    peakGroundLux: 0,
    footprintAreaSqM: 0,
    centerThrowDistM: null,
  });

  // Stable refs for callbacks inside Three.js event handlers
  const handleSelectFixtureFromScene = useCallback((id: string) => {
    setActiveFixtureId(id);
    setSelectedTargetId(null);
    setSelectedSidewalk(null);
    setCanvasSelectedFixtureId(id);
  }, []);

  const handleSelectFixtureFromDock = useCallback((id: string) => {
    setActiveFixtureId(id);
    setSelectedTargetId(null);
    setSelectedSidewalk(null);
    setCanvasSelectedFixtureId(null);
  }, []);

  const handleSelectTarget = useCallback((id: string | null) => {
    setSelectedTargetId(id);
    setSelectedSidewalk(null);
    setCanvasSelectedFixtureId(null);
  }, []);

  const handleSelectSidewalk = useCallback((info: SelectedSidewalkInfo | null) => {
    setSelectedSidewalk(info);
    setSelectedTargetId(null);
    setCanvasSelectedFixtureId(null);
  }, []);

  const handleMoveTarget = useCallback(
    (id: string, pos: { x: number; z: number }) => {
      setTargets((prev) => {
        const nextTargets = prev.map((t) =>
          t.id === id ? { ...t, position: pos } : t,
        );
        const moved = nextTargets.find((t) => t.id === id);
        if (!moved) return nextTargets;
        if (moved.kind === 'pedestrian') {
          const crossingPath = generatePedestrianCrossingPath(pos, nextTargets);
          return nextTargets.map((t) =>
            t.id === id
              ? {
                  ...t,
                  routeId: crossingPath ? 'Crossing' : undefined,
                  crossingPath: crossingPath ?? undefined,
                }
              : t,
          );
        }
        if (moved.kind === 'road-crosswalk' || moved.kind === 'path-sidewalk') {
          return nextTargets.map((t) => {
            if (t.kind !== 'pedestrian') return t;
            const crossingPath = generatePedestrianCrossingPath(
              t.position,
              nextTargets,
            );
            return {
              ...t,
              routeId: crossingPath ? 'Crossing' : undefined,
              crossingPath: crossingPath ?? undefined,
            };
          });
        }
        return nextTargets;
      });
    },
    [],
  );

  const handleMoveFixture = useCallback(
    (id: string, pos: { x: number; z: number }) => {
      setFixtures((prev) =>
        prev.map((f) =>
          f.id === id
            ? {
                ...f,
                position: {
                  x: clamp(pos.x, -FIXTURE_MAX_X, FIXTURE_MAX_X),
                  z: clamp(pos.z, -FIXTURE_MAX_Z, FIXTURE_MAX_Z),
                },
              }
            : f,
        ),
      );
    },
    [],
  );

  const handleRotateBuilderTool = useCallback(() => {
    setBuilderRotationY((r) => r + Math.PI / 4);
  }, []);

  const handleCancelBuilderTool = useCallback(() => {
    setBuilderTool(null);
  }, []);

  const handlePlaceBuilderItem = useCallback(
    (
      tool: Exclude<BuilderTool, null>,
      pos: { x: number; z: number },
      rotationY: number,
    ) => {
      if (tool === 'light') {
        const rawDeg = Math.round((rotationY * 180) / Math.PI) % 360;
        const normalizedDeg =
          rawDeg > 180 ? rawDeg - 360 : rawDeg <= -180 ? rawDeg + 360 : rawDeg;

        setFixtures((prev) => {
          if (prev.length >= MAX_FIXTURES) return prev;
          const idx = prev.length + 1;
          const newFixture: LightFixture = {
            id: `fix-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
            name: `Pole ${idx}`,
            enabled: true,
            position: {
              x: clamp(pos.x, -FIXTURE_MAX_X, FIXTURE_MAX_X),
              z: clamp(pos.z, -FIXTURE_MAX_Z, FIXTURE_MAX_Z),
            },
            height: 8.0,
            tiltAngle: 22,
            yawAngle: normalizedDeg,
            poleYawAngle: normalizedDeg,
            angleRange: 48,
            lumens: 12000,
            kelvin: 4000,
            useCustomColor: false,
            customColor: '#fff2e0',
          };
          setActiveFixtureId(newFixture.id);
          return [...prev, newFixture];
        });
        return;
      }

      const motion =
        tool === 'pedestrian'
          ? 'walk'
          : isVehicleKind(tool)
            ? 'drive'
            : undefined;
      const color =
        tool === 'sedan'
          ? SEDAN_PAINT_PALETTE[Math.floor(Math.random() * SEDAN_PAINT_PALETTE.length)]
          : tool === 'pedestrian'
            ? PEDESTRIAN_JACKET_PALETTE[
                Math.floor(Math.random() * PEDESTRIAN_JACKET_PALETTE.length)
              ]
            : undefined;
      const bDims = BUILDING_DEFAULT_DIMENSIONS[tool];
      const newPos = {
        x: clamp(pos.x, -MAP_HALF_X, MAP_HALF_X),
        z: clamp(pos.z, -MAP_HALF_Z, MAP_HALF_Z),
      };
      const newId = `tgt-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
      setTargets((prev) => {
        const crossingPath =
          tool === 'pedestrian'
            ? generatePedestrianCrossingPath(newPos, prev)
            : null;
        const newTarget: StreetTarget = {
          id: newId,
          kind: tool,
          label: TARGET_LABELS[tool],
          position: newPos,
          rotationY,
          width: bDims?.width,
          length: bDims?.length,
          height: BUILDING_DEFAULT_HEIGHTS[tool],
          motion,
          routeId: crossingPath ? 'Crossing' : undefined,
          crossingPath: crossingPath ?? undefined,
          color,
        };
        const updated = [...prev, newTarget];
        if (tool === 'road-crosswalk' || tool === 'path-sidewalk') {
          return updated.map((t) => {
            if (t.kind !== 'pedestrian') return t;
            const cp = generatePedestrianCrossingPath(t.position, updated);
            return cp
              ? { ...t, routeId: 'Crossing', crossingPath: cp }
              : t;
          });
        }
        return updated;
      });
      setSelectedTargetId(newId);
      setSelectedSidewalk(null);
    },
    [],
  );

  const handleAdjustTargetDimension = useCallback(
    (id: string, axis: 'width' | 'length' | 'height', deltaM: number) => {
      setTargets((prev) =>
        prev.map((t) => {
          if (t.id !== id) return t;
          const bDims = BUILDING_DEFAULT_DIMENSIONS[t.kind];
          if (!bDims) return t;
          const baseVal = bDims[axis];
          const curVal = t[axis] ?? baseVal;
          const minV = axis === 'height' ? 2.5 : Math.max(2.4, baseVal * 0.5);
          const maxV = axis === 'height' ? 42.0 : Math.min(20.0, baseVal * 2.2);
          const nextVal = clamp(Math.round((curVal + deltaM) * 10) / 10, minV, maxV);
          return { ...t, [axis]: nextVal };
        }),
      );
    },
    [],
  );

  const handleRotateTarget = useCallback((id: string, deltaRad = Math.PI / 4) => {
    setTargets((prev) =>
      prev.map((t) =>
        t.id === id ? { ...t, rotationY: t.rotationY + deltaRad } : t,
      ),
    );
  }, []);

  const handleRemoveTarget = useCallback(
    (id: string) => {
      setTargets((prev) => prev.filter((t) => t.id !== id));
      if (selectedTargetId === id) setSelectedTargetId(null);
      setSelectedSidewalk((cur) => (cur?.targetId === id ? null : cur));
    },
    [selectedTargetId],
  );

  const handleRemoveSelectedSidewalk = useCallback((info: SelectedSidewalkInfo) => {
    setTargets((prev) =>
      prev.map((t) => {
        if (t.id !== info.targetId) return t;
        const existing = t.hiddenSidewalks ?? [];
        if (existing.includes(info.partKey)) return t;
        return { ...t, hiddenSidewalks: [...existing, info.partKey] };
      }),
    );
    setSelectedSidewalk(null);
  }, []);

  const handleToggleRoadSidewalks = useCallback((id: string) => {
    setTargets((prev) =>
      prev.map((t) => {
        if (t.id !== id) return t;
        const partKeys = getRoadSidewalkPartKeys(t.kind);
        if (partKeys.length === 0) return t;
        const hasHidden = (t.hiddenSidewalks?.length ?? 0) > 0;
        return {
          ...t,
          hiddenSidewalks: hasHidden ? undefined : partKeys,
        };
      }),
    );
    setSelectedSidewalk((cur) => (cur?.targetId === id ? null : cur));
  }, []);

  const handleRemoveAllSidewalks = useCallback(() => {
    setTargets((prev) => {
      const next: StreetTarget[] = [];
      for (const t of prev) {
        if (t.kind === 'path-sidewalk') {
          if (selectedTargetId === t.id) setSelectedTargetId(null);
          continue;
        }
        const partKeys = getRoadSidewalkPartKeys(t.kind);
        if (partKeys.length > 0) {
          next.push({ ...t, hiddenSidewalks: partKeys });
        } else {
          next.push(t);
        }
      }
      return next;
    });
    setSelectedSidewalk(null);
  }, [selectedTargetId]);

  const handleRotateFixtureYaw = useCallback((id: string, deltaDeg: number) => {
    const normalizeDeg = (deg: number) => {
      const raw = deg % 360;
      return raw > 180 ? raw - 360 : raw <= -180 ? raw + 360 : raw;
    };
    const armLen = 1.05;
    setFixtures((prev) =>
      prev.map((f) => {
        if (f.id !== id) return f;
        const curPole = f.poleYawAngle ?? f.yawAngle;
        const nextPoleYaw = normalizeDeg(curPole + deltaDeg);
        const curRad = (curPole * Math.PI) / 180;
        const nextRad = (nextPoleYaw * Math.PI) / 180;
        const mastX = f.position.x - Math.sin(curRad) * armLen;
        const mastZ = f.position.z - Math.cos(curRad) * armLen;
        const nextX = clamp(
          Math.round((mastX + Math.sin(nextRad) * armLen) * 1000) / 1000,
          -FIXTURE_MAX_X,
          FIXTURE_MAX_X,
        );
        const nextZ = clamp(
          Math.round((mastZ + Math.cos(nextRad) * armLen) * 1000) / 1000,
          -FIXTURE_MAX_Z,
          FIXTURE_MAX_Z,
        );
        return {
          ...f,
          poleYawAngle: nextPoleYaw,
          position: { x: nextX, z: nextZ },
        };
      }),
    );
  }, []);

  const handleRemoveFixture = useCallback(
    (id: string) => {
      setFixtures((prev) => {
        if (prev.length <= 1) return prev;
        const filtered = prev.filter((f) => f.id !== id);
        if (activeFixtureId === id && filtered[0]) {
          setActiveFixtureId(filtered[0].id);
        }
        return filtered;
      });
      if (canvasSelectedFixtureId === id) {
        setCanvasSelectedFixtureId(null);
      }
    },
    [activeFixtureId, canvasSelectedFixtureId],
  );

  const handleRotateSelected = useCallback(
    (deltaRad: number) => {
      if (selectedTargetId) {
        handleRotateTarget(selectedTargetId, deltaRad);
      } else if (canvasSelectedFixtureId) {
        const deltaDeg = Math.round((deltaRad * 180) / Math.PI);
        handleRotateFixtureYaw(canvasSelectedFixtureId, deltaDeg);
      }
    },
    [selectedTargetId, canvasSelectedFixtureId, handleRotateTarget, handleRotateFixtureYaw],
  );

  const handleDeleteSelected = useCallback(() => {
    if (selectedTargetId) {
      handleRemoveTarget(selectedTargetId);
    } else if (selectedSidewalk) {
      handleRemoveSelectedSidewalk(selectedSidewalk);
    } else if (canvasSelectedFixtureId) {
      handleRemoveFixture(canvasSelectedFixtureId);
    }
  }, [
    selectedTargetId,
    selectedSidewalk,
    canvasSelectedFixtureId,
    handleRemoveTarget,
    handleRemoveSelectedSidewalk,
    handleRemoveFixture,
  ]);

  const callbacksRef = useRef({
    onStatsUpdate: setStats,
    onSelectFixture: handleSelectFixtureFromScene,
    onSelectTarget: handleSelectTarget,
    onSelectSidewalk: handleSelectSidewalk,
    onMoveTarget: handleMoveTarget,
    onMoveFixture: handleMoveFixture,
    onPlaceBuilderItem: handlePlaceBuilderItem,
    onRotateBuilderTool: handleRotateBuilderTool,
    onCancelBuilderTool: handleCancelBuilderTool,
    onRotateSelected: handleRotateSelected,
    onDeleteSelected: handleDeleteSelected,
    onContextLostChange: setContextLost,
  });
  callbacksRef.current = {
    onStatsUpdate: setStats,
    onSelectFixture: handleSelectFixtureFromScene,
    onSelectTarget: handleSelectTarget,
    onSelectSidewalk: handleSelectSidewalk,
    onMoveTarget: handleMoveTarget,
    onMoveFixture: handleMoveFixture,
    onPlaceBuilderItem: handlePlaceBuilderItem,
    onRotateBuilderTool: handleRotateBuilderTool,
    onCancelBuilderTool: handleCancelBuilderTool,
    onRotateSelected: handleRotateSelected,
    onDeleteSelected: handleDeleteSelected,
    onContextLostChange: setContextLost,
  };

  // Mount Three.js scene once in isolated container
  useEffect(() => {
    const mountEl = canvasMountRef.current;
    if (!mountEl) return;

    const simScene = new StreetSimulatorScene(mountEl, {
      onStatsUpdate: (s) => callbacksRef.current.onStatsUpdate(s),
      onSelectFixture: (id) => callbacksRef.current.onSelectFixture(id),
      onSelectTarget: (id) => callbacksRef.current.onSelectTarget(id),
      onSelectSidewalk: (info) => callbacksRef.current.onSelectSidewalk(info),
      onMoveTarget: (id, pos) => callbacksRef.current.onMoveTarget(id, pos),
      onMoveFixture: (id, pos) => callbacksRef.current.onMoveFixture(id, pos),
      onPlaceBuilderItem: (tool, pos, rot) =>
        callbacksRef.current.onPlaceBuilderItem(tool, pos, rot),
      onRotateBuilderTool: () => callbacksRef.current.onRotateBuilderTool(),
      onCancelBuilderTool: () => callbacksRef.current.onCancelBuilderTool(),
      onRotateSelected: (deltaRad) => callbacksRef.current.onRotateSelected(deltaRad),
      onDeleteSelected: () => callbacksRef.current.onDeleteSelected(),
      onContextLostChange: (lost) =>
        callbacksRef.current.onContextLostChange(lost),
    });

    sceneRef.current = simScene;

    return () => {
      simScene.dispose();
      sceneRef.current = null;
    };
  }, []);

  // Sync React state -> Three.js scene
  useEffect(() => {
    sceneRef.current?.syncState(
      fixtures,
      targets,
      activeFixtureId,
      selectedTargetId,
      settings,
      selectedSidewalk?.key ?? null,
    );
  }, [fixtures, targets, activeFixtureId, selectedTargetId, settings, selectedSidewalk?.key]);

  // Sync Builder tool & rotation -> Three.js scene
  useEffect(() => {
    sceneRef.current?.setBuilderState(builderTool, builderRotationY);
  }, [builderTool, builderRotationY]);

  // Sync Controls config -> Three.js scene & localStorage
  useEffect(() => {
    sceneRef.current?.setControlsConfig(controlsConfig);
    try {
      window.localStorage.setItem(
        'luminastreet_controls_v1',
        JSON.stringify(controlsConfig),
      );
    } catch {
      // Ignore storage errors
    }
  }, [controlsConfig]);

  // Keyboard shortcut to collapse/expand controls dock
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (document.querySelector('[data-keybind-capture="true"]')) return;
      if (e.code === controlsConfig.keybinds.toggleDock) {
        e.preventDefault();
        setDockCollapsed((c) => !c);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [controlsConfig.keybinds.toggleDock]);

  const handleUpdateFixture = useCallback(
    (id: string, patch: Partial<LightFixture>) => {
      setFixtures((prev) =>
        prev.map((f) => {
          if (f.id !== id) return f;
          const nextPos = patch.position
            ? {
                x: clamp(patch.position.x, -FIXTURE_MAX_X, FIXTURE_MAX_X),
                z: clamp(patch.position.z, -FIXTURE_MAX_Z, FIXTURE_MAX_Z),
              }
            : f.position;
          const nextPoleYaw =
            patch.poleYawAngle !== undefined
              ? patch.poleYawAngle
              : f.poleYawAngle !== undefined
                ? f.poleYawAngle
                : patch.yawAngle !== undefined
                  ? f.yawAngle
                  : undefined;
          return {
            ...f,
            ...patch,
            ...(nextPoleYaw !== undefined ? { poleYawAngle: nextPoleYaw } : {}),
            position: nextPos,
          };
        }),
      );
    },
    [],
  );

  const handleAddFixture = useCallback(() => {
    setFixtures((prev) => {
      if (prev.length >= MAX_FIXTURES) return prev;
      const idx = prev.length + 1;
      const offsetX =
        idx === 2
          ? 6.0
          : idx === 3
            ? -8.0
            : idx === 4
              ? 0.0
              : clamp((idx - 4) * 5 - 10, -FIXTURE_MAX_X, FIXTURE_MAX_X);
      const offsetZ = idx % 2 === 0 ? 3.2 : -3.2;
      const newFixture: LightFixture = {
        id: `fix-${Date.now()}`,
        name: `Pole ${idx}`,
        enabled: true,
        position: { x: offsetX, z: offsetZ },
        height: 8.0,
        tiltAngle: 22,
        yawAngle: offsetZ > 0 ? 180 : 0,
        poleYawAngle: offsetZ > 0 ? 180 : 0,
        angleRange: 48,
        lumens: 12000,
        kelvin: 4000,
        useCustomColor: false,
        customColor: '#fff2e0',
      };
      setActiveFixtureId(newFixture.id);
      return [...prev, newFixture];
    });
  }, []);

  const handleDuplicateFixture = useCallback((id: string) => {
    setFixtures((prev) => {
      if (prev.length >= MAX_FIXTURES) return prev;
      const src = prev.find((f) => f.id === id);
      if (!src) return prev;
      const copy: LightFixture = {
        ...src,
        id: `fix-${Date.now()}`,
        name: `${src.name} Copy`,
        position: {
          x: clamp(src.position.x + 4.5, -FIXTURE_MAX_X, FIXTURE_MAX_X),
          z: src.position.z,
        },
        sectorAngles: src.sectorAngles ? { ...src.sectorAngles } : undefined,
      };
      setActiveFixtureId(copy.id);
      return [...prev, copy];
    });
  }, []);

  const handleAddTarget = useCallback((kind: TargetKind) => {
    const isEdgeKind =
      isBuildingKind(kind) ||
      kind === 'tree' ||
      kind === 'hedge' ||
      kind === 'bench';
    const isSurface = isRoadOrPathKind(kind);
    const isVehicle = isVehicleKind(kind);
    const isWestbound = isVehicle && Math.random() < 0.5;
    const motion =
      kind === 'pedestrian'
        ? 'walk'
        : isVehicle
          ? 'drive'
          : undefined;
    const color =
      kind === 'sedan'
        ? SEDAN_PAINT_PALETTE[Math.floor(Math.random() * SEDAN_PAINT_PALETTE.length)]
        : kind === 'pedestrian'
          ? PEDESTRIAN_JACKET_PALETTE[
              Math.floor(Math.random() * PEDESTRIAN_JACKET_PALETTE.length)
            ]
          : undefined;
    const pedXOptions = [-38, -28.45, -16.5, -8.5, 4.0, 16.5, 28.45, 38];
    const newPos = {
      x:
        kind === 'traffic-light'
          ? -7.4
          : kind === 'pedestrian'
            ? pedXOptions[Math.floor(Math.random() * pedXOptions.length)]
            : Math.round((Math.random() * 18 - 9) * 2) / 2,
      z:
        kind === 'pedestrian'
          ? (Math.random() < 0.5 ? 5.95 : -5.95)
          : isVehicle
            ? isWestbound
              ? -2.2
              : 2.2
            : kind === 'traffic-light'
              ? 5.1
              : kind === 'bollard'
                ? -4.5
                : isSurface
                  ? 18.0
                  : isEdgeKind
                    ? kind === 'bench' || kind === 'hedge'
                      ? 5.5
                      : -12.5
                    : Math.round((Math.random() * 4 - 2) * 2) / 2,
    };
    const newId = `tgt-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    setTargets((prev) => {
      const crossingPath =
        kind === 'pedestrian'
          ? generatePedestrianCrossingPath(newPos, prev)
          : null;
      const newTarget: StreetTarget = {
        id: newId,
        kind,
        label: TARGET_LABELS[kind],
        position: newPos,
        rotationY: isWestbound ? Math.PI : 0,
        width: BUILDING_DEFAULT_DIMENSIONS[kind]?.width,
        length: BUILDING_DEFAULT_DIMENSIONS[kind]?.length,
        height: BUILDING_DEFAULT_HEIGHTS[kind],
        motion,
        routeId: crossingPath ? 'Crossing' : undefined,
        crossingPath: crossingPath ?? undefined,
        color,
      };
      return [...prev, newTarget];
    });
    setSelectedTargetId(newId);
    setSelectedSidewalk(null);
    setCanvasSelectedFixtureId(null);
  }, []);

  const handleClearTargets = useCallback(() => {
    setTargets([]);
    setSelectedTargetId(null);
    setSelectedSidewalk(null);
  }, []);

  const handleApplyPreset = useCallback((presetId: string) => {
    const data = clonePresetData(presetId);
    setFixtures(data.fixtures);
    setTargets(data.targets);
    setActiveFixtureId(data.fixtures[0].id);
    setSelectedTargetId(null);
    setSelectedSidewalk(null);
    setActivePresetId(data.preset.id);
    if (data.preset.cameraPreset) {
      sceneRef.current?.setCameraPreset(data.preset.cameraPreset);
    }
  }, []);

  const handleCameraPreset = useCallback((preset: CameraPresetId) => {
    sceneRef.current?.setCameraPreset(preset);
  }, []);

  const handleUpdateSettings = useCallback((patch: Partial<ViewportSettings>) => {
    setSettings((prev) => ({ ...prev, ...patch }));
  }, []);

  const activeFixture =
    fixtures.find((f) => f.id === activeFixtureId) ?? fixtures[0];

  const selectedTarget = selectedTargetId
    ? targets.find((t) => t.id === selectedTargetId) ?? null
    : null;

  const canvasSelectedFixture =
    !selectedTarget && canvasSelectedFixtureId
      ? fixtures.find((f) => f.id === canvasSelectedFixtureId) ?? null
      : null;

  const selectedTargetDeg = selectedTarget
    ? ((Math.round((selectedTarget.rotationY * 180) / Math.PI) % 360) + 360) % 360
    : 0;

  const handleToggleDock = useCallback(() => {
    setDockCollapsed((c) => !c);
  }, []);

  const handleResetControlsConfig = useCallback(() => {
    setControlsConfig({
      ...DEFAULT_INPUT_CONTROLS,
      keybinds: { ...DEFAULT_INPUT_CONTROLS.keybinds },
    });
  }, []);

  const handleDragStartBuilderTool = useCallback(
    (tool: Exclude<BuilderTool, null>) => {
      draggedToolRef.current = tool;
    },
    [],
  );

  const handleDragEndBuilderTool = useCallback(() => {
    draggedToolRef.current = null;
    sceneRef.current?.clearBuilderDragPreview();
  }, []);

  const builderRotationYRef = useRef(builderRotationY);
  builderRotationYRef.current = builderRotationY;

  const handleDragOverCanvas = useCallback((e: DragEvent<HTMLElement>) => {
    const tool = draggedToolRef.current;
    const hasTransfer = e.dataTransfer.types.includes(
      'application/x-luminastreet-builder',
    );
    if (!tool && !hasTransfer) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    if (tool) {
      sceneRef.current?.previewBuilderDragAt(
        tool,
        e.clientX,
        e.clientY,
        builderRotationYRef.current,
      );
    }
  }, []);

  const handleDragLeaveCanvas = useCallback((e: DragEvent<HTMLElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
      sceneRef.current?.clearBuilderDragPreview();
    }
  }, []);

  const handleDropCanvas = useCallback((e: DragEvent<HTMLElement>) => {
    const raw =
      e.dataTransfer.getData('application/x-luminastreet-builder') ||
      e.dataTransfer.getData('text/plain');
    const tool = VALID_DROP_TOOLS.has(raw)
      ? (raw as Exclude<BuilderTool, null>)
      : draggedToolRef.current;
    if (!tool) return;
    e.preventDefault();
    sceneRef.current?.dropBuilderAt(
      tool,
      e.clientX,
      e.clientY,
      builderRotationYRef.current,
    );
    draggedToolRef.current = null;
  }, []);

  return (
    <div className="relative flex h-screen w-screen flex-col overflow-hidden bg-[#07090e]">
      <TopTelemetryBar
        activeFixture={activeFixture}
        fixtureCount={fixtures.length}
        stats={stats}
        showLuxHeatmap={settings.showLuxHeatmap}
        luxThreshold={settings.luxThreshold}
      />

      {/* Dedicated Isolated WebGL Viewport Container */}
      <main
        className="relative flex-1 w-full overflow-hidden"
        onDragOver={handleDragOverCanvas}
        onDragLeave={handleDragLeaveCanvas}
        onDrop={handleDropCanvas}
      >
        <div
          ref={canvasMountRef}
          className="h-full w-full"
          aria-label="Interactive 3D street lighting simulator canvas"
        />

        {/* Floating Selection Action HUD for clicked objects, sidewalks, or light poles */}
        {builderTool === null && (selectedTarget || selectedSidewalk || canvasSelectedFixture) && (
          <div className="pointer-events-auto absolute top-3 left-1/2 z-20 flex -translate-x-1/2 flex-wrap items-center gap-2 rounded-lg border border-cyan-500/50 bg-[#0b0e17]/95 px-3 py-1.5 text-xs shadow-xl">
            <span
              className={`h-2 w-2 rounded-xs shrink-0 ${
                selectedTarget || selectedSidewalk ? 'bg-cyan-400' : 'bg-amber-400'
              }`}
            />
            <span className="font-semibold text-slate-100 whitespace-nowrap">
              {selectedTarget
                ? selectedTarget.label
                : selectedSidewalk
                  ? selectedSidewalk.label
                  : canvasSelectedFixture?.name}
            </span>
            <span className="font-mono-tabular text-[11px] text-slate-400 whitespace-nowrap">
              {selectedTarget
                ? `(${selectedTarget.position.x.toFixed(1)}, ${selectedTarget.position.z.toFixed(1)}) · ${selectedTargetDeg}°`
                : selectedSidewalk
                  ? `(${selectedSidewalk.position.x.toFixed(1)}, ${selectedSidewalk.position.z.toFixed(1)}) · Sidewalk`
                  : `(${canvasSelectedFixture!.position.x.toFixed(1)}, ${canvasSelectedFixture!.position.z.toFixed(1)}) · Pole ${canvasSelectedFixture!.poleYawAngle ?? canvasSelectedFixture!.yawAngle}° · Aim ${canvasSelectedFixture!.yawAngle}°`}
            </span>

            {selectedTarget && isBuildingKind(selectedTarget.kind) && (() => {
              const bDims = BUILDING_DEFAULT_DIMENSIONS[selectedTarget.kind] ?? {
                width: 5,
                length: 5,
                height: 6,
              };
              const curW = selectedTarget.width ?? bDims.width;
              const curL = selectedTarget.length ?? bDims.length;
              const curH = selectedTarget.height ?? bDims.height;
              return (
                <div className="flex flex-wrap items-center gap-1.5 border-l border-slate-800 pl-2">
                  <span className="font-mono-tabular text-[11px] text-cyan-300 whitespace-nowrap">
                    W {curW.toFixed(1)}m
                  </span>
                  <button
                    type="button"
                    onClick={() => handleAdjustTargetDimension(selectedTarget.id, 'width', -1)}
                    className="rounded border border-slate-700 bg-slate-900 px-1.5 py-0.5 text-[10px] font-medium text-slate-200 hover:border-cyan-500/60 hover:text-white"
                    title="Decrease width by 1m"
                  >
                    -1
                  </button>
                  <button
                    type="button"
                    onClick={() => handleAdjustTargetDimension(selectedTarget.id, 'width', 1)}
                    className="rounded border border-slate-700 bg-slate-900 px-1.5 py-0.5 text-[10px] font-medium text-slate-200 hover:border-cyan-500/60 hover:text-white"
                    title="Increase width by 1m"
                  >
                    +1
                  </button>

                  <span className="font-mono-tabular text-[11px] text-cyan-300 whitespace-nowrap ml-1">
                    L {curL.toFixed(1)}m
                  </span>
                  <button
                    type="button"
                    onClick={() => handleAdjustTargetDimension(selectedTarget.id, 'length', -1)}
                    className="rounded border border-slate-700 bg-slate-900 px-1.5 py-0.5 text-[10px] font-medium text-slate-200 hover:border-cyan-500/60 hover:text-white"
                    title="Decrease length by 1m"
                  >
                    -1
                  </button>
                  <button
                    type="button"
                    onClick={() => handleAdjustTargetDimension(selectedTarget.id, 'length', 1)}
                    className="rounded border border-slate-700 bg-slate-900 px-1.5 py-0.5 text-[10px] font-medium text-slate-200 hover:border-cyan-500/60 hover:text-white"
                    title="Increase length by 1m"
                  >
                    +1
                  </button>

                  <span className="font-mono-tabular text-[11px] text-cyan-300 whitespace-nowrap ml-1">
                    H {curH.toFixed(1)}m
                  </span>
                  <button
                    type="button"
                    onClick={() => handleAdjustTargetDimension(selectedTarget.id, 'height', -2)}
                    className="rounded border border-slate-700 bg-slate-900 px-1.5 py-0.5 text-[10px] font-medium text-slate-200 hover:border-cyan-500/60 hover:text-white"
                    title="Decrease height by 2m"
                  >
                    -2
                  </button>
                  <button
                    type="button"
                    onClick={() => handleAdjustTargetDimension(selectedTarget.id, 'height', 2)}
                    className="rounded border border-slate-700 bg-slate-900 px-1.5 py-0.5 text-[10px] font-medium text-slate-200 hover:border-cyan-500/60 hover:text-white"
                    title="Increase height by 2m"
                  >
                    +2
                  </button>
                </div>
              );
            })()}

            {selectedTarget && getRoadSidewalkPartKeys(selectedTarget.kind).length > 0 && (
              <div className="flex items-center gap-1 border-l border-slate-800 pl-2">
                <button
                  type="button"
                  onClick={() => handleToggleRoadSidewalks(selectedTarget.id)}
                  className="rounded border border-slate-700 bg-slate-900 px-2 py-1 text-[11px] font-medium text-slate-200 hover:border-cyan-500/60 hover:text-white whitespace-nowrap shrink-0"
                  title="Toggle attached sidewalks on this road segment"
                >
                  {(selectedTarget.hiddenSidewalks?.length ?? 0) > 0
                    ? 'Restore Sidewalks'
                    : 'Remove Sidewalks'}
                </button>
              </div>
            )}

            <div className="flex items-center gap-1 border-l border-slate-800 pl-2">
              {!selectedSidewalk && (
                <>
                  <button
                    type="button"
                    onClick={() => handleRotateSelected(-Math.PI / 4)}
                    className="flex items-center gap-1 rounded border border-slate-700 bg-slate-900 px-2 py-1 text-[11px] font-medium text-slate-200 hover:border-cyan-500/60 hover:text-white whitespace-nowrap shrink-0"
                    title="Rotate -45° (Shift+R)"
                  >
                    <RotateCcw className="h-3 w-3 text-cyan-400" />
                    <span>-45°</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => handleRotateSelected(Math.PI / 4)}
                    className="flex items-center gap-1 rounded border border-slate-700 bg-slate-900 px-2 py-1 text-[11px] font-medium text-slate-200 hover:border-cyan-500/60 hover:text-white whitespace-nowrap shrink-0"
                    title={`Rotate +45° (${formatKeyCode(controlsConfig.keybinds.rotate)})`}
                  >
                    <RotateCw className="h-3 w-3 text-cyan-400" />
                    <span>+45° ({formatKeyCode(controlsConfig.keybinds.rotate)})</span>
                  </button>
                </>
              )}
              <button
                type="button"
                disabled={!selectedTarget && !selectedSidewalk && fixtures.length <= 1}
                onClick={handleDeleteSelected}
                className="flex items-center gap-1 rounded border border-slate-700 bg-slate-900 px-2 py-1 text-[11px] font-medium text-rose-300 hover:border-rose-500/60 hover:bg-rose-500/15 disabled:opacity-35 whitespace-nowrap shrink-0"
                title={
                  !selectedTarget && !selectedSidewalk && fixtures.length <= 1
                    ? 'At least 1 light fixture is required'
                    : `Delete selected (${formatKeyCode(controlsConfig.keybinds.delete)})`
                }
              >
                <Trash2 className="h-3 w-3" />
                <span>Delete ({formatKeyCode(controlsConfig.keybinds.delete)})</span>
              </button>
              <button
                type="button"
                aria-label="Deselect"
                onClick={() => handleSelectTarget(null)}
                className="rounded p-1 text-slate-400 hover:bg-slate-800 hover:text-slate-100 shrink-0"
                title="Deselect (Esc)"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        )}

        {contextLost && (
          <div className="absolute inset-0 z-30 flex items-center justify-center bg-[#07090e]/90 p-6 text-center">
            <div className="max-w-sm rounded-xl border border-slate-800 bg-slate-900 p-5">
              <p className="text-sm font-semibold text-slate-100">
                WebGL Context Suspended
              </p>
              <p className="mt-1.5 text-xs text-slate-400">
                The 3D graphics context was temporarily paused by the browser and will resume automatically.
              </p>
            </div>
          </div>
        )}
      </main>

      <ControlDock
        collapsed={dockCollapsed}
        onToggleCollapse={handleToggleDock}
        fixtures={fixtures}
        activeFixtureId={activeFixture.id}
        onSelectFixture={handleSelectFixtureFromDock}
        onUpdateFixture={handleUpdateFixture}
        onRotateFixture={handleRotateFixtureYaw}
        onAddFixture={handleAddFixture}
        onDuplicateFixture={handleDuplicateFixture}
        onRemoveFixture={handleRemoveFixture}
        targets={targets}
        selectedTargetId={selectedTargetId}
        onSelectTarget={handleSelectTarget}
        onAddTarget={handleAddTarget}
        onRotateTarget={handleRotateTarget}
        onRemoveTarget={handleRemoveTarget}
        onClearTargets={handleClearTargets}
        onRemoveAllSidewalks={handleRemoveAllSidewalks}
        builderTool={builderTool}
        builderRotationY={builderRotationY}
        onSelectBuilderTool={setBuilderTool}
        onRotateBuilderTool={handleRotateBuilderTool}
        onDragStartBuilderTool={handleDragStartBuilderTool}
        onDragEndBuilderTool={handleDragEndBuilderTool}
        settings={settings}
        onUpdateSettings={handleUpdateSettings}
        stats={stats}
        activePresetId={activePresetId}
        onApplyPreset={handleApplyPreset}
        onCameraPreset={handleCameraPreset}
        controlsConfig={controlsConfig}
        onUpdateControlsConfig={setControlsConfig}
        onResetControlsConfig={handleResetControlsConfig}
      />
    </div>
  );
}
