import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const fixtureDir = path.join(root, 'fixtures', 'smoke');

const fixtures = [
  {
    name: 'tiny.png',
    description: '1x1 transparent PNG',
    base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
  },
  {
    name: 'tiny.jpg',
    description: '1x1 white JPEG',
    base64: '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAH/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAEFAqf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/Aaf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/Aaf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAY/Aqf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/IV//2gAMAwEAAgADAAAAEP/EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQMBAT8QH//EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQIBAT8QH//EABQQAQAAAAAAAAAAAAAAAAAAABD/2gAIAQEAAT8QH//Z',
  },
  {
    name: 'tiny.webp',
    description: '1x1 lossless WebP',
    base64: 'UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AA/vuUAAA=',
  },
  {
    name: 'corrupt.jpg',
    description: 'Intentionally invalid JPEG for error-path tests',
    text: 'not a jpeg fixture\n',
  },
];

mkdirSync(fixtureDir, { recursive: true });

for (const fixture of fixtures) {
  const target = path.join(fixtureDir, fixture.name);
  if ('base64' in fixture) {
    writeFileSync(target, Buffer.from(fixture.base64, 'base64'));
  } else {
    writeFileSync(target, fixture.text, 'utf8');
  }
  console.log(`[fixtures] wrote ${fixture.name} - ${fixture.description}`);
}

