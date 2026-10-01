(() => {
  'use strict';
  const cfg = window.TMUA_CLOUD_CONFIG;
  if (!cfg?.enabled) return;
  const root = document.querySelector('.site-header');
  const ui = document.createElement('div');
  ui.id = 'cloud-account';
  ui.innerHTML = `<div class="cloud-bar"><span id="cloud-identity"></span><span id="cloud-status" role="status">Connecting your progress…</span><div class="cloud-actions"><button type="button" id="cloud-retry" hidden>Sync now</button><button type="button" id="cloud-files-toggle" hidden>Manage PDFs</button><button type="button" id="cloud-signout" hidden>Sign out</button></div></div>
  <section class="cloud-card" id="cloud-login" aria-labelledby="cloud-login-title" hidden><h2 id="cloud-login-title">Your practice, wherever you are.</h2><p>Sign in to continue with your scores and saved place.</p><form id="cloud-login-form"><label for="cloud-email">Email</label><input id="cloud-email" type="email" autocomplete="username" required><label for="cloud-password">Password</label><input id="cloud-password" type="password" autocomplete="current-password" required><button type="submit" class="cloud-primary" id="cloud-login-submit">Sign in</button></form><p id="cloud-login-message" role="status"></p></section>
  <div class="cloud-modal" id="cloud-conflict" hidden><section class="cloud-card" role="dialog" aria-modal="true" aria-labelledby="cloud-conflict-title"><h2 id="cloud-conflict-title">Progress is saved in two places.</h2><p id="cloud-conflict-description"></p><p class="cloud-notice">We’ll keep a private backup before changing either copy. Your first-attempt marks will not be combined or raised.</p><div class="cloud-actions"><button id="cloud-merge" type="button">Combine separate attempts</button><button id="cloud-use-remote" type="button">Continue from the other device</button><button id="cloud-use-local" type="button">Continue from this device</button></div><p id="cloud-conflict-message" role="status"></p></section></div>
  <section class="cloud-files-area" id="cloud-files-area" hidden></section>`;
  root.after(ui);
  const $ = id => document.getElementById(id);
  const clone = value => JSON.parse(JSON.stringify(value));
  const base = new URL('.', location.href).pathname;
  const keys = {library:`tmua-practice-library-v1:${base}`,history:`tmua-attempt-history-v1:${base}`,roadmap:`tmua-paired-roadmap-v1:${base}`};
  const empty = () => window.TmuaSync.emptyPayload();
  const readJSON = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch (_) { return fallback; } };
  let snapshot, controller, user, role, files, managerView, attachedId, generation = 0, applying = false, pendingKey, cacheKey, lastStatus;
  let cachedPending = null, bound = false, pendingPersistent = true, hasLock = false, lockPending = false, started = false, pageHidden = false;
  window.TmuaCloud = {blocked:true,role:null};
  function block(value) {
    window.TmuaCloud.blocked = value;
    document.body.classList.toggle('cloud-blocked',value);
    const main = $('main');
    if (main) main.inert = value;
  }
  block(true);
  document.dispatchEvent(new CustomEvent('tmua-cloud-lock'));
  function problem(text) { $('cloud-status').textContent=text; $('cloud-login-message').textContent=text; }
  let url;
  try {
    url = new URL(cfg.url);
    if (url.protocol!=='https:' || !/^[a-z0-9]+\.supabase\.co$/.test(url.hostname) || url.pathname!=='/' || url.search || url.hash || url.username || url.password) throw new Error();
    if (typeof cfg.publishableKey!=='string' || !/^sb_publishable_[a-zA-Z0-9_-]+$/.test(cfg.publishableKey)) throw new Error();
    if (!window.supabase?.createClient || !window.TmuaSync || !window.TmuaFiles) throw new Error();
  } catch (_) { problem('Your progress is not connected yet. Your existing browser progress is still saved.'); return; }
  const client = window.supabase.createClient(url.origin,cfg.publishableKey,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:false}});
  // These historic keys are view buffers only. Never treat them as belonging
  // to whoever signs in next. Preserve old device data before replacing them.
  function preserveLegacyDevice() {
    const archiveKey=`tmua-legacy-device-v1:${url.hostname}:${base}`;
    if(localStorage.getItem(archiveKey)!==null)return;
    const raw=Object.fromEntries(Object.values(keys).map(key=>[key,localStorage.getItem(key)]));
    localStorage.setItem(archiveKey,JSON.stringify({version:1,savedAt:new Date().toISOString(),values:raw}));
  }
  function saveAccountCache() {
    if(!cacheKey || !snapshot)return;
    try {localStorage.setItem(cacheKey,JSON.stringify(snapshot));}catch(_) {}
  }
  snapshot=empty();
  function savePending(value) {
    cachedPending=value;
    if (!pendingKey) return;
    try { if(value) localStorage.setItem(pendingKey,JSON.stringify(value));else localStorage.removeItem(pendingKey); pendingPersistent=true; }
    catch (_) {pendingPersistent=false;}
  }
  function applyRemote(payload) {
    if (!window.TmuaSync.validatePayload(payload)) throw new Error('Invalid progress');
    applying=true;
    try {
      snapshot=clone(payload);
      saveAccountCache();
      const persistence={};
      for (const kind of Object.keys(keys)) {try {localStorage.setItem(keys[kind],JSON.stringify(snapshot[kind]));persistence[kind]=true;}catch(_) {persistence[kind]=false;}}
      document.dispatchEvent(new CustomEvent('tmua-cloud-applied',{detail:{payload:clone(snapshot),persistence}}));
    } finally {applying=false;}
  }
  function notes(text) {
    ['storage-note','history-storage-note'].forEach(id=>{if($(id))$(id).textContent=text;});
    document.querySelectorAll('.roadmap-storage').forEach(el=>{el.textContent=text;});
    const frame=$('paper-frame');
    frame?.contentWindow?.postMessage({type:'tmua-storage-status',message:text},'*');
  }
  function onStatus(status) {
    lastStatus=status;
    const labels={loading:'Loading your saved progress…',synced:'Saved across your devices',pending:'Changes waiting to sync…',syncing:'Saving your progress…',offline:'Not synced yet. Your changes are kept on this device.',conflict:'Choose which saved progress to continue.',stopped:'Signed out'};
    const text=status.dirty && !pendingPersistent ? 'Not synced yet. Keep this tab open until your progress is saved.' : labels[status.state] || 'Connecting…';
    $('cloud-status').textContent=text;
    $('cloud-retry').hidden=!['offline','pending'].includes(status.state);
    if (status.state==='synced') {
      bound=true;

      $('cloud-conflict').hidden=true;
      const wasBlocked=window.TmuaCloud.blocked;
      block(false);
      if(wasBlocked)document.dispatchEvent(new CustomEvent('tmua-cloud-unlock'));
    }
    if(status.state==='conflict')block(true);
    notes(text);
  }
  function showConflict(conflict) {
    $('cloud-conflict').hidden=false;
    $('cloud-conflict-description').textContent=conflict.kind==='unclaimed'
      ? 'This browser has earlier practice that has not been linked to your account. Your account also has saved progress.'
      : 'Another device has saved new progress while this one had changes waiting. Choose the copy you want to continue.';
    const merge=conflict.remote ? window.TmuaSync.mergePayloads(conflict.local,conflict.remote) : {conflicts:[true]};
    $('cloud-merge').hidden=merge.conflicts.length>0;
    $('cloud-conflict-message').textContent=merge.conflicts.length ? 'Some of the same exercises differ. Both copies will be preserved in private backups.' : 'Separate papers and attempts can be brought together.';
    $('cloud-use-remote').focus();
  }
  function clearConnection() {
    generation++;
    window.TmuaPrivate?.disconnect();
    controller?.stop();controller=null;
    files?.destroy();files=null;
    managerView?.destroy();managerView=null;
    window.TmuaCloud.role=null;
    if($('course-tab-student'))$('course-tab-student').hidden=true;
    if($('student-progress-section'))$('student-progress-section').hidden=true;
    window.TmuaConcepts?.route();
    user=null;role=null;attachedId=null;cachedPending=null;pendingKey=null;cacheKey=null;
    $('cloud-identity').textContent='';
    applyRemote(empty());
    $('cloud-files-area').replaceChildren();$('cloud-files-area').hidden=true;
    $('cloud-files-toggle').hidden=true;$('cloud-signout').hidden=true;
    $('cloud-conflict').hidden=true;
    block(true);
    document.dispatchEvent(new CustomEvent('tmua-cloud-lock'));
  }
  async function attach(session) {
    if(pageHidden || !hasLock)return;
    if (!session?.user) {clearConnection();$('cloud-login').hidden=false;problem('Sign in to sync your progress.');return;}
    if (attachedId===session.user.id) return;
    clearConnection();
    const current=++generation;
    user=session.user;
    $('cloud-login').hidden=true;
    problem('Checking your account…');
    const result=await client.from('tmua_members').select('role').eq('user_id',user.id).maybeSingle();
    if(current!==generation)return;
    if(result.error || !['student','manager'].includes(result.data?.role)) {
      $('cloud-signout').hidden=false;
      problem(result.error?'Your saved progress could not be reached. Try signing out and back in.':'This account has not been added to this practice library yet.');
      return;
    }
    role=result.data.role;attachedId=user.id;
    $('cloud-identity').textContent=user.email || (role==='manager'?'Your manager account':'Your student account');
    pendingKey=`tmua-cloud-pending-v2:${url.hostname}:${user.id}`;
    cacheKey=`tmua-cloud-cache-v2:${url.hostname}:${user.id}`;
    let cached;
    try {
      cachedPending=JSON.parse(localStorage.getItem(pendingKey)||'null');
      cached=JSON.parse(localStorage.getItem(cacheKey)||'null');
    }catch(_){problem('This account’s saved copy needs checking. It has not been changed.');return;}
    bound=true;
    if(cached!==null && !window.TmuaSync.validatePayload(cached)) {
      problem('This account’s saved copy needs checking. It has not been changed.');return;
    }
    if(cachedPending!==null && (!cachedPending?.payload || !window.TmuaSync.validatePayload(cachedPending.payload))) {
      problem('This account’s pending changes need checking. They have not been changed.');return;
    }
    snapshot=cached || empty();
    if(cachedPending?.payload) {
      // Both copies belong to this account. Preserve divergence before recovery.
      if(cached && !window.TmuaSync.samePayload(cached,cachedPending.payload) && !window.TmuaSync.samePayload(cached,empty())) {
        const recovery=await client.rpc('tmua_save_backup_v2',{new_payload:cached});
        if(current!==generation)return;
        if(recovery.error){problem('Two saved copies were found for this account. Reconnect to preserve a backup before continuing.');return;}
      }
      snapshot=clone(cachedPending.payload);
    }
    applyRemote(snapshot);
    controller=window.TmuaSync.create({client,userId:user.id,readLocal:()=>clone(snapshot),applyRemote,persistPending:savePending,onStatus,onConflict:showConflict});
    $('cloud-signout').hidden=false;
    $('cloud-files-toggle').hidden=role!=='manager';
    await controller.initialise({pending:cachedPending,bound});
    if(current!==generation)return;
    await window.TmuaPrivate?.connect(client,user.id);
    if(current!==generation)return;
    if(role==='manager') {
      files=window.TmuaFiles.mount($('cloud-files-area'),{client,userId:user.id,onStatus:()=>{}});
      if(window.TmuaManager && $('student-progress-section')) {
        managerView=window.TmuaManager.mount($('student-progress-section'),{client});
        window.TmuaCloud.role=role;
        $('course-tab-student').hidden=false;
        window.TmuaConcepts?.route();
        refreshStudentView();
      }
    }
  }
  function refreshStudentView() {
    if(role==='manager' && !window.TmuaCloud.blocked && location.hash==='#student-progress' && document.visibilityState!=='hidden')managerView?.refresh();
  }
  window.addEventListener('hashchange',refreshStudentView);
  document.addEventListener('tmua-cloud-unlock',refreshStudentView);
  document.addEventListener('tmua-local-updated',event=>{
    if(pageHidden || !hasLock || applying || !['library','roadmap'].includes(event.detail?.kind))return;
    if(!controller || !attachedId || window.TmuaCloud.blocked)return;
    snapshot[event.detail.kind]=clone(event.detail.value);
    saveAccountCache();
    controller?.changed();
  });
  document.addEventListener('tmua-history-updated',event=>{
    if(pageHidden || !hasLock || applying || !Array.isArray(event.detail?.attempts))return;
    if(!controller || !attachedId || window.TmuaCloud.blocked)return;
    snapshot.history={version:1,attempts:clone(event.detail.attempts)};
    saveAccountCache();
    controller?.changed();
    if(lastStatus)notes($('cloud-status').textContent);
  });
  $('paper-frame')?.addEventListener('load',()=>{if(lastStatus)notes($('cloud-status').textContent);});
  $('cloud-login-form').addEventListener('submit',async event=>{
    event.preventDefault();$('cloud-login-submit').disabled=true;$('cloud-login-message').textContent='Signing in…';
    try {
      const {data,error}=await client.auth.signInWithPassword({email:$('cloud-email').value.trim(),password:$('cloud-password').value});
      $('cloud-password').value='';
      if(error){$('cloud-login-message').textContent='Sign-in failed. Check your email and password, then try again.';return;}
      await attach(data.session);
    } catch (_) {$('cloud-login-message').textContent='Could not connect. Please try again.';}
    finally {$('cloud-login-submit').disabled=false;}
  });
  $('cloud-signout').addEventListener('click',async()=>{
    $('cloud-signout').disabled=true;
    try {
      block(true);
      controller?.stop();
      document.dispatchEvent(new CustomEvent('tmua-cloud-lock'));
      const {error}=await client.auth.signOut({scope:'local'});
      if(error){problem('Could not sign out. Please try again.');return;}
      clearConnection();$('cloud-login').hidden=false;problem('Signed out. Any unsynced changes are kept on this device for your next sign-in.');
    }finally{$('cloud-signout').disabled=false;}
  });
  $('cloud-files-toggle').addEventListener('click',()=>{$('cloud-files-area').hidden=!$('cloud-files-area').hidden;if(!$('cloud-files-area').hidden)$('cloud-files-area').scrollIntoView({behavior:'smooth',block:'start'});});
  $('cloud-retry').addEventListener('click',()=>hasLock ? controller?.sync() : acquireTab());
  for (const [id,method] of [['cloud-use-remote','useRemote'],['cloud-use-local','useLocal'],['cloud-merge','merge']]) {
    $(id).addEventListener('click',async()=>{
      const buttons=$('cloud-conflict').querySelectorAll('button');buttons.forEach(b=>b.disabled=true);
      $('cloud-conflict-message').textContent='Saving a backup and connecting your progress…';
      try {await controller?.[method](); if(controller?.status?.state==='conflict')$('cloud-conflict-message').textContent='The other device changed again. Please choose once more.';}
      catch(_) {$('cloud-conflict-message').textContent='Could not save the backup. Both copies are unchanged. Try again.';}
      finally {buttons.forEach(b=>b.disabled=false);}
    });
  }
  window.addEventListener('online',()=>controller?.sync());
  window.addEventListener('focus',()=>{controller?.refresh();refreshStudentView();});
  window.addEventListener('beforeunload',event=>{if(controller?.dirty){event.preventDefault();event.returnValue='';}});
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'){controller?.refresh();refreshStudentView();}});
  window.addEventListener('pagehide',()=>{
    // A cached document must stop editing before its Web Lock is released.
    // clearConnection stops callbacks and leaves account-scoped pending work saved.
    pageHidden=true;
    clearConnection();
    hasLock=false;
  });
  window.addEventListener('pageshow',event=>{
    // Rebuild from saved progress and acquire a fresh lock after BFCache restore.
    if(event.persisted)location.reload();
  });
  function start() {
    if(started)return;
    try {preserveLegacyDevice();}catch(_){problem('The earlier browser records could not be backed up. Free some browser storage and reconnect; they have not been changed.');return;}
    started=true;
    client.auth.onAuthStateChange((event,session)=>{
      // Stop the former owner's callbacks before the SDK starts using a new JWT.
      if(event==='SIGNED_OUT' || (user && session?.user?.id!==user.id))clearConnection();
      setTimeout(()=>attach(session),0);
    });
    client.auth.getSession().then(({data,error})=>{if(error)problem('Could not restore your sign-in. Please sign in again.');return attach(data?.session);}).catch(()=>{clearConnection();$('cloud-login').hidden=false;problem('Could not connect. Sign in again when you are online.');});
  }
  async function acquireTab() {
    if(pageHidden || lockPending || hasLock)return;
    if(!navigator.locks?.request){problem('Use an up-to-date browser to connect your progress safely. Your saved work is unchanged.');return;}
    lockPending=true;
    try {await navigator.locks.request(`tmua-practice-active:${url.hostname}`,{ifAvailable:true},async lock=>{
      if(pageHidden)return;
      if(!lock){block(true);problem('Practice is already open in another tab. Close that tab, then choose Connect here.');$('cloud-retry').textContent='Connect here';$('cloud-retry').hidden=false;return;}
      hasLock=true;$('cloud-retry').textContent='Sync now';$('cloud-retry').hidden=true;
      start();
      // The browser releases this lock when the tab closes; other devices still use database revisions.
      await new Promise(resolve=>window.addEventListener('pagehide',resolve,{once:true}));
      hasLock=false;
    });}finally{lockPending=false;}
  }
  acquireTab();
})();
