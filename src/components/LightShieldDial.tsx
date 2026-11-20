import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, RotateCcw, Shield, ShieldOff } from 'lucide-react';
import { LightFixture, SHIELD_SECTORS } from '../types/lighting';
import {
  getBlockedDegrees,
  getFixtureHex,
  getSectorAngle,
  hasCustomSectorAngles,
} from '../utils/photometrics';

interface LightShieldDialProps {
  fixture: LightFixture;
  onChangeMask: (mask: number) => void;
  onChangeSectorAngles: (sectorAngles: Record<number, number> | undefined) => void;
}

const ALL_SECTORS_MASK = (1 << SHIELD_SECTORS) - 1;
const SECTOR_DEG = 360 / SHIELD_SECTORS;
const COMPASS_LABELS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

function compassPoint(deg: number, radius: number): { x: number; y: number } {
  const rad = (deg * Math.PI) / 180;
  return {
    x: radius * Math.sin(rad),
    y: -radius * Math.cos(rad),
  };
}

function buildAnnularSectorPath(
  startDeg: number,
  endDeg: number,
  innerR: number,
  outerR: number,
): string {
  const p1 = compassPoint(startDeg, outerR);
  const p2 = compassPoint(endDeg, outerR);
  const p3 = compassPoint(endDeg, innerR);
  const p4 = compassPoint(startDeg, innerR);
  return [
    `M ${p1.x.toFixed(2)} ${p1.y.toFixed(2)}`,
    `A ${outerR.toFixed(2)} ${outerR.toFixed(2)} 0 0 1 ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`,
    `L ${p3.x.toFixed(2)} ${p3.y.toFixed(2)}`,
    `A ${innerR.toFixed(2)} ${innerR.toFixed(2)} 0 0 0 ${p4.x.toFixed(2)} ${p4.y.toFixed(2)}`,
    'Z',
  ].join(' ');
}

function buildRimArcPath(startDeg: number, endDeg: number, radius: number): string {
  const p1 = compassPoint(startDeg, radius);
  const p2 = compassPoint(endDeg, radius);
  return `M ${p1.x.toFixed(2)} ${p1.y.toFixed(2)} A ${radius} ${radius} 0 0 1 ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`;
}

function angularDiffDeg(a: number, b: number): number {
  return Math.abs((((a - b) % 360) + 540) % 360 - 180);
}

function formatSectorCompass(sector: number): string {
  const start = Math.round(sector * SECTOR_DEG);
  const end = Math.round((sector + 1) * SECTOR_DEG);
  const center = (sector + 0.5) * SECTOR_DEG;
  const dir = COMPASS_LABELS[Math.round(center / 45) % 8];
  return `${start}°–${end}° ${dir}`;
}

