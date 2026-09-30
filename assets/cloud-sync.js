/* A transport-only sync controller. The host owns authentication and local storage. */
(() => {
  'use strict';

  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const copy = value => JSON.parse(JSON.stringify(value));
  const emptyPayload = () => ({version: 1, library: {}, history: {version: 1, attempts: []}, roadmap: {version: 1, pairs: {}}});

  function validatePayload(value) {
    if (!object(value) || value.version !== 1 || !object(value.library)
      || !object(value.history) || value.history.version !== 1 || !Array.isArray(value.history.attempts)
      || !object(value.roadmap) || value.roadmap.version !== 1 || !object(value.roadmap.pairs)) return false;
    const ids = new Set();
    for (const attempt of value.history.attempts) {
      if (!object(attempt) || typeof attempt.id !== 'string' || !attempt.id || ids.has(attempt.id)) return false;
      ids.add(attempt.id);
    }
    try { JSON.stringify(value); } catch (_) { return false; }
    return true;
  }

  function payload(value) {
    if (!validatePayload(value)) throw new Error('Invalid progress data');
    return copy(value);
  }

  // Object key order is not part of progress. Array order is retained.
  function canonical(value) {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
    return JSON.stringify(value);
  }
  const samePayload = (left, right) => canonical(left) === canonical(right);
  const isEmpty = value => !Object.keys(value.library).length && !value.history.attempts.length && !Object.keys(value.roadmap.pairs).length;

  function mergePayloads(localValue, remoteValue) {
    const local = payload(localValue), remote = payload(remoteValue), conflicts = [];
    function mergeMap(left, right, path) {
      const merged = new Map(Object.entries(right));
      for (const [key, value] of Object.entries(left)) {
        if (merged.has(key) && !samePayload(value, merged.get(key))) {
          conflicts.push({path: `${path}.${key}`, local: copy(value), remote: copy(merged.get(key))});
        } else merged.set(key, value);
      }
      return Object.fromEntries(merged);
    }
    const library = mergeMap(local.library, remote.library, 'library');
    const pairs = mergeMap(local.roadmap.pairs, remote.roadmap.pairs, 'roadmap.pairs');
    const attempts = new Map(remote.history.attempts.map(attempt => [attempt.id, attempt]));
    for (const attempt of local.history.attempts) {
      if (attempts.has(attempt.id) && !samePayload(attempt, attempts.get(attempt.id))) {
        conflicts.push({path: `history.attempts.${attempt.id}`, local: copy(attempt), remote: copy(attempts.get(attempt.id))});
      } else attempts.set(attempt.id, attempt);
    }
    // A conflicting result is only a preview. The controller will never write it.
    return {payload: {version: 1, library, history: {version: 1, attempts: [...attempts.values()]}, roadmap: {version: 1, pairs}}, conflicts};
  }

  /**
   * readLocal/applyRemote/persistPending are synchronous account-scoped adapters.
   * Pending metadata is {version:1, revision, payload}, or null when clean.
   * Before initialising, the host may recover pending.payload into empty local
   * storage. bound=true means this account's local copy has no untracked edits.
   * The host calls changed() after local edits, sync() on reconnect, refresh()
   * on focus, and stop() before changing accounts. Operation promises resolve
   * to status snapshots; transport failures keep local progress and metadata.
   */
  function create({client, readLocal, applyRemote, persistPending = () => {}, onStatus = () => {}, onConflict = () => {}, debounceMs = 600}) {
    if (!client || typeof readLocal !== 'function' || typeof applyRemote !== 'function') throw new TypeError('Sync requires a client and local progress callbacks');
    let revision = null, dirty = false, initialized = false, started = false, stopped = false, applying = false;
    let state = 'idle', conflict = null, error = null, generation = 0, timer = null, bound = false;
    let queue = Promise.resolve();

    const local = () => payload(readLocal());
    const snapshot = () => ({state, revision, dirty, ...(error ? {error} : {})});
    function publish(next, message = null) {
      if (stopped && next !== 'stopped') return;
      state = next;
      error = message;
      onStatus(snapshot());
    }
    function remember() {
      if (stopped) return;
      // This callback must save synchronously, under the current account's key.
      persistPending(dirty ? {version: 1, revision, payload: local()} : null);
    }
    function markDirty() {
      dirty = true;
      remember();
    }
    function cancelTimer() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    }
    function failed() {
      if (stopped) return snapshot();
      // Never surface server error details, tokens, or payloads in status text.
      publish(conflict ? 'conflict' : 'offline', 'Progress remains on this device. Reconnect and try again.');
      return snapshot();
    }
    function enqueue(operation) {
      cancelTimer();
      const next = queue.then(async () => {
        if (stopped) return snapshot();
        try { await operation(); } catch (_) { failed(); }
        return snapshot();
      });
      queue = next.catch(() => {});
      return next;
    }
    async function fetchRemote() {
      const result = await client.from('tmua_sync_state').select('revision,payload,updated_at').eq('id', 'main').single();
      if (result.error && result.error.code !== 'PGRST116') throw new Error('Cloud unavailable');
      if (!result.data && (!result.error || result.error.code === 'PGRST116')) return {revision: 0, payload: emptyPayload(), updated_at: null};
      if (result.error) throw new Error('Cloud unavailable');
      const row = result.data;
      if (!Number.isSafeInteger(row.revision) || row.revision < 0) throw new Error('Invalid cloud revision');
      return {revision: row.revision, payload: payload(row.payload), updated_at: row.updated_at || null};
    }
    function announceConflict(kind, remote) {
      if (stopped) return;
      const current = local();
      dirty = true;
      conflict = {kind, local: current, remote: remote ? copy(remote.payload) : null, revision: remote?.revision ?? null,
        conflicts: remote ? mergePayloads(current, remote.payload).conflicts : []};
      remember();
      publish('conflict');
      onConflict(copy(conflict));
    }
    function apply(value) {
      applying = true;
      try {
        const result = applyRemote(copy(value));
        if (result && typeof result.then === 'function') throw new TypeError('applyRemote must be synchronous');
      } finally { applying = false; }
    }
    function acceptRemote(remote) {
      if (stopped) return;
      apply(remote.payload);
      revision = remote.revision;
      dirty = false;
      conflict = null;
      remember();
      publish('synced');
    }
    async function backup(value) {
      const result = await client.rpc('tmua_save_backup', {new_payload: copy(value)});
      if (result.error || !result.data) throw new Error('Backup failed');
    }
    async function drain() {
      while (!stopped && dirty && !conflict) {
        const outgoing = local(), sentGeneration = generation, expected = revision;
        if (!Number.isSafeInteger(expected) || expected < 0) throw new Error('Cloud revision unavailable');
        remember();
        publish('syncing');
        const result = await client.rpc('tmua_write_state', {expected_revision: expected, new_payload: outgoing});
        if (stopped) return;
        if (result.error) {
          if (result.error.code === '40001') {
            let remote = null;
            try { remote = await fetchRemote(); } catch (_) { /* Keep both states pending even if the second request fails. */ }
            if (stopped) return;
            if (remote && samePayload(local(), remote.payload)) {
              revision = remote.revision;
              dirty = false;
              remember();
              publish('synced');
            } else announceConflict('remote-changed', remote);
            return;
          }
          throw new Error('Cloud write failed');
        }
        const row = Array.isArray(result.data) ? result.data[0] : result.data;
        if (!row || !Number.isSafeInteger(row.revision) || row.revision <= expected
          || !validatePayload(row.payload) || !samePayload(row.payload, outgoing)) throw new Error('Invalid write acknowledgement');
        revision = row.revision;
        // A later local edit must survive the acknowledgement of this earlier write.
        dirty = generation !== sentGeneration || !samePayload(local(), outgoing);
        remember();
        publish(dirty ? 'pending' : 'synced');
      }
    }
    async function initialize() {
      publish('loading');
      const remote = await fetchRemote();
      if (stopped) return;
      const current = local();
      initialized = true;
      if (samePayload(current, remote.payload)) {
        revision = remote.revision;
        dirty = false;
        conflict = null;
        remember();
        publish('synced');
      } else if (dirty) {
        if (revision === remote.revision) await drain();
        else if (revision === null && !bound && isEmpty(remote.payload)) {
          revision = remote.revision;
          markDirty();
          await drain();
        }
        else announceConflict('remote-changed', remote);
      } else if (bound) {
        acceptRemote(remote);
      } else if (isEmpty(remote.payload)) {
        // An unclaimed device can import into an empty account. A bound clean
        // device above must also respect a deliberate cloud clear.
        revision = remote.revision;
        markDirty();
        await drain();
      } else if (isEmpty(current)) {
        acceptRemote(remote);
      } else announceConflict('unclaimed', remote);
    }
    async function refreshRemote() {
      if (!initialized) return initialize();
      const remote = await fetchRemote();
      if (stopped) return;
      if (conflict) { announceConflict(conflict.kind, remote); return; }
      if (remote.revision === revision) {
        if (dirty) await drain();
        else publish('synced');
      } else if (samePayload(local(), remote.payload)) {
        revision = remote.revision;
        dirty = false;
        remember();
        publish('synced');
      } else if (dirty) announceConflict('remote-changed', remote);
      else acceptRemote(remote);
    }

    const controller = {
      initialise(options = {}) {
        if (!started) {
          started = true;
          bound = options.bound === true;
          const pending = options.pending;
          if (pending) {
            dirty = true;
            revision = Number.isSafeInteger(pending.revision) && pending.revision >= 0 ? pending.revision : null;
          }
        }
        return enqueue(async () => {
          if (!initialized) await initialize();
          else if (dirty && !conflict) await drain();
          else await refreshRemote();
        });
      },
      changed() {
        if (stopped || applying) return snapshot();
        generation += 1;
        try {
          markDirty();
          if (conflict) {
            conflict.local = local();
            conflict.conflicts = conflict.remote ? mergePayloads(conflict.local, conflict.remote).conflicts : [];
            publish('conflict');
            onConflict(copy(conflict));
          } else {
            publish('pending');
            cancelTimer();
            timer = setTimeout(() => { timer = null; controller.sync(); }, Math.max(0, debounceMs));
          }
        } catch (_) { failed(); }
        return snapshot();
      },
      sync() {
        return enqueue(async () => {
          if (!initialized) await initialize();
          else if (dirty && !conflict) await drain();
          else if (!conflict) await refreshRemote();
        });
      },
      refresh() { return enqueue(refreshRemote); },
      useRemote() {
        return enqueue(async () => {
          const remote = await fetchRemote();
          if (stopped) return;
          const current = local(), beforeBackup = generation;
          publish('syncing');
          await backup(current);
          if (stopped) return;
          if (generation !== beforeBackup || !samePayload(local(), current)) {
            announceConflict('local-changed', remote);
            return;
          }
          initialized = true;
          acceptRemote(remote);
        });
      },
      useLocal() {
        return enqueue(async () => {
          const remote = await fetchRemote();
          if (stopped) return;
          publish('syncing');
          await backup(remote.payload);
          if (stopped) return;
          initialized = true;
          revision = remote.revision;
          conflict = null;
          markDirty();
          await drain();
        });
      },
      merge() {
        return enqueue(async () => {
          const remote = await fetchRemote();
          if (stopped) return;
          const current = local();
          let merged = mergePayloads(current, remote.payload);
          if (merged.conflicts.length) { announceConflict('records-conflict', remote); return; }
          publish('syncing');
          await backup(remote.payload);
          if (stopped) return;
          await backup(current);
          if (stopped) return;
          // Include edits made while backups were being saved, without changing scores.
          merged = mergePayloads(local(), remote.payload);
          if (merged.conflicts.length) { announceConflict('records-conflict', remote); return; }
          apply(merged.payload);
          initialized = true;
          revision = remote.revision;
          conflict = null;
          markDirty();
          await drain();
        });
      },
      stop() {
        if (stopped) return;
        cancelTimer();
        stopped = true;
        publish('stopped');
      },
      get status() { return snapshot(); },
      get revision() { return revision; },
      get dirty() { return dirty; },
      get conflict() { return conflict ? copy(conflict) : null; }
    };
    return controller;
  }

  window.TmuaSync = Object.freeze({create, emptyPayload, validatePayload, samePayload, mergePayloads});
})();
