(() => {
  if (!(['https://vega-app.in', 'https://web.vega-app.in'].includes(location.origin) || ['http:', 'https:'].includes(location.protocol) && ['localhost', '127.0.0.1'].includes(location.hostname))) return;
  if (window !== window.top) return;
  if (globalThis.__vegaContentBridge) {globalThis.__vegaContentBridge.reconnect(); return;}
  let port, retry, ready = false, stopped = false;
  const send = message => window.postMessage({vegaHost: 1, direction: 'response', ...message}, location.origin);
  function connect() {
    if (stopped || ready) return;
    clearTimeout(retry);
    try {port = chrome.runtime.connect({name: 'vega-platform-v1'});}
    catch {stopped = true; send({type: 'status', connected: false}); return;}
    port.onMessage.addListener(message => {
      if (message.type === 'status') ready = message.connected === true;
      if (message.denied) stopped = true;
      send(message);
    });
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError; ready = false; send({type: 'status', connected: false});
      if (!stopped) retry = setTimeout(connect, 1000);
    });
  }
  globalThis.__vegaContentBridge = {reconnect() {if (!ready) {stopped = false; connect();}}};
  window.addEventListener('message', event => {
    if (event.source !== window || event.origin !== location.origin || event.data?.vegaHost !== 1 || event.data.direction !== 'request') return;
    if (event.data.type === 'status') {if (ready) send({type: 'status', connected: true});}
    else if (ready) port.postMessage(event.data);
    else send({id: event.data.id, error: 'Vega extension is inactive. Reload the Vega tab to retry.'});
  });
  let heartbeat;
  function startHeartbeat() {clearInterval(heartbeat); heartbeat = setInterval(() => {if (ready) port.postMessage({type: 'renew'});}, 20_000);}
  window.addEventListener('pagehide', () => {stopped = true; clearTimeout(retry); clearInterval(heartbeat); port?.disconnect();});
  window.addEventListener('pageshow', event => {if (event.persisted) {stopped = false; startHeartbeat(); connect();}});
  startHeartbeat();
  connect();
})();
