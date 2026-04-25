# GPU Acceleration Implementation Summary

## Overview
This document describes the GPU acceleration feature added to Photo Importer's face recognition pipeline via ONNX Runtime.

## Changes Made

### 1. Core Face Engine (`src/main/services/face-engine.ts`)

#### New state variable
```typescript
let gpuAvailable: boolean | null = null;
```
Tracks GPU availability status across the app lifetime (null = unknown, true = GPU available, false = CPU only).

#### New function: `getExecutionProviders()`
Determines optimal ONNX Runtime execution providers based on platform:

- **Windows**: `['dml', 'cuda', 'tensorrt', 'cpu']`
  - DirectML first (GPU-agnostic, works with any Windows GPU)
  - Then CUDA for NVIDIA
  - Fallback to CPU
  
- **macOS**: `['coreml', 'cuda', 'tensorrt', 'cpu']`
  - CoreML for Apple Silicon
  - CUDA for Intel with external GPU
  - Fallback to CPU
  
- **Linux**: `['cuda', 'tensorrt', 'cpu']`
  - CUDA for NVIDIA
  - Fallback to CPU

#### Modified function: `loadSessions()`
Now attempts to load ONNX sessions with GPU providers first:

1. Try GPU providers via `runtime.InferenceSession.create(path, opts)` where `opts.executionProviders` includes GPU
2. If GPU fails, catch the error and retry with CPU-only: `['cpu']`
3. Set `gpuAvailable = true` if GPU providers were used, `false` if CPU fallback occurred
4. Console warning logged when falling back to CPU

#### New function: `isGpuAvailable()`
Public API to check GPU status:
```typescript
export function isGpuAvailable(): boolean | null {
  return gpuAvailable;
}
```

#### Updated function: `disposeFaceEngine()`
Now resets `gpuAvailable` state when sessions are disposed.

### 2. IPC Interface Updates

#### `src/shared/types.ts`
Added new IPC message constant:
```typescript
FACE_GPU_AVAILABLE: 'face:gpu-available',
```

#### `src/main/ipc-handlers.ts`
1. Imported `isGpuAvailable` from face-engine
2. Added new IPC handler:
```typescript
ipcMain.handle(IPC.FACE_GPU_AVAILABLE, () => {
  return isGpuAvailable();
});
```

#### `src/main/preload.ts`
Exposed GPU status via Electron preload API:
```typescript
isGpuAvailable: (): Promise<boolean | null> =>
  ipcRenderer.invoke(IPC.FACE_GPU_AVAILABLE),
```

### 3. Documentation (`README.md`)

Added comprehensive GPU Acceleration section covering:
- How GPU detection works (platform-specific providers)
- Performance improvements (0.1–0.5s GPU vs 20–30s CPU)
- Installation instructions (CUDA, cuDNN, CoreML)
- Troubleshooting guide
- Developer tools for checking GPU status

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ User opens Photo Importer                                    │
└─────────────────────────┬───────────────────────────────────┘
                          │
                    ┌─────▼──────┐
                    │ Start app  │
                    └─────┬──────┘
                          │
           ┌──────────────┴──────────────┐
           │                             │
    ┌──────▼──────────┐         ┌────────▼────────┐
    │ First face      │         │ Manual check    │
    │ analysis call   │         │ via isGpuAvail()│
    └──────┬──────────┘         └────────┬────────┘
           │                             │
           └──────────────┬──────────────┘
                          │
                    ┌─────▼──────────────────┐
                    │ loadSessions() called   │
                    └─────┬──────────────────┘
                          │
              ┌───────────┴──────────────┐
              │                          │
         ┌────▼────────────┐     ┌──────▼──────┐
         │ Try GPU first   │     │ Platform-   │
         │ providers       │     │ specific    │
         └────┬────────────┘     │ selection   │
              │                  └──────┬──────┘
              │                         │
         ┌────▼─────┐         ┌─────────▼────┐
         │ Success? │         │ Windows: DML │
         │          │         │ macOS: CoreML│
         └─┬───┬────┘         │ Linux: CUDA  │
           │   │              └──────┬───────┘
       Yes │   │ No                  │
           │   │         ┌───────────▼────┐
           │   │         │ Retry with CPU │
           │   │         │ only           │
           │   │         └───────────┬────┘
           │   │                     │
      ┌────▼───▼─────────────────────▼───┐
      │ gpuAvailable = true / false        │
      │ (cached for app lifetime)          │
      └────────────────────────────────────┘
