# GPU Acceleration Testing Guide

## Quick verification

### 1. Check files were modified correctly

```bash
# Verify face-engine exports the new function
grep -n "export function isGpuAvailable" src/main/services/face-engine.ts

# Verify IPC handler is registered
grep -n "FACE_GPU_AVAILABLE" src/main/ipc-handlers.ts

# Verify preload API is exposed
grep -n "isGpuAvailable" src/main/preload.ts
```

### 2. Runtime verification (in DevTools console)

```javascript
// After app loads:
const gpuStatus = await window.electronAPI.isGpuAvailable();
console.log('GPU status:', gpuStatus);
// Expected output: null (not run), true (GPU), or false (CPU)

// Trigger face analysis
const results = await window.electronAPI.analyzeFaces('/path/to/photo.jpg');
console.log('Analysis complete');

// Check status again (should now be determined)
const gpuStatus2 = await window.electronAPI.isGpuAvailable();
console.log('GPU status after analysis:', gpuStatus2);
```

### 3. Manual UI testing

1. **Launch app** on system with GPU
2. **Scan photos** (any folder with images)
3. **Trigger face analysis** (grid/single view, any face detection)
4. **Check browser console** (F12 → Console tab)
   - Look for: `GPU acceleration unavailable...` (if CPU fallback)
   - Or: silence (if GPU loaded successfully)
5. **Measure timing**
   - Open DevTools (F12)
   - Open Performance tab
   - Click record
   - Trigger face analysis on a batch
   - Stop recording
   - Check flame graph — should be sub-second for GPU, 1–30s for CPU

### 4. Platform-specific tests

#### Windows (NVIDIA GPU)
```bash
# Verify CUDA is installed
where nvcc
$env:CUDA_PATH

# Run app — should auto-detect CUDA
npm start

# In DevTools console:
window.electronAPI.isGpuAvailable().then(console.log)
# Expected: true
```

#### Windows (AMD/Intel GPU)
```bash
# DirectML is built-in, no install needed
npm start

# In DevTools console:
window.electronAPI.isGpuAvailable().then(console.log)
# Expected: true
```

#### macOS (Apple Silicon)
```bash
# CoreML is built-in
npm start

# In DevTools console:
window.electronAPI.isGpuAvailable().then(console.log)
# Expected: true
```

#### macOS (Intel with external GPU)
```bash
# Verify CUDA is installed
which nvcc
echo $CUDA_PATH

npm start

# In DevTools console:
window.electronAPI.isGpuAvailable().then(console.log)
# Expected: true (if CUDA installed), false (if not)
```

#### Linux (NVIDIA GPU)
```bash
# Verify CUDA is installed
which nvcc
echo $CUDA_PATH

npm start

# In DevTools console:
window.electronAPI.isGpuAvailable().then(console.log)
# Expected: true
```

#### Any platform (CPU-only fallback)
```bash
# Run without any GPU drivers installed
npm start

# In DevTools console:
window.electronAPI.isGpuAvailable().then(console.log)
# Expected: false

# Check console for fallback message:
# "GPU acceleration unavailable, falling back to CPU"
```

## Performance benchmarks

### Expected timings

| Hardware | GPU status | First photo | Subsequent | Notes |
|----------|------------|-------------|------------|-------|
| NVIDIA RTX 4070 | GPU | 0.2–0.5s | 0.1–0.3s | Warm-up overhead ~0.1s |
| NVIDIA RTX 3080 | GPU | 0.3–0.8s | 0.2–0.5s | Warm-up overhead ~0.2s |
| AMD GPU (DirectML) | GPU | 0.2–0.6s | 0.1–0.4s | Platform-dependent |
| Apple M3 (CoreML) | GPU | 0.15–0.4s | 0.1–0.3s | Fastest M-series |
| Intel i7-11th gen | CPU | 20–30s | 20–30s | No warm-up |
| AMD Ryzen 7900X3D | CPU | 0.8–1.2s | 0.8–1.2s | Best single-core CPU |
| Intel i5-8th gen | CPU | 40–60s | 40–60s | Older CPU, slower |

### Batch performance

```
100 photos:
- GPU: 10–50s total (0.1–0.5s each)
- CPU: 2000–6000s total (20–60s each)
- Speedup: 40–100×

1000 photos:
- GPU: 100–500s total
- CPU: 20000–60000s total (5–16 hours!)
- Speedup: 40–100×
```

## Debugging GPU issues

### Issue: "GPU acceleration unavailable, falling back to CPU"

**Check 1: ONNX Runtime can find GPU driver**
```javascript
// In console, check what providers ONNX loaded
// Unfortunately onnxruntime-node doesn't expose this easily

// Workaround: check environment
console.log(process.platform); // should be 'win32', 'darwin', or 'linux'
```

**Check 2: GPU drivers are installed**
```bash
# Windows (NVIDIA)
nvidia-smi

# Windows (AMD/Intel via DirectML)
# Should work out of the box on Windows 10/11

# macOS (Apple Silicon)
system_profiler SPDisplaysDataType | grep GPU

# macOS (Intel)
nvidia-smi

# Linux (NVIDIA)
nvidia-smi
```

**Check 3: CUDA/cuDNN (if applicable)**
```bash
# Linux/macOS with NVIDIA
echo $CUDA_PATH
which nvcc
nvcc --version

# cuDNN (harder to check, look in /usr/local/cuda/include/cudnn.h)
ls /usr/local/cuda/include/cudnn.h
```

### Issue: Slow face detection on GPU

**Possible causes:**
1. GPU is overloaded (other apps using it)
2. ONNX Runtime is actually using CPU fallback (check console)
3. Model is loading from slow storage (first inference includes warm-up)
4. Wrong ONNX Runtime version (older versions slower)

**Solutions:**
1. Close other GPU-intensive apps
2. Check browser DevTools console for fallback message
3. Wait for first batch (subsequent batches should be faster)
4. Verify `onnxruntime-node` version: `npm list onnxruntime-node` should be 1.21.0+

## Code review checklist

- [ ] `getExecutionProviders()` returns correct provider list for platform
- [ ] `loadSessions()` tries GPU first, falls back to CPU on error
- [ ] `gpuAvailable` is set correctly (true/false after first analysis)
- [ ] `isGpuAvailable()` is exported and returns correct type
- [ ] IPC handler `FACE_GPU_AVAILABLE` is registered
- [ ] Preload API `isGpuAvailable` invokes correct IPC handler
- [ ] TypeScript compiles without errors
- [ ] No breaking changes to existing APIs
