# Vega browser extension

Required Manifest V3 adapter for the shared Vega web app. Install it from the
[Chrome Web Store](https://chromewebstore.google.com/detail/vega/iofleagpffjfcaegclkgbjjfeoinmjhe),
open its popup, choose **Allow all websites**, then reload Vega. The web app stays
accessible without the extension and prompts to install it when adding a provider
source or installing a provider. The prompt is dismissible. It contains no
content providers or provider sources. Desktop and installed TV apps use their own
implementation of the platform host contract and do not require this extension.

## Install for development

1. Run `npm run build:extension` from `vega-desktop` to generate the shared cookie
   module and ZIP. Run it again after changing the cookie implementation.
2. Open `chrome://extensions`, enable Developer mode and choose **Load unpacked**.
3. Select this `browser-extension` directory.
4. Start the app with `npm run dev:web` and open `http://localhost:5173`.
5. Open the extension popup, click **Allow all websites**, and approve Chrome's
   permission dialog. The grant covers HTTP/HTTPS provider and CDN domains and
   is remembered by Chrome; it does not ask for each new provider domain.
6. The extension activates automatically on Vega once access is allowed. The popup
   shows **Active** on Vega and **Inactive** elsewhere, with no Connect controls.
   Refresh the Vega tab if an earlier request failed.
7. Add a provider source and install a provider explicitly in Vega's Extensions
   page. Activation does not add either.

The bridge runs only on `https://web.vega-app.in`, `https://vega-app.in`, HTTP(S) `localhost` and HTTP(S)
`127.0.0.1` (the local development alias). Other domains, subdomains, production
HTTP/nonstandard ports and embedded frames are not authorized. Local ports are
allowed for development. To disable it, use Chrome's extension controls.
Upgrading clears old custom-origin script registrations and temporary media rules
for unrelated origins, and ignores saved approvals. App providers, sources and
preferences remain intact.

On Windows, `npm run build:extension` creates
`dist-extension/vega-browser-host-0.5.1.zip`. The directory can be loaded unpacked;
the ZIP is a packaging artifact, not a published Chrome Web Store release.

## Access and delivery

Required host access at installation is limited to Vega/local development origins.
Broad HTTP(S) access is declared in `optional_host_permissions` and is requested
only when the user clicks **Allow all websites** in the packaged popup. This is
separate from activation: content scripts and worker authorization still restrict
the bridge to Vega/local origins after the user grants all-site access.
Chrome requires target-server host access for extension fetch and header rules;
the optional grant covers provider/CDN domains that vary between sources.

Before approval, the popup is Inactive and privileged provider HTTP, media and
verification operations return a permission-needed error. Declining does not
trigger another prompt automatically. **Remove website access** revokes the
optional grant, cancels pending operations, closes an owned verification window
and clears playback rules/blob resources. Required Vega/local host declarations
remain. Re-approval is available through the popup; Chrome may remember a previous
approval and not show another native dialog. No permission is requested by the
website, provider code, startup or background requests.

Upgrades from older builds may retain already-approved broad access. Chrome's
current grant is authoritative; provider/source data is not changed on upgrade.
The `scripting` permission removes legacy custom-origin registrations on upgrade
and reads only the browser User-Agent and origin in the dedicated verification tab.
The `cookies` permission reads the fixed challenge cookie from that tab's private
store. `activeTab` and the manual connection flow are removed.

The Vega app origin is a trust boundary: scripts running in that app can use the
bridge. No bridge is exposed to unrelated sites, even if an older extension build
previously saved an approval for them.

The popup uses bundled 16/32/48/128px Vega icons derived from the existing
black-background `assets/logo-windows.png` artwork. The popup has no marketing
taglines. It displays the current tab's actual
bridge state, with an ON toolbar badge for active Vega tabs. No external fonts or
popup assets are fetched.

Provider metadata goes through the extension worker. Browser-profile cookies are
omitted; provider requests use Vega's source-author cookie jar. The app and worker
share cookie matching/parsing code, generated from `src/lib/providers/cookieRules.ts`.
Cookies honor host/domain, path, Secure and expiry rules, and reject public/private
suffix scopes using the pinned `tldts` suffix list. Legacy saved cookies are read
without rewriting them until the jar changes; missing historical path/Secure
metadata retains its previous root-path/non-Secure meaning.
Restricted headers are set with a temporary exact-URL rule limited to extension
requests. Header validation rejects connection/host/framing overrides. Requests
may include provider-supplied `Sec-CH-*` client hints and the four `Sec-Fetch-*`
metadata headers; these are applied through DNR and retained across redirects.
Other protocol-specific `Sec-*` overrides remain rejected. Requests
are serialized for header isolation, with bounded bodies and timeouts. Redirects
are followed explicitly. Cookies are selected anew for each destination from this
source's snapshot and intermediate Set-Cookie responses. The app stores redirect
updates against their actual response URLs. Authorization/custom secrets are
removed when crossing origins; cookies are never copied wholesale to the new host.

Playback data goes directly to Libmedia, outside the metadata message channel.
Media rules use integer IDs and match exact URLs, the app tab and initiator host.
They set the supplied headers, expose the response to the app origin and remove
Set-Cookie. HLS VOD playlists are fetched/rewritten into page-owned blob URLs;
variants, keys, initialization maps and segments receive individual rules.
Progressive files are probed with a single-byte range request and canceled after
response headers, resolving redirects and cookies before installing the final URL
rule. HLS playlist redirects also carry authentication forward to matching segment
and key URLs. Preparation cookies remain in the delivery operation, outside the
browser profile. Explicit media Cookie headers have host-only root scope; they do
not retain any server attributes lost when a provider supplies a plain header.
Stream bodies are not buffered in the service worker and playback uses neither an
mpv nor FFmpeg process.

Source replacement/player teardown releases delivery rules and blob URLs.
Navigation/disconnect/tab close clean up the document's rules. Leases renew while
connected and expire after two minutes if abandoned, checked by a periodic alarm.
Metadata requests can be canceled. The bridge reconnects after a worker restart;
an interrupted playback session may require reopening the stream.

## Provider verification windows

In Chrome's extension Details, manually enable **Allow in Incognito** for Vega,
then reload the Vega app tab. Vega never enables that permission automatically.
The extension uses spanning mode and requires no existing incognito windows before
creating its dedicated private window. There is no regular-profile fallback.

**Settings → Preferences → Provider verification windows** offers **Block**,
**Ask every time** (default) and **Allow**, shared with the Desktop app. Ask shows
the requesting provider, destination origin and a warning to enter personal
information only if you trust the provider. **Confirm** permits the request;
**Stop** cancels it. **Don't ask again** saves that choice for all providers:
Confirm saves Allow, and Stop saves Block. Allow still enforces private-session
isolation. Cached clearance can be reused without opening a window.

Browser verification accepts only `cf_clearance`, never arbitrary cookie names or
provider-supplied JavaScript. The worker selects the cookie store from the private
tab it created, checks that it differs from the app's normal store and reads only
that fixed cookie. It returns the clearance and browser User-Agent. Vega stores
them under the provider's source scope and obtains page HTML through isolated
provider HTTP; it never returns the private window's DOM or normal-profile login
cookies. Requests and stream headers using that live clearance use the captured
User-Agent rather than provider-supplied browser identity hints.

Only one verification can run at a time. Opening another incognito window, adding
tabs or navigating to another origin stops it. Cancellation, timeout (at most 90
seconds) and completion close only Vega's own window. Other incognito windows are
left open. Disabling/reloading the extension can interrupt cleanup; close any
remaining verification window manually before retrying. A challenge requiring
cross-origin navigation or additional cookies is unsupported by this adapter.
Passing these isolation checks does not guarantee a live WAF will accept a cookie
reused by extension HTTP.

Desktop retains its private Tauri WebView implementation behind the same consent
gate. It does not require this extension or Chrome's incognito permission.

## Provider runtime and destination checks

Provider execution belongs to the shared app's QuickJS/WASM runtime, never the
extension background worker. The app has no direct browser bindings inside that
VM. See [provider security](../docs/provider-security.md) for limits, module-hash
verification, production CSP and remaining trust boundaries.

Version 0.4.0 advertises `publicDestinationChecks`. The app rejects older hosts
for provider HTTP, interactive verification and protected media; reload both the
extension and app after upgrading. The worker checks public HTTP(S) destinations
on every metadata redirect and before media delivery/verification. Private,
loopback, link-local, special IPs and local names are blocked. DNS preflight uses
credential-free Cloudflare HTTPS DNS; empty, private or failed answers reject the
operation. Repeated media-resource hosts are checked once per preparation.

Chrome fetch cannot pin the socket to these DNS answers. Browser/proxy DNS may
change or differ, so this does not fully prevent DNS rebinding. Native provider
HTTP enforces its address policy inside the connection resolver. Production has
no local-target exception: extension tests explicitly copy the extension and
permit only their controlled ephemeral fixture servers in that temporary copy.

## Current limits

- This is an initial adapter, not a tested release for arbitrary providers.
  VMovies/Anikoto still need a fresh explicit live-provider validation pass.
- Supports progressive media and finite HLS VOD. Live/low-latency/variable/steered
  HLS and DRM are unsupported. A preparation is limited to 700 media resources,
  16 playlists and four levels of nesting; the extension caps active rules at 1000.
- Redirects that occur later during playback, including segment/key redirects,
  are blocked by removing Location. Resource URLs must remain stable after
  preparation. Cookies set only by media body responses are not consumed; initial
  file probes and playlist preparation handle their own cookie responses.
- Native Tauri redirect handling retains its native implementation. These browser
  tests do not prove equivalent intermediate-redirect behavior in that runtime.
- Metadata request/response bodies are limited to 8 MiB; operations time out at
  22 seconds. A tab cannot simultaneously lease the same media URL twice.
- Site-access restrictions, removing/updating the extension, or browser restart
  may interrupt playback. Permission-revocation and upgrade recovery need more
  testing. Browser mixed-content/CSP/network policies still apply.
- Chrome-family desktop browsers only. No Firefox, TV SDK or store-review claim.

## Checks

```powershell
npx playwright install chromium
npm run test:extension
```

The real-extension test verifies automatic localhost/production-domain activation,
Active/Inactive popup states and icons, unrelated-origin rejection (including old
approval data and forced legacy scripts), CORS/header handling,
manual/follow/cross-origin redirects, source-cookie isolation, cancellation,
authenticated multi-step redirects, cookie expiry/deletion/path persistence,
advancing direct and redirected MP4 and AES-128 HLS playback, seeks, another tab's isolation,
rule cleanup, reload/reconnection and history navigation. Popup screenshots are
saved with the test artifacts. All video is synthetic
and generated with the existing Desktop fixture tool, which is never used for
browser playback. Check for skips if that fixture tool is missing.

A separate real-Chromium verification test uses a controlled challenge fixture.
It verifies the missing-incognito-permission error, existing-window refusal,
clearance transfer, unchanged normal-profile cookies, public HTTP HTML instead of
private DOM, rejection of arbitrary cookie names, cancellation and a second
incognito window appearing mid-request. Unit checks also cover the native consent
queue and browser cookie-store selection. These do not establish live Cloudflare
compatibility or exercise a native Desktop verification window.

Optional-access tests verify fresh-install host grants, blocked operations,
popup requests made during a user gesture, decline feedback, retained approvals,
restart persistence and revocation cleanup. Native approval is a manual check:
decline is simulated at the API boundary, while approved cases use a temporary
profile upgraded from the previous required-host manifest. Chrome retains its
real grant for those cases; no actual user's browser profile is used or changed.

Implementation references: Chrome's [cross-origin request model](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests),
[DNR API](https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest)
and [webRequest response headers](https://developer.chrome.com/docs/extensions/reference/api/webRequest).
Playwright's [extension testing guide](https://playwright.dev/docs/chrome-extensions)
explains the persistent bundled-Chromium test context.
Cookie matching follows the relevant [RFC 6265 storage and path rules](https://www.rfc-editor.org/rfc/rfc6265.html);
the [tldts documentation](https://github.com/remusao/tldts) explains private suffix
handling. This custom provider jar does not claim full browser SameSite/partitioned
cookie semantics.
