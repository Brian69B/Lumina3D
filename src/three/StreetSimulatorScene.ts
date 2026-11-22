import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import {
  AmbientMode,
  BUILDING_DEFAULT_DIMENSIONS,
  BUILDING_DEFAULT_HEIGHTS,
  BuilderTool,
  CameraControlMode,
  CameraPresetId,
  CrossingWaypoint,
  DEFAULT_INPUT_CONTROLS,
  FIXTURE_MAX_X,
  FIXTURE_MAX_Z,
  InputControlsConfig,
  isRoadOrPathKind,
  isVehicleKind,
  LightFixture,
  MAP_HALF_X,
  MAP_HALF_Z,
  MouseDragButton,
  PhotometricStats,
  SelectedSidewalkInfo,
  StreetRouteId,
  StreetTarget,
  TargetKind,
  ViewportSettings,
} from '../types/lighting';
import {
  clamp,
  computeAngularFactorFromDeg,
  computeIlluminanceAtPoint,
  computePeakCandela,
  computeScenePhotometrics,
  degToRad,
  generatePedestrianCrossingPath,
  getAimDirection,
  getEffectiveAngleAtDeg,
  getEffectiveHalfAngleRad,
  getFixtureHex,
  getMaxEffectiveAngle,
  getNadirEffectiveAngle,
  getSectorAnglesSignature,
  hasCustomSectorAngles,
} from '../utils/photometrics';
import {
  attachLuxOverlayToMaterial,
  attachLuxOverlayToObject,
  createLuxOverlayUniformState,
  disposeLuxOverlayState,
  LuxOverlayUniformState,
  updateLuxOverlayUniforms,
} from './luxHeatmapShader';
import {
  createBuilderGhostGroup,
  createStreetPoleRig,
  createStreetTargetGroup,
  disposeObject3DResources,
  getParkingLotOpenStalls,
  ParkingStallSpec,
  PedestrianRigRefs,
  PoleVisualRefs,
  TrafficSignalMaterials,
  updateStreetPoleRig,
} from './proceduralModels';
import {
  createAsphaltTexture,
  createContactShadowTexture,
  createSidewalkTexture,
  disposeCachedRoadTextures,
  getTrafficCountdownTexture,
} from './textures';
import {
  getShieldTransmittanceAtDeg,
  isPointOnSidewalkSegment,
} from '../utils/photometrics';
import { SHIELD_SECTORS } from '../types/lighting';

interface LightRigEntry {
  spotLight: THREE.SpotLight;
  spotTarget: THREE.Object3D;
  pointLight: THREE.PointLight;
  poleRefs: PoleVisualRefs;
  goboTex: THREE.DataTexture | null;
  goboSignature: string;
}

type SignalAspect = 'green' | 'yellow' | 'red';

interface TrafficController {
  targetId: string;
  cx: number;
  cz: number;
  axisZX: number;
  axisZZ: number;
  axisXX: number;
  axisXZ: number;
  stopBarDist: number;
  cycleOffset: number;
  lastAspectX?: SignalAspect;
  lastAspectZ?: SignalAspect;
  lastCountdownX?: number;
  lastCountdownZ?: number;
}

type VehicleParkingPhase =
  | 'approaching-lot'
  | 'entering-lot'
  | 'parked'
  | 'reversing-out'
  | 'exiting-lot';

interface AnimatedActorState {
  motion: 'walk' | 'drive';
  kind: TargetKind;
  routeId?: StreetRouteId;
  x: number;
  z: number;
  rotationY: number;
  phase: number;
  strideBlend: number;
  waypointIdx: number;
  halfLen: number;
  speed: number;
  currentSpeed: number;
  isYielding: boolean;
  lastPropPos: { x: number; z: number };
  lastPropRotY: number;
  graphNodeId?: number;
  subPath?: Array<{ x: number; z: number }>;
  subPathIdx?: number;
  roundaboutSteps?: number;
  roundaboutTargetSteps?: number;
  speedDriftTimer?: number;
  offGraphTurnRate?: number;
  offGraphTimer?: number;
  seekingRoad?: boolean;
  seekingSidewalk?: boolean;
  walkCurrNodeId?: number;
  walkPrevNodeId?: number;
  walkGoalX?: number;
  walkGoalZ?: number;
  walkIsCrosswalk?: boolean;
  walkPauseTimer?: number;
  walkReactionTimer?: number;
  walkWasYielding?: boolean;
  walkIdleTime?: number;
  walkSeed?: number;
  walkLookYaw?: number;
  walkLookPitch?: number;
  crossingWaypoints?: CrossingWaypoint[];
  crossingStepIdx?: number;
  crossingCurbPaused?: boolean;
  lastCrossingPathRef?: CrossingWaypoint[];
  parkingPhase?: VehicleParkingPhase;
  parkingLotId?: string;
  parkingStallIdx?: number;
  parkingStallYaw?: number;
  parkingExitAisleYaw?: number;
  parkingDwellTimer?: number;
  parkingPlannedEdges?: RoadGraphEdge[];
  parkingApproachTrimmedPoints?: Array<{ x: number; z: number }>;
  parkingOnFinalEdge?: boolean;
  parkingEntryWaypoints?: Array<{ x: number; z: number }>;
  parkingReverseWaypoints?: Array<{ x: number; z: number }>;
  parkingReverseIdx?: number;
  parkingReverseSegDist?: number;
  parkingReverseStartYaw?: number;
  parkingExitRejoinSubIdx?: number;
  parkingLotPose?: { x: number; z: number; rotationY: number };
  lastParkedAt?: number;
}

export interface SceneCallbacks {
  onStatsUpdate: (stats: PhotometricStats) => void;
  onSelectFixture: (id: string) => void;
  onSelectTarget: (id: string | null) => void;
  onSelectSidewalk?: (info: SelectedSidewalkInfo | null) => void;
  onMoveTarget: (id: string, pos: { x: number; z: number }) => void;
  onMoveFixture: (id: string, pos: { x: number; z: number }) => void;
  onPlaceBuilderItem: (
    tool: Exclude<BuilderTool, null>,
    pos: { x: number; z: number },
    rotationY: number,
  ) => void;
  onRotateBuilderTool: () => void;
  onCancelBuilderTool: () => void;
  onRotateSelected?: (deltaRad: number) => void;
  onDeleteSelected?: () => void;
  onContextLostChange?: (lost: boolean) => void;
}

// Module-level reusable math helpers (zero GC churn inside render loop)
const _vec3A = new THREE.Vector3();
const _vec3B = new THREE.Vector3();
const _vec3C = new THREE.Vector3();
const _euler = new THREE.Euler(0, 0, 0, 'YXZ');
const _mouse = new THREE.Vector2();
const _groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const _dragHit = new THREE.Vector3();

interface WalkGraphNode {
  id: number;
  x: number;
  z: number;
  roadId: string;
  isCorner: boolean;
  isSidewalkPath?: boolean;
}

interface WalkGraphEdge {
  toNodeId: number;
  isCrosswalk: boolean;
}

interface WalkGraph {
  nodes: WalkGraphNode[];
  edges: WalkGraphEdge[][];
}

interface RoadGraphNode {
  id: number;
  x: number;
  z: number;
  dirX: number;
  dirZ: number;
  roadId: string;
  isPerimeter: boolean;
}

interface RoadGraphEdge {
  toNodeId: number;
  points: Array<{ x: number; z: number }>;
  isWrap?: boolean;
  isUTurn?: boolean;
  isRoundaboutStay?: boolean;
  isRoundaboutExit?: boolean;
  weight: number;
}

interface RoadLaneGraph {
  nodes: RoadGraphNode[];
  edges: RoadGraphEdge[][];
}

const ROAD_LANE_OFFSET = 2.15;

function buildRoadLaneGraph(roadEntries: RoadSpatialEntry[]): RoadLaneGraph {
  const nodes: RoadGraphNode[] = [];
  const edges: RoadGraphEdge[][] = [];

  interface PortBinding {
    roadId: string;
    inId: number;
    outId: number;
    px: number;
    pz: number;
    outDirX: number;
    outDirZ: number;
    isStraightRoad: boolean;
    connectedOut: boolean;
    connectedIn: boolean;
  }

  const portsList: PortBinding[] = [];

  const createNode = (
    wx: number,
    wz: number,
    wdx: number,
    wdz: number,
    roadId: string,
    isPerimeter = false,
  ): number => {
    const id = nodes.length;
    nodes.push({ id, x: wx, z: wz, dirX: wdx, dirZ: wdz, roadId, isPerimeter });
    edges.push([]);
    return id;
  };

  const pushWorldEdge = (
    fromId: number,
    toId: number,
    points: Array<{ x: number; z: number }>,
    opts: Partial<Omit<RoadGraphEdge, 'toNodeId' | 'points'>> = {},
  ) => {
    edges[fromId].push({
      toNodeId: toId,
      points,
      weight: opts.weight ?? 1.0,
      isWrap: opts.isWrap,
      isUTurn: opts.isUTurn,
      isRoundaboutStay: opts.isRoundaboutStay,
      isRoundaboutExit: opts.isRoundaboutExit,
    });
  };

  for (const entry of roadEntries) {
    const { target, cos, sin } = entry;
    const tx = target.position.x;
    const tz = target.position.z;
    const kind = target.kind;

    const toW = (lx: number, lz: number) => ({
      x: tx + lx * cos + lz * sin,
      z: tz - lx * sin + lz * cos,
    });
    const toD = (dx: number, dz: number) => ({
      x: dx * cos + dz * sin,
      z: -dx * sin + dz * cos,
    });

    const addLocalPort = (
      lx: number,
      lz: number,
      nx: number,
      nz: number,
      isStraightRoad = false,
    ): PortBinding => {
      const rx = -nz;
      const rz = nx;
      // Right-Hand Traffic: entering (-nx, -nz) uses left of outward normal (-rx, -rz);
      // exiting (+nx, +nz) uses right of outward normal (+rx, +rz).
      const wIn = toW(lx - rx * ROAD_LANE_OFFSET, lz - rz * ROAD_LANE_OFFSET);
      const wInDir = toD(-nx, -nz);
      const wOut = toW(lx + rx * ROAD_LANE_OFFSET, lz + rz * ROAD_LANE_OFFSET);
      const wOutDir = toD(nx, nz);
      const wPort = toW(lx, lz);
      const isPerim =
        Math.abs(wPort.x) >= MAP_HALF_X - 2.0 ||
        Math.abs(wPort.z) >= MAP_HALF_Z - 2.0;

      const inId = createNode(wIn.x, wIn.z, wInDir.x, wInDir.z, target.id, isPerim);
      const outId = createNode(wOut.x, wOut.z, wOutDir.x, wOutDir.z, target.id, isPerim);
      const binding: PortBinding = {
        roadId: target.id,
        inId,
        outId,
        px: wPort.x,
        pz: wPort.z,
        outDirX: wOutDir.x,
        outDirZ: wOutDir.z,
        isStraightRoad,
        connectedOut: false,
        connectedIn: false,
      };
      portsList.push(binding);
      return binding;
    };

    if (kind === 'road-2lane' || kind === 'road-crosswalk') {
      const halfL =
        kind === 'road-2lane' && target.length && target.length > 0
          ? target.length * 0.5
          : kind === 'road-crosswalk'
            ? 3.0
            : 4.0;
      const pE = addLocalPort(halfL, 0, 1, 0, true);
      const pW = addLocalPort(-halfL, 0, -1, 0, true);
      pushWorldEdge(pW.inId, pE.outId, [{ x: nodes[pE.outId].x, z: nodes[pE.outId].z }]);
      pushWorldEdge(pE.inId, pW.outId, [{ x: nodes[pW.outId].x, z: nodes[pW.outId].z }]);
    } else if (kind === 'road-intersection' || kind === 'road-t-junction') {
      const portSpecs: Array<[number, number, number, number]> =
        kind === 'road-t-junction'
          ? [
              [4.5, 0, 1, 0],
              [-4.5, 0, -1, 0],
              [0, 4.5, 0, 1],
            ]
          : [
              [4.5, 0, 1, 0],
              [0, -4.5, 0, -1],
              [-4.5, 0, -1, 0],
              [0, 4.5, 0, 1],
            ];
      const localPorts = portSpecs.map(([lx, lz, nx, nz]) => addLocalPort(lx, lz, nx, nz));
      for (let i = 0; i < localPorts.length; i++) {
        for (let j = 0; j < localPorts.length; j++) {
          if (i === j) continue;
          const inNode = nodes[localPorts[i].inId];
          const outNode = nodes[localPorts[j].outId];
          const dot = inNode.dirX * outNode.dirX + inNode.dirZ * outNode.dirZ;
          if (dot > 0.9) {
            pushWorldEdge(inNode.id, outNode.id, [{ x: outNode.x, z: outNode.z }]);
          } else {
            const tProj =
              (outNode.x - inNode.x) * inNode.dirX + (outNode.z - inNode.z) * inNode.dirZ;
            const ctrlX = inNode.x + inNode.dirX * tProj;
            const ctrlZ = inNode.z + inNode.dirZ * tProj;
            const pts: Array<{ x: number; z: number }> = [];
            for (const u of [0.2, 0.4, 0.6, 0.8, 1.0]) {
              const omt = 1 - u;
              pts.push({
                x: omt * omt * inNode.x + 2 * omt * u * ctrlX + u * u * outNode.x,
                z: omt * omt * inNode.z + 2 * omt * u * ctrlZ + u * u * outNode.z,
              });
            }
            pushWorldEdge(inNode.id, outNode.id, pts);
          }
        }
      }
    } else if (kind === 'road-turn-90') {
      const pW = addLocalPort(-6.0, 0, -1, 0);
      const pS = addLocalPort(0, 6.0, 0, 1);

      const innerPts: Array<{ x: number; z: number }> = [];
      const rInner = 6.0 - ROAD_LANE_OFFSET;
      for (const u of [0.25, 0.5, 0.75, 1.0]) {
        const ang = (1 - u) * (Math.PI / 2);
        innerPts.push(toW(-6 + rInner * Math.cos(ang), 6 - rInner * Math.sin(ang)));
      }
      pushWorldEdge(pW.inId, pS.outId, innerPts);

      const outerPts: Array<{ x: number; z: number }> = [];
      const rOuter = 6.0 + ROAD_LANE_OFFSET;
      for (const u of [0.25, 0.5, 0.75, 1.0]) {
        const ang = u * (Math.PI / 2);
        outerPts.push(toW(-6 + rOuter * Math.cos(ang), 6 - rOuter * Math.sin(ang)));
      }
      pushWorldEdge(pS.inId, pW.outId, outerPts);
    } else if (kind === 'road-curve-45') {
      const p0 = addLocalPort(-4.95, -2.05, -1, 0);
      const p1 = addLocalPort(
        -4.95 + 14.0 * Math.SQRT1_2,
        11.95 - 14.0 * Math.SQRT1_2,
        Math.SQRT1_2,
        -Math.SQRT1_2,
      );
      const rInner = 14.0 - ROAD_LANE_OFFSET;
      const fwdPts: Array<{ x: number; z: number }> = [];
      for (const u of [0.25, 0.5, 0.75, 1.0]) {
        const ang = Math.PI / 2 - u * (Math.PI / 4);
        fwdPts.push(toW(-4.95 + rInner * Math.cos(ang), 11.95 - rInner * Math.sin(ang)));
      }
      pushWorldEdge(p0.inId, p1.outId, fwdPts);

      const rOuter = 14.0 + ROAD_LANE_OFFSET;
      const revPts: Array<{ x: number; z: number }> = [];
      for (const u of [0.25, 0.5, 0.75, 1.0]) {
        const ang = Math.PI / 4 + u * (Math.PI / 4);
        revPts.push(toW(-4.95 + rOuter * Math.cos(ang), 11.95 - rOuter * Math.sin(ang)));
      }
      pushWorldEdge(p1.inId, p0.outId, revPts);
    } else if (kind === 'road-roundabout') {
      const armMask = entry.armMask ?? 15;
      const ringR = 6.75;
      const ringNodeIds: number[] = [];
      for (let k = 0; k < 8; k++) {
        const ang = (k * Math.PI) / 4;
        const wp = toW(Math.sin(ang) * ringR, Math.cos(ang) * ringR);
        const wd = toD(Math.cos(ang), -Math.sin(ang));
        ringNodeIds.push(createNode(wp.x, wp.z, wd.x, wd.z, target.id));
      }
      for (let k = 0; k < 8; k++) {
        const nextK = (k + 1) % 8;
        const midAng = ((k + 0.5) * Math.PI) / 4;
        const midW = toW(Math.sin(midAng) * ringR, Math.cos(midAng) * ringR);
        const nextNode = nodes[ringNodeIds[nextK]];
        pushWorldEdge(
          ringNodeIds[k],
          nextNode.id,
          [midW, { x: nextNode.x, z: nextNode.z }],
          { isRoundaboutStay: true, weight: 0.5 },
        );
      }

      const armDefs: Array<[number, number]> = [
        [8, 0], // South
        [1, 2], // East
        [2, 4], // North
        [4, 6], // West
      ];
      for (const [bit, armIdx] of armDefs) {
        if ((armMask & bit) === 0) continue;
        const ang = (armIdx * Math.PI) / 4;
        const radX = Math.sin(ang);
        const radZ = Math.cos(ang);
        const tanX = Math.cos(ang);
        const tanZ = -Math.sin(ang);
        const port = addLocalPort(10.0 * radX, 10.0 * radZ, radX, radZ);

        const nextRing = nodes[ringNodeIds[(armIdx + 1) % 8]];
        const mergeIn = toW(7.2 * radX + 3.2 * tanX, 7.2 * radZ + 3.2 * tanZ);
        pushWorldEdge(
          port.inId,
          nextRing.id,
          [mergeIn, { x: nextRing.x, z: nextRing.z }],
        );

        const prevRingId = ringNodeIds[(armIdx + 7) % 8];
        const mergeOut = toW(7.2 * radX - 3.2 * tanX, 7.2 * radZ - 3.2 * tanZ);
        const outNode = nodes[port.outId];
        pushWorldEdge(
          prevRingId,
          outNode.id,
          [mergeOut, { x: outNode.x, z: outNode.z }],
          { isRoundaboutExit: true, weight: 0.5 },
        );
      }
    } else if (kind === 'road-culdesac') {
      const ringR = 3.8;
      const ringNodeIds: number[] = [];
      for (let k = 0; k < 4; k++) {
        const ang = (k * Math.PI) / 2;
        const wp = toW(Math.sin(ang) * ringR, Math.cos(ang) * ringR);
        const wd = toD(Math.cos(ang), -Math.sin(ang));
        ringNodeIds.push(createNode(wp.x, wp.z, wd.x, wd.z, target.id));
      }
      for (let k = 0; k < 4; k++) {
        const nextK = (k + 1) % 4;
        const midAng = ((k + 0.5) * Math.PI) / 2;
        const midW = toW(Math.sin(midAng) * ringR, Math.cos(midAng) * ringR);
        const nextNode = nodes[ringNodeIds[nextK]];
        pushWorldEdge(
          ringNodeIds[k],
          nextNode.id,
          [midW, { x: nextNode.x, z: nextNode.z }],
          { isRoundaboutStay: true, weight: 0.55 },
        );
      }
      for (let k = 0; k < 4; k++) {
        const ang = (k * Math.PI) / 2;
        const radX = Math.sin(ang);
        const radZ = Math.cos(ang);
        const port = addLocalPort(6.0 * radX, 6.0 * radZ, radX, radZ);
        const nextRing = nodes[ringNodeIds[(k + 1) % 4]];
        pushWorldEdge(port.inId, nextRing.id, [{ x: nextRing.x, z: nextRing.z }]);
        const outNode = nodes[port.outId];
        pushWorldEdge(
          ringNodeIds[k],
          outNode.id,
          [{ x: outNode.x, z: outNode.z }],
          { isRoundaboutExit: true, weight: 0.45 },
        );
      }
    } else if (kind === 'road-deadend') {
      const pW = addLocalPort(-6.0, 0, -1, 0);
      const pts = [
        toW(-1.5, ROAD_LANE_OFFSET),
        toW(1.8, 2.8),
        toW(3.4, 0),
        toW(1.8, -2.8),
        toW(-1.5, -ROAD_LANE_OFFSET),
        { x: nodes[pW.outId].x, z: nodes[pW.outId].z },
      ];
      pushWorldEdge(pW.inId, pW.outId, pts);
    }
  }

  // Stitch flush-connected ports across distinct road targets
  for (let i = 0; i < portsList.length; i++) {
    const pA = portsList[i];
    for (let j = 0; j < portsList.length; j++) {
      if (i === j) continue;
      const pB = portsList[j];
      if (pA.roadId === pB.roadId) continue;
      if (Math.hypot(pA.px - pB.px, pA.pz - pB.pz) > 0.85) continue;
      if (pA.outDirX * pB.outDirX + pA.outDirZ * pB.outDirZ > -0.7) continue;

      const outA = nodes[pA.outId];
      const inB = nodes[pB.inId];
      const gap = Math.hypot(outA.x - inB.x, outA.z - inB.z);
      pushWorldEdge(
        outA.id,
        inB.id,
        gap > 0.15 ? [{ x: inB.x, z: inB.z }] : [],
      );
      pA.connectedOut = true;
      pB.connectedIn = true;
    }
  }

  // Pair open straight-road & perimeter ends to teleport vehicles straight to the opposite end of the street
  for (const pA of portsList) {
    if (pA.connectedOut) continue;
    const outNode = nodes[pA.outId];
    const inNode = nodes[pA.inId];

    let bestWrap: PortBinding | null = null;
    let bestPerpDist = Infinity;
    let bestSpanDist = -Infinity;
    for (const pB of portsList) {
      if (pB === pA || pB.connectedIn) continue;
      const inBNode = nodes[pB.inId];
      const bothPerimeter = outNode.isPerimeter && inBNode.isPerimeter;
      const bothStraight = pA.isStraightRoad && pB.isStraightRoad;
      if (!bothPerimeter && !bothStraight) continue;
      // Same travel direction (pB outward points opposite to pA outward)
      if (pA.outDirX * -pB.outDirX + pA.outDirZ * -pB.outDirZ < 0.85) continue;
      const dx = pB.px - pA.px;
      const dz = pB.pz - pA.pz;
      const fwd = dx * pA.outDirX + dz * pA.outDirZ;
      if (fwd > -14) continue;
      const perp = Math.abs(dx * -pA.outDirZ + dz * pA.outDirX);
      const span = -fwd;
      if (
        perp <= 3.2 &&
        (perp + 0.45 < bestPerpDist ||
          (Math.abs(perp - bestPerpDist) <= 0.45 && span > bestSpanDist))
      ) {
        bestPerpDist = perp;
        bestSpanDist = span;
        bestWrap = pB;
      }
    }
    if (bestWrap) {
      const dest = nodes[bestWrap.inId];
      pushWorldEdge(outNode.id, dest.id, [{ x: dest.x, z: dest.z }], {
        isWrap: true,
        weight: 1.0,
      });
      continue;
    }

    // Smooth in-road turnaround so cars never drive onto grass when a road ends mid-block
    const rightVecX = -pA.outDirZ;
    const rightVecZ = pA.outDirX;
    const outMid = {
      x: pA.px - pA.outDirX * 0.25 + rightVecX * (ROAD_LANE_OFFSET * 0.48),
      z: pA.pz - pA.outDirZ * 0.25 + rightVecZ * (ROAD_LANE_OFFSET * 0.48),
    };
    const apex = {
      x: pA.px - pA.outDirX * 0.55,
      z: pA.pz - pA.outDirZ * 0.55,
    };
    const inMid = {
      x: pA.px - pA.outDirX * 0.85 - rightVecX * (ROAD_LANE_OFFSET * 0.55),
      z: pA.pz - pA.outDirZ * 0.85 - rightVecZ * (ROAD_LANE_OFFSET * 0.55),
    };
    const inLaneTarget = {
      x: inNode.x + inNode.dirX * 1.25,
      z: inNode.z + inNode.dirZ * 1.25,
    };
    const inOutEdges = edges[inNode.id];
    if (inOutEdges.length > 0) {
      for (const nextEdge of inOutEdges) {
        if (nextEdge.isWrap || nextEdge.isUTurn) continue;
        pushWorldEdge(
          outNode.id,
          nextEdge.toNodeId,
          [outMid, apex, inMid, inLaneTarget, ...nextEdge.points],
          {
            isUTurn: true,
            weight: (outNode.isPerimeter ? 0.34 : 1.0) * nextEdge.weight,
          },
        );
      }
    } else {
      pushWorldEdge(outNode.id, inNode.id, [outMid, apex, inMid, inLaneTarget], {
        isUTurn: true,
        weight: outNode.isPerimeter ? 0.34 : 1.0,
      });
    }
  }

  return { nodes, edges };
}

function buildWalkGraph(
  roadEntries: RoadSpatialEntry[],
  allTargets: StreetTarget[] = [],
): WalkGraph {
  const nodes: WalkGraphNode[] = [];
  const edges: WalkGraphEdge[][] = [];

  const addNode = (
    wx: number,
    wz: number,
    roadId: string,
    isCorner = false,
    isSidewalkPath = false,
  ): number => {
    const id = nodes.length;
    nodes.push({ id, x: wx, z: wz, roadId, isCorner, isSidewalkPath });
    edges.push([]);
    return id;
  };

  const addEdge = (a: number, b: number, isCrosswalk = false) => {
    if (a === b) return;
    if (!edges[a].some((e) => e.toNodeId === b)) {
      edges[a].push({ toNodeId: b, isCrosswalk });
    }
    if (!edges[b].some((e) => e.toNodeId === a)) {
      edges[b].push({ toNodeId: a, isCrosswalk });
    }
  };

  for (const entry of roadEntries) {
    const { target, cos, sin, hiddenSet } = entry;
    const tx = target.position.x;
    const tz = target.position.z;
    const kind = target.kind;
    const toW = (lx: number, lz: number) => ({
      x: tx + lx * cos + lz * sin,
      z: tz - lx * sin + lz * cos,
    });
    const addLocal = (lx: number, lz: number, isCorner = false): number => {
      const p = toW(lx, lz);
      return addNode(p.x, p.z, target.id, isCorner);
    };

    if (kind === 'road-2lane' || kind === 'road-crosswalk') {
      const halfL =
        kind === 'road-2lane' && target.length && target.length > 0
          ? target.length * 0.5
          : kind === 'road-crosswalk'
            ? 3.0
            : 4.0;
      const nMid = !hiddenSet.has('north') ? addLocal(0, -5.95) : -1;
      const sMid = !hiddenSet.has('south') ? addLocal(0, 5.95) : -1;
      if (nMid >= 0) {
        const nW = addLocal(-halfL, -5.95);
        const nE = addLocal(halfL, -5.95);
        addEdge(nW, nMid, false);
        addEdge(nMid, nE, false);
      }
      if (sMid >= 0) {
        const sW = addLocal(-halfL, 5.95);
        const sE = addLocal(halfL, 5.95);
        addEdge(sW, sMid, false);
        addEdge(sMid, sE, false);
      }
      if (kind === 'road-crosswalk' && nMid >= 0 && sMid >= 0) {
        addEdge(nMid, sMid, true);
      }
    } else if (kind === 'road-intersection') {
      const corners: Record<'nw' | 'ne' | 'sw' | 'se', number> = {
        nw: -1,
        ne: -1,
        sw: -1,
        se: -1,
      };
      const specs: Array<['nw' | 'ne' | 'sw' | 'se', number, number]> = [
        ['nw', -5.95, -5.95],
        ['ne', 5.95, -5.95],
        ['sw', -5.95, 5.95],
        ['se', 5.95, 5.95],
      ];
      for (const [key, lx, lz] of specs) {
        if (hiddenSet.has(key)) continue;
        const cId = addLocal(lx, lz, true);
        corners[key] = cId;
        const sx = Math.sign(lx);
        const sz = Math.sign(lz);
        addEdge(cId, addLocal(sx * 4.5, lz), false);
        addEdge(cId, addLocal(lx, sz * 4.5), false);
      }
      if (corners.nw >= 0 && corners.ne >= 0) addEdge(corners.nw, corners.ne, true);
      if (corners.sw >= 0 && corners.se >= 0) addEdge(corners.sw, corners.se, true);
      if (corners.nw >= 0 && corners.sw >= 0) addEdge(corners.nw, corners.sw, true);
      if (corners.ne >= 0 && corners.se >= 0) addEdge(corners.ne, corners.se, true);
    } else if (kind === 'road-t-junction') {
      // Sidewalks only (no unmarked crosswalks across T-junction legs)
      if (!hiddenSet.has('back')) {
        const bW = addLocal(-4.5, -5.95);
        const bM = addLocal(0, -5.95, true);
        const bE = addLocal(4.5, -5.95);
        addEdge(bW, bM, false);
        addEdge(bM, bE, false);
      }
      if (!hiddenSet.has('sw')) {
        const swC = addLocal(-5.95, 5.95, true);
        addEdge(swC, addLocal(-4.5, 5.95), false);
        addEdge(swC, addLocal(-5.95, 4.5), false);
      }
      if (!hiddenSet.has('se')) {
        const seC = addLocal(5.95, 5.95, true);
        addEdge(seC, addLocal(4.5, 5.95), false);
        addEdge(seC, addLocal(5.95, 4.5), false);
      }
    } else if (kind === 'road-roundabout') {
      const armMask = entry.armMask ?? 15;
      const openE = (armMask & 1) !== 0;
      const openN = (armMask & 2) !== 0;
      const openW = (armMask & 4) !== 0;
      const openS = (armMask & 8) !== 0;

      const q: Record<'nw' | 'ne' | 'sw' | 'se', number> = {
        nw: !hiddenSet.has('nw') ? addLocal(-7.85, -7.85, true) : -1,
        ne: !hiddenSet.has('ne') ? addLocal(7.85, -7.85, true) : -1,
        sw: !hiddenSet.has('sw') ? addLocal(-7.85, 7.85, true) : -1,
        se: !hiddenSet.has('se') ? addLocal(7.85, 7.85, true) : -1,
      };
      if (openE) {
        const neE = q.ne >= 0 ? addLocal(10.0, -5.95) : -1;
        const seE = q.se >= 0 ? addLocal(10.0, 5.95) : -1;
        if (neE >= 0) addEdge(q.ne, neE, false);
        if (seE >= 0) addEdge(q.se, seE, false);
      } else if (!hiddenSet.has('cap-E') && q.ne >= 0 && q.se >= 0) {
        const capE = addLocal(11.1, 0, true);
        addEdge(q.ne, capE, false);
        addEdge(capE, q.se, false);
      }
      if (openW) {
        const nwW = q.nw >= 0 ? addLocal(-10.0, -5.95) : -1;
        const swW = q.sw >= 0 ? addLocal(-10.0, 5.95) : -1;
        if (nwW >= 0) addEdge(q.nw, nwW, false);
        if (swW >= 0) addEdge(q.sw, swW, false);
      } else if (!hiddenSet.has('cap-W') && q.nw >= 0 && q.sw >= 0) {
        const capW = addLocal(-11.1, 0, true);
        addEdge(q.nw, capW, false);
        addEdge(capW, q.sw, false);
      }
      if (openN) {
        const nwN = q.nw >= 0 ? addLocal(-5.95, -10.0) : -1;
        const neN = q.ne >= 0 ? addLocal(5.95, -10.0) : -1;
        if (nwN >= 0) addEdge(q.nw, nwN, false);
        if (neN >= 0) addEdge(q.ne, neN, false);
      } else if (!hiddenSet.has('cap-N') && q.nw >= 0 && q.ne >= 0) {
        const capN = addLocal(0, -11.1, true);
        addEdge(q.nw, capN, false);
        addEdge(capN, q.ne, false);
      }
      if (openS) {
        const swS = q.sw >= 0 ? addLocal(-5.95, 10.0) : -1;
        const seS = q.se >= 0 ? addLocal(5.95, 10.0) : -1;
        if (swS >= 0) addEdge(q.sw, swS, false);
        if (seS >= 0) addEdge(q.se, seS, false);
      } else if (!hiddenSet.has('cap-S') && q.sw >= 0 && q.se >= 0) {
        const capS = addLocal(0, 11.1, true);
        addEdge(q.sw, capS, false);
        addEdge(capS, q.se, false);
      }
    } else if (kind === 'road-turn-90') {
      if (!hiddenSet.has('outer')) {
        const r = 12.0;
        const a = addLocal(-6.0 + r * Math.cos(Math.PI / 2), 6.0 - r * Math.sin(Math.PI / 2));
        const m = addLocal(-6.0 + r * Math.cos(Math.PI / 4), 6.0 - r * Math.sin(Math.PI / 4), true);
        const b = addLocal(-6.0 + r * Math.cos(0), 6.0 - r * Math.sin(0));
        addEdge(a, m, false);
        addEdge(m, b, false);
      }
    } else if (kind === 'road-curve-45') {
      for (const [key, r] of [
        ['outer', 20.0],
        ['inner', 8.0],
      ] as const) {
        if (hiddenSet.has(key)) continue;
        const a = addLocal(-4.95 + r * Math.cos(Math.PI / 2), 11.95 - r * Math.sin(Math.PI / 2));
        const m = addLocal(
          -4.95 + r * Math.cos(Math.PI * 0.375),
          11.95 - r * Math.sin(Math.PI * 0.375),
          true,
        );
        const b = addLocal(-4.95 + r * Math.cos(Math.PI / 4), 11.95 - r * Math.sin(Math.PI / 4));
        addEdge(a, m, false);
        addEdge(m, b, false);
      }
    } else if (kind === 'road-deadend' && !hiddenSet.has('ring')) {
      const nW = addLocal(-6.0, -5.95);
      const sW = addLocal(-6.0, 5.95);
      const nArc = addLocal(2.0, -7.2);
      const eArc = addLocal(7.4, 0, true);
      const sArc = addLocal(2.0, 7.2);
      addEdge(nW, nArc, false);
      addEdge(nArc, eArc, false);
      addEdge(eArc, sArc, false);
      addEdge(sArc, sW, false);
    }
  }

  // Include standalone path-sidewalk segments in the pedestrian walk graph
  for (const target of allTargets) {
    if (target.kind !== 'path-sidewalk') continue;
    const cos = Math.cos(target.rotationY);
    const sin = Math.sin(target.rotationY);
    const toSW = (lx: number, lz: number) => ({
      x: target.position.x + lx * cos + lz * sin,
      z: target.position.z - lx * sin + lz * cos,
    });
    const pW = toSW(-3.2, 0);
    const pM = toSW(0, 0);
    const pE = toSW(3.2, 0);
    const idW = addNode(pW.x, pW.z, target.id, false, true);
    const idM = addNode(pM.x, pM.z, target.id, false, true);
    const idE = addNode(pE.x, pE.z, target.id, false, true);
    addEdge(idW, idM, false);
    addEdge(idM, idE, false);
  }

  // Stitch adjacent sidewalk nodes across distinct road pieces (avoiding roadway crossings)
  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i];
    for (let j = i + 1; j < nodes.length; j++) {
      const b = nodes[j];
      if (a.roadId === b.roadId) continue;
      const stitchDist = a.isSidewalkPath || b.isSidewalkPath ? 1.85 : 1.05;
      if (Math.hypot(a.x - b.x, a.z - b.z) > stitchDist) continue;
      const mx = (a.x + b.x) * 0.5;
      const mz = (a.z + b.z) * 0.5;
      if (isPointInsideAnyRoadway(mx, mz, roadEntries)) continue;
      addEdge(a.id, b.id, false);
    }
  }

  return { nodes, edges };
}

function getActorHalfLength(kind: TargetKind): number {
  switch (kind) {
    case 'bike':
      return 0.9;
    case 'motorcycle':
      return 1.1;
    case 'sedan':
      return 2.25;
    case 'van':
      return 2.6;
    case 'truck':
      return 3.45;
    case 'bus':
      return 4.65;
    default:
      return 0.5;
  }
}

