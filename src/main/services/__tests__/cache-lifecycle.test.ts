import { mkdtemp, mkdir, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { rm } from 'node:fs/promises';
import { maintainPreviewCache } from '../cache-lifecycle';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('preview cache lifecycle', () => {
  it('removes oldest files until the byte budget is met', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'keptra-cache-'));
    tempDirs.push(dir);
    await mkdir(dir, { recursive: true });
    const oldFile = path.join(dir, 'old.jpg');
    const newFile = path.join(dir, 'new.jpg');
    await writeFile(oldFile, Buffer.alloc(10));
    await writeFile(newFile, Buffer.alloc(10));
    await utimes(oldFile, new Date(1_000), new Date(1_000));
    await utimes(newFile, new Date(2_000), new Date(2_000));

    const report = await maintainPreviewCache(dir, { maxBytes: 10, maxAgeMs: Number.MAX_SAFE_INTEGER, minFreeBytes: 0, now: 3_000 });

    expect(report.bytes).toBe(10);
    expect(report.removedFiles).toBe(1);
    await expect(stat(oldFile)).rejects.toThrow();
    await expect(stat(newFile)).resolves.toBeDefined();
  });
});
