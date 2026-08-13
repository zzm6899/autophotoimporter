import { afterEach, describe, expect, it } from 'vitest';
import {
  autoCullGroup,
  buildAutoCullProposal,
  configureCullingGenre,
  configureReviewProfile,
  getCullingGenre,
  getReviewProfile,
  hasCullingAnalysis,
  inferSceneBucket,
  rankBestShots,
  scoreGenre,
} from '../review';
import type { MediaFile, SceneAnalysis } from '../types';

function file(path: string, overrides: Partial<MediaFile> = {}): MediaFile {
  return {
    path,
    name: path.split('/').pop() ?? path,
    size: 1,
    type: 'photo',
    extension: '.jpg',
    sharpnessScore: 100,
    subjectSharpnessScore: 100,
    reviewScore: 70,
    blurRisk: 'low',
    ...overrides,
  };
}

function scene(kind: SceneAnalysis['kind'], overrides: Partial<SceneAnalysis> = {}): SceneAnalysis {
  return {
    kind,
    confidence: 0.95,
    focusCoverage: 0.8,
    focusUniformity: 0.8,
    edgeSharpness: 150,
    centerSharpness: 150,
    cornerSharpness: 140,
    highlightClipping: 0.03,
    shadowClipping: 0.05,
    dynamicRange: 0.8,
    compositionBalance: 0.8,
    lineStrength: 0.8,
    horizonTiltDeg: 0.5,
    verticalTiltDeg: 0.5,
    ...overrides,
  };
}

afterEach(() => {
  configureReviewProfile('general');
  configureCullingGenre('auto');
});

describe('genre-aware scoring', () => {
  it('preserves deterministic portrait and group specialisation', () => {
    const portrait = file('/portrait.jpg', {
      faceCount: 1,
      faceDetection: 'native',
      faceBoxes: [{ x: 0.35, y: 0.15, width: 0.24, height: 0.3, score: 0.98, eyeSharpness: 0.92, smileScore: 0.8 }],
    });
    const group = file('/group.jpg', {
      faceCount: 4,
      personCount: 4,
      faceDetection: 'native',
      faceBoxes: Array.from({ length: 4 }, (_, index) => ({
        x: 0.1 + index * 0.2, y: 0.18, width: 0.12, height: 0.16,
        score: 0.95, eyeSharpness: 0.85, smileScore: 0.7,
      })),
    });

    expect(scoreGenre(portrait).genre).toBe('portrait');
    expect(scoreGenre(group).genre).toBe('group');
    expect(scoreGenre(portrait)).toEqual(scoreGenre(portrait));
  });

  it('prefers broad focus and a level horizon for landscape repeats', () => {
    configureReviewProfile('landscape');
    const clean = file('/clean.jpg', { sceneAnalysis: scene('landscape') });
    const tiltedClipped = file('/tilted.jpg', {
      sceneAnalysis: scene('landscape', {
        focusCoverage: 0.35,
        focusUniformity: 0.3,
        cornerSharpness: 30,
        highlightClipping: 0.32,
        horizonTiltDeg: 8,
      }),
    });

    expect(scoreGenre(clean, 'landscape').score).toBeGreaterThan(scoreGenre(tiltedClipped, 'landscape').score);
    expect(rankBestShots([tiltedClipped, clean])[0].path).toBe(clean.path);
  });

  it('uses structural lines and controlled verticals for architecture', () => {
    configureReviewProfile('architecture');
    const straight = file('/straight.jpg', { sceneAnalysis: scene('architecture', { lineStrength: 0.94, verticalTiltDeg: 0.2 }) });
    const leaning = file('/leaning.jpg', { sceneAnalysis: scene('architecture', { lineStrength: 0.32, edgeSharpness: 55, verticalTiltDeg: 11 }) });

    expect(rankBestShots([leaning, straight])[0].path).toBe(straight.path);
    expect(scoreGenre(straight, 'architecture').reasons).toContain('crisp structural lines');
  });

  it('balances window clipping, shadow detail and corner sharpness for interiors', () => {
    configureReviewProfile('interior');
    const balanced = file('/balanced.jpg', { sceneAnalysis: scene('interior') });
    const blownWindow = file('/window.jpg', {
      sceneAnalysis: scene('interior', {
        highlightClipping: 0.48,
        shadowClipping: 0.42,
        cornerSharpness: 25,
        focusCoverage: 0.35,
      }),
    });

    const good = scoreGenre(balanced, 'interior');
    const poor = scoreGenre(blownWindow, 'interior');
    expect(good.score).toBeGreaterThan(poor.score);
    expect(poor.cautions).toContain('window/highlight clipping risk');
  });

  it('treats missing scene metrics as uncertain rather than known-bad', () => {
    const unknown = file('/unknown.jpg', { sceneAnalysis: undefined });
    const measuredWeak = file('/weak.jpg', {
      sceneAnalysis: scene('landscape', {
        focusCoverage: 0,
        focusUniformity: 0,
        edgeSharpness: 0,
        centerSharpness: 0,
        cornerSharpness: 0,
        highlightClipping: 1,
        shadowClipping: 1,
        dynamicRange: 0,
        compositionBalance: 0,
        horizonTiltDeg: 20,
      }),
    });

    expect(scoreGenre(unknown, 'landscape').confidence).toBeLessThan(0.5);
    expect(scoreGenre(unknown, 'landscape').score).toBeGreaterThan(scoreGenre(measuredWeak, 'landscape').score);
  });

  it('assigns explicit non-people shoot modes to useful scene buckets', () => {
    const emptyScene = file('/scene.jpg');
    expect(inferSceneBucket(emptyScene, 'landscape')).toBe('Landscape');
    expect(inferSceneBucket(emptyScene, 'architecture')).toBe('Architecture / exterior');
    expect(inferSceneBucket(emptyScene, 'interior')).toBe('Interior / rooms');
  });

  it('applies and restores an explicit genre profile for direct auto-cull calls', () => {
    configureReviewProfile('candids');
    configureCullingGenre('portrait');
    const good = file('/good.jpg', { sceneAnalysis: scene('architecture') });
    const leaning = file('/leaning.jpg', {
      sceneAnalysis: scene('architecture', { edgeSharpness: 20, lineStrength: 0.1, verticalTiltDeg: 15 }),
    });

    const decision = autoCullGroup([leaning, good], {
      eventMode: 'architecture',
      genre: 'architecture',
      confidence: 'conservative',
    });

    expect(decision.best?.path).toBe('/good.jpg');
    expect(getReviewProfile()).toBe('candids');
    expect(getCullingGenre()).toBe('portrait');
  });
});

