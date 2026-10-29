import {ALL_WEBSITE_ORIGINS, hasAllWebsiteAccess} from './access.mjs';

const status = document.querySelector('#status');
const description = document.querySelector('#description');
const origin = document.querySelector('#origin');
const allow = document.querySelector('#allow-websites');
const remove = document.querySelector('#remove-websites');
const feedback = document.querySelector('#access-feedback');
let requesting = false;
let permissionMessage = '';
let previousAccess;
document.querySelector('#version').textContent = `v${chrome.runtime.getManifest().version}`;
async function update() {
  try {
    const access = await hasAllWebsiteAccess();
    const incognito = await chrome.extension.isAllowedIncognitoAccess();
    document.querySelector('#incognito-description').textContent = incognito ? 'Private verification windows are enabled.' : 'Enable Allow in Incognito in the extension details to open website verification. The browser does not ask automatically.';
    const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
    const result = tab?.id === undefined ? undefined : await chrome.runtime.sendMessage({type: 'status', tabId: tab.id});
    document.body.dataset.state = access && result?.active ? 'active' : 'inactive';
    status.textContent = access && result?.active ? 'Active' : 'Inactive';
    description.textContent = !access ? 'Allow website access to use providers and playback.' : result?.active ? 'Working automatically on this tab.' : result?.supported ? 'Waiting for the Vega tab. Reload it to retry.' : 'Open Vega to use the extension.';
    origin.textContent = result?.supported ? new URL(tab.url).host : 'web.vega-app.in · localhost';
    allow.hidden = access; remove.hidden = !access;
    allow.disabled = requesting; remove.disabled = requesting;
    document.querySelector('#access-description').textContent = access ? 'All HTTP/HTTPS websites are allowed for provider and video requests.' : 'Allow provider and video servers on all HTTP/HTTPS websites.';
    if (access && previousAccess === false) permissionMessage = '';
    previousAccess = access;
    feedback.textContent = permissionMessage; feedback.hidden = !permissionMessage;
  } catch {
    document.body.dataset.state = 'inactive'; status.textContent = 'Inactive';
    description.textContent = 'Reload your Vega tab to retry.';
  }
}
allow.addEventListener('click', () => {
  requesting = true; allow.disabled = true; permissionMessage = '';
  // Call synchronously from the click: Chrome requires a real user gesture.
  let permission;
  try {permission = chrome.permissions.request({origins:ALL_WEBSITE_ORIGINS});}
  catch (error) {permission = Promise.reject(error);}
  void permission.then(granted => {
    permissionMessage = granted ? '' : 'Website access was not granted. You can try again.';
  }).catch(error => {permissionMessage = error.message || 'Could not request website access.';})
    .finally(() => {requesting = false; void update();});
});
remove.addEventListener('click', () => {
  requesting = true; remove.disabled = true; permissionMessage = '';
  void chrome.permissions.remove({origins:ALL_WEBSITE_ORIGINS})
    .then(removed => {if (!removed) permissionMessage = 'Website access could not be removed.';})
    .catch(error => {permissionMessage = error.message || 'Could not remove website access.';})
    .finally(() => {requesting = false; void update();});
});
void update();
document.querySelector('#verification-settings').addEventListener('click', () => {
  void chrome.tabs.create({url:`chrome://extensions/?id=${chrome.runtime.id}`}).catch(error => {
    feedback.textContent = error.message || 'Open your browser extension settings and enable Allow in Incognito for Vega.';
    feedback.hidden = false;
  });
});
setInterval(update, 1000);
