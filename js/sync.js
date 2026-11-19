import { GOOGLE_CLIENT_ID } from './config.js';
import { buildSnapshot, mergeSnapshot, changedCount } from './backup.js';
import { CHANGE_EVENT } from './storage.js';

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const SCOPE = `${DRIVE_SCOPE} openid email`;
const FILE_NAME = 'tw-phenology-sync.json.gz';
const DRIVE = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const SIMPLE_UPLOAD_LIMIT = 4.5 * 1024 * 1024;
const AUTO_SYNC_DELAY = 3000;
const RESYNC_ON_FOCUS_AFTER = 60 * 1000;

const K = {
  token:   'tw-phenology:gtoken',
  account: 'tw-phenology:gaccount',
  last:    'tw-phenology:last-sync',
  dirty:   'tw-phenology:dirty',
};

function lsGet(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
}
function lsSet(key, value) {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch { /* storage unavailable: sync still works for this page load */ }
}

// ── gzip helpers ──────────────────────────────────────────────────────────────
async function gzip(text) {
  if (typeof CompressionStream === 'undefined') return { blob: new Blob([text]), type: 'application/json' };
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return { blob: await new Response(stream).blob(), type: 'application/gzip' };
}

async function gunzipToText(buf) {
  const bytes = new Uint8Array(buf);
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return new TextDecoder().decode(bytes);
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}

// ── Google sign-in ────────────────────────────────────────────────────────────
let gisPromise = null;
function loadGis() {
  if (globalThis.google?.accounts?.oauth2) return Promise.resolve();
  gisPromise ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => { gisPromise = null; reject(new Error('無法載入 Google 登入元件，請確認網路連線')); };
    document.head.appendChild(s);
  });
  return gisPromise;
}