function getActorHalfWidth(kind: TargetKind): number {
  switch (kind) {
    case 'bike':
      return 0.35;
    case 'motorcycle':
      return 0.45;
    case 'sedan':
      return 0.95;
    case 'van':
      return 1.05;
    case 'truck':
      return 1.18;
    case 'bus':
      return 1.22;
    default:
      return 0.85;
  }
}

function getActorBaseSpeed(kind: TargetKind, rotY: number): number {
  switch (kind) {
    case 'pedestrian':
      return 1.55;
    case 'bike':
      return 3.9;
    case 'motorcycle':
      return 14.5;
    case 'sedan':
      return Math.cos(rotY) >= 0 ? 12.2 : 13.4;
    case 'van':
      return 11.0;
    case 'truck':
      return 9.5;
    case 'bus':
      return 9.0;
    default:
      return 0;
  }
}

const ROAD_PORT_DIMS: Partial<Record<TargetKind, { halfL: number; halfW: number }>> = {
  'road-2lane': { halfL: 4.0, halfW: 4.5 },
  'road-intersection': { halfL: 4.5, halfW: 4.5 },
  'road-t-junction': { halfL: 4.5, halfW: 4.5 },
  'road-turn-90': { halfL: 6.0, halfW: 6.0 },
  'road-curve-45': { halfL: 7.5, halfW: 5.5 },
  'road-crosswalk': { halfL: 3.0, halfW: 4.5 },
  'road-roundabout': { halfL: 10.0, halfW: 10.0 },
  'road-culdesac': { halfL: 6.0, halfW: 6.0 },
  'road-deadend': { halfL: 6.0, halfW: 6.0 },
  'path-sidewalk': { halfL: 4.0, halfW: 1.5 },
  'path-bike': { halfL: 4.0, halfW: 1.2 },
  'path-cobble': { halfL: 3.0, halfW: 3.0 },
  'path-gravel': { halfL: 4.0, halfW: 1.1 },
};

interface SegmentPort {
  ox: number;
  oz: number;
  nx: number;
  nz: number;
}

function getSegmentLocalPorts(
  kind: TargetKind,
  rotY: number,
  length?: number,
): SegmentPort[] {
  const dims = ROAD_PORT_DIMS[kind];
  if (!dims) return [];
  const cos = Math.cos(rotY);
  const sin = Math.sin(rotY);
  const halfL = kind === 'road-2lane' && length && length > 0 ? length * 0.5 : dims.halfL;

  let raw: Array<[number, number, number, number]>;
  if (kind === 'road-t-junction') {
    raw = [
      [4.5, 0, 1, 0],
      [-4.5, 0, -1, 0],
      [0, 4.5, 0, 1],
    ];
  } else if (kind === 'road-turn-90') {
    raw = [
      [-6.0, 0, -1, 0],
      [0, 6.0, 0, 1],
    ];
  } else if (kind === 'road-curve-45') {
    raw = [
      [-4.95, -2.05, -1, 0],
      [4.95, 2.05, Math.SQRT1_2, Math.SQRT1_2],
    ];
  } else if (kind === 'road-deadend') {
    raw = [[-6.0, 0, -1, 0]];
  } else {
    raw = [
      [halfL, 0, 1, 0],
      [-halfL, 0, -1, 0],
      [0, dims.halfW, 0, 1],
      [0, -dims.halfW, 0, -1],
    ];
  }

  return raw.map(([lx, lz, lnx, lnz]) => ({
    ox: lx * cos + lz * sin,
    oz: -lx * sin + lz * cos,
    nx: lnx * cos + lnz * sin,
    nz: -lnx * sin + lnz * cos,
  }));
}

interface RoadSpatialEntry {
  target: StreetTarget;
  cos: number;
  sin: number;
  maxRadiusSq: number;
  armMask?: number;
  hiddenSet: Set<string>;
}

function getRoundaboutArmMask(rbTarget: StreetTarget, allTargets: StreetTarget[]): number {
  const cos = Math.cos(rbTarget.rotationY);
  const sin = Math.sin(rbTarget.rotationY);
  const armSpecs: Array<[number, number, number, number, number]> = [
    [1, 10, 0, 1, 0],
    [2, 0, -10, 0, -1],
    [4, -10, 0, -1, 0],
    [8, 0, 10, 0, 1],
  ];

  let mask = 0;
  let connectedCount = 0;

  for (const [bit, lx, lz, lnx, lnz] of armSpecs) {
    const px = rbTarget.position.x + lx * cos + lz * sin;
    const pz = rbTarget.position.z - lx * sin + lz * cos;
    const nx = lnx * cos + lnz * sin;
    const nz = -lnx * sin + lnz * cos;

    let connected = false;
    for (const other of allTargets) {
      if (other.id === rbTarget.id || !ROAD_PORT_DIMS[other.kind]) continue;
      const otherPorts = getSegmentLocalPorts(other.kind, other.rotationY, other.length);
      for (const tp of otherPorts) {
        if (tp.nx * nx + tp.nz * nz > -0.7) continue;
        const ox = other.position.x + tp.ox;
        const oz = other.position.z + tp.oz;
        if (Math.hypot(ox - px, oz - pz) <= 0.65) {
          connected = true;
          break;
        }
      }
      if (connected) break;
    }

    if (connected) {
      mask |= bit;
      connectedCount++;
    }
  }

  return connectedCount >= 2 ? mask : 15;
}

function getRoadSpatialRadius(kind: TargetKind, length?: number): number {
  switch (kind) {
    case 'road-2lane':
      return Math.hypot((length && length > 0 ? length * 0.5 : 4.0) + 1.0, 7.5) + 1.5;
    case 'road-roundabout':
      return 15.0;
    case 'road-curve-45':
      return 18.0;
    case 'road-turn-90':
      return 15.0;
    case 'road-deadend':
    case 'road-culdesac':
      return 11.5;
    default:
      return 10.5;
  }
}

function toRoadLocal(
  wx: number,
  wz: number,
  entry: RoadSpatialEntry,
): { lx: number; lz: number } {
  const dx = wx - entry.target.position.x;
  const dz = wz - entry.target.position.z;
  return {
    lx: dx * entry.cos - dz * entry.sin,
    lz: dx * entry.sin + dz * entry.cos,
  };
}

function isPointInsideRoadTargetLocal(
  kind: TargetKind,
  lx: number,
  lz: number,
  armMask = 15,
  length?: number,
): boolean {
  switch (kind) {
    case 'road-2lane': {
      const halfL = length && length > 0 ? length * 0.5 : 4.0;
      return Math.abs(lx) <= halfL + 0.04 && Math.abs(lz) <= 4.54;
    }
    case 'road-intersection':
      return (
        (Math.abs(lx) <= 4.54 && Math.abs(lz) <= 4.54) ||
        (Math.abs(lx) <= 4.44 && Math.abs(lz) <= 7.92) ||
        (Math.abs(lz) <= 4.44 && Math.abs(lx) <= 7.92)
      );
    case 'road-t-junction':
      return Math.abs(lx) <= 4.54 && Math.abs(lz) <= 4.54;
    case 'road-crosswalk':
      return Math.abs(lx) <= 3.04 && Math.abs(lz) <= 4.54;
    case 'road-turn-90': {
      if (lx < -6.04 || lz > 6.04) return false;
      const r = Math.hypot(lx + 6, lz - 6);
      return r >= 1.46 && r <= 10.54;
    }
    case 'road-curve-45': {
      const dx = lx + 4.95;
      const dz = -(lz - 11.95);
      const r = Math.hypot(dx, dz);
      if (r < 9.46 || r > 18.54) return false;
      const ang = Math.atan2(dz, dx);
      return ang >= Math.PI / 4 - 0.02 && ang <= Math.PI / 2 + 0.02;
    }
    case 'road-roundabout':
      if (Math.hypot(lx, lz) <= 9.68) return true;
      if ((armMask & 1) !== 0 && lx >= 0 && lx <= 10.04 && Math.abs(lz) <= 4.54) return true;
      if ((armMask & 2) !== 0 && lz <= 0 && lz >= -10.04 && Math.abs(lx) <= 4.54) return true;
      if ((armMask & 4) !== 0 && lx <= 0 && lx >= -10.04 && Math.abs(lz) <= 4.54) return true;
      if ((armMask & 8) !== 0 && lz >= 0 && lz <= 10.04 && Math.abs(lx) <= 4.54) return true;
      return false;
    case 'road-culdesac':
      return Math.hypot(lx, lz) <= 6.06;
    case 'road-deadend':
      return (
        Math.hypot(lx, lz) <= 6.06 ||
        (lx >= -6.04 && lx <= 0 && Math.abs(lz) <= 4.54)
      );
    default:
      return false;
  }
}

function getSidewalkPartKeyLocal(
  kind: TargetKind,
  lx: number,
  lz: number,
  armMask = 15,
  length?: number,
): string | null {
  const ax = Math.abs(lx);
  const az = Math.abs(lz);
  switch (kind) {
    case 'road-2lane': {
      const halfL = length && length > 0 ? length * 0.5 : 4.0;
      if (ax > halfL || az < 4.74 || az > 7.24) return null;
      return lz < 0 ? 'north' : 'south';
    }
    case 'road-crosswalk':
      if (ax > 3.0 || az < 4.74 || az > 7.24) return null;
      return lz < 0 ? 'north' : 'south';
    case 'road-intersection':
      if (ax >= 4.5 && ax <= 7.24 && az >= 4.5 && az <= 7.24 && !(ax < 4.74 && az < 4.74)) {
        return `${lz < 0 ? 'n' : 's'}${lx < 0 ? 'w' : 'e'}`;
      }
      return null;
    case 'road-t-junction':
      if (ax <= 4.5 && lz >= -7.24 && lz <= -4.74) return 'back';
      if (ax >= 4.5 && ax <= 7.24 && lz >= 4.5 && lz <= 7.24 && !(ax < 4.74 && lz < 4.74)) {
        return lx < 0 ? 'sw' : 'se';
      }
      return null;
    case 'road-turn-90': {
      if (lx < -6.0 || lz > 6.0) return null;
      const r = Math.hypot(lx + 6, lz - 6);
      if (r >= 10.74 && r <= 13.24) return 'outer';
      if (r <= 1.26) return 'inner';
      return null;
    }
    case 'road-curve-45': {
      const dx = lx + 4.95;
      const dz = -(lz - 11.95);
      const r = Math.hypot(dx, dz);
      const ang = Math.atan2(dz, dx);
      if (ang < Math.PI / 4 || ang > Math.PI / 2) return null;
      if (r >= 6.76 && r <= 9.26) return 'inner';
      if (r >= 18.74 && r <= 21.24) return 'outer';
      return null;
    }
    case 'road-roundabout': {
      const r = Math.hypot(lx, lz);
      if (r < 9.85 || r > 12.35) return null;
      const openE = (armMask & 1) !== 0;
      const openN = (armMask & 2) !== 0;
      const openW = (armMask & 4) !== 0;
      const openS = (armMask & 8) !== 0;
      if (az < 4.74) {
        if (lx > 0) return openE ? null : 'cap-E';
        if (lx < 0) return openW ? null : 'cap-W';
        return null;
      }
      if (ax < 4.74) {
        if (lz < 0) return openN ? null : 'cap-N';
        if (lz > 0) return openS ? null : 'cap-S';
        return null;
      }
      if ((lx > 10.0 && openE) || (lx < -10.0 && openW)) return null;
      if ((lz < -10.0 && openN) || (lz > 10.0 && openS)) return null;
      return `${lz < 0 ? 'n' : 's'}${lx < 0 ? 'w' : 'e'}`;
    }
    case 'road-culdesac': {
      const r = Math.hypot(lx, lz);
      return r >= 6.19 && r <= 8.69 ? 'ring' : null;
    }
    case 'road-deadend': {
      if (lx >= -6.0 && lx <= -3.96 && az >= 4.74 && az <= 7.24) return 'ring';
      if (lx < -3.96) return null;
      const r = Math.hypot(lx, lz);
      if (r < 6.18 || r > 8.68) return null;
      const thetaNeck = Math.asin(4.74 / 6.18);
      return Math.abs(Math.atan2(lz, lx)) <= Math.PI - thetaNeck + 0.01 ? 'ring' : null;
    }
    default:
      return null;
  }
}

function isPointInsideTargetSidewalkLocal(
  kind: TargetKind,
  lx: number,
  lz: number,
  armMask = 15,
  length?: number,
  hiddenSet?: Set<string>,
): boolean {
  const partKey = getSidewalkPartKeyLocal(kind, lx, lz, armMask, length);
  if (!partKey) return false;
  return !hiddenSet || !hiddenSet.has(partKey);
}

function isPointInsideAnyRoadway(
  wx: number,
  wz: number,
  roadEntries: RoadSpatialEntry[],
): boolean {
  for (let i = 0; i < roadEntries.length; i++) {
    const entry = roadEntries[i];
    const dx = wx - entry.target.position.x;
    const dz = wz - entry.target.position.z;
    if (dx * dx + dz * dz > entry.maxRadiusSq) continue;
    const { lx, lz } = toRoadLocal(wx, wz, entry);
    if (
      isPointInsideRoadTargetLocal(
        entry.target.kind,
        lx,
        lz,
        entry.armMask,
        entry.target.length,
      )
    ) {
      return true;
    }
  }
  return false;
}

function isPointInsideAnyParkingDriveway(
  wx: number,
  wz: number,
  targets: StreetTarget[],
): boolean {
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    if (t.kind !== 'parking-lot') continue;
    const dx = wx - t.position.x;
    const dz = wz - t.position.z;
    if (dx * dx + dz * dz > 90) continue;
    const cos = Math.cos(t.rotationY);
    const sin = Math.sin(t.rotationY);
    const lx = dx * cos - dz * sin;
    const lz = dx * sin + dz * cos;
    if (Math.abs(lx) <= 2.12 && lz >= 4.45 && lz <= 8.0) {
      return true;
    }
  }
  return false;
}

function formatCompassSideLabel(dx: number, dz: number, roadLabel: string): string {
  if (Math.hypot(dx, dz) < 0.25) return `Sidewalk · ${roadLabel}`;
  const angle = Math.atan2(dz, dx); // +X=0 (East), +Z=PI/2 (South), -X=PI (West), -Z=-PI/2 (North)
  const dirs = ['East', 'SE', 'South', 'SW', 'West', 'NW', 'North', 'NE'];
  const idx = ((Math.round((angle / (Math.PI * 2)) * 8) % 8) + 8) % 8;
  return `${dirs[idx]} Sidewalk · ${roadLabel}`;
}

function detectSoftwareGl(): boolean {
  try {
    const probeCanvas = document.createElement('canvas');
    const gl = probeCanvas.getContext('webgl2');
    if (!gl) return true;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const param = ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER;
    const gpu = String(gl.getParameter(param) || '');
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(gpu);
  } catch {
    return true;
  }
}

export class StreetSimulatorScene {
  private container: HTMLElement;
  private callbacks: SceneCallbacks;
  private isSoftwareGl: boolean;
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;

  private hemiLight: THREE.HemisphereLight;
  private moonLight: THREE.DirectionalLight;
  private gridHelper: THREE.GridHelper;
  private luxOverlayState: LuxOverlayUniformState;
  private cursorProbeMesh: THREE.Mesh;

  private lightEntries = new Map<string, LightRigEntry>();
  private targetGroups = new Map<string, THREE.Group>();
  private animatedActors = new Map<string, AnimatedActorState>();
  private contactShadowTex: THREE.CanvasTexture;
  private asphaltTex: THREE.CanvasTexture;
  private sidewalkTex: THREE.CanvasTexture;
  private curbMat: THREE.MeshStandardMaterial;
  private sidewalkMat: THREE.MeshStandardMaterial;
  private selectedSidewalkMat: THREE.MeshStandardMaterial;
  private sidewalkGroup = new THREE.Group();
  private sidewalkMeshes: THREE.Mesh[] = [];
  private baseGroundMeshes: THREE.Object3D[] = [];
  private modularRoadEntries: RoadSpatialEntry[] = [];
  private roundaboutEntries: Array<{
    idx: number;
    entry: RoadSpatialEntry;
    isMini: boolean;
    ringZoneR: number;
    yieldLineR: number;
    approachMaxR: number;
  }> = [];
  private intersectionEntries: Array<{ x: number; z: number; stopBarDist: number }> = [];
  private roadGraph: RoadLaneGraph = { nodes: [], edges: [] };
  private walkGraph: WalkGraph = { nodes: [], edges: [] };
  private trafficControllers: TrafficController[] = [];
  private trafficSignalClock = 0;
  private simElapsedSeconds = 0;
  private nextParkingEventTimer = 600 + Math.random() * 300;
  private lastRoadSignature = '__init__';

  private raycaster = new THREE.Raycaster();
  private pickables: THREE.Object3D[] = [];
  private groundPickMeshes: THREE.Object3D[] = [];
  private lastGroundCursorHit: THREE.Vector3 | null = null;
  private lastCursorProbePoint: { x: number; y: number; z: number } | null = null;

  private currentFixtures: LightFixture[] = [];
  private currentTargets: StreetTarget[] = [];
  private vehicleTargets: StreetTarget[] = [];
  private pedestrianTargets: StreetTarget[] = [];
  private prevFixturesProp: LightFixture[] | null = null;
  private prevTargetsProp: StreetTarget[] | null = null;
  private prevSelectedFixtureId: string | null = null;
  private prevSelectedTargetId: string | null = null;
  private prevShowBeamEnvelope: boolean | null = null;
  private prevAmbientMode: AmbientMode | null = null;
  private prevShowLuxHeatmap: boolean | null = null;
  private prevLuxThreshold: number | null = null;
  private currentLuxThreshold = 2.0;
  private pickablesDirty = true;

  private lastPhotometricsKey = '';
  private cachedPhotometrics: {
    peakGroundLux: number;
    footprintAreaSqM: number;
    centerThrowDistM: number | null;
  } = {
    peakGroundLux: 0,
    footprintAreaSqM: 0,
    centerThrowDistM: null,
  };
  private lastEmittedStatsKey = '';

  private selectedFixtureId: string | null = null;
  private selectedTargetId: string | null = null;
  private selectedSidewalkKey: string | null = null;
  private pendingSidewalkClick: SelectedSidewalkInfo | null = null;
  private draggingTargetId: string | null = null;
  private draggingFixtureId: string | null = null;
  private pointerDownHitPickable = false;
  private dragOffset = new THREE.Vector2();
  private lastHoverProbeTime = 0;
  private lastPointerClient: { x: number; y: number } | null = null;
  private builderTool: BuilderTool = null;
  private builderRotationY = 0;
  private builderGhostGroup: THREE.Group | null = null;
  private dragPreviewTool: BuilderTool = null;
  private dragGhostGroup: THREE.Group | null = null;
  private pointerDownClient = { x: 0, y: 0, button: -1 };
  private controlsConfig: InputControlsConfig = {
    ...DEFAULT_INPUT_CONTROLS,
    keybinds: { ...DEFAULT_INPUT_CONTROLS.keybinds },
  };

  // Smooth camera transition state
  private cameraTransition: {
    active: boolean;
    targetPos: THREE.Vector3;
    targetLookAt: THREE.Vector3;
  } = {
    active: false,
    targetPos: new THREE.Vector3(),
    targetLookAt: new THREE.Vector3(),
  };

  // Coalesced on-demand rendering state
  private frameId = 0;
  private renderBusy = false;
  private renderDirty = false;
  private lastTickTime = performance.now();
  private disposed = false;
  private pressedKeys = new Set<string>();
  private cameraControlMode: CameraControlMode = 'orbit';
  private isFreeLooking = false;
  private isFreePanning = false;
  private lastLookPointer = { x: 0, y: 0 };
  private freeYaw = 0;
  private freePitch = 0;
  private savedOrbitDistance = 18;
  private orbitGroundLift = 0;

  constructor(container: HTMLElement, callbacks: SceneCallbacks) {
    this.container = container;
    this.callbacks = callbacks;
    this.isSoftwareGl = detectSoftwareGl();

    this.renderer = new THREE.WebGLRenderer({
      antialias: !this.isSoftwareGl,
      powerPreference: 'high-performance',
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;
    this.renderer.setPixelRatio(this.isSoftwareGl ? 1 : Math.min(window.devicePixelRatio, 1.5));
    this.renderer.shadowMap.enabled = !this.isSoftwareGl;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    const rect = container.getBoundingClientRect();
    const width = Math.max(rect.width, 320);
    const height = Math.max(rect.height, 240);
    this.renderer.setSize(width, height);
    this.renderer.domElement.style.display = 'block';
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x070a12);
    this.scene.fog = new THREE.FogExp2(0x070a12, 0.0075);

    // Procedural Studio Environment Map for metallic & clearcoat reflections
    const pmremGenerator = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmremGenerator.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.25;
    pmremGenerator.dispose();

    this.camera = new THREE.PerspectiveCamera(46, width / height, 0.1, 420);
    this.camera.position.set(16.5, 12.5, 21.5);
    this.camera.layers.mask = (1 << 0) | (1 << 2);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 1.5, 0);
    this.controls.enableDamping = !this.isSoftwareGl;
    this.controls.dampingFactor = 0.07;
    this.controls.enablePan = true;
    this.controls.screenSpacePanning = false;
    this.controls.panSpeed = 1.35;
    this.controls.maxPolarAngle = Math.PI * 0.94;
    this.controls.minDistance = 0.6;
    this.controls.maxDistance = 150.0;
    this.controls.mouseButtons.LEFT = THREE.MOUSE.PAN;
    this.controls.mouseButtons.RIGHT = THREE.MOUSE.ROTATE;
    this.controls.touches.ONE = THREE.TOUCH.ROTATE;
    this.camera.lookAt(this.controls.target);
    this.applyControlsConfig();
    this.setCameraControlMode('pan');

    this.controls.addEventListener('start', () => {
      // Cancel scripted camera glide immediately on user drag
      this.cameraTransition.active = false;
    });
    this.controls.addEventListener('change', () => {
      this.enforceOrbitGroundClearance();
      if (this.lastPointerClient) {
        this.updateCursorProbe(false);
      }
      this.requestRender();
    });

    // Ambient sky hemisphere + directional sun/moon key
    this.hemiLight = new THREE.HemisphereLight(0x385178, 0x10141c, 0.42);
    this.scene.add(this.hemiLight);

    this.moonLight = new THREE.DirectionalLight(0x9ab8e8, 0.26);
    this.moonLight.position.set(-16, 22, 14);
    this.moonLight.castShadow = false;
    this.moonLight.shadow.mapSize.set(1024, 1024);
    this.moonLight.shadow.camera.near = 1;
    this.moonLight.shadow.camera.far = 140;
    this.moonLight.shadow.camera.left = -48;
    this.moonLight.shadow.camera.right = 48;
    this.moonLight.shadow.camera.top = 48;
    this.moonLight.shadow.camera.bottom = -48;
    this.moonLight.shadow.bias = -0.0007;
    this.moonLight.shadow.normalBias = 0.03;
    this.scene.add(this.moonLight);

    // Procedural textures & shared sidewalk materials
    const maxAniso = this.renderer.capabilities.getMaxAnisotropy();
    this.asphaltTex = createAsphaltTexture(maxAniso);
    this.sidewalkTex = createSidewalkTexture(maxAniso);
    this.sidewalkTex.repeat.set(1, 1);
    this.contactShadowTex = createContactShadowTexture();

    this.luxOverlayState = createLuxOverlayUniformState();

    this.curbMat = new THREE.MeshStandardMaterial({
      color: 0x475569,
      roughness: 0.78,
      metalness: 0.04,
    });
    this.sidewalkMat = new THREE.MeshStandardMaterial({
      map: this.sidewalkTex,
      roughness: 0.88,
      metalness: 0.02,
    });
    this.selectedSidewalkMat = new THREE.MeshStandardMaterial({
      map: this.sidewalkTex,
      color: 0x99f6e4,
      emissive: 0x0891b2,
      emissiveIntensity: 0.45,
      roughness: 0.84,
      metalness: 0.04,
    });
    attachLuxOverlayToMaterial(this.curbMat, this.luxOverlayState);
    attachLuxOverlayToMaterial(this.sidewalkMat, this.luxOverlayState);
    attachLuxOverlayToMaterial(this.selectedSidewalkMat, this.luxOverlayState);

    this.buildStreetEnvironment();

    // Coordinate reference grid (2m cells across 128m x 128m)
    this.gridHelper = new THREE.GridHelper(128, 64, 0x334155, 0x1e293b);
    this.gridHelper.position.y = 0.018;
    const gridMats = Array.isArray(this.gridHelper.material)
      ? this.gridHelper.material
      : [this.gridHelper.material];
    for (const m of gridMats) {
      m.transparent = true;
      m.opacity = 0.4;
      m.depthWrite = false;
    }
    this.scene.add(this.gridHelper);

    // Live cursor lux probe reticle (always rendered visibly on top of all surfaces on Layer 2)
    this.cursorProbeMesh = new THREE.Mesh(
      new THREE.RingGeometry(0.17, 0.25, 28),
      new THREE.MeshBasicMaterial({
        color: 0x06b6d4,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.92,
        depthTest: false,
        depthWrite: false,
        fog: false,
      }),
    );
    this.cursorProbeMesh.rotation.x = -Math.PI / 2;
    this.cursorProbeMesh.position.set(0, 0.05, 0);
    this.cursorProbeMesh.renderOrder = 999;
    this.cursorProbeMesh.layers.set(2);

    const cursorCenterDot = new THREE.Mesh(
      new THREE.CircleGeometry(0.095, 24),
      new THREE.MeshBasicMaterial({
        color: 0x38bdf8,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.98,
        depthTest: false,
        depthWrite: false,
        fog: false,
      }),
    );
    cursorCenterDot.renderOrder = 1000;
    cursorCenterDot.layers.set(2);
    this.cursorProbeMesh.add(cursorCenterDot);
    this.cursorProbeMesh.visible = false;
    this.scene.add(this.cursorProbeMesh);

    this.bindEvents();

    if (!this.isSoftwareGl) {
      this.renderer.compile(this.scene, this.camera);
    }
    this.requestRender();
  }

  private buildStreetEnvironment(): void {
    // Extended dark earth base beyond corridor
    const terrainMat = new THREE.MeshStandardMaterial({
      color: 0x0b0f17,
      roughness: 0.95,
      metalness: 0.0,
    });
    attachLuxOverlayToMaterial(terrainMat, this.luxOverlayState);
    const terrain = new THREE.Mesh(new THREE.PlaneGeometry(320, 320), terrainMat);
    terrain.rotation.x = -Math.PI / 2;
    terrain.position.y = -0.02;
    terrain.receiveShadow = true;
    this.scene.add(terrain);
    this.baseGroundMeshes.push(terrain);

    this.scene.add(this.sidewalkGroup);
    this.rebuildSidewalks([]);
  }

  private buildSidewalkPartGeometry(
    entry: RoadSpatialEntry,
    ownerIdx: number,
    roadEntries: RoadSpatialEntry[],
    allTargets: StreetTarget[],
    patches: Array<{
      uVals: number[];
      vVals: number[];
      localPoint: (u: number, v: number) => [number, number];
    }>,
  ): { geometry: THREE.BufferGeometry; centerX: number; centerZ: number } {
    const positions: number[] = [];
    const normals: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];
    const uScale = 36 / (MAP_HALF_X * 2);
    const vScale = 3 / 6.2;
    const topY = 0.12;
    let sumX = 0;
    let sumZ = 0;
    let activeCount = 0;

    const pushTopQuad = (
      x0: number,
      z0: number,
      x1: number,
      z1: number,
      x2: number,
      z2: number,
      x3: number,
      z3: number,
    ) => {
      const base = positions.length / 3;
      const pts: [number, number][] = [
        [x0, z0],
        [x1, z1],
        [x2, z2],
        [x3, z3],
      ];
      for (const [wx, wz] of pts) {
        positions.push(wx, topY, wz);
        normals.push(0, 1, 0);
        uvs.push((wx + MAP_HALF_X) * uScale, (wz - 4.76) * vScale);
      }
      const crossY = (z1 - z0) * (x2 - x0) - (x1 - x0) * (z2 - z0);
      if (crossY >= 0) {
        indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
      } else {
        indices.push(base, base + 2, base + 1, base, base + 3, base + 2);
      }
    };

    const pushSkirtQuad = (
      ax: number,
      az: number,
      bx: number,
      bz: number,
      insideX: number,
      insideZ: number,
    ) => {
      const len = Math.hypot(bx - ax, bz - az);
      if (len < 1e-4) return;
      const mx = (ax + bx) * 0.5;
      const mz = (az + bz) * 0.5;
      let p0x = ax;
      let p0z = az;
      let p1x = bx;
      let p1z = bz;
      const nx = bz - az;
      const nz = -(bx - ax);
      if (nx * (insideX - mx) + nz * (insideZ - mz) > 0) {
        p0x = bx;
        p0z = bz;
        p1x = ax;
        p1z = az;
      }
      const unx = (p1z - p0z) / len;
      const unz = -(p1x - p0x) / len;
      const base = positions.length / 3;
      positions.push(
        p0x, topY, p0z,
        p1x, topY, p1z,
        p1x, 0, p1z,
        p0x, 0, p0z,
      );
      for (let k = 0; k < 4; k++) normals.push(unx, 0, unz);
      uvs.push(0, 0.1, len * uScale, 0.1, len * uScale, 0, 0, 0);
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    };

    const isClaimedEarlier = (wx: number, wz: number): boolean => {
      for (let k = 0; k < ownerIdx; k++) {
        const prev = roadEntries[k];
        const dx = wx - prev.target.position.x;
        const dz = wz - prev.target.position.z;
        if (dx * dx + dz * dz > prev.maxRadiusSq) continue;
        const { lx, lz } = toRoadLocal(wx, wz, prev);
        if (
          isPointInsideTargetSidewalkLocal(
            prev.target.kind,
            lx,
            lz,
            prev.armMask,
            prev.target.length,
            prev.hiddenSet,
          )
        ) {
          return true;
        }
      }
      return false;
    };

    const tx = entry.target.position.x;
    const tz = entry.target.position.z;
    const cos = entry.cos;
    const sin = entry.sin;

    for (const { uVals, vVals, localPoint } of patches) {
      const cols = uVals.length - 1;
      const rows = vVals.length - 1;

      const gridX = new Float32Array((cols + 1) * (rows + 1));
      const gridZ = new Float32Array((cols + 1) * (rows + 1));
      for (let i = 0; i <= cols; i++) {
        for (let j = 0; j <= rows; j++) {
          const [lx, lz] = localPoint(uVals[i], vVals[j]);
          const idx = i * (rows + 1) + j;
          gridX[idx] = tx + lx * cos + lz * sin;
          gridZ[idx] = tz - lx * sin + lz * cos;
        }
      }

      const active = new Uint8Array(cols * rows);
      const cellCenterX = new Float32Array(cols * rows);
      const cellCenterZ = new Float32Array(cols * rows);

      for (let i = 0; i < cols; i++) {
        for (let j = 0; j < rows; j++) {
          const uMid = (uVals[i] + uVals[i + 1]) * 0.5;
          const vMid = (vVals[j] + vVals[j + 1]) * 0.5;
          const [lx, lz] = localPoint(uMid, vMid);
          const cx = tx + lx * cos + lz * sin;
          const cz = tz - lx * sin + lz * cos;
          const cIdx = i * rows + j;
          cellCenterX[cIdx] = cx;
          cellCenterZ[cIdx] = cz;

          if (Math.abs(cx) > MAP_HALF_X + 1.5 || Math.abs(cz) > MAP_HALF_Z + 1.5) continue;
          if (isPointInsideAnyRoadway(cx, cz, roadEntries)) continue;
          if (isPointInsideAnyParkingDriveway(cx, cz, allTargets)) continue;
          if (isClaimedEarlier(cx, cz)) continue;
          active[cIdx] = 1;
          sumX += cx;
          sumZ += cz;
          activeCount++;
        }
      }

      for (let i = 0; i < cols; i++) {
        for (let j = 0; j < rows; j++) {
          const cIdx = i * rows + j;
          if (!active[cIdx]) continue;
          const p00 = i * (rows + 1) + j;
          const p10 = (i + 1) * (rows + 1) + j;
          const p11 = (i + 1) * (rows + 1) + (j + 1);
          const p01 = i * (rows + 1) + (j + 1);

          const x00 = gridX[p00];
          const z00 = gridZ[p00];
          const x10 = gridX[p10];
          const z10 = gridZ[p10];
          const x11 = gridX[p11];
          const z11 = gridZ[p11];
          const x01 = gridX[p01];
          const z01 = gridZ[p01];

          pushTopQuad(x00, z00, x10, z10, x11, z11, x01, z01);

          const cx = cellCenterX[cIdx];
          const cz = cellCenterZ[cIdx];
          if (i === 0 || !active[(i - 1) * rows + j]) pushSkirtQuad(x00, z00, x01, z01, cx, cz);
          if (i === cols - 1 || !active[(i + 1) * rows + j]) pushSkirtQuad(x10, z10, x11, z11, cx, cz);
          if (j === 0 || !active[i * rows + (j - 1)]) pushSkirtQuad(x00, z00, x10, z10, cx, cz);
          if (j === rows - 1 || !active[i * rows + (j + 1)]) pushSkirtQuad(x01, z01, x11, z11, cx, cz);
        }
      }
    }

