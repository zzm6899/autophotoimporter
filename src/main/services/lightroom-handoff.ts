import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  ImportConfig,
  ImportLedger,
  ImportLedgerItem,
  LightroomCollectionArtifact,
  LightroomCollectionKey,
  LightroomHandoffResult,
  MediaFile,
} from '../../shared/types';

const COLLECTIONS: Array<{ key: LightroomCollectionKey; label: string; keyword: string }> = [
  { key: 'selected', label: 'Keptra Selected', keyword: 'Keptra Collection: Selected' },
  { key: 'rejected', label: 'Keptra Rejected', keyword: 'Keptra Collection: Rejected' },
  { key: 'protected', label: 'Keptra Protected', keyword: 'Keptra Collection: Protected' },
  { key: 'second-pass-approved', label: 'Keptra Second Pass Approved', keyword: 'Keptra Collection: Second Pass Approved' },
  { key: 'catalog-duplicate', label: 'Keptra Catalog Duplicate', keyword: 'Keptra Collection: Catalog Duplicate' },
];

interface LightroomHandoffOptions {
  config?: Pick<ImportConfig, 'destRoot' | 'sourcePath'>;
  ledger?: ImportLedger;
  outputRoot?: string;
  source: LightroomHandoffResult['source'];
}

interface LightroomHandoffRecord {
  collection: LightroomCollectionKey;
  collectionLabel: string;
  keyword: string;
  sourcePath: string;
  targetPath: string;
  name: string;
  size: number;
  type: MediaFile['type'];
  pick?: MediaFile['pick'];
  rating?: number;
  isProtected: boolean;
  reviewApproved: boolean;
  catalogDuplicate: boolean;
  importedStatus?: ImportLedgerItem['status'];
  matchedPath?: string;
}

function stampFor(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, '-');
}

