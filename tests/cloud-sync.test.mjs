import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../assets/cloud-sync.js', import.meta.url), 'utf8');
const window = {};
vm.runInNewContext(source, {window, setTimeout, clearTimeout});
const sync = window.TmuaSync;
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const student = '10000000-0000-4000-8000-000000000001';
const empty = () => clone(sync.emptyPayload());
const attempt = (id, firstCorrect = 7) => ({id, paperId: 'sample', title: 'Sample', paper: 1, total: 20,
  firstCorrect, afterCorrect: null, completedAt: '2026-09-01T12:00:00Z', source: 'guided', attemptContext: 'first'});
const progress = (...attempts) => ({...empty(), history: {version: 1, attempts}});
const deferred = () => {
  let resolve;
  const promise = new Promise(accept => { resolve = accept; });
  return {promise, resolve};
};

function backend(initial = empty(), revision = 0) {
  const store = {row: {user_id: student, revision, payload: clone(initial), updated_at: '2026-09-01T00:00:00Z'},
    calls: [], backups: [], failWrites: 0, failReads: 0, failBackups: 0, beforeWrite: null, beforeRead: null, beforeBackup: null,
    concurrent: 0, maxConcurrent: 0};
  // The session determines ownership; no caller-supplied owner is accepted.
  const session = {user: {id: student}};
  const client = {
    async rpc(name, args) {
      assert.ok(['tmua_read_state_v2', 'tmua_write_state_v2', 'tmua_save_backup_v2'].includes(name), `Unexpected RPC ${name}`);
      store.calls.push({type: name, args: clone(args)});
      if (name === 'tmua_read_state_v2') {
        assert.deepEqual(args ?? {}, {});
        if (store.beforeRead) await store.beforeRead();
        if (store.failReads-- > 0) return {data: null, error: {message: 'SECRET SERVER DETAILS'}};
        return {data: store.row ? {user_id: session.user.id, ...clone(store.row)} : null, error: null};
      }
      if (name === 'tmua_save_backup_v2') {
        assert.deepEqual(Object.keys(args), ['new_payload']);
        if (store.beforeBackup) await store.beforeBackup();
        if (store.failBackups-- > 0) return {data: null, error: {message: 'SECRET BACKUP DETAILS'}};
        store.backups.push(clone(args.new_payload));
        return {data: `backup-${store.backups.length}`, error: null};
      }
      assert.deepEqual(Object.keys(args).sort(), ['expected_revision', 'new_payload']);
      store.concurrent += 1;
      store.maxConcurrent = Math.max(store.maxConcurrent, store.concurrent);
      try {
        if (store.beforeWrite) await store.beforeWrite();
        if (store.failWrites-- > 0) return {data: null, error: {message: 'SECRET WRITE DETAILS'}};
        if ((store.row?.revision ?? 0) !== args.expected_revision) return {data: null, error: {code: '40001'}};
        store.row = {user_id: session.user.id, revision: args.expected_revision + 1, payload: clone(args.new_payload), updated_at: '2026-09-02T00:00:00Z'};
        return {data: clone(store.row), error: null};
      } finally { store.concurrent -= 1; }
    }
  };
  return Object.assign(store, {client});
}

function device(t, server, initial = empty(), options = {}) {
  const local = {value: clone(initial), pending: null, statuses: [], conflicts: [], applied: [], pendingCalls: []};
  const controller = sync.create({client: server.client, userId: student, readLocal: () => local.value,
    applyRemote(value) { local.applied.push(clone(value)); local.value = clone(value); },
    persistPending(value) { local.pending = clone(value); local.pendingCalls.push(clone(value)); },
    onStatus(value) { local.statuses.push(clone(value)); },
    onConflict(value) { local.conflicts.push(clone(value)); }, debounceMs: 60_000, ...options});
  t.after(() => controller.stop());
  return Object.assign(local, {controller, edit(value) { local.value = clone(value); controller.changed(); }});
}

test('payload helpers validate shape and compare object key order without changing scores', () => {
  assert.equal(sync.validatePayload(empty()), true);
  assert.equal(sync.validatePayload({version: 2}), false);
  assert.equal(sync.validatePayload(progress(attempt('same'), attempt('same'))), false);
  assert.equal(sync.samePayload({a: 1, b: {x: 2, y: 3}}, {b: {y: 3, x: 2}, a: 1}), true);
  const result = clone(sync.mergePayloads(progress(attempt('same', 4)), progress(attempt('same', 15))));
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0].local.firstCorrect, 4);
  assert.equal(result.conflicts[0].remote.firstCorrect, 15);
});

