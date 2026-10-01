import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const SMALL_IMAGE_BYTES = 32 * 1024;
const WEBP_SAVINGS_THRESHOLD = 0.05;
const PAGE_SIZE = 1000;

for (const filename of ['.env', '.env.local']) {
  const filepath = join(ROOT, filename);
  if (existsSync(filepath) && typeof process.loadEnvFile === 'function') process.loadEnvFile(filepath);
}

function readProjectConfig() {
  const config = readFileSync(join(ROOT, 'supabase-config.js'), 'utf8');
  const readValue = (name) => config.match(new RegExp(`window\\.${name}\\s*=\\s*["']([^"']+)["']`))?.[1];
  return {
    url: process.env.SUPABASE_URL || process.env.RANGSHU_SUPABASE_URL || readValue('RANGSHU_SUPABASE_URL'),
    publishableKey: process.env.SUPABASE_ANON_KEY || process.env.RANGSHU_SUPABASE_KEY || readValue('RANGSHU_SUPABASE_KEY')
  };
}

const config = readProjectConfig();
const supabaseUrl = config.url?.replace(/\/$/, '');
const apiKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const mode = process.argv.includes('--migrate') ? 'migrate' : 'dry-run';

if (!supabaseUrl || !apiKey) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. Set them in the environment or .env.local; no request was made.');
  process.exit(1);
}
if (mode === 'migrate' && !process.argv.includes('--migrate')) {
  console.error('Migration requires the explicit --migrate flag.');
  process.exit(1);
}
if (process.argv.includes('--dry-run') && mode === 'migrate') {
  console.error('Choose either --dry-run or --migrate, not both.');
  process.exit(1);
}

const headers = {
  apikey: apiKey,
  authorization: `Bearer ${apiKey}`
};

function apiUrl(path) {
  return `${supabaseUrl}${path}`;
}

async function apiRequest(path, options = {}) {
  const response = await fetch(apiUrl(path), {
    ...options,
    headers: { ...headers, ...options.headers }
  });
  if (!response.ok) {
    const detail = await response.text();
    const error = new Error(`${options.method || 'GET'} ${path} failed (${response.status}): ${detail.slice(0, 500)}`);
    error.status = response.status;
    throw error;
  }
  return response;
}

async function apiJson(path, options) {
  const response = await apiRequest(path, options);
  return response.status === 204 ? null : response.json();
}

function encodeObjectPath(path) {
  return path.split('/').map(encodeURIComponent).join('/');
}

