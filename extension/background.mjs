import {request} from './http.mjs';
import {prepare, release, cleanOwner, renew, expire} from './media.mjs';
import {appOrigin} from './app-policy.mjs';
import {verifyProvider, verificationTimeout} from './verification.mjs';
import {hasAllWebsiteAccess, requireWebsiteAccess} from './access.mjs';

const ports = new Set();
let websiteAccess = false;
async function removeLegacyAccess() {
  // Earlier builds allowed users to connect arbitrary origins. Static app-only
  // content scripts now replace those registrations; saved providers stay intact.
  const scripts = await chrome.scripting.getRegisteredContentScripts();
  const ids = scripts.filter(script => /^vega-[a-f0-9]+(?:-content)?$/.test(script.id)).map(script => script.id);
  if (ids.length) await chrome.scripting.unregisterContentScripts({ids});
  const leases = (await chrome.storage.session.get('leases')).leases || {};
  for (const lease of Object.values(leases)) if (!appOrigin(lease.origin)) await cleanOwner(lease);
}
const ready = Promise.all([
  chrome.declarativeNetRequest.updateSessionRules({removeRuleIds: [1]}),
  removeLegacyAccess(),
]).then(expire).then(syncWebsiteAccess);

async function syncWebsiteAccess() {
  websiteAccess = await hasAllWebsiteAccess();
  if (!websiteAccess) {
    for (const item of ports) item.cancel();
    const leases = (await chrome.storage.session.get('leases')).leases || {};
    for (const lease of Object.values(leases)) await cleanOwner(lease);
  }
  for (const item of ports) {
    item.post({type:'status', connected:true, websiteAccess});
    void refreshAction(item.owner.tabId);
  }
}

function isActive(tab) {
  const origin = appOrigin(tab?.url);
  return Boolean(websiteAccess && origin && [...ports].some(item => item.owner.tabId === tab.id && item.owner.origin === origin));
}
async function refreshAction(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId), active = isActive(tab);
    await chrome.action.setBadgeText({tabId, text: active ? 'ON' : ''});
    await chrome.action.setBadgeBackgroundColor({tabId, color: '#2a9e72'});
    await chrome.action.setTitle({tabId, title: active ? 'Vega · Active' : 'Vega · Inactive'});
  } catch {} // A tab may close while its port is being released.
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.url !== chrome.runtime.getURL('popup.html') || message?.type !== 'status' || !Number.isInteger(message.tabId)) return;
  void ready.then(async () => {
    const tab = await chrome.tabs.get(message.tabId);
    websiteAccess = await hasAllWebsiteAccess();
    respond({active: isActive(tab), supported: Boolean(appOrigin(tab.url)), websiteAccess});
  }).catch(() => respond({active: false, supported: false}));
  return true;
});

chrome.runtime.onConnect.addListener(port => {
  const sender = port.sender, origin = appOrigin(sender?.url);
  if (port.name !== 'vega-platform-v1' || !origin || sender.frameId !== 0 || !sender.documentId || !Number.isInteger(sender.tab?.id)) {port.disconnect(); return;}
  const owner = {tabId: sender.tab.id, documentId: sender.documentId, origin};
  const item = {port, owner}, pending = new Map(); let disconnected = false;
  const post = value => {if (!disconnected) {try {port.postMessage(value);} catch {}}};
  item.post = post;
  item.cancel = () => {for (const controller of pending.values()) controller.abort(new Error('Website access was removed.'));};
  const authorized = ready.then(async () => {
    const tab = await chrome.tabs.get(owner.tabId);
    if (appOrigin(tab.url) !== origin || disconnected) throw new Error('App document changed.');
    ports.add(item); post({type: 'status', connected: true, websiteAccess}); void refreshAction(owner.tabId);
  });
  authorized.catch(error => {post({type: 'status', connected: false, error: error.message}); port.disconnect();});
  port.onMessage.addListener(message => {
    if (message?.type === 'cancel') {pending.get(message.id)?.abort(); return;}
    if (message?.type === 'renew') {void authorized.then(() => renew(owner)).catch(() => {}); return;}
    if (!['request', 'prepare', 'release', 'verify'].includes(message?.type) || typeof message.id !== 'string' || message.id.length > 100 || pending.has(message.id) || pending.size >= 16) return;
    const controller = new AbortController(); pending.set(message.id, controller);
    const timer = setTimeout(() => controller.abort(new Error('Host operation timed out.')), message.type === 'verify' ? verificationTimeout(message.payload?.timeoutMs) + 1000 : 22_000);
    void authorized.then(async () => {
      controller.signal.throwIfAborted();
      if (disconnected) throw new Error('Vega tab closed.');
      if (message.type !== 'release') await requireWebsiteAccess();
      if (message.type === 'request') return request(message.payload, controller.signal);
      if (message.type === 'verify') return verifyProvider(message.payload, owner, controller.signal);
      if (message.type === 'prepare') return prepare(message.payload, owner, controller.signal);
      return release(message.payload?.id, owner);
    }).then(value => post({id: message.id, value}), error => post({id: message.id, error: error.message || 'Host operation failed.'})).finally(() => {clearTimeout(timer); pending.delete(message.id);});
  });
  port.onDisconnect.addListener(() => {
    disconnected = true; ports.delete(item); for (const controller of pending.values()) controller.abort();
    void authorized.catch(() => {}).then(() => cleanOwner(owner)).catch(() => {});
    void refreshAction(owner.tabId);
  });
});
chrome.tabs.onRemoved.addListener(tabId => {void cleanOwner({tabId});});
chrome.tabs.onUpdated.addListener((tabId, change) => {if (change.status || change.url) void refreshAction(tabId);});
chrome.alarms.create('vega-media-expiry', {periodInMinutes: 1});
chrome.alarms.onAlarm.addListener(alarm => {if (alarm.name === 'vega-media-expiry') void expire();});
chrome.permissions.onAdded.addListener(() => {void ready.then(syncWebsiteAccess).catch(() => {});});
chrome.permissions.onRemoved.addListener(() => {void ready.then(syncWebsiteAccess).catch(() => {});});
