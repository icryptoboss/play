export const ALL_WEBSITE_ORIGINS = ['http://*/*', 'https://*/*'];

export function hasAllWebsiteAccess() {
  return chrome.permissions.contains({origins: ALL_WEBSITE_ORIGINS});
}

export async function requireWebsiteAccess() {
  if (!await hasAllWebsiteAccess()) throw new Error('Website access is required. Open the Vega extension and choose Allow all websites.');
}
