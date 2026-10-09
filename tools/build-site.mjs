import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { validateContentAudit } from './validate-content-audit.mjs';
import { validateFollowupAudit } from './validate-followup-audit.mjs';
import { validateConceptMappings } from './validate-concept-mappings.mjs';
import { validateEditionSources } from './validate-edition-sources.mjs';
import {publicMockMarked,assertPublicMockMetadata,assertPublicMockRecord,assertPublicMockPaper} from './public-mock-sources.mjs';

const siteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fingerprint = content => createHash('sha256').update(content).digest('hex').slice(0, 16);
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
  if (metadata.visibility === 'private' || ['jzmaths-tyler','jzmaths-exam','miomath'].includes(metadata.provider)) fail('private purchased content cannot enter the public catalogue.');
  assertPublicMockMetadata(metadata);
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
  if (metadata.pairId !== undefined && (typeof metadata.pairId !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,79}$/.test(metadata.pairId))) fail('pairId must be a lowercase exam reference.');
  if (metadata.practicePolicy !== undefined && metadata.practicePolicy !== 'after-miss-up-to-3') fail('unsupported practice policy.');
  return {...Object.fromEntries(metadataFields.map((key) => [key, metadata[key]])), ...(metadata.practicePolicy ? {practicePolicy:metadata.practicePolicy} : {}), ...(metadata.pairId ? {pairId:metadata.pairId} : {}), ...(publicMockMarked(metadata) ? {provider:metadata.provider,visibility:metadata.visibility,sourceUrl:metadata.sourceUrl} : {})};
}


