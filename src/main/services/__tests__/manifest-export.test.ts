import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { MediaFile } from '../../../shared/types';
import { writeManifestFile } from '../manifest-export';

const dirs: string[] = [];
const file = (name: string): MediaFile => ({
  name,
  path: `C:\\card\\${name}`,
  size: 12,
  type: 'photo',
  extension: '.jpg',
  thumbnail: 'data:image/jpeg;base64,large',
});

afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

describe('manifest export', () => {
  it('streams JSON without thumbnail payloads', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'keptra-manifest-'));
    dirs.push(dir);
    const output = path.join(dir, 'manifest.json');
    await writeManifestFile(output, [file('a.jpg'), file('b.jpg')], 'json');
    const records = JSON.parse(await readFile(output, 'utf8')) as MediaFile[];
    expect(records).toHaveLength(2);
    expect(records[0].thumbnail).toBeUndefined();
  });

  it('neutralizes spreadsheet formulas in CSV values', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'keptra-manifest-'));
    dirs.push(dir);
    const output = path.join(dir, 'manifest.csv');
    await writeManifestFile(output, [file('=cmd.jpg')], 'csv');
    expect(await readFile(output, 'utf8')).toContain("'=cmd.jpg");
  });
});
