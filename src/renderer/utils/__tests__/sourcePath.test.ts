import { describe, expect, it } from 'vitest';
import { getSourceFolderLabel, getSourceRelativePath, isPathInsideSourceRoot } from '../sourcePath';

describe('sourcePath', () => {
  it('detects files inside a source root across Windows separators', () => {
    expect(isPathInsideSourceRoot('D:\\Clients\\Event\\Dump', 'D:\\Clients\\Event\\Dump\\DCIM\\100D850\\A001.JPG')).toBe(true);
    expect(isPathInsideSourceRoot('D:\\Clients\\Event\\Dump', 'D:\\Clients\\Event\\Other\\A001.JPG')).toBe(false);
  });

  it('formats a source-relative path for nested folders', () => {
    expect(getSourceRelativePath('D:\\Clients\\Event\\Dump', 'D:\\Clients\\Event\\Dump\\DCIM\\100D850\\A001.JPG'))
      .toBe('DCIM/100D850/A001.JPG');
  });

  it('returns a folder label relative to the source root', () => {
    expect(getSourceFolderLabel('D:\\Clients\\Event\\Dump', 'D:\\Clients\\Event\\Dump\\DCIM\\100D850\\A001.JPG'))
      .toBe('DCIM/100D850');
    expect(getSourceFolderLabel('D:\\Clients\\Event\\Dump', 'D:\\Clients\\Event\\Dump\\A001.JPG'))
      .toBe('(root)');
  });
});
