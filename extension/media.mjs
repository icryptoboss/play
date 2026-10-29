import {request} from './http.mjs';
import {exactUrl, headersOf, httpUrl, redirectHeaders, requestChanges} from './policy.mjs';
import {cookieHeader, responseCookies, suppliedCookies} from './cookieRules.mjs';
import {assertPublicDestination} from './network-guard.mjs';

let mutation = Promise.resolve();
function locked(task) {const value = mutation.then(task); mutation = value.catch(() => {}); return value;}
async function leases() {return (await chrome.storage.session.get('leases')).leases || {};}
const owned = (lease, owner) => lease.tabId === owner.tabId && lease.documentId === owner.documentId;

export function release(id, owner) {return locked(async () => {
  const values = await leases(); const lease = values[id];
  if (!lease || !owned(lease, owner)) return;
  await chrome.declarativeNetRequest.updateSessionRules({removeRuleIds: lease.ruleIds});
  delete values[id]; await chrome.storage.session.set({leases: values});
});}
export function cleanOwner(owner) {return locked(async () => {
  const values = await leases(); const ids = [];
  for (const [key, lease] of Object.entries(values)) if (lease.tabId === owner.tabId && (!owner.documentId || lease.documentId === owner.documentId)) {ids.push(...lease.ruleIds); delete values[key];}
  if (ids.length) await chrome.declarativeNetRequest.updateSessionRules({removeRuleIds: ids});
  await chrome.storage.session.set({leases: values});
});}
export function renew(owner) {return locked(async () => {
  const values = await leases(); let changed = false;
  for (const lease of Object.values(values)) if (owned(lease, owner)) {lease.expires = Date.now() + 120_000; changed = true;}
  if (changed) await chrome.storage.session.set({leases: values});
});}
export function expire() {return locked(async () => {
  const values = await leases(), ids = [];
  for (const [id, lease] of Object.entries(values)) if (lease.expires < Date.now()) {ids.push(...lease.ruleIds); delete values[id];}
  if (ids.length) await chrome.declarativeNetRequest.updateSessionRules({removeRuleIds: ids});
  await chrome.storage.session.set({leases: values});
});}