test('explicit unbound import supports existing local progress for controller callers', async t => {
  const server = backend(), current = progress(attempt('local', 0)), app = device(t, server, current);
  await app.controller.initialise();
  assert.deepEqual(server.row.payload, current);
  assert.equal(server.row.revision, 1);
  assert.equal(app.controller.status.state, 'synced');
  assert.equal(app.applied.length, 0);
  assert.equal(app.pending, null);
});

test('a clean new browser downloads cloud data and a bound device respects a cloud clear', async t => {
  const saved = progress(attempt('cloud')), server = backend(saved, 7), app = device(t, server);
  await app.controller.initialise();
  assert.deepEqual(app.value, saved);
  assert.equal(app.controller.revision, 7);
  server.row = {revision: 8, payload: empty()};
  await app.controller.refresh();
  assert.deepEqual(app.value, empty());
  const bound = device(t, server, saved);
  await bound.controller.initialise({bound: true});
  assert.deepEqual(bound.value, empty());
  assert.equal(server.row.revision, 8);
});

test('unclaimed divergent local data is preserved until an explicit decision', async t => {
  const remote = progress(attempt('remote')), original = progress(attempt('local'));
  const server = backend(remote, 4), app = device(t, server, original);
  await app.controller.initialise();
  assert.equal(app.controller.status.state, 'conflict');
  assert.equal(app.controller.conflict.kind, 'unclaimed');
  assert.deepEqual(app.value, original);
  assert.deepEqual(server.row.payload, remote);
  assert.deepEqual(app.pending.payload, original);
  assert.equal(server.calls.filter(call => call.type === 'tmua_write_state_v2').length, 0);
});

test('two clients cannot overwrite each other with a stale revision', async t => {
  const server = backend(), first = device(t, server), second = device(t, server);
  await Promise.all([first.controller.initialise(), second.controller.initialise()]);
  first.edit(progress(attempt('first', 4)));
  await first.controller.sync();
  second.edit(progress(attempt('second', 19)));
  await second.controller.sync();
  assert.deepEqual(server.row.payload, first.value);
  assert.equal(second.value.history.attempts[0].id, 'second');
  assert.equal(second.controller.status.state, 'conflict');
  assert.equal(second.controller.revision, 0);
  assert.equal(second.controller.conflict.revision, 1);
  assert.equal(second.pending.revision, 0);
});

test('transient failure keeps pending data and a reconnect sync retries safely', async t => {
  const server = backend(), app = device(t, server);
  await app.controller.initialise();
  app.edit(progress(attempt('unsent', 3)));
  server.failWrites = 1;
  await app.controller.sync();
  assert.equal(app.controller.status.state, 'offline');
  assert.doesNotMatch(JSON.stringify(app.statuses), /SECRET/);
  assert.deepEqual(app.pending.payload, app.value);
  assert.equal(server.row.revision, 0);
  await app.controller.sync(); // Root invokes this on the online event.
  assert.deepEqual(server.row.payload, app.value);
  assert.equal(app.pending, null);
  assert.equal(app.controller.status.state, 'synced');
});

test('edits during a write are sent next and writes remain serial', async t => {
  const server = backend(), app = device(t, server), entered = deferred(), release = deferred();
  await app.controller.initialise();
  let held = false;
  server.beforeWrite = async () => { if (!held) { held = true; entered.resolve(); await release.promise; } };
  app.edit(progress(attempt('first')));
  const running = app.controller.sync();
  await entered.promise;
  app.edit(progress(attempt('first'), attempt('second')));
  const queued = app.controller.sync();
  release.resolve();
  await Promise.all([running, queued]);
  assert.equal(server.row.revision, 2);
  assert.equal(server.maxConcurrent, 1);
  assert.deepEqual(server.row.payload, app.value);
  assert.equal(server.row.payload.history.attempts.length, 2);
  assert.equal(app.pending, null);
  assert.equal(app.pendingCalls.filter(value => value?.revision === 1).at(-1).payload.history.attempts.length, 2);
});

test('debouncing saves the latest of rapid edits in one write', async t => {
  const server = backend(), saved = deferred(), app = device(t, server, empty(), {debounceMs: 5,
    onStatus(value) { if (value.state === 'synced' && value.revision === 1) saved.resolve(); }});
  await app.controller.initialise();
  app.edit(progress(attempt('first')));
  app.edit(progress(attempt('first'), attempt('second')));
  await saved.promise;
  assert.equal(server.row.revision, 1);
  assert.equal(server.row.payload.history.attempts.length, 2);
});