function imageExtension(path) {
  const cleanPath = path.split(/[?#]/, 1)[0];
  const filename = cleanPath.slice(cleanPath.lastIndexOf('/') + 1);
  const dot = filename.lastIndexOf('.');
  return dot < 0 ? '' : filename.slice(dot).toLowerCase();
}

function objectKey(bucket, path) {
  return `${bucket}/${path}`;
}

function parseStorageReference(value, bucketNames) {
  if (typeof value !== 'string' || !value) return null;
  try {
    const parsed = new URL(value, supabaseUrl);
    if (parsed.origin !== new URL(supabaseUrl).origin) return null;
    const match = parsed.pathname.match(/\/storage\/v1\/object\/(?:public|authenticated|sign)\/([^/]+)\/(.+)$/);
    if (match) {
      const bucket = decodeURIComponent(match[1]);
      const path = match[2].split('/').map(decodeURIComponent).join('/');
      return bucketNames.has(bucket) ? { bucket, path } : null;
    }
  } catch {}

  for (const bucket of bucketNames) {
    const prefix = `${bucket}/`;
    if (value.startsWith(prefix)) return { bucket, path: value.slice(prefix.length).split(/[?#]/, 1)[0] };
  }
  return null;
}

async function listBuckets() {
  const buckets = await apiJson('/storage/v1/bucket');
  if (!Array.isArray(buckets)) throw new Error('Supabase Storage did not return a bucket list.');
  return buckets;
}

async function listBucketObjects(bucket) {
  const files = [];
  const visitedDirectories = new Set();

  async function visit(prefix) {
    const directoryKey = `${bucket.id}/${prefix}`;
    if (visitedDirectories.has(directoryKey)) return;
    visitedDirectories.add(directoryKey);
    const directories = [];
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const items = await apiJson(`/storage/v1/object/list/${encodeURIComponent(bucket.id)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prefix, limit: PAGE_SIZE, offset, sortBy: { column: 'name', order: 'asc' } })
      });
      if (!Array.isArray(items)) throw new Error(`Unexpected Storage listing response for bucket ${bucket.id}.`);
      for (const item of items) {
        const path = prefix ? `${prefix}/${item.name}` : item.name;
        if (item.id || item.metadata || item.updated_at) {
          files.push({ bucket: bucket.id, path, size: Number(item.metadata?.size || item.size || 0), metadata: item.metadata || {} });
        } else {
          directories.push(path);
        }
      }
      if (items.length < PAGE_SIZE) break;
    }
    for (const directory of directories) await visit(directory);
  }

  await visit('');
  return files;
}

async function getTableColumns(table, candidates) {
  let columns = [...candidates];
  while (columns.length) {
    const params = new URLSearchParams({ select: columns.join(','), limit: '0' });
    try {
      await apiRequest(`/rest/v1/${table}?${params}`);
      return columns;
    } catch (error) {
      const optional = columns.find(column => error.message.includes(column) && column !== 'id');
      if (!optional) throw error;
      columns = columns.filter(column => column !== optional);
    }
  }
  throw new Error(`Unable to discover readable columns for ${table}.`);
}

async function loadTableRows(table, columns) {
  const rows = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const params = new URLSearchParams({ select: columns.join(','), order: 'id.asc', limit: String(PAGE_SIZE), offset: String(offset) });
    const page = await apiJson(`/rest/v1/${table}?${params}`);
    if (!Array.isArray(page)) throw new Error(`Unexpected Database response for ${table}.`);
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  return rows;
}

async function loadDatabaseReferences(bucketNames) {
  const schemas = [
    { table: 'works', columns: ['id', 'updated_at', 'cover_url', 'gallery', 'content_blocks'] },
    { table: 'journal_entries', columns: ['id', 'updated_at', 'cover_url', 'gallery', 'content_blocks'] }
  ];
  const records = [];
  const referencesByKey = new Map();
  const fieldCounts = new Map();

  for (const schema of schemas) {
    const columns = await getTableColumns(schema.table, schema.columns);
    if (!columns.includes('id')) throw new Error(`The ${schema.table} table has no id column.`);
    const rows = await loadTableRows(schema.table, columns);
    for (const row of rows) {
      const record = { table: schema.table, id: row.id, columns, values: row };
      records.push(record);
      for (const column of columns.filter(name => name !== 'id')) {
        collectReferences(row[column], column, bucketNames, (reference, fieldPath, value) => {
          const key = objectKey(reference.bucket, reference.path);
          const entry = { record, column, fieldPath, value, key };
          if (!referencesByKey.has(key)) referencesByKey.set(key, []);
          referencesByKey.get(key).push(entry);
          const field = `${schema.table}.${column}${fieldPath ? `.${fieldPath}` : ''}`;
          fieldCounts.set(field, (fieldCounts.get(field) || 0) + 1);
        });
      }
    }
  }
  return { records, referencesByKey, fieldCounts };
}

function collectReferences(value, fieldPath, bucketNames, callback) {
  if (typeof value === 'string') {
    const reference = parseStorageReference(value, bucketNames);
    if (reference && IMAGE_EXTENSIONS.has(imageExtension(reference.path))) callback(reference, fieldPath, value);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectReferences(item, `${fieldPath}[${index}]`, bucketNames, callback));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) collectReferences(item, `${fieldPath}.${key}`, bucketNames, callback);
  }
}

async function downloadObject(file) {
  const path = `/storage/v1/object/${encodeURIComponent(file.bucket)}/${encodeObjectPath(file.path)}`;
  const response = await apiRequest(path);
  return Buffer.from(await response.arrayBuffer());
}

function orientedDimensions(metadata) {
  const swapsAxes = [5, 6, 7, 8].includes(metadata.orientation);
  return swapsAxes ? { width: metadata.height, height: metadata.width } : { width: metadata.width, height: metadata.height };
}

async function analyzeImage(file) {
  const input = await downloadObject(file);
  const image = sharp(input);
  const metadata = await image.metadata();
  if (!metadata.width || !metadata.height) throw new Error('Image dimensions are unavailable.');
  const dimensions = orientedDimensions(metadata);
  const output = await image
    .rotate()
    .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true, fastShrinkOnLoad: true })
    .webp({ quality: 78, effort: 4 })
    .toBuffer();
  const outputMetadata = await sharp(output).metadata();
  const needsResize = dimensions.width > 1600 || dimensions.height > 1600;
  const savingsRatio = (file.size - output.length) / Math.max(file.size, 1);
  const isTiny = file.size <= SMALL_IMAGE_BYTES && !needsResize;
  const isOptimizedWebp = imageExtension(file.path) === '.webp' && !needsResize && savingsRatio < WEBP_SAVINGS_THRESHOLD;
  const alreadyMigrated = file.path.split('/').includes('batch-compressed');
  const shouldCompress = !isTiny && !isOptimizedWebp && !alreadyMigrated && output.length < file.size;
  return {
    file,
    input,
    output,
    dimensions,
    outputDimensions: { width: outputMetadata.width, height: outputMetadata.height },
    skipReason: alreadyMigrated ? 'already in batch-compressed path'
      : isTiny ? 'small image (32 KB or less)'
        : isOptimizedWebp ? 'WebP already optimized'
          : output.length >= file.size ? 'recompression would not reduce size' : '',
    shouldCompress
  };
}

function formatBytes(bytes) {
  const mb = bytes / (1024 ** 2);
  const gb = bytes / (1024 ** 3);
  return `${mb.toFixed(2)} MB / ${gb.toFixed(3)} GB`;
}

function printReport({ buckets, files, analyses, database }) {
  const analysisByKey = new Map(analyses.map(item => [objectKey(item.file.bucket, item.file.path), item]));
  const images = files.filter(file => IMAGE_EXTENSIONS.has(imageExtension(file.path)));
  const totalBytes = images.reduce((sum, file) => sum + file.size, 0);
  const estimatedBytes = images.reduce((sum, file) => {
    const analysis = analysisByKey.get(objectKey(file.bucket, file.path));
    return sum + (analysis?.shouldCompress ? analysis.output.length : file.size);
  }, 0);
  const estimatedReduction = totalBytes - estimatedBytes;
  const toCompress = analyses.filter(item => item.shouldCompress);
  const skipped = analyses.length - toCompress.length;
  const largest = [...images].sort((a, b) => b.size - a.size).slice(0, 20);

  console.log('\n=== Supabase Storage Image Dry Run ===');
  console.log(`Total images: ${images.length}`);
  console.log(`Current total size: ${formatBytes(totalBytes)}`);
  console.log(`Estimated compressed size: ${formatBytes(estimatedBytes)}`);
  console.log(`Estimated reduction: ${formatBytes(estimatedReduction)}`);
  console.log(`Estimated reduction %: ${totalBytes ? `${(estimatedReduction * 100 / totalBytes).toFixed(2)}%` : '0.00%'}`);
  console.log(`Images to compress: ${toCompress.length}`);
  console.log(`Images skipped: ${skipped}`);

  console.log('\nLargest 20 images:');
  console.log('filename | dimensions | current size | estimated size');
  for (const file of largest) {
    const analysis = analysisByKey.get(objectKey(file.bucket, file.path));
    const dims = analysis ? `${analysis.dimensions.width}x${analysis.dimensions.height}` : 'unavailable';
    const estimate = analysis?.shouldCompress ? analysis.output.length : file.size;
    console.log(`${file.path} | ${dims} | ${formatBytes(file.size)} | ${formatBytes(estimate)}`);
  }

  console.log('\nBucket usage (all object types):');
  for (const bucket of buckets) {
    const bucketFiles = files.filter(file => file.bucket === bucket.id);
    const bytes = bucketFiles.reduce((sum, file) => sum + file.size, 0);
    console.log(`${bucket.id}: ${formatBytes(bytes)} (${bucketFiles.length} objects)`);
  }

  console.log('\nDatabase image references:');
  if (database.fieldCounts.size) {
    for (const [field, count] of [...database.fieldCounts].sort(([a], [b]) => a.localeCompare(b))) console.log(`${field}: ${count} image URL references`);
  } else {
    console.log('No Storage image URLs found in the inspected image columns.');
  }

  const failures = analyses.filter(item => item.error);
  if (failures.length) {
    console.log(`\nImages that could not be analyzed: ${failures.length}`);
    for (const item of failures) console.log(`${item.file.bucket}/${item.file.path}: ${item.error}`);
  }
}

function makePublicUrl(bucket, path) {
  return `${supabaseUrl}/storage/v1/object/public/${encodeURIComponent(bucket)}/${encodeObjectPath(path)}`;
}

function replacementValue(originalValue, bucket, oldPath, newPath) {
  if (typeof originalValue !== 'string') return originalValue;
  const reference = parseStorageReference(originalValue, new Set([bucket]));
  if (!reference || reference.path !== oldPath) return originalValue;
  if (/^https?:\/\//i.test(originalValue)) return makePublicUrl(bucket, newPath);
  return `${bucket}/${newPath}`;
}

function replaceReferences(value, bucket, oldPath, newPath) {
  if (typeof value === 'string') return replacementValue(value, bucket, oldPath, newPath);
  if (Array.isArray(value)) return value.map(item => replaceReferences(item, bucket, oldPath, newPath));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceReferences(item, bucket, oldPath, newPath)]));
  }
  return value;
}

async function updateDatabaseRecord(record, bucket, oldPath, newPath, bucketNames) {
  const currentQuery = new URLSearchParams({ select: record.columns.join(','), id: `eq.${record.id}`, limit: '1' });
  const [current] = await apiJson(`/rest/v1/${record.table}?${currentQuery}`);
  if (!current) throw new Error(`Could not read ${record.table} row ${record.id} before update.`);

  const patch = {};
  for (const column of record.columns.filter(name => name !== 'id')) {
    const value = current[column];
    const updated = replaceReferences(value, bucket, oldPath, newPath);
    if (JSON.stringify(updated) !== JSON.stringify(value)) patch[column] = updated;
  }
  if (!Object.keys(patch).length) return;

  const params = new URLSearchParams({ id: `eq.${record.id}` });
  if (current.updated_at) params.set('updated_at', `eq.${current.updated_at}`);
  const response = await apiJson(`/rest/v1/${record.table}?${params}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', prefer: 'return=representation' },
    body: JSON.stringify(patch)
  });
  if (!Array.isArray(response) || response.length !== 1) throw new Error(`Database update did not affect exactly one ${record.table} row (${record.id}).`);

  const select = record.columns.join(',');
  const query = new URLSearchParams({ select, id: `eq.${record.id}`, limit: '1' });
  const [updated] = await apiJson(`/rest/v1/${record.table}?${query}`);
  if (!updated) throw new Error(`Could not read back ${record.table} row ${record.id} after update.`);
  record.values = updated;
  for (const column of record.columns.filter(name => name !== 'id')) {
    let stillReferencesOld = false;
    collectReferences(updated[column], column, bucketNames, reference => {
      if (reference.bucket === bucket && reference.path === oldPath) stillReferencesOld = true;
    });
    if (stillReferencesOld) throw new Error(`Old image URL remains in ${record.table}.${column} for row ${record.id}.`);
  }
}

async function uploadCompressedImage(analysis, newPath) {
  const path = `/storage/v1/object/${encodeURIComponent(analysis.file.bucket)}/${encodeObjectPath(newPath)}`;
  try {
    await apiRequest(path, {
      method: 'POST',
      headers: { 'content-type': 'image/webp', 'x-upsert': 'false', 'cache-control': '3600' },
      body: analysis.output
    });
  } catch (error) {
    if (![400, 409].includes(error.status)) throw error;
    const existing = await downloadObject({ bucket: analysis.file.bucket, path: newPath });
    if (createHash('sha256').update(existing).digest('hex') !== createHash('sha256').update(analysis.output).digest('hex')) {
      throw new Error(`Destination already exists with different content: ${newPath}`);
    }
  }
}

async function validateStoredWebp(bucket, path) {
  const stored = await downloadObject({ bucket, path });
  const metadata = await sharp(stored).metadata();
  if (metadata.format !== 'webp' || !metadata.width || !metadata.height || metadata.width > 1600 || metadata.height > 1600) {
    throw new Error(`Uploaded object failed WebP/dimension validation: ${bucket}/${path}`);
  }
}

async function deleteOriginal(file) {
  const path = `/storage/v1/object/${encodeURIComponent(file.bucket)}/${encodeObjectPath(file.path)}`;
  await apiRequest(path, { method: 'DELETE' });
}

async function migrateImage(analysis, referencesByKey, bucketNames) {
  const { file, output } = analysis;
  const hash = createHash('sha256').update(`${file.bucket}/${file.path}`).digest('hex').slice(0, 16);
  const filename = file.path.slice(file.path.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '');
  const folder = dirname(file.path);
  const newPath = [folder === '.' ? '' : folder, 'batch-compressed', `${hash}-${filename}.webp`].filter(Boolean).join('/');
  const refs = referencesByKey.get(objectKey(file.bucket, file.path)) || [];
  const records = [...new Map(refs.map(reference => [`${reference.record.table}:${reference.record.id}`, reference.record])).values()];

  await uploadCompressedImage(analysis, newPath);
  for (const record of records) await updateDatabaseRecord(record, file.bucket, file.path, newPath, bucketNames);
  await validateStoredWebp(file.bucket, newPath);
  await deleteOriginal(file);
  console.log(`Migrated ${file.bucket}/${file.path} -> ${file.bucket}/${newPath} (${formatBytes(output.length)})`);
}

async function main() {
  const buckets = await listBuckets();
  const bucketNames = new Set(buckets.map(bucket => bucket.id));
  const filePages = await Promise.all(buckets.map(bucket => listBucketObjects(bucket)));
  const files = filePages.flat();
  const images = files.filter(file => IMAGE_EXTENSIONS.has(imageExtension(file.path)));
  const database = await loadDatabaseReferences(bucketNames);
  const analyses = [];

  for (let index = 0; index < images.length; index++) {
    const file = images[index];
    try {
      const analysis = await analyzeImage(file);
      analyses.push(analysis);
      if ((index + 1) % 25 === 0 || index + 1 === images.length) console.log(`Analyzed ${index + 1}/${images.length} images`);
    } catch (error) {
      analyses.push({ file, shouldCompress: false, skipReason: 'analysis failed', error: error.message });
    }
  }

  printReport({ buckets, files, analyses, database });
  if (mode === 'dry-run') {
    console.log('\nDry Run complete. No Storage object or Database row was changed.');
    return;
  }

  console.log('\nMigration enabled. Each original is retained unless its replacement is uploaded, referenced rows are updated and verified, and the new WebP is validated.');
  for (const analysis of analyses.filter(item => item.shouldCompress)) {
    if (buckets.find(bucket => bucket.id === analysis.file.bucket)?.public !== true) {
      console.log(`Skipped private bucket object; original retained: ${analysis.file.bucket}/${analysis.file.path}`);
      continue;
    }
    try {
      await migrateImage(analysis, database.referencesByKey, bucketNames);
    } catch (error) {
      console.error(`FAILED; original retained: ${analysis.file.bucket}/${analysis.file.path}: ${error.message}`);
    }
  }
}

main().catch(error => {
  console.error(`Storage image batch ${mode} failed: ${error.message}`);
  process.exitCode = 1;
});