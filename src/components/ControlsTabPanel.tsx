import { useEffect, useState } from 'react';
import { Keyboard, Mouse, RotateCcw } from 'lucide-react';
import {
  formatKeyCode,
  InputControlsConfig,
  KeybindAction,
  MouseDragButton,
} from '../types/lighting';

interface ControlsTabPanelProps {
  controlsConfig: InputControlsConfig;
  onUpdateControlsConfig: (next: InputControlsConfig) => void;
  onResetControlsConfig: () => void;
}

const MOUSE_BUTTON_OPTIONS: Array<{ id: MouseDragButton; label: string }> = [
  { id: 'left', label: 'Left' },
  { id: 'middle', label: 'Middle' },
  { id: 'right', label: 'Right' },
];

const KEYBIND_ROWS: Array<{ action: KeybindAction; label: string }> = [
  { action: 'moveForward', label: 'Move Forward' },
  { action: 'moveBackward', label: 'Move Backward' },
  { action: 'moveLeft', label: 'Strafe Left' },
  { action: 'moveRight', label: 'Strafe Right' },
  { action: 'moveUp', label: 'Camera Up' },
  { action: 'moveDown', label: 'Camera Down' },
  { action: 'rotate', label: 'Rotate +45°' },
  { action: 'delete', label: 'Delete Selected' },
  { action: 'toggleDock', label: 'Hide / Show Dock' },
];

