(() => {
  if (!(['https://vega-app.in', 'https://web.vega-app.in'].includes(location.origin) || ['http:', 'https:'].includes(location.protocol) && ['localhost', '127.0.0.1'].includes(location.hostname))) return;
  if (window !== window.top || window.__vegaBrowserBridge) return;
  window.__vegaBrowserBridge = true;
  const pending = new Map(), resources = new Map();
  let ready;
  window.vegaPlatformHostReady = new Promise(resolve => {ready = resolve; setTimeout(resolve, 2000);});
  let connected = false;
  function call(type, payload, signal) {
    if (!connected) return Promise.reject(new Error('Vega extension is inactive. Reload the Vega tab to retry.'));
    if (signal?.aborted) return Promise.reject(signal.reason || new DOMException('Aborted', 'AbortError'));
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const finish = (error, value) => {
        pending.delete(id); clearTimeout(timer); signal?.removeEventListener('abort', abort);
        error ? reject(error) : resolve(value);
      };
      const abort = () => {window.postMessage({vegaHost: 1, direction: 'request', id, type: 'cancel'}, location.origin); finish(signal.reason || new DOMException('Aborted', 'AbortError'));};
      const timer = setTimeout(() => {window.postMessage({vegaHost: 1, direction: 'request', id, type: 'cancel'}, location.origin); finish(new Error('Vega browser host request timed out.'));}, type === 'verify' ? 95_000 : 25_000);
      pending.set(id, finish); signal?.addEventListener('abort', abort, {once: true});
      window.postMessage({vegaHost: 1, direction: 'request', id, type, payload}, location.origin);
    });
  }
  const host = {
    version: 1, kind: 'browser-extension',
    capabilities: {restrictedHeaders: true, isolatedCookies: true, manualRedirects: true, mediaDelivery: true, publicDestinationChecks:true},
    request: (request, signal) => call('request', request, signal),
    verifyProvider: (request, signal) => call('verify', request, signal),
    async prepareMediaSource(source) {
      const id = crypto.randomUUID();
      const result = await call('prepare', {...source, id});
      const blobs = [];
      try {
        const urls = new Map();
        // Children arrive before parents, so placeholder replacement is deterministic.
        for (const playlist of result.playlists || []) {
          let text = playlist.text;
          for (const [key, value] of urls) text = text.split(key).join(value);
          const url = URL.createObjectURL(new Blob([text], {type: 'application/vnd.apple.mpegurl'}));
          blobs.push(url); urls.set(playlist.key, url);
        }
        const sourceUrl = urls.get(result.source) || result.source;
        resources.set(id, blobs);
        return {...source, id, source: sourceUrl, headers: undefined};
      } catch (error) {blobs.forEach(url => URL.revokeObjectURL(url)); void call('release', {id}).catch(() => {}); throw error;}
    },
    async releaseMediaSource(id) {
      (resources.get(id) || []).forEach(url => URL.revokeObjectURL(url)); resources.delete(id);
      if (connected) await call('release', {id});
    },
  };
  window.addEventListener('message', event => {
    if (event.source !== window || event.origin !== location.origin || event.data?.vegaHost !== 1 || event.data.direction !== 'response') return;
    const message = event.data;
    if (message.type === 'status') {
      connected = message.connected === true;
      if (message.websiteAccess === false) {
        for (const finish of [...pending.values()]) finish(new Error('Website access is required. Open the Vega extension and choose Allow all websites.'));
        for (const blobs of resources.values()) blobs.forEach(url => URL.revokeObjectURL(url)); resources.clear();
      }
      if (connected) {if (!window.vegaPlatformHost) window.vegaPlatformHost = host;}
      else {
        if (window.vegaPlatformHost === host) delete window.vegaPlatformHost;
        for (const finish of [...pending.values()]) finish(new Error('Vega browser host disconnected.'));
        for (const blobs of resources.values()) blobs.forEach(url => URL.revokeObjectURL(url)); resources.clear();
      }
      ready();
      window.dispatchEvent(new Event('vega-platform-host-change'));
    } else pending.get(message.id)?.(message.error ? new Error(message.error) : undefined, message.value);
  });
  window.postMessage({vegaHost: 1, direction: 'request', type: 'status'}, location.origin);
})();
