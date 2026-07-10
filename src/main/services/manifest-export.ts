import { open } from 'node:fs/promises';
import type { MediaFile } from '../../shared/types';

const CSV_HEADERS = [
  'name', 'path', 'size', 'type', 'extension', 'dateTaken',
  'destPath', 'pick', 'rating', 'isProtected', 'duplicate',
  'cameraMake', 'cameraModel', 'lensModel', 'iso', 'aperture',
  'shutterSpeed', 'focalLength', 'exposureValue', 'normalizeToAnchor',
  'exposureAdjustmentStops',
];

function manifestFile(file: MediaFile): Omit<MediaFile, 'thumbnail'> {
  const {
    thumbnail: _thumbnail,
    faceEmbedding: _faceEmbedding,
    faceEmbeddings: _faceEmbeddings,
    faceEmbeddingBoxes: _faceEmbeddingBoxes,
    faceBoxes: _faceBoxes,
    personBoxes: _personBoxes,
    reviewReasons: _reviewReasons,
    subjectReasons: _subjectReasons,
    duplicateMemory: _duplicateMemory,
    ...record
  } = file;
  return record;
}

function csvValue(value: unknown): string {
  if (value == null) return '';
  let text = String(value);
  // Prevent spreadsheet applications from interpreting camera filenames or
  // metadata as formulas when a CSV is opened.
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export async function writeManifestFile(
  outputPath: string,
  files: MediaFile[],
  format: 'csv' | 'json',
): Promise<void> {
  const handle = await open(outputPath, 'w');
  try {
    if (format === 'json') {
      await handle.write('[\n');
      for (let index = 0; index < files.length; index++) {
        const suffix = index + 1 < files.length ? ',\n' : '\n';
        await handle.write(`${JSON.stringify(manifestFile(files[index]))}${suffix}`);
      }
      await handle.write(']\n');
      return;
    }

    await handle.write(`${CSV_HEADERS.join(',')}\n`);
    const chunk: string[] = [];
    for (const file of files) {
      const record = file as unknown as Record<string, unknown>;
      chunk.push(CSV_HEADERS.map((header) => csvValue(record[header])).join(','));
      if (chunk.length >= 500) {
        await handle.write(`${chunk.join('\n')}\n`);
        chunk.length = 0;
      }
    }
    if (chunk.length > 0) await handle.write(`${chunk.join('\n')}\n`);
  } finally {
    await handle.close();
  }
}