function csvEscape(value: unknown): string {
  if (value == null) return '';
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function safeFileStem(value: string): string {
  return value
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'file';
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function collectionKeysForFile(file: MediaFile): LightroomCollectionKey[] {
  const keys: LightroomCollectionKey[] = [];
  if (file.pick === 'selected') keys.push('selected');
  if (file.pick === 'rejected') keys.push('rejected');
  if (file.isProtected) keys.push('protected');
  if (file.reviewApproved) keys.push('second-pass-approved');
  if (file.duplicateMemory) keys.push('catalog-duplicate');
  return keys;
}

function ledgerItemsBySource(ledger?: ImportLedger): Map<string, ImportLedgerItem> {
  const bySource = new Map<string, ImportLedgerItem>();
  for (const item of ledger?.items ?? []) {
    bySource.set(item.sourcePath, item);
  }
  return bySource;
}

function bestTargetPath(file: MediaFile, item?: ImportLedgerItem): string {
  return item?.destFullPath || item?.backupFullPath || file.destPath || file.path;
}

function buildRows(files: MediaFile[], ledger?: ImportLedger): LightroomHandoffRecord[] {
  const items = ledgerItemsBySource(ledger);
  const rows: LightroomHandoffRecord[] = [];
  for (const file of files) {
    const item = items.get(file.path);
    for (const key of collectionKeysForFile(file)) {
      const collection = COLLECTIONS.find((entry) => entry.key === key)!;
      rows.push({
        collection: key,
        collectionLabel: collection.label,
        keyword: collection.keyword,
        sourcePath: file.path,
        targetPath: bestTargetPath(file, item),
        name: file.name,
        size: file.size,
        type: file.type,
        pick: file.pick,
        rating: file.rating,
        isProtected: !!file.isProtected,
        reviewApproved: !!file.reviewApproved,
        catalogDuplicate: !!file.duplicateMemory,
        importedStatus: item?.status,
        matchedPath: file.duplicateMemory?.matchedPath,
      });
    }
  }
  return rows;
}

function buildCsv(rows: LightroomHandoffRecord[]): string {
  const headers: Array<keyof LightroomHandoffRecord> = [
    'collection',
    'collectionLabel',
    'keyword',
    'name',
    'targetPath',
    'sourcePath',
    'type',
    'size',
    'pick',
    'rating',
    'isProtected',
    'reviewApproved',
    'catalogDuplicate',
    'importedStatus',
    'matchedPath',
  ];
  return [
    headers.join(','),
    ...rows.map((row) => headers.map((header) => csvEscape(row[header])).join(',')),
  ].join('\n') + '\n';
}

function buildXmpSidecar(row: LightroomHandoffRecord): string {
  const keywords = [row.keyword, row.collectionLabel];
  return [
    '<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>',
    '<x:xmpmeta xmlns:x="adobe:ns:meta/">',
    '  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">',
    '    <rdf:Description rdf:about=""',
    '      xmlns:dc="http://purl.org/dc/elements/1.1/"',
    '      xmlns:xmp="http://ns.adobe.com/xap/1.0/">',
    `      <dc:subject><rdf:Bag>${keywords.map((keyword) => `<rdf:li>${escapeXml(keyword)}</rdf:li>`).join('')}</rdf:Bag></dc:subject>`,
    row.rating ? `      <xmp:Rating>${Math.max(1, Math.min(5, row.rating))}</xmp:Rating>` : '',
    '    </rdf:Description>',
    '  </rdf:RDF>',
    '</x:xmpmeta>',
    '<?xpacket end="w"?>',
  ].filter(Boolean).join('\n');
}

function buildReadme(result: Omit<LightroomHandoffResult, 'readmePath'>): string {
  const counts = result.collections
    .map((collection) => `- ${collection.label}: ${collection.count}`)
    .join('\n');
  return [
    'Keptra Lightroom Handoff',
    '',
    `Created: ${result.createdAt}`,
    `Source: ${result.source}`,
    '',
    'Collections:',
    counts,
    '',
    'Files in this folder:',
    '- keptra-lightroom-handoff.json: machine-readable manifest with every helper artifact path.',
    '- keptra-lightroom-handoff.csv: one row per file/collection membership.',
    '- collections/*.txt: absolute target paths, one file per suggested Lightroom collection.',
    '- collections/*.csv: inspectable collection rows with source, target, rating, and status.',
    '- xmp-sidecars/*/*.xmp: keyword sidecar helpers that mirror the collection names.',
    '',
    'Lightroom workflow:',
    '1. Import the photos normally from the targetPath locations.',
    '2. Use the per-collection TXT/CSV files as checklists or with your preferred Lightroom collection importer/plugin.',
    '3. The XMP helpers carry Keptra collection keywords for users who prefer keyword or smart-collection workflows.',
    '',
  ].join('\n');
}

export async function writeLightroomHandoff(
  files: MediaFile[],
  options: LightroomHandoffOptions,
): Promise<LightroomHandoffResult> {
  const createdAt = new Date().toISOString();
  const outputBase = options.outputRoot || options.config?.destRoot || process.cwd();
  const outputDir = path.join(outputBase, `keptra-lightroom-handoff-${stampFor(new Date(createdAt))}`);
  const collectionsDir = path.join(outputDir, 'collections');
  const sidecarsDir = path.join(outputDir, 'xmp-sidecars');
  await mkdir(collectionsDir, { recursive: true });
  await mkdir(sidecarsDir, { recursive: true });

  const rows = buildRows(files, options.ledger);
  const manifestPath = path.join(outputDir, 'keptra-lightroom-handoff.json');
  const csvPath = path.join(outputDir, 'keptra-lightroom-handoff.csv');
  const readmePath = path.join(outputDir, 'README-Lightroom-Handoff.txt');
  await writeFile(csvPath, buildCsv(rows), 'utf8');

  const artifacts: LightroomCollectionArtifact[] = [];
  for (const collection of COLLECTIONS) {
    const collectionRows = rows.filter((row) => row.collection === collection.key);
    const fileStem = collection.key;
    const pathListPath = path.join(collectionsDir, `${fileStem}.txt`);
    const collectionCsvPath = path.join(collectionsDir, `${fileStem}.csv`);
    const xmpSidecarDir = path.join(sidecarsDir, fileStem);
    await mkdir(xmpSidecarDir, { recursive: true });
    await writeFile(pathListPath, collectionRows.map((row) => row.targetPath).join('\n') + (collectionRows.length > 0 ? '\n' : ''), 'utf8');
    await writeFile(collectionCsvPath, buildCsv(collectionRows), 'utf8');
    await Promise.all(collectionRows.map((row, index) => {
      const sidecarName = `${String(index + 1).padStart(4, '0')}-${safeFileStem(path.parse(row.name).name)}.xmp`;
      return writeFile(path.join(xmpSidecarDir, sidecarName), buildXmpSidecar(row), 'utf8');
    }));
    artifacts.push({
      key: collection.key,
      label: collection.label,
      count: collectionRows.length,
      pathListPath,
      csvPath: collectionCsvPath,
      xmpSidecarDir,
    });
  }

  const result: LightroomHandoffResult = {
    createdAt,
    source: options.source,
    outputDir,
    manifestPath,
    csvPath,
    readmePath,
    totalFiles: files.length,
    totalMemberships: rows.length,
    collections: artifacts,
  };
  await writeFile(readmePath, buildReadme(result), 'utf8');
  await writeFile(manifestPath, JSON.stringify(result, null, 2) + '\n', 'utf8');
  return result;
}
