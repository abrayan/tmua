import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const siteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const metadataFields = ['format', 'id', 'title', 'paper', 'source', 'description', 'questionCount', 'version'];

export function parseMetadata(html, filename = 'Paper HTML') {
  const documents = [];
  for (const match of html.matchAll(/<!--[\s\S]*?-->|<script\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)(?:<\/script\s*>|$)/gi)) {
    if (match[1] === undefined) continue;
    const attributes = {};
    for (const attribute of match[1].matchAll(/([^\s=\/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
      attributes[attribute[1].toLowerCase()] = attribute[2] ?? attribute[3] ?? attribute[4] ?? '';
    }
    if (attributes.id !== 'tmua-paper-meta') continue;
    if (!/<\/script\s*>$/i.test(match[0])) throw new Error(`${filename}: paper metadata script is incomplete.`);
    if (attributes.type?.toLowerCase() !== 'application/json') {
      throw new Error(`${filename}: paper metadata must use type="application/json".`);
    }
    documents.push(match[2]);
  }
  if (documents.length !== 1) {
    throw new Error(`${filename}: include exactly one complete tmua-paper-meta JSON script.`);
  }
  let metadata;
  try {
    metadata = JSON.parse(documents[0]);
  } catch {
    throw new Error(`${filename}: paper metadata is not valid JSON.`);
  }
  const fail = (message) => { throw new Error(`${filename}: ${message}`); };
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) fail('paper metadata must be a JSON object.');
  if (metadata.format !== 'tmua-paper-v1') fail('paper format must be tmua-paper-v1.');
  if (metadata.version !== 1) fail('paper metadata version must be 1.');
  if (typeof metadata.id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,79}$/.test(metadata.id)) {
    fail('paper ID must contain 1–80 lowercase letters, numbers, hyphens or underscores.');
  }
  if (metadata.paper !== 1 && metadata.paper !== 2) fail('paper category must be 1 or 2.');
  if (!Number.isInteger(metadata.questionCount) || metadata.questionCount < 1 || metadata.questionCount > 1000) {
    fail('question count must be a whole number from 1 to 1000.');
  }
  for (const [key, maximum] of [['title', 200], ['source', 300], ['description', 2000]]) {
    const value = metadata[key];
    if (typeof value !== 'string' || [...value].length > maximum || (key !== 'description' && !value.trim())) {
      fail(`paper ${key} must be text with at most ${maximum} characters.`);
    }
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)) fail(`paper ${key} contains an unsupported control character.`);
  }
  return Object.fromEntries(metadataFields.map((key) => [key, metadata[key]]));
}

async function regularFiles(directory) {
  let entries;
  try {
    const stats = await lstat(directory);
    if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error(`${directory}: must be a regular directory.`);
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    if (entry.name.startsWith('.')) continue;
    const filename = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`${filename}: symbolic links are not supported in published files.`);
    if (entry.isDirectory()) files.push(...await regularFiles(filename));
    else if (entry.isFile()) files.push(filename);
  }
  return files;
}

function relativeUrl(root, filename) {
  return path.relative(root, filename).split(path.sep).map(encodeURIComponent).join('/');
}

export async function discoverPapers(root = siteRoot) {
  root = path.resolve(root);
  const papers = [];
  const sourceFiles = [];
  const errors = [];
  const ids = new Map();
  for (const filename of await regularFiles(path.join(root, 'papers'))) {
    if (path.extname(filename).toLowerCase() !== '.html') continue;
    const relative = path.relative(root, filename).split(path.sep).join('/');
    try {
      if ((await lstat(filename)).size > 15 * 1024 * 1024) throw new Error(`${relative}: paper is larger than 15 MB.`);
      const buffer = await readFile(filename);
      const html = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
      const metadata = parseMetadata(html, relative);
      for (const folder of path.relative(path.join(root, 'papers'), path.dirname(filename)).split(path.sep)) {
        const category = /^paper-([12])$/.exec(folder);
        if (category && Number(category[1]) !== metadata.paper) throw new Error(`${relative}: paper category does not match its folder.`);
      }
      if (ids.has(metadata.id)) throw new Error(`${relative}: duplicate paper ID "${metadata.id}" is already used by ${ids.get(metadata.id)}.`);
      ids.set(metadata.id, relative);
      papers.push({ ...metadata, href: relativeUrl(root, filename) });
      sourceFiles.push(filename);
    } catch (error) {
      errors.push(`${relative}: ${error.message}`.replace(`${relative}: ${relative}: `, `${relative}: `));
    }
  }
  if (errors.length) throw new Error(`Cannot build the paper library:\n${errors.map((error) => `- ${error}`).join('\n')}`);
  papers.sort((a, b) => a.paper - b.paper || a.title.localeCompare(b.title, 'en', { sensitivity: 'base' }) || a.id.localeCompare(b.id, 'en'));
  return { catalog: { papers, errors: [] }, sourceFiles };
}

export async function buildSite(root = siteRoot) {
  root = path.resolve(root);
  const indexFile = path.join(root, 'index.html');
  const indexStats = await lstat(indexFile);
  if (!indexStats.isFile() || indexStats.isSymbolicLink()) throw new Error('index.html must be a regular file.');
  const { catalog, sourceFiles } = await discoverPapers(root);
  const assets = await regularFiles(path.join(root, 'assets'));
  const staging = await mkdtemp(path.join(root, '.site-build-'));
  const destination = path.join(root, 'dist');
  try {
    for (const file of [indexFile, ...assets, ...sourceFiles]) {
      const target = path.join(staging, path.relative(root, file));
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(file, target);
    }
    await mkdir(path.join(staging, 'papers', 'paper-1'), { recursive: true });
    await mkdir(path.join(staging, 'papers', 'paper-2'), { recursive: true });
    await writeFile(path.join(staging, 'papers', 'catalog.json'), JSON.stringify(catalog, null, 2) + '\n');
    await writeFile(path.join(staging, '.nojekyll'), '');
    await rm(destination, { recursive: true, force: true });
    await rename(staging, destination);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
  return { destination, catalog };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { destination, catalog } = await buildSite();
    console.log(`Built ${catalog.papers.length} paper${catalog.papers.length === 1 ? '' : 's'} → ${destination}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
