import { describe, expect, it } from 'vitest';
import {
  autoCullGroup,
  buildAutoCullProposal,
  faceMatchingCoverageQuality,
} from '../review';
import type { MediaFile } from '../types';

function file(path: string, overrides: Partial<MediaFile> = {}): MediaFile {
  return {
    path,
    name: path.split('/').pop() ?? path,
    size: 1,
    type: 'photo',
    extension: '.jpg',
    reviewAnalysisStage: 'full',
    reviewScore: 78,
    sharpnessScore: 125,
    blurRisk: 'low',
    faceCount: 1,
    faceDetection: 'native',
    faceBoxes: [{
      x: 0.42, y: 0.1, width: 0.13, height: 0.15,
      score: 0.96, eyeScore: 2, eyeSharpness: 0.88, expressionScore: 0.72,
    }],
    personCount: 1,
    personBoxes: [{ x: 0.29, y: 0.05, width: 0.4, height: 0.9, score: 0.95 }],
    sceneAnalysis: {
      kind: 'people', confidence: 0.9,
      subjectSharpnessScore: 128, subjectFocusConfidence: 0.9,
    },
    ...overrides,
  };
}

const embeddingA = '3f800000000000000000000000000000';
const embeddingB = '000000003f8000000000000000000000';
const embeddingC = '00000000000000003f80000000000000';

