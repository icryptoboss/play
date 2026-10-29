export const MAX_BODY = 8 * 1024 * 1024;
// Provider browser identity headers are ordinary DNR header modifications. Keep
// other Sec-* protocol headers blocked, rather than rejecting client hints too.
const browserIdentityHeader = name => /^sec-(?:ch-[a-z0-9-]+|fetch-(?:site|mode|dest|user))$/i.test(name);
export function httpUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Only HTTP(S) URLs without embedded credentials are supported.');
  url.hash = '';
  return url.href;
}
export function headersOf(input = []) {
  if (!Array.isArray(input) || input.length > 100) throw new Error('Invalid HTTP headers.');
  const headers = new Headers();
  for (const pair of input) {
    if (!Array.isArray(pair) || pair.length !== 2 || pair.some(value => typeof value !== 'string')) throw new Error('Invalid HTTP header.');
    const [name, value] = pair;
    if (/^(host|content-length|connection|transfer-encoding|upgrade|proxy-.*|sec-.*|set-cookie)$/i.test(name) && !browserIdentityHeader(name)) throw new Error(`The ${name} header cannot be overridden.`);
    if (value.length > 16_384 || /[\r\n\0]/.test(value)) throw new Error('Invalid HTTP header value.');
    headers.append(name, value);
  }
  return [...headers];
}
export function validateRequest(input) {
  if (!input || !['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(input.method) || !['follow', 'manual', 'error'].includes(input.redirect) || input.credentials !== 'omit') throw new Error('Invalid host request.');
  if (input.scope !== undefined && (typeof input.scope !== 'string' || input.scope.length > 256)) throw new Error('Invalid provider scope.');
  if (input.cookies !== undefined && (!input.scope || !Array.isArray(input.cookies) || input.cookies.length > 500)) throw new Error('Invalid provider cookie snapshot.');
  if (input.body !== undefined && (!Array.isArray(input.body) || input.body.length > MAX_BODY || input.body.some(value => !Number.isInteger(value) || value < 0 || value > 255))) throw new Error('Invalid request body.');
  if (['GET', 'HEAD'].includes(input.method) && input.body?.length) throw new Error('This method cannot have a body.');
  return {...input, url: httpUrl(input.url), headers: headersOf(input.headers)};
}
export function exactUrl(url) {return `^${httpUrl(url).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`;}
export function requestChanges(headers) {
  const values = new Map(headers);
  // Never send the user's browser-profile cookies or HTTP authorization implicitly.
  const result = ['cookie', 'authorization'].filter(name => !values.has(name)).map(header => ({header, operation: 'remove'}));
  return [...result, ...headers.map(([header, value]) => ({header, operation: 'set', value}))];
}
export function redirectHeaders(headers, previous, next) {
  if (new URL(previous).origin === new URL(next).origin) return headers;
  return headers.filter(([name]) => ['accept', 'accept-language', 'referer', 'user-agent', 'range'].includes(name) || browserIdentityHeader(name));
}
