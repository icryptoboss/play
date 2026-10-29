import {MAX_BODY, exactUrl, requestChanges, redirectHeaders, validateRequest, httpUrl} from './policy.mjs';
import {cookieHeader, decodeCookieJar, responseCookies, suppliedCookies} from './cookieRules.mjs';
import {assertPublicDestination} from './network-guard.mjs';

let queue = Promise.resolve(), active;
const extensionOrigin = new URL(chrome.runtime.getURL('/')).origin;
const requestFilter = {urls: ['http://*/*', 'https://*/*'], types: ['xmlhttprequest']};
const matchesActive = details => active && details.initiator === extensionOrigin && details.url === active.url &&
  (active.requestId === undefined || details.requestId === active.requestId);
chrome.webRequest.onBeforeRequest.addListener(details => {
  if (matchesActive(details)) active.requestId = details.requestId;
}, requestFilter);
function captureResponse(details) {
  if (!matchesActive(details) || details.statusCode < 200 || details.statusCode > 599) return;
  // onBeforeRedirect may omit Set-Cookie. Keep the extraHeaders snapshot from
  // onHeadersReceived so authentication established by the redirect survives.
  const responseHeaders = [...(details.redirectUrl && active.response?.responseHeaders?.length
    ? active.response.responseHeaders : details.responseHeaders || [])];
  // Browser-generated redirects can expose their destination through this
  // event even when fetch returns an opaque redirect with no headers.
  if (details.redirectUrl && !responseHeaders.some(header => header.name.toLowerCase() === 'location')) {
    responseHeaders.push({name:'Location', value:details.redirectUrl});
  }
  active.response = {...details, responseHeaders};
  active.notify?.();
}
chrome.webRequest.onHeadersReceived.addListener(captureResponse, requestFilter, ['responseHeaders', 'extraHeaders']);
chrome.webRequest.onBeforeRedirect.addListener(captureResponse, requestFilter, ['responseHeaders']);

async function waitForResponse(session, signal) {
  signal.throwIfAborted();
  if (session.response) return session.response;
  return new Promise((resolve, reject) => {
    const finish = error => {
      clearTimeout(timer); signal.removeEventListener('abort', abort); session.notify = undefined;
      error ? reject(error) : resolve(session.response);
    };
    const abort = () => finish(signal.reason || new DOMException('Aborted','AbortError'));
    const timer = setTimeout(() => finish(), 1000);
    session.notify = () => finish();
    signal.addEventListener('abort', abort, {once:true});
    if (signal.aborted) abort();
  });
}

async function readBounded(response, signal) {
  if (!response.body) return [];
  const reader = response.body.getReader(), chunks = []; let length = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const {done, value} = await reader.read(); if (done) break;
      length += value.length;
      if (length > MAX_BODY) throw new Error('Provider response exceeds the 8 MiB metadata limit.');
      chunks.push(value);
    }
  } catch (error) {await reader.cancel().catch(() => {}); throw error;}
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) {bytes.set(chunk, offset); offset += chunk.length;}
  return Array.from(bytes);
}

export function request(input, signal, delivery = {}) {
  const validated = validateRequest(input);
  const task = queue.then(() => perform({...validated, cookies: delivery.cookies ?? validated.cookies}, signal, delivery.headersOnly === true));
  queue = task.catch(() => {}); return task;
}

async function perform(input, signal, headersOnly) {
  let url = input.url, method = input.method, headers = input.headers, body = input.body;
  let jar = input.cookies ? decodeCookieJar({version: 2, cookies: input.cookies}) : suppliedCookies([], url, new Map(headers).get('cookie') || '');
  const cookieUpdates = [];
  for (let hop = 0; hop <= 10; hop++) {
    signal.throwIfAborted();
    await assertPublicDestination(url, signal);
    let response, captured;
    try {
      await chrome.declarativeNetRequest.updateSessionRules({removeRuleIds: [1], addRules: [{
        id: 1, priority: 1, condition: {regexFilter: exactUrl(url), isUrlFilterCaseSensitive: true, tabIds: [-1], initiatorDomains: [chrome.runtime.id], resourceTypes: ['xmlhttprequest']},
        action: {type: 'modifyHeaders', requestHeaders: requestChanges(headers)},
      }]});
      signal.throwIfAborted(); const session = active = {url};
      // Headers are applied by DNR, outside fetch's forbidden-header guard.
      response = await fetch(url, {method, body: body?.length ? Uint8Array.from(body) : undefined, credentials: 'omit', redirect: 'manual', cache: 'no-store', signal});
      // webRequest notifications are asynchronous. Do not mistake fetch's
      // deliberately hidden redirect status (0) for a failed provider response.
      captured = session.response || (response.status === 0 ? await waitForResponse(session, signal) : undefined);
      const status = captured?.statusCode || response.status;
      const responseHeaders = captured?.responseHeaders?.filter(item => typeof item.value === 'string').map(item => [item.name, item.value]) || [...response.headers];
      if (status < 200 || status > 599) throw new Error(`The extension could not read the ${response.type === 'opaqueredirect' ? 'redirect' : 'HTTP response'} from ${new URL(url).hostname}. Reload the Vega extension and app, then retry.`);
      const redirect = [301, 302, 303, 307, 308].includes(status);
      const location = responseHeaders.find(([name]) => name.toLowerCase() === 'location')?.[1];
      const setCookies = responseHeaders.filter(([name]) => name.toLowerCase() === 'set-cookie').map(([, value]) => value);
      jar = responseCookies(jar, url, setCookies);
      if (!redirect || !location || input.redirect === 'manual') {
        if (headersOnly) await response.body?.cancel();
        return {url, status, headers: responseHeaders, cookieUpdates, body: headersOnly || redirect || method === 'HEAD' ? [] : await readBounded(response, signal)};
      }
      await response.body?.cancel();
      if (input.redirect === 'error') throw new Error('Redirects are disabled for this request.');
      if (setCookies.length) cookieUpdates.push({url, headers: setCookies});
      const next = httpUrl(new URL(location, url).href);
      headers = redirectHeaders(headers, url, next).filter(([name]) => name !== 'cookie');
      const cookie = cookieHeader(jar, next);
      if (cookie) headers.push(['cookie', cookie]);
      if (status === 303 && method !== 'HEAD' || [301, 302].includes(status) && method === 'POST') {
        method = 'GET'; body = undefined; headers = headers.filter(([name]) => !['content-type', 'content-encoding'].includes(name));
      }
      url = next;
    } finally {
      active = undefined;
      await chrome.declarativeNetRequest.updateSessionRules({removeRuleIds: [1]});
    }
  }
  throw new Error('Too many provider redirects.');
}
