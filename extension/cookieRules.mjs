function getDomain(host) {
  if (!host || typeof host !== 'string') return null;
  host = host.toLowerCase().trim().replace(/^\.+|\.+$/g, '');
  if (!host) return null;
  if (/^[\d.]+$/.test(host) || host.includes(':')) return host;
  if (host === 'localhost') return 'localhost';
  const parts = host.split('.');
  if (parts.length === 1) return parts[0];
  const secondLevelTLDs = new Set(['co', 'com', 'org', 'net', 'edu', 'gov', 'mil']);
  if (parts.length >= 3 && secondLevelTLDs.has(parts[parts.length - 2]) && parts[parts.length - 1].length === 2) {
    return parts.slice(-3).join('.');
  }
  return parts.slice(-2).join('.');
}

const LIMIT = 500;
const validPair = (name, value) =>
  typeof name === 'string' && /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name) &&
  typeof value === 'string' && !/[\x00-\x20\x7f;]/.test(value) && name.length + value.length <= 16_384;
const domainMatches = (host, domain, hostOnly) =>
  host === domain || (!hostOnly && !/^[\d.]+$/.test(host) && !host.includes(':') && host.endsWith(`.${domain}`));
const pathMatches = (path, cookiePath) =>
  path === cookiePath || (path.startsWith(cookiePath) && (cookiePath.endsWith('/') || path[cookiePath.length] === '/'));
const defaultPath = (url) => url.pathname.slice(0, url.pathname.lastIndexOf('/')) || '/';
const alive = (cookie, now) => cookie.expiresAt === null || cookie.expiresAt > now;
const urlOf = (input) => {try {const url = new URL(input); return /^https?:$/.test(url.protocol) ? url : undefined;} catch {return undefined;}};
const registrable = (domain) => getDomain(domain) !== null;

export function decodeCookieJar(value, now = Date.now()) {
  if (!value || typeof value !== 'object') return [];
  const object = value;
  const candidates = object.version === 2 && Array.isArray(object.cookies) ? object.cookies : [];
  if (object.version === undefined) {
    for (const [domain, names] of Object.entries(object)) {
      if (!names || typeof names !== 'object' || Array.isArray(names)) continue;
      for (const [name, cookie] of Object.entries(names)) if (cookie && typeof cookie === 'object') {
        candidates.push({...cookie, domain, name, path: '/', secure: false, createdAt: 0});
      }
    }
  }
  const result = [];
  for (const entry of candidates) {
    if (!entry || typeof entry !== 'object') continue;
    const cookie = entry;
    if (!validPair(cookie.name, cookie.value) || typeof cookie.domain !== 'string' || typeof cookie.path !== 'string' || !cookie.path.startsWith('/') ||
        typeof cookie.hostOnly !== 'boolean' || typeof cookie.secure !== 'boolean' ||
        !(cookie.expiresAt === null || typeof cookie.expiresAt === 'number' && Number.isFinite(cookie.expiresAt))) continue;
    const domain = cookie.domain.toLowerCase();
    const host = urlOf(`https://${domain}/`);
    if (!host || host.hostname !== domain || !cookie.hostOnly && !registrable(domain)) continue;
    if (alive(cookie, now)) result.push({...cookie, domain, createdAt: Number.isFinite(cookie.createdAt) ? cookie.createdAt : 0});
  }
  return result.slice(-LIMIT);
}

