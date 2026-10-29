import {publicHttpUrl, isPublicAddress} from './networkPolicy.mjs';

async function lookup(hostname, signal) {
  const answers = await Promise.all(['A','AAAA'].map(async type => {
    const url = new URL('https://cloudflare-dns.com/dns-query');
    url.searchParams.set('name', hostname); url.searchParams.set('type', type);
    const response = await fetch(url, {credentials:'omit', redirect:'error', cache:'no-store', headers:{Accept:'application/dns-json'}, signal});
    if (!response.ok) throw new Error('Public DNS validation failed.');
    const data = await response.json();
    if (![0,3].includes(data.Status)) throw new Error('Public DNS validation failed.');
    return (data.Answer || []).filter(answer => [1,28].includes(answer.type)).map(answer => answer.data);
  }));
  return answers.flat();
}
export async function assertPublicDestination(value, signal, resolve = lookup) {
  const url = publicHttpUrl(value);
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (!/^[\d.]+$/.test(hostname) && !hostname.includes(':')) {
    const addresses = await resolve(hostname, signal);
    if (!addresses.length || addresses.some(address => !isPublicAddress(address))) throw new Error('Provider DNS destination is blocked or unavailable.');
  }
  return url.href;
}
