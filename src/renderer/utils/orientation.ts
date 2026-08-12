/** CSS transform matching the stored-pixel EXIF orientation used by previews. */
export function orientationTransform(orientation?: number): string | undefined {
  switch (orientation) {
    case 2: return 'scaleX(-1)';
    case 3: return 'rotate(180deg)';
    case 4: return 'scaleY(-1)';
    case 5: return 'rotate(90deg) scaleX(-1)';
    case 6: return 'rotate(90deg)';
    case 7: return 'rotate(270deg) scaleX(-1)';
    case 8: return 'rotate(270deg)';
    default: return undefined;
  }
}

export function orientationQuarterTurns(orientation?: number): number {
  switch (orientation) {
    case 3:
    case 4:
      return 2;
    case 5:
    case 6:
      return 1;
    case 7:
    case 8:
      return 3;
    default:
      return 0;
  }
}

export function orientationSwapsAxes(orientation?: number): boolean {
  return orientation === 5 || orientation === 6 || orientation === 7 || orientation === 8;
}
