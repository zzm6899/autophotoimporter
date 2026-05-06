import { describe, expect, it } from 'vitest';
import { clusterFaces } from '../useFaceAnalysis';

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