export function initSync({ onMerged } = {}) {
  if (!GOOGLE_CLIENT_ID) return null;

  const listeners = new Set();
  const st = {
    state: 'signed-out',   // signed-out | need-auth | syncing | ok | error
    account: lsGet(K.account),
    lastSync: lsGet(K.last),
    dirty: !!lsGet(K.dirty),
    error: '',
  };
  let tokenClient = null;
  let pending = null;
  let running = null;
  let again = false;
  let applying = false;
  let timer = null;

  const emit = () => listeners.forEach(fn => fn({ ...st }));
  const set = patch => { Object.assign(st, patch); emit(); };

  function validToken() {
    const t = lsGet(K.token);
    return t && t.expires_at - 60_000 > Date.now() ? t.access_token : null;
  }

  function idleState() {
    if (!st.account) return 'signed-out';
    return validToken() ? 'ok' : 'need-auth';
  }

  loadGis().then(() => {
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: SCOPE,
      callback: resp => {
        const p = pending; pending = null;
        if (!p) return;
        if (resp.error) return p.reject(new Error(resp.error_description || resp.error));
        if (!google.accounts.oauth2.hasGrantedAllScopes(resp, DRIVE_SCOPE)) {
          return p.reject(new Error('需要允許存取「應用程式專屬資料夾」才能同步'));
        }
        lsSet(K.token, { access_token: resp.access_token, expires_at: Date.now() + resp.expires_in * 1000 });
        p.resolve(resp.access_token);
      },
      error_callback: err => {
        const p = pending; pending = null;
        const msg = err.type === 'popup_closed' ? '登入視窗已關閉'
          : err.type === 'popup_failed_to_open' ? '無法開啟 Google 登入視窗，請允許這個網站顯示彈出式視窗'
          : (err.message || err.type);
        p?.reject(new Error(msg));
      },
    });
  }).catch(err => set({ state: 'error', error: err.message }));

  // Must run synchronously inside a click handler, or the popup gets blocked
  function requestTokenInteractive() {
    if (!tokenClient) return Promise.reject(new Error('Google 登入元件尚未載入，請稍後再按一次'));
    return new Promise((resolve, reject) => {
      pending = { resolve, reject };
      tokenClient.requestAccessToken({
        prompt: st.account ? '' : 'consent',
        login_hint: st.account?.email || undefined,
      });
    });
  }

  async function api(url, opts = {}, token) {
    const res = await fetch(url, { ...opts, headers: { Authorization: `Bearer ${token}`, ...(opts.headers || {}) } });
    if (res.status === 401) {
      lsSet(K.token, null);
      const e = new Error('Google 登入已過期');
      e.auth = true;
      throw e;
    }
    if (!res.ok) throw new Error(`Google Drive 回應錯誤（${res.status}）`);
    return res;
  }

  async function fetchAccount(token) {
    const res = await api('https://www.googleapis.com/oauth2/v3/userinfo', {}, token);
    const u = await res.json();
    const account = { email: u.email || '', name: u.name || '' };
    lsSet(K.account, account);
    st.account = account;
  }

  async function findFile(token) {
    const q = encodeURIComponent(`name='${FILE_NAME}'`);
    const res = await api(`${DRIVE}/files?spaces=appDataFolder&q=${q}&fields=files(id,modifiedTime)&orderBy=modifiedTime desc`, {}, token);
    return (await res.json()).files?.[0] || null;
  }

  async function download(id, token) {
    const res = await api(`${DRIVE}/files/${id}?alt=media`, {}, token);
    return JSON.parse(await gunzipToText(await res.arrayBuffer()));
  }

  async function upload(id, data, token) {
    const { blob, type } = await gzip(JSON.stringify(data));
    const meta = id ? {} : { name: FILE_NAME, parents: ['appDataFolder'], mimeType: type };

    if (blob.size <= SIMPLE_UPLOAD_LIMIT) {
      if (id) {
        await api(`${UPLOAD}/files/${id}?uploadType=media`, { method: 'PATCH', headers: { 'Content-Type': type }, body: blob }, token);
      } else {
        const b = `tw${Date.now()}`;
        const body = new Blob([
          `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n`,
          `--${b}\r\nContent-Type: ${type}\r\n\r\n`, blob, `\r\n--${b}--`,
        ]);
        await api(`${UPLOAD}/files?uploadType=multipart`, { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${b}` }, body }, token);
      }
      return;
    }

    // Large memo: resumable upload
    const init = await api(id ? `${UPLOAD}/files/${id}?uploadType=resumable` : `${UPLOAD}/files?uploadType=resumable`, {
      method: id ? 'PATCH' : 'POST',
      headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': type },
      body: JSON.stringify(meta),
    }, token);
    const location = init.headers.get('Location');
    if (!location) throw new Error('無法取得上傳位址');
    const res = await fetch(location, { method: 'PUT', headers: { 'Content-Type': type }, body: blob });
    if (!res.ok) throw new Error(`上傳失敗（${res.status}）`);
  }

  async function doSync(token) {
    set({ state: 'syncing', error: '' });
    applying = true;
    let result = null;
    try {
      if (!st.account) await fetchAccount(token);
      const file = await findFile(token);
      if (file) result = await mergeSnapshot(await download(file.id, token));
      await upload(file?.id, await buildSnapshot(), token);
    } finally {
      applying = false;
    }
    const now = new Date().toISOString();
    lsSet(K.last, now);
    lsSet(K.dirty, null);
    set({ state: 'ok', lastSync: now, dirty: false });
    if (result && changedCount(result)) onMerged?.(result);
    return result;
  }

  function run(tokenPromise) {
    if (running) { again = true; return running; }
    running = (async () => {
      try {
        const token = await tokenPromise;
        if (!token) { set({ state: idleState() }); return null; }
        return await doSync(token);
      } catch (err) {
        console.warn('Sync failed:', err);
        set({ state: err.auth ? 'need-auth' : 'error', error: err.message });
        return null;
      } finally {
        running = null;
        if (again) { again = false; syncSilently(); }
      }
    })();
    return running;
  }

  function syncSilently() {
    return run(Promise.resolve(validToken()));
  }

  function syncInteractive() {
    const token = validToken();
    return run(token ? Promise.resolve(token) : requestTokenInteractive());
  }

  function signOut() {
    const t = lsGet(K.token);
    if (t && globalThis.google?.accounts?.oauth2) google.accounts.oauth2.revoke(t.access_token, () => {});
    lsSet(K.token, null);
    lsSet(K.account, null);
    lsSet(K.last, null);
    set({ state: 'signed-out', account: null, lastSync: null, error: '' });
  }

  addEventListener(CHANGE_EVENT, () => {
    if (applying) return;
    lsSet(K.dirty, true);
    if (!st.dirty) set({ dirty: true });
    if (!st.account) return;
    clearTimeout(timer);
    timer = setTimeout(syncSilently, AUTO_SYNC_DELAY);
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !st.account || !validToken()) return;
    const last = st.lastSync ? Date.parse(st.lastSync) : 0;
    if (Date.now() - last > RESYNC_ON_FOCUS_AFTER) syncSilently();
  });

  set({ state: idleState() });
  if (st.account && validToken()) syncSilently();

  return {
    get status() { return { ...st }; },
    subscribe(fn) { listeners.add(fn); fn({ ...st }); return () => listeners.delete(fn); },
    sync: syncInteractive,
    signOut,
  };
}
