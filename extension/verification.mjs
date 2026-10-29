import {httpUrl} from './policy.mjs';
import {assertPublicDestination} from './network-guard.mjs';

let active;
export function verificationTimeout(value) {
  return Number.isFinite(value) ? Math.max(10_000, Math.min(90_000, value)) : 90_000;
}
export function validateVerification(input) {
  if (!input || typeof input.scope !== 'string' || !input.scope || input.scope.length > 256) throw new Error('Invalid verification request.');
  if (input.waitForCookie && input.waitForCookie !== 'cf_clearance') throw new Error('Only the cf_clearance challenge cookie can be returned.');
  if (input.injectedJavaScript) throw new Error('Provider JavaScript is not allowed in browser verification.');
  return {url: httpUrl(input.url), timeoutMs: verificationTimeout(input.timeoutMs)};
}
const pause = (signal, ms) => new Promise((resolve, reject) => {
  signal.throwIfAborted();
  const abort = () => {clearTimeout(timer); reject(signal.reason || new DOMException('Aborted','AbortError'));};
  const timer = setTimeout(() => {signal.removeEventListener('abort', abort); resolve();}, ms);
  signal.addEventListener('abort', abort, {once:true});
});

/** Never reads normal-profile cookies, arbitrary cookie names or page HTML. */
export async function verifyProvider(input, owner, signal) {
  const {url, timeoutMs} = validateVerification(input);
  if (active) throw new Error('Another provider verification is already running.');
  const session = active = {windowId: undefined};
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason || new DOMException('Aborted','AbortError'));
  signal.addEventListener('abort', abort, {once:true});
  const deadline = setTimeout(() => controller.abort(new Error('Provider verification timed out.')), timeoutMs);
  let externalWindow;
  try {
    signal.throwIfAborted();
    if (!await chrome.extension.isAllowedIncognitoAccess()) throw new Error('Enable Allow in Incognito for Vega in chrome://extensions before verifying a provider.');
    if ((await chrome.windows.getAll()).some(window => window.incognito)) throw new Error('Close all existing incognito windows before verifying a provider.');
    controller.signal.throwIfAborted();
    await assertPublicDestination(url, controller.signal);
    const created = await chrome.windows.create({url:'about:blank', incognito:true, type:'normal', focused:true, width:920, height:720});
    session.windowId = created.id;
    const tab = created.tabs?.[0];
    if (!created.incognito || !Number.isInteger(tab?.id)) throw new Error('A private verification window could not be created.');
    externalWindow = window => {if (window.incognito && window.id !== session.windowId) controller.abort(new Error('Another incognito window opened. Verification was stopped.'));};
    chrome.windows.onCreated.addListener(externalWindow);
    const assertExclusive = async () => {
      controller.signal.throwIfAborted();
      const windows = (await chrome.windows.getAll()).filter(window => window.incognito);
      if (windows.length !== 1 || windows[0].id !== session.windowId) throw new Error('Incognito session changed. Verification was stopped.');
      const tabs = await chrome.tabs.query({windowId:session.windowId});
      if (tabs.length !== 1 || tabs[0].id !== tab.id || !tabs[0].incognito) throw new Error('Verification must use only its dedicated private tab.');
      return tabs[0];
    };
    await assertExclusive();
    const stores = await chrome.cookies.getAllCookieStores();
    const store = stores.find(store => store.tabIds.includes(tab.id));
    const appStore = stores.find(store => store.tabIds.includes(owner.tabId));
    if (!store || store.id === appStore?.id) throw new Error('The verification cookie store is not isolated.');
    await chrome.tabs.update(tab.id, {url});
    const origin = new URL(url).origin;
    while (true) {
      const current = await assertExclusive();
      if (current.pendingUrl && current.pendingUrl !== 'about:blank' && new URL(current.pendingUrl).origin !== origin) throw new Error('The verification window is navigating to another website. Verification was stopped.');
      // Chrome can omit url while the new private tab's first navigation commits.
      if (!current.url || current.url === 'about:blank') {await pause(controller.signal, 500); continue;}
      if (new URL(current.url).origin !== origin) throw new Error('The verification window navigated to another website. Verification was stopped.');
      // storeId is mandatory here. Never use cookies.get's regular-profile default.
      const cookie = await chrome.cookies.get({url, name:'cf_clearance', storeId:store.id});
      if (cookie?.value && cookie.storeId === store.id && !cookie.partitionKey) {
        await assertExclusive();
        const [identity] = await chrome.scripting.executeScript({target:{tabId:tab.id}, world:'ISOLATED', func: () => ({userAgent:navigator.userAgent, origin:location.origin})});
        if (identity?.result?.origin !== origin) throw new Error('Verification page changed.');
        controller.signal.throwIfAborted();
        return {url:current.url, userAgent:identity.result.userAgent, cookie:{name:'cf_clearance', value:cookie.value, domain:cookie.domain, hostOnly:cookie.hostOnly, path:cookie.path, secure:cookie.secure, expiresAt:cookie.expirationDate ? cookie.expirationDate * 1000 : null}};
      }
      await pause(controller.signal, 700);
    }
  } finally {
    clearTimeout(deadline); signal.removeEventListener('abort', abort);
    if (session.windowId !== undefined) await chrome.windows.remove(session.windowId).catch(() => {});
    if (externalWindow) chrome.windows.onCreated.removeListener(externalWindow);
    if (active === session) active = undefined;
    controller.signal.throwIfAborted();
  }
}
