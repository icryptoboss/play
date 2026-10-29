/**
 * Vega Web - Core Client Application
 * Fully Integrated with Libmedia Player Engine, Scraper Providers, and Vega Design System
 */
(function () {
  "use strict";

  /* =====================================================================
   * Storage & Persistence Utilities
   * ===================================================================== */
  var KEY = "vega:";
  function load(k, def) {
    try {
      var v = localStorage.getItem(KEY + k);
      return v == null ? def : JSON.parse(v);
    } catch (e) {
      return def;
    }
  }
  function save(k, val) {
    try {
      localStorage.setItem(KEY + k, JSON.stringify(val));
    } catch (e) {}
  }
  function esc(s) {
    return String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }
  function enc(s) { return encodeURIComponent(s); }
  function fmtTime(sec) {
    if (!sec || isNaN(sec) || sec < 0) return "0:00";
    var m = Math.floor(sec / 60);
    var s = Math.floor(sec % 60);
    if (m >= 60) {
      var h = Math.floor(m / 60);
      m = m % 60;
      return h + ":" + (m < 10 ? "0" : "") + m + ":" + (s < 10 ? "0" : "") + s;
    }
    return m + ":" + (s < 10 ? "0" : "") + s;
  }
  function safeUrl(u) {
    if (!u || typeof u !== "string") return "";
    u = u.trim();
    if (/^https?:\/\//i.test(u) || /^data:image\//i.test(u) || /^\//.test(u)) return u;
    return "";
  }

  /* =====================================================================
   * Application State
   * ===================================================================== */
  var S = {
    theme: load("theme", "oled"),
    accentColor: load("accentColor", "#FF6347"),
    uiScale: load("uiScale", 100),
    sidebarCollapsed: load("sidebarCollapsed", false),
    currentRoute: "home",
    catalogFilter: "all",
    catalogGenre: "all",
    repos: load("repos", []),
    providers: load("providers", []),
    off: load("off", {}),
    provider: load("provider", ""),
    watchlist: load("wl", [
      "dune-part-two", "cyberpunk-edgerunners", "interstellar"
    ]),
    progress: load("prog", {}),
    custom: load("custom", []),
    sources: load("sources", []),
    proxy: (function () {
      var p = load("proxy", { url: "/api/proxy", key: "mysecret" });
      if (!p.key) p.key = "mysecret";
      return p;
    })(),
    prefs: load("prefs", { autoPick: false, autoNext: true, preferLibmedia: true }),
    subtitleConfig: load("subConfig", { size: 18, color: "#ffffff", bgOpacity: 0.4 })
  };

  var cache = new Map();
  function cachedFn(map, key, ttl, fn) {
    var hit = map.get(key);
    var now = Date.now();
    if (hit && hit.exp > now) return hit.val;
    var p = fn();
    map.set(key, { exp: now + ttl, val: p });
    p.catch(function () { map.delete(key); });
    return p;
  }

  /* =====================================================================
   * Vega Theme & Appearance Engine
   * ===================================================================== */
  function hexToRgb(hex) {
    var c = hex.replace("#", "");
    if (c.length === 3) c = c.split("").map(function (x) { return x + x; }).join("");
    var num = parseInt(c, 16);
    return ((num >> 16) & 255) + ", " + ((num >> 8) & 255) + ", " + (num & 255);
  }

  function applyTheme(themeName) {
    S.theme = themeName;
    document.documentElement.setAttribute("data-theme", themeName);
    document.body.setAttribute("data-theme", themeName);
    save("theme", themeName);

    document.querySelectorAll(".theme-btn").forEach(function (btn) {
      btn.classList.toggle("active", btn.dataset.theme === themeName);
    });
  }

  function applyAccentColor(hex) {
    S.accentColor = hex;
    var rgb = hexToRgb(hex);
    document.documentElement.style.setProperty("--primary", hex);
    document.documentElement.style.setProperty("--primary-rgb", rgb);
    document.documentElement.style.setProperty("--primary-hover", hex);
    document.documentElement.style.setProperty("--primary-container", "rgba(" + rgb + ", 0.16)");
    save("accentColor", hex);

    document.querySelectorAll(".accent-color-btn").forEach(function (btn) {
      btn.classList.toggle("active", btn.dataset.color.toLowerCase() === hex.toLowerCase());
    });
  }

  function applyUiScale(scale) {
    S.uiScale = scale;
    document.documentElement.style.zoom = scale + "%";
    save("uiScale", scale);
  }

  function applySidebarState() {
    var appShell = document.querySelector(".app-shell");
    var sidebar = document.querySelector(".sidebar");
    if (!sidebar || !appShell) return;
    if (S.sidebarCollapsed) {
      sidebar.classList.add("collapsed");
      appShell.classList.add("sidebar-collapsed");
    } else {
      sidebar.classList.remove("collapsed");
      appShell.classList.remove("sidebar-collapsed");
    }
    save("sidebarCollapsed", S.sidebarCollapsed);
  }

  function updateWatchlistBadge() {
    var countEl = document.getElementById("sidebar-watchlist-count");
    if (countEl) {
      countEl.textContent = Array.isArray(S.watchlist) ? S.watchlist.length : 0;
    }
  }

  function showToast(message, type) {
    var container = document.getElementById("toast-container");
    if (!container) return;
    var toast = document.createElement("div");
    toast.className = "toast" + (type ? " toast-" + type : "");
    toast.innerHTML = "<div style='width:8px;height:8px;border-radius:50%;background-color:var(--primary);flex-shrink:0;'></div><span>" + esc(message) + "</span>";
    container.appendChild(toast);
    setTimeout(function () {
      toast.style.opacity = "0";
      toast.style.transform = "translateY(10px)";
      toast.style.transition = "all 0.25s ease";
      setTimeout(function () { toast.remove(); }, 250);
    }, 3200);
  }

  /* =====================================================================
   * Provider Web Worker & RPC Engine
   * ===================================================================== */
  var Prov = (function () {
    var worker, seq = 0, waiting = new Map(), codeCache = new Map();

    function kvKey(provider, key) { return KEY + "kv:" + provider + ":" + key; }
    function kv(provider, op, key, value) {
      var prefix = KEY + "kv:" + provider + ":";
      try {
        if (op === "get") { var v = localStorage.getItem(kvKey(provider, key)); return v == null ? undefined : JSON.parse(v); }
        if (op === "set") { if (value === undefined) localStorage.removeItem(kvKey(provider, key)); else localStorage.setItem(kvKey(provider, key), JSON.stringify(value)); return undefined; }
        if (op === "delete") { var had = localStorage.getItem(kvKey(provider, key)) != null; localStorage.removeItem(kvKey(provider, key)); return had; }
        var keys = [];
        for (var i = 0; i < localStorage.length; i++) { var k = localStorage.key(i); if (k.indexOf(prefix) === 0) keys.push(k); }
        if (op === "keys") return keys.map(function (k) { return k.slice(prefix.length); });
        if (op === "clear") { keys.forEach(function (k) { localStorage.removeItem(k); }); return undefined; }
      } catch (e) {}
      return undefined;
    }

    function ensure() {
      if (worker) return worker;
      worker = new Worker("provider-worker.js");
      worker.onmessage = function (e) {
        var m = e.data;
        if (m.type === "kv") worker.postMessage({ type: "kvResult", r: m.r, result: kv(m.provider, m.op, m.key, m.value) });
        else if (m.type === "result") {
          var w = waiting.get(m.id);
          if (w) { waiting.delete(m.id); clearTimeout(w.timer); w.resolve(m); }
        }
      };
      worker.onerror = function (e) {
        var err = new Error("Provider runtime: " + (e.message || "unknown worker error"));
        waiting.forEach(function (w) { clearTimeout(w.timer); w.reject(err); });
        waiting.clear(); worker = null;
      };
      return worker;
    }

    function rpc(msg, timeout) {
      return new Promise(function (resolve, reject) {
        var w = ensure(), id = ++seq;
        var timer = setTimeout(function () {
          w.postMessage({ type: "cancel", id: id });
          waiting.delete(id);
          reject(new Error("Provider request timed out"));
        }, timeout || 45000);
        waiting.set(id, { resolve: resolve, reject: reject, timer: timer });
        msg.type = "call"; msg.id = id;
        w.postMessage(msg);
      });
    }

    function fetchCode(p, module) {
      var key = p.base + "|" + p.value + "|" + p.version + "|" + module;
      return cachedFn(codeCache, key, 1e12, function () {
        var base = p.base.replace(/\/+$/, "") + "/";
        return fetch(base + "dist/" + p.value + "/" + module + ".js", { cache: "no-cache" }).then(function (r) {
          if (r.status === 404) throw new Error("Provider '" + p.display_name + "' has no " + module + " module");
          if (!r.ok) throw new Error("HTTP " + r.status + " fetching " + module + ".js");
          return r.text();
        });
      });
    }

    function call(p, module, fn, args, timeout) {
      var key = p.base + "|" + p.value + "|" + p.version + "|" + module;
      var cfg = { proxyUrl: S.proxy.url || "/api/proxy", proxyKey: (S.proxy && S.proxy.key) || "mysecret" };
      var base = { provider: p.value, module: module, fn: fn, args: args || {}, key: key, cfg: cfg };
      return rpc(Object.assign({}, base), timeout).then(function (r) {
        if (!r.needCode) return r;
        return fetchCode(p, module).then(function (code) { return rpc(Object.assign({}, base, { code: code }), timeout); });
      }).then(function (r) {
        if (!r.ok) throw new Error(r.error && r.error.message || "Provider error");
        return r.result;
      });
    }

    return { call: call, kv: kv };
  })();

  function activeProviders() {
    return S.providers.filter(function (p) { return !p.disabled && !S.off[p.value]; });
  }
  function provById(v) {
    return S.providers.filter(function (p) { return p.value === v; })[0];
  }
  function curProvider() {
    var a = activeProviders();
    var p = provById(S.provider);
    return (p && a.indexOf(p) !== -1) ? p : a[0];
  }

  function fillProviderSelect() {
    var sel = document.getElementById("provsel");
    if (!sel) return;
    var a = activeProviders();
    var cur = curProvider();
    sel.innerHTML = "<option value=''>Showcase Catalog (Built-in)</option>" +
      a.map(function (p) {
        return "<option value='" + esc(p.value) + "'" + (cur && cur.value === p.value ? " selected" : "") + ">" +
          esc(p.display_name || p.value) + " (" + esc(p.type || "global") + ")</option>";
      }).join("");

    sel.onchange = function (e) {
      S.provider = e.target.value;
      save("provider", S.provider);
      navigateTo(S.currentRoute);
    };
  }

  /* =====================================================================
   * Repository & Manifest Engine (with GitHub Pages & Raw Fallback)
   * ===================================================================== */
  var RAW = function (o, r, b) { return "https://raw.githubusercontent.com/" + o + "/" + r + "/" + b + "/"; };
  var GHPAGES = function (o, r) { return "https://" + o.toLowerCase() + ".github.io/" + r + "/"; };

  function repoCandidates(input) {
    input = (input || "").trim();
    var m;
    if (/^https?:\/\//i.test(input)) {
      var u; try { u = new URL(input); } catch (e) { return []; }
      if (u.hostname === "github.com") {
        var parts = u.pathname.split("/").filter(Boolean);
        var owner = parts[0];
        var repo = (parts[1] || "vega-providers").replace(/\.git$/, "");
        var branches = parts[2] === "tree" && parts[3] ? [parts[3]] : ["main", "master", "gh-pages"];
        var list = [GHPAGES(owner, repo)];
        branches.forEach(function (b) { list.push(RAW(owner, repo, b)); });
        return list;
      }
      var b = input.replace(/\/manifest\.json.*$/, "").replace(/\/+$/, "") + "/";
      return [b];
    }
    if ((m = input.match(/^([\w.-]+)\/([\w.-]+)$/))) {
      var o = m[1], r = m[2];
      return [GHPAGES(o, r), RAW(o, r, "main"), RAW(o, r, "master"), RAW(o, r, "gh-pages")];
    }
    if (/^[\w-]+$/.test(input)) {
      return [GHPAGES(input, "vega-providers"), RAW(input, "vega-providers", "main"), RAW(input, "vega-providers", "master")];
    }
    return [];
  }

  function fetchManifest(base) {
    var url = base.replace(/\/+$/, "") + "/manifest.json";
    return fetch(url, { cache: "no-cache" }).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    }).then(function (j) {
      if (!Array.isArray(j)) throw new Error("manifest.json must be an array of providers");
      return j.filter(function (e) { return e && typeof e.value === "string" && /^[\w.-]+$/.test(e.value); });
    });
  }

  function addRepo(input) {
    var cands = repoCandidates(input);
    if (!cands.length) return Promise.reject(new Error("Please enter a valid GitHub username, repository (owner/repo), or URL"));
    var i = 0;
    function tryNext() {
      if (i >= cands.length) return Promise.reject(new Error("Could not find a valid manifest.json. Verify the repository name."));
      var base = cands[i++];
      return fetchManifest(base).then(function (entries) {
        return { base: base, entries: entries };
      }, tryNext);
    }
    return tryNext().then(function (r) {
      if (S.repos.some(function (x) { return x.base === r.base; })) throw new Error("This repository is already installed");
      if (!r.entries.length) throw new Error("The repository manifest contains no providers");
      S.repos.push({ base: r.base, name: input });
      save("repos", S.repos);
      return refreshProviders().then(function () {
        return r.entries.length;
      });
    });
  }

  function removeRepo(idx) {
    var r = S.repos.splice(idx, 1)[0];
    save("repos", S.repos);
    S.providers = S.providers.filter(function (p) { return p.base !== r.base; });
    save("providers", S.providers);
    fillProviderSelect();
    renderExtensionsView();
    showToast("Repository removed");
  }

  function refreshProviders() {
    if (!S.repos.length) return Promise.resolve();
    return Promise.all(S.repos.map(function (r) {
      return fetchManifest(r.base).then(function (entries) {
        return entries.map(function (e) {
          return Object.assign({}, e, {
            base: r.base,
            display_name: e.display_name || e.value,
            version: String(e.version || "1.0")
          });
        });
      }, function (err) {
        console.warn("Failed to refresh repository:", r.base, err);
        return S.providers.filter(function (p) { return p.base === r.base; });
      });
    })).then(function (lists) {
      S.providers = [].concat.apply([], lists);
      save("providers", S.providers);
      if (!curProvider() && activeProviders()[0]) {
        S.provider = activeProviders()[0].value;
        save("provider", S.provider);
      }
      fillProviderSelect();
    });
  }

  /* =====================================================================
   * Provider Settings Modal
   * ===================================================================== */
  function openProviderSettings(p) {
    Prov.call(p, "settings", "settings", {}).then(function (schema) {
      schema = Array.isArray(schema) ? schema : [];
      if (!schema.length) {
        showToast("No configuration settings required for " + (p.display_name || p.value));
        return;
      }
      var html = "<form id='prov-settings-form'>";
      schema.forEach(function (f) {
        var cur = Prov.kv(p.value, "get", f.key);
        if (cur === undefined) cur = f.defaultValue;
        html += "<div class='app-form-group'><label class='app-form-label'>" + esc(f.label || f.key) + "</label>";
        if (f.type === "checkbox") {
          html += "<div><label class='switch'><input type='checkbox' name='" + esc(f.key) + "' " + (cur ? "checked" : "") + "/><span class='slider'></span></label></div>";
        } else {
          html += "<input class='app-input' type='" + (f.type === "password" ? "password" : "text") + "' name='" + esc(f.key) + "' value='" + esc(cur || "") + "' placeholder='" + esc(f.placeholder || "") + "'/>";
        }
        if (f.description) html += "<div style='font-size:0.75rem;color:var(--on-surface-variant);margin-top:4px;'>" + esc(f.description) + "</div>";
        html += "</div>";
      });
      html += "<div style='display:flex;justify-content:flex-end;gap:10px;margin-top:20px;'>" +
        "<button type='button' class='btn-secondary' onclick='closeAppModal()'>Cancel</button>" +
        "<button type='submit' class='btn-primary'>Save Settings</button></div></form>";

      openAppModal((p.display_name || p.value) + " Settings", html);

      document.getElementById("prov-settings-form").onsubmit = function (e) {
        e.preventDefault();
        var fd = new FormData(e.target);
        schema.forEach(function (f) {
          var val = f.type === "checkbox" ? fd.has(f.key) : fd.get(f.key);
          Prov.kv(p.value, "set", f.key, val);
        });
        closeAppModal();
        showToast("Settings saved for " + (p.display_name || p.value));
      };
    }).catch(function (e) {
      showToast("Settings error: " + e.message, "warning");
    });
  }

  /* =====================================================================
   * Catalog, Posts & Media Data Access
   * ===================================================================== */
  var sampleCatalog = typeof VEGA_CATALOG !== "undefined" ? VEGA_CATALOG : [];

  function normPost(x, provVal) {
    if (!x || typeof x !== "object") return null;
    var title = x.title || x.name || "";
    var link = x.link || x.url || x.id || "";
    if (!title || !link) return null;
    return {
      id: "prov:" + (provVal || "") + ":" + link,
      title: String(title),
      link: String(link),
      poster: safeUrl(x.image || x.poster),
      backdrop: safeUrl(x.image || x.poster || x.backdrop),
      quality: x.tag || x.quality || "HD",
      rating: x.rating || (x.tag ? x.tag.replace("★", "") : "8.5"),
      year: x.year || "2024",
      type: x.type || "movie",
      provider: provVal || ""
    };
  }

  function getCatalog(p) {
    return cachedFn(cache, "cat|" + p.value + "|" + p.version, 3e5, function () {
      return Prov.call(p, "catalog", "catalog", {}).catch(function () { return []; });
    });
  }

  function getPosts(p, filter, page) {
    return cachedFn(cache, "posts|" + p.value + "|" + filter + "|" + page, 3e5, function () {
      return Prov.call(p, "posts", "getPosts", { filter: filter || "", page: page || 1, providerValue: p.value }).then(function (l) {
        return (Array.isArray(l) ? l : []).map(function (it) { return normPost(it, p.value); }).filter(Boolean);
      });
    });
  }

  function searchPosts(p, q, page) {
    return cachedFn(cache, "search|" + p.value + "|" + q + "|" + page, 3e5, function () {
      return Prov.call(p, "posts", "getSearchPosts", { searchQuery: q, page: page || 1, providerValue: p.value }).then(function (l) {
        return (Array.isArray(l) ? l : []).map(function (it) { return normPost(it, p.value); }).filter(Boolean);
      });
    });
  }

  function getMeta(p, link) {
    return cachedFn(cache, "meta|" + p.value + "|" + link, 6e5, function () {
      return Prov.call(p, "meta", "getMeta", { link: link, provider: p.value });
    });
  }

  function getEpisodes(p, url) {
    return cachedFn(cache, "eps|" + p.value + "|" + url, 6e5, function () {
      return Prov.call(p, "episodes", "getEpisodes", { url: url }).catch(function () { return []; });
    });
  }

  function getStream(p, link, type) {
    return Prov.call(p, "stream", "getStream", { link: link, type: type || "movie" }).then(function (streams) {
      if (!Array.isArray(streams)) return [];
      return streams.map(function (s) {
        return {
          name: s.server || s.quality || s.name || "Stream Mirror",
          link: s.link || s.url,
          headers: s.headers,
          subtitles: s.subtitles,
          type: s.type
        };
      });
    });
  }

  function findCatalogItem(id) {
    return sampleCatalog.find(function (x) { return x.id === id; });
  }

  function toggleWatchlist(id) {
    var inList = S.watchlist.includes(id);
    if (inList) {
      S.watchlist = S.watchlist.filter(function (x) { return x !== id; });
      showToast("Removed from Library");
    } else {
      S.watchlist.unshift(id);
      showToast("Added to Library");
    }
    save("wl", S.watchlist);
    updateWatchlistBadge();
  }

  /* =====================================================================
   * Generic Modal Utility
   * ===================================================================== */
  function openAppModal(title, html) {
    var modal = document.getElementById("app-modal");
    if (!modal) return;
    modal.innerHTML = "<div class='app-modal-sheet'>" +
      "<div class='app-modal-header'><div class='app-modal-title'>" + esc(title) + "</div>" +
      "<button class='app-modal-close' id='app-modal-x'>✕</button></div>" +
      "<div>" + html + "</div>" +
      "</div>";
    modal.style.display = "flex";
    modal.classList.add("active");
    document.body.style.overflow = "hidden";

    document.getElementById("app-modal-x").onclick = closeAppModal;
    modal.onclick = function (e) { if (e.target === modal) closeAppModal(); };
  }

  function closeAppModal() {
    var modal = document.getElementById("app-modal");
    if (!modal) return;
    modal.style.display = "none";
    modal.classList.remove("active");
    modal.innerHTML = "";
    document.body.style.overflow = "";
  }
  window.closeAppModal = closeAppModal;

  /* =====================================================================
   * Media Details Modal
   * ===================================================================== */
  function openMediaModal(item) {
    var inWatchlist = S.watchlist.includes(item.id);
    var modal = document.getElementById("media-modal");
    var heroBg = document.getElementById("modal-hero-bg");
    var posterImg = document.getElementById("modal-poster-img");
    var titleText = document.getElementById("modal-title-text");
    var ratingBadge = document.getElementById("modal-rating-badge");
    var yearText = document.getElementById("modal-year-text");
    var durationText = document.getElementById("modal-duration-text");
    var qualityBadge = document.getElementById("modal-quality-badge");
    var overviewText = document.getElementById("modal-overview-text");
    var castText = document.getElementById("modal-cast-text");
    var genresList = document.getElementById("modal-genres-list");
    var epSection = document.getElementById("modal-episodes-section");
    var epList = document.getElementById("modal-episodes-list");
    var watchlistBtn = document.getElementById("modal-watchlist-btn");
    var playBtn = document.getElementById("modal-play-btn");

    heroBg.style.backgroundImage = "url('" + (item.backdrop || item.poster || "") + "')";
    posterImg.src = item.poster || "";
    titleText.textContent = item.title || "";
    ratingBadge.textContent = "★ " + (item.rating || "8.5");
    yearText.textContent = item.year || "2024";
    durationText.textContent = item.duration || "Feature";
    qualityBadge.textContent = item.quality || "HD";
    overviewText.textContent = item.overview || "Loading media information...";
    castText.textContent = Array.isArray(item.cast) ? item.cast.join(", ") : (item.cast || "Cast");

    genresList.innerHTML = (item.genres || ["Feature", "Stream"]).map(function (g) {
      return "<span class='filter-chip' style='padding:2px 10px;font-size:0.75rem;'>" + esc(g) + "</span>";
    }).join("");

    watchlistBtn.innerHTML = "<svg width='18' height='18' viewBox='0 0 24 24' fill='" + (inWatchlist ? "var(--primary)" : "none") + "' stroke='currentColor' stroke-width='2'><path d='M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z'/></svg>" +
      "<span>" + (inWatchlist ? "In Library" : "Add to Library") + "</span>";
    watchlistBtn.onclick = function () {
      toggleWatchlist(item.id);
      openMediaModal(item);
    };

    var prog = S.progress[item.id];
    var resumeTime = prog && prog.t > 15 && prog.t < (prog.d - 30) ? prog.t : 0;
    playBtn.innerHTML = "<svg width='20' height='20' viewBox='0 0 24 24' fill='currentColor'><polygon points='5 3 19 12 5 21 5 3'/></svg> " +
      (resumeTime ? "Resume (" + fmtTime(resumeTime) + ")" : "Watch Now");

    // Dynamic Meta Resolution for Provider Items
    if (item.provider && item.link) {
      var p = provById(item.provider) || curProvider();
      if (p) {
        getMeta(p, item.link).then(function (meta) {
          if (!meta) return;
          if (meta.synopsis || meta.overview) overviewText.textContent = meta.synopsis || meta.overview;
          if (meta.image || meta.poster) {
            posterImg.src = meta.image || meta.poster;
            heroBg.style.backgroundImage = "url('" + (meta.backdrop || meta.image || meta.poster) + "')";
          }
          if (meta.rating) ratingBadge.textContent = "★ " + meta.rating;
          if (meta.year) yearText.textContent = meta.year;
          if (meta.cast) castText.textContent = Array.isArray(meta.cast) ? meta.cast.join(", ") : meta.cast;
          if (meta.tags) {
            genresList.innerHTML = (Array.isArray(meta.tags) ? meta.tags : [meta.tags]).map(function (g) {
              return "<span class='filter-chip' style='padding:2px 10px;font-size:0.75rem;'>" + esc(g) + "</span>";
            }).join("");
          }
        }).catch(function (e) {
          overviewText.textContent = "Click 'Watch Now' to extract playable streams.";
        });

        // Dynamic Episodes Resolution
        getEpisodes(p, item.link).then(function (eps) {
          if (Array.isArray(eps) && eps.length > 0) {
            epSection.style.display = "block";
            epList.innerHTML = eps.map(function (ep, idx) {
              var epNum = ep.episode || ep.ep || (idx + 1);
              var epTitle = ep.title || ("Episode " + epNum);
              return "<div class='episode-item' data-eplink='" + esc(ep.link || ep.url || item.link) + "' data-epnum='" + epNum + "'>" +
                "<img src='" + esc(ep.image || ep.poster || item.poster || "") + "' alt='' class='episode-thumb'/>" +
                "<div class='episode-info'>" +
                "<div class='episode-number'>Episode " + epNum + "</div>" +
                "<div class='episode-title'>" + esc(epTitle) + "</div>" +
                "</div>" +
                "<button class='btn-primary' style='padding:6px 12px;font-size:0.75rem;border-radius:var(--rounded-md);'>Play</button>" +
                "</div>";
            }).join("");

            epList.querySelectorAll(".episode-item").forEach(function (el) {
              el.onclick = function () {
                var epLink = el.dataset.eplink;
                var epNum = el.dataset.epnum;
                closeMediaModal();
                showToast("Extracting episode stream...");
                getStream(p, epLink, "series").then(function (streams) {
                  if (!streams.length) { showToast("No playable streams found for this episode", "warning"); return; }
                  openPlayer(item, "Episode " + epNum, 0, null, streams);
                }).catch(function (err) {
                  showToast("Stream extraction failed: " + err.message, "warning");
                });
              };
            });
          } else {
            epSection.style.display = "none";
          }
        }).catch(function () {
          epSection.style.display = "none";
        });
      }
    } else if (item.episodes && item.episodes.length > 0) {
      epSection.style.display = "block";
      epList.innerHTML = item.episodes.map(function (ep) {
        return "<div class='episode-item' data-ep='" + ep.ep + "'>" +
          "<img src='" + (ep.thumb || item.poster || "") + "' alt='' class='episode-thumb'/>" +
          "<div class='episode-info'>" +
          "<div class='episode-number'>Episode " + ep.ep + "</div>" +
          "<div class='episode-title'>" + esc(ep.title) + "</div>" +
          "<div class='episode-duration'>" + esc(ep.duration || "") + "</div>" +
          "</div>" +
          "<button class='btn-primary' style='padding:6px 12px;font-size:0.75rem;border-radius:var(--rounded-md);'>Play</button>" +
          "</div>";
      }).join("");

      epList.querySelectorAll(".episode-item").forEach(function (el) {
        el.onclick = function () {
          closeMediaModal();
          var epNum = el.dataset.ep;
          var epData = item.episodes.find(function (e) { return String(e.ep) === String(epNum); });
          openPlayer(item, "Episode " + epNum + (epData ? ": " + epData.title : ""), 0, epData);
        };
      });
    } else {
      epSection.style.display = "none";
    }

    playBtn.onclick = function () {
      if (item.provider && item.link) {
        var prov = provById(item.provider) || curProvider();
        if (prov) {
          showToast("Extracting streams from " + (prov.display_name || prov.value) + "...");
          getStream(prov, item.link, item.type || "movie").then(function (streams) {
            if (!streams.length) {
              showToast("No playable streams found from this provider", "warning");
              return;
            }
            closeMediaModal();
            openPlayer(item, "", resumeTime, null, streams);
          }).catch(function (err) {
            showToast("Stream extraction failed: " + err.message, "warning");
          });
          return;
        }
      }
      closeMediaModal();
      openPlayer(item, "", resumeTime);
    };

    modal.classList.add("active");
    document.body.style.overflow = "hidden";
  }

  function closeMediaModal() {
    var modal = document.getElementById("media-modal");
    if (modal) {
      modal.classList.remove("active");
      document.body.style.overflow = "";
    }
  }

  /* =====================================================================
   * Libmedia Multimedia Cinema Player Engine (AVPlayer Core)
   * ===================================================================== */
  var P = null;

  /* =====================================================================
   * Vega Original Minimal Video Player Controller
   * Dual-Engine: Libmedia (WASM/WebCodecs) + HTML5 Video/HLS/WebTorrent
   * ===================================================================== */
  var playerToastTimer = null;
  function showPlayerToast(text) {
    var toast = document.getElementById("player-toast");
    if (!toast) return;
    toast.textContent = text;
    toast.classList.add("visible");
    toast.style.display = "block";
    clearTimeout(playerToastTimer);
    playerToastTimer = setTimeout(function () {
      toast.classList.remove("visible");
      toast.style.display = "none";
    }, 1800);
  }

  function setPlayerLoading(loading, message) {
    var loader = document.getElementById("player-loading");
    var txt = document.getElementById("player-loading-text");
    if (!loader) return;
    if (loading) {
      if (txt && message) txt.textContent = message;
      loader.style.display = "flex";
    } else {
      loader.style.display = "none";
    }
  }

  var activeSettingsTab = "audio";
  function openPlayerSettings(tabName) {
    var overlay = document.getElementById("player-settings-overlay");
    if (!overlay) return;
    if (tabName) activeSettingsTab = tabName;
    overlay.classList.add("visible");
    overlay.style.display = "flex";
    renderSettingsTabs();
    renderSettingsContent();
  }

  function closePlayerSettings() {
    var overlay = document.getElementById("player-settings-overlay");
    if (overlay) {
      overlay.classList.remove("visible");
      overlay.style.display = "none";
    }
  }
  function closePlayerPopover() {
    closePlayerSettings();
  }

  function renderSettingsTabs() {
    var tabs = document.querySelectorAll(".settings-tab");
    tabs.forEach(function (tab) {
      if (tab.dataset.tab === activeSettingsTab) {
        tab.classList.add("active");
      } else {
        tab.classList.remove("active");
      }
    });
  }

  function renderSettingsContent() {
    var container = document.getElementById("player-settings-content");
    if (!container || !P) return;

    var checkSvg = '<svg class="check-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>';

    if (activeSettingsTab === "audio") {
      if (P.lp && P.audioTracks && P.audioTracks.length > 0) {
        container.innerHTML = P.audioTracks.map(function (t, i) {
          var name = esc(t.title || t.label || t.lang || ("Audio Track " + (i + 1)));
          var sub = esc(t.codec || t.channelLayout || "Stereo / 5.1 Surround");
          return '<div class="settings-item ' + (t.selected ? 'selected' : '') + '" data-set-audio="' + t.id + '">' +
            '<div class="settings-item-label">' + name + '</div>' +
            '<div class="settings-item-sublabel">' + sub + '</div>' +
            checkSvg + '</div>';
        }).join("");
      } else {
        container.innerHTML = '<div class="settings-item selected">' +
          '<div class="settings-item-label">Default Audio (Stereo/Direct)</div>' +
          '<div class="settings-item-sublabel">Original stream mix</div>' +
          checkSvg + '</div>';
      }
    } else if (activeSettingsTab === "subtitles") {
      var subs = (P.subtitles || []);
      var offSelected = !P.activeSubId;
      var html = '<div class="settings-item ' + (offSelected ? 'selected' : '') + '" data-set-sub="off">' +
        '<div class="settings-item-label">Off</div>' +
        '<div class="settings-item-sublabel">Disable subtitles</div>' +
        (offSelected ? checkSvg : '') + '</div>';

      if (subs.length > 0) {
        html += subs.map(function (s, i) {
          var isSel = P.activeSubId === (s.id || String(i));
          return '<div class="settings-item ' + (isSel ? 'selected' : '') + '" data-set-sub="' + (s.id || i) + '">' +
            '<div class="settings-item-label">' + esc(s.label || s.lang || ("Subtitle " + (i + 1))) + '</div>' +
            '<div class="settings-item-sublabel">' + esc(s.kind || "Embedded / VTT") + '</div>' +
            (isSel ? checkSvg : '') + '</div>';
        }).join("");
      } else {
        html += '<div class="settings-empty">No subtitles found in this stream.</div>';
      }
      container.innerHTML = html;
    } else if (activeSettingsTab === "quality") {
      var qHtml = "";
      if (P.lp && P.videoTracks && P.videoTracks.length > 0) {
        qHtml = P.videoTracks.map(function (v) {
          var label = v.height ? (v.height + "p (" + (v.width || "") + "x" + v.height + ")") : (v.title || "Auto");
          return '<div class="settings-item ' + (v.selected ? 'selected' : '') + '" data-set-vid="' + v.id + '">' +
            '<div class="settings-item-label">' + esc(label) + '</div>' +
            '<div class="settings-item-sublabel">' + esc(v.codec || "WebCodecs Hardware") + '</div>' +
            (v.selected ? checkSvg : '') + '</div>';
        }).join("");
      } else if (P.hls && P.hls.levels && P.hls.levels.length > 0) {
        var autoSel = P.hls.currentLevel === -1;
        qHtml = '<div class="settings-item ' + (autoSel ? 'selected' : '') + '" data-set-hlslvl="-1">' +
          '<div class="settings-item-label">Auto (Adaptive Bitrate)</div>' +
          '<div class="settings-item-sublabel">Automatically adapts to bandwidth</div>' +
          (autoSel ? checkSvg : '') + '</div>';
        qHtml += P.hls.levels.map(function (lvl, idx) {
          var isSel = P.hls.currentLevel === idx;
          return '<div class="settings-item ' + (isSel ? 'selected' : '') + '" data-set-hlslvl="' + idx + '">' +
            '<div class="settings-item-label">' + lvl.height + 'p</div>' +
            '<div class="settings-item-sublabel">' + Math.round(lvl.bitrate / 1000) + ' kbps</div>' +
            (isSel ? checkSvg : '') + '</div>';
        }).join("");
      } else {
        qHtml = '<div class="settings-item selected">' +
          '<div class="settings-item-label">Source Quality (Auto)</div>' +
          '<div class="settings-item-sublabel">Direct stream source</div>' +
          checkSvg + '</div>';
      }
      container.innerHTML = qHtml;
    } else if (activeSettingsTab === "speed") {
      var curRate = (P.v ? P.v.playbackRate : 1.0) || 1.0;
      var speeds = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0];
      container.innerHTML = speeds.map(function (sp) {
        var isSel = Math.abs(curRate - sp) < 0.05;
        return '<div class="settings-item ' + (isSel ? 'selected' : '') + '" data-set-speed="' + sp + '">' +
          '<div class="settings-item-label">' + sp + 'x ' + (sp === 1.0 ? '(Normal)' : '') + '</div>' +
          (isSel ? checkSvg : '') + '</div>';
      }).join("");
    } else if (activeSettingsTab === "servers") {
      container.innerHTML = P.streams.map(function (s, i) {
        var isSel = P.activeStreamIdx === i;
        return '<div class="settings-item ' + (isSel ? 'selected' : '') + '" data-set-server="' + i + '">' +
          '<div class="settings-item-label">' + esc(s.name || ("Server Mirror " + (i + 1))) + '</div>' +
          '<div class="settings-item-sublabel">' + (s.quality ? esc(s.quality) : "Direct Fast Mirror") + '</div>' +
          (isSel ? checkSvg : '') + '</div>';
      }).join("");
    } else if (activeSettingsTab === "sync") {
      var d = P.audioDelay || 0;
      container.innerHTML = '<div style="padding: 18px 14px; text-align: center;">' +
        '<div style="font-size: 13px; color: var(--on-surface-variant); margin-bottom: 12px;">Calibrate audio delay if dialogue is not in sync with video:</div>' +
        '<div style="font-size: 26px; font-weight: 700; color: var(--primary); margin-bottom: 18px;">' + (d > 0 ? "+" : "") + (d / 1000).toFixed(2) + 's (' + d + 'ms)</div>' +
        '<div style="display: flex; gap: 8px; justify-content: center; flex-wrap: wrap;">' +
          '<button class="btn-secondary" data-sync-adj="-200">-0.2s</button>' +
          '<button class="btn-secondary" data-sync-adj="-100">-0.1s</button>' +
          '<button class="btn-secondary" data-sync-reset="0">Reset (0s)</button>' +
          '<button class="btn-secondary" data-sync-adj="100">+0.1s</button>' +
          '<button class="btn-secondary" data-sync-adj="200">+0.2s</button>' +
        '</div></div>';
    }

    // Attach click events
    container.querySelectorAll("[data-set-audio]").forEach(function (el) {
      el.onclick = function () {
        var id = el.dataset.setAudio;
        if (P.lp) P.lp.selectAudio(id).catch(function () {});
        showPlayerToast("Audio Track Updated");
        syncTrackLabels();
        closePlayerSettings();
      };
    });

    container.querySelectorAll("[data-set-sub]").forEach(function (el) {
      el.onclick = function () {
        var sid = el.dataset.setSub;
        P.activeSubId = sid === "off" ? null : sid;
        if (P.lp && P.lp.selectSubtitle) {
          P.lp.selectSubtitle(P.activeSubId).catch(function () {});
        }
        var subLabel = document.getElementById("player-sub-label");
        if (subLabel) subLabel.textContent = P.activeSubId ? "Subtitles: On" : "Subtitles: Off";
        showPlayerToast(P.activeSubId ? "Subtitles: Enabled" : "Subtitles: Disabled");
        closePlayerSettings();
      };
    });

    container.querySelectorAll("[data-set-vid]").forEach(function (el) {
      el.onclick = function () {
        var id = el.dataset.setVid;
        if (P.lp) P.lp.selectVideo(id).catch(function () {});
        showPlayerToast("Quality Updated");
        syncTrackLabels();
        closePlayerSettings();
      };
    });

    container.querySelectorAll("[data-set-hlslvl]").forEach(function (el) {
      el.onclick = function () {
        var lvl = Number(el.dataset.setHlslvl);
        if (P.hls) P.hls.currentLevel = lvl;
        showPlayerToast(lvl === -1 ? "Quality: Auto (Adaptive)" : "Quality: Level " + (lvl + 1));
        syncTrackLabels();
        closePlayerSettings();
      };
    });

    container.querySelectorAll("[data-set-speed]").forEach(function (el) {
      el.onclick = function () {
        var rate = Number(el.dataset.setSpeed);
        if (P.lp) P.lp.setPlaybackRate(rate);
        if (P.v) P.v.playbackRate = rate;
        var sLabel = document.getElementById("player-speed-label");
        if (sLabel) sLabel.textContent = rate + "x";
        showPlayerToast("Speed: " + rate + "x");
        closePlayerSettings();
      };
    });

    container.querySelectorAll("[data-set-server]").forEach(function (el) {
      el.onclick = function () {
        var idx = Number(el.dataset.setServer);
        var cur = getPlayerTime();
        closePlayerSettings();
        loadSessionStream(idx, cur);
      };
    });

    container.querySelectorAll("[data-sync-adj]").forEach(function (btn) {
      btn.onclick = function () {
        var delta = Number(btn.dataset.syncAdj);
        P.audioDelay = (P.audioDelay || 0) + delta;
        if (P.lp && P.lp.setAudioDelay) P.lp.setAudioDelay(P.audioDelay);
        showPlayerToast("Audio Offset: " + (P.audioDelay / 1000).toFixed(2) + "s");
        renderSettingsContent();
      };
    });

    container.querySelectorAll("[data-sync-reset]").forEach(function (btn) {
      btn.onclick = function () {
        P.audioDelay = 0;
        if (P.lp && P.lp.setAudioDelay) P.lp.setAudioDelay(0);
        showPlayerToast("Audio Offset Reset");
        renderSettingsContent();
      };
    });
  }

  function openPlayer(item, subtitle, startAt, episodeData, extraStreams) {
    if (P) teardownPlayer();

    var overlay = document.getElementById("player-overlay");
    var mainVideo = document.getElementById("main-video");
    var libContainer = document.getElementById("plibmedia");
    var titleEl = document.getElementById("player-title-text");
    var subEl = document.getElementById("player-subtitle-text");

    titleEl.textContent = item.title;
    subEl.textContent = subtitle || (item.type === "movie" ? "Feature Film" : "Season 1");
    overlay.classList.add("active");
    overlay.style.display = "flex";
    document.body.style.overflow = "hidden";

    var streams = [];
    if (extraStreams && Array.isArray(extraStreams) && extraStreams.length > 0) {
      extraStreams.forEach(function (s) { streams.push(s); });
    }
    if (episodeData && episodeData.videoUrl) streams.push({ name: "Primary Server", link: episodeData.videoUrl });
    if (item.videoUrl) streams.push({ name: "Primary Server", link: item.videoUrl });
    if (item.streams && Array.isArray(item.streams)) {
      item.streams.forEach(function (s) { streams.push(s); });
    }
    if (!streams.length) {
      streams.push({ name: "Demo Stream", link: "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4" });
    }

    var session = {
      item: item,
      streams: streams,
      activeStreamIdx: 0,
      v: mainVideo,
      libC: libContainer,
      lp: null,
      hls: null,
      engine: "native",
      isPaused: true,
      audioTracks: [],
      videoTracks: [],
      subtitles: [],
      activeSubId: null,
      audioDelay: 0,
      idleTimer: null
    };
    P = session;

    closePlayerSettings();
    loadSessionStream(0, startAt || 0);
    setupPlayerControls();
    wakePlayerControls();
  }

  function teardownPlayer() {
    if (!P) return;
    saveProgress(true);

    if (P.lp) {
      try { P.lp.destroy(); } catch (e) {}
      P.lp = null;
    }
    if (P.hls) {
      try { P.hls.destroy(); } catch (e) {}
      P.hls = null;
    }
    if (window.webtorrentClient) {
      try { window.webtorrentClient.destroy(); } catch (e) {}
      window.webtorrentClient = null;
    }

    var v = P.v;
    if (v) {
      v.pause();
      v.removeAttribute("src");
      v.load();
    }
    if (P.libC) {
      P.libC.innerHTML = "";
      P.libC.style.display = "none";
    }

    if (document.fullscreenElement) {
      document.exitFullscreen().catch(function () {});
    }

    P = null;
    var overlay = document.getElementById("player-overlay");
    if (overlay) {
      overlay.classList.remove("active");
      overlay.style.display = "none";
    }
    document.body.style.overflow = "";
    closePlayerSettings();
  }

  function closePlayer() {
    teardownPlayer();
  }

  function loadSessionStream(idx, startAt) {
    if (!P) return;
    P.activeStreamIdx = idx;
    var s = P.streams[idx];
    if (!s) return;

    var url = s.link;
    var isTorrent = /^magnet:/i.test(url) || /\.torrent($|\?)/i.test(url);
    var isHls = /\.m3u8($|\?)/i.test(url);

    setPlayerLoading(true, "Connecting to " + (s.name || "stream") + "...");
    syncTrackLabels();

    function startFallback(streamUrl) {
      if (!P) return;
      P.v.style.display = "block";
      if (P.libC) P.libC.style.display = "none";
      P.engine = isHls ? "hls" : "native";

      if (isHls && window.Hls && window.Hls.isSupported()) {
        if (P.hls) P.hls.destroy();
        var hls = new window.Hls({ enableWorker: true });
        P.hls = hls;
        hls.loadSource(streamUrl);
        hls.attachMedia(P.v);
        hls.on(window.Hls.Events.MANIFEST_PARSED, function () {
          setPlayerLoading(false);
          if (startAt) P.v.currentTime = startAt;
          P.v.play().catch(function () {});
          syncTrackLabels();
        });
        hls.on(window.Hls.Events.ERROR, function (ev, data) {
          if (data.fatal) {
            setPlayerLoading(true, "Stream error. Switch server mirror.");
          }
        });
      } else {
        P.v.src = streamUrl;
        P.v.onloadedmetadata = function () {
          setPlayerLoading(false);
          if (startAt) P.v.currentTime = startAt;
          P.v.play().catch(function () {});
          syncTrackLabels();
        };
        P.v.onerror = function () {
          setPlayerLoading(true, "Playback failed. Switch server mirror.");
        };
      }
    }

    if (isTorrent && window.WebTorrent) {
      setPlayerLoading(true, "Connecting to WebTorrent swarm...");
      var client = new window.WebTorrent();
      window.webtorrentClient = client;
      client.add(url, function (torrent) {
        var file = torrent.files.find(function (f) {
          return /\.(mp4|mkv|webm|avi|m4v)$/i.test(f.name);
        }) || torrent.files[0];
        if (file) {
          file.renderTo(P.v, { autoplay: true }, function () {
            setPlayerLoading(false);
            if (startAt) P.v.currentTime = startAt;
          });
        }
      });
      return;
    }

    if (window.AVPlayer && P.libC && S.prefs.preferLibmedia) {
      try {
        P.libC.innerHTML = "";
        P.libC.style.display = "block";
        P.v.style.display = "none";

        var lp = new window.AVPlayer({
          container: P.libC,
          wasmBaseUrl: "https://cdn.jsdelivr.net/gh/zhaohappy/libmedia@1.3.1/dist",
          enableHardware: true,
          enableWebCodecs: true,
          enableWorker: true
        });
        P.lp = lp;
        P.engine = "libmedia";

        lp.on("loaded", function () {
          setPlayerLoading(false);
          if (startAt) lp.seek(startAt * 1000).catch(function () {});
          lp.play().catch(function () {});
          syncTrackLabels();
        });
        lp.on("playing", function () {
          setPlayerLoading(false);
          P.isPaused = false;
          updatePlayPauseButton();
        });
        lp.on("paused", function () {
          P.isPaused = true;
          updatePlayPauseButton();
        });
        lp.on("time", function (d) {
          var curSec = typeof d === "object" ? (Number(d.time || d.pts || 0) / 1000) : (Number(d) / 1000);
          var durSec = Number(lp.getDuration() || 0) / 1000;
          updatePlayerTime(curSec, durSec);
        });
        lp.on("ended", function () {
          P.isPaused = true;
          updatePlayPauseButton();
          saveProgress(true);
        });
        lp.on("error", function (err) {
          console.warn("Libmedia error, switching to fallback:", err);
          startFallback(url);
        });

        var opts = {};
        if (isHls) opts.ext = "m3u8";
        if (s.headers && Object.keys(s.headers).length) opts.http = { headers: s.headers };
        lp.load(url, opts).catch(function (e) {
          console.warn("Libmedia load error:", e);
          startFallback(url);
        });
        return;
      } catch (err) {
        console.warn("Libmedia init failed:", err);
      }
    }

    startFallback(url);
  }

  function getPlayerTime() {
    if (!P) return 0;
    if (P.lp) return Number(P.lp.currentTime || 0) / 1000;
    return P.v ? P.v.currentTime : 0;
  }
  function getPlayerDuration() {
    if (!P) return 0;
    if (P.lp) return Number(P.lp.getDuration() || 0) / 1000;
    return (P.v && P.v.duration) ? P.v.duration : 0;
  }
  function seekPlayer(sec) {
    if (!P) return;
    var dur = getPlayerDuration() || 1e6;
    var target = Math.max(0, Math.min(dur, sec));
    if (P.lp) P.lp.seek(target * 1000).catch(function () {});
    else if (P.v) P.v.currentTime = target;
  }
  function togglePlayerPlay() {
    if (!P) return;
    if (P.lp) {
      if (P.isPaused) P.lp.play(); else P.lp.pause();
    } else if (P.v) {
      if (P.v.paused) P.v.play(); else P.v.pause();
    }
  }

  function updatePlayPauseButton() {
    if (!P) return;
    var paused = P.lp ? P.isPaused : (P.v ? P.v.paused : true);
    var centerIcon = document.getElementById("player-center-play-icon");
    var bottomIcon = document.getElementById("player-bottom-play-icon");

    var playSvg = '<polygon points="5 3 19 12 5 21 5 3"/>';
    var pauseSvg = '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>';

    if (centerIcon) centerIcon.innerHTML = paused ? playSvg : pauseSvg;
    if (bottomIcon) bottomIcon.innerHTML = paused ? playSvg : pauseSvg;
  }

  function updatePlayerTime(cur, dur) {
    var curEl = document.getElementById("player-time-current");
    var durEl = document.getElementById("player-time-duration");
    var prog = document.getElementById("player-timeline-progress");
    var buff = document.getElementById("player-timeline-buffered");
    if (!curEl || !durEl || !prog) return;

    var pct = dur > 0 ? (cur / dur) * 100 : 0;
    prog.style.width = Math.min(100, Math.max(0, pct)) + "%";

    curEl.textContent = fmtTime(cur);
    durEl.textContent = fmtTime(dur);

    if (buff && P && P.v && P.v.buffered && P.v.buffered.length > 0) {
      try {
        var bEnd = P.v.buffered.end(P.v.buffered.length - 1);
        var bPct = dur > 0 ? (bEnd / dur) * 100 : 0;
        buff.style.width = Math.min(100, bPct) + "%";
      } catch (e) {}
    }
  }

  function saveProgress(finalSync) {
    if (!P || !P.item) return;
    var cur = getPlayerTime();
    var dur = getPlayerDuration();
    if (!dur || cur < 5) return;
    S.progress[P.item.id] = {
      id: P.item.id,
      title: P.item.title,
      poster: P.item.poster,
      backdrop: P.item.backdrop,
      t: Math.round(cur),
      d: Math.round(dur),
      at: Date.now()
    };
    save("prog", S.progress);
  }

  function syncTrackLabels() {
    if (!P) return;
    var aLabel = document.getElementById("player-audio-label");
    var qLabel = document.getElementById("player-quality-label");
    var sLabel = document.getElementById("player-server-label");
    var badgeAudio = document.getElementById("badge-audio-count");

    if (sLabel && P.streams && P.streams[P.activeStreamIdx]) {
      sLabel.textContent = P.streams[P.activeStreamIdx].name || ("Server " + (P.activeStreamIdx + 1));
    }

    if (P.lp) {
      P.lp.getAudioList().then(function (res) {
        var list = (res && res.list) || [];
        P.audioTracks = list;
        if (badgeAudio) badgeAudio.textContent = list.length || 1;
        if (list.length > 0) {
          var cur = list.find(function (t) { return t.selected; }) || list[0];
          if (aLabel) aLabel.textContent = cur.title || cur.label || cur.lang || "Audio";
        }
      }).catch(function () {});

      P.lp.getVideoList().then(function (res) {
        var list = (res && res.list) || [];
        P.videoTracks = list;
        if (list.length > 0) {
          var cur = list.find(function (t) { return t.selected; }) || list[0];
          if (qLabel) qLabel.textContent = cur.height ? (cur.height + "p") : "Quality";
        }
      }).catch(function () {});
    } else if (P.hls && P.hls.levels) {
      if (qLabel) {
        var lvl = P.hls.levels[P.hls.currentLevel];
        qLabel.textContent = lvl ? (lvl.height + "p") : "Auto";
      }
    }
  }

  function wakePlayerControls() {
    var overlay = document.getElementById("player-overlay");
    var wrapper = document.getElementById("player-controls-wrapper");
    if (!wrapper || !overlay) return;

    overlay.classList.add("controls-visible");
    wrapper.classList.remove("exiting");
    wrapper.classList.add("visible");

    clearTimeout(P ? P.idleTimer : null);
    if (P) {
      P.idleTimer = setTimeout(function () {
        var settingsOverlay = document.getElementById("player-settings-overlay");
        var settingsOpen = settingsOverlay && settingsOverlay.classList.contains("visible");
        var paused = P.lp ? P.isPaused : (P.v ? P.v.paused : true);
        if (P && !paused && !settingsOpen) {
          wrapper.classList.add("exiting");
          overlay.classList.remove("controls-visible");
          setTimeout(function () {
            if (wrapper.classList.contains("exiting")) {
              wrapper.classList.remove("visible");
            }
          }, 250);
        }
      }, 2500);
    }
  }

  function setupPlayerControls() {
    var overlay = document.getElementById("player-overlay");
    var centerPlayBtn = document.getElementById("player-center-play");
    var bottomPlayBtn = document.getElementById("player-bottom-play");
    var centerRewind = document.getElementById("player-center-rewind");
    var centerForward = document.getElementById("player-center-forward");
    var timelineTrack = document.getElementById("player-timeline-track");
    var volBtn = document.getElementById("player-volume-btn");
    var volSlider = document.getElementById("player-volume-slider");
    var fsBtn = document.getElementById("player-fullscreen-btn");
    var backBtn = document.getElementById("player-back-btn");

    var serverBtn = document.getElementById("player-server-btn");
    var audioBtn = document.getElementById("player-audio-btn");
    var subBtn = document.getElementById("player-sub-btn");
    var qualityBtn = document.getElementById("player-quality-btn");
    var speedBtn = document.getElementById("player-speed-btn");

    // Play/Pause toggles
    function handlePlayToggle(e) {
      if (e) e.stopPropagation();
      togglePlayerPlay();
      updatePlayPauseButton();
      wakePlayerControls();
    }
    if (centerPlayBtn) centerPlayBtn.onclick = handlePlayToggle;
    if (bottomPlayBtn) bottomPlayBtn.onclick = handlePlayToggle;

    // 10s Rewind & Forward
    if (centerRewind) {
      centerRewind.onclick = function (e) {
        e.stopPropagation();
        seekPlayer(getPlayerTime() - 10);
        showPlayerToast("-10s");
        wakePlayerControls();
      };
    }
    if (centerForward) {
      centerForward.onclick = function (e) {
        e.stopPropagation();
        seekPlayer(getPlayerTime() + 10);
        showPlayerToast("+10s");
        wakePlayerControls();
      };
    }

    // Timeline Scrub
    if (timelineTrack) {
      var isDragging = false;
      function handleScrub(e) {
        var rect = timelineTrack.getBoundingClientRect();
        var clientX = e.touches ? e.touches[0].clientX : e.clientX;
        var pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
        var dur = getPlayerDuration();
        seekPlayer(pct * dur);
        wakePlayerControls();
      }
      timelineTrack.onmousedown = function (e) {
        isDragging = true;
        handleScrub(e);
      };
      window.addEventListener("mousemove", function (e) {
        if (isDragging) handleScrub(e);
      });
      window.addEventListener("mouseup", function () {
        isDragging = false;
      });
      timelineTrack.ontouchstart = handleScrub;
      timelineTrack.ontouchmove = handleScrub;
    }

    // Volume
    if (volBtn) {
      volBtn.onclick = function (e) {
        e.stopPropagation();
        if (P && P.v) {
          P.v.muted = !P.v.muted;
          volBtn.style.color = P.v.muted ? "var(--primary)" : "#fff";
          showPlayerToast(P.v.muted ? "Muted" : "Unmuted");
        }
      };
    }
    if (volSlider) {
      volSlider.oninput = function (e) {
        var val = Number(e.target.value);
        if (P && P.v) {
          P.v.volume = val;
          P.v.muted = false;
          if (volBtn) volBtn.style.color = "#fff";
        }
      };
    }

    // Fullscreen
    if (fsBtn) {
      fsBtn.onclick = function (e) {
        e.stopPropagation();
        if (!document.fullscreenElement) {
          overlay.requestFullscreen().catch(function () {});
        } else {
          document.exitFullscreen().catch(function () {});
        }
      };
    }

    // Exit Player
    if (backBtn) {
      backBtn.onclick = function (e) {
        e.stopPropagation();
        closePlayer();
      };
    }

    // Bottom Action Buttons -> Open Bottom Sheet Settings
    if (serverBtn) serverBtn.onclick = function (e) { e.stopPropagation(); openPlayerSettings("servers"); };
    if (audioBtn) audioBtn.onclick = function (e) { e.stopPropagation(); openPlayerSettings("audio"); };
    if (subBtn) subBtn.onclick = function (e) { e.stopPropagation(); openPlayerSettings("subtitles"); };
    if (qualityBtn) qualityBtn.onclick = function (e) { e.stopPropagation(); openPlayerSettings("quality"); };
    if (speedBtn) speedBtn.onclick = function (e) { e.stopPropagation(); openPlayerSettings("speed"); };

    // Settings Tabs click
    document.querySelectorAll(".settings-tab").forEach(function (tab) {
      tab.onclick = function (e) {
        e.stopPropagation();
        activeSettingsTab = tab.dataset.tab;
        renderSettingsTabs();
        renderSettingsContent();
      };
    });

    // Close settings overlay on backdrop click
    var settingsOverlay = document.getElementById("player-settings-overlay");
    if (settingsOverlay) {
      settingsOverlay.onclick = function (e) {
        if (e.target === settingsOverlay) {
          closePlayerSettings();
        }
      };
    }

    // Mobile Double Tap gestures & Screen Click
    var lastTapTime = 0;
    var videoWrapper = document.getElementById("player-video-wrapper");
    if (videoWrapper) {
      videoWrapper.onclick = function (e) {
        if (e.target.closest("#player-controls-wrapper") || e.target.closest("#player-settings-overlay")) return;

        var now = Date.now();
        var isDouble = (now - lastTapTime < 300);
        lastTapTime = now;

        if (isDouble) {
          var rect = videoWrapper.getBoundingClientRect();
          var clickX = (e.touches ? e.touches[0].clientX : e.clientX) - rect.left;
          var pct = clickX / rect.width;
          if (pct < 0.35) {
            seekPlayer(getPlayerTime() - 10);
            showPlayerToast("-10s");
          } else if (pct > 0.65) {
            seekPlayer(getPlayerTime() + 10);
            showPlayerToast("+10s");
          } else {
            handlePlayToggle();
          }
        } else {
          // Single tap toggles controls visibility
          var wrapper = document.getElementById("player-controls-wrapper");
          if (wrapper && wrapper.classList.contains("visible")) {
            wrapper.classList.remove("visible");
            overlay.classList.remove("controls-visible");
          } else {
            wakePlayerControls();
          }
        }
      };
    }

    overlay.onmousemove = wakePlayerControls;
    overlay.ontouchstart = wakePlayerControls;

    if (P && P.v) {
      P.v.ontimeupdate = function () {
        if (!P || P.lp) return;
        updatePlayerTime(P.v.currentTime, P.v.duration || 1);
      };
    }
  }

  /* =====================================================================
   * Page Views & Renderers
   * ===================================================================== */
  var pageContainer = document.getElementById("page-container");

  function renderMediaCard(item) {
    return "<div class='post-card' data-id='" + esc(item.id) + "' data-prov='" + esc(item.provider || "") + "' data-link='" + esc(item.link || "") + "'>" +
      "<div class='post-card-inner'>" +
      "<img src='" + esc(item.poster || "") + "' alt='" + esc(item.title) + "' class='post-card-img' loading='lazy'/>" +
      "<div class='post-card-badge'>" + esc(item.quality || "HD") + "</div>" +
      "<div class='post-card-rating'>★ " + esc(item.rating || "8.5") + "</div>" +
      "<div class='post-card-overlay'>" +
      "<div class='post-card-actions'>" +
      "<button class='card-action-btn' data-play-card='" + esc(item.id) + "' title='Play Now'>" +
      "<svg width='18' height='18' viewBox='0 0 24 24' fill='currentColor'><polygon points='5 3 19 12 5 21 5 3'/></svg></button>" +
      "<button class='card-action-btn' data-info-card='" + esc(item.id) + "' title='More Info'>" +
      "<svg width='18' height='18' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2'><circle cx='12' cy='12' r='10'/><line x1='12' y1='16' x2='12' y2='12'/><line x1='12' y1='8' x2='12.01' y2='8'/></svg></button>" +
      "</div></div></div>" +
      "<div class='post-card-info'>" +
      "<div class='post-card-title'>" + esc(item.title) + "</div>" +
      "<div class='post-card-meta'><span>" + esc(item.year || "2024") + "</span><span>•</span><span>" + esc(item.provider ? item.provider : (item.type === "movie" ? "Movie" : "Series")) + "</span></div>" +
      "</div></div>";
  }

  function bindCardEvents() {
    document.querySelectorAll(".post-card").forEach(function (card) {
      card.onclick = function (e) {
        var id = card.dataset.id;
        var prov = card.dataset.prov;
        var link = card.dataset.link;
        var it = findCatalogItem(id);
        if (!it) {
          it = {
            id: id,
            title: card.querySelector(".post-card-title").textContent,
            poster: card.querySelector(".post-card-img").src,
            backdrop: card.querySelector(".post-card-img").src,
            provider: prov,
            link: link,
            quality: "HD"
          };
        }
        if (e.target.closest("[data-play-card]")) {
          if (it.provider && it.link) {
            var p = provById(it.provider) || curProvider();
            if (p) {
              showToast("Loading streams from " + (p.display_name || p.value) + "...");
              getStream(p, it.link, "movie").then(function (streams) {
                if (streams.length) openPlayer(it, "", 0, null, streams);
                else showToast("No streams found", "warning");
              }).catch(function (err) { showToast(err.message, "warning"); });
              return;
            }
          }
          openPlayer(it);
        } else {
          openMediaModal(it);
        }
      };
    });
  }

  // HOME VIEW
  function renderHomeView() {
    var cur = curProvider();
    var progressItems = Object.values(S.progress).filter(function (p) {
      return p && p.t > 10;
    }).sort(function (a, b) { return (b.at || 0) - (a.at || 0); });

    var hero = sampleCatalog[0];
    var trending = sampleCatalog.slice(0, 6);
    var movies = sampleCatalog.filter(function (x) { return x.type === "movie"; });
    var series = sampleCatalog.filter(function (x) { return x.type === "series" || x.type === "anime"; });

    var html = "<div class='home-container'>";

    if (hero) {
      html += "<section class='hero-container' id='hero-banner'>" +
        "<div class='hero-backdrop' style='background-image:url(\"" + esc(hero.backdrop || hero.poster) + "\");'></div>" +
        "<div class='hero-vignette'></div>" +
        "<div class='hero-content'>" +
        "<div class='hero-badge-row'>" +
        "<span class='hero-badge'>" + esc(hero.quality || "4K HDR") + "</span>" +
        "<span class='hero-rating'>★ " + esc(hero.rating || "8.8") + "</span>" +
        "<span class='hero-meta-item'>" + esc(hero.year || "2024") + "</span>" +
        "<span class='hero-meta-item'>•</span>" +
        "<span class='hero-meta-item'>" + esc(hero.duration || "2h 46m") + "</span>" +
        (cur ? "<span class='hero-badge' style='background:var(--primary);'>" + esc(cur.display_name || cur.value) + "</span>" : "") +
        "</div>" +
        "<h1 class='hero-title'>" + esc(hero.title) + "</h1>" +
        "<p class='hero-overview'>" + esc(hero.overview || "") + "</p>" +
        "<div class='hero-actions'>" +
        "<button class='btn-primary' id='hero-play-btn'>" +
        "<svg width='20' height='20' viewBox='0 0 24 24' fill='currentColor'><polygon points='5 3 19 12 5 21 5 3'/></svg> Watch Now</button>" +
        "<button class='btn-secondary' id='hero-info-btn'>" +
        "<svg width='20' height='20' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2'><circle cx='12' cy='12' r='10'/><line x1='12' y1='16' x2='12' y2='12'/><line x1='12' y1='8' x2='12.01' y2='8'/></svg> More Info</button>" +
        "<button class='btn-secondary' id='hero-wl-btn'>" +
        "<svg width='20' height='20' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2'><path d='M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z'/></svg> Library</button>" +
        "</div></div></section>";
    }

    if (progressItems.length > 0) {
      html += "<section class='carousel-section'>" +
        "<div class='carousel-header'><h2 class='carousel-title'>Continue Watching</h2></div>" +
        "<div class='carousel-row'>" +
        progressItems.map(function (p) {
          var pct = Math.min(100, Math.round((p.t / (p.d || 1)) * 100));
          return "<div class='continue-card' data-resume-id='" + esc(p.id) + "' data-resume-t='" + p.t + "'>" +
            "<div class='continue-thumb-wrapper'>" +
            "<img src='" + esc(p.backdrop || p.poster || "") + "' alt='' class='continue-thumb'/>" +
            "<div class='continue-progress-bar'><div class='continue-progress-fill' style='width:" + pct + "%'></div></div>" +
            "<button class='continue-play-overlay'><svg width='24' height='24' viewBox='0 0 24 24' fill='currentColor'><polygon points='5 3 19 12 5 21 5 3'/></svg></button>" +
            "</div>" +
            "<div class='continue-info'>" +
            "<div class='continue-title'>" + esc(p.title) + "</div>" +
            "<div class='continue-sub'>" + fmtTime(p.t) + " left • " + pct + "%</div>" +
            "</div></div>";
        }).join("") +
        "</div></section>";
    }

    // Dynamic Provider Section Container
    html += "<div id='dynamic-home-sections'>";
    if (cur) {
      html += "<section class='carousel-section'>" +
        "<div class='carousel-header'><h2 class='carousel-title'>Latest on " + esc(cur.display_name || cur.value) + "</h2></div>" +
        "<div class='carousel-row' id='prov-home-row'><div style='padding:20px;color:var(--on-surface-variant);'>Loading provider feeds...</div></div>" +
        "</section>";
    }

    // Showcase Carousels
    html += "<section class='carousel-section'>" +
      "<div class='carousel-header'><h2 class='carousel-title'>Trending Now</h2></div>" +
      "<div class='carousel-row'>" + trending.map(renderMediaCard).join("") + "</div>" +
      "</section>";

    html += "<section class='carousel-section'>" +
      "<div class='carousel-header'><h2 class='carousel-title'>Blockbuster Movies</h2></div>" +
      "<div class='carousel-row'>" + movies.map(renderMediaCard).join("") + "</div>" +
      "</section>";

    html += "<section class='carousel-section'>" +
      "<div class='carousel-header'><h2 class='carousel-title'>Top TV Series & Anime</h2></div>" +
      "<div class='carousel-row'>" + series.map(renderMediaCard).join("") + "</div>" +
      "</section>";

    html += "</div></div>";
    pageContainer.innerHTML = html;

    if (hero) {
      document.getElementById("hero-play-btn").onclick = function () { openPlayer(hero); };
      document.getElementById("hero-info-btn").onclick = function () { openMediaModal(hero); };
      document.getElementById("hero-wl-btn").onclick = function () { toggleWatchlist(hero.id); };
    }

    document.querySelectorAll("[data-resume-id]").forEach(function (el) {
      el.onclick = function () {
        var it = findCatalogItem(el.dataset.resumeId);
        if (it) openPlayer(it, "", Number(el.dataset.resumeT));
      };
    });

    bindCardEvents();

    // Async Provider Content Loader
    if (cur) {
      getPosts(cur, "", 1).then(function (posts) {
        var row = document.getElementById("prov-home-row");
        if (row && posts.length) {
          row.innerHTML = posts.map(renderMediaCard).join("");
          bindCardEvents();
        } else if (row) {
          row.innerHTML = "<div style='padding:20px;color:var(--on-surface-variant);'>No recent posts available from this provider.</div>";
        }
      }).catch(function (e) {
        var row = document.getElementById("prov-home-row");
        if (row) row.innerHTML = "<div style='padding:20px;color:var(--on-surface-variant);'>Feed error: " + esc(e.message) + "</div>";
      });
    }
  }

  // DISCOVER / CATALOG VIEW
  function renderCatalogView() {
    var cur = curProvider();
    var types = [
      { id: "all", label: "All Titles" },
      { id: "movie", label: "Movies" },
      { id: "series", label: "TV Series" },
      { id: "anime", label: "Anime" }
    ];
    var genres = ["all", "Action", "Sci-Fi", "Drama", "Animation", "Thriller", "Adventure"];

    var filtered = sampleCatalog.filter(function (it) {
      if (S.catalogFilter !== "all" && it.type !== S.catalogFilter) return false;
      if (S.catalogGenre !== "all" && (!it.genres || !it.genres.includes(S.catalogGenre))) return false;
      return true;
    });

    var html = "<div class='catalog-container'>" +
      "<div class='catalog-header'>" +
      "<h2 style='font-size:1.5rem;font-weight:700;'>Discover Media " + (cur ? "<span style='font-size:1rem;color:var(--primary);font-weight:400;'>• " + esc(cur.display_name || cur.value) + "</span>" : "") + "</h2>" +
      "<div class='filter-group' style='margin-top:16px;display:flex;gap:8px;flex-wrap:wrap;'>" +
      types.map(function (t) {
        return "<button class='filter-chip" + (S.catalogFilter === t.id ? " active" : "") + "' data-cat-type='" + t.id + "'>" + esc(t.label) + "</button>";
      }).join("") +
      "</div>" +
      "<div class='filter-group' style='margin-top:10px;display:flex;gap:6px;flex-wrap:wrap;'>" +
      genres.map(function (g) {
        return "<button class='filter-chip" + (S.catalogGenre === g ? " active" : "") + "' data-cat-genre='" + g + "'>" + (g === "all" ? "All Genres" : g) + "</button>";
      }).join("") +
      "</div></div>" +
      "<div class='catalog-grid' id='catalog-grid-cards' style='margin-top:24px;'>" +
      (filtered.length ? filtered.map(renderMediaCard).join("") : "<div style='color:var(--on-surface-variant);padding:40px;'>No titles match the selected filters.</div>") +
      "</div></div>";

    pageContainer.innerHTML = html;

    document.querySelectorAll("[data-cat-type]").forEach(function (btn) {
      btn.onclick = function () {
        S.catalogFilter = btn.dataset.catType;
        renderCatalogView();
      };
    });
    document.querySelectorAll("[data-cat-genre]").forEach(function (btn) {
      btn.onclick = function () {
        S.catalogGenre = btn.dataset.catGenre;
        renderCatalogView();
      };
    });

    bindCardEvents();

    if (cur) {
      getPosts(cur, "", 1).then(function (posts) {
        var grid = document.getElementById("catalog-grid-cards");
        if (grid && posts.length) {
          grid.innerHTML = posts.map(renderMediaCard).join("");
          bindCardEvents();
        }
      }).catch(function () {});
    }
  }

  // SEARCH VIEW
  function renderSearchView(query) {
    query = (query !== undefined ? query : S.searchQuery) || "";
    var q = query.trim().toLowerCase();
    var cur = curProvider();
    var results = [];

    if (q) {
      results = sampleCatalog.filter(function (it) {
        var matchTitle = it.title.toLowerCase().indexOf(q) !== -1;
        var matchGenre = it.genres && it.genres.some(function (g) { return g.toLowerCase().indexOf(q) !== -1; });
        var matchCast = it.cast && it.cast.some(function (c) { return c.toLowerCase().indexOf(q) !== -1; });
        return matchTitle || matchGenre || matchCast;
      });
    }

    var quickTags = ["Dune", "Interstellar", "Anime", "4K HDR", "Cyberpunk", "Oppenheimer", "Action"];

    var html = "<div class='search-view-container' style='padding-top:16px;'>" +
      "<div class='search-view-header' style='max-width:680px;margin-bottom:24px;'>" +
      "<h2 style='font-size:1.5rem;font-weight:700;margin-bottom:14px;'>Search Catalog</h2>" +
      "<div class='header-search' style='display:flex;width:100%;'>" +
      "<span class='header-search-icon'><svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2'><circle cx='11' cy='11' r='8'/><line x1='21' y1='21' x2='16.65' y2='16.65'/></svg></span>" +
      "<input type='text' id='search-page-input' value='" + esc(query) + "' placeholder='Type to search movies, series, anime, genres...' style='width:100%;'/>" +
      "</div>" +
      "<div style='display:flex;gap:6px;margin-top:12px;flex-wrap:wrap;'>" +
      quickTags.map(function (tag) {
        return "<button class='filter-chip' data-tag='" + esc(tag) + "'>" + esc(tag) + "</button>";
      }).join("") +
      "</div></div>" +
      "<div class='catalog-grid' id='search-results-grid'>" +
      (q ? (results.length ? results.map(renderMediaCard).join("") : "<div style='color:var(--on-surface-variant);padding:40px;'>Searching...</div>") :
        "<div style='color:var(--on-surface-variant);padding:40px;'>Explore titles using the search bar or quick tag chips above.</div>") +
      "</div></div>";

    pageContainer.innerHTML = html;

    var input = document.getElementById("search-page-input");
    if (input) {
      input.focus();
      input.oninput = function (e) {
        S.searchQuery = e.target.value;
        renderSearchView(e.target.value);
      };
    }

    document.querySelectorAll("[data-tag]").forEach(function (btn) {
      btn.onclick = function () {
        S.searchQuery = btn.dataset.tag;
        renderSearchView(btn.dataset.tag);
      };
    });

    bindCardEvents();

    if (q && cur) {
      searchPosts(cur, q, 1).then(function (provResults) {
        var grid = document.getElementById("search-results-grid");
        if (grid && provResults.length) {
          grid.innerHTML = provResults.map(renderMediaCard).join("");
          bindCardEvents();
        } else if (grid && !results.length) {
          grid.innerHTML = "<div style='color:var(--on-surface-variant);padding:40px;'>No results found on " + esc(cur.display_name || cur.value) + "</div>";
        }
      }).catch(function () {});
    }
  }

  // LIBRARY / WATCHLIST VIEW
  function renderWatchlistView() {
    var items = S.watchlist.map(function (id) {
      return findCatalogItem(id);
    }).filter(Boolean);

    var html = "<div class='watchlist-container' style='padding-top:16px;'>" +
      "<div style='display:flex;align-items:center;justify-content:space-between;margin-bottom:24px;'>" +
      "<div><h2 style='font-size:1.5rem;font-weight:700;'>My Library</h2>" +
      "<p style='font-size:0.85rem;color:var(--on-surface-variant);'>Tracked movies, series, and bookmarked streams</p></div>" +
      "<div><span class='hero-badge'>" + items.length + " Saved</span></div>" +
      "</div>" +
      "<div class='catalog-grid'>" +
      (items.length ? items.map(renderMediaCard).join("") :
        "<div style='padding:60px 20px;text-align:center;color:var(--on-surface-variant);'>" +
        "<svg width='48' height='48' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='1.5' style='margin:0 auto 12px;opacity:0.4;'><path d='M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z'/></svg>" +
        "<div style='font-size:1.1rem;font-weight:600;margin-bottom:6px;'>Your Library is Empty</div>" +
        "<p style='font-size:0.85rem;'>Add titles to your library from Home or Discover to track them here.</p>" +
        "<button class='btn-primary' style='margin-top:16px;' onclick='window.vegaNavigate(\"catalog\")'>Discover Titles</button></div>") +
      "</div></div>";

    pageContainer.innerHTML = html;
    bindCardEvents();
  }

  // DOWNLOADS VIEW
  function renderDownloadsView() {
    pageContainer.innerHTML = "<div class='downloads-container' style='padding-top:16px;'>" +
      "<h2 style='font-size:1.5rem;font-weight:700;margin-bottom:8px;'>Downloads & Offline</h2>" +
      "<p style='font-size:0.85rem;color:var(--on-surface-variant);margin-bottom:24px;'>Manage offline queued streams and downloaded episodes</p>" +
      "<div style='background:var(--surface-container);border:1px solid var(--outline-variant);border-radius:var(--rounded-lg);padding:40px;text-align:center;'>" +
      "<div class='sidebar-brand-icon' style='width:40px;height:40px;margin:0 auto 14px;'></div>" +
      "<div style='font-size:1.1rem;font-weight:600;margin-bottom:6px;'>No Active Downloads</div>" +
      "<p style='font-size:0.85rem;color:var(--on-surface-variant);max-width:440px;margin:0 auto;'>Streams can be cached offline via Service Worker or streamed natively via WebTorrent peer-to-peer demuxing.</p>" +
      "</div></div>";
  }

  // EXTENSIONS / PROVIDERS VIEW
  function renderExtensionsView() {
    var activeCount = activeProviders().length;

    var html = "<div class='extensions-container' style='padding-top:16px;'>" +
      "<div style='display:flex;align-items:center;justify-content:space-between;margin-bottom:24px;flex-wrap:wrap;gap:12px;'>" +
      "<div><h2 style='font-size:1.5rem;font-weight:700;'>Streaming Providers & Repositories</h2>" +
      "<p style='font-size:0.85rem;color:var(--on-surface-variant);'>Install community scraper providers, manage repository manifests, or add direct media sources.</p></div>" +
      "<div style='display:flex;gap:8px;'>" +
      "<button class='btn-secondary' id='btn-add-source'>+ Add Media Stream</button>" +
      "</div></div>" +

      // Quick Install Recommendation for Zenda-Cross
      (!S.repos.some(function (r) { return /zenda/i.test(r.name || r.base); }) ?
        "<div style='background:linear-gradient(135deg, var(--surface-container-high), var(--surface-container));border:1px solid var(--primary);border-radius:var(--rounded-lg);padding:18px 22px;margin-bottom:24px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:14px;'>" +
        "<div><div style='font-weight:700;font-size:1rem;color:var(--on-surface);'>Featured: Zenda-Cross Vega Providers</div>" +
        "<div style='font-size:0.825rem;color:var(--on-surface-variant);margin-top:2px;'>Install the official community repository with 63 verified scraping providers.</div></div>" +
        "<button class='btn-primary' id='quick-install-zenda' style='white-space:nowrap;'>+ Install Zenda-Cross (63 Providers)</button>" +
        "</div>" : "") +

      // Install Repo Form
      "<div class='settings-section' style='margin-bottom:24px;'>" +
      "<h3 class='settings-section-title'>" +
      "<svg width='20' height='20' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2'><path d='M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4'/><polyline points='17 8 12 3 7 8'/><line x1='12' y1='3' x2='12' y2='15'/></svg>" +
      "Install Repository Manifest</h3>" +
      "<div style='display:flex;gap:10px;margin-top:12px;'>" +
      "<input type='text' id='repo-input' class='app-input' style='margin:0;flex:1;' placeholder='GitHub username, repo (e.g. Zenda-Cross/vega-providers) or URL'/>" +
      "<button class='btn-primary' id='repo-add-btn' style='white-space:nowrap;'>Install Repo</button>" +
      "</div>" +
      "<div style='font-size:0.775rem;color:var(--on-surface-variant);margin-top:8px;'>Resolves GitHub Pages and raw branches automatically. Providers run safely inside a sandboxed Web Worker.</div>" +
      "</div>" +

      // Installed Repositories Section
      (S.repos.length ?
        "<div class='settings-section' style='margin-bottom:24px;'>" +
        "<h3 class='settings-section-title'>Installed Repositories (" + S.repos.length + ")</h3>" +
        "<div style='display:flex;flex-direction:column;gap:8px;margin-top:12px;'>" +
        S.repos.map(function (r, idx) {
          return "<div style='display:flex;align-items:center;justify-content:space-between;background:var(--surface-container-high);padding:10px 16px;border-radius:var(--rounded-md);border:1px solid var(--outline-variant);'>" +
            "<div><div style='font-weight:600;font-size:0.9rem;'>" + esc(r.name || r.base) + "</div>" +
            "<div style='font-size:0.75rem;color:var(--on-surface-variant);font-family:monospace;'>" + esc(r.base) + "</div></div>" +
            "<button class='btn-secondary' style='padding:4px 10px;font-size:0.75rem;color:#f87171;' data-remove-repo='" + idx + "'>Remove</button>" +
            "</div>";
        }).join("") +
        "</div></div>" : "") +

      // Installed Providers List
      "<div class='settings-section'>" +
      "<h3 class='settings-section-title'>Available Providers (" + activeCount + " active)</h3>" +
      "<div class='provider-list' style='display:flex;flex-direction:column;gap:10px;margin-top:14px;'>" +
      (S.providers.length ? S.providers.map(function (p) {
        var on = !p.disabled && !S.off[p.value];
        return "<div class='provider-card' style='display:flex;align-items:center;justify-content:space-between;background:var(--surface-container-high);padding:14px 18px;border-radius:var(--rounded-lg);border:1px solid var(--outline-variant);'>" +
          "<div style='display:flex;align-items:center;gap:14px;'>" +
          (p.icon ? "<img src='" + esc(p.icon) + "' alt='' style='width:38px;height:38px;border-radius:var(--rounded-md);object-fit:cover;' onerror='this.style.display=\"none\"'/>" :
            "<div style='width:38px;height:38px;border-radius:var(--rounded-md);background:var(--primary-container);color:var(--primary);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:1.1rem;'>" +
            esc((p.display_name || p.value).charAt(0).toUpperCase()) + "</div>") +
          "<div><div style='font-weight:700;font-size:0.95rem;'>" + esc(p.display_name || p.value) + " <span style='font-size:0.75rem;color:var(--on-surface-variant);font-weight:400;'>v" + esc(p.version || "1.0") + "</span></div>" +
          "<div style='font-size:0.8rem;color:var(--on-surface-variant);margin-top:2px;'>" + esc(p.type || "global") + "</div></div></div>" +
          "<div style='display:flex;align-items:center;gap:12px;'>" +
          (p.hasSettings ? "<button class='btn-secondary' style='padding:4px 10px;font-size:0.75rem;' data-psettings='" + esc(p.value) + "'>⚙ Settings</button>" : "") +
          "<label class='switch'><input type='checkbox' " + (on ? "checked" : "") + " data-toggle-prov='" + esc(p.value) + "'><span class='slider'></span></label>" +
          "</div></div>";
      }).join("") :
        "<div style='padding:20px;color:var(--on-surface-variant);'>No external provider repository installed yet. Vega Showcase Catalog is active.</div>") +
      "</div></div></div>";

    pageContainer.innerHTML = html;

    // Quick Install Zenda
    var qz = document.getElementById("quick-install-zenda");
    if (qz) {
      qz.onclick = function () {
        qz.disabled = true;
        qz.textContent = "Installing...";
        showToast("Fetching Zenda-Cross repository manifest...");
        addRepo("Zenda-Cross/vega-providers").then(function (count) {
          showToast("Successfully added " + count + " providers from Zenda-Cross!", "success");
          fillProviderSelect();
          renderExtensionsView();
        }).catch(function (err) {
          qz.disabled = false;
          qz.textContent = "+ Install Zenda-Cross";
          showToast("Failed to install: " + err.message, "warning");
        });
      };
    }

    // Bind Add Repo Input Button
    document.getElementById("repo-add-btn").onclick = function () {
      var input = document.getElementById("repo-input");
      var val = input.value.trim();
      if (!val) {
        showToast("Please enter a repository name or URL", "warning");
        return;
      }
      var btn = document.getElementById("repo-add-btn");
      btn.disabled = true;
      btn.textContent = "Installing...";
      showToast("Fetching provider manifest: " + val + "...");
      addRepo(val).then(function (count) {
        btn.disabled = false;
        btn.textContent = "Install Repo";
        input.value = "";
        showToast("Successfully added repository with " + count + " providers!", "success");
        fillProviderSelect();
        renderExtensionsView();
      }).catch(function (err) {
        btn.disabled = false;
        btn.textContent = "Install Repo";
        showToast("Error: " + err.message, "warning");
      });
    };

    // Bind Remove Repo
    document.querySelectorAll("[data-remove-repo]").forEach(function (btn) {
      btn.onclick = function () {
        removeRepo(Number(btn.dataset.removeRepo));
      };
    });

    // Bind Provider Settings
    document.querySelectorAll("[data-psettings]").forEach(function (btn) {
      btn.onclick = function () {
        var pv = provById(btn.dataset.psettings);
        if (pv) openProviderSettings(pv);
      };
    });

    // Bind Toggle
    document.querySelectorAll("[data-toggle-prov]").forEach(function (chk) {
      chk.onchange = function () {
        var v = chk.dataset.toggleProv;
        S.off[v] = !chk.checked;
        if (chk.checked) delete S.off[v];
        save("off", S.off);
        fillProviderSelect();
        showToast("Provider " + (chk.checked ? "Enabled" : "Disabled"));
      };
    });

    // Add Media Stream Modal
    document.getElementById("btn-add-source").onclick = function () {
      openAppModal("Add Direct Media Stream",
        "<div class='app-form-group'>" +
        "<label class='app-form-label'>Stream Title</label>" +
        "<input type='text' id='custom-stream-title' class='app-input' placeholder='My Video Title'/></div>" +
        "<div class='app-form-group'>" +
        "<label class='app-form-label'>Stream URL or Magnet Link</label>" +
        "<input type='text' id='custom-stream-url' class='app-input' placeholder='https://example.com/video.m3u8 or magnet:?xt=...'/></div>" +
        "<div class='app-form-group'>" +
        "<label class='app-form-label'>Poster Image URL (Optional)</label>" +
        "<input type='text' id='custom-stream-poster' class='app-input' placeholder='https://example.com/poster.jpg'/></div>" +
        "<div style='display:flex;justify-content:flex-end;gap:10px;margin-top:20px;'>" +
        "<button class='btn-secondary' onclick='closeAppModal()'>Cancel</button>" +
        "<button class='btn-primary' id='save-custom-stream'>Save & Stream</button></div>"
      );

      document.getElementById("save-custom-stream").onclick = function () {
        var title = document.getElementById("custom-stream-title").value.trim() || "Custom Stream";
        var url = document.getElementById("custom-stream-url").value.trim();
        var poster = document.getElementById("custom-stream-poster").value.trim();
        if (!url) {
          showToast("Stream URL is required", "warning");
          return;
        }
        var customItem = {
          id: "custom-" + Date.now(),
          title: title,
          type: "movie",
          poster: poster || "assets/favicon.png",
          backdrop: poster || "assets/favicon.png",
          videoUrl: url,
          quality: "Source HD"
        };
        sampleCatalog.unshift(customItem);
        closeAppModal();
        showToast("Stream added to catalog");
        openPlayer(customItem);
      };
    };
  }

  // SETTINGS VIEW
  function renderSettingsView() {
    var accents = typeof VEGA_ACCENTS !== "undefined" ? VEGA_ACCENTS : [
      { name: "Vega", color: "#FF6347" },
      { name: "Hayasaka", color: "#00e6e6" },
      { name: "Lavender", color: "#B2A4D4" },
      { name: "Sky", color: "#87CEEB" },
      { name: "Mint", color: "#98FB98" },
      { name: "Sunset", color: "#FFA07A" },
      { name: "Flix", color: "#E50914" },
      { name: "Material", color: "#2196F3" },
      { name: "Custom", color: "#FFFFFF" }
    ];

    var html = "<div class='settings-container' style='padding-top:16px;'>" +
      "<h2 style='font-size:1.5rem;font-weight:700;margin-bottom:24px;'>Settings & Preferences</h2>" +

      // Appearance
      "<div class='settings-section'>" +
      "<h3 class='settings-section-title'>" +
      "<svg width='20' height='20' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2'><circle cx='12' cy='12' r='5'/><line x1='12' y1='1' x2='12' y2='3'/><line x1='12' y1='21' x2='12' y2='23'/><line x1='4.22' y1='4.22' x2='5.64' y2='5.64'/><line x1='18.36' y1='18.36' x2='19.78' y2='19.78'/><line x1='1' y1='12' x2='3' y2='12'/><line x1='21' y1='12' x2='23' y2='12'/><line x1='4.22' y1='19.78' x2='5.64' y2='18.36'/><line x1='18.36' y1='5.64' x2='19.78' y2='4.22'/></svg>" +
      "Appearance & Interface</h3>" +

      "<div class='settings-row'>" +
      "<div class='settings-info'><h4>Theme Mode</h4><p>Choose your dark or light display interface style</p></div>" +
      "<div class='theme-toggle-group'>" +
      "<button class='theme-btn" + (S.theme === "oled" ? " active" : "") + "' data-theme='oled'>OLED Black</button>" +
      "<button class='theme-btn" + (S.theme === "gray" ? " active" : "") + "' data-theme='gray'>Dark Gray</button>" +
      "<button class='theme-btn" + (S.theme === "white" ? " active" : "") + "' data-theme='white'>White</button>" +
      "</div></div>" +

      "<div class='settings-row'>" +
      "<div class='settings-info'><h4>Primary Accent Color</h4><p>Vega signature highlights across badges, buttons, and seek handles</p></div>" +
      "<div class='accent-color-grid'>" +
      accents.map(function (acc) {
        var isAct = S.accentColor.toLowerCase() === acc.color.toLowerCase();
        return "<button class='accent-color-btn" + (isAct ? " active" : "") + "' style='background-color:" + acc.color + ";' data-color='" + acc.color + "' title='" + esc(acc.name) + "'>" +
          (isAct ? "<span style='color:#fff;font-size:13px;'>✔</span>" : "") + "</button>";
      }).join("") +
      "</div></div>" +

      "<div class='settings-row'>" +
      "<div class='settings-info'><h4>UI Scaling</h4><p>Adjust layout scale for high-DPI and mobile displays</p></div>" +
      "<select class='filter-select' id='ui-scale-select'>" +
      "<option value='85'" + (S.uiScale === 85 ? " selected" : "") + ">85% (Compact)</option>" +
      "<option value='100'" + (S.uiScale === 100 ? " selected" : "") + ">100% (Default)</option>" +
      "<option value='110'" + (S.uiScale === 110 ? " selected" : "") + ">110%</option>" +
      "<option value='125'" + (S.uiScale === 125 ? " selected" : "") + ">125% (Large)</option>" +
      "</select></div>" +
      "</div>" +

      // Playback & Engine
      "<div class='settings-section'>" +
      "<h3 class='settings-section-title'>" +
      "<svg width='20' height='20' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2'><polygon points='5 3 19 12 5 21 5 3'/></svg>" +
      "Playback & Multimedia Engine</h3>" +

      "<div class='settings-row'>" +
      "<div class='settings-info'><h4>Use Libmedia Player Engine</h4><p>Hardware-accelerated Wasm + WebCodecs player (AC3/DTS/HEVC/Multi-Audio demuxing)</p></div>" +
      "<label class='switch'><input type='checkbox' id='pref-libmedia' " + (S.prefs.preferLibmedia ? "checked" : "") + "/><span class='slider'></span></label>" +
      "</div>" +

      "<div class='settings-row'>" +
      "<div class='settings-info'><h4>Auto-Play Next Episode</h4><p>Automatically queue and start subsequent episodes</p></div>" +
      "<label class='switch'><input type='checkbox' id='pref-next' " + (S.prefs.autoNext ? "checked" : "") + "/><span class='slider'></span></label>" +
      "</div>" +
      "</div>" +

      // Proxy & Scraping Relay Section
      "<div class='settings-section'>" +
      "<h3 class='settings-section-title'>" +
      "<svg width='20' height='20' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2'><rect x='2' y='2' width='20' height='8' rx='2' ry='2'/><rect x='2' y='14' width='20' height='8' rx='2' ry='2'/><line x1='6' y1='6' x2='6.01' y2='6'/><line x1='6' y1='18' x2='6.01' y2='18'/></svg>" +
      "Scraper Proxy & CORS Bypass Relay</h3>" +

      "<div class='settings-row'>" +
      "<div class='settings-info'><h4>Proxy Service URL</h4><p>Endpoint used to bypass CORS and scraper Cloudflare blocks</p></div>" +
      "<input class='app-input' type='text' id='proxy-url-input' value='" + esc(S.proxy.url || "/api/proxy") + "' style='max-width:240px;'/>" +
      "</div>" +

      "<div class='settings-row'>" +
      "<div class='settings-info'><h4>Proxy Access Key</h4><p>Key matching PROXY_ACCESS_KEY on your server or Koyeb</p></div>" +
      "<input class='app-input' type='text' id='proxy-key-input' value='" + esc(S.proxy.key || "mysecret") + "' style='max-width:240px;'/>" +
      "</div>" +

      "<div style='display:flex;justify-content:flex-end;gap:10px;margin-top:14px;'>" +
      "<button class='btn-secondary' id='btn-test-proxy'>Test Proxy Connection</button>" +
      "<button class='btn-primary' id='btn-save-proxy'>Save Proxy Key</button>" +
      "</div>" +
      "<div id='proxy-test-status' style='font-size:0.8rem;color:var(--on-surface-variant);margin-top:8px;'></div>" +
      "</div>" +

      // About
      "<div class='settings-section' style='border-color:rgba(var(--primary-rgb), 0.3);'>" +
      "<div style='display:flex;align-items:center;gap:16px;'>" +
      "<div class='sidebar-brand-icon' style='width:44px;height:44px;'></div>" +
      "<div><h4 style='font-size:1.15rem;font-weight:700;'>Vega Web</h4>" +
      "<p style='font-size:0.825rem;color:var(--on-surface-variant);'>Cross-platform media streaming web application • Libmedia AVPlayer Engine</p></div></div>" +
      "<div style='display:flex;gap:14px;margin-top:16px;'>" +
      "<a href='https://web.vega-app.in' target='_blank' class='btn-secondary' style='font-size:0.85rem;padding:8px 16px;'>Official Vega App</a>" +
      "<a href='https://github.com/Zenda-Cross/vega-providers' target='_blank' class='btn-secondary' style='font-size:0.85rem;padding:8px 16px;'>Zenda-Cross Providers</a>" +
      "</div></div>" +

      "</div>";

    pageContainer.innerHTML = html;

    document.querySelectorAll(".theme-btn").forEach(function (btn) {
      btn.onclick = function () { applyTheme(btn.dataset.theme); };
    });

    document.querySelectorAll(".accent-color-btn").forEach(function (btn) {
      btn.onclick = function () {
        applyAccentColor(btn.dataset.color);
        renderSettingsView();
        showToast("Accent set to " + btn.title);
      };
    });

    var scaleSelect = document.getElementById("ui-scale-select");
    if (scaleSelect) {
      scaleSelect.onchange = function (e) {
        applyUiScale(Number(e.target.value));
        showToast("UI scale set to " + e.target.value + "%");
      };
    }

    document.getElementById("pref-libmedia").onchange = function (e) {
      S.prefs.preferLibmedia = e.target.checked;
      save("prefs", S.prefs);
      showToast("Libmedia Engine " + (e.target.checked ? "Enabled" : "Disabled"));
    };
    document.getElementById("pref-next").onchange = function (e) {
      S.prefs.autoNext = e.target.checked;
      save("prefs", S.prefs);
    };

    var btnSaveProxy = document.getElementById("btn-save-proxy");
    if (btnSaveProxy) {
      btnSaveProxy.onclick = function () {
        S.proxy.url = document.getElementById("proxy-url-input").value.trim() || "/api/proxy";
        S.proxy.key = document.getElementById("proxy-key-input").value.trim();
        save("proxy", S.proxy);
        showToast("Proxy settings saved");
      };
    }

    var btnTestProxy = document.getElementById("btn-test-proxy");
    if (btnTestProxy) {
      btnTestProxy.onclick = function () {
        var statusEl = document.getElementById("proxy-test-status");
        statusEl.textContent = "Testing connection to " + (S.proxy.url || "/api/proxy") + "...";
        fetch(S.proxy.url || "/api/proxy", {
          headers: S.proxy.key ? { "x-proxy-key": S.proxy.key } : {}
        }).then(function (r) { return r.json(); }).then(function (d) {
          if (d.ok) {
            statusEl.innerHTML = "<span style='color:#4ade80;'>✔ Proxy Online! Configured: " + d.configured + " | Key Validated</span>";
            showToast("Proxy connection successful!", "success");
          } else {
            statusEl.innerHTML = "<span style='color:#f87171;'>✖ Error: " + esc(d.proxyError || "Failed") + "</span>";
          }
        }).catch(function (e) {
          statusEl.innerHTML = "<span style='color:#f87171;'>✖ Connection error: " + esc(e.message) + "</span>";
        });
      };
    }
  }

  /* =====================================================================
   * Router & Navigation
   * ===================================================================== */
  function navigateTo(route, param) {
    S.currentRoute = route || "home";
    location.hash = "#/" + S.currentRoute + (param ? "?q=" + enc(param) : "");

    document.querySelectorAll(".nav-item").forEach(function (el) {
      el.classList.toggle("active", el.dataset.route === S.currentRoute);
    });

    if (S.currentRoute === "home") renderHomeView();
    else if (S.currentRoute === "catalog") renderCatalogView();
    else if (S.currentRoute === "search") renderSearchView(param);
    else if (S.currentRoute === "watchlist") renderWatchlistView();
    else if (S.currentRoute === "downloads") renderDownloadsView();
    else if (S.currentRoute === "extensions") renderExtensionsView();
    else if (S.currentRoute === "settings") renderSettingsView();
    else renderHomeView();

    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  window.vegaNavigate = navigateTo;

  /* =====================================================================
   * Boot & Initialization
   * ===================================================================== */
  document.addEventListener("DOMContentLoaded", function () {
    applyTheme(S.theme);
    applyAccentColor(S.accentColor);
    applyUiScale(S.uiScale);
    applySidebarState();
    updateWatchlistBadge();
    fillProviderSelect();

    document.querySelectorAll(".nav-item").forEach(function (item) {
      item.onclick = function (e) {
        e.preventDefault();
        navigateTo(item.dataset.route);
        var sidebar = document.querySelector(".sidebar");
        if (sidebar) sidebar.classList.remove("open");
      };
    });

    var toggleBtn = document.getElementById("sidebar-toggle-btn");
    if (toggleBtn) {
      toggleBtn.onclick = function () {
        S.sidebarCollapsed = !S.sidebarCollapsed;
        applySidebarState();
      };
    }

    var mobBtn = document.getElementById("mobile-toggle-btn");
    if (mobBtn) {
      mobBtn.onclick = function () {
        var sidebar = document.querySelector(".sidebar");
        if (sidebar) sidebar.classList.toggle("open");
      };
    }

    var searchInput = document.getElementById("header-search-input");
    if (searchInput) {
      searchInput.onkeydown = function (e) {
        if (e.key === "Enter" && searchInput.value.trim()) {
          navigateTo("search", searchInput.value.trim());
        }
      };
    }

    var headSetBtn = document.getElementById("header-settings-btn");
    if (headSetBtn) {
      headSetBtn.onclick = function () { navigateTo("settings"); };
    }

    document.getElementById("modal-close-btn").onclick = closeMediaModal;
    document.getElementById("media-modal").onclick = function (e) {
      if (e.target === this) closeMediaModal();
    };

    document.getElementById("player-back-btn").onclick = closePlayer;

    window.addEventListener("keydown", function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        navigateTo("search");
      }
      if (e.key === "Escape") {
        var sOverlay = document.getElementById("player-settings-overlay");
        if (sOverlay && sOverlay.classList.contains("visible")) {
          closePlayerSettings();
        } else if (document.getElementById("app-modal").classList.contains("active")) {
          closeAppModal();
        } else if (document.getElementById("player-overlay").classList.contains("active")) {
          closePlayer();
        } else if (document.getElementById("media-modal").classList.contains("active")) {
          closeMediaModal();
        }
      }
    });

    function handleHash() {
      var h = location.hash.replace(/^#\/?/, "");
      var parts = h.split("?");
      var route = parts[0] || "home";
      var param = "";
      if (parts[1]) {
        var m = parts[1].match(/q=([^&]+)/);
        if (m) param = decodeURIComponent(m[1]);
      }
      navigateTo(route, param);
    }
    window.addEventListener("hashchange", handleHash);
    handleHash();

    if (S.repos.length) refreshProviders();
  });
})();