test('restored pending data is uploaded only against its saved baseline', async t => {
  const original = progress(attempt('remote')), pending = progress(attempt('pending'));
  const server = backend(original, 2), valid = device(t, server, pending);
  await valid.controller.initialise({bound: true, pending: {version: 1, revision: 2, payload: pending}});
  assert.deepEqual(server.row.payload, pending);
  const stale = device(t, server, original);
  await stale.controller.initialise({bound: true, pending: {version: 1, revision: 2, payload: original}});
  assert.equal(stale.controller.status.state, 'conflict');
  assert.deepEqual(stale.value, original);
  server.row = {revision: 4, payload: empty()};
  const cleared = device(t, server, original);
  await cleared.controller.initialise({bound: true, pending: {version: 1, revision: 2, payload: original}});
  assert.equal(cleared.controller.status.state, 'conflict');
  assert.deepEqual(server.row.payload, empty());
});

test('focus refresh stops if the remote revision changed while local data is dirty', async t => {
  const server = backend(), app = device(t, server);
  await app.controller.initialise();
  app.edit(progress(attempt('local')));
  server.row = {revision: 1, payload: progress(attempt('remote'))};
  await app.controller.refresh();
  assert.equal(app.controller.status.state, 'conflict');
  assert.equal(app.applied.length, 0);
  assert.equal(app.value.history.attempts[0].id, 'local');
});

test('a local edit arriving during a clean remote fetch is not overwritten', async t => {
  const server = backend(), app = device(t, server), entered = deferred(), release = deferred();
  await app.controller.initialise();
  server.row = {revision: 1, payload: progress(attempt('remote'))};
  server.beforeRead = async () => { entered.resolve(); await release.promise; };
  const refreshing = app.controller.refresh();
  await entered.promise;
  app.edit(progress(attempt('local')));
  release.resolve();
  await refreshing;
  assert.equal(app.controller.status.state, 'conflict');
  assert.equal(app.value.history.attempts[0].id, 'local');
});

test('useRemote requires a durable backup and leaves local intact when backup fails', async t => {
  const original = progress(attempt('local')), remote = progress(attempt('remote'));
  const server = backend(remote, 1), app = device(t, server, original);
  await app.controller.initialise();
  server.failBackups = 1;
  await app.controller.useRemote();
  assert.deepEqual(app.value, original);
  assert.equal(app.applied.length, 0);
  await app.controller.useRemote();
  assert.deepEqual(server.backups, [original]);
  assert.deepEqual(app.value, remote);
  assert.equal(app.pending, null);
  assert.equal(app.controller.status.state, 'synced');
});

test('useRemote refuses to discard an edit made while the backup was in flight', async t => {
  const server = backend(progress(attempt('remote')), 1), app = device(t, server, progress(attempt('local')));
  await app.controller.initialise();
  const entered = deferred(), release = deferred();
  server.beforeBackup = async () => { entered.resolve(); await release.promise; };
  const choosing = app.controller.useRemote();
  await entered.promise;
  app.edit(progress(attempt('local'), attempt('new')));
  release.resolve();
  await choosing;
  assert.equal(app.value.history.attempts.length, 2);
  assert.equal(app.controller.conflict.kind, 'local-changed');
  assert.equal(app.applied.length, 0);
});

test('useLocal backs up remote and still uses CAS if another client writes during backup', async t => {
  const remote = progress(attempt('remote')), original = progress(attempt('local'));
  const server = backend(remote, 1), app = device(t, server, original), entered = deferred(), release = deferred();
  await app.controller.initialise();
  server.beforeBackup = async () => { entered.resolve(); await release.promise; };
  const choosing = app.controller.useLocal();
  await entered.promise;
  server.row = {revision: 2, payload: progress(attempt('newer-remote'))};
  release.resolve();
  await choosing;
  assert.deepEqual(server.backups, [remote]);
  assert.equal(server.row.payload.history.attempts[0].id, 'newer-remote');
  assert.deepEqual(app.value, original);
  assert.equal(app.controller.status.state, 'conflict');
  server.beforeBackup = null;
  await app.controller.useLocal();
  assert.equal(server.backups[1].history.attempts[0].id, 'newer-remote');
  assert.deepEqual(server.row.payload, original);
  assert.equal(app.pending, null);
});