export function ControlsTabPanel({
  controlsConfig,
  onUpdateControlsConfig,
  onResetControlsConfig,
}: ControlsTabPanelProps) {
  const [listeningAction, setListeningAction] = useState<KeybindAction | null>(null);

  useEffect(() => {
    if (!listeningAction) return;

    const handleCaptureKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();

      if (e.code === 'Escape') {
        setListeningAction(null);
        return;
      }

      const prevCode = controlsConfig.keybinds[listeningAction];
      const nextKeybinds = { ...controlsConfig.keybinds };

      // If another action already uses this key, swap cleanly so bindings never conflict
      for (const row of KEYBIND_ROWS) {
        if (row.action !== listeningAction && nextKeybinds[row.action] === e.code) {
          nextKeybinds[row.action] = prevCode;
        }
      }
      nextKeybinds[listeningAction] = e.code;

      onUpdateControlsConfig({
        ...controlsConfig,
        keybinds: nextKeybinds,
      });
      setListeningAction(null);
    };

    window.addEventListener('keydown', handleCaptureKeyDown, { capture: true });
    return () => {
      window.removeEventListener('keydown', handleCaptureKeyDown, { capture: true });
    };
  }, [listeningAction, controlsConfig, onUpdateControlsConfig]);

  const handleSetRotateButton = (btn: MouseDragButton) => {
    if (btn === controlsConfig.rotateMouseButton) return;
    const nextPan =
      controlsConfig.panMouseButton === btn
        ? controlsConfig.rotateMouseButton
        : controlsConfig.panMouseButton;
    onUpdateControlsConfig({
      ...controlsConfig,
      rotateMouseButton: btn,
      panMouseButton: nextPan,
    });
  };

  const handleSetPanButton = (btn: MouseDragButton) => {
    if (btn === controlsConfig.panMouseButton) return;
    const nextRotate =
      controlsConfig.rotateMouseButton === btn
        ? controlsConfig.panMouseButton
        : controlsConfig.rotateMouseButton;
    onUpdateControlsConfig({
      ...controlsConfig,
      panMouseButton: btn,
      rotateMouseButton: nextRotate,
    });
  };

  return (
    <div
      className="grid grid-cols-1 gap-4 lg:grid-cols-12"
      data-keybind-capture={listeningAction ? 'true' : undefined}
    >
      {/* Left Column: Mouse Buttons & Camera Speeds */}
      <div className="space-y-3 rounded-lg border border-slate-800/90 bg-slate-950/60 p-3 lg:col-span-5">
        <div className="flex items-center gap-1.5">
          <Mouse className="h-3.5 w-3.5 text-cyan-400" />
          <span className="text-xs font-semibold text-slate-200">
            Mouse & Camera Feel
          </span>
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-slate-300">Rotate Camera</span>
            <div className="flex items-center gap-1 rounded-md bg-slate-900 p-0.5 border border-slate-800">
              {MOUSE_BUTTON_OPTIONS.map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => handleSetRotateButton(opt.id)}
                  className={`rounded px-2.5 py-1 text-[11px] font-medium transition-colors whitespace-nowrap ${
                    controlsConfig.rotateMouseButton === opt.id
                      ? 'bg-amber-500 text-slate-950 font-semibold'
                      : 'text-slate-300 hover:bg-slate-800 hover:text-white'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-slate-300">Pan Camera</span>
            <div className="flex items-center gap-1 rounded-md bg-slate-900 p-0.5 border border-slate-800">
              {MOUSE_BUTTON_OPTIONS.map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => handleSetPanButton(opt.id)}
                  className={`rounded px-2.5 py-1 text-[11px] font-medium transition-colors whitespace-nowrap ${
                    controlsConfig.panMouseButton === opt.id
                      ? 'bg-cyan-400 text-slate-950 font-semibold'
                      : 'text-slate-300 hover:bg-slate-800 hover:text-white'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-2.5 border-t border-slate-800/80 pt-2.5 sm:grid-cols-3 lg:grid-cols-1">
          <div className="space-y-1">
            <div className="flex items-baseline justify-between">
              <label
                htmlFor="ctrl-move-speed"
                className="text-[11px] font-medium text-slate-300"
              >
                Movement & Pan Speed
              </label>
              <span className="font-mono-tabular text-xs font-semibold text-amber-400">
                {controlsConfig.moveSpeed.toFixed(1)}×
              </span>
            </div>
            <input
              id="ctrl-move-speed"
              type="range"
              min={0.4}
              max={2.5}
              step={0.1}
              value={controlsConfig.moveSpeed}
              onChange={(e) =>
                onUpdateControlsConfig({
                  ...controlsConfig,
                  moveSpeed: parseFloat(e.target.value),
                })
              }
              className="instrument-slider"
            />
          </div>

          <div className="space-y-1">
            <div className="flex items-baseline justify-between">
              <label
                htmlFor="ctrl-rotate-sens"
                className="text-[11px] font-medium text-slate-300"
              >
                Orbit Rotate Sensitivity
              </label>
              <span className="font-mono-tabular text-xs font-semibold text-cyan-400">
                {controlsConfig.rotateSensitivity.toFixed(1)}×
              </span>
            </div>
            <input
              id="ctrl-rotate-sens"
              type="range"
              min={0.4}
              max={2.5}
              step={0.1}
              value={controlsConfig.rotateSensitivity}
              onChange={(e) =>
                onUpdateControlsConfig({
                  ...controlsConfig,
                  rotateSensitivity: parseFloat(e.target.value),
                })
              }
              className="instrument-slider"
            />
          </div>

          <div className="space-y-1">
            <div className="flex items-baseline justify-between">
              <label
                htmlFor="ctrl-zoom-sens"
                className="text-[11px] font-medium text-slate-300"
              >
                Scroll Zoom Speed
              </label>
              <span className="font-mono-tabular text-xs font-semibold text-slate-200">
                {controlsConfig.zoomSensitivity.toFixed(1)}×
              </span>
            </div>
            <input
              id="ctrl-zoom-sens"
              type="range"
              min={0.4}
              max={2.5}
              step={0.1}
              value={controlsConfig.zoomSensitivity}
              onChange={(e) =>
                onUpdateControlsConfig({
                  ...controlsConfig,
                  zoomSensitivity: parseFloat(e.target.value),
                })
              }
              className="instrument-slider"
            />
          </div>
        </div>

        <p className="text-[11px] text-slate-400">
          Left-click selects or drags objects & poles · Scroll wheel zooms.
        </p>
      </div>

      {/* Right Column: Rebindable Keyboard Shortcuts */}
      <div className="flex flex-col justify-between space-y-2.5 rounded-lg border border-slate-800/90 bg-slate-950/60 p-3 lg:col-span-7">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-1.5">
            <Keyboard className="h-3.5 w-3.5 text-amber-400" />
            <span className="text-xs font-semibold text-slate-200">
              Keyboard Bindings
            </span>
            <span className="hidden sm:inline text-[11px] text-slate-400">
              · {listeningAction ? 'Press any key (Esc cancels)' : 'Click a key to rebind'}
            </span>
          </div>
          <button
            type="button"
            onClick={() => {
              setListeningAction(null);
              onResetControlsConfig();
            }}
            className="flex items-center gap-1 rounded border border-slate-700 bg-slate-900 px-2 py-1 text-[11px] font-medium text-slate-300 hover:border-amber-500/50 hover:text-white whitespace-nowrap shrink-0"
            title="Restore default mouse and keyboard controls"
          >
            <RotateCcw className="h-3 w-3" />
            <span>Reset Defaults</span>
          </button>
        </div>

        <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
          {KEYBIND_ROWS.map((row) => {
            const isListening = listeningAction === row.action;
            const boundCode = controlsConfig.keybinds[row.action];
            return (
              <div
                key={row.action}
                className={`flex items-center justify-between gap-2 rounded-md border px-2.5 py-1.5 ${
                  isListening
                    ? 'border-cyan-400 bg-cyan-500/15'
                    : 'border-slate-800 bg-slate-900/75'
                }`}
              >
                <span className="text-xs text-slate-200 truncate">
                  {row.label}
                </span>
                <button
                  type="button"
                  onClick={() =>
                    setListeningAction(isListening ? null : row.action)
                  }
                  className={`min-w-[68px] rounded border px-2 py-0.5 text-center font-mono-tabular text-[11px] font-semibold transition-colors whitespace-nowrap shrink-0 ${
                    isListening
                      ? 'border-cyan-400 bg-cyan-400 text-slate-950'
                      : 'border-slate-700 bg-slate-950 text-amber-300 hover:border-cyan-500/60 hover:text-white'
                  }`}
                >
                  {isListening ? 'Press key…' : formatKeyCode(boundCode)}
                </button>
              </div>
            );
          })}

          <div className="flex items-center justify-between gap-2 rounded-md border border-slate-800/70 bg-slate-900/40 px-2.5 py-1.5">
            <span className="text-xs text-slate-400 truncate">
              Cancel / Deselect
            </span>
            <span className="min-w-[68px] rounded border border-slate-800 bg-slate-950/70 px-2 py-0.5 text-center font-mono-tabular text-[11px] text-slate-400 whitespace-nowrap shrink-0">
              Esc
            </span>
          </div>
        </div>

        <p className="text-[11px] text-slate-400">
          Changes save automatically and apply immediately to the 3D viewport. Arrow keys also work when unbound.
        </p>
      </div>
    </div>
  );
}