describe('face-matching-assisted comparison coverage', () => {
  it('keeps the best usable frame for every recurring primary identity in a burst', () => {
    const aBest = file('/a-best.jpg', {
      burstId: 'mixed-cosplayers', burstSize: 3,
      faceGroupId: 'person-a', faceGroupSize: 4,
      faceEmbedding: embeddingA, faceEmbeddings: [embeddingA],
      reviewScore: 92,
      sceneAnalysis: {
        kind: 'people', confidence: 0.94,
        subjectSharpnessScore: 155, subjectFocusConfidence: 0.95,
      },
    });
    const aSoft = file('/a-soft.jpg', {
      burstId: 'mixed-cosplayers', burstSize: 3,
      faceGroupId: 'person-a', faceGroupSize: 4,
      faceEmbedding: embeddingA, faceEmbeddings: [embeddingA],
      reviewScore: 42, sharpnessScore: 58, blurRisk: 'high',
      sceneAnalysis: {
        kind: 'people', confidence: 0.88,
        subjectSharpnessScore: 42, subjectFocusConfidence: 0.86,
      },
    });
    const bBest = file('/b-best.jpg', {
      burstId: 'mixed-cosplayers', burstSize: 3,
      faceGroupId: 'person-b', faceGroupSize: 3,
      faceEmbedding: embeddingB, faceEmbeddings: [embeddingB],
      reviewScore: 70,
      sceneAnalysis: {
        kind: 'people', confidence: 0.91,
        subjectSharpnessScore: 105, subjectFocusConfidence: 0.9,
      },
    });

    const proposal = buildAutoCullProposal([aBest, aSoft, bBest], {
      eventMode: 'cosplay', confidence: 'aggressive',
    });
    expect(proposal.keep).toContain(aBest.path);
    expect(proposal.keep).toContain(bBest.path);
    expect(proposal.reasons[aBest.path]).toContain('best frame for recurring face group');
    expect(proposal.reasons[bBest.path]).toContain('best frame for recurring face group');
    expect(proposal.keep).not.toContain(aSoft.path);

    const direct = autoCullGroup([aBest, aSoft, bBest], {
      eventMode: 'cosplay', confidence: 'aggressive',
    });
    expect(direct.keep).toEqual(expect.arrayContaining([aBest.path, bBest.path]));
  });

  it('retains the strongest completed multi-face match as group-completeness coverage', () => {
    const solo = file('/solo.jpg', {
      burstId: 'group-transition', burstSize: 2,
      rating: 5,
      faceGroupId: 'lead', faceGroupSize: 5,
      faceEmbedding: embeddingA, faceEmbeddings: [embeddingA],
      reviewScore: 94,
      sceneAnalysis: {
        kind: 'people', confidence: 0.94,
        subjectSharpnessScore: 150, subjectFocusConfidence: 0.94,
      },
    });
    const completeGroup = file('/complete-group.jpg', {
      burstId: 'group-transition', burstSize: 2,
      faceGroupId: 'lead', faceGroupSize: 5,
      faceCount: 3,
      faceEmbeddings: [embeddingA, embeddingB, embeddingC],
      faceEmbedding: embeddingA,
      faceBoxes: [
        { x: 0.18, y: 0.1, width: 0.11, height: 0.14, score: 0.95, eyeScore: 2 },
        { x: 0.44, y: 0.09, width: 0.11, height: 0.14, score: 0.96, eyeScore: 2 },
        { x: 0.69, y: 0.1, width: 0.11, height: 0.14, score: 0.94, eyeScore: 2 },
      ],
      personCount: 3,
      personBoxes: [
        { x: 0.1, y: 0.05, width: 0.25, height: 0.9, score: 0.94 },
        { x: 0.37, y: 0.04, width: 0.25, height: 0.91, score: 0.96 },
        { x: 0.64, y: 0.05, width: 0.25, height: 0.9, score: 0.93 },
      ],
      reviewScore: 70,
      sceneAnalysis: {
        kind: 'people', confidence: 0.92,
        subjectSharpnessScore: 105, subjectFocusConfidence: 0.9,
      },
    });

    expect(faceMatchingCoverageQuality(completeGroup)).toBeGreaterThan(faceMatchingCoverageQuality(solo));
    const proposal = buildAutoCullProposal([solo, completeGroup], {
      eventMode: 'cosplay', confidence: 'aggressive',
    });
    expect(proposal.keep).toEqual(expect.arrayContaining([solo.path, completeGroup.path]));
    expect(proposal.reasons[completeGroup.path]).toContain('matched-face group coverage');
  });

  it('treats unknown identity as neutral and never compares unrelated standalone scenes', () => {
    const unknown = file('/unknown-identity.jpg', {
      faceEmbedding: undefined, faceEmbeddings: undefined,
      faceGroupId: undefined, faceGroupSize: undefined,
    });
    expect(faceMatchingCoverageQuality(unknown)).toBe(0);

    const knownPeer = file('/known-comparison.jpg', {
      burstId: 'identity-neutral', burstSize: 2,
      faceGroupId: 'known-person', faceGroupSize: 4,
      faceEmbedding: embeddingA, faceEmbeddings: [embeddingA],
    });
    const unknownPeer = file('/unknown-comparison.jpg', {
      burstId: 'identity-neutral', burstSize: 2,
      faceEmbedding: undefined, faceEmbeddings: undefined,
      faceGroupId: undefined, faceGroupSize: undefined,
    });
    const comparison = buildAutoCullProposal([knownPeer, unknownPeer], {
      eventMode: 'cosplay', confidence: 'aggressive',
    });
    expect(comparison.reject).not.toContain(unknownPeer.path);
    expect(comparison.reasons[unknownPeer.path]).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/identity|face group/i)]),
    );

    const knownStandalone = file('/known-standalone.jpg', {
      faceGroupId: 'known-person', faceGroupSize: 7,
      faceEmbedding: embeddingA, faceEmbeddings: [embeddingA],
      visualHash: '0000000000000000',
    });
    const unknownStandalone = {
      ...unknown,
      visualHash: 'ffffffffffffffff',
    };
    const proposal = buildAutoCullProposal([knownStandalone, unknownStandalone], {
      eventMode: 'cosplay', confidence: 'aggressive',
    });
    expect(proposal.keep).toHaveLength(0);
    expect(proposal.reject).toHaveLength(0);
    expect(proposal.uncertain).toEqual(expect.arrayContaining([
      knownStandalone.path, unknownStandalone.path,
    ]));
    expect(proposal.reasons[unknownStandalone.path]).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/identity|face group/i)]),
    );
  });
});
