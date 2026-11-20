import { memo } from 'react';
import { LightFixture, PhotometricStats } from '../types/lighting';
import { getFixtureHex } from '../utils/photometrics';

interface TopTelemetryBarProps {
  activeFixture: LightFixture | undefined;
  fixtureCount: number;
  stats: PhotometricStats;
  showLuxHeatmap: boolean;
  luxThreshold: number;
}

export const TopTelemetryBar = memo(function TopTelemetryBar({
  activeFixture,
  fixtureCount,
  stats,
  showLuxHeatmap,
  luxThreshold,
}: TopTelemetryBarProps) {
  const activeColor = activeFixture ? getFixtureHex(activeFixture) : '#f59e0b';
  const thresholdLabel = Number.isInteger(luxThreshold)
    ? luxThreshold.toFixed(0)
    : luxThreshold.toFixed(1);
  const scaleMax = Math.round(Math.max(luxThreshold * 16, 250));
  const meetsThreshold = stats.cursorLux !== null && stats.cursorLux >= luxThreshold;

  return (
    <header className="pointer-events-auto relative z-20 flex h-12 w-full items-center justify-between gap-6 border-b border-slate-800/90 bg-[#0b0e17]/95 px-4 sm:px-6">
      <div className="flex items-center gap-4 min-w-0">
        <span className="text-sm font-semibold tracking-tight text-slate-100 whitespace-nowrap shrink-0">
          LuminaStreet 3D
        </span>
        {activeFixture && (
          <div className="hidden md:flex items-center gap-2 text-xs text-slate-400 whitespace-nowrap truncate">
            <span
              className="inline-block h-2.5 w-2.5 rounded-sm border border-white/20 shrink-0"
              style={{ backgroundColor: activeColor }}
              aria-hidden="true"
            />
            <span className="text-slate-200 font-medium">{activeFixture.name}</span>
            <span aria-hidden="true">·</span>
            <span className="font-mono-tabular">
              {activeFixture.height.toFixed(1)} m
            </span>
            <span aria-hidden="true">·</span>
            <span className="font-mono-tabular">
              {activeFixture.angleRange}° spread
            </span>
            <span aria-hidden="true">·</span>
            <span className="font-mono-tabular">
              {activeFixture.useCustomColor ? activeFixture.customColor.toUpperCase() : `${activeFixture.kelvin} K`}
            </span>
            {fixtureCount > 1 && (
              <>
                <span aria-hidden="true">·</span>
                <span>{fixtureCount} fixtures</span>
              </>
            )}
          </div>
        )}
      </div>

      <div className="flex items-center gap-5 sm:gap-7 shrink-0">
        {/* Live Cursor Lux Probe */}
        <div className="flex items-baseline gap-2 whitespace-nowrap">
          <span className="text-[11px] font-medium text-slate-400">Cursor Probe</span>
          {stats.cursorLux !== null && stats.cursorWorld ? (
            <span
              className={`font-mono-tabular text-sm font-semibold ${
                meetsThreshold ? 'text-cyan-400' : 'text-slate-300'
              }`}
            >
              {stats.cursorLux >= 100
                ? stats.cursorLux.toFixed(0)
                : stats.cursorLux.toFixed(1)}{' '}
              <span className="text-[11px] font-normal text-slate-400">lx</span>
              <span
                className={`ml-1.5 text-[10px] font-medium ${
                  meetsThreshold ? 'text-cyan-300' : 'text-slate-500'
                }`}
              >
                {meetsThreshold ? `≥${thresholdLabel}` : `<${thresholdLabel}`}
              </span>
              <span className="hidden lg:inline ml-2 text-[11px] font-normal text-slate-500">
                ({stats.cursorWorld.x.toFixed(1)}, {stats.cursorWorld.z.toFixed(1)} m)
              </span>
            </span>
          ) : (
            <span className="font-mono-tabular text-xs text-slate-500">Hover street</span>
          )}
        </div>

        {/* Peak Ground Lux */}
        <div className="hidden sm:flex items-baseline gap-2 whitespace-nowrap">
          <span className="text-[11px] font-medium text-slate-400">Peak</span>
          <span className="font-mono-tabular text-sm font-semibold text-amber-400">
            {stats.peakGroundLux >= 100
              ? stats.peakGroundLux.toFixed(0)
              : stats.peakGroundLux.toFixed(1)}{' '}
            <span className="text-[11px] font-normal text-slate-400">lx</span>
          </span>
        </div>

        {/* Lit Footprint Area */}
        <div className="hidden md:flex items-baseline gap-2 whitespace-nowrap">
          <span className="text-[11px] font-medium text-slate-400">
            Lit Area ≥{thresholdLabel} lx
          </span>
          <span className="font-mono-tabular text-sm font-semibold text-slate-200">
            {stats.footprintAreaSqM.toLocaleString()}{' '}
            <span className="text-[11px] font-normal text-slate-400">m²</span>
          </span>
        </div>

        {/* Beam Center Throw */}
        <div className="hidden lg:flex items-baseline gap-2 whitespace-nowrap">
          <span className="text-[11px] font-medium text-slate-400">Throw</span>
          <span className="font-mono-tabular text-sm font-semibold text-slate-200">
            {stats.centerThrowDistM !== null
              ? `${stats.centerThrowDistM.toFixed(1)} `
              : 'Above horizon'}
            {stats.centerThrowDistM !== null && (
              <span className="text-[11px] font-normal text-slate-400">m</span>
            )}
          </span>
        </div>

        {showLuxHeatmap && (
          <div className="hidden xl:flex items-center gap-1.5 text-[11px] text-slate-400 whitespace-nowrap border-l border-slate-800 pl-4">
            <span>{thresholdLabel} lx</span>
            <div
              className="h-2 w-20 rounded-sm"
              style={{
                background:
                  'linear-gradient(90deg, #0f6be0 0%, #0ac7e6 25%, #24d67a 50%, #faa814 75%, #fff2c7 100%)',
              }}
              aria-label={`Lux isoline scale from ${thresholdLabel} to ${scaleMax}+ lux`}
            />
            <span>{scaleMax}+ lx</span>
          </div>
        )}
      </div>
    </header>
  );
});