test('explicit import merges distinct attempt IDs, library entries and roadmap pairs', async t => {
  const original = progress(attempt('local', 2)), remote = progress(attempt('remote', 19));
  original.library.local = {state: {firstCorrect: 2}};
  remote.library.remote = {state: {firstCorrect: 19}};
  original.roadmap.pairs.local = {reviewed: false};
  remote.roadmap.pairs.remote = {reviewed: true};
  const server = backend(remote, 3), app = device(t, server, original);
  await app.controller.initialise();
  await app.controller.merge();
  assert.deepEqual(server.backups, [remote, original]);
  assert.deepEqual(server.row.payload, app.value);
  assert.deepEqual(app.value.history.attempts.map(row => [row.id, row.firstCorrect]), [['remote', 19], ['local', 2]]);
  assert.deepEqual(Object.keys(app.value.library).sort(), ['local', 'remote']);
  assert.deepEqual(Object.keys(app.value.roadmap.pairs).sort(), ['local', 'remote']);
  assert.equal(app.controller.status.state, 'synced');
});

test('same-ID scores and overlapping library progress require a choice; higher scores never win automatically', async t => {
  const original = progress(attempt('same', 2)), remote = progress(attempt('same', 19));
  original.library.paper = {firstCorrect: 2};
  remote.library.paper = {firstCorrect: 19};
  const server = backend(remote, 3), app = device(t, server, original);
  await app.controller.initialise();
  await app.controller.merge();
  assert.equal(app.controller.conflict.kind, 'records-conflict');
  assert.equal(app.controller.conflict.conflicts.length, 2);
  assert.deepEqual(app.value, original);
  assert.deepEqual(server.row.payload, remote);
  assert.equal(server.backups.length, 0);
});

test('sign-out cancels queued saves and prevents an old fetch from applying to another account', async t => {
  const server = backend(progress(attempt('remote')), 1), app = device(t, server), entered = deferred(), release = deferred();
  server.beforeRead = async () => { entered.resolve(); await release.promise; };
  const initializing = app.controller.initialise();
  await entered.promise;
  app.controller.stop();
  const statusCount = app.statuses.length, pendingCount = app.pendingCalls.length;
  release.resolve();
  await initializing;
  assert.deepEqual(app.value, empty());
  assert.equal(app.applied.length, 0);
  assert.equal(app.statuses.length, statusCount);
  assert.equal(app.pendingCalls.length, pendingCount);
  assert.equal(app.controller.status.state, 'stopped');
  app.edit(progress(attempt('after-sign-out')));
  await app.controller.sync();
  assert.equal(server.calls.filter(call => call.type === 'tmua_write_state_v2').length, 0);
});

test('sign-out during a write retains recovery metadata and suppresses its late acknowledgement', async t => {
  const server = backend(), app = device(t, server), entered = deferred(), release = deferred();
  await app.controller.initialise();
  server.beforeWrite = async () => { entered.resolve(); await release.promise; };
  app.edit(progress(attempt('pending')));
  const writing = app.controller.sync();
  await entered.promise;
  app.controller.stop();
  const pendingCount = app.pendingCalls.length;
  release.resolve();
  await writing;
  // A request already accepted by the server cannot be recalled, but no local
  // state or account metadata is touched after stop().
  assert.equal(app.pendingCalls.length, pendingCount);
  assert.equal(app.pending.payload.history.attempts[0].id, 'pending');
  assert.equal(app.controller.status.state, 'stopped');
  assert.equal(app.controller.revision, 0);
});

test('invalid cloud payload and failed reads never replace valid local data', async t => {
  const original = progress(attempt('local')), server = backend({version: 9}, 1), app = device(t, server, original);
  await app.controller.initialise({bound: true});
  assert.equal(app.controller.status.state, 'offline');
  assert.deepEqual(app.value, original);
  assert.equal(app.applied.length, 0);
  server.row = {revision: 1, payload: progress(attempt('remote'))};
  server.failReads = 1;
  await app.controller.sync();
  assert.deepEqual(app.value, original);
  await app.controller.sync();
  assert.equal(app.value.history.attempts[0].id, 'remote');
});


test('account-bound initialization downloads the owner cloud state instead of importing an old device copy', async t => {
  const original = progress(attempt('old-shared')), server = backend(), app = device(t, server, original);
  await app.controller.initialise({bound: true});
  assert.deepEqual(app.value, empty());
  assert.deepEqual(server.row.payload, empty());
  assert.equal(server.row.revision, 0);
  assert.equal(server.calls.some(call => call.type === 'tmua_write_state_v2'), false);
});

test('a row for a different authenticated owner is rejected without touching local state', async t => {
  const original = progress(attempt('own-cached')), server = backend(progress(attempt('another-owner')), 2);
  server.row.user_id = '10000000-0000-4000-8000-000000000099';
  const app = device(t, server, original);
  await app.controller.initialise({bound: true});
  assert.equal(app.controller.status.state, 'offline');
  assert.deepEqual(app.value, original);
  assert.equal(app.applied.length, 0);
  assert.equal(server.calls.length, 1);
});