export async function prepare(input, owner, signal) {
  if (!input || typeof input.id !== 'string' || input.id.length > 100) throw new Error('Invalid media descriptor.');
  const source = httpUrl(input.source), headers = headersOf(Object.entries(input.headers || {}));
  let jar = suppliedCookies([], source, new Map(headers).get('cookie') || '');
  const headersFor = url => {
    const values = redirectHeaders(headers, source, url).filter(([name]) => name !== 'cookie');
    const cookie = cookieHeader(jar, url); if (cookie) values.push(['cookie', cookie]);
    return values;
  };
  const fetchSource = async (url, probe = false) => {
    const values = headersFor(url);
    if (probe) {const range = values.findIndex(([name]) => name === 'range'); if (range >= 0) values.splice(range, 1); values.push(['range', 'bytes=0-0']);}
    const result = await request({url, method: 'GET', headers: values, redirect: 'follow', credentials: 'omit'}, signal, {cookies: jar, headersOnly: probe});
    for (const update of result.cookieUpdates || []) jar = responseCookies(jar, update.url, update.headers);
    jar = responseCookies(jar, result.url, result.headers.filter(([name]) => name.toLowerCase() === 'set-cookie').map(([, value]) => value));
    return result;
  };
  const resources = new Map(), playlists = [], visited = new Map();
  const resource = url => {
    const normalized = httpUrl(url);
    resources.set(normalized, null);
    if (resources.size > 700) throw new Error('This media source exceeds the current 700-resource limit.');
    return normalized;
  };
  const playlist = async (url, depth = 0) => {
    if (depth > 4 || visited.size >= 16) throw new Error('Too many nested HLS playlists.');
    const normalized = httpUrl(url);
    if (visited.has(normalized)) {
      const previous = visited.get(normalized); if (!previous.done) throw new Error('Cyclic HLS playlist.');
      return previous.key;
    }
    const entry = {key: `vega-playlist:${crypto.randomUUID()}`, done: false}; visited.set(normalized, entry);
    const response = await fetchSource(normalized);
    if (response.status !== 200) throw new Error(`HLS playlist returned HTTP ${response.status}.`);
    const text = new TextDecoder().decode(Uint8Array.from(response.body));
    if (!text.trimStart().startsWith('#EXTM3U') || text.length > 512_000) throw new Error('Invalid HLS playlist.');
    if (/\{\$|#EXT-X-(?:CONTENT-STEERING|DEFINE|PART:|PRELOAD-HINT:)/.test(text)) throw new Error('Variable, steering and low-latency HLS are not supported by this extension yet.');
    const master = /#EXT-X-(?:STREAM-INF|MEDIA:|I-FRAME-STREAM-INF)/.test(text);
    if (!master && !text.includes('#EXT-X-ENDLIST')) throw new Error('Live HLS needs a streaming transport; this extension currently supports on-demand HLS.');
    const lines = []; let nextPlaylist = false;
    for (const line of text.split(/\r?\n/)) {
      signal.throwIfAborted();
      if (/KEYFORMAT="(?!identity")/.test(line)) throw new Error('DRM HLS keys are not supported.');
      if (!line.trim() || line.startsWith('#')) {
        let replaced = line;
        for (const match of line.matchAll(/URI="([^"]+)"/g)) {
          const url = new URL(match[1], response.url).href;
          const nested = /^#EXT-X-(?:MEDIA|I-FRAME-STREAM-INF):/.test(line);
          const target = nested ? await playlist(url, depth + 1) : resource(url);
          replaced = replaced.replace(match[0], `URI="${target}"`);
        }
        lines.push(replaced); nextPlaylist = /^#EXT-X-STREAM-INF:/.test(line) || nextPlaylist;
      } else {
        const url = new URL(line.trim(), response.url).href;
        lines.push(nextPlaylist ? await playlist(url, depth + 1) : resource(url)); nextPlaylist = false;
      }
    }
    playlists.push({key: entry.key, text: lines.join('\n')}); entry.done = true; return entry.key;
  };
  const hls = /hls|m3u8|mpegurl/i.test(input.format || '') || /\.m3u8(?:[?#]|$)/i.test(source);
  let resultSource;
  if (hls) resultSource = await playlist(source);
  else {
    // Resolve authentication/redirects using headers only. Video bytes still go
    // directly from the resolved URL to the player, including byte-range seeks.
    const response = await fetchSource(source, true);
    if (![200, 206].includes(response.status)) throw new Error(`Media source returned HTTP ${response.status}.`);
    resultSource = resource(response.url);
  }
  const checkedHosts = new Set();
  for (const url of resources.keys()) {
    const hostname = new URL(url).hostname;
    if (!checkedHosts.has(hostname)) {await assertPublicDestination(url, signal); checkedHosts.add(hostname);}
  }
  await locked(async () => {
    signal.throwIfAborted();
    const existing = await leases();
    // Different credentials for the same tab/URL cannot safely share DNR rules.
    for (const lease of Object.values(existing)) if (lease.tabId === owner.tabId && lease.urls.some(url => resources.has(url))) throw new Error('This tab already has a media lease for one of these URLs.');
    const rules = await chrome.declarativeNetRequest.getSessionRules();
    let id = Math.max(1, ...rules.map(rule => rule.id)) + 1;
    if (id + resources.size > 2_147_483_647 || rules.length + resources.size > 1000) throw new Error('Extension media rule capacity reached.');
    const added = [...resources.keys()].map(url => ({
      id: id++, priority: 1,
      condition: {regexFilter: exactUrl(url), isUrlFilterCaseSensitive: true, tabIds: [owner.tabId], initiatorDomains: [new URL(owner.origin).hostname], resourceTypes: ['xmlhttprequest', 'media']},
      action: {type: 'modifyHeaders', requestHeaders: requestChanges(headersFor(url)), responseHeaders: [
        {header: 'access-control-allow-origin', operation: 'set', value: owner.origin},
        {header: 'access-control-expose-headers', operation: 'set', value: 'Content-Length, Content-Range, Accept-Ranges'},
        {header: 'set-cookie', operation: 'remove'},
        // Follow redirects only through host HTTP, where credentials are scoped.
        {header: 'location', operation: 'remove'},
      ]},
    }));
    await chrome.declarativeNetRequest.updateSessionRules({addRules: added});
    existing[input.id] = {...owner, urls: [...resources.keys()], ruleIds: added.map(rule => rule.id), expires: Date.now() + 120_000};
    await chrome.storage.session.set({leases: existing});
  });
  return {source: resultSource, playlists};
}
