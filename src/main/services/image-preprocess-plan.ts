export interface ImagePreprocessPlanInput {
  /** Defaults to true for backwards compatibility with detector-only callers. */
  includeDetectorTensor?: boolean;
  includeAnalysisSurface: boolean;
  includePersonTensors: boolean;
  includeNanoDetTensor?: boolean;
  includeYuNetTensor?: boolean;
}

export function imagePreprocessPlan(input: ImagePreprocessPlanInput) {
  return {
    detector: input.includeDetectorTensor !== false,
    surface: input.includeAnalysisSurface,
    fastPerson: input.includePersonTensors,
    nanoDet: input.includeNanoDetTensor === true,
    yuNet: input.includeYuNetTensor === true,
  };
}

export type SharpOrientationOperation = 'rotate90' | 'rotate180' | 'rotate270' | 'flip' | 'flop';

/** Choose the transform for the encoded bytes actually being decoded. */
export function sourcePixelOrientation(
  originalOrientation: number,
  encodedOrientation: number | undefined,
  useEncodedOrientation: boolean,
): number {
  return useEncodedOrientation && encodedOrientation !== undefined &&
    encodedOrientation >= 1 && encodedOrientation <= 8
    ? encodedOrientation
    : originalOrientation;
}

/** Operation order verified against the EXIF 1-8 stored-pixel mapping. */
export function sharpOrientationOperations(orientation: number): SharpOrientationOperation[] {
  switch (orientation) {
    case 2: return ['flop'];
    case 3: return ['rotate180'];
    case 4: return ['flip'];
    case 5: return ['rotate90', 'flip'];
    case 6: return ['rotate90'];
    case 7: return ['rotate90', 'flop'];
    case 8: return ['rotate270'];
    default: return [];
  }
}