// The paid payload is compiled outside this repository. Refuse marked data even
// when accidentally placed in assets, which otherwise copies every regular file.
export function assertPublicPayload(value, filename = 'public file') {
  if (Array.isArray(value)) { value.forEach(item => assertPublicPayload(item, filename)); return; }
  if (!value || typeof value !== 'object') return;
  if (value.visibility === 'private' || ['jzmaths-tyler','jzmaths-exam','miomath'].includes(value.provider)) {
    throw new Error(`${filename}: private purchased content cannot be published.`);
  }
  // References in concept mappings are not full source payloads.
  if (value.metadata && Array.isArray(value.questions)) assertPublicMockPaper(value);
  if (publicMockMarked(value)) {
    if ('sourceId' in value && ('provider' in value || 'lead' in value)) assertPublicMockRecord(value);
    else if ('format' in value || 'provider' in value) assertPublicMockMetadata(value);
  }
  for (const item of Object.values(value)) assertPublicPayload(item, filename);
}
export async function assertPublicFile(filename) {
  const text = await readFile(filename, 'utf8');
  // Detect a marked JSON payload even if it was given a different extension.
  if (/^\s*[\[{]/.test(text)) {
    let value;
    try { value = JSON.parse(text); }
    catch (error) { if (/\.json$/i.test(filename)) throw error; }
    if (value !== undefined) { assertPublicPayload(value, filename); return; }
  }
  if (/\.json$/i.test(filename)) assertPublicPayload(JSON.parse(text), filename);
  // Marked object literals can be embedded in raw JS or renamed text assets.
  // Property/value syntax does not match legitimate runtime comparisons.
  if (/(?:["'](?:visibility|provider)["']|\b(?:visibility|provider))\s*:\s*["'](?:private|jzmaths-tyler|jzmaths-exam|miomath)["']/.test(text)) {
    throw new Error(`${filename}: private purchased content cannot be published.`);
  }
  for (const match of text.matchAll(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi)) {
    const source = match[0].replace(/^<script\b[^>]*>/i, '').replace(/<\/script\s*>$/i, '');
    // Modern standalone metadata and teaching payloads use JSON script blocks.
    if (/^\s*[\[{]/.test(source)) {
      let value; try { value=JSON.parse(source); } catch {}
      if (value !== undefined) assertPublicPayload(value, filename);
    }
    // Standalone metadata is JSON; DATA is embedded in a JavaScript assignment.
    if (/['"](?:visibility|provider)['"]\s*:\s*['"](?:private|jzmaths-tyler|jzmaths-exam|miomath)['"]/.test(source)) {
      throw new Error(`${filename}: private purchased content cannot be published.`);
    }
  }
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

// Teaching editions are append-only companions to the original standalone files.
// A manifest may be absent for older repositories and isolated build fixtures.
export async function attachTeachingEditions(root, papers) {
  const manifestPath = path.join(root, 'content', 'paper-editions.json');
  let manifest;
  try {
    const stats = await lstat(manifestPath);
    if (stats.isSymbolicLink() || !stats.isFile()) throw new Error('Teaching edition manifest must be a regular file.');
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (!manifest || manifest.version !== 1 || !Array.isArray(manifest.editions)) throw new Error('Invalid teaching edition manifest.');
  const seen = new Set();
  for (const entry of manifest.editions) {
    if (!entry || typeof entry.editionId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(entry.editionId) || entry.editionId === 'original'
      || typeof entry.paperId !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,79}$/.test(entry.paperId)
      || typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256)
      || entry.href !== `assets/editions/${entry.editionId}/${entry.paperId}.html`) throw new Error('Invalid teaching edition entry or unsafe path.');
    const key = `${entry.paperId}:${entry.editionId}`;
    if (seen.has(key)) throw new Error(`Duplicate teaching edition ${key}.`);
    seen.add(key);
    const paper = papers.find(item => item.id === entry.paperId);
    if (!paper) throw new Error(`Teaching edition ${key} has no original paper.`);
    let filename = root;
    for (const segment of entry.href.split('/')) {
      filename = path.join(filename, segment);
      const stats = await lstat(filename);
      if (stats.isSymbolicLink() || (segment === `${entry.paperId}.html` ? !stats.isFile() : !stats.isDirectory())) throw new Error(`Teaching edition ${key} must use regular files and directories.`);
      if (stats.isFile() && stats.size > 15 * 1024 * 1024) throw new Error(`Teaching edition ${key} is larger than 15 MB.`);
    }
    const buffer = await readFile(filename);
    const sha256 = createHash('sha256').update(buffer).digest('hex');
    if (sha256 !== entry.sha256) throw new Error(`Teaching edition ${key} changed: its immutable SHA-256 does not match.`);
    const metadata = parseMetadata(new TextDecoder('utf-8', {fatal:true}).decode(buffer),entry.href);
    for (const field of ['id','paper','version','questionCount','practicePolicy']) {
      if (metadata[field] !== paper[field]) throw new Error(`Teaching edition ${key} must preserve original ${field}.`);
    }
    (paper.editions ||= []).push({id:entry.editionId,href:entry.href,contentHash:sha256.slice(0,16)});
    paper.currentEditionId = entry.editionId;
    paper.description = metadata.description;
  }
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
      papers.push({ ...metadata, href: relativeUrl(root, filename), contentHash: fingerprint(buffer) });
      sourceFiles.push(filename);
    } catch (error) {
      errors.push(`${relative}: ${error.message}`.replace(`${relative}: ${relative}: `, `${relative}: `));
    }
  }
  if (errors.length) throw new Error(`Cannot build the paper library:\n${errors.map((error) => `- ${error}`).join('\n')}`);
  await attachTeachingEditions(root, papers);
  papers.sort((a, b) => a.paper - b.paper || a.title.localeCompare(b.title, 'en', { sensitivity: 'base' }) || a.id.localeCompare(b.id, 'en'));
  return { catalog: { papers, errors: [] }, sourceFiles };
}

export async function buildSite(root = siteRoot, {editionSourceBaseline} = {}) {
  root = path.resolve(root);
  // Production builds cannot omit the mandatory review files. Isolated generic
  // fixtures remain usable without copying the site's full teaching catalogue.
  if (root === siteRoot) await validateContentAudit(root);
  if (root === siteRoot) await validateFollowupAudit(root);
  if (root === siteRoot) await validateConceptMappings(root);
  if (root === siteRoot) await validateEditionSources(root,{priorRead:editionSourceBaseline});
  const indexFile = path.join(root, 'index.html');
  const indexStats = await lstat(indexFile);
  if (!indexStats.isFile() || indexStats.isSymbolicLink()) throw new Error('index.html must be a regular file.');
  const { catalog, sourceFiles } = await discoverPapers(root);
  // Existing attempts depend on these exact standalone files, not just their IDs.
  let published;
  try {
    published = JSON.parse(await readFile(path.join(root, 'content', 'published-papers.json'), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (published !== undefined) {
    if (published?.version !== 1 || !Array.isArray(published.papers)) throw new Error('Invalid published-paper protection file.');
    const seen = new Set();
    const files = new Map(sourceFiles.map(file => [relativeUrl(root, file), file]));
    for (const entry of published.papers) {
      if (!entry || typeof entry.id !== 'string' || typeof entry.href !== 'string' ||
          !/^[a-f0-9]{64}$/.test(entry.sha256) || seen.has(entry.id)) throw new Error('Invalid published-paper protection entry.');
      seen.add(entry.id);
      const paper = catalog.papers.find(item => item.id === entry.id);
      const file = paper && paper.href === entry.href && files.get(paper.href);
      const hash = file && createHash('sha256').update(await readFile(file)).digest('hex');
      if (hash !== entry.sha256) {
        throw new Error(`Published paper ${entry.id} changed or is missing. Preserve its HTML, ID and URL so saved attempts remain intact. Publish changes as a separate version with safe attempt routing.`);
      }
    }
  }
  // New releases are complete exam pairs. Existing frozen papers retain their
  // original metadata and URLs, including the historical preview.
  let pairPolicy;
  try { pairPolicy = JSON.parse(await readFile(path.join(root, 'content', 'pair-publication.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (pairPolicy !== undefined) {
    if (pairPolicy.version !== 1 || !Array.isArray(pairPolicy.legacyPaperIds) || pairPolicy.legacyPaperIds.some(id => typeof id !== 'string')) throw new Error('Invalid pair publication policy.');
    const legacy = new Set(pairPolicy.legacyPaperIds), pairs = new Map();
    for (const paper of catalog.papers) {
      if (legacy.has(paper.id)) continue;
      if (!paper.pairId) throw new Error(`${paper.id}: new papers require a pairId and a matching Paper 1 / Paper 2.`);
      if (!pairs.has(paper.pairId)) pairs.set(paper.pairId, []);
      pairs.get(paper.pairId).push(paper);
    }
    for (const [id, pair] of pairs) {
      if (pair.length !== 2 || new Set(pair.map(paper => paper.paper)).size !== 2 || pair.some(paper => paper.questionCount !== 20)) {
        throw new Error(`${id}: publish Paper 1 and Paper 2 together, with 20 questions in each.`);
      }
    }
  }
  const assets = await regularFiles(path.join(root, 'assets'));
  await Promise.all([indexFile, ...assets, ...sourceFiles].map(assertPublicFile));
  const assetHashes = new Map();
  for (const file of assets) {
    if (/\.(?:js|css)$/i.test(file)) assetHashes.set(relativeUrl(root, file), fingerprint(await readFile(file)));
  }
  const indexHtml = (await readFile(indexFile, 'utf8')).replace(/\b(src|href)=(["'])(assets\/[^"'?#]+)\2/g, (attribute, name, quote, href) => {
    const hash = assetHashes.get(href);
    return hash ? `${name}=${quote}${href}?v=${hash}${quote}` : attribute;
  });
  const staging = await mkdtemp(path.join(root, '.site-build-'));
  const destination = path.join(root, 'dist');
  try {
    for (const file of [indexFile, ...assets, ...sourceFiles]) {
      const target = path.join(staging, path.relative(root, file));
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(file, target);
    }
    await writeFile(path.join(staging, 'index.html'), indexHtml);
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
