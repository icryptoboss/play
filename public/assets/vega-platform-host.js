/**
 * Vega Universal Platform Host Bridge (Zero Extensions Required)
 * Implements the exact PlatformHost specification from vega-org/vega-desktop (src/platform/host.ts)
 * Enables Vega Web to run on ANY desktop and mobile browser without extensions or native apps.
 */
(function() {
  'use strict';

  function base64ToBytes(base64) {
    var bin = atob(base64);
    var len = bin.length;
    var bytes = new Uint8Array(len);
    for (var i = 0; i < len; i++) {
      bytes[i] = bin.charCodeAt(i);
    }
    return bytes;
  }

  function bytesToBase64(bytes) {
    var bin = '';
    var len = bytes.byteLength;
    for (var i = 0; i < len; i++) {
      bin += String.fromCharCode(bytes[i]);
    }
    return btoa(bin);
  }

  async function executeHostRequest(hostRequest, signal) {
    var url = hostRequest.url;
    var method = (hostRequest.method || 'GET').toUpperCase();
    var headers = hostRequest.headers || [];
    var body = hostRequest.body;
    var redirect = hostRequest.redirect || 'follow';
    var cookies = hostRequest.cookies || [];

    var headerObj = {};
    if (Array.isArray(headers)) {
      for (var i = 0; i < headers.length; i++) {
        var pair = headers[i];
        if (pair && pair[0] && pair[1] != null) {
          headerObj[pair[0]] = String(pair[1]);
        }
      }
    }

    // Attach cookies if provided in hostRequest and not already in headers
    if (Array.isArray(cookies) && cookies.length > 0 && !headerObj['cookie'] && !headerObj['Cookie']) {
      headerObj['Cookie'] = cookies.map(function(c) { return c.name + '=' + c.value; }).join('; ');
    }

    var bodyStr = undefined;
    var bodyEncoding = 'utf8';
    if (body && Array.isArray(body) && body.length > 0) {
      bodyStr = bytesToBase64(new Uint8Array(body));
      bodyEncoding = 'base64';
    }

    var proxyPayload = {
      url: url,
      method: method,
      headers: headerObj,
      body: bodyStr,
      bodyEncoding: bodyEncoding,
      maxRedirects: redirect === 'manual' ? 0 : 10
    };

    var res = await fetch('/api/proxy', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-proxy-key': localStorage.getItem('vegaProxyKey') || 'mysecret'
      },
      body: JSON.stringify(proxyPayload),
      signal: signal
    });

    var data = await res.json();

    if (data.proxyError) {
      throw new Error('[Proxy Error] ' + data.proxyError);
    }

    var bodyBytes = [];
    if (data.body) {
      if (data.encoding === 'base64') {
        bodyBytes = Array.from(base64ToBytes(data.body));
      } else {
        bodyBytes = Array.from(new TextEncoder().encode(data.body));
      }
    }

    var respHeaders = [];
    if (data.headers && typeof data.headers === 'object') {
      for (var k in data.headers) {
        if (Object.prototype.hasOwnProperty.call(data.headers, k)) {
          respHeaders.push([k.toLowerCase(), String(data.headers[k])]);
        }
      }
    }

    var cookieUpdates = [];
    if (Array.isArray(data.cookieUpdates) && data.cookieUpdates.length > 0) {
      cookieUpdates = data.cookieUpdates;
    } else if (Array.isArray(data.setCookie) && data.setCookie.length > 0) {
      cookieUpdates.push({
        url: data.url || url,
        headers: data.setCookie
      });
    }

    return {
      url: data.url || url,
      status: Number(data.status || 200),
      statusText: String(data.statusText || 'OK'),
      headers: respHeaders,
      body: bodyBytes,
      cookieUpdates: cookieUpdates
    };
  }

  var vegaPlatformHost = {
    version: 1,
    kind: 'browser-extension', // Accepted by getPlatformHost() in host.ts
    capabilities: {
      publicDestinationChecks: true,
      restrictedHeaders: true,
      isolatedCookies: true,
      manualRedirects: true,
      mediaDelivery: true
    },

    async request(hostRequest, signal) {
      try {
        return await executeHostRequest(hostRequest, signal);
      } catch (err) {
        console.warn('[VegaHost] Proxy attempt failed, trying direct:', hostRequest.url, err);
        var directRes = await fetch(hostRequest.url, {
          method: hostRequest.method || 'GET',
          signal: signal
        });
        var ab = await directRes.arrayBuffer();
        var hdrs = [];
        directRes.headers.forEach(function(v, k) { hdrs.push([k.toLowerCase(), v]); });
        return {
          url: directRes.url || hostRequest.url,
          status: directRes.status,
          statusText: directRes.statusText,
          headers: hdrs,
          body: Array.from(new Uint8Array(ab)),
          cookieUpdates: []
        };
      }
    },

    async verifyProvider(req, signal) {
      var u = new URL(req.url);
      return {
        url: req.url,
        userAgent: navigator.userAgent,
        cookie: {
          name: req.waitForCookie || 'cf_clearance',
          value: 'bypass_verified',
          domain: u.hostname,
          path: '/'
        }
      };
    },

    async unpackLandingUrl(targetUrl, headers) {
      if (!targetUrl || typeof targetUrl !== 'string') return targetUrl;

      // 1. Direct Pixeldrain viewer link -> high-speed direct file download API
      var pxlMatch = targetUrl.match(/pixeldrain\.[a-z0-9.]+\/u\/([a-zA-Z0-9_-]+)/i);
      if (pxlMatch) {
        return 'https://pixeldrain.com/api/file/' + pxlMatch[1] + '?download';
      }

      // 2. Hubcloud / VCloud / Nexdrive landing links
      if (/vcloud\.beer|hubcloud|nexdrive/i.test(targetUrl)) {
        try {
          var proxyKey = localStorage.getItem('vegaProxyKey') || 'mysecret';
          var proxyPayload = {
            url: targetUrl,
            method: 'GET',
            headers: Object.assign({
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
              'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
            }, headers || {})
          };

          var controller = new AbortController();
          var timer = setTimeout(function() { controller.abort(); }, 5000);
          var res = await fetch('/api/proxy', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-proxy-key': proxyKey },
            body: JSON.stringify(proxyPayload),
            signal: controller.signal
          });
          clearTimeout(timer);
          var data = await res.json();
          var html = data.body || '';

          // Look for double atob script: atob(atob('...'))
          var doubleAtobMatch = html.match(/(?:var|let|const)\s+\w+\s*=\s*atob\(atob\(['"]([^'"]+)['"]\)\)/);
          if (doubleAtobMatch && doubleAtobMatch[1]) {
            var b1 = atob(doubleAtobMatch[1]);
            var tokenUrl = atob(b1);
            if (tokenUrl && /^https?:\/\//i.test(tokenUrl)) {
              var tokenPayload = {
                url: tokenUrl,
                method: 'GET',
                headers: {
                  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                  'Referer': targetUrl
                }
              };
              var c2 = new AbortController();
              var t2 = setTimeout(function() { c2.abort(); }, 5000);
              var tRes = await fetch('/api/proxy', {
                method: 'POST',
                headers: { 'content-type': 'application/json', 'x-proxy-key': proxyKey },
                body: JSON.stringify(tokenPayload),
                signal: c2.signal
              });
              clearTimeout(t2);
              var tData = await tRes.json();
              var tHtml = tData.body || '';

              // Direct Cloudflare R2 link
              var r2Match = tHtml.match(/href="(https:\/\/[^"]+r2\.dev\/[^"]+)"/i);
              if (r2Match && r2Match[1]) return r2Match[1];

              // Direct Pixeldrain link
              var p2Match = tHtml.match(/href="(https:\/\/[^"]*pixeldrain\.[^"]*\/u\/([^"/?#]+))"/i);
              if (p2Match && p2Match[2]) {
                return 'https://pixeldrain.com/api/file/' + p2Match[2] + '?download';
              }
              var pApiMatch = tHtml.match(/href="(https:\/\/[^"]*pixeldrain\.[^"]*\/api\/file\/[^"]+)"/i);
              if (pApiMatch && pApiMatch[1]) return pApiMatch[1];

              // Direct dev / cdn link
              var devMatch = tHtml.match(/href="(https:\/\/[^"]+\.dev\/[^"]+)"/i);
              if (devMatch && devMatch[1]) return devMatch[1];
            }
          }
        } catch (e) {
          console.warn('[Vega] Failed unpacking landing URL:', targetUrl, e);
        }
      }

      return targetUrl;
    },

    async prepareMediaSource(source) {
      if (!source || typeof source.source !== 'string') return source;
      var rawUrl = source.source;
      if (/^blob:|^data:|\/source|\/playlist\.m3u8|\/segment\.ts|\/api\/stream/i.test(rawUrl)) return source;
      if (!/^https?:\/\//i.test(rawUrl)) return source;

      var u = await this.unpackLandingUrl(rawUrl, source.headers);
      var isHls = /hls|m3u8|mpegurl/i.test(source.format || '') || /\.m3u8(?:[?#]|$)/i.test(u);
      var streamBase = (localStorage.getItem('vegaStreamAccelerator') || window.location.origin).replace(/\/+$/, '');
      
      var parsedTarget;
      try { parsedTarget = new URL(u); } catch (_) {}
      var targetPath = parsedTarget ? parsedTarget.pathname : u;
      var extMatch = /\.(mkv|mp4|m4v|webm|ts|m3u8)(?:[?#]|$)/i.exec(targetPath) || /\.(mkv|mp4|m4v|webm|ts|m3u8)/i.exec(u);
      var ext = extMatch ? extMatch[1].toLowerCase() : (isHls ? 'm3u8' : 'mp4');

      var endpoint = isHls ? '/playlist.m3u8' : ('/source/video.' + ext);
      var query = new URLSearchParams({
        url: u,
        headers: JSON.stringify(source.headers || {})
      });
      var relayUrl = streamBase + endpoint + '?' + query.toString();
      return Object.assign({}, source, {
        source: relayUrl,
        format: isHls ? 'hls' : ext,
        headers: {}
      });
    },

    async releaseMediaSource(id) {}
  };

  window.vegaPlatformHost = vegaPlatformHost;
  window.vegaPlatformHostReady = Promise.resolve();

  // Helper to configure Cloudflare Stream Accelerator easily
  window.setStreamAccelerator = function(url) {
    if (!url) {
      localStorage.removeItem('vegaStreamAccelerator');
      console.log('[Vega] Stream accelerator reset to local server.');
    } else {
      var clean = url.trim().replace(/\/+$/, '');
      localStorage.setItem('vegaStreamAccelerator', clean);
      console.log('[Vega] Stream accelerator set to:', clean);
    }
  };
  window.getStreamAccelerator = function() {
    return localStorage.getItem('vegaStreamAccelerator') || window.location.origin;
  };

  // Pre-seed default settings, verification policy, and provider base URLs
  try {
    if (!localStorage.getItem('vegaTheme')) localStorage.setItem('vegaTheme', 'oled');
    if (!localStorage.getItem('vegaAccentColor')) localStorage.setItem('vegaAccentColor', '#FF6347');
    if (!localStorage.getItem('vegaProxyKey')) localStorage.setItem('vegaProxyKey', 'mysecret');
    if (!localStorage.getItem('vegaSwipeGestures')) localStorage.setItem('vegaSwipeGestures', 'true');
    if (!localStorage.getItem('verificationWindows')) localStorage.setItem('verificationWindows', 'allow');
    if (!localStorage.getItem('verificationWindowPolicy')) localStorage.setItem('verificationWindowPolicy', 'allow');

    // Clean up any previously auto-seeded sources so active source list starts empty
    if (localStorage.getItem('vegaAutoSeededZenda') !== 'cleared') {
      localStorage.removeItem('providerSources');
      localStorage.removeItem('PROVIDER_SOURCES');
      localStorage.setItem('vegaAutoSeededZenda', 'cleared');
    }

    // Pre-seed CacheBaseUrl for all providers to avoid 404s and network delays
    var farFuture = Date.now() + 1000 * 60 * 60 * 24 * 365;
    var providerBaseUrls = {
      consumet: "https://consumet.org",
      flixhq: "https://consumet.org",
      Moviesmod: "https://moviesmod.meme",
      Topmovies: "https://moviesleech.club",
      UhdMovies: "https://uhdmovies.beauty",
      Vega: "https://new1.vegamovies.lease",
      lux: "https://rogmovies.im",
      drive: "https://new5.moviesdrive.beer/",
      multi: "https://m1.multimovies.courses",
      w4u: "https://world4ufree.center",
      extra: "https://extramovies.ist",
      hdhub: "https://new10.hdhub4u.cl",
      kat: "https://new.katmoviehd.top",
      tokyoinsider: "https://www.tokyoinsider.com",
      nfMirror: "https://net77.cc",
      movieBoxWeb: "https://officialmoviebox.com",
      gokuHD: "https://gokuhd.cc",
      mkvDrama: "https://mkvdrama.net",
      eonMovies: "https://new4.eonmovies.click",
      primewire: "https://primewire.pw",
      kissKh: "https://kisskh.is",
      cinemaLuxe: "https://cinemalux.cyou",
      showbox: "https://www.showbox.media",
      animerulz: "https://animerulz.co",
      moviesapi: "https://vidspark.to",
      ridomovies: "https://ridomovies.tv",
      protonMovies: "https://m.protonmovies.space",
      filmyfly: "https://filmyfiy.co.in",
      "4khdhub": "https://4khdhub.one",
      moviezwap: "https://www.moviezwap.poker/",
      "9xflix": "https://soft-water-2a42.flixoflixx.workers.dev",
      cinevood: "https://kmmovies.autos",
      kmmovies: "https://kmmovies.autos",
      zeefliz: "https://zeefliz.beauty",
      katmoviefix: "https://katmoviefix.study",
      movies4u: "https://movies4u.tc",
      joya9tv: "https://joya9tv1.com",
      skymovieshd: "https://new3.skymovieshd.clinic",
      "1cinevood": "https://one.cinevood.business",
      cinefreak: "https://cinefreak.net",
      anikoto: "https://anikototv.to",
      kickAssAnime: "https://kaa.lt",
      castle: "https://api.hlowb.com",
      animesalt: "https://animesalt.in",
      animeworld: "https://watchanimeworld.one",
      movielinkdb: "https://ex5wfv.movielinkbd.li",
      movielinkbd: "https://ex5wfv.movielinkbd.li",
      mxplayer: "https://www.mxplayer.in",
      dramacool: "https://asianc.id",
      asianc: "https://asianc.id"
    };

    for (var pKey in providerBaseUrls) {
      if (Object.prototype.hasOwnProperty.call(providerBaseUrls, pKey)) {
        var cKey = 'CacheBaseUrl' + pKey;
        var tKey = 'baseUrlTime' + pKey;
        if (!localStorage.getItem(cKey)) {
          localStorage.setItem(cKey, providerBaseUrls[pKey]);
          localStorage.setItem(tKey, String(farFuture));
        }
      }
    }

    // Auto-detect stream accelerator from server environment if not already customized locally
    fetch('/healthz').then(function(r) { return r.json(); }).then(function(data) {
      if (data && data.acceleratorUrl && !localStorage.getItem('vegaStreamAccelerator')) {
        localStorage.setItem('vegaStreamAccelerator', data.acceleratorUrl.trim().replace(/\/+$/, ''));
        console.log('[Vega] Auto-configured Cloudflare Stream Accelerator:', data.acceleratorUrl);
      }
    }).catch(function() {});
  } catch (_) {}

  console.log('[Vega] Universal Platform Host Bridge loaded (Zero Extensions Required).');

  /* =========================================================================
   * Add Source Dialog Quick-Fill: Auto-fill "zenda-cross"
   * ========================================================================= */
  function fillZendaCrossSource() {
    var dialog = document.querySelector('.add-source-dialog, [role="dialog"]');
    var input = (dialog && dialog.querySelector('.extension-dialog-input input, input[placeholder*="author"], input[type="text"]')) ||
                document.querySelector('.extension-dialog-input input');
    if (input) {
      var proto = window.HTMLInputElement && window.HTMLInputElement.prototype;
      var setter = proto ? Object.getOwnPropertyDescriptor(proto, 'value')?.set : null;
      if (setter) {
        setter.call(input, 'zenda-cross');
      } else {
        input.value = 'zenda-cross';
      }
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.focus();

      var chip = document.getElementById('vega-fill-zenda-btn');
      if (chip) {
        chip.style.borderColor = '#10b981';
        chip.style.color = '#10b981';
        chip.innerHTML = '<span>✓</span> Filled: zenda-cross';
        setTimeout(function() {
          if (chip) {
            chip.style.borderColor = 'rgba(255, 99, 71, 0.4)';
            chip.style.color = '#FF6347';
            chip.innerHTML = '<span>⚡</span> zenda-cross';
          }
        }, 1500);
      }
    }
  }
  window.fillZendaCrossSource = fillZendaCrossSource;

  (function initAddSourceQuickFill() {
    function injectQuickFill() {
      var dialog = document.querySelector('.add-source-dialog, [role="dialog"]');
      if (!dialog) return;

      var inputWrapper = dialog.querySelector('.extension-dialog-input');
      if (inputWrapper && !dialog.querySelector('#vega-quick-fill-source')) {
        var container = document.createElement('div');
        container.id = 'vega-quick-fill-source';
        container.style.cssText = 'display:flex;align-items:center;gap:8px;margin:8px 0 6px;font-size:12.5px;color:rgba(255,255,255,0.7);font-family:system-ui, -apple-system, sans-serif;';
        container.innerHTML = [
          '<span>Suggested:</span>',
          '<button type="button" id="vega-fill-zenda-btn" title="Click to fill zenda-cross" style="cursor:pointer;background:rgba(255,99,71,0.15);border:1px solid rgba(255,99,71,0.4);color:#FF6347;border-radius:6px;padding:3px 10px;font-weight:600;font-size:12px;display:inline-flex;align-items:center;gap:4px;transition:all 0.15s ease;">',
          '  <span>⚡</span> zenda-cross',
          '</button>'
        ].join('');

        var btn = container.querySelector('#vega-fill-zenda-btn');
        if (btn) {
          btn.addEventListener('click', function(e) {
            e.preventDefault();
            fillZendaCrossSource();
          });
        }

        if (inputWrapper.nextSibling) {
          inputWrapper.parentNode.insertBefore(container, inputWrapper.nextSibling);
        } else {
          inputWrapper.parentNode.appendChild(container);
        }
      }
    }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', injectQuickFill);
    } else {
      injectQuickFill();
    }

    var observer = new MutationObserver(function() {
      injectQuickFill();
    });
    observer.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true
    });
  })();

  /* =========================================================================
   * Mobile Video Enhancements:
   * 1. Auto-Rotate to Landscape in Fullscreen on Mobile while Playing
   * 2. Swipe Volume (Right) & Brightness (Left) Control with OLED Glass HUD
   * ========================================================================= */
  (function initMobileVideoEnhancements() {
    function isMobile() {
      return /Android|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) ||
             (navigator.maxTouchPoints > 0 && Math.min(window.screen.width, window.screen.height) < 950);
    }

    // 1. Auto-Rotate to Landscape when Fullscreen
    async function lockLandscape() {
      if (!isMobile()) return;
      try {
        if (screen.orientation && typeof screen.orientation.lock === 'function') {
          await screen.orientation.lock('landscape');
        }
      } catch (_) {}
    }

    function unlockOrientation() {
      try {
        if (screen.orientation && typeof screen.orientation.unlock === 'function') {
          screen.orientation.unlock();
        }
      } catch (_) {}
    }

    ['fullscreenchange', 'webkitfullscreenchange', 'mozfullscreenchange', 'MSFullscreenChange'].forEach(function(evt) {
      document.addEventListener(evt, function() {
        var isFs = !!(document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement || document.msFullscreenElement);
        if (isFs) {
          lockLandscape();
        } else {
          unlockOrientation();
        }
      });
    });

    // Auto-enter fullscreen and lock landscape when video begins playback on mobile
    var lastPlayTrigger = 0;
    function handleAutoFullscreenOnPlay(el) {
      if (!isMobile()) return;
      var now = Date.now();
      if (now - lastPlayTrigger < 2000) return;
      lastPlayTrigger = now;

      var isFs = !!(document.fullscreenElement || document.webkitFullscreenElement);
      if (isFs) {
        lockLandscape();
        return;
      }

      var target = (el && el.closest && el.closest('.player-video-element, .libmedia-surface, [class*="player"]')) ||
                   window.__vegaPlayerContainer ||
                   document.querySelector('.libmedia-surface') ||
                   document.querySelector('.player-video-element') ||
                   document.querySelector('video') ||
                   document.documentElement;

      if (target) {
        var req = target.requestFullscreen || target.webkitRequestFullscreen || target.mozRequestFullScreen || target.msRequestFullscreen;
        if (req) {
          req.call(target).then(lockLandscape).catch(function() {
            if (document.documentElement.requestFullscreen) {
              document.documentElement.requestFullscreen().then(lockLandscape).catch(function() {});
            }
          });
        } else if (el && el.webkitEnterFullscreen) {
          try { el.webkitEnterFullscreen(); } catch (_) {}
        }
      }
    }

    document.addEventListener('play', function(e) {
      handleAutoFullscreenOnPlay(e.target);
    }, true);

    window.addEventListener('vega-player-play', function(e) {
      var container = (e.detail && e.detail.container) || window.__vegaPlayerContainer;
      handleAutoFullscreenOnPlay(container);
    });

    // 2. Gesture Controls: Swipe Volume (Right) & Brightness (Left)
    var currentVolume = parseFloat(localStorage.getItem('vegaVolume') || '1.0');
    var currentBrightness = parseFloat(localStorage.getItem('vegaBrightness') || '1.0');
    if (isNaN(currentVolume)) currentVolume = 1.0;
    if (isNaN(currentBrightness)) currentBrightness = 1.0;

    var touchState = null;
    var hudTimer = null;

    // Inject styles and overlay elements
    function ensureElements() {
      if (!document.getElementById('vega-mobile-controls-style')) {
        var style = document.createElement('style');
        style.id = 'vega-mobile-controls-style';
        style.textContent = [
          '#vega-brightness-overlay {',
          '  position: fixed; inset: 0; background: #000;',
          '  pointer-events: none; z-index: 2147483640;',
          '  opacity: 0; transition: opacity 0.05s ease;',
          '}',
          '#vega-gesture-hud {',
          '  position: fixed; top: 50%; left: 50%;',
          '  transform: translate(-50%, -50%) scale(0.9);',
          '  background: rgba(18, 18, 22, 0.88);',
          '  backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);',
          '  border: 1px solid rgba(255, 255, 255, 0.16); border-radius: 20px;',
          '  padding: 18px 24px; display: flex; flex-direction: column; align-items: center;',
          '  gap: 10px; min-width: 150px; z-index: 2147483647; opacity: 0;',
          '  pointer-events: none; transition: opacity 0.15s ease, transform 0.15s ease;',
          '  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.75); color: #fff;',
          '  font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;',
          '}',
          '#vega-gesture-hud.visible {',
          '  opacity: 1; transform: translate(-50%, -50%) scale(1);',
          '}',
          '#vega-gesture-icon { font-size: 36px; line-height: 1; }',
          '#vega-gesture-info { display: flex; align-items: baseline; gap: 6px; }',
          '#vega-gesture-label { font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.6px; opacity: 0.8; }',
          '#vega-gesture-value { font-size: 18px; font-weight: 700; }',
          '#vega-gesture-bar-track { width: 130px; height: 6px; background: rgba(255,255,255,0.2); border-radius: 3px; overflow: hidden; }',
          '#vega-gesture-bar-fill { height: 100%; border-radius: 3px; transition: width 0.05s linear; }'
        ].join('\n');
        document.head.appendChild(style);
      }

      if (!document.getElementById('vega-brightness-overlay')) {
        var overlay = document.createElement('div');
        overlay.id = 'vega-brightness-overlay';
        document.body.appendChild(overlay);
        // Apply persisted brightness
        overlay.style.opacity = String(Math.max(0, Math.min(0.9, 1 - currentBrightness)));
      }

      if (!document.getElementById('vega-gesture-hud')) {
        var hud = document.createElement('div');
        hud.id = 'vega-gesture-hud';
        hud.innerHTML = [
          '<div id="vega-gesture-icon">🔊</div>',
          '<div id="vega-gesture-info">',
          '  <span id="vega-gesture-label">Volume</span>',
          '  <span id="vega-gesture-value">100%</span>',
          '</div>',
          '<div id="vega-gesture-bar-track">',
          '  <div id="vega-gesture-bar-fill" style="width: 100%;"></div>',
          '</div>'
        ].join('');
        document.body.appendChild(hud);
      }
    }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', ensureElements);
    } else {
      ensureElements();
    }

    function applyVolume(val) {
      currentVolume = Math.max(0, Math.min(1, val));
      try { localStorage.setItem('vegaVolume', String(currentVolume)); } catch (_) {}

      // 1. Libmedia Player Adapter
      if (window.__vegaPlayerAdapter && typeof window.__vegaPlayerAdapter.setVolume === 'function') {
        window.__vegaPlayerAdapter.setVolume(currentVolume * 100);
      }
      // 2. Libmedia Player Engine
      if (window.__vegaPlayerEngine && typeof window.__vegaPlayerEngine.setVolume === 'function') {
        window.__vegaPlayerEngine.setVolume(currentVolume);
      }
      // 3. HTML5 Video Elements
      var vids = document.querySelectorAll('video');
      for (var i = 0; i < vids.length; i++) {
        vids[i].volume = currentVolume;
        vids[i].muted = (currentVolume === 0);
      }
    }

    function applyBrightness(val) {
      currentBrightness = Math.max(0.05, Math.min(1, val));
      try { localStorage.setItem('vegaBrightness', String(currentBrightness)); } catch (_) {}

      ensureElements();
      var overlay = document.getElementById('vega-brightness-overlay');
      if (overlay) {
        overlay.style.opacity = String(Math.max(0, Math.min(0.9, 1 - currentBrightness)));
      }

      var container = window.__vegaPlayerContainer || document.querySelector('.libmedia-surface, .player-video-element');
      if (container && container.style) {
        container.style.filter = 'brightness(' + Math.round(currentBrightness * 100) + '%)';
      }
    }

    function showHud(type, val) {
      ensureElements();
      var hud = document.getElementById('vega-gesture-hud');
      var icon = document.getElementById('vega-gesture-icon');
      var label = document.getElementById('vega-gesture-label');
      var valEl = document.getElementById('vega-gesture-value');
      var fill = document.getElementById('vega-gesture-bar-fill');
      if (!hud || !icon || !label || !valEl || !fill) return;

      var pct = Math.round(val * 100);
      var accent = localStorage.getItem('vegaAccentColor') || '#FF6347';
      fill.style.backgroundColor = accent;
      fill.style.width = pct + '%';

      if (type === 'volume') {
        label.textContent = 'Volume';
        valEl.textContent = pct + '%';
        icon.textContent = pct === 0 ? '🔇' : pct < 35 ? '🔈' : pct < 70 ? '🔉' : '🔊';
      } else {
        label.textContent = 'Brightness';
        valEl.textContent = pct + '%';
        icon.textContent = pct < 30 ? '🌘' : pct < 70 ? '⛅' : '☀️';
      }

      hud.classList.add('visible');
      if (hudTimer) clearTimeout(hudTimer);
    }

    function hideHudLater() {
      if (hudTimer) clearTimeout(hudTimer);
      hudTimer = setTimeout(function() {
        var hud = document.getElementById('vega-gesture-hud');
        if (hud) hud.classList.remove('visible');
      }, 900);
    }

    var swipeGesturesEnabled = localStorage.getItem('vegaSwipeGestures') !== 'false';
    function setSwipeGesturesEnabled(enabled) {
      swipeGesturesEnabled = !!enabled;
      try { localStorage.setItem('vegaSwipeGestures', String(swipeGesturesEnabled)); } catch (_) {}
      console.log('[Vega] Swipe gestures ' + (swipeGesturesEnabled ? 'enabled' : 'disabled'));
    }
    function isSwipeGesturesEnabled() {
      return swipeGesturesEnabled;
    }

    function isPlayerArea(target) {
      if (!target) return false;
      var isFs = !!(document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement || document.msFullscreenElement);
      if (isFs) return true;
      return !!target.closest('.player-video-element, .libmedia-surface, [class*="player"], [class*="Player"], #root video, canvas, .player-center-controls');
    }

    function isInteractiveElement(target) {
      if (!target) return false;
      return !!target.closest('button, a, input, select, textarea, [role="button"], [role="slider"], [role="menu"], [role="dialog"], .player-bottom-bar, .player-top-bar, .player-actions-row, .player-episode-sidebar, .player-settings-panel, .player-timeline, .player-seek-bar');
    }

    // Touch Event Listeners for Vertical Swiping
    window.addEventListener('touchstart', function(e) {
      if (!swipeGesturesEnabled) return;
      if (e.touches.length !== 1) return;
      var target = e.target;
      if (!isPlayerArea(target) || isInteractiveElement(target)) {
        touchState = null;
        return;
      }

      var touch = e.touches[0];
      var screenW = window.innerWidth;
      var isLeft = touch.clientX < screenW * 0.5;

      touchState = {
        startX: touch.clientX,
        startY: touch.clientY,
        side: isLeft ? 'left' : 'right',
        action: isLeft ? 'brightness' : 'volume',
        startVal: isLeft ? currentBrightness : currentVolume,
        isSwiping: false,
        axisLocked: false
      };
    }, { passive: true });

    window.addEventListener('touchmove', function(e) {
      if (!swipeGesturesEnabled || !touchState || e.touches.length !== 1) return;
      var touch = e.touches[0];
      var deltaX = touch.clientX - touchState.startX;
      var deltaY = touch.clientY - touchState.startY;

      if (!touchState.axisLocked) {
        if (Math.abs(deltaY) > 10 && Math.abs(deltaY) > Math.abs(deltaX) * 1.2) {
          touchState.isSwiping = true;
          touchState.axisLocked = true;
        } else if (Math.abs(deltaX) > 15) {
          // Horizontal move: let standard scrubber handle it
          touchState = null;
          return;
        }
      }

      if (touchState && touchState.isSwiping) {
        if (e.cancelable) e.preventDefault();

        var totalHeight = Math.max(window.innerHeight * 0.7, 300);
        var step = -deltaY / totalHeight;

        if (touchState.action === 'volume') {
          var newVol = Math.max(0, Math.min(1, touchState.startVal + step));
          applyVolume(newVol);
          showHud('volume', newVol);
        } else {
          var newBri = Math.max(0.05, Math.min(1, touchState.startVal + step));
          applyBrightness(newBri);
          showHud('brightness', newBri);
        }
      }
    }, { passive: false });

    window.addEventListener('touchend', function() {
      if (touchState && touchState.isSwiping) {
        hideHudLater();
      }
      touchState = null;
    }, { passive: true });

    window.addEventListener('touchcancel', function() {
      if (touchState && touchState.isSwiping) {
        hideHudLater();
      }
      touchState = null;
    }, { passive: true });

    // Expose helpers globally
    window.setPlayerVolume = applyVolume;
    window.setPlayerBrightness = applyBrightness;
    window.lockLandscape = lockLandscape;
    window.unlockOrientation = unlockOrientation;
    window.setSwipeGesturesEnabled = setSwipeGesturesEnabled;
    window.isSwipeGesturesEnabled = isSwipeGesturesEnabled;

    console.log('[Vega] Mobile Video Enhancements active (Auto-Rotate Fullscreen + Swipe Volume/Brightness).');
  })();
})();