describe('buildAutoCullProposal', () => {
  it('is deterministic, non-mutating and preserves profile state', () => {
    configureReviewProfile('candids');
    configureCullingGenre('portrait');
    const files = [
      file('/best.jpg', { burstId: 'b1', burstSize: 2, burstIndex: 1, visualHash: '0000000000000000' }),
      file('/soft.jpg', { burstId: 'b1', burstSize: 2, burstIndex: 2, visualHash: '0000000000000001', sharpnessScore: 8, subjectSharpnessScore: 8, reviewScore: 5, blurRisk: 'high' }),
    ];
    const before = structuredClone(files);

    const first = buildAutoCullProposal(files, { eventMode: 'landscape', genre: 'landscape' });
    const second = buildAutoCullProposal(files, { eventMode: 'landscape', genre: 'landscape' });

    expect(first).toEqual(second);
    expect(first.automaticDeletion).toBe(false);
    expect(files).toEqual(before);
    expect(getReviewProfile()).toBe('candids');
    expect(getCullingGenre()).toBe('portrait');
  });

  it('only proposes rejection for supported comparisons and keeps unrelated scenes uncertain', () => {
    const files = [
      file('/best-room.jpg', {
        burstId: 'room-burst', burstSize: 2, burstIndex: 1,
        sceneAnalysis: scene('interior'),
      }),
      file('/bad-room.jpg', {
        burstId: 'room-burst', burstSize: 2, burstIndex: 2,
        sharpnessScore: 4, subjectSharpnessScore: 4, reviewScore: 2, blurRisk: 'high',
        sceneAnalysis: scene('interior', {
          focusCoverage: 0.1, focusUniformity: 0.1, cornerSharpness: 2,
          highlightClipping: 0.8, shadowClipping: 0.8, verticalTiltDeg: 18,
        }),
      }),
      file('/different-room.jpg', { sceneAnalysis: scene('interior') }),
      file('/not-analysed.jpg', { sharpnessScore: undefined, subjectSharpnessScore: undefined, reviewScore: undefined, blurRisk: undefined }),
    ];

    const proposal = buildAutoCullProposal(files, {
      eventMode: 'interior',
      genre: 'interior',
      confidence: 'balanced',
    });

    expect(proposal.keep).toContain('/best-room.jpg');
    expect(proposal.reject).toContain('/bad-room.jpg');
    expect(proposal.uncertain).toContain('/different-room.jpg');
    expect(proposal.unanalysed).toContain('/not-analysed.jpg');
    expect(proposal.reasons['/different-room.jpg']).toContain('no comparable burst or near-duplicate');
  });

  it('never proposes an automatic reject when comparison confidence is low', () => {
    const proposal = buildAutoCullProposal([
      file('/a.jpg', { burstId: 'b', burstSize: 2, sceneAnalysis: scene('landscape', { confidence: 0.1 }) }),
      file('/b.jpg', { burstId: 'b', burstSize: 2, sceneAnalysis: scene('landscape', { confidence: 0.1 }), sharpnessScore: 80 }),
    ], { genre: 'landscape', confidence: 'conservative' });

    expect(proposal.reject).toEqual([]);
    expect(proposal.uncertain.length + proposal.keep.length).toBe(2);
  });

  it('leaves detected-subject files unanalysed until the ROI pass completes', () => {
    const files = [
      file('/pending-a.jpg', {
        burstId: 'people', burstSize: 2,
        faceCount: 1,
        faceDetection: 'native',
        faceBoxes: [{ x: 0.2, y: 0.15, width: 0.24, height: 0.3, score: 0.98 }],
        sceneAnalysis: scene('people'),
      }),
      file('/pending-b.jpg', {
        burstId: 'people', burstSize: 2,
        faceCount: 1,
        faceDetection: 'native',
        faceBoxes: [{ x: 0.22, y: 0.15, width: 0.24, height: 0.3, score: 0.97 }],
        sceneAnalysis: scene('people'),
      }),
    ];

    expect(files.every((candidate) => !hasCullingAnalysis(candidate))).toBe(true);
    const proposal = buildAutoCullProposal(files, { genre: 'portrait' });
    expect(proposal.keep).toEqual([]);
    expect(proposal.reject).toEqual([]);
    expect(proposal.unanalysed.sort()).toEqual(['/pending-a.jpg', '/pending-b.jpg']);
  });

  it('does not compare burst frames after only the Super Speed screening pass', () => {
    const files = [
      file('/screened-a.jpg', {
        burstId: 'screened', burstSize: 2, reviewAnalysisStage: 'screened',
        faceBoxes: [], faceCount: 0, sceneAnalysis: scene('general'),
      }),
      file('/screened-b.jpg', {
        burstId: 'screened', burstSize: 2, reviewAnalysisStage: 'screened',
        faceBoxes: [], faceCount: 0, sceneAnalysis: scene('general'),
      }),
    ];

    expect(files.every((candidate) => !hasCullingAnalysis(candidate))).toBe(true);
    const proposal = buildAutoCullProposal(files, { genre: 'general' });
    expect(proposal.reject).toEqual([]);
    expect(proposal.unanalysed.sort()).toEqual(['/screened-a.jpg', '/screened-b.jpg']);
  });

  it('keeps exhausted native-analysis failures manual even when canvas scores exist', () => {
    const failed = file('/unavailable.jpg', {
      reviewAnalysisUnavailable: true,
      sharpnessScore: 180,
      subjectSharpnessScore: 180,
      reviewScore: 95,
      sceneAnalysis: scene('general'),
    });

    expect(hasCullingAnalysis(failed)).toBe(false);
    const proposal = buildAutoCullProposal([failed], { genre: 'general' });
    expect(proposal.keep).toEqual([]);
    expect(proposal.reject).toEqual([]);
    expect(proposal.unanalysed).toEqual(['/unavailable.jpg']);
  });

  it('does not reject an analysed frame while another group member is still screened', () => {
    const files = [
      file('/pending-best.jpg', {
        burstId: 'mixed-depth', burstSize: 2, reviewAnalysisStage: 'screened',
        sharpnessScore: 220, subjectSharpnessScore: undefined,
        faceBoxes: [], faceCount: 0, sceneAnalysis: scene('general'),
      }),
      file('/analysed-runner.jpg', {
        burstId: 'mixed-depth', burstSize: 2, reviewAnalysisStage: 'subjects',
        sharpnessScore: 80, subjectSharpnessScore: 80,
        faceBoxes: [], faceCount: 0, personBoxes: [], personCount: 0,
        sceneAnalysis: scene('general', { edgeSharpness: 80, centerSharpness: 80 }),
      }),
    ];

    const proposal = buildAutoCullProposal(files, { eventMode: 'general', genre: 'general' });
    expect(proposal.reject).toEqual([]);
    expect(proposal.unanalysed).toEqual(['/pending-best.jpg']);
    expect(proposal.uncertain).toContain('/analysed-runner.jpg');
    expect(proposal.reasons['/analysed-runner.jpg']).toContain('comparison group is still being analysed');
  });

  it('keeps face-screened landscape repeats manual until body detection completes', () => {
    const files = [
      file('/landscape-a.jpg', {
        burstId: 'landscape', burstSize: 2, reviewAnalysisStage: 'screened',
        faceBoxes: [], faceCount: 0, sharpnessScore: 180,
        sceneAnalysis: scene('landscape'),
      }),
      file('/landscape-b.jpg', {
        burstId: 'landscape', burstSize: 2, reviewAnalysisStage: 'screened',
        faceBoxes: [], faceCount: 0, sharpnessScore: 120,
        sceneAnalysis: scene('landscape', { edgeSharpness: 90, cornerSharpness: 70 }),
      }),
    ];

    const proposal = buildAutoCullProposal(files, { eventMode: 'landscape', genre: 'landscape' });
    expect(proposal.keep).toEqual([]);
    expect(proposal.reject).toEqual([]);
    expect(proposal.unanalysed.sort()).toEqual(['/landscape-a.jpg', '/landscape-b.jpg']);
  });

  it('keeps dynamically grouped screened scenes manual before group metadata lands', () => {
    const files = [
      file('/hash-screened-a.jpg', {
        reviewAnalysisStage: 'screened', faceBoxes: [], faceCount: 0,
        visualHash: '0000000000000000', sharpnessScore: 200,
        sceneAnalysis: scene('landscape'),
      }),
      file('/hash-screened-b.jpg', {
        reviewAnalysisStage: 'screened', faceBoxes: [], faceCount: 0,
        visualHash: '0000000000000001', sharpnessScore: 80,
        sceneAnalysis: scene('landscape', { edgeSharpness: 40, cornerSharpness: 30 }),
      }),
    ];

    const proposal = buildAutoCullProposal(files, { eventMode: 'landscape', genre: 'landscape' });
    expect(proposal.keep).toEqual([]);
    expect(proposal.reject).toEqual([]);
    expect(proposal.unanalysed.sort()).toEqual(['/hash-screened-a.jpg', '/hash-screened-b.jpg']);
  });

  it('keeps completed but low-confidence subject ROI results uncertain', () => {
    const files = [
      file('/tiny-a.jpg', {
        burstId: 'tiny-people', burstSize: 2,
        faceCount: 1,
        faceDetection: 'native',
        faceBoxes: [{ x: 0.48, y: 0.45, width: 0.05, height: 0.08, score: 0.99 }],
        sceneAnalysis: scene('people', {
          subjectSharpnessScore: 12,
          backgroundSharpnessScore: 900,
          subjectFocusConfidence: 0.1,
        }),
      }),
      file('/tiny-b.jpg', {
        burstId: 'tiny-people', burstSize: 2,
        faceCount: 1,
        faceDetection: 'native',
        faceBoxes: [{ x: 0.5, y: 0.45, width: 0.05, height: 0.08, score: 0.98 }],
        sceneAnalysis: scene('people', {
          subjectSharpnessScore: 8,
          backgroundSharpnessScore: 850,
          subjectFocusConfidence: 0.08,
        }),
      }),
    ];

    expect(files.every(hasCullingAnalysis)).toBe(true);
    const proposal = buildAutoCullProposal(files, { genre: 'portrait', confidence: 'aggressive' });
    expect(proposal.keep).toEqual([]);
    expect(proposal.reject).toEqual([]);
    expect(proposal.uncertain.sort()).toEqual(['/tiny-a.jpg', '/tiny-b.jpg']);
    expect(proposal.reasons['/tiny-a.jpg']).toContain('subject focus confidence too low for an automatic decision');
  });

  it('preserves a distinct exposure bracket for review', () => {
    const proposal = buildAutoCullProposal([
      file('/normal.jpg', { burstId: 'hdr', burstSize: 2, exposureValue: 10, sceneAnalysis: scene('interior') }),
      file('/shadow-bracket.jpg', {
        burstId: 'hdr', burstSize: 2, exposureValue: 8.5,
        sharpnessScore: 15, subjectSharpnessScore: 15, reviewScore: 10, blurRisk: 'high',
        sceneAnalysis: scene('interior', { highlightClipping: 0.4 }),
      }),
    ], { eventMode: 'interior', genre: 'interior', confidence: 'balanced' });

    expect(proposal.reject).not.toContain('/shadow-bracket.jpg');
    expect(proposal.uncertain).toContain('/shadow-bracket.jpg');
    expect(proposal.reasons['/shadow-bracket.jpg'][0]).toContain('distinct exposure variant');
  });
});
