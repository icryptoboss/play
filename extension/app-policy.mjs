export const APP_MATCHES = [
  'https://vega-app.in/*',
  'https://web.vega-app.in/*',
  'http://localhost/*', 'https://localhost/*',
  'http://127.0.0.1/*', 'https://127.0.0.1/*',
];

export function appOrigin(value) {
  try {
    const url = new URL(value);
    if (url.username || url.password) return undefined;
    if (['https://vega-app.in', 'https://web.vega-app.in'].includes(url.origin)) return url.origin;
    if (['http:', 'https:'].includes(url.protocol) && ['localhost', '127.0.0.1'].includes(url.hostname)) return url.origin;
  } catch {}
  return undefined;
}