export function putCookies(jar, input, cookies, now = Date.now()) {
  const url = urlOf(input); if (!url) return jar;
  let result = jar.filter(cookie => alive(cookie, now));
  for (const cookie of cookies) {
    if (!validPair(cookie.name, cookie.value)) continue;
    const attrDomain = cookie.domain?.trim().toLowerCase().replace(/^\./, '');
    if (attrDomain && !domainMatches(url.hostname, attrDomain, false)) continue;
    let hostOnly = cookie.hostOnly ?? !attrDomain;
    const domain = attrDomain || url.hostname;
    if (!hostOnly && !registrable(domain)) {
      if (domain !== url.hostname) continue;
      hostOnly = true;
    }
    const path = cookie.path?.startsWith('/') ? cookie.path : defaultPath(url);
    const secure = cookie.secure === true;
    if (secure && url.protocol !== 'https:') continue;
    if (cookie.name.startsWith('__Secure-') && !secure) continue;
    if (cookie.name.startsWith('__Host-') && (!secure || !hostOnly || path !== '/' || attrDomain)) continue;
    if (url.protocol !== 'https:' && result.some(previous => previous.name === cookie.name && previous.secure &&
        (domainMatches(domain, previous.domain, false) || domainMatches(previous.domain, domain, false)) && pathMatches(path, previous.path))) continue;
    const previous = result.find(item => item.name === cookie.name && item.domain === domain && item.path === path);
    result = result.filter(item => item !== previous);
    const expiresAt = cookie.expiresAt ?? null;
    if (expiresAt !== null && (!Number.isFinite(expiresAt) || expiresAt <= now)) continue;
    result.push({name: cookie.name, value: cookie.value, domain, path, secure, hostOnly, expiresAt, createdAt: previous?.createdAt ?? now});
  }
  return result.slice(-LIMIT);
}

function parseSetCookie(header, now) {
  const [pair, ...attributes] = header.split(';'), eq = pair.indexOf('=');
  if (eq <= 0) return;
  const cookie = {name: pair.slice(0, eq).trim(), value: pair.slice(eq + 1).trim()};
  let maxAge;
  for (const attribute of attributes) {
    const separator = attribute.indexOf('='), key = (separator < 0 ? attribute : attribute.slice(0, separator)).trim().toLowerCase();
    const value = separator < 0 ? '' : attribute.slice(separator + 1).trim();
    if (key === 'domain') cookie.domain = value;
    else if (key === 'path') cookie.path = value;
    else if (key === 'secure') cookie.secure = true;
    else if (key === 'max-age' && /^-?\d+$/.test(value)) maxAge = Number(value);
    else if (key === 'expires') {const expiry = Date.parse(value); if (Number.isFinite(expiry)) cookie.expiresAt = expiry;}
  }
  if (maxAge !== undefined) cookie.expiresAt = maxAge <= 0 ? 0 : Math.min(Number.MAX_SAFE_INTEGER, now + maxAge * 1000);
  return cookie;
}

export function responseCookies(jar, url, headers, now = Date.now()) {
  const cookies = headers.flatMap(header => header.split(/,(?=\s*[^;,\s]+=)/).map(part => parseSetCookie(part.trim(), now)).filter((cookie) => !!cookie));
  return putCookies(jar, url, cookies, now);
}

export function matchingCookies(jar, input, now = Date.now()) {
  const url = urlOf(input); if (!url) return [];
  return jar.filter(cookie => alive(cookie, now) && domainMatches(url.hostname, cookie.domain, cookie.hostOnly) &&
    pathMatches(url.pathname || '/', cookie.path) && (!cookie.secure || url.protocol === 'https:'))
    .sort((a, b) => b.path.length - a.path.length || a.createdAt - b.createdAt);
}

export function cookieHeader(jar, url) {
  return matchingCookies(jar, url).map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
}

export function cookieMap(jar, url) {
  const values = new Map();
  for (const cookie of matchingCookies(jar, url)) if (!values.has(cookie.name)) values.set(cookie.name, cookie.value);
  return Object.fromEntries(values);
}

export function suppliedCookies(jar, url, header) {
  const secure = urlOf(url)?.protocol === 'https:';
  const cookies = header.split(';').flatMap(pair => {
    const eq = pair.indexOf('=');
    return eq <= 0 ? [] : [{name: pair.slice(0, eq).trim(), value: pair.slice(eq + 1).trim(), path: '/', secure}];
  });
  return putCookies(jar, url, cookies);
}

export function withoutCookie(jar, url, name) {
  const visible = new Set(matchingCookies(jar, url));
  return jar.filter(cookie => cookie.name !== name || !visible.has(cookie));
}