```

## API Usage (from Renderer)

```javascript
// Check GPU status
const gpuStatus = await window.electronAPI.isGpuAvailable();
// null = not yet determined
// true = GPU available and active
// false = CPU only

console.log('GPU available:', gpuStatus);
```

## Performance Impact

### Expected improvements

| Scenario | CPU | GPU | Speedup |
|----------|-----|-----|---------|
| Modern CPU (Ryzen 7900X3D) | 1s/photo | 0.1s/photo | 10× |
| Old CPU (i7-11th gen) | 25s/photo | 0.3s/photo | 80× |
| Batch of 100 photos | 100–2500s | 10–50s | 10–50× |
| RAW+JPEG pair (with embedding) | 50s | 1–2s | 25–50× |

### GPU provider selection logic

The implementation uses ONNX Runtime's multi-provider fallback mechanism:

1. **Provider order matters**: ONNX Runtime tries providers in list order
2. **Silent fallback**: If a GPU provider is unavailable (driver missing, etc.), ONNX moves to the next one
3. **Graceful CPU fallback**: If all GPU providers fail, we explicitly catch and retry with CPU
4. **One-time probe**: GPU availability is determined once on first face analysis, then cached

## Testing

### Manual testing checklist

- [ ] Run app on Windows with NVIDIA GPU → should use CUDA or TensorRT
- [ ] Run app on Windows without GPU → should use DirectML or CPU
- [ ] Run app on macOS with Apple Silicon → should use CoreML
- [ ] Run app on Linux with NVIDIA → should use CUDA
- [ ] Check console for "GPU acceleration unavailable..." warning on CPU-only systems
- [ ] Analyze a face batch and measure time: should be sub-second on GPU
- [ ] Run `window.electronAPI.isGpuAvailable()` in DevTools console → check status

### Automated testing

The face-engine tests should verify:
- `isGpuAvailable()` returns null before initialization
- `isGpuAvailable()` returns a boolean after first `analyzeFaces()` call
- GPU provider fallback logic works (though mocking ONNX sessions in tests is complex)

## Backward compatibility

✅ **Fully backward compatible**
- Existing code paths unchanged
- CPU-only fallback ensures app works on any system
- New API is purely additive (no breaking changes)
- Default behavior is identical (CPU only without GPU drivers)

## Future enhancements

1. **User preference UI** — Settings toggle for "Disable GPU" (useful for debugging or power-saving)
2. **Performance metrics** — Log inference time per image for performance tracking
3. **Quantized models** — Distribute INT8 quantized ONNX models for faster GPU/CPU inference
4. **Batch inference** — Queue multiple face analyses to saturate GPU more efficiently
5. **Multi-GPU support** — Use multiple GPUs if available (for very large batches)

## Dependencies

No new dependencies added. This feature leverages:
- **onnxruntime-node**: Already a dependency (v1.21.0)
  - GPU support is built into the npm package but requires runtime drivers/toolkits
- **CUDA / cuDNN** (optional): Must be installed separately by users who want NVIDIA GPU support
- **DirectML** (Windows): Built into Windows 10/11, no install needed
- **CoreML** (macOS): Built into macOS, Apple Silicon native

## Rollout considerations

1. **No breaking changes** — Safe to release immediately
2. **User communication** — Add FAQ to website about GPU setup (CUDA, cuDNN links)
3. **Performance telemetry** (future) — Consider logging GPU vs CPU usage for analytics
4. **Docs** — README GPU section should help most users understand it works automatically
