import { describe, expect, it } from 'vitest';
import { clusterFaces, resolveFaceAnalysisBatchSize } from '../useFaceAnalysis';

function embeddingHex(values: number[]): string {
  const array = new Float32Array(values);
  return Buffer.from(array.buffer).toString('hex');
}

function deserializeEmbedding(hex: string): Float32Array {
  const buffer = Buffer.from(hex, 'hex');
  const bytes = new Uint8Array(buffer.byteLength);
  bytes.set(buffer);
  return new Float32Array(bytes.buffer);
}

describe('clusterFaces', () => {
  it('matches a solo face to a group photo when any face embedding overlaps', () => {
    const groups = clusterFaces(new Map([
      ['/group.jpg', {
        path: '/group.jpg',
        faceCount: 2,
        boxes: [],
        embeddings: [
          embeddingHex([0, 1, 0, 0]),
          embeddingHex([1, 0, 0, 0]),
        ],
      }],
      ['/solo.jpg', {
        path: '/solo.jpg',
        faceCount: 1,
        boxes: [],
        embeddings: [embeddingHex([0.99, 0.01, 0, 0])],
      }],
    ]), deserializeEmbedding);

    expect(groups.get('/solo.jpg')).toBe('/group.jpg');
  });

  it('skips malformed embeddings instead of creating invalid clusters', () => {
    const groups = clusterFaces(new Map([
      ['/bad.jpg', {
        path: '/bad.jpg',
        faceCount: 1,
        boxes: [],
        embeddings: ['not-hex'],
      }],
    ]), deserializeEmbedding);

    expect(groups.size).toBe(0);
  });
});

describe('resolveFaceAnalysisBatchSize', () => {
  it('keeps low-end CPUs and memory-starved devices on a single in-flight batch', () => {
    expect(resolveFaceAnalysisBatchSize({ hardwareConcurrency: 2, deviceMemory: 16 })).toBe(1);
    expect(resolveFaceAnalysisBatchSize({ hardwareConcurrency: 12, deviceMemory: 4 })).toBe(1);
  });

  it('does not force high-core desktops into low-end mode when device memory is unavailable', () => {
    expect(resolveFaceAnalysisBatchSize({ hardwareConcurrency: 8 })).toBe(2);
    expect(resolveFaceAnalysisBatchSize({ hardwareConcurrency: 16 })).toBe(4);
  });

  it('uses memory pressure to hold balanced machines back when memory is known', () => {
    expect(resolveFaceAnalysisBatchSize({ hardwareConcurrency: 16, deviceMemory: 8 })).toBe(2);
    expect(resolveFaceAnalysisBatchSize({ hardwareConcurrency: 16, deviceMemory: 16 })).toBe(4);
  });
});
