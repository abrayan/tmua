/* Private teaching is fetched only through the signed-in household client.
   Neither HTML, access tokens nor signed URLs are written to public manifests. */
(() => {
  'use strict';
  const MAX_BYTES = 15 * 1024 * 1024;
  const ID = /^[a-z0-9][a-z0-9-]{0,79}$/;
  const SHA = /^[a-f0-9]{64}$/;
  const object = value => value && typeof value === 'object' && !Array.isArray(value);
  const clone = value => JSON.parse(JSON.stringify(value));
  const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : object(value) ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
  const digest = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)), b => b.toString(16).padStart(2,'0')).join('');
  const textHash = text => digest(new TextEncoder().encode(text));
  let client = null, account = null, generation = 0, entries = [], papers = [], privateVersions = [], error = null;
  const announce = () => document.dispatchEvent(new CustomEvent('tmua-private-catalog',{detail:{papers:clone(papers),error}}));
  function disconnect() { ++generation; client = null; account = null; entries = []; papers = []; privateVersions = []; error = null; announce(); }
  function validateRow(row) {
    if (!object(row) || !ID.test(row.paper_id) || !ID.test(row.edition_id) || row.edition_id === 'original' || !ID.test(row.pair_id) || ![1,2].includes(row.paper_number)
      || row.object_path !== `${row.paper_id}/${row.edition_id}.html` || !SHA.test(row.sha256) || !Number.isFinite(Date.parse(row.created_at))) throw Error('Invalid private teaching entry');
    const m = row.metadata, mapping = row.concept_mapping;
    if (!object(m) || m.visibility !== 'private' || m.format !== 'tmua-paper-v1' || m.version !== 1 || m.id !== row.paper_id || m.pairId !== row.pair_id
      || m.paper !== row.paper_number || m.questionCount !== 20 || m.practicePolicy !== 'after-miss-up-to-3' || m.href !== undefined
      || !['title','source','description'].every(key => typeof m[key] === 'string') || !m.title.trim() || m.title.length > 200 || m.source.length > 300 || m.description.length > 2000
      || !object(mapping) || !ID.test(mapping.versionId) || !SHA.test(mapping.sha256) || !object(mapping.paper)
      || mapping.paper.id !== row.paper_id || mapping.paper.paper !== row.paper_number || mapping.paper.questions?.length !== 20) throw Error('Invalid private paper metadata');
    return row;
  }
  async function validateRows(rows) {
    if (!Array.isArray(rows) || rows.length > 1000) throw Error('Invalid private catalogue');
    const byPair = new Map(), seen = new Set(), sourceOrder = new Map();
    for (const raw of rows) {
      const row = validateRow(raw), key = `${row.paper_id}:${row.edition_id}`, pairKey = `${row.pair_id}:${row.edition_id}`;
      if (seen.has(key)) throw Error('Repeated private teaching entry'); seen.add(key);
      const pair = byPair.get(pairKey) || []; pair.push(row); byPair.set(pairKey,pair);
      const order = canonical(row.concept_mapping.paper.questions.map(q => [q.sourceId,q.canonicalSourceId]));
      if (sourceOrder.has(row.paper_id) && sourceOrder.get(row.paper_id) !== order) throw Error('Private assessment order changed');
      sourceOrder.set(row.paper_id,order);
      if (await textHash(canonical(row.concept_mapping.paper)) !== row.concept_mapping.sha256) throw Error('Private concept mapping failed its integrity check');
      if (window.TmuaProgressAnalytics) window.TmuaProgressAnalytics.validateMap({version:1,papers:[row.concept_mapping.paper]});
    }
    for (const pair of byPair.values()) {
      if (pair.length !== 2 || new Set(pair.map(row => row.paper_number)).size !== 2
        || pair[0].concept_mapping.versionId !== pair[1].concept_mapping.versionId || pair[0].created_at !== pair[1].created_at) throw Error('Private paper pair is incomplete');
    }
    return clone(rows).sort((a,b) => Date.parse(a.created_at) - Date.parse(b.created_at) || a.edition_id.localeCompare(b.edition_id));
  }
  function makeCatalog(rows) {
    const grouped = new Map();
    for (const row of rows) {
      const value = grouped.get(row.paper_id) || {...row.metadata,private:true,editions:[]};
      value.editions.push({id:row.edition_id,contentHash:row.sha256.slice(0,16)});
      value.currentEditionId = row.edition_id;
      value.description = row.metadata.description;
      grouped.set(row.paper_id,value);
    }
    return [...grouped.values()];
  }
  async function refresh() {
    if (!client || !account) return;
    const current = generation, connection = client, before = canonical({entries,error});
    try {
      const response = await connection.from('tmua_guided_editions').select('paper_id,edition_id,pair_id,paper_number,object_path,sha256,metadata,concept_mapping,created_at').order('created_at',{ascending:true});
      if (current !== generation) return;
      if (response.error) throw Error('Private papers are not available yet.');
      const checked = await validateRows(response.data);
      if (current !== generation) return;
      const versions = new Map();
      for (const row of checked) {
        const m = row.concept_mapping, version = versions.get(m.versionId) || {id:m.versionId,pairId:row.pair_id,papers:[]};
        const existing = version.papers.find(p => p.id === row.paper_id);
        if (version.pairId !== row.pair_id || existing && canonical(existing) !== canonical(m.paper)) throw Error('Private mapping version changed');
        if (!existing) version.papers.push(clone(m.paper));
        versions.set(m.versionId,version);
      }
      const mappedVersions = [];
      for (const version of versions.values()) {
        version.papers.sort((a,b) => a.paper - b.paper);
        mappedVersions.push({id:version.id,papers:version.papers,sha256:await textHash(canonical(version.papers))});
      }
      if (current !== generation) return;
      entries = checked; papers = makeCatalog(entries); privateVersions = mappedVersions; error = null;
    } catch (_) {
      if (current !== generation) return;
      entries = []; papers = []; privateVersions = []; error = 'Your private papers could not be loaded. Refresh to try again.';
    }
    // Focusing the parent after working in its iframe must not replace the
    // roadmap button between pointer-down and click when nothing has changed.
    if (before !== canonical({entries,error})) announce();
  }
  async function connect(nextClient,userId) {
    disconnect();
    if (!nextClient?.from || !nextClient?.storage || typeof userId !== 'string' || !userId) return;
    client = nextClient; account = userId; await refresh();
  }
  function catalog() { return clone(papers); }
  function mergeMap(base) {
    const result = clone(base);
    if (!entries.length) return result;
    if (result.version !== 2 || !result.assessmentMappings) throw Error('Versioned concept mappings required');
    const publicIds = new Set(result.papers.map(p => p.id));
    for (const row of entries) {
      if (publicIds.has(row.paper_id)) throw Error('Private and public paper identities collide');
      result.assessmentMappings.editionBindings.push({paperId:row.paper_id,teachingEdition:row.edition_id,mappingVersion:row.concept_mapping.versionId});
    }
    for (const paper of papers) result.papers.push(clone(entries.filter(row => row.paper_id === paper.id).at(-1).concept_mapping.paper));
    for (const version of privateVersions) {
      if (result.assessmentMappings.versions.some(v => v.id === version.id)) throw Error('Private mapping identity collides');
      result.assessmentMappings.versions.push(clone(version));
    }
    return result;
  }
  async function loadHTML(paperId,editionId) {
    const current = generation, connection = client;
    const row = entries.find(entry => entry.paper_id === paperId && entry.edition_id === editionId);
    if (!connection || !account || !row) throw Error('This private teaching edition is unavailable.');
    const response = await connection.storage.from('tmua-guided').download(row.object_path);
    if (current !== generation) throw Error('The signed-in account changed.');
    if (response.error || !response.data || response.data.size > MAX_BYTES || response.data.size < 1) throw Error('Your private paper could not be loaded.');
    const bytes = await response.data.arrayBuffer();
    if (await digest(bytes) !== row.sha256) throw Error('The private paper failed its integrity check.');
    const html = new TextDecoder('utf-8',{fatal:true}).decode(bytes);
    const doc = new DOMParser().parseFromString(html,'text/html');
    const scripts = doc.querySelectorAll('script#tmua-paper-meta[type="application/json"]');
    if (scripts.length !== 1 || canonical(JSON.parse(scripts[0].textContent)) !== canonical(row.metadata)) throw Error('The private paper does not match its catalogue.');
    if (current !== generation) throw Error('The signed-in account changed.');
    // The sandbox has no origin/storage privileges. Deny remote requests as an
    // additional containment layer; questions/images and styling are embedded.
    const policy = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'";
    const csp = doc.createElement('meta'); csp.httpEquiv = 'Content-Security-Policy'; csp.content = policy; doc.head.prepend(csp);
    return '<!doctype html>\n' + doc.documentElement.outerHTML;
  }
  window.TmuaPrivate = Object.freeze({connect,disconnect,refresh,catalog,mergeMap,loadHTML});
})();