export function LightShieldDial({
  fixture,
  onChangeMask,
  onChangeSectorAngles,
}: LightShieldDialProps) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [dialTool, setDialTool] = useState<'shield' | 'angle'>('shield');
  const [selectedSector, setSelectedSector] = useState<number>(0);
  const [paintMode, setPaintMode] = useState<'block' | 'open' | 'angle' | null>(null);
  const [brushAngle, setBrushAngle] = useState<number>(fixture.angleRange);
  const latestSectorAnglesRef = useRef(fixture.sectorAngles);
  latestSectorAnglesRef.current = fixture.sectorAngles;

  const mask = (fixture.shieldSectors ?? 0) & ALL_SECTORS_MASK;
  const blockedDeg = getBlockedDegrees(mask);
  const lightHex = getFixtureHex(fixture);
  const customAnglesActive = hasCustomSectorAngles(fixture.sectorAngles);

  const selectedIsBlocked = ((mask >> selectedSector) & 1) !== 0;
  const selectedCustomVal = fixture.sectorAngles?.[selectedSector];
  const selectedEffectiveAngle = getSectorAngle(
    fixture.angleRange,
    fixture.sectorAngles,
    selectedSector,
  );

  // Sync brush angle with selected sector only when switching fixture or inspecting in shield mode
  useEffect(() => {
    if (dialTool === 'shield' && paintMode === null) {
      setBrushAngle(selectedEffectiveAngle);
    }
  }, [fixture.id, selectedSector, selectedEffectiveAngle, dialTool, paintMode]);

  // Fixture aim azimuth on the N=0° (-Z) clockwise compass dial
  const compassAimDeg = (((180 - fixture.yawAngle) % 360) + 360) % 360;
  const aimTip = compassPoint(compassAimDeg, fixture.tiltAngle <= 3 ? 10 : 34);

  const getSectorFromPointer = (clientX: number, clientY: number): number | null => {
    const svg = svgRef.current;
    if (!svg) return null;
    const rect = svg.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const dx = clientX - cx;
    const dy = clientY - cy;
    const dist = Math.hypot(dx, dy);
    const scaleRadius = rect.width / 2;
    if (dist < scaleRadius * 0.14) return null;

    const azimDeg = (((Math.atan2(dx, -dy) * 180) / Math.PI) + 360) % 360;
    return Math.floor(azimDeg / SECTOR_DEG) % SHIELD_SECTORS;
  };

  const applySectorPaint = (sector: number, mode: 'block' | 'open') => {
    const bit = 1 << sector;
    const nextMask = mode === 'block' ? mask | bit : mask & ~bit;
    if (nextMask !== mask) {
      onChangeMask(nextMask);
    }
  };

  const setSectorBeamAngle = (sector: number, angleDeg: number) => {
    const clamped = Math.max(0, Math.min(180, Math.round(angleDeg)));
    const prevMap = latestSectorAnglesRef.current ?? {};
    if (prevMap[sector] === clamped) return;
    const nextMap: Record<number, number> = { ...prevMap, [sector]: clamped };
    latestSectorAnglesRef.current = nextMap;
    onChangeSectorAngles(nextMap);
  };

  const resetSectorBeamAngle = (sector: number) => {
    const prevMap = latestSectorAnglesRef.current;
    if (!prevMap || prevMap[sector] === undefined) return;
    const nextMap = { ...prevMap };
    delete nextMap[sector];
    const hasRemaining = Object.keys(nextMap).length > 0;
    latestSectorAnglesRef.current = hasRemaining ? nextMap : undefined;
    onChangeSectorAngles(hasRemaining ? nextMap : undefined);
  };

  const handlePointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    const sector = getSectorFromPointer(e.clientX, e.clientY);
    if (sector === null) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setSelectedSector(sector);

    if (dialTool === 'angle') {
      setPaintMode('angle');
      setSectorBeamAngle(sector, brushAngle);
      return;
    }

    const isCurrentlyBlocked = ((mask >> sector) & 1) !== 0;
    const mode: 'block' | 'open' = isCurrentlyBlocked ? 'open' : 'block';
    setPaintMode(mode);
    applySectorPaint(sector, mode);
  };

  const handlePointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!paintMode) return;
    const sector = getSectorFromPointer(e.clientX, e.clientY);
    if (sector === null) return;
    setSelectedSector(sector);
    if (paintMode === 'angle') {
      setSectorBeamAngle(sector, brushAngle);
    } else {
      applySectorPaint(sector, paintMode);
    }
  };

  const stopPainting = (e: React.PointerEvent<SVGSVGElement>) => {
    if (paintMode) {
      setPaintMode(null);
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
    }
  };

  const handleShieldBackHalf = () => {
    const backCenterDeg = (compassAimDeg + 180) % 360;
    let next = 0;
    for (let i = 0; i < SHIELD_SECTORS; i++) {
      const centerDeg = (i + 0.5) * SECTOR_DEG;
      if (angularDiffDeg(centerDeg, backCenterDeg) < 90) {
        next |= 1 << i;
      }
    }
    onChangeMask(next);
  };

  const customCount = fixture.sectorAngles
    ? Object.keys(fixture.sectorAngles).length
    : 0;

  return (
    <div className="flex flex-col justify-between gap-2 rounded-lg border border-slate-800/90 bg-slate-950/70 p-2.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          {blockedDeg > 0 ? (
            <Shield className="h-3.5 w-3.5 text-rose-400 shrink-0" />
          ) : (
            <ShieldOff className="h-3.5 w-3.5 text-slate-400 shrink-0" />
          )}
          <span className="text-xs font-medium text-slate-200 whitespace-nowrap">
            360° Light Shield
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          {customCount > 0 && (
            <span className="rounded bg-cyan-500/15 px-1.5 py-0.5 font-mono-tabular text-[10px] font-medium text-cyan-300 whitespace-nowrap">
              {customCount} angled
            </span>
          )}
          <span
            className={`font-mono-tabular text-[11px] font-semibold whitespace-nowrap ${
              blockedDeg > 0 ? 'text-rose-400' : 'text-cyan-400'
            }`}
          >
            {blockedDeg > 0 ? `${blockedDeg}° blocked` : 'Open 360°'}
          </span>
        </div>
      </div>

      {/* Ring click mode toggle */}
      <div className="grid grid-cols-2 gap-1 rounded-md border border-slate-800 bg-slate-900/90 p-0.5">
        <button
          type="button"
          onClick={() => setDialTool('shield')}
          className={`rounded px-2 py-1 text-[11px] font-medium transition-colors whitespace-nowrap ${
            dialTool === 'shield'
              ? 'bg-rose-500/20 text-rose-200 shadow-sm'
              : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          Shield On/Off
        </button>
        <button
          type="button"
          onClick={() => setDialTool('angle')}
          className={`rounded px-2 py-1 text-[11px] font-medium transition-colors whitespace-nowrap ${
            dialTool === 'angle'
              ? 'bg-cyan-500/20 text-cyan-200 shadow-sm'
              : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          Paint Beam Angle
        </button>
      </div>

      <div className="flex items-center justify-center gap-3">
        <svg
          ref={svgRef}
          viewBox="-64 -64 128 128"
          className="h-[116px] w-[116px] shrink-0 cursor-crosshair select-none touch-none"
          aria-label="360 degree light shield dial"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={stopPainting}
          onPointerCancel={stopPainting}
        >
          {/* Outer compass ring & 90° beam reference circle */}
          <circle
            cx={0}
            cy={0}
            r={47}
            fill="#070a12"
            stroke="#1e293b"
            strokeWidth={1}
          />
          <circle
            cx={0}
            cy={0}
            r={31}
            fill="none"
            stroke="#1e293b"
            strokeOpacity={0.75}
            strokeWidth={0.6}
            strokeDasharray="2 2"
            pointerEvents="none"
          />

          {/* 24 selectable 15-degree sectors */}
          {Array.from({ length: SHIELD_SECTORS }, (_, i) => {
            const startDeg = i * SECTOR_DEG + 0.8;
            const endDeg = (i + 1) * SECTOR_DEG - 0.8;
            const isBlocked = ((mask >> i) & 1) !== 0;
            const sectorAngle = getSectorAngle(fixture.angleRange, fixture.sectorAngles, i);
            const hasOverride = fixture.sectorAngles?.[i] !== undefined;
            const isSelected = selectedSector === i;

            const trackPath = buildAnnularSectorPath(startDeg, endDeg, 15, 43);
            const lobeOuterR = 19 + (sectorAngle / 180) * 24;
            const lobePath = buildAnnularSectorPath(startDeg, endDeg, 15, lobeOuterR);
            const rimPath = buildRimArcPath(startDeg, endDeg, 46.5);

            return (
              <g key={i}>
                {/* Full-sector hit track */}
                <path
                  d={trackPath}
                  fill={isBlocked ? '#0f172a' : '#0b1120'}
                  fillOpacity={isBlocked ? 0.92 : 0.65}
                  stroke={isSelected ? '#38bdf8' : isBlocked ? '#334155' : '#1e293b'}
                  strokeOpacity={isSelected ? 0.95 : 0.6}
                  strokeWidth={isSelected ? 1.2 : 0.5}
                />
                {/* Radial beam-angle lobe for unshielded sector */}
                {!isBlocked && (
                  <path
                    d={lobePath}
                    fill={lightHex}
                    fillOpacity={hasOverride ? 0.56 : 0.34}
                    stroke={isSelected ? '#38bdf8' : lightHex}
                    strokeOpacity={isSelected ? 0.95 : 0.55}
                    strokeWidth={isSelected ? 1.0 : 0.5}
                    pointerEvents="none"
                  />
                )}
                {/* Outer rim marker for blocked (rose) or custom-angled (cyan) sectors */}
                {(isBlocked || hasOverride) && (
                  <path
                    d={rimPath}
                    fill="none"
                    stroke={isBlocked ? '#fb7185' : '#22d3ee'}
                    strokeWidth={isBlocked ? 3.2 : 2.1}
                    strokeLinecap="butt"
                    pointerEvents="none"
                  />
                )}
              </g>
            );
          })}

          {/* Subtle cardinal axis crosshairs */}
          <line
            x1={-43}
            y1={0}
            x2={43}
            y2={0}
            stroke="#475569"
            strokeOpacity={0.35}
            strokeWidth={0.6}
            strokeDasharray="2 2"
            pointerEvents="none"
          />
          <line
            x1={0}
            y1={-43}
            x2={0}
            y2={43}
            stroke="#475569"
            strokeOpacity={0.35}
            strokeWidth={0.6}
            strokeDasharray="2 2"
            pointerEvents="none"
          />

          {/* Aim vector line & hub */}
          <line
            x1={0}
            y1={0}
            x2={aimTip.x}
            y2={aimTip.y}
            stroke="#fbbf24"
            strokeWidth={1.8}
            strokeLinecap="round"
            pointerEvents="none"
          />
          <circle
            cx={aimTip.x}
            cy={aimTip.y}
            r={2.5}
            fill="#fbbf24"
            pointerEvents="none"
          />
          <circle
            cx={0}
            cy={0}
            r={13}
            fill="#0b0e17"
            stroke="#334155"
            strokeWidth={1}
            pointerEvents="none"
          />
          <circle
            cx={0}
            cy={0}
            r={3.5}
            fill={lightHex}
            pointerEvents="none"
          />

          {/* Compass labels */}
          <text
            x={0}
            y={-52}
            textAnchor="middle"
            dominantBaseline="central"
            fill="#94a3b8"
            fontSize={8.5}
            fontWeight={600}
            pointerEvents="none"
          >
            N
          </text>
          <text
            x={54}
            y={0}
            textAnchor="middle"
            dominantBaseline="central"
            fill="#64748b"
            fontSize={8}
            fontWeight={600}
            pointerEvents="none"
          >
            E
          </text>
          <text
            x={0}
            y={54}
            textAnchor="middle"
            dominantBaseline="central"
            fill="#64748b"
            fontSize={8}
            fontWeight={600}
            pointerEvents="none"
          >
            S
          </text>
          <text
            x={-54}
            y={0}
            textAnchor="middle"
            dominantBaseline="central"
            fill="#64748b"
            fontSize={8}
            fontWeight={600}
            pointerEvents="none"
          >
            W
          </text>
        </svg>

        <div className="flex flex-col gap-1 min-w-[78px]">
          <button
            type="button"
            onClick={handleShieldBackHalf}
            className="rounded border border-slate-700 bg-slate-900 px-2 py-1 text-[11px] font-medium text-slate-200 hover:border-rose-500/60 hover:text-white whitespace-nowrap"
            title="Shield the 180° side behind the luminaire aim"
          >
            Back 180°
          </button>
          <button
            type="button"
            onClick={() => onChangeMask(mask ^ ALL_SECTORS_MASK)}
            className="rounded border border-slate-700 bg-slate-900 px-2 py-1 text-[11px] font-medium text-slate-200 hover:border-cyan-500/60 hover:text-white whitespace-nowrap"
            title="Invert shielded and open sectors"
          >
            Flip Mask
          </button>
          <button
            type="button"
            disabled={!customAnglesActive}
            onClick={() => onChangeSectorAngles(undefined)}
            className="rounded border border-slate-800 bg-slate-900 px-2 py-1 text-[11px] font-medium text-slate-400 hover:border-cyan-500/50 hover:text-cyan-200 disabled:opacity-35 whitespace-nowrap"
            title="Reset all shield part beam angles back to fixture Angle Range"
          >
            Reset Angles
          </button>
          <button
            type="button"
            disabled={mask === 0}
            onClick={() => onChangeMask(0)}
            className="rounded border border-slate-800 bg-slate-900 px-2 py-1 text-[11px] font-medium text-slate-400 hover:border-slate-600 hover:text-slate-200 disabled:opacity-35 whitespace-nowrap"
            title="Remove all shields for full 360° output"
          >
            Clear Shields
          </button>
        </div>
      </div>

      {/* Selected Shield Part Beam Angle Control */}
      <div className="space-y-1.5 rounded-md border border-slate-800/80 bg-slate-900/60 p-2">
        <div className="flex items-center justify-between gap-1.5">
          <div className="flex items-center gap-1 min-w-0">
            <button
              type="button"
              onClick={() =>
                setSelectedSector((s) => (s + SHIELD_SECTORS - 1) % SHIELD_SECTORS)
              }
              className="rounded border border-slate-700/80 bg-slate-900 p-0.5 text-slate-400 hover:border-slate-500 hover:text-white"
              title="Previous shield part"
              aria-label="Previous shield part"
            >
              <ChevronLeft className="h-3 w-3" />
            </button>
            <button
              type="button"
              onClick={() => setSelectedSector((s) => (s + 1) % SHIELD_SECTORS)}
              className="rounded border border-slate-700/80 bg-slate-900 p-0.5 text-slate-400 hover:border-slate-500 hover:text-white"
              title="Next shield part"
              aria-label="Next shield part"
            >
              <ChevronRight className="h-3 w-3" />
            </button>
            <span className="ml-0.5 text-[11px] font-medium text-slate-300 truncate">
              Part #{selectedSector + 1} · {formatSectorCompass(selectedSector)}
            </span>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <button
              type="button"
              onClick={() =>
                applySectorPaint(selectedSector, selectedIsBlocked ? 'open' : 'block')
              }
              className={`rounded border px-1.5 py-0.5 text-[10px] font-medium transition-colors whitespace-nowrap ${
                selectedIsBlocked
                  ? 'border-rose-500/60 bg-rose-500/15 text-rose-200 hover:bg-rose-500/25'
                  : 'border-slate-700 bg-slate-900 text-slate-300 hover:border-slate-600'
              }`}
            >
              {selectedIsBlocked ? 'Shielded' : 'Open'}
            </button>
            {selectedCustomVal !== undefined && (
              <button
                type="button"
                onClick={() => resetSectorBeamAngle(selectedSector)}
                className="rounded border border-slate-700 bg-slate-900 p-0.5 text-slate-400 hover:border-cyan-500/60 hover:text-cyan-200"
                title={`Reset part beam angle to ${fixture.angleRange}°`}
              >
                <RotateCcw className="h-3 w-3" />
              </button>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <label
            htmlFor={`slider-sector-angle-${fixture.id}`}
            className="text-[11px] text-slate-400 whitespace-nowrap"
          >
            Beam
          </label>
          <input
            id={`slider-sector-angle-${fixture.id}`}
            type="range"
            min={0}
            max={180}
            step={1}
            value={dialTool === 'angle' ? brushAngle : selectedEffectiveAngle}
            onChange={(e) => {
              const val = parseInt(e.target.value, 10);
              setBrushAngle(val);
              setSectorBeamAngle(selectedSector, val);
            }}
            className="instrument-slider flex-1"
          />
          <span
            className={`font-mono-tabular text-xs font-semibold w-9 text-right whitespace-nowrap ${
              selectedCustomVal !== undefined ? 'text-cyan-300' : 'text-slate-200'
            }`}
          >
            {dialTool === 'angle' ? brushAngle : selectedEffectiveAngle}°
          </span>
        </div>
      </div>

      <p className="text-[10px] leading-tight text-slate-400">
        {dialTool === 'angle'
          ? 'Drag across ring sectors to paint this beam angle per shield part.'
          : 'Click any sector to select & set its beam angle, or drag to toggle shields.'}
      </p>
    </div>
  );
}