    const geo = new THREE.BufferGeometry();
    if (indices.length > 0) {
      geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
      geo.setIndex(indices);
      geo.computeBoundingSphere();
    }
    return {
      geometry: geo,
      centerX: activeCount > 0 ? sumX / activeCount : tx,
      centerZ: activeCount > 0 ? sumZ / activeCount : tz,
    };
  }

  private rebuildSidewalks(targets: StreetTarget[]): void {
    const roadEntries: RoadSpatialEntry[] = [];
    for (const t of targets) {
      if (!t.kind.startsWith('road-')) continue;
      const r = getRoadSpatialRadius(t.kind, t.length);
      const armMask = t.kind === 'road-roundabout' ? getRoundaboutArmMask(t, targets) : undefined;
      roadEntries.push({
        target: t,
        cos: Math.cos(t.rotationY),
        sin: Math.sin(t.rotationY),
        maxRadiusSq: r * r,
        armMask,
        hiddenSet: new Set(t.hiddenSidewalks ?? []),
      });
    }

    for (const child of [...this.sidewalkGroup.children]) {
      this.sidewalkGroup.remove(child);
      const mesh = child as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
    }
    this.sidewalkMeshes = [];
    this.modularRoadEntries = roadEntries;
    this.roundaboutEntries = [];
    this.intersectionEntries = [];
    for (let i = 0; i < roadEntries.length; i++) {
      const entry = roadEntries[i];
      if (entry.target.kind === 'road-roundabout' || entry.target.kind === 'road-culdesac') {
        const isMini = entry.target.kind === 'road-culdesac';
        this.roundaboutEntries.push({
          idx: i,
          entry,
          isMini,
          ringZoneR: isMini ? 5.25 : 8.55,
          yieldLineR: isMini ? 6.25 : 10.1,
          approachMaxR: isMini ? 16.0 : 23.5,
        });
      } else if (
        entry.target.kind === 'road-intersection' ||
        entry.target.kind === 'road-t-junction'
      ) {
        this.intersectionEntries.push({
          x: entry.target.position.x,
          z: entry.target.position.z,
          stopBarDist: entry.target.kind === 'road-t-junction' ? 3.05 : 7.72,
        });
      }
    }
    this.roadGraph = buildRoadLaneGraph(roadEntries);
    this.walkGraph = buildWalkGraph(roadEntries, targets);
    this.pickablesDirty = true;
    for (const actor of this.animatedActors.values()) {
      if (actor.motion === 'drive') {
        if (
          actor.parkingPhase === 'entering-lot' ||
          actor.parkingPhase === 'parked' ||
          actor.parkingPhase === 'reversing-out'
        ) {
          continue;
        }
        this.clearActorParkingState(actor);
        actor.graphNodeId = undefined;
        actor.subPath = undefined;
        actor.subPathIdx = 0;
        actor.roundaboutSteps = 0;
      } else if (actor.motion === 'walk') {
        this.initPedestrianWalk(actor);
      }
    }

    const nextPickMeshes: THREE.Object3D[] = [...this.baseGroundMeshes];
    if (roadEntries.length === 0) {
      this.groundPickMeshes = nextPickMeshes;
      return;
    }

    const lin = (a: number, b: number, segs: number): number[] => {
      const arr: number[] = [];
      for (let i = 0; i <= segs; i++) arr.push(a + ((b - a) * i) / segs);
      return arr;
    };

    const mergeSortedAngles = (a: number, b: number, baseSegs: number, critical: number[]): number[] => {
      const set = new Set<number>(lin(a, b, baseSegs));
      for (const c of critical) {
        if (c > a + 1e-4 && c < b - 1e-4) set.add(c);
      }
      return Array.from(set).sort((x, y) => x - y);
    };

    const emitSidewalkPart = (
      entry: RoadSpatialEntry,
      ownerIdx: number,
      partKey: string,
      patches: Array<{
        uVals: number[];
        vVals: number[];
        localPoint: (u: number, v: number) => [number, number];
      }>,
    ) => {
      if (entry.hiddenSet.has(partKey)) return;
      const { geometry, centerX, centerZ } = this.buildSidewalkPartGeometry(
        entry,
        ownerIdx,
        roadEntries,
        targets,
        patches,
      );
      if (!geometry.index || geometry.index.count === 0) {
        geometry.dispose();
        return;
      }

      const key = `${entry.target.id}::${partKey}`;
      const info: SelectedSidewalkInfo = {
        key,
        targetId: entry.target.id,
        partKey,
        label: formatCompassSideLabel(
          centerX - entry.target.position.x,
          centerZ - entry.target.position.z,
          entry.target.label,
        ),
        position: {
          x: Math.round(centerX * 10) / 10,
          z: Math.round(centerZ * 10) / 10,
        },
      };
      const mesh = new THREE.Mesh(
        geometry,
        key === this.selectedSidewalkKey ? this.selectedSidewalkMat : this.sidewalkMat,
      );
      mesh.receiveShadow = true;
      mesh.userData.selectSidewalkKey = key;
      mesh.userData.sidewalkInfo = info;
      mesh.layers.enable(1);

      this.sidewalkGroup.add(mesh);
      this.sidewalkMeshes.push(mesh);
      nextPickMeshes.push(mesh);
    };

    for (let idx = 0; idx < roadEntries.length; idx++) {
      const entry = roadEntries[idx];
      const kind = entry.target.kind;

      if (kind === 'road-2lane') {
        const halfL =
          entry.target.length && entry.target.length > 0 ? entry.target.length * 0.5 : 4.0;
        const uSegs = Math.max(8, Math.round(halfL * 4));
        emitSidewalkPart(entry, idx, 'north', [
          { uVals: lin(-halfL, halfL, uSegs), vVals: lin(-7.24, -4.74, 4), localPoint: (lx, lz) => [lx, lz] },
        ]);
        emitSidewalkPart(entry, idx, 'south', [
          { uVals: lin(-halfL, halfL, uSegs), vVals: lin(4.74, 7.24, 4), localPoint: (lx, lz) => [lx, lz] },
        ]);
      } else if (kind === 'road-crosswalk') {
        emitSidewalkPart(entry, idx, 'north', [
          { uVals: lin(-3, 3, 12), vVals: lin(-7.24, -4.74, 4), localPoint: (lx, lz) => [lx, lz] },
        ]);
        emitSidewalkPart(entry, idx, 'south', [
          { uVals: lin(-3, 3, 12), vVals: lin(4.74, 7.24, 4), localPoint: (lx, lz) => [lx, lz] },
        ]);
      } else if (kind === 'road-intersection') {
        for (const sx of [-1, 1]) {
          for (const sz of [-1, 1]) {
            const partKey = `${sz < 0 ? 'n' : 's'}${sx < 0 ? 'w' : 'e'}`;
            const ax0 = sx < 0 ? sx * 4.74 : sx * 4.5;
            const ax1 = sx < 0 ? sx * 4.5 : sx * 4.74;
            const bx0 = sx < 0 ? sx * 7.24 : sx * 4.74;
            const bx1 = sx < 0 ? sx * 4.74 : sx * 7.24;
            const az0 = sz < 0 ? sz * 7.24 : sz * 4.74;
            const az1 = sz < 0 ? sz * 4.74 : sz * 7.24;
            const bz0 = sz < 0 ? sz * 7.24 : sz * 4.5;
            const bz1 = sz < 0 ? sz * 4.5 : sz * 7.24;
            emitSidewalkPart(entry, idx, partKey, [
              { uVals: [ax0, ax1], vVals: lin(az0, az1, 4), localPoint: (lx, lz) => [lx, lz] },
              { uVals: lin(bx0, bx1, 5), vVals: lin(bz0, bz1, 5), localPoint: (lx, lz) => [lx, lz] },
            ]);
          }
        }
      } else if (kind === 'road-t-junction') {
        emitSidewalkPart(entry, idx, 'back', [
          { uVals: lin(-4.5, 4.5, 18), vVals: lin(-7.24, -4.74, 4), localPoint: (lx, lz) => [lx, lz] },
        ]);
        for (const sx of [-1, 1]) {
          const partKey = sx < 0 ? 'sw' : 'se';
          const ax0 = sx < 0 ? sx * 4.74 : sx * 4.5;
          const ax1 = sx < 0 ? sx * 4.5 : sx * 4.74;
          const bx0 = sx < 0 ? sx * 7.24 : sx * 4.74;
          const bx1 = sx < 0 ? sx * 4.74 : sx * 7.24;
          emitSidewalkPart(entry, idx, partKey, [
            { uVals: [ax0, ax1], vVals: lin(4.74, 7.24, 4), localPoint: (lx, lz) => [lx, lz] },
            { uVals: lin(bx0, bx1, 5), vVals: lin(4.5, 7.24, 5), localPoint: (lx, lz) => [lx, lz] },
          ]);
        }
      } else if (kind === 'road-turn-90') {
        emitSidewalkPart(entry, idx, 'outer', [
          {
            uVals: lin(0, Math.PI / 2, 24),
            vVals: lin(10.74, 13.24, 4),
            localPoint: (ang, r) => [-6 + r * Math.cos(ang), 6 - r * Math.sin(ang)],
          },
        ]);
        emitSidewalkPart(entry, idx, 'inner', [
          {
            uVals: lin(0, Math.PI / 2, 14),
            vVals: lin(0.02, 1.26, 3),
            localPoint: (ang, r) => [-6 + r * Math.cos(ang), 6 - r * Math.sin(ang)],
          },
        ]);
      } else if (kind === 'road-curve-45') {
        emitSidewalkPart(entry, idx, 'inner', [
          {
            uVals: lin(Math.PI / 4, Math.PI / 2, 18),
            vVals: lin(6.76, 9.26, 4),
            localPoint: (ang, r) => [-4.95 + r * Math.cos(ang), 11.95 - r * Math.sin(ang)],
          },
        ]);
        emitSidewalkPart(entry, idx, 'outer', [
          {
            uVals: lin(Math.PI / 4, Math.PI / 2, 24),
            vVals: lin(18.74, 21.24, 4),
            localPoint: (ang, r) => [-4.95 + r * Math.cos(ang), 11.95 - r * Math.sin(ang)],
          },
        ]);
      } else if (kind === 'road-roundabout') {
        const armMask = entry.armMask ?? 15;
        const openE = (armMask & 1) !== 0;
        const openN = (armMask & 2) !== 0;
        const openW = (armMask & 4) !== 0;
        const openS = (armMask & 8) !== 0;

        const aMin = Math.atan2(4.74, 10.0);
        const aMax = Math.atan2(10.0, 4.74);
        const thetas = mergeSortedAngles(aMin, aMax, 14, [
          Math.atan2(4.74, 9.85),
          Math.atan2(7.24, 10.0),
          Math.atan2(10.0, 7.24),
          Math.atan2(9.85, 4.74),
        ]);
        for (const sx of [-1, 1]) {
          for (const sz of [-1, 1]) {
            const openX = sx > 0 ? openE : openW;
            const openZ = sz > 0 ? openS : openN;
            const partKey = `${sz < 0 ? 'n' : 's'}${sx < 0 ? 'w' : 'e'}`;
            emitSidewalkPart(entry, idx, partKey, [
              {
                uVals: thetas,
                vVals: lin(0, 1, 4),
                localPoint: (th, t) => {
                  const c = Math.cos(th);
                  const s = Math.sin(th);
                  const rIn = Math.max(9.85, 4.74 / s, 4.74 / c);
                  const rOut = Math.min(12.35, openX ? 10.0 / c : 12.35, openZ ? 10.0 / s : 12.35);
                  const r = rIn + (Math.max(rIn, rOut) - rIn) * t;
                  return [sx * r * c, sz * r * s];
                },
              },
            ]);
          }
        }

        // Continuous curved sidewalk across any sealed roundabout arms
        for (const [bit, capName, cosD, sinD] of [
          [1, 'cap-E', 1, 0],
          [2, 'cap-N', 0, -1],
          [4, 'cap-W', -1, 0],
          [8, 'cap-S', 0, 1],
        ] as const) {
          if ((armMask & bit) !== 0) continue;
          emitSidewalkPart(entry, idx, capName, [
            {
              uVals: lin(-4.74, 4.74, 14),
              vVals: lin(0, 1, 4),
              localPoint: (v, t) => {
                const uIn = Math.sqrt(9.85 * 9.85 - v * v);
                const uOut = Math.sqrt(12.35 * 12.35 - v * v);
                const u = uIn + (uOut - uIn) * t;
                return [u * cosD - v * sinD, u * sinD + v * cosD];
              },
            },
          ]);
        }
      } else if (kind === 'road-culdesac') {
        emitSidewalkPart(entry, idx, 'ring', [
          {
            uVals: lin(0, Math.PI * 2, 36),
            vVals: lin(6.19, 8.69, 4),
            localPoint: (ang, r) => [r * Math.cos(ang), r * Math.sin(ang)],
          },
        ]);
      } else if (kind === 'road-deadend') {
        const thetaNeck = Math.asin(4.74 / 6.18);
        const aEnd = Math.PI - thetaNeck;
        const critFlare = Math.acos(-3.96 / 8.68);
        const thetas = mergeSortedAngles(-aEnd, aEnd, 32, [-critFlare, critFlare]);
        emitSidewalkPart(entry, idx, 'ring', [
          { uVals: lin(-6.0, -3.96, 4), vVals: lin(-7.24, -4.74, 4), localPoint: (lx, lz) => [lx, lz] },
          { uVals: lin(-6.0, -3.96, 4), vVals: lin(4.74, 7.24, 4), localPoint: (lx, lz) => [lx, lz] },
          {
            uVals: thetas,
            vVals: lin(0, 1, 4),
            localPoint: (ang, t) => {
              const c = Math.cos(ang);
              const s = Math.sin(ang);
              const rIn = 6.18;
              const rOut = c < -3.96 / 8.68 ? Math.min(8.68, Math.max(rIn, -3.96 / c)) : 8.68;
              const r = rIn + (rOut - rIn) * t;
              return [r * c, r * s];
            },
          },
        ]);
      }
    }

    this.groundPickMeshes = nextPickMeshes;
  }

  private bindEvents(): void {
    const dom = this.renderer.domElement;
    dom.addEventListener('pointerdown', this.onPointerDown, { capture: true });
    dom.addEventListener('wheel', this.onCanvasWheel, { passive: false });
    dom.addEventListener('contextmenu', this.onContextMenu);
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onWindowBlur);
    window.addEventListener('resize', this.onResize);
    dom.addEventListener('webglcontextlost', this.onContextLost);
    dom.addEventListener('webglcontextrestored', this.onContextRestored);
  }

  private unbindEvents(): void {
    const dom = this.renderer.domElement;
    dom.removeEventListener('pointerdown', this.onPointerDown, { capture: true });
    dom.removeEventListener('wheel', this.onCanvasWheel);
    dom.removeEventListener('contextmenu', this.onContextMenu);
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onWindowBlur);
    window.removeEventListener('resize', this.onResize);
    dom.removeEventListener('webglcontextlost', this.onContextLost);
    dom.removeEventListener('webglcontextrestored', this.onContextRestored);
  }

  private mouseButtonToIndex(btn: MouseDragButton): number {
    if (btn === 'left') return 0;
    if (btn === 'middle') return 1;
    return 2;
  }

  private isAnyActionBoundTo(code: string): boolean {
    const kb = this.controlsConfig.keybinds;
    return (
      kb.moveForward === code ||
      kb.moveBackward === code ||
      kb.moveLeft === code ||
      kb.moveRight === code ||
      kb.moveUp === code ||
      kb.moveDown === code ||
      kb.rotate === code ||
      kb.delete === code ||
      kb.toggleDock === code
    );
  }

  private applyControlsConfig(): void {
    const mapAction = (btn: MouseDragButton): THREE.MOUSE | null => {
      if (this.controlsConfig.rotateMouseButton === btn) return THREE.MOUSE.ROTATE;
      if (this.controlsConfig.panMouseButton === btn) return THREE.MOUSE.PAN;
      return btn === 'middle' ? THREE.MOUSE.DOLLY : null;
    };
    this.controls.mouseButtons.LEFT = mapAction('left');
    this.controls.mouseButtons.MIDDLE = mapAction('middle');
    this.controls.mouseButtons.RIGHT = mapAction('right');
    this.controls.rotateSpeed = this.controlsConfig.rotateSensitivity;
    this.controls.zoomSpeed = this.controlsConfig.zoomSensitivity;
    this.controls.panSpeed = 1.35 * this.controlsConfig.moveSpeed;
  }

  public setControlsConfig(config: InputControlsConfig): void {
    this.controlsConfig = {
      ...config,
      keybinds: { ...config.keybinds },
    };
    this.applyControlsConfig();
    this.controls.update();
    this.requestRender();
  }

  private isMoveKey(code: string): boolean {
    const kb = this.controlsConfig.keybinds;
    if (
      code === kb.moveForward ||
      code === kb.moveBackward ||
      code === kb.moveLeft ||
      code === kb.moveRight ||
      code === kb.moveUp ||
      code === kb.moveDown
    ) {
      return true;
    }
    // Keep Arrow keys / Q / E as secondary aliases only if not rebound to another action
    if (!this.isAnyActionBoundTo(code)) {
      return (
        code === 'ArrowUp' ||
        code === 'ArrowDown' ||
        code === 'ArrowLeft' ||
        code === 'ArrowRight' ||
        code === 'KeyE' ||
        code === 'KeyQ' ||
        code === 'ShiftRight'
      );
    }
    return false;
  }

  private onKeyDown = (e: KeyboardEvent) => {
    if (e.defaultPrevented) return;
    const tag = (e.target as HTMLElement | null)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (document.querySelector('[data-keybind-capture="true"]')) return;

    const kb = this.controlsConfig.keybinds;

    if (this.builderTool !== null) {
      if (e.code === kb.rotate) {
        e.preventDefault();
        this.callbacks.onRotateBuilderTool();
        return;
      }
      if (e.code === 'Escape') {
        e.preventDefault();
        this.callbacks.onCancelBuilderTool();
        return;
      }
    } else {
      if (e.code === kb.rotate) {
        e.preventDefault();
        this.callbacks.onRotateSelected?.(e.shiftKey ? -Math.PI / 4 : Math.PI / 4);
        return;
      }
      if (
        e.code === kb.delete ||
        (kb.delete === 'Delete' && e.code === 'Backspace' && !this.isAnyActionBoundTo('Backspace'))
      ) {
        e.preventDefault();
        this.callbacks.onDeleteSelected?.();
        return;
      }
      if (e.code === 'Escape') {
        e.preventDefault();
        this.callbacks.onSelectTarget(null);
        return;
      }
    }

    if (!this.isMoveKey(e.code)) return;

    if (
      e.code === 'Space' ||
      e.code === kb.moveUp ||
      e.code === 'ArrowUp' ||
      e.code === 'ArrowDown' ||
      e.code === 'ArrowLeft' ||
      e.code === 'ArrowRight'
    ) {
      e.preventDefault();
    }

    const hadKey = this.pressedKeys.has(e.code);
    this.pressedKeys.add(e.code);
    if (!hadKey) {
      this.cameraTransition.active = false;
      this.requestRender();
    }
  };

  private onKeyUp = (e: KeyboardEvent) => {
    this.pressedKeys.delete(e.code);
  };

  private onWindowBlur = () => {
    this.pressedKeys.clear();
    this.isFreeLooking = false;
    this.isFreePanning = false;
  };

  private onContextMenu = (e: MouseEvent) => {
    e.preventDefault();
  };

  private onCanvasWheel = (e: WheelEvent) => {
    if (this.cameraControlMode !== 'pan') return;
    e.preventDefault();
    this.cameraTransition.active = false;
    this.camera.getWorldDirection(_vec3A);
    const altScale = 1 + Math.max(0, this.camera.position.y - 4) * 0.045;
    const step = clamp(
      -e.deltaY * 0.012 * altScale * this.controlsConfig.zoomSensitivity,
      -8,
      8,
    );
    this.camera.position.addScaledVector(_vec3A, step);
    this.camera.position.x = clamp(this.camera.position.x, -110, 110);
    this.camera.position.y = clamp(this.camera.position.y, 0.45, 75);
    this.camera.position.z = clamp(this.camera.position.z, -110, 110);
    this.controls.target
      .copy(this.camera.position)
      .addScaledVector(_vec3A, this.savedOrbitDistance);
    if (this.lastPointerClient) {
      this.updateCursorProbe(false);
    }
    this.requestRender();
  };

  private enforceOrbitGroundClearance(): void {
    if (this.cameraControlMode !== 'orbit') return;
    const minCamY = 0.45;
    if (this.camera.position.y < minCamY) {
      const lift = minCamY - this.camera.position.y;
      this.camera.position.y += lift;
      this.controls.target.y += lift;
      this.orbitGroundLift += lift;
    } else if (this.orbitGroundLift > 0 && this.camera.position.y > minCamY) {
      const relax = Math.min(this.orbitGroundLift, this.camera.position.y - minCamY);
      this.camera.position.y -= relax;
      this.controls.target.y -= relax;
      this.orbitGroundLift -= relax;
    }
  }

  public setCameraControlMode(mode: CameraControlMode): void {
    if (mode === this.cameraControlMode) return;
    this.cameraControlMode = mode;
    this.isFreeLooking = false;
    this.isFreePanning = false;
    this.orbitGroundLift = 0;

    if (mode === 'pan') {
      // Save current orbit distance and switch to free-look + move mode
      this.savedOrbitDistance = clamp(
        this.camera.position.distanceTo(this.controls.target),
        3,
        40,
      );
      _euler.setFromQuaternion(this.camera.quaternion, 'YXZ');
      this.freePitch = _euler.x;
      this.freeYaw = _euler.y;
      this.controls.enabled = false;
      this.renderer.domElement.style.cursor = 'grab';
    } else {
      // Sync orbit target ahead of camera and restore OrbitControls
      this.camera.getWorldDirection(_vec3A);
      this.controls.target
        .copy(this.camera.position)
        .addScaledVector(_vec3A, this.savedOrbitDistance);
      this.controls.target.y = clamp(this.controls.target.y, -80, 140);
      this.controls.enabled = true;
      this.applyControlsConfig();
      this.controls.touches.ONE = THREE.TOUCH.ROTATE;
      this.controls.update();
      this.renderer.domElement.style.cursor = 'crosshair';
    }
    this.requestRender();
  }

  public setBuilderState(tool: BuilderTool, rotationY: number): void {
    const toolChanged = tool !== this.builderTool;
    this.builderTool = tool;
    this.builderRotationY = rotationY;

    if (toolChanged) {
      if (this.builderGhostGroup) {
        this.scene.remove(this.builderGhostGroup);
        disposeObject3DResources(this.builderGhostGroup);
        this.builderGhostGroup = null;
      }

      if (tool !== null) {
        this.builderGhostGroup = createBuilderGhostGroup(tool);
        this.builderGhostGroup.traverse((obj) => obj.layers.set(2));
        this.builderGhostGroup.visible = false;
        this.scene.add(this.builderGhostGroup);
      }
    }

    if (this.builderGhostGroup) {
      this.builderGhostGroup.rotation.y = rotationY;
    }

    this.renderer.domElement.style.cursor =
      tool !== null
        ? 'copy'
        : this.cameraControlMode === 'pan'
          ? 'grab'
          : 'crosshair';
    this.requestRender();
  }

  private disposeGhostGroup(group: THREE.Group | null): void {
    if (!group) return;
    this.scene.remove(group);
    disposeObject3DResources(group);
  }

  private snapRoadOrPathPosition(
    kind: TargetKind,
    rawX: number,
    rawZ: number,
    rotationY: number,
    excludeTargetId?: string,
    length?: number,
  ): { x: number; z: number } {
    if (kind === 'parking-lot') {
      const outX = Math.sin(rotationY);
      const outZ = Math.cos(rotationY);
      let bestDist = Infinity;
      let bestX = rawX;
      let bestZ = rawZ;

      for (const target of this.currentTargets) {
        if (target.id === excludeTargetId) continue;
        if (target.kind !== 'road-2lane' && target.kind !== 'road-crosswalk') continue;
        const rCos = Math.cos(target.rotationY);
        const rSin = Math.sin(target.rotationY);
        const tx = rCos;
        const tz = -rSin;
        const nx = rSin;
        const nz = rCos;
        const sideDot = nx * -outX + nz * -outZ;
        if (Math.abs(sideDot) <= 0.7) continue;
        const side = sideDot > 0 ? 1 : -1;
        const dx = rawX - target.position.x;
        const dz = rawZ - target.position.z;
        const u = dx * tx + dz * tz;
        const v = dx * (side * nx) + dz * (side * nz);
        const halfL =
          target.kind === 'road-2lane' && target.length && target.length > 0
            ? target.length * 0.5
            : target.kind === 'road-crosswalk'
              ? 3.0
              : 4.0;
        if (Math.abs(u) > halfL + 1.5 || Math.abs(v - 12.0) > 3.6) continue;
        const uSnapped = clamp(Math.round(u * 2) / 2, -halfL, halfL);
        const cx = target.position.x + uSnapped * tx + 12.0 * side * nx;
        const cz = target.position.z + uSnapped * tz + 12.0 * side * nz;
        const d = Math.hypot(cx - rawX, cz - rawZ);
        if (d < bestDist) {
          bestDist = d;
          bestX = cx;
          bestZ = cz;
        }
      }

      if (bestDist < Infinity) {
        return {
          x: clamp(Math.round(bestX * 100) / 100, -MAP_HALF_X, MAP_HALF_X),
          z: clamp(Math.round(bestZ * 100) / 100, -MAP_HALF_Z, MAP_HALF_Z),
        };
      }
      return {
        x: clamp(this.snapCoordinate(rawX), -MAP_HALF_X, MAP_HALF_X),
        z: clamp(this.snapCoordinate(rawZ), -MAP_HALF_Z, MAP_HALF_Z),
      };
    }

    const ports = getSegmentLocalPorts(kind, rotationY, length);
    if (ports.length === 0) {
      return {
        x: clamp(this.snapCoordinate(rawX), -MAP_HALF_X, MAP_HALF_X),
        z: clamp(this.snapCoordinate(rawZ), -MAP_HALF_Z, MAP_HALF_Z),
      };
    }

    const snapThreshold = 3.2;
    let bestDist = Infinity;
    let bestX = rawX;
    let bestZ = rawZ;

    // Snap flush to existing placed roads & paths via opposing outward ports
    for (const target of this.currentTargets) {
      if (target.id === excludeTargetId) continue;
      if (!ROAD_PORT_DIMS[target.kind]) continue;
      const tPorts = getSegmentLocalPorts(target.kind, target.rotationY, target.length);
      for (const tp of tPorts) {
        const px = target.position.x + tp.ox;
        const pz = target.position.z + tp.oz;
        for (const mp of ports) {
          if (tp.nx * mp.nx + tp.nz * mp.nz > -0.7) continue;
          const cx = px - mp.ox;
          const cz = pz - mp.oz;
          const d = Math.hypot(cx - rawX, cz - rawZ);
          if (d <= snapThreshold && d < bestDist) {
            bestDist = d;
            bestX = cx;
            bestZ = cz;
          }
        }
      }
    }

    const gridX = this.snapCoordinate(rawX);
    if (bestDist === Infinity) {
      return {
        x: clamp(gridX, -MAP_HALF_X, MAP_HALF_X),
        z: clamp(this.snapCoordinate(rawZ), -MAP_HALF_Z, MAP_HALF_Z),
      };
    }

    return {
      x: clamp(Math.round(bestX * 100) / 100, -MAP_HALF_X, MAP_HALF_X),
      z: clamp(Math.round(bestZ * 100) / 100, -MAP_HALF_Z, MAP_HALF_Z),
    };
  }

  private resolvePlacementCoords(
    clientX: number,
    clientY: number,
    tool?: Exclude<BuilderTool, null>,
    rotationY = 0,
  ): { x: number; y: number; z: number } | null {
    if (!this.updateNormalizedPointer(clientX, clientY)) return null;
    this.raycaster.setFromCamera(_mouse, this.camera);
    const kind = tool && tool !== 'light' ? tool : undefined;
    const groundHits = this.raycaster.intersectObjects(this.groundPickMeshes, false);
    const pt =
      groundHits.length > 0
        ? groundHits[0].point
        : this.raycaster.ray.intersectPlane(_groundPlane, _dragHit)
          ? _dragHit
          : null;
    if (!pt) return null;

    if (kind && isRoadOrPathKind(kind)) {
      const snapped = this.snapRoadOrPathPosition(kind, pt.x, pt.z, rotationY);
      return {
        x: snapped.x,
        y: this.getGroundPlacementHeight(snapped.x, snapped.z, kind),
        z: snapped.z,
      };
    }

    const sx = clamp(this.snapCoordinate(pt.x), -MAP_HALF_X, MAP_HALF_X);
    const sz = clamp(this.snapCoordinate(pt.z), -MAP_HALF_Z, MAP_HALF_Z);
    return { x: sx, y: this.getGroundPlacementHeight(sx, sz, kind), z: sz };
  }

  public previewBuilderDragAt(
    tool: Exclude<BuilderTool, null>,
    clientX: number,
    clientY: number,
    rotationY: number,
  ): void {
    if (this.dragPreviewTool !== tool || !this.dragGhostGroup) {
      this.disposeGhostGroup(this.dragGhostGroup);
      this.dragGhostGroup = createBuilderGhostGroup(tool);
      this.dragGhostGroup.traverse((obj) => obj.layers.set(2));
      this.dragPreviewTool = tool;
      this.scene.add(this.dragGhostGroup);
    }

    const coords = this.resolvePlacementCoords(clientX, clientY, tool, rotationY);
    if (coords) {
      this.dragGhostGroup.position.set(coords.x, coords.y, coords.z);
      this.dragGhostGroup.rotation.y = rotationY;
      this.dragGhostGroup.visible = true;
    } else {
      this.dragGhostGroup.visible = false;
    }
    this.requestRender();
  }

  public clearBuilderDragPreview(): void {
    if (!this.dragGhostGroup) return;
    this.disposeGhostGroup(this.dragGhostGroup);
    this.dragGhostGroup = null;
    this.dragPreviewTool = null;
    this.requestRender();
  }

  public dropBuilderAt(
    tool: Exclude<BuilderTool, null>,
    clientX: number,
    clientY: number,
    rotationY: number,
  ): void {
    const coords = this.resolvePlacementCoords(clientX, clientY, tool, rotationY);
    this.clearBuilderDragPreview();
    if (coords) {
      this.callbacks.onPlaceBuilderItem(tool, { x: coords.x, z: coords.z }, rotationY);
    }
  }

  private snapCoordinate(val: number): number {
    return Math.round(val * 2) / 2;
  }

  private isPointOnAnySidewalk(x: number, z: number): boolean {
    if (isPointInsideAnyRoadway(x, z, this.modularRoadEntries)) return false;
    if (isPointInsideAnyParkingDriveway(x, z, this.currentTargets)) return false;
    for (let i = 0; i < this.modularRoadEntries.length; i++) {
      const entry = this.modularRoadEntries[i];
      const dx = x - entry.target.position.x;
      const dz = z - entry.target.position.z;
      if (dx * dx + dz * dz > entry.maxRadiusSq) continue;
      const { lx, lz } = toRoadLocal(x, z, entry);
      if (
        isPointInsideTargetSidewalkLocal(
          entry.target.kind,
          lx,
          lz,
          entry.armMask,
          entry.target.length,
          entry.hiddenSet,
        )
      ) {
        return true;
      }
    }
    return false;
  }

  private getGroundPlacementHeight(x: number, z: number, kind?: TargetKind): number {
    if (kind?.startsWith('road-') || kind === 'parking-lot') return 0;
    return this.isPointOnAnySidewalk(x, z) ? 0.12 : 0;
  }

  private onContextLost = (e: Event) => {
    e.preventDefault();
    this.callbacks.onContextLostChange?.(true);
  };

  private onContextRestored = () => {
    this.callbacks.onContextLostChange?.(false);
    this.requestRender();
  };

  private updateNormalizedPointer(clientX: number, clientY: number): boolean {
    const rect = this.renderer.domElement.getBoundingClientRect();
    if (
      clientX < rect.left ||
      clientX > rect.right ||
      clientY < rect.top ||
      clientY > rect.bottom
    ) {
      return false;
    }
    _mouse.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    _mouse.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    return true;
  }

  private onPointerDown = (event: PointerEvent) => {
    this.pointerDownClient = { x: event.clientX, y: event.clientY, button: event.button };
    this.pointerDownHitPickable = false;
    this.pendingSidewalkClick = null;
    if (!this.updateNormalizedPointer(event.clientX, event.clientY)) return;

    if (event.button === 0 && this.builderTool === null) {
      this.raycaster.layers.set(1);
      this.raycaster.setFromCamera(_mouse, this.camera);
      const hits = this.raycaster.intersectObjects(this.pickables, true);
      this.raycaster.layers.set(0);

      if (hits.length > 0) {
        const hitObj = hits[0].object;
        if (hitObj.userData.selectTargetId) {
          event.stopImmediatePropagation();
          const targetId = String(hitObj.userData.selectTargetId);
          this.pointerDownHitPickable = true;
          this.callbacks.onSelectTarget(targetId);
          this.draggingTargetId = targetId;
          this.controls.enabled = false;

          if (this.raycaster.ray.intersectPlane(_groundPlane, _dragHit)) {
            const group = this.targetGroups.get(targetId);
            if (group) {
              this.dragOffset.set(group.position.x - _dragHit.x, group.position.z - _dragHit.z);
            }
          }
          this.renderer.domElement.style.cursor = 'grabbing';
          return;
        }

        if (hitObj.userData.selectFixtureId) {
          event.stopImmediatePropagation();
          const fixtureId = String(hitObj.userData.selectFixtureId);
          this.pointerDownHitPickable = true;
          this.callbacks.onSelectFixture(fixtureId);
          this.draggingFixtureId = fixtureId;
          this.controls.enabled = false;

          if (this.raycaster.ray.intersectPlane(_groundPlane, _dragHit)) {
            const entry = this.lightEntries.get(fixtureId);
            if (entry) {
              this.dragOffset.set(
                entry.poleRefs.root.position.x - _dragHit.x,
                entry.poleRefs.root.position.z - _dragHit.z,
              );
            }
          }
          this.renderer.domElement.style.cursor = 'grabbing';
          return;
        }

        if (hitObj.userData.selectSidewalkKey && hitObj.userData.sidewalkInfo) {
          this.pointerDownHitPickable = true;
          this.pendingSidewalkClick = hitObj.userData.sidewalkInfo as SelectedSidewalkInfo;
        }
      }
    }

    // In Move Camera mode, configured rotate/pan mouse buttons rotate look direction in place or pan
    if (this.cameraControlMode === 'pan') {
      this.cameraTransition.active = false;
      this.lastLookPointer.x = event.clientX;
      this.lastLookPointer.y = event.clientY;
      if (
        (event.pointerType === 'touch' && event.isPrimary) ||
        event.button === this.mouseButtonToIndex(this.controlsConfig.rotateMouseButton)
      ) {
        _euler.setFromQuaternion(this.camera.quaternion, 'YXZ');
        this.freePitch = _euler.x;
        this.freeYaw = _euler.y;
        this.isFreeLooking = true;
        this.renderer.domElement.style.cursor = 'grabbing';
      } else if (event.button === this.mouseButtonToIndex(this.controlsConfig.panMouseButton)) {
        this.isFreePanning = true;
        this.renderer.domElement.style.cursor = 'move';
      }
    }
  };

  private updateCursorProbe(computeLux: boolean): void {
    if (!this.lastPointerClient) {
      this.lastGroundCursorHit = null;
      return;
    }
    const inside = this.updateNormalizedPointer(
      this.lastPointerClient.x,
      this.lastPointerClient.y,
    );
    if (!inside) {
      this.lastGroundCursorHit = null;
      if (this.cursorProbeMesh.visible) {
        this.cursorProbeMesh.visible = false;
        this.requestRender();
      }
      return;
    }

    this.raycaster.setFromCamera(_mouse, this.camera);
    const groundHits = this.raycaster.intersectObjects(this.groundPickMeshes, false);

    if (groundHits.length > 0) {
      const pt = groundHits[0].point;
      this.lastGroundCursorHit = pt;
      const probePt = { x: pt.x, y: Math.max(pt.y, 0), z: pt.z };
      this.lastCursorProbePoint = probePt;
      const probeY = Math.max(pt.y, 0.03) + 0.025;
      this.cursorProbeMesh.position.set(pt.x, probeY, pt.z);
      if (computeLux) {
        const lux = computeIlluminanceAtPoint(
          probePt,
          { x: 0, y: 1, z: 0 },
          this.currentFixtures,
        );
        this.emitStats(probePt, lux);
      }
    } else if (this.raycaster.ray.intersectPlane(_groundPlane, _vec3A)) {
      this.lastGroundCursorHit = null;
      const probePt = { x: _vec3A.x, y: 0, z: _vec3A.z };
      this.lastCursorProbePoint = probePt;
      this.cursorProbeMesh.position.set(_vec3A.x, 0.055, _vec3A.z);
      if (computeLux) {
        const lux = computeIlluminanceAtPoint(
          probePt,
          { x: 0, y: 1, z: 0 },
          this.currentFixtures,
        );
        this.emitStats(probePt, lux);
      }
    } else {
      this.lastGroundCursorHit = null;
      this.lastCursorProbePoint = null;
      this.cursorProbeMesh.visible = false;
      if (computeLux) {
        this.emitStats(null, null);
      }
      return;
    }

    const camDist = this.camera.position.distanceTo(this.cursorProbeMesh.position);
    const probeScale = clamp(camDist / 26, 0.65, 2.2);
    this.cursorProbeMesh.scale.setScalar(probeScale);
    this.cursorProbeMesh.visible = true;
  }

  private onPointerMove = (event: PointerEvent) => {
    this.lastPointerClient = { x: event.clientX, y: event.clientY };
    const inside = this.updateNormalizedPointer(event.clientX, event.clientY);

    if (this.draggingTargetId) {
      this.raycaster.setFromCamera(_mouse, this.camera);
      if (this.raycaster.ray.intersectPlane(_groundPlane, _dragHit)) {
        const nx = clamp(_dragHit.x + this.dragOffset.x, -MAP_HALF_X, MAP_HALF_X);
        const nz = clamp(_dragHit.z + this.dragOffset.y, -MAP_HALF_Z, MAP_HALF_Z);
        const dragged = this.currentTargets.find((t) => t.id === this.draggingTargetId);
        if (dragged && isRoadOrPathKind(dragged.kind)) {
          const snapped = this.snapRoadOrPathPosition(
            dragged.kind,
            nx,
            nz,
            dragged.rotationY,
            dragged.id,
            dragged.length,
          );
          this.callbacks.onMoveTarget(this.draggingTargetId, snapped);
        } else {
          this.callbacks.onMoveTarget(this.draggingTargetId, {
            x: Math.round(nx * 20) / 20,
            z: Math.round(nz * 20) / 20,
          });
        }
      }
      this.updateCursorProbe(false);
      this.requestRender();
      return;
    }

    if (this.draggingFixtureId) {
      this.raycaster.setFromCamera(_mouse, this.camera);
      if (this.raycaster.ray.intersectPlane(_groundPlane, _dragHit)) {
        const nx = clamp(_dragHit.x + this.dragOffset.x, -FIXTURE_MAX_X, FIXTURE_MAX_X);
        const nz = clamp(_dragHit.z + this.dragOffset.y, -FIXTURE_MAX_Z, FIXTURE_MAX_Z);
        this.callbacks.onMoveFixture(this.draggingFixtureId, {
          x: Math.round(nx * 10) / 10,
          z: Math.round(nz * 10) / 10,
        });
      }
      this.updateCursorProbe(false);
      this.requestRender();
      return;
    }

    if (this.isFreeLooking) {
      const dx = event.clientX - this.lastLookPointer.x;
      const dy = event.clientY - this.lastLookPointer.y;
      this.lastLookPointer.x = event.clientX;
      this.lastLookPointer.y = event.clientY;

      const lookSens = 0.0042 * this.controlsConfig.rotateSensitivity;
      this.freeYaw -= dx * lookSens;
      this.freePitch = clamp(
        this.freePitch - dy * lookSens,
        -Math.PI * 0.49,
        Math.PI * 0.49,
      );
      _euler.set(this.freePitch, this.freeYaw, 0, 'YXZ');
      this.camera.quaternion.setFromEuler(_euler);

      this.camera.getWorldDirection(_vec3A);
      this.controls.target
        .copy(this.camera.position)
        .addScaledVector(_vec3A, this.savedOrbitDistance);
      this.updateCursorProbe(false);
      this.requestRender();
      return;
    }

    if (this.isFreePanning) {
      const dx = event.clientX - this.lastLookPointer.x;
      const dy = event.clientY - this.lastLookPointer.y;
      this.lastLookPointer.x = event.clientX;
      this.lastLookPointer.y = event.clientY;

      this.camera.getWorldDirection(_vec3A);
      _vec3A.y = 0;
      if (_vec3A.lengthSq() < 1e-5) {
        _vec3A.set(-Math.sin(this.freeYaw), 0, -Math.cos(this.freeYaw)).normalize();
      } else {
        _vec3A.normalize();
      }
      _vec3B.crossVectors(_vec3A, this.camera.up).normalize();

      const panScale =
        Math.max(4, this.camera.position.y) * 0.0022 * this.controlsConfig.moveSpeed;
      this.camera.position.addScaledVector(_vec3B, -dx * panScale);
      this.camera.position.addScaledVector(_vec3A, dy * panScale);
      this.camera.position.x = clamp(this.camera.position.x, -110, 110);
      this.camera.position.z = clamp(this.camera.position.z, -110, 110);
      this.camera.getWorldDirection(_vec3C);
      this.controls.target
        .copy(this.camera.position)
        .addScaledVector(_vec3C, this.savedOrbitDistance);
      this.updateCursorProbe(false);
      this.requestRender();
      return;
    }

    if (!inside) {
      if (this.cursorProbeMesh.visible || (this.builderGhostGroup && this.builderGhostGroup.visible)) {
        this.cursorProbeMesh.visible = false;
        if (this.builderGhostGroup) this.builderGhostGroup.visible = false;
        this.requestRender();
      }
      return;
    }

    const now = performance.now();
    const shouldComputeLux = now - this.lastHoverProbeTime >= 28;
    if (shouldComputeLux) {
      this.lastHoverProbeTime = now;
    }

    this.updateCursorProbe(shouldComputeLux);

    if (this.builderTool !== null) {
      this.renderer.domElement.style.cursor = 'copy';
      if (shouldComputeLux) {
        const pt = this.lastGroundCursorHit;
        if (pt && this.builderGhostGroup) {
          const kind = this.builderTool !== 'light' ? this.builderTool : undefined;
          let sx = clamp(this.snapCoordinate(pt.x), -MAP_HALF_X, MAP_HALF_X);
          let sz = clamp(this.snapCoordinate(pt.z), -MAP_HALF_Z, MAP_HALF_Z);
          if (kind && isRoadOrPathKind(kind)) {
            const snapped = this.snapRoadOrPathPosition(kind, pt.x, pt.z, this.builderRotationY);
            sx = snapped.x;
            sz = snapped.z;
          }
          const sy = this.getGroundPlacementHeight(sx, sz, kind);
          this.builderGhostGroup.position.set(sx, sy, sz);
          this.builderGhostGroup.rotation.y = this.builderRotationY;
          this.builderGhostGroup.visible = true;
        } else if (this.builderGhostGroup) {
          this.builderGhostGroup.visible = false;
        }
      }
      this.requestRender();
      return;
    }

    if (shouldComputeLux) {
      // Check hover affordance over draggable targets & poles
      this.raycaster.setFromCamera(_mouse, this.camera);
      this.raycaster.layers.set(1);
      const pickHits = this.raycaster.intersectObjects(this.pickables, true);
      this.raycaster.layers.set(0);

      if (pickHits.length > 0 && (pickHits[0].object.userData.selectTargetId || pickHits[0].object.userData.selectFixtureId)) {
        this.renderer.domElement.style.cursor = 'grab';
      } else if (pickHits.length > 0 && pickHits[0].object.userData.selectSidewalkKey) {
        this.renderer.domElement.style.cursor = 'pointer';
      } else {
        this.renderer.domElement.style.cursor =
          this.cameraControlMode === 'pan' ? 'grab' : 'crosshair';
      }
    }

    this.requestRender();
  };

  private onPointerUp = (event: PointerEvent) => {
    if (this.draggingTargetId || this.draggingFixtureId) {
      this.draggingTargetId = null;
      this.draggingFixtureId = null;
      this.controls.enabled = this.cameraControlMode === 'orbit';
      this.renderer.domElement.style.cursor =
        this.cameraControlMode === 'pan' ? 'grab' : 'crosshair';
      return;
    }

    if (this.isFreeLooking || this.isFreePanning) {
      this.isFreeLooking = false;
      this.isFreePanning = false;
      this.renderer.domElement.style.cursor =
        this.builderTool !== null ? 'copy' : 'grab';
    }

    // Click-to-place in Builder Mode (distinguishes crisp click < 5px from camera drag)
    const moveDist = Math.hypot(
      event.clientX - this.pointerDownClient.x,
      event.clientY - this.pointerDownClient.y,
    );

    if (
      this.builderTool !== null &&
      event.button === 0 &&
      this.pointerDownClient.button === 0 &&
      this.updateNormalizedPointer(event.clientX, event.clientY)
    ) {
      if (moveDist < 5) {
        this.raycaster.setFromCamera(_mouse, this.camera);
        const groundHits = this.raycaster.intersectObjects(this.groundPickMeshes, false);
        if (groundHits.length > 0) {
          const pt = groundHits[0].point;
          const kind = this.builderTool !== 'light' ? this.builderTool : undefined;
          let sx = clamp(this.snapCoordinate(pt.x), -MAP_HALF_X, MAP_HALF_X);
          let sz = clamp(this.snapCoordinate(pt.z), -MAP_HALF_Z, MAP_HALF_Z);
          if (kind && isRoadOrPathKind(kind)) {
            const snapped = this.snapRoadOrPathPosition(kind, pt.x, pt.z, this.builderRotationY);
            sx = snapped.x;
            sz = snapped.z;
          }
          this.callbacks.onPlaceBuilderItem(
            this.builderTool,
            { x: sx, z: sz },
            this.builderRotationY,
          );
        }
      }
    } else if (this.builderTool !== null && event.button === 2) {
      if (moveDist < 5) {
        this.callbacks.onCancelBuilderTool();
      }
    } else if (
      this.builderTool === null &&
      event.button === 0 &&
      this.pointerDownClient.button === 0 &&
      this.pendingSidewalkClick
    ) {
      const clickInfo = this.pendingSidewalkClick;
      this.pendingSidewalkClick = null;
      if (moveDist < 5) {
        this.callbacks.onSelectSidewalk?.(clickInfo);
      }
    } else if (
      this.builderTool === null &&
      event.button === 0 &&
      this.pointerDownClient.button === 0 &&
      !this.pointerDownHitPickable &&
      moveDist < 5
    ) {
      // Crisp click on empty street/terrain clears object selection
      this.callbacks.onSelectTarget(null);
    }
    this.pendingSidewalkClick = null;
  };

  public onResize = () => {
    if (this.disposed) return;
    const rect = this.container.getBoundingClientRect();
    const width = Math.max(rect.width, 320);
    const height = Math.max(rect.height, 240);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
    this.requestRender();
  };

  public setCameraPreset(preset: CameraPresetId): void {
    const goalPos = this.cameraTransition.targetPos;
    const goalTarget = this.cameraTransition.targetLookAt;

    switch (preset) {
      case 'perspective':
        goalPos.set(16.5, 12.5, 21.5);
        goalTarget.set(0, 1.5, 0);
        break;
      case 'top':
        goalPos.set(0, 68, 0.01);
        goalTarget.set(0, 0, 0);
        break;
      case 'side':
        goalPos.set(-18.5, 4.8, 0.2);
        goalTarget.set(0, 2.2, 0);
        break;
      case 'closeup': {
        const active =
          this.currentFixtures.find((f) => f.id === this.selectedFixtureId) ??
          this.currentFixtures[0];
        const fx = active?.position.x ?? 0;
        const fz = active?.position.z ?? -3.2;
        const fh = active?.height ?? 8;
        goalPos.set(fx + 5.8, Math.max(2.4, fh * 0.85), fz + 6.4);
        goalTarget.set(fx, fh * 0.6, fz);
        break;
      }
    }

    this.orbitGroundLift = 0;
    this.cameraTransition.active = true;
    this.requestRender();
  }

  public syncState(
    fixtures: LightFixture[],
    targets: StreetTarget[],
    selectedFixtureId: string,
    selectedTargetId: string | null,
    settings: ViewportSettings,
    selectedSidewalkKey: string | null = null,
  ): void {
    this.currentFixtures = fixtures;
    this.currentTargets = targets;
    this.selectedFixtureId = selectedFixtureId;
    this.selectedTargetId = selectedTargetId;
    this.selectedSidewalkKey = selectedSidewalkKey;

    const fixturesChanged =
      fixtures !== this.prevFixturesProp ||
      selectedFixtureId !== this.prevSelectedFixtureId ||
      settings.showBeamEnvelope !== this.prevShowBeamEnvelope;
    const targetsChanged = targets !== this.prevTargetsProp;

    // 1. Ambient sky, fog & sun/moon mode (only update when changed)
    if (this.prevAmbientMode !== settings.ambientMode) {
      this.prevAmbientMode = settings.ambientMode;
      const presetMap: Record<
        AmbientMode,
        {
          skyHex: number;
          fogDensity: number;
          hemiSky: number;
          hemiGround: number;
          hemiIntensity: number;
          keyColor: number;
          keyIntensity: number;
          keyPos: [number, number, number];
          castSunShadow: boolean;
          envIntensity: number;
          exposure: number;
        }
      > = {
        dawn: {
          skyHex: 0x526180,
          fogDensity: 0.0068,
          hemiSky: 0xf4b698,
          hemiGround: 0x222a3a,
          hemiIntensity: 0.96,
          keyColor: 0xffb375,
          keyIntensity: 1.45,
          keyPos: [-36, 12, 22],
          castSunShadow: true,
          envIntensity: 0.56,
          exposure: 1.06,
        },
        morning: {
          skyHex: 0x89bce8,
          fogDensity: 0.004,
          hemiSky: 0xd0e9ff,
          hemiGround: 0x38414e,
          hemiIntensity: 1.18,
          keyColor: 0xfff4de,
          keyIntensity: 2.3,
          keyPos: [-24, 30, 18],
          castSunShadow: true,
          envIntensity: 0.8,
          exposure: 0.96,
        },
        noon: {
          skyHex: 0x76b8f2,
          fogDensity: 0.0032,
          hemiSky: 0xdff0ff,
          hemiGround: 0x454e59,
          hemiIntensity: 1.3,
          keyColor: 0xffffff,
          keyIntensity: 2.75,
          keyPos: [10, 48, 14],
          castSunShadow: true,
          envIntensity: 0.92,
          exposure: 0.92,
        },
        sunset: {
          skyHex: 0x6a4962,
          fogDensity: 0.0062,
          hemiSky: 0xff9a69,
          hemiGround: 0x261f2f,
          hemiIntensity: 0.94,
          keyColor: 0xff8c3d,
          keyIntensity: 1.8,
          keyPos: [38, 10, -18],
          castSunShadow: true,
          envIntensity: 0.56,
          exposure: 1.08,
        },
        twilight: {
          skyHex: 0x131d33,
          fogDensity: 0.007,
          hemiSky: 0x4b6a9e,
          hemiGround: 0x121824,
          hemiIntensity: 0.85,
          keyColor: 0x94b5eb,
          keyIntensity: 0.55,
          keyPos: [-16, 22, 14],
          castSunShadow: false,
          envIntensity: 0.48,
          exposure: 1.15,
        },
        night: {
          skyHex: 0x070a12,
          fogDensity: 0.0075,
          hemiSky: 0x385178,
          hemiGround: 0x10141c,
          hemiIntensity: 0.36,
          keyColor: 0x9ab8e8,
          keyIntensity: 0.22,
          keyPos: [-16, 22, 14],
          castSunShadow: false,
          envIntensity: 0.22,
          exposure: 1.15,
        },
      };

      const cfg = presetMap[settings.ambientMode] ?? presetMap.night;
      (this.scene.background as THREE.Color).setHex(cfg.skyHex);
      const fog = this.scene.fog as THREE.FogExp2;
      fog.color.setHex(cfg.skyHex);
      fog.density = cfg.fogDensity;

      this.hemiLight.color.setHex(cfg.hemiSky);
      this.hemiLight.groundColor.setHex(cfg.hemiGround);
      this.hemiLight.intensity = cfg.hemiIntensity;

      this.moonLight.color.setHex(cfg.keyColor);
      this.moonLight.intensity = cfg.keyIntensity;
      this.moonLight.position.set(cfg.keyPos[0], cfg.keyPos[1], cfg.keyPos[2]);
      this.moonLight.castShadow = !this.isSoftwareGl && cfg.castSunShadow;

      this.scene.environmentIntensity = cfg.envIntensity;
      this.renderer.toneMappingExposure = cfg.exposure;
    }

    this.currentLuxThreshold = settings.luxThreshold;
    const thresholdChanged = settings.luxThreshold !== this.prevLuxThreshold;

    this.gridHelper.visible = settings.showGrid;
    if (
      settings.showLuxHeatmap !== this.prevShowLuxHeatmap ||
      (settings.showLuxHeatmap &&
        (fixtures !== this.prevFixturesProp || thresholdChanged))
    ) {
      updateLuxOverlayUniforms(
        this.luxOverlayState,
        fixtures,
        settings.showLuxHeatmap,
        settings.luxThreshold,
      );
    }
    this.prevShowLuxHeatmap = settings.showLuxHeatmap;
    this.prevLuxThreshold = settings.luxThreshold;

    // Rebuild corridor sidewalks & road driveway curb cuts when roads, sidewalks, or parking lots change
    let roadLayoutChanged = false;
    if (targetsChanged) {
      const roadSig = targets
        .filter((t) => t.kind.startsWith('road-') || t.kind === 'parking-lot')
        .map(
          (t) =>
            `${t.id}:${t.kind}:${t.position.x.toFixed(2)},${t.position.z.toFixed(2)},${t.rotationY.toFixed(3)},${t.length ?? 0},${(t.hiddenSidewalks ?? []).join(',')}`,
        )
        .join('|');
      if (roadSig !== this.lastRoadSignature) {
        this.lastRoadSignature = roadSig;
        roadLayoutChanged = true;
        this.rebuildSidewalks(targets);
      }
    }
    for (const mesh of this.sidewalkMeshes) {
      const wantMat =
        mesh.userData.selectSidewalkKey === selectedSidewalkKey
          ? this.selectedSidewalkMat
          : this.sidewalkMat;
      if (mesh.material !== wantMat) {
        mesh.material = wantMat;
      }
    }

    // 2. Sync Light Fixtures (only when fixtures, selected fixture, or beam toggle changed)
    if (fixturesChanged) {
      const activeIds = new Set(fixtures.map((f) => f.id));
      for (const [id, entry] of this.lightEntries.entries()) {
        if (!activeIds.has(id)) {
          this.scene.remove(entry.spotLight);
          this.scene.remove(entry.spotTarget);
          this.scene.remove(entry.pointLight);
          this.scene.remove(entry.poleRefs.root);
          entry.spotLight.map = null;
          entry.goboTex?.dispose();
          entry.poleRefs.shieldTex.dispose();
          entry.spotLight.dispose();
          entry.pointLight.dispose();
          this.lightEntries.delete(id);
          this.pickablesDirty = true;
        }
      }

      let enabledShadowCount = 0;
      fixtures.forEach((f) => {
        let entry = this.lightEntries.get(f.id);
        if (!entry) {
          const spotLight = new THREE.SpotLight(0xffffff, 0, 55, Math.PI / 4, 0.32, 2);
          spotLight.shadow.mapSize.set(1024, 1024);
          spotLight.shadow.camera.near = 0.35;
          spotLight.shadow.camera.far = 42;
          spotLight.shadow.bias = -0.0005;
          spotLight.shadow.normalBias = 0.02;

          const spotTarget = new THREE.Object3D();
          spotLight.target = spotTarget;

          const pointLight = new THREE.PointLight(0xffffff, 0, 48, 2);
          pointLight.shadow.mapSize.set(512, 512);
          pointLight.shadow.camera.near = 0.08;
          pointLight.shadow.camera.far = 36;
          pointLight.shadow.bias = -0.004;

          const poleRefs = createStreetPoleRig(f.id);
          attachLuxOverlayToObject(poleRefs.root, this.luxOverlayState);

          this.scene.add(spotLight, spotTarget, pointLight, poleRefs.root);
          entry = {
            spotLight,
            spotTarget,
            pointLight,
            poleRefs,
            goboTex: null,
            goboSignature: '',
          };
          this.lightEntries.set(f.id, entry);
          this.pickablesDirty = true;
        }

        const colorHex = getFixtureHex(f);
        const aim = getAimDirection(f.tiltAngle, f.yawAngle);
        const shieldMask = (f.shieldSectors ?? 0) & ((1 << SHIELD_SECTORS) - 1);
        const hasCustomAngles = hasCustomSectorAngles(f.sectorAngles);
        const sectorAnglesSig = hasCustomAngles ? getSectorAnglesSignature(f.sectorAngles) : '';
        const maxEffectiveAngle = hasCustomAngles ? getMaxEffectiveAngle(f) : f.angleRange;

        entry.poleRefs.root.position.set(f.position.x, 0, f.position.z);
        updateStreetPoleRig(
          entry.poleRefs,
          f.height,
          f.tiltAngle,
          f.yawAngle,
          f.angleRange,
          f.lumens,
          colorHex,
          f.enabled,
          f.id === selectedFixtureId,
          settings.showBeamEnvelope,
          f.position.x,
          f.position.z,
          shieldMask,
          hasCustomAngles ? f.sectorAngles : undefined,
          sectorAnglesSig,
          f.poleYawAngle ?? f.yawAngle,
        );

        // Position real Three.js lights at optical center
        entry.spotLight.position.set(f.position.x, f.height, f.position.z);
        entry.spotTarget.position.set(
          f.position.x + aim.x * 10,
          f.height + aim.y * 10,
          f.position.z + aim.z * 10,
        );
        entry.spotLight.updateMatrixWorld();
        entry.spotTarget.updateMatrixWorld();
        entry.pointLight.position.set(f.position.x, f.height, f.position.z);

        entry.spotLight.color.set(colorHex);
        entry.pointLight.color.set(colorHex);

        // Physical Three.js intensity scaling calibrated to lumens & beam spread
        const halfRad = getEffectiveHalfAngleRad(f.angleRange);
        const maxHalfRad = getEffectiveHalfAngleRad(maxEffectiveAngle);
        const solidAngle = Math.max(2 * Math.PI * (1 - Math.cos(halfRad)), 0.008);
        const baseIntensity = f.enabled ? (f.lumens / solidAngle) * 0.042 : 0;
        const canShadow = !this.isSoftwareGl && f.enabled && enabledShadowCount < 3;
        if (canShadow) enabledShadowCount++;

        let openSectorCount = 0;
        let wideExcessSum = 0;
        for (let s = 0; s < SHIELD_SECTORS; s++) {
          if (((shieldMask >> s) & 1) !== 0) continue;
          openSectorCount++;
          const secAngle = hasCustomAngles
            ? (f.sectorAngles?.[s] ?? f.angleRange)
            : f.angleRange;
          if (secAngle > 76) {
            wideExcessSum += clamp((secAngle - 76) / 104, 0, 1);
          }
        }
        const openRatio = openSectorCount / SHIELD_SECTORS;
        const wideOpenRatio = wideExcessSum / SHIELD_SECTORS;

        entry.spotLight.penumbra = hasCustomAngles ? 0.0 : 0.32;
        const maxSafeSpotRad = degToRad(76);
        const pointBase = f.enabled ? (f.lumens / (4 * Math.PI)) * 0.065 : 0;

        if (f.angleRange <= 78) {
          entry.spotLight.angle = Math.min(maxHalfRad, maxSafeSpotRad);
          entry.spotLight.intensity = baseIntensity;
          entry.spotLight.castShadow = canShadow;
          entry.pointLight.intensity = wideOpenRatio > 0.01 ? pointBase * wideOpenRatio * 0.72 : 0;
          entry.pointLight.castShadow = false;
        } else {
          const blend = clamp((f.angleRange - 78) / 102, 0, 1);

          entry.spotLight.angle = maxSafeSpotRad;
          entry.spotLight.intensity = baseIntensity * (1 - blend);
          entry.pointLight.intensity = pointBase * openRatio * (0.25 + 0.75 * blend);

          entry.spotLight.castShadow = canShadow && blend < 0.35;
          entry.pointLight.castShadow = canShadow && blend >= 0.35 && openRatio > 0.05;
        }

        if ((shieldMask === 0 && !hasCustomAngles) || !f.enabled || entry.spotLight.intensity <= 0.001) {
          if (entry.spotLight.map !== null) {
            entry.spotLight.map = null;
          }
        } else {
          const goboSig = `${shieldMask}:${f.angleRange}:${sectorAnglesSig}:${f.tiltAngle}:${f.yawAngle}:${Math.round(entry.spotLight.angle * 1000)}`;
          if (entry.goboSignature !== goboSig || !entry.goboTex) {
            entry.goboSignature = goboSig;
            entry.spotLight.shadow.updateMatrices(entry.spotLight);
            entry.goboTex = this.buildSpotShieldGoboTexture(
              entry.goboTex,
              entry.spotLight.shadow.camera as THREE.PerspectiveCamera,
              f,
              shieldMask,
              hasCustomAngles,
            );
          }
          entry.spotLight.map = entry.goboTex;
        }
      });

      this.prevFixturesProp = fixtures;
      this.prevSelectedFixtureId = selectedFixtureId;
      this.prevShowBeamEnvelope = settings.showBeamEnvelope;
    }

    // 3. Sync Movable & Animated Street Targets (only rebuild when targets change)
    if (targetsChanged) {
      const targetIds = new Set(targets.map((t) => t.id));
      for (const [id, group] of this.targetGroups.entries()) {
        if (!targetIds.has(id)) {
          this.disposeGhostGroup(group);
          this.targetGroups.delete(id);
          this.animatedActors.delete(id);
          this.pickablesDirty = true;
        }
      }
      for (const id of this.animatedActors.keys()) {
        if (!targetIds.has(id)) {
          this.animatedActors.delete(id);
        }
      }

      const maxAniso = this.renderer.capabilities.getMaxAnisotropy();
      const nextVehicles: StreetTarget[] = [];
      const nextPedestrians: StreetTarget[] = [];

      for (const t of targets) {
        if (isVehicleKind(t.kind)) nextVehicles.push(t);
        else if (t.kind === 'pedestrian') nextPedestrians.push(t);

        let group = this.targetGroups.get(t.id);
        const colorKey = t.color ?? '';
        const lenKey = isRoadOrPathKind(t.kind) ? (t.length ?? 0) : 0;
        if (
          group &&
          (group.userData.targetKind !== t.kind ||
            group.userData.targetColor !== colorKey ||
            group.userData.targetLength !== lenKey)
        ) {
          this.disposeGhostGroup(group);
          this.targetGroups.delete(t.id);
          this.animatedActors.delete(t.id);
          group = undefined;
          this.pickablesDirty = true;
        }

        if (!group) {
          group = createStreetTargetGroup(
            t.id,
            t.kind,
            this.contactShadowTex,
            maxAniso,
            t.color,
            t.length,
          );
          group.userData.targetKind = t.kind;
          group.userData.targetColor = colorKey;
          group.userData.targetLength = lenKey;
          attachLuxOverlayToObject(group, this.luxOverlayState);
          this.scene.add(group);
          this.targetGroups.set(t.id, group);
          this.pickablesDirty = true;
        }

        let liveX = t.position.x;
        let liveZ = t.position.z;
        let liveRotY = t.rotationY;

        if (t.motion) {
          let actor = this.animatedActors.get(t.id);
          if (
            !actor ||
            actor.motion !== t.motion ||
            actor.kind !== t.kind ||
            actor.routeId !== t.routeId
          ) {
            const baseSpeed =
              t.motion === 'drive'
                ? getActorBaseSpeed(t.kind, t.rotationY) * (0.82 + Math.random() * 0.36)
                : getActorBaseSpeed(t.kind, t.rotationY) * (0.76 + Math.random() * 0.48);
            actor = {
              motion: t.motion,
              kind: t.kind,
              routeId: t.routeId,
              x: t.position.x,
              z: t.position.z,
              rotationY: t.rotationY,
              phase: t.motion === 'walk' ? Math.random() * Math.PI * 2 : 0,
              strideBlend: 1,
              waypointIdx: 0,
              halfLen: getActorHalfLength(t.kind),
              speed: baseSpeed,
              currentSpeed: baseSpeed,
              isYielding: false,
              lastPropPos: { x: t.position.x, z: t.position.z },
              lastPropRotY: t.rotationY,
              roundaboutSteps: 0,
              roundaboutTargetSteps: 1 + Math.floor(Math.random() * 8),
              speedDriftTimer: 2.5 + Math.random() * 5.0,
              offGraphTurnRate: (Math.random() - 0.5) * 0.45,
              offGraphTimer: 1.5 + Math.random() * 3.0,
              walkPauseTimer: t.motion === 'walk' && Math.random() < 0.25 ? Math.random() * 1.4 : 0,
              walkReactionTimer: 0,
              walkWasYielding: false,
              walkIdleTime: Math.random() * 12,
              walkSeed: Math.random() * Math.PI * 2,
              walkLookYaw: 0,
              walkLookPitch: 0,
              crossingWaypoints: t.crossingPath
                ? t.crossingPath.map((wp) => ({ ...wp }))
                : undefined,
              crossingStepIdx: 0,
              crossingCurbPaused: false,
              lastCrossingPathRef: t.crossingPath,
            };
            if (actor.motion === 'drive') {
              this.assignInitialGraphRoute(actor);
            } else if (actor.motion === 'walk') {
              this.initPedestrianWalk(actor);
            }
            this.animatedActors.set(t.id, actor);
          } else {
            if (
              Math.abs(t.position.x - actor.lastPropPos.x) > 1e-4 ||
              Math.abs(t.position.z - actor.lastPropPos.z) > 1e-4
            ) {
              actor.x = t.position.x;
              actor.z = t.position.z;
              actor.lastPropPos.x = t.position.x;
              actor.lastPropPos.z = t.position.z;
              actor.routeId = t.routeId;
              actor.crossingWaypoints = t.crossingPath
                ? t.crossingPath.map((wp) => ({ ...wp }))
                : undefined;
              actor.crossingStepIdx = 0;
              actor.crossingCurbPaused = false;
              actor.lastCrossingPathRef = t.crossingPath;
              if (actor.motion === 'walk') {
                this.initPedestrianWalk(actor);
              } else {
                this.clearActorParkingState(actor);
                actor.roundaboutSteps = 0;
                actor.roundaboutTargetSteps = 1 + Math.floor(Math.random() * 8);
                this.assignInitialGraphRoute(actor);
              }
            } else if (
              t.routeId === 'Crossing' &&
              t.crossingPath &&
              t.crossingPath !== actor.lastCrossingPathRef
            ) {
              actor.crossingWaypoints = t.crossingPath.map((wp) => ({ ...wp }));
              actor.crossingStepIdx = 0;
              actor.crossingCurbPaused = false;
              actor.lastCrossingPathRef = t.crossingPath;
              if (actor.motion === 'walk') {
                this.initPedestrianWalk(actor);
              }
            }
            if (Math.abs(t.rotationY - actor.lastPropRotY) > 1e-4) {
              actor.rotationY = t.rotationY;
              actor.lastPropRotY = t.rotationY;
              if (actor.motion === 'drive') {
                this.clearActorParkingState(actor);
                actor.speed =
                  getActorBaseSpeed(actor.kind, actor.rotationY) * (0.82 + Math.random() * 0.36);
                actor.roundaboutSteps = 0;
                actor.roundaboutTargetSteps = 1 + Math.floor(Math.random() * 8);
                this.assignInitialGraphRoute(actor);
              }
            }
          }
          liveX = actor.x;
          liveZ = actor.z;
          liveRotY = actor.rotationY;
        } else {
          this.animatedActors.delete(t.id);
        }

        const groundY = this.getGroundPlacementHeight(liveX, liveZ, t.kind);
        group.position.set(liveX, groundY, liveZ);
        group.rotation.y = liveRotY;

        const defaultDims = BUILDING_DEFAULT_DIMENSIONS[t.kind];
        const defaultH = BUILDING_DEFAULT_HEIGHTS[t.kind];
        const wScale =
          defaultDims && t.width !== undefined
            ? clamp(t.width / defaultDims.width, 0.45, 2.8)
            : 1;
        const lScale =
          defaultDims && t.length !== undefined
            ? clamp(t.length / defaultDims.length, 0.45, 2.8)
            : 1;
        const hScale =
          defaultH !== undefined
            ? clamp((t.height ?? defaultH) / defaultH, 0.35, 3.0)
            : 1;

        if (defaultH) {
          const bodyGroup =
            (group.userData.buildingBody as THREE.Group | undefined) ??
            group.getObjectByName('buildingBody');
          if (bodyGroup) {
            bodyGroup.scale.set(wScale, hScale, lScale);
          }
          const contactPlane = group.userData.contactPlane as THREE.Mesh | undefined;
          if (contactPlane) {
            contactPlane.scale.set(wScale, lScale, 1);
          }
        }

        const ring =
          (group.userData.selectionRing as THREE.Mesh | undefined) ??
          (group.getObjectByName('selectionRing') as THREE.Mesh | undefined);
        if (ring) {
          ring.visible = t.id === selectedTargetId;
          if (defaultH) {
            ring.scale.set(wScale, lScale, 1);
          }
        }

        if (t.kind === 'road-roundabout') {
          const armMask =
            this.modularRoadEntries.find((e) => e.target.id === t.id)?.armMask ?? 15;
          const armGroups = group.userData.roundaboutArmGroups as Record<string, THREE.Group> | undefined;
          const capCurbs = group.userData.roundaboutCapCurbs as Record<string, THREE.Mesh> | undefined;
          for (const [bit, dir] of [
            [1, 'E'],
            [2, 'N'],
            [4, 'W'],
            [8, 'S'],
          ] as const) {
            const open = (armMask & bit) !== 0;
            const armGrp = armGroups ? armGroups[dir] : group.getObjectByName(`armGroup_${dir}`);
            if (armGrp) armGrp.visible = open;
            const capMesh = capCurbs ? capCurbs[dir] : group.getObjectByName(`capCurb_${dir}`);
            if (capMesh) capMesh.visible = !open;
          }
        }
      }

      this.vehicleTargets = nextVehicles;
      this.pedestrianTargets = nextPedestrians;
      this.prevTargetsProp = targets;
      this.prevSelectedTargetId = selectedTargetId;

      for (const actor of this.animatedActors.values()) {
        if (actor.parkingLotId) {
          const lot = targets.find(
            (item) => item.id === actor.parkingLotId && item.kind === 'parking-lot',
          );
          const poseChanged =
            lot &&
            actor.parkingLotPose &&
            (Math.hypot(
              lot.position.x - actor.parkingLotPose.x,
              lot.position.z - actor.parkingLotPose.z,
            ) > 0.05 ||
              Math.abs(lot.rotationY - actor.parkingLotPose.rotationY) > 0.02);
          if (!lot || poseChanged) {
            this.clearActorParkingState(actor);
            if (actor.motion === 'drive') {
              this.assignInitialGraphRoute(actor);
            }
          }
        }
      }

      if (roadLayoutChanged) {
        this.updateRoadDrivewayCurbs(targets);
      }

      this.rebuildTrafficControllers(targets);
      this.updateTrafficLightVisuals();
    } else if (selectedTargetId !== this.prevSelectedTargetId) {
      if (this.prevSelectedTargetId) {
        const prevGrp = this.targetGroups.get(this.prevSelectedTargetId);
        const prevRing = prevGrp?.userData.selectionRing as THREE.Mesh | undefined;
        if (prevRing) prevRing.visible = false;
      }
      if (selectedTargetId) {
        const nextGrp = this.targetGroups.get(selectedTargetId);
        const nextRing = nextGrp?.userData.selectionRing as THREE.Mesh | undefined;
        if (nextRing) nextRing.visible = true;
      }
      this.prevSelectedTargetId = selectedTargetId;
    }

    if (this.pickablesDirty) {
      this.pickables = [];
      for (const entry of this.lightEntries.values()) {
        this.pickables.push(
          entry.poleRefs.mastGroup,
          entry.poleRefs.armMesh,
          entry.poleRefs.gimbalGroup,
          entry.poleRefs.shieldGroup,
        );
      }
      for (const group of this.targetGroups.values()) {
        this.pickables.push(group);
      }
      for (const mesh of this.sidewalkMeshes) {
        this.pickables.push(mesh);
      }
      this.pickablesDirty = false;
    }

    if (fixturesChanged || thresholdChanged) {
      const pt = this.lastCursorProbePoint;
      if (pt) {
        const lux = computeIlluminanceAtPoint(pt, { x: 0, y: 1, z: 0 }, fixtures);
        this.emitStats(pt, lux);
      } else {
        this.emitStats(null, null);
      }
    }
    this.requestRender();
  }

  private buildSpotShieldGoboTexture(
    existing: THREE.DataTexture | null,
    shadowCam: THREE.PerspectiveCamera,
    fixture: LightFixture,
    shieldMask: number,
    hasCustomAngles: boolean,
  ): THREE.DataTexture {
    const size = 256;
    let tex = existing;
    if (!tex || tex.image.width !== size) {
      tex?.dispose();
      const buf = new Uint8Array(size * size * 4);
      tex = new THREE.DataTexture(buf, size, size, THREE.RGBAFormat);
      tex.minFilter = THREE.LinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.wrapS = THREE.ClampToEdgeWrapping;
      tex.wrapT = THREE.ClampToEdgeWrapping;
    }
    const data = tex.image.data as Uint8Array;
    const tanHalf = Math.tan(degToRad(clamp(shadowCam.fov * 0.5, 1, 78)));
    const camQuat = shadowCam.quaternion;

    let openCount = 0;
    if (shieldMask !== 0) {
      for (let s = 0; s < SHIELD_SECTORS; s++) {
        if (((shieldMask >> s) & 1) === 0) openCount++;
      }
    }
    const nadirOpen = shieldMask === 0 ? 1 : openCount / SHIELD_SECTORS;
    const nadirAngle = hasCustomAngles ? getNadirEffectiveAngle(fixture) : fixture.angleRange;
    const baseUnitCandela = hasCustomAngles ? computePeakCandela(1, fixture.angleRange) : 1;

    for (let y = 0; y < size; y++) {
      const ndcY = ((y + 0.5) / size) * 2 - 1;
      for (let x = 0; x < size; x++) {
        const ndcX = ((x + 0.5) / size) * 2 - 1;
        const lx = ndcX * tanHalf;
        const ly = ndcY * tanHalf;
        const cosTheta = 1 / Math.sqrt(1 + lx * lx + ly * ly);
        _vec3A.set(lx, ly, -1).applyQuaternion(camQuat);
        const horiz = Math.hypot(_vec3A.x, _vec3A.z);
        const azimDeg =
          horiz >= 0.015 ? (Math.atan2(_vec3A.x, -_vec3A.z) * 180) / Math.PI : 0;

        const shieldT =
          shieldMask === 0
            ? 1
            : horiz >= 0.015
              ? getShieldTransmittanceAtDeg(shieldMask, azimDeg)
              : nadirOpen;

        let t = shieldT;
        if (hasCustomAngles && t > 0) {
          const effAngle =
            horiz >= 0.015
              ? getEffectiveAngleAtDeg(fixture.angleRange, fixture.sectorAngles, azimDeg)
              : nadirAngle;
          const angular = computeAngularFactorFromDeg(cosTheta, effAngle);
          const candelaRatio =
            effAngle > fixture.angleRange
              ? Math.min(1, computePeakCandela(1, effAngle) / baseUnitCandela)
              : 1;
          t *= angular * candelaRatio;
        }

        const byte = Math.round(clamp(t, 0, 1) * 255);
        const idx = (y * size + x) * 4;
        data[idx] = byte;
        data[idx + 1] = byte;
        data[idx + 2] = byte;
        data[idx + 3] = 255;
      }
    }
    tex.needsUpdate = true;
    return tex;
  }

  private rebuildTrafficControllers(targets: StreetTarget[]): void {
    const controllers: TrafficController[] = [];
    const intersections = targets.filter(
      (t) => t.kind === 'road-intersection' || t.kind === 'road-t-junction',
    );

    for (const tl of targets) {
      if (tl.kind !== 'traffic-light') continue;
      let bestInt: StreetTarget | null = null;
      let bestDist = 11.5;
      for (const inter of intersections) {
        const d = Math.hypot(
          tl.position.x - inter.position.x,
          tl.position.z - inter.position.z,
        );
        if (d <= bestDist) {
          bestDist = d;
          bestInt = inter;
        }
      }

      const cx = bestInt ? bestInt.position.x : tl.position.x;
      const cz = bestInt ? bestInt.position.z : tl.position.z;
      const cos = Math.cos(tl.rotationY);
      const sin = Math.sin(tl.rotationY);
      const offset = ((cx * 0.14 + cz * 0.18) % 24 + 24) % 24;

      controllers.push({
        targetId: tl.id,
        cx,
        cz,
        axisZX: sin,
        axisZZ: cos,
        axisXX: cos,
        axisXZ: -sin,
        stopBarDist: bestInt
          ? bestInt.kind === 'road-t-junction'
            ? 3.05
            : 7.72
          : 3.2,
        cycleOffset: offset,
      });
    }

    this.trafficControllers = controllers;
  }

  private getTrafficSignalAspects(ctrl: TrafficController): {
    axisX: SignalAspect;
    axisZ: SignalAspect;
    remX: number;
    remZ: number;
  } {
    const cycle = 24.0;
    const t = (((this.trafficSignalClock + ctrl.cycleOffset) % cycle) + cycle) % cycle;
    if (t < 7.5) {
      return {
        axisX: 'green',
        axisZ: 'red',
        remX: Math.max(1, Math.ceil(7.5 - t)),
        remZ: Math.max(1, Math.ceil(12.0 - t)),
      };
    }
    if (t < 9.5) {
      return {
        axisX: 'yellow',
        axisZ: 'red',
        remX: Math.max(1, Math.ceil(9.5 - t)),
        remZ: Math.max(1, Math.ceil(12.0 - t)),
      };
    }
    if (t < 12.0) {
      return {
        axisX: 'red',
        axisZ: 'red',
        remX: Math.max(1, Math.ceil(24.0 - t)),
        remZ: Math.max(1, Math.ceil(12.0 - t)),
      };
    }
    if (t < 19.5) {
      return {
        axisX: 'red',
        axisZ: 'green',
        remX: Math.max(1, Math.ceil(24.0 - t)),
        remZ: Math.max(1, Math.ceil(19.5 - t)),
      };
    }
    if (t < 21.5) {
      return {
        axisX: 'red',
        axisZ: 'yellow',
        remX: Math.max(1, Math.ceil(24.0 - t)),
        remZ: Math.max(1, Math.ceil(21.5 - t)),
      };
    }
    return {
      axisX: 'red',
      axisZ: 'red',
      remX: Math.max(1, Math.ceil(24.0 - t)),
      remZ: Math.max(1, Math.ceil(36.0 - t)),
    };
  }

  private updateTrafficLightVisuals(): void {
    for (const ctrl of this.trafficControllers) {
      const { axisX, axisZ, remX, remZ } = this.getTrafficSignalAspects(ctrl);
      const changedAspect = ctrl.lastAspectX !== axisX || ctrl.lastAspectZ !== axisZ;
      const changedCountdownX = ctrl.lastAspectX !== axisX || ctrl.lastCountdownX !== remX;
      const changedCountdownZ = ctrl.lastAspectZ !== axisZ || ctrl.lastCountdownZ !== remZ;

      if (!changedAspect && !changedCountdownX && !changedCountdownZ) continue;

      const group = this.targetGroups.get(ctrl.targetId);
      if (!group) continue;
      const mats = group.userData.trafficSignalMaterials as
        | TrafficSignalMaterials
        | undefined;
      if (!mats) continue;

      if (changedAspect) {
        ctrl.lastAspectX = axisX;
        ctrl.lastAspectZ = axisZ;

        for (const m of mats.axisZ.red) m.emissiveIntensity = axisZ === 'red' ? 2.6 : 0.05;
        for (const m of mats.axisZ.yellow) m.emissiveIntensity = axisZ === 'yellow' ? 2.6 : 0.05;
        for (const m of mats.axisZ.green) m.emissiveIntensity = axisZ === 'green' ? 2.6 : 0.05;

        for (const m of mats.axisX.red) m.emissiveIntensity = axisX === 'red' ? 2.6 : 0.05;
        for (const m of mats.axisX.yellow) m.emissiveIntensity = axisX === 'yellow' ? 2.6 : 0.05;
        for (const m of mats.axisX.green) m.emissiveIntensity = axisX === 'green' ? 2.6 : 0.05;
      }

      if (changedCountdownX) {
        ctrl.lastCountdownX = remX;
        const texX = getTrafficCountdownTexture(axisX, remX);
        mats.axisX.countdown.map = texX;
        mats.axisX.countdown.emissiveMap = texX;
      }

      if (changedCountdownZ) {
        ctrl.lastCountdownZ = remZ;
        const texZ = getTrafficCountdownTexture(axisZ, remZ);
        mats.axisZ.countdown.map = texZ;
        mats.axisZ.countdown.emissiveMap = texZ;
      }
    }
  }

  private emitStats(
    cursorWorld: { x: number; y: number; z: number } | null,
    cursorLux: number | null,
  ): void {
    const active =
      this.currentFixtures.find((f) => f.id === this.selectedFixtureId) ??
      this.currentFixtures[0];

    const photometricsKey =
      `${active?.id ?? ''}:${this.currentLuxThreshold.toFixed(1)}:` +
      this.currentFixtures
        .map(
          (f) =>
            `${f.id},${f.enabled ? 1 : 0},${f.position.x.toFixed(2)},${f.position.z.toFixed(2)},${f.height.toFixed(2)},${f.tiltAngle},${f.yawAngle},${f.angleRange},${f.lumens},${f.shieldSectors ?? 0},${getSectorAnglesSignature(f.sectorAngles)}`,
        )
        .join('|');

    if (photometricsKey !== this.lastPhotometricsKey) {
      this.lastPhotometricsKey = photometricsKey;
      this.cachedPhotometrics = computeScenePhotometrics(
        this.currentFixtures,
        active,
        this.currentLuxThreshold,
      );
    }

    const metrics = this.cachedPhotometrics;
    const statsKey = `${photometricsKey}|${
      cursorWorld ? `${cursorWorld.x.toFixed(1)},${cursorWorld.z.toFixed(1)}` : 'none'
    }|${cursorLux !== null ? cursorLux.toFixed(1) : 'null'}`;
    if (statsKey === this.lastEmittedStatsKey) return;
    this.lastEmittedStatsKey = statsKey;

    this.callbacks.onStatsUpdate({
      cursorWorld,
      cursorLux,
      peakGroundLux: metrics.peakGroundLux,
      footprintAreaSqM: metrics.footprintAreaSqM,
      centerThrowDistM: metrics.centerThrowDistM,
    });
  }

  private afterDraw(cb: () => void): void {
    const gl = this.renderer.getContext() as WebGL2RenderingContext;
    const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
    const poll = () => {
      if (this.disposed) return;
      const state = sync && gl.getSyncParameter(sync, gl.SYNC_STATUS);
      if (state === gl.UNSIGNALED) {
        this.frameId = window.setTimeout(poll, 5);
      } else {
        if (sync) gl.deleteSync(sync);
        this.frameId = window.setTimeout(cb, 80);
      }
    };
    this.frameId = window.setTimeout(poll, 5);
  }

  private countSegmentBuildingHits(
    x1: number,
    z1: number,
    x2: number,
    z2: number,
    padding = 0.75,
    excludeTargetId?: string,
  ): number {
    let hits = 0;
    for (const t of this.currentTargets) {
      if (excludeTargetId && t.id === excludeTargetId) continue;
      if (t.motion || (isRoadOrPathKind(t.kind) && t.kind !== 'parking-lot') || t.kind === 'traffic-light') continue;
      const bDims =
        t.kind === 'parking-lot'
          ? { width: 12.8, length: 9.4 }
          : BUILDING_DEFAULT_DIMENSIONS[t.kind];
      if (!bDims) continue;
      const hw = (t.width ?? bDims.width) * 0.5 + padding;
      const hl = (t.length ?? bDims.length) * 0.5 + padding;
      const cosR = Math.cos(t.rotationY);
      const sinR = Math.sin(t.rotationY);
      const dx1 = x1 - t.position.x;
      const dz1 = z1 - t.position.z;
      const lx1 = dx1 * cosR - dz1 * sinR;
      const lz1 = dx1 * sinR + dz1 * cosR;
      const dx2 = x2 - t.position.x;
      const dz2 = z2 - t.position.z;
      const lx2 = dx2 * cosR - dz2 * sinR;
      const lz2 = dx2 * sinR + dz2 * cosR;

      let tMin = 0;
      let tMax = 1;
      const dlx = lx2 - lx1;
      const dlz = lz2 - lz1;
      if (Math.abs(dlx) < 1e-6) {
        if (lx1 < -hw || lx1 > hw) continue;
      } else {
        const inv = 1 / dlx;
        let t1 = (-hw - lx1) * inv;
        let t2 = (hw - lx1) * inv;
        if (t1 > t2) {
          const tmp = t1;
          t1 = t2;
          t2 = tmp;
        }
        tMin = Math.max(tMin, t1);
        tMax = Math.min(tMax, t2);
        if (tMin > tMax) continue;
      }
      if (Math.abs(dlz) < 1e-6) {
        if (lz1 < -hl || lz1 > hl) continue;
      } else {
        const inv = 1 / dlz;
        let t1 = (-hl - lz1) * inv;
        let t2 = (hl - lz1) * inv;
        if (t1 > t2) {
          const tmp = t1;
          t1 = t2;
          t2 = tmp;
        }
        tMin = Math.max(tMin, t1);
        tMax = Math.min(tMax, t2);
        if (tMin > tMax) continue;
      }
      hits++;
    }
    return hits;
  }

  private getOffRoadSteerDirection(
    actor: AnimatedActorState,
    goalX: number,
    goalZ: number,
  ): { dirX: number; dirZ: number } {
    const dx = goalX - actor.x;
    const dz = goalZ - actor.z;
    const dist = Math.hypot(dx, dz) || 1;
    let moveX = dx / dist;
    let moveZ = dz / dist;
    const myHalfW = getActorHalfWidth(actor.kind);
    const probeX = actor.x + moveX * Math.min(dist, 2.2);
    const probeZ = actor.z + moveZ * Math.min(dist, 2.2);

    for (const prop of this.currentTargets) {
      if (
        prop.motion ||
        (isRoadOrPathKind(prop.kind) && prop.kind !== 'parking-lot') ||
        prop.kind === 'traffic-light'
      ) {
        continue;
      }
      const bDims =
        prop.kind === 'parking-lot'
          ? { width: 12.8, length: 9.4 }
          : BUILDING_DEFAULT_DIMENSIONS[prop.kind];
      if (bDims) {
        const hw = (prop.width ?? bDims.width) * 0.5 + myHalfW + 1.05;
        const hl = (prop.length ?? bDims.length) * 0.5 + myHalfW + 1.05;
        const cosR = Math.cos(prop.rotationY);
        const sinR = Math.sin(prop.rotationY);

        const rx = actor.x - prop.position.x;
        const rz = actor.z - prop.position.z;
        const lx = rx * cosR - rz * sinR;
        const lz = rx * sinR + rz * cosR;

        const prx = probeX - prop.position.x;
        const prz = probeZ - prop.position.z;
        const plx = prx * cosR - prz * sinR;
        const plz = prx * sinR + prz * cosR;

        const insideNow = Math.abs(lx) < hw && Math.abs(lz) < hl;
        const insideProbe = Math.abs(plx) < hw && Math.abs(plz) < hl;
        if (insideNow || insideProbe) {
          const refLx = insideNow ? lx : plx;
          const refLz = insideNow ? lz : plz;
          const penX = hw - Math.abs(refLx);
          const penZ = hl - Math.abs(refLz);
          const gdx = goalX - prop.position.x;
          const gdz = goalZ - prop.position.z;
          const glx = gdx * cosR - gdz * sinR;
          const glz = gdx * sinR + gdz * cosR;
          let pushLX = 0;
          let pushLZ = 0;
          if (penX < penZ) {
            pushLX = (refLx >= 0 ? 1 : -1) * (insideNow ? Math.min(1.5, 0.5 + penX * 1.4) : 0.7);
            const slideDir = Math.abs(refLz) > 0.35 ? (refLz >= 0 ? 1 : -1) : glz >= 0 ? 1 : -1;
            pushLZ = slideDir * 1.15;
          } else {
            pushLZ = (refLz >= 0 ? 1 : -1) * (insideNow ? Math.min(1.5, 0.5 + penZ * 1.4) : 0.7);
            const slideDir = Math.abs(refLx) > 0.35 ? (refLx >= 0 ? 1 : -1) : glx >= 0 ? 1 : -1;
            pushLX = slideDir * 1.15;
          }
          moveX += pushLX * cosR + pushLZ * sinR;
          moveZ += -pushLX * sinR + pushLZ * cosR;
        }
        continue;
      }

      if (prop.kind === 'tree') {
        const minClear = 1.65 + myHalfW;
        const ox = actor.x - prop.position.x;
        const oz = actor.z - prop.position.z;
        const od = Math.hypot(ox, oz);
        if (od > 0.05 && od < minClear) {
          const push = ((minClear - od) / minClear) * 1.1;
          moveX += (ox / od) * push;
          moveZ += (oz / od) * push;
        }
      }
    }

    const mLen = Math.hypot(moveX, moveZ) || 1;
    return { dirX: moveX / mLen, dirZ: moveZ / mLen };
  }

  private assignInitialGraphRoute(actor: AnimatedActorState): void {
    actor.graphNodeId = undefined;
    actor.subPath = undefined;
    actor.subPathIdx = 0;
    actor.seekingRoad = false;
    const { nodes, edges } = this.roadGraph;
    if (nodes.length === 0) return;

    const fx = Math.cos(actor.rotationY);
    const fz = -Math.sin(actor.rotationY);
    const onRoad = isPointInsideAnyRoadway(actor.x, actor.z, this.modularRoadEntries);
    const candidates: Array<{ edge: RoadGraphEdge; subIdx: number; score: number }> = [];
    let bestScore = Infinity;

    let bestSeek: {
      edge: RoadGraphEdge;
      subIdx: number;
      projX: number;
      projZ: number;
      score: number;
    } | null = null;
    const myHalfW = getActorHalfWidth(actor.kind);

    for (let uId = 0; uId < nodes.length; uId++) {
      const startNode = nodes[uId];
      const outEdges = edges[uId];
      for (const edge of outEdges) {
        if (edge.isWrap || edge.isUTurn || edge.points.length === 0) continue;
        let prevX = startNode.x;
        let prevZ = startNode.z;
        for (let pIdx = 0; pIdx < edge.points.length; pIdx++) {
          const pt = edge.points[pIdx];
          const abX = pt.x - prevX;
          const abZ = pt.z - prevZ;
          const lenSq = abX * abX + abZ * abZ;
          if (lenSq > 1e-4) {
            const len = Math.sqrt(lenSq);
            const t = clamp(
              ((actor.x - prevX) * abX + (actor.z - prevZ) * abZ) / lenSq,
              0,
              1,
            );
            const projX = prevX + abX * t;
            const projZ = prevZ + abZ * t;
            const dist = Math.hypot(actor.x - projX, actor.z - projZ);
            const align = (abX / len) * fx + (abZ / len) * fz;

            if (dist <= (onRoad ? 6.5 : 3.0) && align >= 0.35) {
              const score = dist + (1 - align) * 3.5;
              if (score < bestScore) bestScore = score;
              candidates.push({ edge, subIdx: pIdx, score });
            }

            if (!onRoad || candidates.length === 0) {
              const buildingPenalty =
                this.countSegmentBuildingHits(actor.x, actor.z, projX, projZ, myHalfW + 0.55) * 28.0;
              const seekScore = dist + buildingPenalty + (1 - align) * 0.75;
              if (!bestSeek || seekScore < bestSeek.score) {
                bestSeek = { edge, subIdx: pIdx, projX, projZ, score: seekScore };
              }
            }
          }
          prevX = pt.x;
          prevZ = pt.z;
        }
      }
    }

    if (candidates.length > 0 && (onRoad || bestScore <= 3.0)) {
      const nearBest = candidates.filter((c) => c.score <= bestScore + 1.25);
      const chosen = nearBest[Math.floor(Math.random() * nearBest.length)];
      actor.graphNodeId = chosen.edge.toNodeId;
      actor.subPath = chosen.edge.points;
      actor.subPathIdx = chosen.subIdx;
      actor.seekingRoad = false;
      return;
    }

    if (bestSeek) {
      const remaining = bestSeek.edge.points.slice(bestSeek.subIdx);
      const firstRem = remaining[0];
      const needEntryPt =
        !firstRem ||
        Math.hypot(firstRem.x - bestSeek.projX, firstRem.z - bestSeek.projZ) > 0.65;
      actor.graphNodeId = bestSeek.edge.toNodeId;
      actor.subPath = needEntryPt
        ? [{ x: bestSeek.projX, z: bestSeek.projZ }, ...remaining]
        : remaining;
      actor.subPathIdx = 0;
      actor.seekingRoad = true;
    }
  }

  private clearActorParkingState(actor: AnimatedActorState): void {
    actor.parkingPhase = undefined;
    actor.parkingLotId = undefined;
    actor.parkingStallIdx = undefined;
    actor.parkingStallYaw = undefined;
    actor.parkingExitAisleYaw = undefined;
    actor.parkingDwellTimer = undefined;
    actor.parkingPlannedEdges = undefined;
    actor.parkingApproachTrimmedPoints = undefined;
    actor.parkingOnFinalEdge = undefined;
    actor.parkingEntryWaypoints = undefined;
    actor.parkingReverseWaypoints = undefined;
    actor.parkingReverseIdx = undefined;
    actor.parkingReverseSegDist = undefined;
    actor.parkingReverseStartYaw = undefined;
    actor.parkingExitRejoinSubIdx = undefined;
    actor.parkingLotPose = undefined;
  }

  private updateRoadDrivewayCurbs(targets: StreetTarget[]): void {
    const lots = targets.filter((t) => t.kind === 'parking-lot');
    for (const road of targets) {
      if (road.kind !== 'road-2lane') continue;
      const roadGroup = this.targetGroups.get(road.id);
      if (!roadGroup) continue;

      const prevCutGroup = roadGroup.userData.curbCutGroup as THREE.Group | undefined;
      if (prevCutGroup) {
        roadGroup.remove(prevCutGroup);
        prevCutGroup.traverse((child) => {
          if (child instanceof THREE.Mesh && child.geometry) {
            child.geometry.dispose();
          }
        });
        roadGroup.userData.curbCutGroup = undefined;
      }

      const rCos = Math.cos(road.rotationY);
      const rSin = Math.sin(road.rotationY);
      const halfL = road.length && road.length > 0 ? road.length * 0.5 : 4.0;

      const curbMeshes: THREE.Mesh[] = [];
      for (const child of roadGroup.children) {
        if (child instanceof THREE.Mesh && child.userData.roadCurbSide !== undefined) {
          curbMeshes.push(child);
        }
      }
      if (curbMeshes.length === 0) continue;

      let newCutGroup: THREE.Group | undefined;

      for (const curb of curbMeshes) {
        const side = curb.userData.roadCurbSide as number;
        const curbLz = side * 4.62;
        const cuts: Array<[number, number]> = [];

        for (const lot of lots) {
          const corners: Array<[number, number]> = [
            [-2.06, 4.5],
            [2.06, 4.5],
            [-2.06, 7.7],
            [2.06, 7.7],
          ];
          let minLx = Infinity;
          let maxLx = -Infinity;
          let minLz = Infinity;
          let maxLz = -Infinity;
          for (const [cx, cz] of corners) {
            const w = this.toLotWorld(lot, cx, cz);
            const dx = w.x - road.position.x;
            const dz = w.z - road.position.z;
            const rlx = dx * rCos - dz * rSin;
            const rlz = dx * rSin + dz * rCos;
            if (rlx < minLx) minLx = rlx;
            if (rlx > maxLx) maxLx = rlx;
            if (rlz < minLz) minLz = rlz;
            if (rlz > maxLz) maxLz = rlz;
          }
          if (minLz <= curbLz + 0.35 && maxLz >= curbLz - 0.35) {
            const c0 = Math.max(-halfL, minLx);
            const c1 = Math.min(halfL, maxLx);
            if (c1 - c0 > 0.05) {
              cuts.push([c0, c1]);
            }
          }
        }

        if (cuts.length === 0) {
          curb.visible = true;
          continue;
        }

        curb.visible = false;
        cuts.sort((a, b) => a[0] - b[0]);
        const merged: Array<[number, number]> = [];
        for (const interval of cuts) {
          const last = merged[merged.length - 1];
          if (last && interval[0] <= last[1] + 0.02) {
            last[1] = Math.max(last[1], interval[1]);
          } else {
            merged.push([interval[0], interval[1]]);
          }
        }

        if (!newCutGroup) {
          newCutGroup = new THREE.Group();
          roadGroup.add(newCutGroup);
          roadGroup.userData.curbCutGroup = newCutGroup;
        }

        let cursor = -halfL;
        for (const [c0, c1] of merged) {
          if (c0 - cursor > 0.05) {
            const segW = c0 - cursor;
            const mesh = new THREE.Mesh(new THREE.BoxGeometry(segW, 0.135, 0.24), curb.material);
            mesh.position.set(cursor + segW * 0.5, 0.0675, curbLz);
            mesh.receiveShadow = true;
            newCutGroup.add(mesh);
          }
          cursor = Math.max(cursor, c1);
        }
        if (halfL - cursor > 0.05) {
          const segW = halfL - cursor;
          const mesh = new THREE.Mesh(new THREE.BoxGeometry(segW, 0.135, 0.24), curb.material);
          mesh.position.set(cursor + segW * 0.5, 0.0675, curbLz);
          mesh.receiveShadow = true;
          newCutGroup.add(mesh);
        }
      }
    }
  }

  private toLotWorld(
    lot: StreetTarget,
    lx: number,
    lz: number,
  ): { x: number; z: number } {
    const cosL = Math.cos(lot.rotationY);
    const sinL = Math.sin(lot.rotationY);
    return {
      x: lot.position.x + lx * cosL + lz * sinL,
      z: lot.position.z - lx * sinL + lz * cosL,
    };
  }

  private findNearestRoadConnectionForLot(
    lot: StreetTarget,
    myHalfW: number,
    forwardBiasSign: -1 | 1,
  ): {
    fromNodeId: number;
    edge: RoadGraphEdge;
    pIdx: number;
    point: { x: number; z: number };
    distMouth: number;
  } | null {
    const { nodes, edges } = this.roadGraph;
    if (nodes.length === 0) return null;

    const mouth = this.toLotWorld(lot, 0, 5.1);
    const apronApproach = this.toLotWorld(lot, 0, 6.8);
    let best: {
      fromNodeId: number;
      edge: RoadGraphEdge;
      pIdx: number;
      point: { x: number; z: number };
      distMouth: number;
      score: number;
    } | null = null;

    for (let uId = 0; uId < nodes.length; uId++) {
      const startNode = nodes[uId];
      const outEdges = edges[uId];
      for (const edge of outEdges) {
        if (edge.isWrap || edge.isUTurn || edge.points.length === 0) continue;
        let prevX = startNode.x;
        let prevZ = startNode.z;
        for (let pIdx = 0; pIdx < edge.points.length; pIdx++) {
          const pt = edge.points[pIdx];
          const abX = pt.x - prevX;
          const abZ = pt.z - prevZ;
          const lenSq = abX * abX + abZ * abZ;
          if (lenSq > 1e-4) {
            const len = Math.sqrt(lenSq);
            const rawT = clamp(
              ((mouth.x - prevX) * abX + (mouth.z - prevZ) * abZ) / lenSq,
              0,
              1,
            );
            const projX = prevX + abX * rawT;
            const projZ = prevZ + abZ * rawT;
            const distMouth = Math.hypot(projX - mouth.x, projZ - mouth.z);
            if (distMouth <= 15.0) {
              const biasedT = clamp(rawT + (forwardBiasSign * 1.2) / len, 0.04, 0.96);
              const px = prevX + abX * biasedT;
              const pz = prevZ + abZ * biasedT;

              let insideIntersection = false;
              for (const inter of this.intersectionEntries) {
                if (Math.hypot(px - inter.x, pz - inter.z) < 5.5) {
                  insideIntersection = true;
                  break;
                }
              }
              if (
                !insideIntersection &&
                this.countSegmentBuildingHits(
                  px,
                  pz,
                  apronApproach.x,
                  apronApproach.z,
                  myHalfW + 0.35,
                  lot.id,
                ) === 0
              ) {
                const score = distMouth;
                if (!best || score < best.score) {
                  best = {
                    fromNodeId: uId,
                    edge,
                    pIdx,
                    point: { x: px, z: pz },
                    distMouth,
                    score,
                  };
                }
              }
            }
          }
          prevX = pt.x;
          prevZ = pt.z;
        }
      }
    }

    return best;
  }

  private tryAssignParkingTrip(actorId: string, actor: AnimatedActorState): boolean {
    if (
      actor.motion !== 'drive' ||
      (actor.kind !== 'sedan' && actor.kind !== 'van') ||
      actor.seekingRoad ||
      actor.parkingPhase !== undefined ||
      actor.graphNodeId === undefined
    ) {
      return false;
    }

    const { nodes, edges } = this.roadGraph;
    const nNodes = nodes.length;
    if (nNodes === 0 || actor.graphNodeId >= nNodes) return false;

    const lots = this.currentTargets.filter((t) => t.kind === 'parking-lot');
    if (lots.length === 0) return false;

    const reservedStalls = new Set<string>();
    for (const [otherId, other] of this.animatedActors.entries()) {
      if (otherId === actorId) continue;
      if (other.parkingPhase && other.parkingLotId && other.parkingStallIdx !== undefined) {
        reservedStalls.add(`${other.parkingLotId}::${other.parkingStallIdx}`);
      }
    }

    // Dijkstra shortest paths on roadGraph starting from actor.graphNodeId
    const dist = new Float64Array(nNodes).fill(Infinity);
    const parentNode = new Int32Array(nNodes).fill(-1);
    const parentEdge: Array<RoadGraphEdge | null> = new Array(nNodes).fill(null);
    const visited = new Uint8Array(nNodes);
    dist[actor.graphNodeId] = 0;

    for (let iter = 0; iter < nNodes; iter++) {
      let u = -1;
      let bestD = Infinity;
      for (let i = 0; i < nNodes; i++) {
        if (!visited[i] && dist[i] < bestD) {
          bestD = dist[i];
          u = i;
        }
      }
      if (u < 0 || bestD === Infinity) break;
      visited[u] = 1;

      const uNode = nodes[u];
      for (const edge of edges[u]) {
        let edgeCost = 0;
        if (edge.isWrap) {
          edgeCost = 5.0;
        } else {
          let px = uNode.x;
          let pz = uNode.z;
          for (const pt of edge.points) {
            edgeCost += Math.hypot(pt.x - px, pt.z - pz);
            px = pt.x;
            pz = pt.z;
          }
          if (edge.isUTurn) edgeCost += 500;
        }
        const cand = bestD + edgeCost;
        if (cand < dist[edge.toNodeId]) {
          dist[edge.toNodeId] = cand;
          parentNode[edge.toNodeId] = u;
          parentEdge[edge.toNodeId] = edge;
        }
      }
    }

    const myHalfW = getActorHalfWidth(actor.kind);
    const candidates: Array<{
      lot: StreetTarget;
      stall: ParkingStallSpec;
      conn: NonNullable<ReturnType<StreetSimulatorScene['findNearestRoadConnectionForLot']>>;
      score: number;
    }> = [];

    for (const lot of lots) {
      const openStalls = getParkingLotOpenStalls(lot.id).filter(
        (s) => !reservedStalls.has(`${lot.id}::${s.idx}`),
      );
      if (openStalls.length === 0) continue;

      const conn = this.findNearestRoadConnectionForLot(lot, myHalfW, -1);
      if (!conn || dist[conn.fromNodeId] === Infinity) continue;

      // Prefer stalls sorted closer to front/middle if multiple stalls are open
      const chosenStall =
        openStalls.find((s) => s.z >= -0.5) ??
        openStalls[Math.floor(Math.random() * openStalls.length)];

      candidates.push({
        lot,
        stall: chosenStall,
        conn,
        score: dist[conn.fromNodeId] + conn.distMouth * 4.0 + Math.random() * 12.0,
      });
    }

    if (candidates.length === 0) return false;
    candidates.sort((a, b) => a.score - b.score);
    const picked = candidates[0];

    const plannedEdges: RoadGraphEdge[] = [];
    let cur = picked.conn.fromNodeId;
    let guard = 0;
    while (cur !== actor.graphNodeId && guard < nNodes + 2) {
      const pe = parentEdge[cur];
      const pn = parentNode[cur];
      if (!pe || pn < 0) {
        return false;
      }
      plannedEdges.push(pe);
      cur = pn;
      guard++;
    }
    plannedEdges.reverse();
    plannedEdges.push(picked.conn.edge);

    const { lot, stall, conn } = picked;
    const signX = stall.x >= 0 ? 1 : -1;
    const stallDepth = actor.kind === 'van' ? 3.55 : 3.85;
    const entryWaypoints: Array<{ x: number; z: number }> = [
      this.toLotWorld(lot, 0, 6.8),
      this.toLotWorld(lot, 0, 4.6),
    ];
    if (stall.z < 1.5) {
      entryWaypoints.push(this.toLotWorld(lot, 0, stall.z + 2.1));
    }
    entryWaypoints.push(
      this.toLotWorld(lot, -0.28 * signX, stall.z + 0.95),
      this.toLotWorld(lot, 1.45 * signX, stall.z + 0.12),
      this.toLotWorld(lot, stallDepth * signX, stall.z),
    );

    const trimmedPoints = [...conn.edge.points.slice(0, conn.pIdx), conn.point];

    actor.parkingPhase = 'approaching-lot';
    actor.parkingLotId = lot.id;
    actor.parkingStallIdx = stall.idx;
    actor.parkingStallYaw = stall.inwardYaw + lot.rotationY;
    actor.parkingExitAisleYaw = Math.atan2(-Math.cos(lot.rotationY), Math.sin(lot.rotationY));
    actor.parkingLotPose = {
      x: lot.position.x,
      z: lot.position.z,
      rotationY: lot.rotationY,
    };
    actor.parkingPlannedEdges = plannedEdges;
    actor.parkingApproachTrimmedPoints = trimmedPoints;
    actor.parkingOnFinalEdge = false;
    actor.parkingEntryWaypoints = entryWaypoints;
    actor.roundaboutTargetSteps = 1;
    return true;
  }

  private getWrapEdgeForNode(nodeId: number | undefined): RoadGraphEdge | null {
    if (nodeId === undefined) return null;
    const outEdges = this.roadGraph.edges[nodeId];
    if (!outEdges || outEdges.length === 0) return null;
    const wrapEdge = outEdges.find((e) => e.isWrap);
    if (!wrapEdge) return null;
    const hasRegularExit = outEdges.some((e) => !e.isWrap && !e.isUTurn);
    return hasRegularExit ? null : wrapEdge;
  }

  private resolveWrapPlacement(
    actorId: string,
    actor: AnimatedActorState,
    destNodeId: number,
  ): { clear: boolean; x: number; z: number } {
    const { nodes, edges } = this.roadGraph;
    const dest = nodes[destNodeId];
    if (!dest) return { clear: false, x: actor.x, z: actor.z };

    const myHalfW = getActorHalfWidth(actor.kind);
    let maxOutSegLen = 8.0;
    const destOutEdges = edges[destNodeId];
    if (destOutEdges && destOutEdges.length > 0 && destOutEdges[0].points.length > 0) {
      let px = dest.x;
      let pz = dest.z;
      let len = 0;
      for (const pt of destOutEdges[0].points) {
        len += Math.hypot(pt.x - px, pt.z - pz);
        px = pt.x;
        pz = pt.z;
      }
      if (len > 0.1) maxOutSegLen = len;
    }

    let maxStopInset = Infinity;
    for (const ctrl of this.trafficControllers) {
      const relX = ctrl.cx - dest.x;
      const relZ = ctrl.cz - dest.z;
      const fwdToInt = relX * dest.dirX + relZ * dest.dirZ;
      if (fwdToInt <= 0 || fwdToInt >= 26.0) continue;
      const latToInt = Math.abs(relX * -dest.dirZ + relZ * dest.dirX);
      if (latToInt > 4.25) continue;
      const roomBeforeBar = fwdToInt - ctrl.stopBarDist - actor.halfLen - 0.35;
      if (roomBeforeBar < maxStopInset) maxStopInset = roomBeforeBar;
    }

    const idealInset = clamp(
      Math.min(actor.halfLen, maxOutSegLen - 0.65, maxStopInset),
      0,
      actor.halfLen,
    );
    const candidateInsets: number[] = [];
    if (idealInset > 0.25) candidateInsets.push(idealInset);
    if (idealInset > 1.2) candidateInsets.push(idealInset * 0.5);
    candidateInsets.push(0);

    const isSpawnClearAt = (sx: number, sz: number): boolean => {
      for (const t of this.vehicleTargets) {
        if (t.id === actorId) continue;
        const other = this.animatedActors.get(t.id);
        if (other?.parkingPhase === 'parked') continue;
        const ox = other ? other.x : t.position.x;
        const oz = other ? other.z : t.position.z;
        const oRotY = other ? other.rotationY : t.rotationY;
        const ofx = Math.cos(oRotY);
        const ofz = -Math.sin(oRotY);
        const otherHalfLen = other ? other.halfLen : getActorHalfLength(t.kind);
        const otherHalfW = getActorHalfWidth(t.kind);

        const dx = ox - sx;
        const dz = oz - sz;
        const relFwd = dx * dest.dirX + dz * dest.dirZ;
        const lat = Math.abs(dx * -dest.dirZ + dz * dest.dirX);

        const dotH = dest.dirX * ofx + dest.dirZ * ofz;
        const sinH = Math.sqrt(Math.max(0, 1 - dotH * dotH));
        const oProjL = otherHalfLen * Math.abs(dotH) + otherHalfW * sinH;
        const oProjW = otherHalfLen * sinH + otherHalfW * Math.abs(dotH);

        if (lat < myHalfW + oProjW + 0.45) {
          const minClearFront = actor.halfLen + oProjL + 0.85;
          const minClearRear = actor.halfLen + oProjL + 0.6;
          if (relFwd > -minClearRear && relFwd < minClearFront) {
            return false;
          }
        }
      }
      return true;
    };

    for (const inset of candidateInsets) {
      const sx = dest.x + dest.dirX * inset;
      const sz = dest.z + dest.dirZ * inset;
      if (isSpawnClearAt(sx, sz)) {
        return { clear: true, x: sx, z: sz };
      }
    }
    return { clear: false, x: dest.x, z: dest.z };
  }

  private pickNextGraphEdge(
    actorId: string,
    actor: AnimatedActorState,
    nodeId: number,
  ): { edge: RoadGraphEdge | null; waitForWrap: boolean; wrapPos?: { x: number; z: number } } {
    const { edges } = this.roadGraph;
    const outEdges = edges[nodeId];
    if (!outEdges || outEdges.length === 0) {
      return { edge: null, waitForWrap: false };
    }

    const wrapPlacements = new Map<number, { clear: boolean; x: number; z: number }>();
    const getPlacement = (destId: number) => {
      let res = wrapPlacements.get(destId);
      if (!res) {
        res = this.resolveWrapPlacement(actorId, actor, destId);
        wrapPlacements.set(destId, res);
      }
      return res;
    };

    const usable = outEdges.filter(
      (e) => !e.isWrap || getPlacement(e.toNodeId).clear,
    );

    if (
      actor.parkingPhase === 'approaching-lot' &&
      actor.parkingPlannedEdges &&
      actor.parkingPlannedEdges.length > 0
    ) {
      const nextPlanned = actor.parkingPlannedEdges[0];
      if (outEdges.includes(nextPlanned)) {
        if (nextPlanned.isWrap) {
          const placement = getPlacement(nextPlanned.toNodeId);
          if (!placement.clear) {
            return { edge: null, waitForWrap: true };
          }
          actor.parkingPlannedEdges.shift();
          return {
            edge: nextPlanned,
            waitForWrap: false,
            wrapPos: { x: placement.x, z: placement.z },
          };
        }
        actor.parkingPlannedEdges.shift();
        if (actor.parkingPlannedEdges.length === 0 && actor.parkingApproachTrimmedPoints) {
          actor.parkingOnFinalEdge = true;
          return {
            edge: {
              ...nextPlanned,
              points: actor.parkingApproachTrimmedPoints,
            },
            waitForWrap: false,
          };
        }
        return { edge: nextPlanned, waitForWrap: false };
      }
      this.clearActorParkingState(actor);
    }

    const nonUTurn = usable.filter((e) => !e.isUTurn);
    let pool = nonUTurn.length > 0 ? nonUTurn : usable;
    if (pool.length === 0) {
      return { edge: null, waitForWrap: outEdges.some((e) => e.isWrap) };
    }

    const maxLoopSteps = actor.roundaboutTargetSteps ?? 3;
    const exitEdges = pool.filter((e) => e.isRoundaboutExit);
    if ((actor.roundaboutSteps ?? 0) >= maxLoopSteps && exitEdges.length > 0) {
      pool = exitEdges;
    }

    let totalWeight = 0;
    for (const e of pool) totalWeight += e.weight;
    let r = Math.random() * totalWeight;
    let picked = pool[pool.length - 1];
    for (const e of pool) {
      r -= e.weight;
      if (r <= 0) {
        picked = e;
        break;
      }
    }
    if (picked.isWrap) {
      const placement = getPlacement(picked.toNodeId);
      return {
        edge: picked,
        waitForWrap: false,
        wrapPos: { x: placement.x, z: placement.z },
      };
    }
    return { edge: picked, waitForWrap: false };
  }

  private isPointBlockedForPedestrian(px: number, pz: number): boolean {
    if (Math.abs(px) > MAP_HALF_X - 1.0 || Math.abs(pz) > MAP_HALF_Z - 1.0) return true;
    for (const t of this.currentTargets) {
      if (
        t.motion ||
        (isRoadOrPathKind(t.kind) && t.kind !== 'parking-lot') ||
        t.kind === 'traffic-light'
      ) {
        continue;
      }
      const bDims =
        t.kind === 'parking-lot'
          ? { width: 12.8, length: 9.4 }
          : BUILDING_DEFAULT_DIMENSIONS[t.kind];
      if (bDims) {
        const hw = (t.width ?? bDims.width) * 0.5 + 0.55;
        const hl = (t.length ?? bDims.length) * 0.5 + 0.55;
        const dx = px - t.position.x;
        const dz = pz - t.position.z;
        const cosR = Math.cos(t.rotationY);
        const sinR = Math.sin(t.rotationY);
        const lx = dx * cosR - dz * sinR;
        const lz = dx * sinR + dz * cosR;
        if (Math.abs(lx) < hw && Math.abs(lz) < hl) return true;
        continue;
      }
      const rad =
        t.kind === 'tree'
          ? 1.5
          : t.kind === 'hedge' || t.kind === 'bench'
            ? 1.35
            : 0.9;
      if (Math.hypot(px - t.position.x, pz - t.position.z) < rad) return true;
    }
    return false;
  }

  private initPedestrianWalk(actor: AnimatedActorState): void {
    actor.walkCurrNodeId = undefined;
    actor.walkPrevNodeId = undefined;
    actor.walkGoalX = undefined;
    actor.walkGoalZ = undefined;
    actor.walkIsCrosswalk = false;
    actor.crossingCurbPaused = false;
    actor.seekingSidewalk = false;

    const onSidewalk = isPointOnSidewalkSegment(actor.x, actor.z, this.currentTargets);
    const onRoadNow = this.isOnCrosswalkArea(actor.x, actor.z);

    // Automatically generate or activate a 'Crossing' animation path when placed on a
    // sidewalk segment near a road-crosswalk tile (approach -> pause at curb -> cross).
    if (onSidewalk && !onRoadNow) {
      const hasValidWaypoints =
        actor.routeId === 'Crossing' &&
        actor.crossingWaypoints &&
        actor.crossingWaypoints.length > 0 &&
        (actor.crossingStepIdx ?? 0) < actor.crossingWaypoints.length;
      const crossingPlan = hasValidWaypoints
        ? actor.crossingWaypoints
        : generatePedestrianCrossingPath(
            { x: actor.x, z: actor.z },
            this.currentTargets,
          );
      if (crossingPlan && crossingPlan.length > 0) {
        actor.crossingWaypoints = crossingPlan.map((wp) => ({ ...wp }));
        actor.crossingStepIdx = 0;
        actor.crossingCurbPaused = false;
        actor.walkPauseTimer = 0;
        actor.walkGoalX = actor.crossingWaypoints[0].x;
        actor.walkGoalZ = actor.crossingWaypoints[0].z;
        actor.walkIsCrosswalk = actor.crossingWaypoints[0].action === 'cross';
        return;
      }
    }
    actor.crossingWaypoints = undefined;
    actor.crossingStepIdx = 0;

    const nodes = this.walkGraph.nodes;
    if (nodes.length > 0) {
      if (onSidewalk && !onRoadNow) {
        let bestId = -1;
        let bestDist = 4.5;
        for (const n of nodes) {
          if (this.walkGraph.edges[n.id].length === 0) continue;
          const d = Math.hypot(n.x - actor.x, n.z - actor.z);
          if (d < bestDist) {
            // Ensure acquiring the starting sidewalk node doesn't step across an unmarked road
            const mx = (actor.x + n.x) * 0.5;
            const mz = (actor.z + n.z) * 0.5;
            if (!isPointInsideAnyRoadway(mx, mz, this.modularRoadEntries)) {
              bestDist = d;
              bestId = n.id;
            }
          }
        }
        if (bestId >= 0) {
          actor.walkCurrNodeId = bestId;
          this.pickNextWalkTarget(actor);
          return;
        }
      }

      // Not on a sidewalk (or on a long sidewalk segment >4.5m from a node):
      // seek the nearest point along any sidewalk edge in the walk graph.
      let bestSeek: {
        px: number;
        pz: number;
        nodeA: number;
        nodeB: number;
        t: number;
        score: number;
      } | null = null;

      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i];
        const out = this.walkGraph.edges[i];
        for (const e of out) {
          if (e.isCrosswalk || e.toNodeId < i) continue;
          const b = nodes[e.toNodeId];
          const abX = b.x - a.x;
          const abZ = b.z - a.z;
          const lenSq = abX * abX + abZ * abZ;
          const t =
            lenSq > 1e-4
              ? clamp(((actor.x - a.x) * abX + (actor.z - a.z) * abZ) / lenSq, 0, 1)
              : 0;
          const px = a.x + abX * t;
          const pz = a.z + abZ * t;
          const dist = Math.hypot(px - actor.x, pz - actor.z);

          let roadPenalty = 0;
          if (!onRoadNow) {
            for (const u of [0.25, 0.5, 0.75]) {
              const sx = actor.x + (px - actor.x) * u;
              const sz = actor.z + (pz - actor.z) * u;
              if (isPointInsideAnyRoadway(sx, sz, this.modularRoadEntries)) {
                roadPenalty = 24.0;
                break;
              }
            }
          }
          const buildingPenalty =
            this.countSegmentBuildingHits(actor.x, actor.z, px, pz, 0.55) * 8.5;
          const score = dist + roadPenalty + buildingPenalty;
          if (!bestSeek || score < bestSeek.score) {
            bestSeek = { px, pz, nodeA: a.id, nodeB: b.id, t, score };
          }
        }
      }

      if (!bestSeek) {
        for (const n of nodes) {
          const dist = Math.hypot(n.x - actor.x, n.z - actor.z);
          let roadPenalty = 0;
          if (!onRoadNow) {
            const mx = (actor.x + n.x) * 0.5;
            const mz = (actor.z + n.z) * 0.5;
            if (isPointInsideAnyRoadway(mx, mz, this.modularRoadEntries)) {
              roadPenalty = 24.0;
            }
          }
          const buildingPenalty =
            this.countSegmentBuildingHits(actor.x, actor.z, n.x, n.z, 0.55) * 8.5;
          const score = dist + roadPenalty + buildingPenalty;
          if (!bestSeek || score < bestSeek.score) {
            bestSeek = { px: n.x, pz: n.z, nodeA: n.id, nodeB: n.id, t: 0, score };
          }
        }
      }

      if (bestSeek) {
        const targetNode = bestSeek.t <= 0.5 ? bestSeek.nodeB : bestSeek.nodeA;
        const prevNode = bestSeek.t <= 0.5 ? bestSeek.nodeA : bestSeek.nodeB;
        if (onSidewalk && !onRoadNow) {
          actor.walkCurrNodeId = targetNode;
          actor.walkPrevNodeId = prevNode;
          actor.walkGoalX = nodes[targetNode].x;
          actor.walkGoalZ = nodes[targetNode].z;
          actor.walkIsCrosswalk = false;
          actor.seekingSidewalk = false;
        } else {
          actor.walkCurrNodeId = targetNode;
          actor.walkPrevNodeId = prevNode;
          actor.walkGoalX = bestSeek.px;
          actor.walkGoalZ = bestSeek.pz;
          actor.walkIsCrosswalk = false;
          actor.walkPauseTimer = 0;
          actor.seekingSidewalk = true;
        }
        return;
      }
    }

    this.pickRandomFreeWalkTarget(actor);
  }

  private transitionAfterCrossingPath(actor: AnimatedActorState): void {
    actor.crossingWaypoints = undefined;
    actor.crossingStepIdx = 0;
    actor.crossingCurbPaused = false;
    actor.walkIsCrosswalk = false;

    const nodes = this.walkGraph.nodes;
    let bestId = -1;
    let bestDist = 2.6;
    for (const n of nodes) {
      const outEdges = this.walkGraph.edges[n.id];
      const hasSidewalkContinuation = outEdges.some((e) => !e.isCrosswalk);
      if (!hasSidewalkContinuation) continue;
      const d = Math.hypot(n.x - actor.x, n.z - actor.z);
      if (d < bestDist) {
        const mx = (actor.x + n.x) * 0.5;
        const mz = (actor.z + n.z) * 0.5;
        if (!isPointInsideAnyRoadway(mx, mz, this.modularRoadEntries)) {
          bestDist = d;
          bestId = n.id;
        }
      }
    }

    if (bestId >= 0) {
      actor.walkCurrNodeId = bestId;
      actor.walkPrevNodeId = undefined;
      this.pickNextWalkTarget(actor);
      actor.walkPauseTimer = 0.5 + Math.random() * 1.1;
      return;
    }

    // Isolated crosswalk + sidewalk segment: pause briefly on the far sidewalk before crossing back
    actor.walkCurrNodeId = undefined;
    actor.walkGoalX = actor.x;
    actor.walkGoalZ = actor.z;
    actor.walkPauseTimer = 0.9 + Math.random() * 0.9;
  }

  private pickRandomFreeWalkTarget(actor: AnimatedActorState): void {
    actor.walkCurrNodeId = undefined;
    actor.walkPrevNodeId = undefined;
    actor.walkIsCrosswalk = false;

    for (let attempt = 0; attempt < 18; attempt++) {
      const ang = Math.random() * Math.PI * 2;
      const dist = 3.0 + Math.random() * 8.0;
      const gx = clamp(actor.x + Math.cos(ang) * dist, -MAP_HALF_X + 2.0, MAP_HALF_X - 2.0);
      const gz = clamp(actor.z + Math.sin(ang) * dist, -MAP_HALF_Z + 2.0, MAP_HALF_Z - 2.0);
      if (
        !isPointInsideAnyRoadway(gx, gz, this.modularRoadEntries) &&
        !this.isPointBlockedForPedestrian(gx, gz)
      ) {
        let crossesRoad = false;
        for (const u of [0.25, 0.5, 0.75]) {
          const sx = actor.x + (gx - actor.x) * u;
          const sz = actor.z + (gz - actor.z) * u;
          if (isPointInsideAnyRoadway(sx, sz, this.modularRoadEntries)) {
            crossesRoad = true;
            break;
          }
        }
        if (!crossesRoad) {
          actor.walkGoalX = gx;
          actor.walkGoalZ = gz;
          return;
        }
      }
    }

    actor.walkGoalX = actor.x;
    actor.walkGoalZ = actor.z;
    actor.walkPauseTimer = 0.8 + Math.random() * 1.4;
  }

  private pickNextWalkTarget(actor: AnimatedActorState): void {
    const currId = actor.walkCurrNodeId;
    if (currId === undefined || currId >= this.walkGraph.nodes.length) {
      this.pickRandomFreeWalkTarget(actor);
      return;
    }

    let outEdges = this.walkGraph.edges[currId];
    if (!outEdges || outEdges.length === 0) {
      this.pickRandomFreeWalkTarget(actor);
      return;
    }

    // Avoid immediate ping-pong reversals most of the time, while still allowing occasional random turn-backs
    if (outEdges.length > 1 && actor.walkPrevNodeId !== undefined) {
      const nonBack = outEdges.filter((e) => e.toNodeId !== actor.walkPrevNodeId);
      if (nonBack.length > 0 && Math.random() < 0.9) {
        outEdges = nonBack;
      }
    }

    const chosen = outEdges[Math.floor(Math.random() * outEdges.length)];
    const prevNode = this.walkGraph.nodes[currId];
    const nextNode = this.walkGraph.nodes[chosen.toNodeId];

    actor.walkPrevNodeId = currId;
    actor.walkCurrNodeId = chosen.toNodeId;
    actor.walkIsCrosswalk = chosen.isCrosswalk;

    const segDx = nextNode.x - prevNode.x;
    const segDz = nextNode.z - prevNode.z;
    const segLen = Math.hypot(segDx, segDz);
    if (segLen > 2.2) {
      const perpX = -segDz / segLen;
      const perpZ = segDx / segLen;
      const jitterMag = chosen.isCrosswalk ? 0.38 : 0.55;
      const offset = (Math.random() - 0.5) * 2 * jitterMag;
      actor.walkGoalX = nextNode.x + perpX * offset;
      actor.walkGoalZ = nextNode.z + perpZ * offset;
    } else {
      actor.walkGoalX = nextNode.x;
      actor.walkGoalZ = nextNode.z;
    }
  }

  private isOnCrosswalkArea(px: number, pz: number): boolean {
    return isPointInsideAnyRoadway(px, pz, this.modularRoadEntries);
  }

  private shouldPedestrianYield(
    actor: AnimatedActorState,
    dx: number,
    dz: number,
  ): boolean {
    const stepLen = Math.hypot(dx, dz);
    if (stepLen < 0.25) return false;
    const dirX = dx / stepLen;
    const dirZ = dz / stepLen;

    const currentlyOnRoad = this.isOnCrosswalkArea(actor.x, actor.z);
    // Once a pedestrian has stepped into the roadway/crosswalk, they MUST finish crossing
    // to the opposite sidewalk instead of freezing mid-intersection when the light turns red.
    if (currentlyOnRoad) {
      return false;
    }

    // Strictly wait behind the curb at roads with traffic lights unless the crossing light is GREEN
    if (this.trafficControllers.length > 0 && (actor.walkIsCrosswalk || stepLen > 1.0)) {
      const dNear = Math.min(stepLen, 1.35);
      const dFar = Math.min(stepLen, 2.15);
      const aheadNearX = actor.x + dirX * dNear;
      const aheadNearZ = actor.z + dirZ * dNear;
      const aheadFarX = actor.x + dirX * dFar;
      const aheadFarZ = actor.z + dirZ * dFar;
      const approachingRoad =
        this.isOnCrosswalkArea(aheadNearX, aheadNearZ) ||
        this.isOnCrosswalkArea(aheadFarX, aheadFarZ) ||
        Boolean(actor.walkIsCrosswalk);

      if (approachingRoad) {
        for (const ctrl of this.trafficControllers) {
          if (Math.hypot(aheadNearX - ctrl.cx, aheadNearZ - ctrl.cz) > 11.5) continue;
          const aspects = this.getTrafficSignalAspects(ctrl);
          const dotZ = Math.abs(dirX * ctrl.axisZX + dirZ * ctrl.axisZZ);
          const dotX = Math.abs(dirX * ctrl.axisXX + dirZ * ctrl.axisXZ);
          // Walkers parallel to axisZ only cross when axisZ is green (and cross-traffic axisX is red), and vice versa
          const walkAxisAspect = dotZ >= dotX ? aspects.axisZ : aspects.axisX;
          const crossAxisAspect = dotZ >= dotX ? aspects.axisX : aspects.axisZ;
          if (walkAxisAspect !== 'green' || crossAxisAspect !== 'red') {
            return true;
          }
        }
      }
    }

    // Only check oncoming car yield when about to enter the roadway at the curb
    const curbProbeDist = Math.min(stepLen, 1.8);
    const curbProbeX = actor.x + dirX * curbProbeDist;
    const curbProbeZ = actor.z + dirZ * curbProbeDist;
    if (!this.isOnCrosswalkArea(curbProbeX, curbProbeZ)) {
      return false;
    }

    const perpX = -dirZ;
    const perpZ = dirX;
    const safeZoneAcross = 1.55;
    const checkWindowAhead = 3.6;

    for (const other of this.animatedActors.values()) {
      if (other.motion !== 'drive') continue;
      // Do not yield to vehicles already braking/stopped for the crosswalk (prevents deadlock)
      if (other.isYielding || other.currentSpeed < 1.8) continue;

      const fx = Math.cos(other.rotationY);
      const fz = -Math.sin(other.rotationY);

      const relX = other.x - actor.x;
      const relZ = other.z - actor.z;
      const aheadCross = relX * dirX + relZ * dirZ;
      const alongVehicleFlow = fx * perpX + fz * perpZ;

      if (Math.abs(alongVehicleFlow) >= 0.65 && aheadCross >= 1.0 && aheadCross <= checkWindowAhead) {
        const flowDir = Math.sign(alongVehicleFlow);
        const flowSpeed = Math.abs(alongVehicleFlow) * other.currentSpeed;
        const crossPad = other.halfLen + 1.25;
        const tEnter = Math.max(0, (aheadCross - safeZoneAcross) / Math.max(actor.speed, 0.8));
        const tExit = (aheadCross + safeZoneAcross) / Math.max(actor.speed, 0.8);
        const tMin = Math.max(0, tEnter - 1.0);
        const tMax = tExit + 0.8;

        const actorLat = 0;
        const vehLat0 = relX * perpX + relZ * perpZ;
        const distAtTMin = (actorLat - (vehLat0 + flowDir * flowSpeed * tMin)) * flowDir;
        const distAtTMax = (actorLat - (vehLat0 + flowDir * flowSpeed * tMax)) * flowDir;

        if (distAtTMin >= -crossPad && distAtTMax <= crossPad) {
          return true;
        }
      } else {
        // Angled / turning vehicles: check upcoming trajectory proximity
        for (let t = 0; t <= 2.2; t += 0.55) {
          const px = other.x + fx * other.currentSpeed * t;
          const pz = other.z + fz * other.currentSpeed * t;
          if (Math.hypot(px - actor.x, pz - actor.z) < other.halfLen + 1.85) {
            return true;
          }
        }
      }
    }

    return false;
  }

  private isVehicleInIntersectionBox(
    vx: number,
    vz: number,
    vfx: number,
    vfz: number,
    vHalfLen: number,
    vHalfW: number,
    ix: number,
    iz: number,
    boxHalf = 4.35,
  ): boolean {
    const extX = Math.abs(vfx) * vHalfLen + Math.abs(vfz) * vHalfW;
    const extZ = Math.abs(vfz) * vHalfLen + Math.abs(vfx) * vHalfW;
    return Math.abs(vx - ix) < boxHalf + extX && Math.abs(vz - iz) < boxHalf + extZ;
  }

  private getSweptCorridorHitFwd(
    ax: number,
    az: number,
    fx: number,
    fz: number,
    rx: number,
    rz: number,
    corridorHalfW: number,
    bx: number,
    bz: number,
    ofx: number,
    ofz: number,
    bHalfL: number,
    bHalfW: number,
  ): number {
    const relX = bx - ax;
    const relZ = bz - az;
    const cFwd = relX * fx + relZ * fz;
    const cLat = relX * rx + relZ * rz;

    const uFwd = ofx * fx + ofz * fz;
    const uLat = ofx * rx + ofz * rz;
    const orx = -ofz;
    const orz = ofx;
    const vFwd = orx * fx + orz * fz;
    const vLat = orx * rx + orz * rz;

    const f0 = cFwd + uFwd * bHalfL + vFwd * bHalfW;
    const l0 = cLat + uLat * bHalfL + vLat * bHalfW;
    const f1 = cFwd + uFwd * bHalfL - vFwd * bHalfW;
    const l1 = cLat + uLat * bHalfL - vLat * bHalfW;
    const f2 = cFwd - uFwd * bHalfL - vFwd * bHalfW;
    const l2 = cLat - uLat * bHalfL - vLat * bHalfW;
    const f3 = cFwd - uFwd * bHalfL + vFwd * bHalfW;
    const l3 = cLat - uLat * bHalfL + vLat * bHalfW;

    const minL = Math.min(l0, l1, l2, l3);
    const maxL = Math.max(l0, l1, l2, l3);
    if (maxL < -corridorHalfW || minL > corridorHalfW) return Infinity;

    const maxF = Math.max(f0, f1, f2, f3);
    if (maxF <= 0.1) return Infinity;

    let minHitFwd = Infinity;
    const checkEdge = (af: number, al: number, bf: number, bl: number) => {
      let t0 = 0;
      let t1 = 1;
      const dl = bl - al;
      if (Math.abs(dl) < 1e-6) {
        if (al < -corridorHalfW || al > corridorHalfW) return;
      } else {
        let aT = (-corridorHalfW - al) / dl;
        let bT = (corridorHalfW - al) / dl;
        if (aT > bT) {
          const tmp = aT;
          aT = bT;
          bT = tmp;
        }
        t0 = Math.max(t0, aT);
        t1 = Math.min(t1, bT);
        if (t0 > t1) return;
      }
      const df = bf - af;
      const hitF = Math.min(af + df * t0, af + df * t1);
      if (hitF < minHitFwd) minHitFwd = hitF;
    };

    checkEdge(f0, l0, f1, l1);
    checkEdge(f1, l1, f2, l2);
    checkEdge(f2, l2, f3, l3);
    checkEdge(f3, l3, f0, l0);
    return minHitFwd;
  }

  private wouldCollideWithVehicleAhead(
    id: string,
    actor: AnimatedActorState,
    nx: number,
    nz: number,
    nRotY: number,
  ): boolean {
    const fx = Math.cos(nRotY);
    const fz = -Math.sin(nRotY);
    const rx = -fz;
    const rz = fx;
    const myHalfW = getActorHalfWidth(actor.kind);

    for (const t of this.vehicleTargets) {
      if (t.id === id) continue;
      const otherAnim = this.animatedActors.get(t.id);
      if (
        otherAnim?.parkingPhase === 'parked' &&
        (actor.parkingPhase === 'entering-lot' ||
          actor.parkingPhase === 'reversing-out' ||
          actor.parkingPhase === 'exiting-lot') &&
        otherAnim.parkingLotId === actor.parkingLotId &&
        otherAnim.parkingStallIdx !== actor.parkingStallIdx
      ) {
        continue;
      }
      const ox = otherAnim ? otherAnim.x : t.position.x;
      const oz = otherAnim ? otherAnim.z : t.position.z;
      const oRotY = otherAnim ? otherAnim.rotationY : t.rotationY;
      const ofx = Math.cos(oRotY);
      const ofz = -Math.sin(oRotY);
      const oHalfL = otherAnim ? otherAnim.halfLen : getActorHalfLength(t.kind);
      const oHalfW = getActorHalfWidth(t.kind);

      const dx = ox - nx;
      const dz = oz - nz;
      const maxR = actor.halfLen + oHalfL + myHalfW + oHalfW + 1.2;
      if (dx * dx + dz * dz > maxR * maxR) continue;

      const dotH = fx * ofx + fz * ofz;
      const sinH = Math.sqrt(Math.max(0, 1 - dotH * dotH));
      const oProjL = oHalfL * Math.abs(dotH) + oHalfW * sinH;
      const oProjW = oHalfL * sinH + oHalfW * Math.abs(dotH);

      const fwd = dx * fx + dz * fz;
      const lat = Math.abs(dx * rx + dz * rz);

      if (
        fwd > -actor.halfLen * 0.25 &&
        fwd < actor.halfLen + oProjL + 0.85 &&
        lat < myHalfW + oProjW + 0.24
      ) {
        const curDx = ox - actor.x;
        const curDz = oz - actor.z;
        const curFwd = curDx * fx + curDz * fz;
        const curDistSq = curDx * curDx + curDz * curDz;
        const newDistSq = dx * dx + dz * dz;
        if (fwd < curFwd - 1e-4 || newDistSq < curDistSq - 1e-4) {
          return true;
        }
      }
    }
    return false;
  }

  private getVehicleTrafficScale(
    id: string,
    actor: AnimatedActorState,
  ): {
    scale: number;
    yieldingToPed: boolean;
    hardStop: boolean;
    maxAdvanceDist: number;
  } {
    const fx = Math.cos(actor.rotationY);
    const fz = -Math.sin(actor.rotationY);
    const rx = -fz;
    const rz = fx;
    const myHalfW = getActorHalfWidth(actor.kind);
    let minScale = 1;
    let yieldingToPed = false;
    let hardStop = false;
    let maxAdvanceDist = Infinity;

    const inParkingManeuver =
      actor.parkingPhase === 'entering-lot' ||
      actor.parkingPhase === 'reversing-out' ||
      (actor.parkingPhase === 'exiting-lot' && (actor.subPathIdx ?? 0) <= 1);

    // Determine if actor is already inside any intersection clearing box or already past the horizontal white stop bar
    let actorInsideAnyIntersection = false;
    if (!inParkingManeuver) {
      for (const inter of this.intersectionEntries) {
        if (
          this.isVehicleInIntersectionBox(
            actor.x,
            actor.z,
            fx,
            fz,
            actor.halfLen,
            myHalfW,
            inter.x,
            inter.z,
          )
        ) {
          actorInsideAnyIntersection = true;
          break;
        }
        const relX = inter.x - actor.x;
        const relZ = inter.z - actor.z;
        const fwdToInt = relX * fx + relZ * fz;
        const latToInt = Math.abs(relX * rx + relZ * rz);
        if (
          fwdToInt > 0 &&
          latToInt <= 4.25 &&
          fwdToInt - actor.halfLen < inter.stopBarDist - 0.12
        ) {
          actorInsideAnyIntersection = true;
          break;
        }
      }
    }

    // 0. Obey intersection traffic signals:
    // Cars MUST NOT enter or cross past the horizontal white line during a red light,
    // and ONLY keep moving during red if their front is already past the horizontal white line.
    if (!inParkingManeuver) {
      for (const ctrl of this.trafficControllers) {
        const relX = ctrl.cx - actor.x;
        const relZ = ctrl.cz - actor.z;
        const fwdToInt = relX * fx + relZ * fz;
        if (fwdToInt <= 0 || fwdToInt >= 28.0) continue;
        const latToInt = Math.abs(relX * rx + relZ * rz);
        if (latToInt > 4.25) continue;

        const aspects = this.getTrafficSignalAspects(ctrl);
        const dotZ = Math.abs(fx * ctrl.axisZX + fz * ctrl.axisZZ);
        const dotX = Math.abs(fx * ctrl.axisXX + fz * ctrl.axisXZ);
        const aspect = dotZ >= dotX ? aspects.axisZ : aspects.axisX;

        if (aspect === 'green') continue;

        const distToStopBar = fwdToInt - actor.halfLen - ctrl.stopBarDist;
        // Already in front of (past) the horizontal white line -> do not stop on red/yellow; clear the intersection
        if (distToStopBar < -0.12) continue;

        if (aspect === 'red') {
          if (distToStopBar <= 22.0) {
            const stopGap = distToStopBar - 0.14;
            const s =
              stopGap <= 0.04 ? 0 : clamp(Math.sqrt(stopGap / 20.0) * 0.95, 0, 1);
            if (s < minScale) minScale = s;
            if (stopGap <= 0.18) hardStop = true;
            maxAdvanceDist = Math.min(maxAdvanceDist, Math.max(0, stopGap));
          }
        } else if (aspect === 'yellow') {
          const minStopDist = Math.max(
            2.2,
            (actor.currentSpeed * actor.currentSpeed) / 16.0,
          );
          if (
            distToStopBar <= 22.0 &&
            (distToStopBar >= minStopDist || actor.currentSpeed <= 3.5)
          ) {
            const stopGap = distToStopBar - 0.14;
            const s =
              stopGap <= 0.04 ? 0 : clamp(Math.sqrt(stopGap / 20.0) * 0.95, 0, 1);
            if (s < minScale) minScale = s;
            if (stopGap <= 0.18) hardStop = true;
            maxAdvanceDist = Math.min(maxAdvanceDist, Math.max(0, stopGap));
          }
        }
      }
    }

    // 0b. Intersection occupancy & entry reservation guard:
    // Never enter an intersection past the stop bar while another vehicle is inside or already entering from a conflicting/opposing approach
    if (!inParkingManeuver && !actorInsideAnyIntersection) {
      for (const inter of this.intersectionEntries) {
        const relX = inter.x - actor.x;
        const relZ = inter.z - actor.z;
        const fwdToInt = relX * fx + relZ * fz;
        if (fwdToInt <= 0 || fwdToInt >= 26.0) continue;
        const latToInt = Math.abs(relX * rx + relZ * rz);
        if (latToInt > 4.25) continue;

        const distToStopBar = fwdToInt - actor.halfLen - inter.stopBarDist;
        if (distToStopBar < -0.12 || distToStopBar > 19.0) continue;

        let occupiedByConflicting = false;
        for (const t of this.vehicleTargets) {
          if (t.id === id) continue;
          const otherAnim = this.animatedActors.get(t.id);
          if (otherAnim?.parkingPhase === 'parked') continue;
          const ox = otherAnim ? otherAnim.x : t.position.x;
          const oz = otherAnim ? otherAnim.z : t.position.z;
          const oRotY = otherAnim ? otherAnim.rotationY : t.rotationY;
          const ofx = Math.cos(oRotY);
          const ofz = -Math.sin(oRotY);
          const oHalfL = otherAnim ? otherAnim.halfLen : getActorHalfLength(t.kind);
          const oHalfW = getActorHalfWidth(t.kind);
          const oSpeed = otherAnim ? otherAnim.currentSpeed : 0;

          const otherInBox = this.isVehicleInIntersectionBox(
            ox,
            oz,
            ofx,
            ofz,
            oHalfL,
            oHalfW,
            inter.x,
            inter.z,
            7.6,
          );

          // Also detect an opposing or cross-street moving vehicle actively entering past its stop bar
          const oRelX = inter.x - ox;
          const oRelZ = inter.z - oz;
          const oFwdToInt = oRelX * ofx + oRelZ * ofz;
          const oLatToInt = Math.abs(oRelX * -ofz + oRelZ * ofx);
          const oDistToStopBar = oFwdToInt - oHalfL - inter.stopBarDist;
          const otherEnteringAhead =
            oSpeed > 0.65 &&
            oFwdToInt > 0 &&
            oLatToInt <= 4.25 &&
            oDistToStopBar < 2.2 &&
            (oDistToStopBar + 0.35 < distToStopBar ||
              (Math.abs(oDistToStopBar - distToStopBar) <= 0.35 && id > t.id));

          // Don't Block the Box: avoid entering if a slow/stopped same-direction vehicle blocks our exit lane clearance
          const dotH = fx * ofx + fz * ofz;
          const oRelExitFwd = (ox - inter.x) * fx + (oz - inter.z) * fz;
          const oRelExitLat = Math.abs((ox - inter.x) * rx + (oz - inter.z) * rz);
          const oRearFromCenter = oRelExitFwd - oHalfL;
          const sameLaneExitBlocked =
            dotH > 0.78 &&
            oRelExitLat < 2.1 &&
            oRearFromCenter >= 4.0 &&
            oRearFromCenter < actor.halfLen * 2 + 5.8 &&
            oSpeed < 1.2;

          if (!otherInBox && !otherEnteringAhead && !sameLaneExitBlocked) {
            continue;
          }

          // Allow following only when a same-direction vehicle's rear bumper has cleared past the box and exit isn't stalled
          const otherRearPastCenter = oRearFromCenter > 4.6;
          if (!sameLaneExitBlocked && dotH > 0.78 && otherRearPastCenter) continue;

          occupiedByConflicting = true;
          break;
        }

        if (occupiedByConflicting) {
          const stopGap = distToStopBar - 0.14;
          const s = stopGap <= 0.1 ? 0 : clamp(stopGap / 8.5, 0, 1);
          if (s < minScale) minScale = s;
          if (stopGap <= 0.2) hardStop = true;
          maxAdvanceDist = Math.min(maxAdvanceDist, Math.max(0, stopGap));
        }
      }
    }

    // 1. Yield to pedestrians currently on any crosswalk / roadway ahead (or sidewalk apron when entering/exiting a parking lot)
    const checkingApronPed =
      actor.parkingPhase === 'entering-lot' || actor.parkingPhase === 'exiting-lot';
    for (const t of this.pedestrianTargets) {
      const animPed = this.animatedActors.get(t.id);
      const px = animPed ? animPed.x : t.position.x;
      const pz = animPed ? animPed.z : t.position.z;
      const pedRotY = animPed ? animPed.rotationY : t.rotationY;

      if (!checkingApronPed && !this.isOnCrosswalkArea(px, pz)) continue;

      const relX = px - actor.x;
      const relZ = pz - actor.z;
      const fwdDist = relX * fx + relZ * fz;
      const bumperDist = fwdDist - actor.halfLen;
      if (bumperDist <= 0.35 || bumperDist >= 14.5) continue;
      if (actorInsideAnyIntersection && fwdDist < actor.halfLen + 0.8) continue;

      const signedLat = relX * rx + relZ * rz;
      const latDist = Math.abs(signedLat);
      const pedFx = Math.sin(pedRotY);
      const pedFz = Math.cos(pedRotY);
      const latApproach = -(pedFx * rx + pedFz * rz) * Math.sign(signedLat || 1);

      const lateralBand = actorInsideAnyIntersection ? myHalfW + 1.2 : myHalfW + 1.35;
      const shouldYield =
        latDist < lateralBand ||
        (!actorInsideAnyIntersection &&
          latDist < 4.2 &&
          latApproach > 0.25 &&
          bumperDist > 1.2) ||
        (!animPed && latDist < 3.5);

      if (shouldYield) {
        const s = clamp((bumperDist - 2.6) / 11.0, 0, 1);
        if (s < minScale) minScale = s;
        if (bumperDist < 10.6) yieldingToPed = true;
      }
    }

    // Check if actor is already inside any roundabout circulating ring
    let actorRoundaboutIdx = -1;
    let actorRbAngle = 0;
    let actorRbR = Infinity;
    let actorRbRingR = 8.55;
    for (const rbInfo of this.roundaboutEntries) {
      const rb = rbInfo.entry;
      const d = Math.hypot(actor.x - rb.target.position.x, actor.z - rb.target.position.z);
      if (d <= rbInfo.ringZoneR) {
        actorRoundaboutIdx = rbInfo.idx;
        actorRbR = d;
        actorRbRingR = rbInfo.ringZoneR;
        actorRbAngle = Math.atan2(actor.x - rb.target.position.x, actor.z - rb.target.position.z);
        break;
      }
    }

    // 2. Roundabout right-of-way: entering traffic MUST wait for vehicles already inside the roundabout
    if (!inParkingManeuver && actorRoundaboutIdx < 0) {
      for (const rbInfo of this.roundaboutEntries) {
        const rb = rbInfo.entry;
        const { isMini, ringZoneR, yieldLineR, approachMaxR } = rbInfo;

        const rcx = rb.target.position.x;
        const rcz = rb.target.position.z;
        const dxC = actor.x - rcx;
        const dzC = actor.z - rcz;
        const rA = Math.hypot(dxC, dzC);
        if (rA <= ringZoneR || rA >= approachMaxR) continue;

        const approachCos = (-dxC * fx - dzC * fz) / rA;
        if (approachCos < 0.15) continue;

        const armAngle = Math.atan2(dxC, dzC);
        for (const t of this.vehicleTargets) {
          if (t.id === id) continue;
          const otherAnim = this.animatedActors.get(t.id);
          const ox = otherAnim ? otherAnim.x : t.position.x;
          const oz = otherAnim ? otherAnim.z : t.position.z;
          const oRotY = otherAnim ? otherAnim.rotationY : t.rotationY;
          const rB = Math.hypot(ox - rcx, oz - rcz);
          if (rB > ringZoneR + 0.65) continue;

          // Ignore vehicles that have already turned outbound onto an exit arm
          const ofx = Math.cos(oRotY);
          const ofz = -Math.sin(oRotY);
          const radialOutB =
            rB > 0.1 ? ((ox - rcx) * ofx + (oz - rcz) * ofz) / rB : 0;
          if (radialOutB > 0.65 && rB > (isMini ? 4.4 : 7.6)) continue;

          const angleB = Math.atan2(ox - rcx, oz - rcz);
          let delta = armAngle - angleB;
          while (delta < 0) delta += Math.PI * 2;
          if (delta <= 2.45 || delta >= Math.PI * 2 - 0.9) {
            const stopDist = rA - (yieldLineR + actor.halfLen + 0.35);
            const s = stopDist <= 0.2 ? 0 : clamp(stopDist / 8.5, 0, 1);
            if (s < minScale) minScale = s;
            if (stopDist <= 0.25) hardStop = true;
          }
        }
      }
    }

    // 3. Vehicle-to-vehicle following, roundabout arc spacing, & intersection right-of-way
    for (const t of this.vehicleTargets) {
      if (t.id === id) continue;
      const otherAnim = this.animatedActors.get(t.id);
      if (otherAnim?.parkingPhase === 'parked') continue;
      const ox = otherAnim ? otherAnim.x : t.position.x;
      const oz = otherAnim ? otherAnim.z : t.position.z;
      const oRotY = otherAnim ? otherAnim.rotationY : t.rotationY;
      const otherSpeed = otherAnim ? otherAnim.currentSpeed : 0;
      const otherHalfLen = otherAnim ? otherAnim.halfLen : getActorHalfLength(t.kind);
      const otherHalfW = getActorHalfWidth(t.kind);

      const relX = ox - actor.x;
      const relZ = oz - actor.z;
      const maxCheckDist = actor.halfLen + otherHalfLen + 24.0;
      if (relX * relX + relZ * relZ > maxCheckDist * maxCheckDist) continue;

      const ofx = Math.cos(oRotY);
      const ofz = -Math.sin(oRotY);
      const dotHeading = fx * ofx + fz * ofz;

      let skipIntersectionCrossing = false;
      // Roundabout circulatory arc following (handles tight 60-120 deg curve spacing)
      if (actorRoundaboutIdx >= 0) {
        const rb = this.modularRoadEntries[actorRoundaboutIdx];
        const rcx = rb.target.position.x;
        const rcz = rb.target.position.z;
        const rB = Math.hypot(ox - rcx, oz - rcz);
        if (rB <= actorRbRingR + 0.65) {
          const angleB = Math.atan2(ox - rcx, oz - rcz);
          let arcAngle = angleB - actorRbAngle;
          while (arcAngle < 0) arcAngle += Math.PI * 2;
          if (arcAngle > 0.02 && arcAngle < Math.PI) {
            const arcDist = arcAngle * ((actorRbR + rB) * 0.5);
            const safeGap = actor.halfLen + otherHalfLen + 2.5;
            if (arcDist < safeGap + 7.5) {
              const s = arcDist <= safeGap ? 0 : clamp((arcDist - safeGap) / 7.5, 0, 1);
              if (s < minScale) minScale = s;
              if (arcDist <= safeGap + 0.35) hardStop = true;
              if (otherAnim?.isYielding && arcDist < safeGap + 3.5) yieldingToPed = true;
            }
          }
          continue;
        }
        // Circulating traffic inside a roundabout has right-of-way over outside entering arms
        skipIntersectionCrossing = true;
      }

      const fwdDist = relX * fx + relZ * fz;
      const latDist = Math.abs(relX * rx + relZ * rz);
      const sinHeading = Math.sqrt(Math.max(0, 1 - dotHeading * dotHeading));
      const otherProjHalfL = otherHalfLen * Math.abs(dotHeading) + otherHalfW * sinHeading;
      const otherProjHalfW = otherHalfLen * sinHeading + otherHalfW * Math.abs(dotHeading);
      const safeGap = actor.halfLen + otherProjHalfL + 2.6;
      const followRamp = Math.max(11.0, actor.speed * 1.1);

      // A. Same-lane following / parked obstacle / direct-lane head-on guard
      const isSameDirection = dotHeading > 0.35;
      const isParkedAhead = otherSpeed < 0.25 && fwdDist > 0;
      const isDirectLaneHeadOn =
        dotHeading < -0.35 && latDist < myHalfW + otherProjHalfW + 0.3;

      if (isSameDirection || isParkedAhead || isDirectLaneHeadOn) {
        const laneHalfBand =
          myHalfW + otherProjHalfW + (isSameDirection && dotHeading < 0.92 ? 0.85 : 0.45);
        if (fwdDist > 0 && latDist < laneHalfBand && fwdDist < safeGap + followRamp) {
          const s = fwdDist <= safeGap ? 0 : clamp((fwdDist - safeGap) / followRamp, 0, 1);
          if (s < minScale) minScale = s;
          if (fwdDist <= safeGap + 0.5) hardStop = true;
          if (otherAnim?.isYielding && fwdDist < safeGap + 3.5) yieldingToPed = true;
        }
      }

      // B. Crossing / Intersection right-of-way (4-way, T-junction, merging traffic)
      const det = fz * ofx - fx * ofz;
      if (!skipIntersectionCrossing && Math.abs(det) > 0.22) {
        const sCross = (relZ * ofx - relX * ofz) / det;
        const uCross = (fx * relZ - fz * relX) / det;
        const clearA = actor.halfLen + otherHalfW + 2.0;
        const clearB = otherHalfLen + myHalfW + 2.0;

        if (
          sCross >= -actor.halfLen - 0.5 &&
          sCross <= actor.halfLen + 17.5 &&
          uCross >= -otherHalfLen - 1.2 &&
          uCross <= otherHalfLen + 18.0
        ) {
          // If moving other vehicle is already stopped outside the box yielding, don't deadlock
          const otherStoppedYielding =
            otherAnim && otherSpeed < 0.45 && uCross > clearB + 0.4;
          if (!otherStoppedYielding) {
            const vA = Math.max(actor.speed * 0.8, actor.currentSpeed, 2.5);
            const tAEnter = Math.max(0, (sCross - clearA) / vA);
            const tAExit = Math.max(0, (sCross + clearA) / vA);
            const tBEnter = otherSpeed < 0.45 ? 0 : Math.max(0, (uCross - clearB) / otherSpeed);
            const tBExit = otherSpeed < 0.45 ? 99 : Math.max(0, (uCross + clearB) / otherSpeed);

            if (tAEnter <= tBExit + 1.0 && tBEnter <= tAExit + 1.0) {
              let mustYield = false;
              const iz = actor.z + fz * sCross;

              if (uCross <= clearB && sCross > clearA) {
                // Other vehicle is already occupying the crossing point
                mustYield = true;
              } else if (
                (sCross <= clearA || actorInsideAnyIntersection) &&
                uCross > clearB
              ) {
                // We are already inside the intersection / crossing; finish clearing
                mustYield = false;
              } else {
                // Through-traffic on main corridor has priority over side-street merging traffic
                const aMainThrough =
                  Math.abs(iz) <= 4.5 && Math.abs(actor.z) <= 4.0 && Math.abs(fx) >= 0.85;
                const bMainThrough =
                  Math.abs(iz) <= 4.5 && Math.abs(oz) <= 4.0 && Math.abs(ofx) >= 0.85;

                if (!aMainThrough && bMainThrough) {
                  mustYield = true;
                } else if (aMainThrough && !bMainThrough) {
                  mustYield = false;
                } else {
                  const bumperDistA = sCross - actor.halfLen;
                  const bumperDistB = uCross - otherHalfLen;
                  if (bumperDistB + 2.0 < bumperDistA) {
                    mustYield = true;
                  } else if (bumperDistA + 2.0 < bumperDistB) {
                    mustYield = false;
                  } else {
                    // Equal arrival: Yield to vehicle approaching from the RIGHT
                    const rightDot = relX * rx + relZ * rz;
                    if (rightDot > 0.6) mustYield = true;
                    else if (rightDot < -0.6) mustYield = false;
                    else mustYield = id > t.id;
                  }
                }
              }

              if (mustYield) {
                const stopDist = sCross - clearA;
                const brakeWindow = Math.max(7.5, actor.speed * 1.2);
                const scale = stopDist <= 0.15 ? 0 : clamp(stopDist / brakeWindow, 0, 1);
                if (scale < minScale) minScale = scale;
                if (stopDist <= 0.25 && sCross > -actor.halfLen * 0.4) hardStop = true;
              }
            }
          }
        }
      }

      // C. Exact oriented-box forward corridor collision guard (prevents angled/turning bumper contact)
      const hitFwd = this.getSweptCorridorHitFwd(
        actor.x,
        actor.z,
        fx,
        fz,
        rx,
        rz,
        myHalfW + 0.42,
        ox,
        oz,
        ofx,
        ofz,
        otherHalfLen,
        otherHalfW,
      );
      if (hitFwd < Infinity && hitFwd >= -actor.halfLen * 0.85) {
        let ignoreStationarySideTurn = false;
        if (
          otherSpeed < 0.35 &&
          actor.subPath &&
          actor.subPath.length >= 2 &&
          actor.graphNodeId !== undefined
        ) {
          const destNode = this.roadGraph.nodes[actor.graphNodeId];
          if (destNode) {
            const turnDot = fx * destNode.dirX + fz * destNode.dirZ;
            if (turnDot < 0.9) {
              let minPathDistSq = Infinity;
              let px = actor.x;
              let pz = actor.z;
              const startIdx = actor.subPathIdx ?? 0;
              for (let k = startIdx; k < actor.subPath.length; k++) {
                const wp = actor.subPath[k];
                const abx = wp.x - px;
                const abz = wp.z - pz;
                const abLenSq = abx * abx + abz * abz;
                const t =
                  abLenSq > 1e-4
                    ? clamp(((ox - px) * abx + (oz - pz) * abz) / abLenSq, 0, 1)
                    : 0;
                const qx = px + abx * t;
                const qz = pz + abz * t;
                const dSq = (ox - qx) * (ox - qx) + (oz - qz) * (oz - qz);
                if (dSq < minPathDistSq) minPathDistSq = dSq;
                px = wp.x;
                pz = wp.z;
              }
              // Include 4.5m exit tangent along destination node direction
              const ex = px + destNode.dirX * 4.5;
              const ez = pz + destNode.dirZ * 4.5;
              const abx = ex - px;
              const abz = ez - pz;
              const abLenSq = abx * abx + abz * abz;
              const t =
                abLenSq > 1e-4
                  ? clamp(((ox - px) * abx + (oz - pz) * abz) / abLenSq, 0, 1)
                  : 0;
              const qx = px + abx * t;
              const qz = pz + abz * t;
              const dSq = (ox - qx) * (ox - qx) + (oz - qz) * (oz - qz);
              if (dSq < minPathDistSq) minPathDistSq = dSq;

              const pathClearance = myHalfW + Math.max(otherHalfW, otherHalfLen) + 0.65;
              if (minPathDistSq > pathClearance * pathClearance) {
                ignoreStationarySideTurn = true;
              }
            }
          }
        }

        const bumperGap = Math.max(0, hitFwd) - actor.halfLen;
        const corridorRamp = Math.max(9.5, actor.speed * 1.0);
        if (!ignoreStationarySideTurn || bumperGap <= 2.4) {
          if (bumperGap <= 1.75) {
            minScale = 0;
            hardStop = true;
          } else if (bumperGap < 1.75 + corridorRamp) {
            const s = clamp((bumperGap - 1.75) / corridorRamp, 0, 1);
            if (s < minScale) minScale = s;
          }
        }
      }
    }

    // 4. Hold cleanly inside the asphalt edge if a perimeter wrap destination is physically occupied
    if (
      !inParkingManeuver &&
      !actor.seekingRoad &&
      actor.graphNodeId !== undefined &&
      actor.subPath &&
      actor.subPath.length > 0 &&
      (actor.subPathIdx ?? 0) === actor.subPath.length - 1
    ) {
      const wrapEdge = this.getWrapEdgeForNode(actor.graphNodeId);
      if (wrapEdge) {
        const wp = actor.subPath[actor.subPathIdx ?? 0];
        const outNode = this.roadGraph.nodes[actor.graphNodeId];
        const alignOut = outNode ? fx * outNode.dirX + fz * outNode.dirZ : 1;
        if (wp && alignOut >= 0.85) {
          const distToEnd = Math.hypot(wp.x - actor.x, wp.z - actor.z);
          const wrapHoldInset = Math.min(actor.halfLen, 4.65);
          if (distToEnd <= wrapHoldInset + 16.0) {
            const placement = this.resolveWrapPlacement(id, actor, wrapEdge.toNodeId);
            if (!placement.clear) {
              const stopGap = distToEnd - wrapHoldInset - 0.1;
              if (stopGap <= 0.12) {
                minScale = 0;
                hardStop = true;
                maxAdvanceDist = Math.min(maxAdvanceDist, 0);
              } else {
                const s = clamp(Math.sqrt(stopGap / 14.0) * 0.9, 0, 1);
                if (s < minScale) minScale = s;
                maxAdvanceDist = Math.min(maxAdvanceDist, Math.max(0, stopGap));
              }
            }
          }
        }
      }
    }

    return { scale: minScale, yieldingToPed, hardStop, maxAdvanceDist };
  }

  public requestRender(): void {
    if (this.disposed) return;
    if (this.renderBusy) {
      this.renderDirty = true;
      return;
    }

    this.renderBusy = true;
    this.frameId = requestAnimationFrame(() => {
      if (this.disposed) return;
      this.renderDirty = false;

      const now = performance.now();
      const delta = Math.min((now - this.lastTickTime) / 1000, 0.1);
      this.lastTickTime = now;

      let keepAnimating = false;

      if (this.cameraTransition.active) {
        const lambda = 7.5;
        this.camera.position.x = THREE.MathUtils.damp(
          this.camera.position.x,
          this.cameraTransition.targetPos.x,
          lambda,
          delta,
        );
        this.camera.position.y = THREE.MathUtils.damp(
          this.camera.position.y,
          this.cameraTransition.targetPos.y,
          lambda,
          delta,
        );
        this.camera.position.z = THREE.MathUtils.damp(
          this.camera.position.z,
          this.cameraTransition.targetPos.z,
          lambda,
          delta,
        );
        this.controls.target.x = THREE.MathUtils.damp(
          this.controls.target.x,
          this.cameraTransition.targetLookAt.x,
          lambda,
          delta,
        );
        this.controls.target.y = THREE.MathUtils.damp(
          this.controls.target.y,
          this.cameraTransition.targetLookAt.y,
          lambda,
          delta,
        );
        this.controls.target.z = THREE.MathUtils.damp(
          this.controls.target.z,
          this.cameraTransition.targetLookAt.z,
          lambda,
          delta,
        );

        const posDist = _vec3A
          .copy(this.camera.position)
          .distanceTo(this.cameraTransition.targetPos);
        const tgtDist = _vec3B
          .copy(this.controls.target)
          .distanceTo(this.cameraTransition.targetLookAt);

        if (this.cameraControlMode === 'pan') {
          this.camera.lookAt(this.controls.target);
        }

        if (posDist < 0.04 && tgtDist < 0.04) {
          this.camera.position.copy(this.cameraTransition.targetPos);
          this.controls.target.copy(this.cameraTransition.targetLookAt);
          if (this.cameraControlMode === 'pan') {
            this.camera.lookAt(this.controls.target);
            _euler.setFromQuaternion(this.camera.quaternion, 'YXZ');
            this.freePitch = _euler.x;
            this.freeYaw = _euler.y;
          }
          this.cameraTransition.active = false;
        } else {
          keepAnimating = true;
        }
      }

      // Free camera translation using customizable keybinds + unbound secondary arrows/Q/E
      const kb = this.controlsConfig.keybinds;
      const hasBoundFwd =
        this.pressedKeys.has(kb.moveForward) ||
        (!this.isAnyActionBoundTo('ArrowUp') && this.pressedKeys.has('ArrowUp'));
      const hasBoundBack =
        this.pressedKeys.has(kb.moveBackward) ||
        (!this.isAnyActionBoundTo('ArrowDown') && this.pressedKeys.has('ArrowDown'));
      const hasBoundRight =
        this.pressedKeys.has(kb.moveRight) ||
        (!this.isAnyActionBoundTo('ArrowRight') && this.pressedKeys.has('ArrowRight'));
      const hasBoundLeft =
        this.pressedKeys.has(kb.moveLeft) ||
        (!this.isAnyActionBoundTo('ArrowLeft') && this.pressedKeys.has('ArrowLeft'));
      const hasBoundUp =
        this.pressedKeys.has(kb.moveUp) ||
        (!this.isAnyActionBoundTo('KeyE') && this.pressedKeys.has('KeyE'));
      const hasBoundDown =
        this.pressedKeys.has(kb.moveDown) ||
        (kb.moveDown === 'ShiftLeft' && this.pressedKeys.has('ShiftRight')) ||
        (!this.isAnyActionBoundTo('KeyQ') && this.pressedKeys.has('KeyQ'));

      const moveFwd = (hasBoundFwd ? 1 : 0) - (hasBoundBack ? 1 : 0);
      const moveRight = (hasBoundRight ? 1 : 0) - (hasBoundLeft ? 1 : 0);
      const moveUp = (hasBoundUp ? 1 : 0) - (hasBoundDown ? 1 : 0);

      if (moveFwd !== 0 || moveRight !== 0 || moveUp !== 0) {
        const speed = 15.5 * this.controlsConfig.moveSpeed * Math.max(delta, 0.016);

        this.camera.getWorldDirection(_vec3A);
        _vec3A.y = 0;
        if (_vec3A.lengthSq() < 1e-5) {
          _vec3A.set(0, 0, -1);
        } else {
          _vec3A.normalize();
        }
        _vec3B.crossVectors(_vec3A, this.camera.up).normalize();

        _vec3C.set(0, 0, 0);
        if (moveFwd !== 0) _vec3C.addScaledVector(_vec3A, moveFwd);
        if (moveRight !== 0) _vec3C.addScaledVector(_vec3B, moveRight);
        if (_vec3C.lengthSq() > 1) _vec3C.normalize();
        _vec3C.multiplyScalar(speed);
        _vec3C.y = moveUp * speed * 0.75;

        const nextCamX = clamp(this.camera.position.x + _vec3C.x, -110, 110);
        const nextCamZ = clamp(this.camera.position.z + _vec3C.z, -110, 110);
        const nextCamY = clamp(this.camera.position.y + _vec3C.y, 0.45, 75);

        const actualDx = nextCamX - this.camera.position.x;
        const actualDy = nextCamY - this.camera.position.y;
        const actualDz = nextCamZ - this.camera.position.z;

        if (actualDy > 0 && this.orbitGroundLift > 0) {
          this.orbitGroundLift = Math.max(0, this.orbitGroundLift - actualDy);
        }
        this.camera.position.set(nextCamX, nextCamY, nextCamZ);
        this.controls.target.set(
          clamp(this.controls.target.x + actualDx, -110, 110),
          clamp(this.controls.target.y + actualDy, -80, 140),
          clamp(this.controls.target.z + actualDz, -110, 110),
        );
        keepAnimating = true;
      }

      if (this.cameraControlMode === 'orbit') {
        const dampingMoved = this.controls.update();
        this.enforceOrbitGroundClearance();
        if (dampingMoved && !this.isSoftwareGl) {
          keepAnimating = true;
        }
      }

      // 3b. Advance synchronized traffic signals
      if (this.trafficControllers.length > 0 && delta > 0) {
        this.trafficSignalClock += Math.min(delta, 0.1);
        this.updateTrafficLightVisuals();
        keepAnimating = true;
      }

      // 4. Advance walking pedestrian & driving cars
      if (this.animatedActors.size > 0 && delta > 0) {
        const stepDelta = Math.min(delta, 0.08);
        this.simElapsedSeconds += stepDelta;

        // Periodically schedule a car to park in a parking lot (once every 10-15 minutes)
        if (this.roadGraph.nodes.length > 0 && this.vehicleTargets.length > 0) {
          const hasLots = this.currentTargets.some((t) => t.kind === 'parking-lot');
          if (hasLots) {
            this.nextParkingEventTimer -= stepDelta;
            if (this.nextParkingEventTimer <= 0) {
              const eligibleCars: Array<{ id: string; actor: AnimatedActorState }> = [];
              for (const [cid, cActor] of this.animatedActors.entries()) {
                if (
                  cActor.motion === 'drive' &&
                  (cActor.kind === 'sedan' || cActor.kind === 'van') &&
                  !cActor.seekingRoad &&
                  cActor.parkingPhase === undefined &&
                  cActor.graphNodeId !== undefined
                ) {
                  eligibleCars.push({ id: cid, actor: cActor });
                }
              }
              eligibleCars.sort(
                (a, b) =>
                  (a.actor.lastParkedAt ?? -Infinity) - (b.actor.lastParkedAt ?? -Infinity) +
                  (Math.random() - 0.5) * 30,
              );
              let scheduled = false;
              for (const cand of eligibleCars) {
                if (this.tryAssignParkingTrip(cand.id, cand.actor)) {
                  scheduled = true;
                  break;
                }
              }
              this.nextParkingEventTimer = scheduled ? 600 + Math.random() * 300 : 15;
            }
          }
        }

        for (const [id, actor] of this.animatedActors.entries()) {
          const group = this.targetGroups.get(id);
          if (!group) continue;

          if (this.draggingTargetId === id) {
            actor.x = group.position.x;
            actor.z = group.position.z;
            continue;
          }

          if (actor.motion === 'walk') {
            if (actor.walkGoalX === undefined || actor.walkGoalZ === undefined) {
              this.initPedestrianWalk(actor);
            }

            actor.walkIdleTime = (actor.walkIdleTime ?? 0) + stepDelta;
            const walkSeed = actor.walkSeed ?? 0;

            // Periodically vary natural stroll pace
            actor.speedDriftTimer = (actor.speedDriftTimer ?? 5.0) - stepDelta;
            if (actor.speedDriftTimer <= 0) {
              actor.speedDriftTimer = 3.5 + Math.random() * 6.0;
              actor.speed =
                getActorBaseSpeed(actor.kind, actor.rotationY) * (0.76 + Math.random() * 0.48);
            }

            let activeCrossingSteps = actor.crossingWaypoints;
            let cIdx = actor.crossingStepIdx ?? 0;
            let activeCrossingStep =
              activeCrossingSteps && cIdx < activeCrossingSteps.length
                ? activeCrossingSteps[cIdx]
                : undefined;

            if (activeCrossingStep) {
              actor.walkGoalX = activeCrossingStep.x;
              actor.walkGoalZ = activeCrossingStep.z;
              actor.walkIsCrosswalk = activeCrossingStep.action === 'cross';
            }

            // Handle curb pauses & random stroll pauses
            if ((actor.walkPauseTimer ?? 0) > 0) {
              actor.walkPauseTimer = Math.max(0, (actor.walkPauseTimer ?? 0) - stepDelta);
              if (actor.walkPauseTimer === 0 && !activeCrossingStep) {
                if (actor.walkCurrNodeId !== undefined) {
                  this.pickNextWalkTarget(actor);
                } else if (actor.routeId === 'Crossing') {
                  this.initPedestrianWalk(actor);
                  activeCrossingSteps = actor.crossingWaypoints;
                  cIdx = actor.crossingStepIdx ?? 0;
                  activeCrossingStep =
                    activeCrossingSteps && cIdx < activeCrossingSteps.length
                      ? activeCrossingSteps[cIdx]
                      : undefined;
                } else {
                  this.pickRandomFreeWalkTarget(actor);
                }
              }
            }

            let curbWaitYielding = false;
            let curbLookDirX = 0;
            let curbLookDirZ = 0;

            if (activeCrossingStep?.action === 'pause-at-curb' && actor.crossingCurbPaused) {
              const nextCross = activeCrossingSteps?.[cIdx + 1];
              if (nextCross) {
                curbLookDirX = nextCross.x - actor.x;
                curbLookDirZ = nextCross.z - actor.z;
              }
              if ((actor.walkPauseTimer ?? 0) <= 0) {
                const trafficBlocked = nextCross
                  ? this.shouldPedestrianYield(actor, curbLookDirX, curbLookDirZ)
                  : false;
                if (trafficBlocked) {
                  curbWaitYielding = true;
                } else {
                  actor.crossingCurbPaused = false;
                  const nextIdx = cIdx + 1;
                  if (activeCrossingSteps && nextIdx < activeCrossingSteps.length) {
                    actor.crossingStepIdx = nextIdx;
                    cIdx = nextIdx;
                    activeCrossingStep = activeCrossingSteps[nextIdx];
                    actor.walkGoalX = activeCrossingStep.x;
                    actor.walkGoalZ = activeCrossingStep.z;
                    actor.walkIsCrosswalk = activeCrossingStep.action === 'cross';
                  } else {
                    this.transitionAfterCrossingPath(actor);
                    activeCrossingSteps = actor.crossingWaypoints;
                    cIdx = actor.crossingStepIdx ?? 0;
                    activeCrossingStep = undefined;
                  }
                }
              }
            }

            const goalX = actor.walkGoalX ?? actor.x;
            const goalZ = actor.walkGoalZ ?? actor.z;
            const dx = goalX - actor.x;
            const dz = goalZ - actor.z;
            const dist = Math.hypot(dx, dz);
            const onRoadNow = this.isOnCrosswalkArea(actor.x, actor.z);
            if (onRoadNow && (actor.walkPauseTimer ?? 0) > 0) {
              actor.walkPauseTimer = 0;
            }
            const paused = !onRoadNow && (actor.walkPauseTimer ?? 0) > 0;
            const curbYielding =
              curbWaitYielding || (!paused && this.shouldPedestrianYield(actor, dx, dz));

            // Realistic staggered human reaction delay when light turns green or traffic clears (never mid-road!)
            if (onRoadNow) {
              actor.walkWasYielding = false;
              actor.walkReactionTimer = 0;
            } else if (curbYielding) {
              actor.walkWasYielding = true;
              actor.walkReactionTimer = 0.14 + Math.random() * 0.48;
            } else if (actor.walkWasYielding) {
              actor.walkReactionTimer = Math.max(0, (actor.walkReactionTimer ?? 0) - stepDelta);
              if ((actor.walkReactionTimer ?? 0) <= 0) {
                actor.walkWasYielding = false;
              }
            }

            const reacting = !onRoadNow && !curbYielding && (actor.walkReactionTimer ?? 0) > 0;
            const waiting = paused || curbYielding || reacting;

            // Hustle briskly across crosswalks—even faster (1.48x) if still crossing when light isn't green
            let paceBoost = 1.0;
            if (onRoadNow) {
              paceBoost = 1.24;
              if (this.trafficControllers.length > 0 && dist > 1e-4) {
                const ndx = dx / dist;
                const ndz = dz / dist;
                for (const ctrl of this.trafficControllers) {
                  if (Math.hypot(actor.x - ctrl.cx, actor.z - ctrl.cz) > 12.0) continue;
                  const aspects = this.getTrafficSignalAspects(ctrl);
                  const dotZ = Math.abs(ndx * ctrl.axisZX + ndz * ctrl.axisZZ);
                  const dotX = Math.abs(ndx * ctrl.axisXX + ndz * ctrl.axisXZ);
                  const walkAxisAspect = dotZ >= dotX ? aspects.axisZ : aspects.axisX;
                  if (walkAxisAspect !== 'green') {
                    paceBoost = 1.48;
                  }
                  break;
                }
              }
            }
            const targetWalkSpeed = waiting ? 0 : actor.speed * paceBoost;
            actor.currentSpeed = THREE.MathUtils.damp(
              actor.currentSpeed,
              targetWalkSpeed,
              waiting ? 12 : onRoadNow ? 7.5 : 4.6,
              stepDelta,
            );
            if (waiting && actor.currentSpeed < 0.05) {
              actor.currentSpeed = 0;
            }

            let faceDirX =
              actor.crossingCurbPaused && Math.hypot(curbLookDirX, curbLookDirZ) > 1e-4
                ? curbLookDirX
                : dx;
            let faceDirZ =
              actor.crossingCurbPaused && Math.hypot(curbLookDirX, curbLookDirZ) > 1e-4
                ? curbLookDirZ
                : dz;

            if (!waiting) {
              const step = actor.currentSpeed * stepDelta;

              if (
                dist <= step + 0.08 ||
                (actor.seekingSidewalk &&
                  dist < 1.35 &&
                  isPointOnSidewalkSegment(actor.x, actor.z, this.currentTargets))
              ) {
                if (!actor.seekingSidewalk) {
                  actor.x = goalX;
                  actor.z = goalZ;
                }
                if (activeCrossingStep) {
                  if (
                    activeCrossingStep.action === 'pause-at-curb' &&
                    !actor.crossingCurbPaused
                  ) {
                    actor.crossingCurbPaused = true;
                    actor.walkPauseTimer =
                      (activeCrossingStep.pauseSec ?? 1.4) * (0.85 + Math.random() * 0.3);
                    actor.currentSpeed = 0;
                  } else {
                    const nextIdx = cIdx + 1;
                    if (activeCrossingSteps && nextIdx < activeCrossingSteps.length) {
                      actor.crossingStepIdx = nextIdx;
                      actor.crossingCurbPaused = false;
                      actor.walkGoalX = activeCrossingSteps[nextIdx].x;
                      actor.walkGoalZ = activeCrossingSteps[nextIdx].z;
                      actor.walkIsCrosswalk = activeCrossingSteps[nextIdx].action === 'cross';
                    } else {
                      this.transitionAfterCrossingPath(actor);
                    }
                  }
                } else if (actor.seekingSidewalk) {
                  actor.seekingSidewalk = false;
                  if (actor.routeId === 'Crossing') {
                    this.initPedestrianWalk(actor);
                  } else {
                    let hops = 0;
                    while (hops < 4) {
                      hops++;
                      this.pickNextWalkTarget(actor);
                      if (
                        Math.hypot(
                          (actor.walkGoalX ?? actor.x) - actor.x,
                          (actor.walkGoalZ ?? actor.z) - actor.z,
                        ) > 0.2
                      ) {
                        break;
                      }
                    }
                  }
                } else if (actor.walkCurrNodeId !== undefined) {
                  // Never pause while still on a roadway; only pause briefly once safely on a sidewalk
                  if (
                    !this.isOnCrosswalkArea(actor.x, actor.z) &&
                    Math.random() < (actor.walkIsCrosswalk ? 0.22 : 0.16)
                  ) {
                    actor.walkPauseTimer = 0.65 + Math.random() * 2.3;
                  } else {
                    let hops = 0;
                    while (hops < 4) {
                      hops++;
                      this.pickNextWalkTarget(actor);
                      if (
                        Math.hypot(
                          (actor.walkGoalX ?? actor.x) - actor.x,
                          (actor.walkGoalZ ?? actor.z) - actor.z,
                        ) > 0.2
                      ) {
                        break;
                      }
                    }
                  }
                } else {
                  if (Math.random() < 0.45) {
                    actor.walkPauseTimer = 0.8 + Math.random() * 2.4;
                  } else {
                    this.pickRandomFreeWalkTarget(actor);
                  }
                }
              } else if (dist > 1e-4) {
                const dirX = dx / dist;
                const dirZ = dz / dist;
                const rightX = -dirZ;
                const rightZ = dirX;
                let moveX = dirX;
                let moveZ = dirZ;

                // Subtle organic sidewalk meander (no robotic laser-straight marching)
                if (!onRoadNow && dist > 1.8) {
                  const meander =
                    Math.sin((actor.walkIdleTime ?? 0) * 0.55 + walkSeed) * 0.09;
                  moveX += rightX * meander;
                  moveZ += rightZ * meander;
                }

                // Predictive keep-right passing & personal-space steering around other pedestrians
                for (const [otherId, otherActor] of this.animatedActors.entries()) {
                  if (otherId === id || otherActor.motion !== 'walk') continue;
                  const rx = actor.x - otherActor.x;
                  const rz = actor.z - otherActor.z;
                  const d = Math.hypot(rx, rz);
                  if (d > 0.05 && d < 2.2) {
                    // Forward dot product to check if the other person is ahead of us
                    const toOtherX = -rx / d;
                    const toOtherZ = -rz / d;
                    const ahead = toOtherX * dirX + toOtherZ * dirZ;
                    if (ahead > 0.35 && d < 2.1) {
                      const oFx = Math.sin(otherActor.rotationY);
                      const oFz = Math.cos(otherActor.rotationY);
                      const oncoming = oFx * dirX + oFz * dirZ < -0.25;
                      const latOffset = (-rx * rightX - rz * rightZ);
                      const steerSign = oncoming ? 1 : latOffset >= 0 ? -1 : 1;
                      const passStrength = ((2.1 - d) / 2.1) * (oncoming ? 0.52 : 0.36);
                      moveX += rightX * steerSign * passStrength;
                      moveZ += rightZ * steerSign * passStrength;
                    }
                    if (d < 0.92) {
                      const push = ((0.92 - d) / 0.92) * 0.58;
                      moveX += (rx / d) * push;
                      moveZ += (rz / d) * push;
                    }
                  }
                }

                // Softly curve around trees, benches, bollards, and oriented buildings on sidewalks
                if (!onRoadNow) {
                  for (const prop of this.currentTargets) {
                    if (
                      prop.motion ||
                      (isRoadOrPathKind(prop.kind) && prop.kind !== 'parking-lot') ||
                      prop.kind === 'traffic-light'
                    ) {
                      continue;
                    }
                    const bDims =
                      prop.kind === 'parking-lot'
                        ? { width: 12.8, length: 9.4 }
                        : BUILDING_DEFAULT_DIMENSIONS[prop.kind];
                    if (bDims) {
                      const hw = (prop.width ?? bDims.width) * 0.5 + 0.8;
                      const hl = (prop.length ?? bDims.length) * 0.5 + 0.8;
                      const rx = actor.x - prop.position.x;
                      const rz = actor.z - prop.position.z;
                      const cosR = Math.cos(prop.rotationY);
                      const sinR = Math.sin(prop.rotationY);
                      const lx = rx * cosR - rz * sinR;
                      const lz = rx * sinR + rz * cosR;
                      if (Math.abs(lx) < hw && Math.abs(lz) < hl) {
                        const penX = hw - Math.abs(lx);
                        const penZ = hl - Math.abs(lz);
                        const gdx = goalX - prop.position.x;
                        const gdz = goalZ - prop.position.z;
                        const glx = gdx * cosR - gdz * sinR;
                        const glz = gdx * sinR + gdz * cosR;
                        let pushLX = 0;
                        let pushLZ = 0;
                        if (penX < penZ) {
                          pushLX = (lx >= 0 ? 1 : -1) * Math.min(1.4, 0.45 + penX * 1.4);
                          const slideDir =
                            Math.abs(lz) > 0.25 ? (lz >= 0 ? 1 : -1) : glz >= 0 ? 1 : -1;
                          pushLZ = slideDir * 0.95;
                        } else {
                          pushLZ = (lz >= 0 ? 1 : -1) * Math.min(1.4, 0.45 + penZ * 1.4);
                          const slideDir =
                            Math.abs(lx) > 0.25 ? (lx >= 0 ? 1 : -1) : glx >= 0 ? 1 : -1;
                          pushLX = slideDir * 0.95;
                        }
                        moveX += pushLX * cosR + pushLZ * sinR;
                        moveZ += -pushLX * sinR + pushLZ * cosR;
                      }
                      continue;
                    }
                    const minClear =
                      prop.kind === 'tree'
                        ? 1.55
                        : prop.kind === 'bench' || prop.kind === 'hedge'
                          ? 1.4
                          : 0.95;
                    const ox = actor.x - prop.position.x;
                    const oz = actor.z - prop.position.z;
                    const od = Math.hypot(ox, oz);
                    if (od > 0.05 && od < minClear) {
                      const push = ((minClear - od) / minClear) * 0.85;
                      moveX += (ox / od) * push;
                      moveZ += (oz / od) * push;
                    }
                  }
                }

                const mLen = Math.hypot(moveX, moveZ) || 1;
                const stepX = moveX / mLen;
                const stepZ = moveZ / mLen;
                actor.x += stepX * step;
                actor.z += stepZ * step;
                faceDirX = stepX;
                faceDirZ = stepZ;
              }
            }

            if (Math.hypot(faceDirX, faceDirZ) > 1e-4) {
              // Smoothly turn body toward actual travel direction (or crosswalk when waiting at curb)
              const targetRotY = Math.atan2(faceDirX, faceDirZ);
              let angleDiff = targetRotY - actor.rotationY;
              while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
              while (angleDiff < -Math.PI) angleDiff += Math.PI * 2;
              actor.rotationY += angleDiff * Math.min(1, 7.5 * stepDelta);
            }

            const targetY = this.getGroundPlacementHeight(actor.x, actor.z, 'pedestrian');
            group.position.x = actor.x;
            group.position.z = actor.z;
            group.position.y = THREE.MathUtils.damp(group.position.y, targetY, 12, stepDelta);
            group.rotation.y = actor.rotationY;

            const pedRefs = group.userData.pedestrianRefs as PedestrianRigRefs | undefined;
            const heightInv = pedRefs ? 1 / pedRefs.heightScale : 1;
            const normSpeed = clamp(actor.currentSpeed / Math.max(0.5, actor.speed), 0, 1.25);

            actor.strideBlend = THREE.MathUtils.damp(
              actor.strideBlend,
              waiting ? 0 : normSpeed,
              9,
              stepDelta,
            );
            if (actor.currentSpeed > 0.06) {
              actor.phase += stepDelta * (3.95 * actor.currentSpeed * heightInv);
            }

            // Natural human head look-around & intersection traffic check
            const tIdle = actor.walkIdleTime ?? 0;
            let desiredLookYaw = Math.sin(tIdle * 0.48 + walkSeed) * 0.1;
            let desiredLookPitch = 0;

            if (curbYielding || reacting || actor.crossingCurbPaused) {
              // Actively glance left & right to check oncoming traffic at the curb
              const scanWave = Math.sin(tIdle * 1.45 + walkSeed * 2.1);
              desiredLookYaw = Math.tanh(scanWave * 1.8) * 0.56;
              desiredLookPitch = 0.04 + Math.sin(tIdle * 0.9 + walkSeed) * 0.03;
            } else if (paused) {
              // Stroll pause: casual look around or brief downward glance (e.g. checking watch/phone)
              const modeCycle = Math.sin(tIdle * 0.4 + walkSeed);
              if (modeCycle < -0.35) {
                desiredLookPitch = 0.28;
                desiredLookYaw = Math.sin(tIdle * 0.65 + walkSeed) * 0.14;
              } else {
                desiredLookYaw = Math.sin(tIdle * 0.85 + walkSeed) * 0.42;
                desiredLookPitch = -0.04;
              }
            } else if (onRoadNow || actor.walkIsCrosswalk) {
              // Quick glance left/right while stepping across a street
              desiredLookYaw = Math.sin(tIdle * 1.65 + walkSeed) * 0.28;
            }

            actor.walkLookYaw = THREE.MathUtils.damp(
              actor.walkLookYaw ?? 0,
              desiredLookYaw,
              5.5,
              stepDelta,
            );
            actor.walkLookPitch = THREE.MathUtils.damp(
              actor.walkLookPitch ?? 0,
              desiredLookPitch,
              5.5,
              stepDelta,
            );

            if (pedRefs) {
              const sb = actor.strideBlend;
              const idleMix = Math.max(0, 1 - sb);
              const sinP = Math.sin(actor.phase);
              const swingAmp = 0.54 * sb;
              const legLSwing = sinP * swingAmp;
              const legRSwing = -sinP * swingAmp;

              // Subtle relaxed stance when waiting instead of locking ramrod straight
              const weightShift = Math.sin(tIdle * 1.1 + walkSeed) * 0.045 * idleMix;
              pedRefs.legL.rotation.x = legLSwing + weightShift * 0.7;
              pedRefs.legR.rotation.x = legRSwing - weightShift * 0.9;

              // Realistic knee bend (flexes smoothly through toe-off & swing clearance, straightens cleanly at heel strike)
              const kneeLWalk =
                Math.max(0, Math.sin(actor.phase - 0.5)) * 0.68 +
                Math.max(0, -Math.sin(actor.phase + 0.55)) * 0.16;
              const kneeRWalk =
                Math.max(0, -Math.sin(actor.phase - 0.5)) * 0.68 +
                Math.max(0, Math.sin(actor.phase + 0.55)) * 0.16;
              pedRefs.kneeL.rotation.x =
                kneeLWalk * sb + Math.max(0, -weightShift) * 1.4 * idleMix;
              pedRefs.kneeR.rotation.x =
                kneeRWalk * sb + Math.max(0, weightShift) * 1.4 * idleMix;

              // Counter-swinging shoulders & forward-flexing elbows
              const armLSwing = -sinP * 0.44 * sb;
              const armRSwing = sinP * 0.44 * sb;
              const idleArmSway = Math.sin(tIdle * 1.3 + walkSeed) * 0.028 * idleMix;
              pedRefs.armL.rotation.x = armLSwing + idleArmSway;
              pedRefs.armR.rotation.x = armRSwing - idleArmSway;
              // Negative X bends forearm forward naturally; greater bend on forward swing
              pedRefs.elbowL.rotation.x = -(0.16 + 0.14 * sb + Math.max(0, sinP) * 0.36 * sb);
              pedRefs.elbowR.rotation.x = -(0.16 + 0.14 * sb + Math.max(0, -sinP) * 0.36 * sb);

              // Upper body stride bounce + breathing, forward lean, shoulder twist, and subtle weight shift
              const strideBob = Math.abs(sinP) * 0.036 * sb;
              const breathe = Math.sin(tIdle * 2.1 + walkSeed) * 0.006 * idleMix;
              pedRefs.upperBody.position.y = strideBob + breathe;
              pedRefs.upperBody.rotation.x = 0.055 * sb + Math.sin(tIdle * 1.1 + walkSeed) * 0.012 * idleMix;
              pedRefs.upperBody.rotation.y = sinP * 0.075 * sb;
              pedRefs.upperBody.rotation.z =
                Math.cos(actor.phase) * 0.022 * sb + weightShift * 0.45;

              // Head scan + natural stabilization against torso lean
              pedRefs.head.rotation.y = actor.walkLookYaw ?? 0;
              pedRefs.head.rotation.x =
                (actor.walkLookPitch ?? 0) - 0.035 * sb + Math.sin(tIdle * 2.1 + walkSeed) * 0.015 * idleMix;
              pedRefs.head.rotation.z = Math.sin(tIdle * 0.75 + walkSeed) * 0.03 * idleMix;
            }
          } else if (actor.motion === 'drive') {
            if (actor.parkingPhase === 'parked') {
              actor.currentSpeed = 0;
              actor.isYielding = false;
              if (actor.parkingStallYaw !== undefined) {
                let yawErr = actor.parkingStallYaw - actor.rotationY;
                while (yawErr > Math.PI) yawErr -= Math.PI * 2;
                while (yawErr < -Math.PI) yawErr += Math.PI * 2;
                actor.rotationY += yawErr * Math.min(1, 10 * stepDelta);
              }
              actor.parkingDwellTimer = (actor.parkingDwellTimer ?? 600) - stepDelta;
              if (actor.parkingDwellTimer <= 0) {
                // Wait briefly if another car is actively entering/exiting the same lot's aisle
                let aisleBusy = false;
                for (const [otherId, other] of this.animatedActors.entries()) {
                  if (otherId === id) continue;
                  if (
                    other.parkingLotId === actor.parkingLotId &&
                    (other.parkingPhase === 'entering-lot' ||
                      other.parkingPhase === 'reversing-out' ||
                      other.parkingPhase === 'exiting-lot')
                  ) {
                    aisleBusy = true;
                    break;
                  }
                }
                const lot = actor.parkingLotId
                  ? this.currentTargets.find(
                      (t) => t.id === actor.parkingLotId && t.kind === 'parking-lot',
                    )
                  : undefined;
                if (!lot) {
                  this.clearActorParkingState(actor);
                  this.assignInitialGraphRoute(actor);
                } else if (!aisleBusy) {
                  const stall =
                    getParkingLotOpenStalls(lot.id).find(
                      (s) => s.idx === actor.parkingStallIdx,
                    ) ?? getParkingLotOpenStalls(lot.id)[0];
                  const signX = stall ? (stall.x >= 0 ? 1 : -1) : 1;
                  const stallZ = stall ? stall.z : 0;
                  const exitAisleZ =
                    stallZ < -1.5
                      ? actor.kind === 'van'
                        ? -1.85
                        : -2.1
                      : stallZ < 1.5
                        ? -0.95
                        : 1.75;
                  const wp0 = this.toLotWorld(lot, 1.55 * signX, stallZ);
                  const wp1 = this.toLotWorld(lot, 0, exitAisleZ);
                  actor.parkingPhase = 'reversing-out';
                  actor.parkingReverseWaypoints = [wp0, wp1];
                  actor.parkingReverseIdx = 0;
                  actor.parkingReverseSegDist = Math.max(
                    0.5,
                    Math.hypot(wp0.x - actor.x, wp0.z - actor.z),
                  );
                  actor.parkingReverseStartYaw = actor.rotationY;
                }
              }
              group.position.x = actor.x;
              group.position.z = actor.z;
              group.position.y = THREE.MathUtils.damp(group.position.y, 0.015, 14, stepDelta);
              group.rotation.y = actor.rotationY;
              continue;
            }

            if (
              actor.parkingPhase === 'reversing-out' &&
              actor.parkingReverseWaypoints &&
              actor.parkingReverseWaypoints.length > 0
            ) {
              const revIdx = actor.parkingReverseIdx ?? 0;
              const wp = actor.parkingReverseWaypoints[revIdx];
              if (wp) {
                const dx = wp.x - actor.x;
                const dz = wp.z - actor.z;
                const dist = Math.hypot(dx, dz);
                const revDirX = dist > 1e-4 ? dx / dist : 0;
                const revDirZ = dist > 1e-4 ? dz / dist : 0;

                // Safety yield if a moving vehicle or pedestrian is directly in our backing corridor
                let rearBlocked = false;
                for (const t of this.vehicleTargets) {
                  if (t.id === id) continue;
                  const other = this.animatedActors.get(t.id);
                  if (other?.parkingPhase === 'parked') continue;
                  const ox = other ? other.x : t.position.x;
                  const oz = other ? other.z : t.position.z;
                  if (Math.hypot(ox - (actor.x + revDirX * 1.4), oz - (actor.z + revDirZ * 1.4)) < actor.halfLen + 1.8) {
                    rearBlocked = true;
                    break;
                  }
                }
                if (!rearBlocked) {
                  for (const t of this.pedestrianTargets) {
                    const animPed = this.animatedActors.get(t.id);
                    const px = animPed ? animPed.x : t.position.x;
                    const pz = animPed ? animPed.z : t.position.z;
                    if (Math.hypot(px - (actor.x + revDirX * 1.4), pz - (actor.z + revDirZ * 1.4)) < 2.4) {
                      rearBlocked = true;
                      break;
                    }
                  }
                }

                const targetRevSpeed = rearBlocked ? 0 : 2.4;
                actor.currentSpeed = THREE.MathUtils.damp(
                  actor.currentSpeed,
                  targetRevSpeed,
                  rearBlocked ? 14 : 6,
                  stepDelta,
                );
                if (rearBlocked && actor.currentSpeed < 0.08) actor.currentSpeed = 0;
                actor.isYielding = rearBlocked;

                const step = actor.currentSpeed * stepDelta;
                const segLen = Math.max(0.5, actor.parkingReverseSegDist ?? 1.5);
                const segProg = clamp(1 - dist / segLen, 0, 1);
                const startYaw = actor.parkingReverseStartYaw ?? actor.rotationY;
                const endYaw = actor.parkingExitAisleYaw ?? actor.rotationY;
                const overallFrac =
                  revIdx === 0 ? segProg * 0.25 : 0.25 + segProg * 0.75;
                let yawDelta = endYaw - startYaw;
                while (yawDelta > Math.PI) yawDelta -= Math.PI * 2;
                while (yawDelta < -Math.PI) yawDelta += Math.PI * 2;
                actor.rotationY = startYaw + yawDelta * overallFrac;

                if (!rearBlocked && dist <= step + 0.18) {
                  actor.x = wp.x;
                  actor.z = wp.z;
                  const nextRevIdx = revIdx + 1;
                  if (nextRevIdx < actor.parkingReverseWaypoints.length) {
                    actor.parkingReverseIdx = nextRevIdx;
                    const nextWp = actor.parkingReverseWaypoints[nextRevIdx];
                    actor.parkingReverseSegDist = Math.max(
                      0.5,
                      Math.hypot(nextWp.x - actor.x, nextWp.z - actor.z),
                    );
                  } else {
                    actor.rotationY = endYaw;
                    const lot = actor.parkingLotId
                      ? this.currentTargets.find(
                          (t) => t.id === actor.parkingLotId && t.kind === 'parking-lot',
                        )
                      : undefined;
                    if (!lot) {
                      this.clearActorParkingState(actor);
                      this.assignInitialGraphRoute(actor);
                    } else {
                      const mouthPt = this.toLotWorld(lot, 0, 4.6);
                      const apronPt = this.toLotWorld(lot, 0, 6.8);
                      const exitConn = this.findNearestRoadConnectionForLot(
                        lot,
                        getActorHalfWidth(actor.kind),
                        1,
                      );
                      actor.parkingPhase = 'exiting-lot';
                      if (exitConn) {
                        const remPts = exitConn.edge.points.slice(exitConn.pIdx);
                        const firstRem = remPts[0];
                        const skipFirst =
                          firstRem &&
                          Math.hypot(firstRem.x - exitConn.point.x, firstRem.z - exitConn.point.z) < 0.7;
                        actor.subPath = [
                          mouthPt,
                          apronPt,
                          exitConn.point,
                          ...(skipFirst ? remPts.slice(1) : remPts),
                        ];
                        actor.subPathIdx = 0;
                        actor.graphNodeId = exitConn.edge.toNodeId;
                        actor.parkingExitRejoinSubIdx = 3;
                      } else {
                        actor.subPath = [mouthPt, apronPt];
                        actor.subPathIdx = 0;
                        actor.graphNodeId = undefined;
                        actor.parkingExitRejoinSubIdx = 2;
                      }
                    }
                  }
                } else if (!rearBlocked && dist > 1e-4) {
                  actor.x += revDirX * step;
                  actor.z += revDirZ * step;
                }

                const wheelPivots = group.userData.wheelPivots as THREE.Group[] | undefined;
                if (wheelPivots && actor.currentSpeed > 0) {
                  const wheelR = (group.userData.wheelRadius as number | undefined) ?? 0.32;
                  const spinAngle = (actor.currentSpeed * stepDelta) / wheelR;
                  for (const pivot of wheelPivots) {
                    pivot.rotation.z += spinAngle;
                  }
                }
              }
              group.position.x = actor.x;
              group.position.z = actor.z;
              group.position.y = THREE.MathUtils.damp(group.position.y, 0.015, 14, stepDelta);
              group.rotation.y = actor.rotationY;
              continue;
            }

            actor.speedDriftTimer = (actor.speedDriftTimer ?? 4.0) - stepDelta;
            if (actor.speedDriftTimer <= 0) {
              actor.speedDriftTimer = 3.5 + Math.random() * 5.0;
              actor.speed =
                getActorBaseSpeed(actor.kind, actor.rotationY) * (0.82 + Math.random() * 0.36);
            }

            if (
              actor.subPath === undefined &&
              actor.parkingPhase === undefined &&
              this.roadGraph.nodes.length > 0
            ) {
              this.assignInitialGraphRoute(actor);
            }

            const onRoadNow = isPointInsideAnyRoadway(actor.x, actor.z, this.modularRoadEntries);
            if (actor.seekingRoad && onRoadNow && (actor.subPathIdx ?? 0) > 0) {
              actor.seekingRoad = false;
            }

            let cornerScale = 1;
            const activeWp =
              actor.subPath &&
              (actor.graphNodeId !== undefined ||
                actor.parkingPhase === 'entering-lot' ||
                actor.parkingPhase === 'exiting-lot')
                ? actor.subPath[actor.subPathIdx ?? 0]
                : undefined;
            const seekSteer =
              actor.seekingRoad && !onRoadNow && activeWp
                ? this.getOffRoadSteerDirection(actor, activeWp.x, activeWp.z)
                : null;
            if (activeWp) {
              const adx = seekSteer ? seekSteer.dirX : activeWp.x - actor.x;
              const adz = seekSteer ? seekSteer.dirZ : activeWp.z - actor.z;
              if (Math.hypot(adx, adz) > 1e-4) {
                const tRot = Math.atan2(-adz, adx);
                let diff = tRot - actor.rotationY;
                while (diff > Math.PI) diff -= Math.PI * 2;
                while (diff < -Math.PI) diff += Math.PI * 2;
                if (actor.seekingRoad && !onRoadNow) {
                  if (Math.abs(diff) > 0.75) {
                    cornerScale = 0.14;
                  } else if (Math.abs(diff) > 0.25) {
                    cornerScale = clamp(1 - Math.abs(diff) * 0.65, 0.28, 1);
                  }
                } else if (Math.abs(diff) > 0.25) {
                  cornerScale = clamp(1 - Math.abs(diff) * 0.42, 0.48, 1);
                }
              }
            }

            const traffic = this.getVehicleTrafficScale(id, actor);
            actor.isYielding = traffic.yieldingToPed || traffic.scale < 0.15;
            if (traffic.hardStop) {
              actor.currentSpeed = 0;
            } else {
              let effectiveBaseSpeed =
                actor.seekingRoad && !onRoadNow ? Math.min(actor.speed, 6.8) : actor.speed;
              if (actor.parkingPhase === 'entering-lot') {
                effectiveBaseSpeed = Math.min(effectiveBaseSpeed, 3.3);
              } else if (actor.parkingPhase === 'exiting-lot' && (actor.subPathIdx ?? 0) <= 1) {
                effectiveBaseSpeed = Math.min(effectiveBaseSpeed, 3.6);
              } else if (actor.parkingOnFinalEdge) {
                effectiveBaseSpeed = Math.min(effectiveBaseSpeed, 6.2);
              }
              const targetSpeed = effectiveBaseSpeed * traffic.scale * cornerScale;
              const dampRate = targetSpeed < actor.currentSpeed ? 14.5 : 5.2;
              actor.currentSpeed = THREE.MathUtils.damp(
                actor.currentSpeed,
                targetSpeed,
                dampRate,
                stepDelta,
              );
              if (targetSpeed === 0 && actor.currentSpeed < 0.08) {
                actor.currentSpeed = 0;
              }
              if (
                traffic.maxAdvanceDist < Infinity &&
                actor.currentSpeed * stepDelta > traffic.maxAdvanceDist
              ) {
                actor.currentSpeed =
                  traffic.maxAdvanceDist <= 0.015
                    ? 0
                    : traffic.maxAdvanceDist / Math.max(stepDelta, 1e-4);
              }
            }

            if (
              actor.subPath &&
              ((actor.graphNodeId !== undefined &&
                actor.graphNodeId < this.roadGraph.nodes.length) ||
                actor.parkingPhase === 'entering-lot' ||
                actor.parkingPhase === 'exiting-lot')
            ) {
              const wp = actor.subPath[actor.subPathIdx ?? 0];
              if (wp) {
                const dx = wp.x - actor.x;
                const dz = wp.z - actor.z;
                const dist = Math.hypot(dx, dz);
                const step = Math.min(
                  actor.currentSpeed * stepDelta,
                  traffic.maxAdvanceDist,
                );

                const steerDirX = seekSteer ? seekSteer.dirX : dist > 1e-4 ? dx / dist : 0;
                const steerDirZ = seekSteer ? seekSteer.dirZ : dist > 1e-4 ? dz / dist : 0;

                if (dist > 1e-4) {
                  const targetRotY = Math.atan2(-steerDirZ, steerDirX);
                  let angleDiff = targetRotY - actor.rotationY;
                  while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
                  while (angleDiff < -Math.PI) angleDiff += Math.PI * 2;
                  const turnGain =
                    actor.parkingPhase === 'entering-lot' || actor.parkingPhase === 'exiting-lot'
                      ? 14.5
                      : actor.seekingRoad && !onRoadNow
                        ? 14.0
                        : actor.subPath.length >= 3
                          ? 12.5
                          : 10.0;
                  actor.rotationY += angleDiff * Math.min(1, turnGain * stepDelta);
                }

                const baseSnapTolerance =
                  actor.parkingPhase === 'entering-lot' || actor.parkingPhase === 'exiting-lot'
                    ? 0.2
                    : 0.35;
                const snapTolerance =
                  traffic.maxAdvanceDist < Infinity
                    ? Math.min(baseSnapTolerance, Math.max(0, traffic.maxAdvanceDist - step))
                    : baseSnapTolerance;

                const isOnFinalWrapSeg =
                  !actor.seekingRoad &&
                  actor.parkingPhase !== 'entering-lot' &&
                  actor.parkingPhase !== 'exiting-lot' &&
                  actor.graphNodeId !== undefined &&
                  (actor.subPathIdx ?? 0) === actor.subPath.length - 1 &&
                  this.getWrapEdgeForNode(actor.graphNodeId) !== null;
                const wrapOutNode = isOnFinalWrapSeg
                  ? this.roadGraph.nodes[actor.graphNodeId!]
                  : undefined;
                const wrapAligned = wrapOutNode
                  ? Math.cos(actor.rotationY) * wrapOutNode.dirX +
                      -Math.sin(actor.rotationY) * wrapOutNode.dirZ >=
                    0.85
                  : false;
                const wrapTriggerDist =
                  isOnFinalWrapSeg && wrapAligned ? Math.min(actor.halfLen, 4.65) : 0;
                const reachedWrapTrigger =
                  isOnFinalWrapSeg &&
                  wrapAligned &&
                  dist <= wrapTriggerDist + Math.max(step, 0) + baseSnapTolerance;

                if (
                  reachedWrapTrigger ||
                  ((step > 1e-5 || dist < 0.02) && dist <= step + snapTolerance)
                ) {
                  if (
                    !reachedWrapTrigger &&
                    actor.currentSpeed > 0 &&
                    this.wouldCollideWithVehicleAhead(id, actor, wp.x, wp.z, actor.rotationY)
                  ) {
                    actor.currentSpeed = 0;
                    actor.isYielding = true;
                  } else {
                    if (reachedWrapTrigger) {
                      actor.subPathIdx = actor.subPath.length;
                    } else {
                      actor.x = wp.x;
                      actor.z = wp.z;
                      actor.subPathIdx = (actor.subPathIdx ?? 0) + 1;
                    }
                    if (actor.seekingRoad && isPointInsideAnyRoadway(actor.x, actor.z, this.modularRoadEntries)) {
                      actor.seekingRoad = false;
                    }

                    if (
                      actor.parkingPhase === 'exiting-lot' &&
                      (actor.subPathIdx ?? 0) >= (actor.parkingExitRejoinSubIdx ?? 3)
                    ) {
                      const needSeek = actor.graphNodeId === undefined;
                      this.clearActorParkingState(actor);
                      actor.lastParkedAt = this.simElapsedSeconds;
                      if (needSeek) {
                        this.assignInitialGraphRoute(actor);
                      }
                    }

                    if (
                      actor.parkingPhase === 'entering-lot' &&
                      actor.subPath &&
                      (actor.subPathIdx ?? 0) >= actor.subPath.length
                    ) {
                      actor.parkingPhase = 'parked';
                      actor.parkingDwellTimer = 600 + Math.random() * 300;
                      actor.currentSpeed = 0;
                      actor.isYielding = false;
                      actor.subPath = undefined;
                      actor.subPathIdx = 0;
                      actor.graphNodeId = undefined;
                    } else if (
                      actor.parkingPhase === 'approaching-lot' &&
                      actor.parkingOnFinalEdge &&
                      actor.subPath &&
                      (actor.subPathIdx ?? 0) >= actor.subPath.length
                    ) {
                      if (actor.parkingEntryWaypoints && actor.parkingEntryWaypoints.length > 0) {
                        actor.parkingPhase = 'entering-lot';
                        actor.parkingOnFinalEdge = false;
                        actor.subPath = actor.parkingEntryWaypoints;
                        actor.subPathIdx = 0;
                        actor.graphNodeId = undefined;
                      } else {
                        this.clearActorParkingState(actor);
                        this.assignInitialGraphRoute(actor);
                      }
                    } else {
                      let hops = 0;
                      while (
                        actor.subPath &&
                        (actor.subPathIdx ?? 0) >= actor.subPath.length &&
                        actor.graphNodeId !== undefined &&
                        hops < 8
                      ) {
                        hops++;
                        const pick = this.pickNextGraphEdge(id, actor, actor.graphNodeId);
                        if (pick.waitForWrap) {
                          const holdNode = this.roadGraph.nodes[actor.graphNodeId];
                          if (holdNode && reachedWrapTrigger) {
                            // Keep holding inside the road right at wrapTriggerDist until destination clears
                            actor.subPath = [{ x: holdNode.x, z: holdNode.z }];
                            actor.subPathIdx = 0;
                          } else if (holdNode) {
                            actor.x = holdNode.x;
                            actor.z = holdNode.z;
                            actor.subPath = [{ x: holdNode.x, z: holdNode.z }];
                            actor.subPathIdx = 0;
                          }
                          actor.currentSpeed = 0;
                          actor.isYielding = true;
                          break;
                        }
                        const nextEdge = pick.edge;
                        if (!nextEdge) {
                          actor.subPath = undefined;
                          actor.graphNodeId = undefined;
                          break;
                        }
                        if (nextEdge.isRoundaboutStay) {
                          actor.roundaboutSteps = (actor.roundaboutSteps ?? 0) + 1;
                        } else if (nextEdge.isRoundaboutExit) {
                          actor.roundaboutSteps = 0;
                          actor.roundaboutTargetSteps = 1 + Math.floor(Math.random() * 8);
                        }
                        if (nextEdge.isWrap) {
                          const destNode = this.roadGraph.nodes[nextEdge.toNodeId];
                          if (destNode) {
                            const wrapPos = pick.wrapPos ?? { x: destNode.x, z: destNode.z };
                            actor.x = wrapPos.x;
                            actor.z = wrapPos.z;
                            actor.rotationY = Math.atan2(-destNode.dirZ, destNode.dirX);
                          }
                          actor.graphNodeId = nextEdge.toNodeId;
                          actor.subPath = [];
                          actor.subPathIdx = 0;
                          continue;
                        }
                        actor.graphNodeId = nextEdge.toNodeId;
                        actor.subPath = nextEdge.points;
                        actor.subPathIdx = 0;
                      }
                    }
                  }
                } else if (dist > 1e-4) {
                  const nx = actor.x + steerDirX * step;
                  const nz = actor.z + steerDirZ * step;
                  if (
                    step > 1e-4 &&
                    this.wouldCollideWithVehicleAhead(id, actor, nx, nz, actor.rotationY)
                  ) {
                    actor.currentSpeed = 0;
                    actor.isYielding = true;
                  } else {
                    actor.x = nx;
                    actor.z = nz;
                  }
                }
              }
            } else {
              // Off-graph random steering wander + periodic road network re-entry
              actor.offGraphTimer = (actor.offGraphTimer ?? 2.0) - stepDelta;
              if (actor.offGraphTimer <= 0) {
                actor.offGraphTimer = 1.5 + Math.random() * 3.0;
                actor.offGraphTurnRate = (Math.random() - 0.5) * 0.7;
                if (this.roadGraph.nodes.length > 0) {
                  this.assignInitialGraphRoute(actor);
                }
              }
              actor.rotationY += (actor.offGraphTurnRate ?? 0) * stepDelta;
              const fx = Math.cos(actor.rotationY);
              const fz = -Math.sin(actor.rotationY);

              const nx = actor.x + fx * actor.currentSpeed * stepDelta;
              const nz = actor.z + fz * actor.currentSpeed * stepDelta;
              if (
                actor.currentSpeed > 0 &&
                this.wouldCollideWithVehicleAhead(id, actor, nx, nz, actor.rotationY)
              ) {
                actor.currentSpeed = 0;
                actor.isYielding = true;
              } else {
                actor.x = nx;
                actor.z = nz;
              }

              if (
                Math.abs(actor.x) > FIXTURE_MAX_X - 3.0 ||
                Math.abs(actor.z) > FIXTURE_MAX_Z - 3.0
              ) {
                actor.x = clamp(actor.x, -FIXTURE_MAX_X + 2.5, FIXTURE_MAX_X - 2.5);
                actor.z = clamp(actor.z, -FIXTURE_MAX_Z + 2.5, FIXTURE_MAX_Z - 2.5);
                const inwardRot = Math.atan2(actor.z, -actor.x) + (Math.random() - 0.5) * 0.8;
                actor.rotationY = inwardRot;
              }
            }

            const baseGroundY = this.getGroundPlacementHeight(actor.x, actor.z, actor.kind);
            const targetY =
              actor.parkingPhase === 'entering-lot' ||
              actor.parkingPhase === 'reversing-out' ||
              actor.parkingPhase === 'exiting-lot'
                ? Math.max(0.015, baseGroundY)
                : baseGroundY;
            group.position.x = actor.x;
            group.position.z = actor.z;
            group.position.y = THREE.MathUtils.damp(group.position.y, targetY, 14, stepDelta);
            group.rotation.y = actor.rotationY;

            const wheelPivots = group.userData.wheelPivots as THREE.Group[] | undefined;
            if (wheelPivots && actor.currentSpeed > 0) {
              const wheelR = (group.userData.wheelRadius as number | undefined) ?? 0.32;
              const spinAngle = (actor.currentSpeed * stepDelta) / wheelR;
              for (const pivot of wheelPivots) {
                pivot.rotation.z -= spinAngle;
              }
            }
          }
        }
        keepAnimating = true;
      }

      this.camera.layers.mask = (1 << 0) | (1 << 2);
      this.renderer.render(this.scene, this.camera);

      const done = () => {
        this.renderBusy = false;
        if (this.renderDirty || keepAnimating) {
          this.requestRender();
        }
      };

      if (this.isSoftwareGl) {
        this.afterDraw(done);
      } else {
        done();
      }
    });
  }

  public dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.frameId);
    clearTimeout(this.frameId);
    this.unbindEvents();
    this.controls.dispose();

    disposeObject3DResources(this.scene);

    for (const entry of this.lightEntries.values()) {
      entry.spotLight.map = null;
      entry.goboTex?.dispose();
      entry.poleRefs.shieldTex.dispose();
    }
    disposeLuxOverlayState(this.luxOverlayState);

    this.asphaltTex.dispose();
    this.sidewalkTex.dispose();
    this.contactShadowTex.dispose();
    this.curbMat.dispose();
    this.sidewalkMat.dispose();
    this.selectedSidewalkMat.dispose();
    disposeCachedRoadTextures();
    this.renderer.dispose();
    if (this.renderer.domElement.parentNode === this.container) {
      this.container.removeChild(this.renderer.domElement);
    }
  }
}
