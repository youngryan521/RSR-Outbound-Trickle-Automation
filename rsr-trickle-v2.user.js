// ==UserScript==
// @name         RSR+ Outbound Trickle v2
// @namespace    https://github.com/youngryan521
// @version      2.18.0
// @description  Incremental SP00 relay -- Rodeo ManifestPending -> Sort Center Trickle, priority by CPT
// @author       youryanh
// @match        https://rodeo-iad.amazon.com/*
// @match        https://sortcenter-menu-na.amazon.com/containerization/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      trans-logistics.amazon.com
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/youngryan521/RSR-Outbound-Trickle-Automation/main/rsr-trickle-v2.user.js
// @downloadURL  https://raw.githubusercontent.com/youngryan521/RSR-Outbound-Trickle-Automation/main/rsr-trickle-v2.user.js
// ==/UserScript==

(function () {
  'use strict';

  const KEY         = 'rsr_v2';
  const RODEO_MS    = 2000;
  const TRICKLE_MS  = 600;
  const FC_UTC_OFFSET_H = -5;   // QIW9 = CDT (UTC-5)
  const COOLDOWN_MS = 5 * 60000;

  const CPTS = [
    { label: '14:30', h: 14, m: 30, destId: '1ccd5e27-2a40-59cf-37e1-3b880c243e57' },
    { label: '22:00', h: 22, m:  0, destId: 'f6cd5e27-2a42-e873-aa17-be5ebb0539d6' },
    { label: '02:00', h:  2, m:  0, destId: 'aacd5e27-2a4c-7d53-fc04-093007fe0f5c' },
  ];

  // -- STATE ------------------------------------------------------------------

  function blank() {
    return {
      sp00: null, rawId: null, destId: null, cpt: null, action: 'idle',
      pausedAt: null,
      skipList:          [],
      cooldowns:         {},
      recentlyProcessed: [],
      errorCount:        {},
      ok14: 0, err14: 0, ok22: 0, err22: 0, ok02: 0, err02: 0,
    };
  }
  function load()  { try { return JSON.parse(GM_getValue(KEY, 'null')) || blank(); } catch { return blank(); } }
  function save(s) { GM_setValue(KEY, JSON.stringify(s)); }

  // -- SP00 / CPT UTILS -------------------------------------------------------

  // spP only -- direct character conversion (confirmed working)
  function toTrickle(id) { return 'SP' + id.slice(3) + '_001_v'; }

  function dwellMins(text) {
    let m = 0;
    const d  = text.match(/(\d+)\s*d/i);      if (d)  m += +d[1]  * 1440;
    const h  = text.match(/(\d+)\s*h/i);      if (h)  m += +h[1]  * 60;
    const mn = text.match(/(\d+)\s*m(?!s)/i); if (mn) m += +mn[1];
    if (!m) { const hms = text.match(/\b(\d{1,3}):(\d{2})(?::\d{2})?\b/); if (hms) m = +hms[1]*60 + +hms[2]; }
    return m;
  }

  function cptMs(cpt) {
    const now    = new Date();
    const utcMid = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    let utcH = cpt.h - FC_UTC_OFFSET_H, dayOff = 0;
    if (utcH >= 24) { utcH -= 24; dayOff = 1; }
    const ms = utcMid + dayOff * 86400000 + utcH * 3600000 + cpt.m * 60000;
    return ms <= now.getTime() ? ms + 86400000 : ms;
  }

  function cptUrl(cpt) {
    const ms = cptMs(cpt);
    return 'https://rodeo-iad.amazon.com/QIW9/ItemList?WorkPool=ManifestPending' +
           `&ExSDRange.RangeEndMillis=${ms+60000}&Fracs=NON_FRACS` +
           '&ProcessPath=PPSingle%2cPPMultiBldgWide' +
           `&ExSDRange.RangeStartMillis=${ms-1}&shipmentType=CUSTOMER_SHIPMENTS`;
  }

  // -- TANTEI LOOKUP (spR orders) -----------------------------------------------
  // spR (PPMultiBldgWide) SP00s have no deterministic conversion formula.
  // The Trickle ID is obtained by:
  //   1. Extracting ShipmentId from the Rodeo data-url attribute (referenceId param)
  //   2. Querying the tantei GraphQL API with SHIPMENT_ID
  //   3. Finding the containerLabel matching /^SP[A-Za-z0-9]{7}T_001_v$/ in the response

  const sp00ToShipmentId = {};   // populated each fetchItems() call from data-url attrs
  let   tanteiToken      = null; // CSRF token (anti-csrftoken-a2z), cached per session
  const trickleIdCache   = {};   // shipmentId -> trickleId, permanent per session

  // Promise wrapper around GM_xmlhttpRequest (bypasses CORS for cross-origin calls)
  function gmFetch(method, url, headers, body) {
    headers = headers || {};
    body    = body    || null;
    return new Promise(function(resolve, reject) {
      GM_xmlhttpRequest({
        method:          method,
        url:             url,
        headers:         headers,
        data:            body,
        withCredentials: true,
        onload:          function(r) { resolve(r.responseText); },
        onerror:         function()  { reject(new Error('gmFetch failed: ' + url)); },
        ontimeout:       function()  { reject(new Error('gmFetch timeout: ' + url)); },
      });
    });
  }

  // Recursively search parsed JSON for a Trickle-format barcode string
  function findTrickleId(obj) {
    if (!obj || typeof obj !== 'object') return null;
    var vals = Object.values(obj);
    for (var i = 0; i < vals.length; i++) {
      var v = vals[i];
      if (typeof v === 'string' && /^SP[A-Za-z0-9]{7}T_001_v$/.test(v)) return v;
      if (typeof v === 'object') { var f = findTrickleId(v); if (f) return f; }
    }
    return null;
  }

  async function lookupTrickleIdFromTantei(shipmentId) {
    if (trickleIdCache[shipmentId]) return trickleIdCache[shipmentId];
    try {
      // Step 1: get CSRF token from tantei HTML page (cached for the session)
      if (!tanteiToken) {
        console.log('[RSR+][Tantei] Fetching CSRF token...');
        var html = await gmFetch('GET', 'https://trans-logistics.amazon.com/sortcenter/tantei?nodeId=QIW9');
        var m = html.match(/name=['"]__token_['"]\s+value=['"]([^'"]+)['"]/);
        if (m) {
          tanteiToken = m[1];
          console.log('[RSR+][Tantei] Token acquired');
        } else {
          console.log('[RSR+][Tantei] __token_ not found in page');
          return null;
        }
      }

      // Step 2: GraphQL query -- searchEntities with SHIPMENT_ID
      var query = '\n        query ($queryInput: [SearchTermInput!]!, $startIndex: String) {\n          searchEntities(searchTerms: $queryInput) {\n            searchTerm { nodeId searchId searchIdType resolvedIdType }\n            contents(pageSize: 60, startIndex: $startIndex, forwardNavigate: true) {\n              contents {\n                containerId\n                containerLabel\n                containerType\n              }\n              endToken\n            }\n          }\n        }\n      ';

      var variables = {
        queryInput: [{
          nodeId:       'QIW9',
          nodeTimezone: 'America/Chicago',
          searchId:     shipmentId,
          searchIdType: 'SHIPMENT_ID',
        }],
      };

      var responseText = await gmFetch(
        'POST',
        'https://trans-logistics.amazon.com/sortcenter/tantei/graphql',
        { 'Content-Type': 'application/json', 'anti-csrftoken-a2z': tanteiToken },
        JSON.stringify({ query: query, variables: variables })
      );

      var data      = JSON.parse(responseText);
      var trickleId = findTrickleId(data);

      if (trickleId) {
        trickleIdCache[shipmentId] = trickleId;
        console.log('[RSR+][Tantei] Resolved:', shipmentId, '->', trickleId);
        return trickleId;
      }

      console.log('[RSR+][Tantei] No Trickle ID found for shipment', shipmentId);
      console.log('[RSR+][Tantei] Response preview:', responseText.slice(0, 500));
      return null;

    } catch (e) {
      console.log('[RSR+][Tantei] Error:', e.message);
      tanteiToken = null; // reset so it re-fetches next time
      return null;
    }
  }

  // -- RODEO PAGE FETCH -------------------------------------------------------

  async function fetchItems(cpt, skipList, cooldowns) {
    try {
      var url = cptUrl(cpt);
      console.log('[RSR+][Rodeo] Fetching CPT', cpt.label, ':', url);
      var res = await fetch(url, { credentials: 'include' });
      if (!res.ok) {
        console.log('[RSR+][Rodeo] fetchItems HTTP', res.status, 'for CPT', cpt.label);
        return [];
      }
      var html = await res.text();
      console.log('[RSR+][Rodeo] Response preview CPT', cpt.label, ':', html.slice(0, 400).replace(/\s+/g, ' '));
      var doc = new DOMParser().parseFromString(html, 'text/html');

      // Build sp00 -> ShipmentId map from data-url attributes.
      // Each .shipmentitem-highlight-link has:
      //   data-url="/QIW9/ShipmentItem/mark?...&referenceId=458...&...&scannableId=spR...&..."
      doc.querySelectorAll('[data-url]').forEach(function(el) {
        var u   = el.getAttribute('data-url') || '';
        var sp  = u.match(/[?&]scannableId=([^&]+)/);
        var ref = u.match(/[?&]referenceId=(\d{10,})/);
        if (sp && ref) sp00ToShipmentId[sp[1]] = ref[1];
      });

      var out = [];
      doc.querySelectorAll('tr, [role="row"]').forEach(function(row) {
        var txt = row.textContent;
        var sp  = txt.match(/\bsp[A-Z][A-Za-z0-9]{6,18}\b/);
        if (sp) out.push({ id: sp[0], dwell: dwellMins(txt) });
      });

      var skipped = out.filter(function(x) {
        return (skipList || []).includes(x.id) || Date.now() < ((cooldowns || {})[x.id] || 0);
      }).length;
      var filtered = out.filter(function(x) {
        if ((skipList  || []).includes(x.id))             return false;
        if (Date.now() < ((cooldowns || {})[x.id] || 0)) return false;
        return true;
      }).sort(function(a, b) { return b.dwell - a.dwell; });

      console.log('[RSR+][Rodeo] CPT', cpt.label, '-- rows:', out.length, '| skipped:', skipped, '| available:', filtered.length);
      return filtered;
    } catch (e) {
      console.log('[RSR+][Rodeo] fetchItems error for CPT', cpt.label, ':', e.message);
      return [];
    }
  }

  // -- SHARED UTILS -----------------------------------------------------------

  function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

  function waitFor(pred, ms) {
    ms = ms || 5000;
    return new Promise(function(resolve) {
      if (pred()) return resolve(true);
      var ob = new MutationObserver(function() {
        if (pred()) { ob.disconnect(); clearTimeout(t); resolve(true); }
      });
      ob.observe(document.body, { childList: true, subtree: true, characterData: true });
      var t = setTimeout(function() { ob.disconnect(); resolve(false); }, ms);
    });
  }

  // -- ENTRY ------------------------------------------------------------------

  if      (location.href.includes('rodeo-iad.amazon.com'))                           runRodeo();
  else if (location.href.includes('sortcenter-menu-na.amazon.com/containerization')) runTrickle();

  // ==========================================================================
  //  RODEO
  // ==========================================================================
  function runRodeo() {
    var okKey  = { '14:30':'ok14', '22:00':'ok22', '02:00':'ok02'  };
    var errKey = { '14:30':'err14','22:00':'err22','02:00':'err02' };

    async function loop() {
      var s0 = load();
      console.log('[RSR+][Rodeo] Loop started | skipList:', s0.skipList.length, '| action:', s0.action);
      while (true) {
        try {
          await sleep(RODEO_MS);
          var s = load();
          s.skipList          = s.skipList          || [];
          s.cooldowns         = s.cooldowns         || {};
          s.recentlyProcessed = s.recentlyProcessed || [];
          s.errorCount        = s.errorCount        || {};

          // Handle outcome from Trickle side
          if (s.action === 'done') {
            s[okKey[s.cpt]]++;
            s.recentlyProcessed = [s.rawId].concat(s.recentlyProcessed).slice(0, 20);
            s.errorCount[s.rawId] = 0;
            s.action = 'idle'; save(s);

          } else if (s.action === 'step1_fail') {
            s[errKey[s.cpt]]++;
            if (s.rawId && !s.skipList.includes(s.rawId)) {
              s.skipList.push(s.rawId);
              console.log('[RSR+][Rodeo] Permanent skip (step1):', s.rawId);
            }
            s.recentlyProcessed = [s.rawId].concat(s.recentlyProcessed).slice(0, 20);
            s.action = 'idle'; save(s);

          } else if (s.action === 'error') {
            s[errKey[s.cpt]]++;
            if (s.rawId) {
              s.errorCount[s.rawId] = (s.errorCount[s.rawId] || 0) + 1;
              if (s.errorCount[s.rawId] >= 3 && !s.skipList.includes(s.rawId)) {
                s.skipList.push(s.rawId);
                console.log('[RSR+][Rodeo] Permanent skip after 3 errors:', s.rawId);
              } else {
                s.cooldowns[s.rawId] = Date.now() + COOLDOWN_MS;
                console.log('[RSR+][Rodeo] Cooldown for', s.rawId, '(error #' + s.errorCount[s.rawId] + ')');
              }
            }
            s.recentlyProcessed = [s.rawId].concat(s.recentlyProcessed).slice(0, 20);
            s.action = 'idle'; save(s);
          }

          if (s.action === 'pending') continue;

          // Pick highest-dwell item not recently processed
          var pick = null, pickCPT = null, anyAvailable = false;
          for (var ci = 0; ci < CPTS.length; ci++) {
            var cpt   = CPTS[ci];
            var items = await fetchItems(cpt, s.skipList, s.cooldowns);
            if (items.length > 0) anyAvailable = true;
            var c = items.find(function(x) { return !s.recentlyProcessed.includes(x.id); });
            if (c) { pick = c; pickCPT = cpt; break; }
          }

          if (!pick) {
            if (anyAvailable) {
              console.log('[RSR+][Rodeo] All items recently processed -- resetting cycle');
              s.recentlyProcessed = [];
              save(s);
            }
            continue;
          }

          // Resolve Trickle ID:
          //   spP -> toTrickle() -- direct formula, confirmed working
          //   spR -> ShipmentId from Rodeo data-url -> tantei GraphQL -> containerLabel
          var trickleId;
          if (pick.id.startsWith('spR')) {
            var shipId = sp00ToShipmentId[pick.id];
            if (!shipId) {
              console.log('[RSR+][Rodeo] No ShipmentId for spR:', pick.id, '-- 30s retry');
              s.cooldowns[pick.id] = Date.now() + 30000;
              s.recentlyProcessed = [pick.id].concat(s.recentlyProcessed).slice(0, 20);
              save(s); continue;
            }
            trickleId = await lookupTrickleIdFromTantei(shipId);
            if (!trickleId) {
              console.log('[RSR+][Rodeo] Tantei lookup failed for', pick.id, '(shipId:', shipId, ') -- 5m cooldown');
              s.cooldowns[pick.id] = Date.now() + COOLDOWN_MS;
              s.recentlyProcessed = [pick.id].concat(s.recentlyProcessed).slice(0, 20);
              save(s); continue;
            }
          } else {
            trickleId = toTrickle(pick.id);
          }

          s.sp00   = trickleId;      s.rawId  = pick.id;
          s.destId = pickCPT.destId; s.cpt    = pickCPT.label;
          s.action = 'pending'; save(s);
          console.log('[RSR+][Rodeo] Assigned:', pick.id, '->', s.sp00, '| CPT:', s.cpt);

        } catch (err) {
          console.log('[RSR+][Rodeo] Loop error (recovering):', err.message || err);
          await sleep(3000);
        }
      }
    }
    loop();
  }

  // ==========================================================================
  //  TRICKLE
  // ==========================================================================
  function runTrickle() {
    console.log('[RSR+][Trickle] runTrickle() called');

    function sdMsg()      { var el = document.getElementById('sd_message'); return el ? el.textContent.trim() : ''; }
    function atStart()    { return /scan container to move/i.test(sdMsg()); }
    function atDestStep() { return /scan destination/i.test(sdMsg()); }

    function infodisplayText() {
      var el = document.getElementById('infodisplay');
      return el ? el.textContent.trim() : '';
    }

    function scanInject(value) {
      var el = document.getElementById('sd_input');
      if (el) el.value = value;
      var sd = null;
      try { sd = (typeof unsafeWindow !== 'undefined') ? unsafeWindow.sd : null; } catch (e) {}
      if (sd && typeof sd.receivedScanEvent === 'function') {
        sd.receivedScanEvent(value, '', '');
        return true;
      }
      if (!el) return false;
      el.focus(); el.value = '';
      for (var i = 0; i < value.length; i++) {
        var ch = value[i];
        var o = { key: ch, charCode: ch.charCodeAt(0), keyCode: ch.charCodeAt(0), bubbles: true };
        el.dispatchEvent(new KeyboardEvent('keydown',  o));
        el.dispatchEvent(new KeyboardEvent('keypress', o));
        el.value += ch;
        el.dispatchEvent(new KeyboardEvent('keyup', o));
      }
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keyup',   { key: 'Enter', keyCode: 13, bubbles: true }));
      return true;
    }

    async function tryScanDestId(destId) {
      console.log('[RSR+] Scanning destId:', destId);
      scanInject(destId);
      await waitFor(function() { return !atDestStep(); }, 2500);
      await sleep(150);
      if (atDestStep()) { console.log('[RSR+] destId timed out'); return 'reject'; }
      var info = infodisplayText();
      console.log('[RSR+] infodisplay after dest scan:', info || '(empty)');
      if (/not open|no active|waterspider/i.test(info))                                                return 'closed';
      if (/wrong barcode|scan correct|cannot move|does not have|package not found|invalid/i.test(info)) return 'reject';
      console.log('[RSR+] Move accepted');
      return 'success';
    }

    async function tryDestId(primaryDestId) {
      await sleep(200);
      var result = await tryScanDestId(primaryDestId);
      if (result === 'success') return true;
      if (result === 'closed') {
        console.log('[RSR+] Container not open -- waiting 45s');
        await sleep(45000);
      }
      return false;
    }

    async function submit(s) {
      if (!atStart()) {
        var btn = document.getElementById('start_again');
        if (btn) btn.click();
        var ok = await waitFor(atStart, 3000);
        if (!ok) { console.log('[RSR+] Cannot reach start state. sdMsg:', sdMsg()); return false; }
      }

      console.log('[RSR+] Step 1: scanning SP00:', s.sp00);
      scanInject(s.sp00);

      var resolved = await waitFor(
        function() { return atDestStep() || /wrong barcode|scan correct sc|unrecognized/i.test(infodisplayText()); },
        6000
      );

      if (!resolved) { console.log('[RSR+] Step 1 timeout. sdMsg:', sdMsg()); return 'step1_fail'; }
      if (!atDestStep()) { console.log('[RSR+] Step 1 rejected. infodisplay:', infodisplayText()); return 'step1_fail'; }

      await sleep(600);
      if (!atDestStep()) { console.log('[RSR+] Dest step not stable.'); return 'step1_fail'; }

      var worked = await tryDestId(s.destId);
      if (!worked) console.log('[RSR+] destId failed.');
      return worked;
    }

    async function loop() {
      console.log('[RSR+][Trickle] loop() called');
      await sleep(2000);
      console.log('[RSR+][Trickle] Loop started');

      var idleTicks = 0;
      while (true) {
        try {
          await sleep(TRICKLE_MS);
          var s = load();
          if (s.action !== 'pending') {
            if (++idleTicks % 50 === 0)
              console.log('[RSR+][Trickle] Idle. action:', s.action);
            continue;
          }
          idleTicks = 0;

          var result = await submit(s);

          var s2 = load();
          if (s2.sp00 !== s.sp00) continue;

          if (result === 'step1_fail') {
            s2.action = 'step1_fail'; save(s2);
            await sleep(1000);
          } else if (result === true) {
            s2.action = 'done'; save(s2);
            console.log('[RSR+] SUCCESS:', s.sp00);
          } else {
            s2.action = 'error'; save(s2);
            console.log('[RSR+] FAILED:', s.sp00);
          }

        } catch (err) {
          console.log('[RSR+][Trickle] Loop error (recovering):', err.message || err);
          await sleep(2000);
        }
      }
    }

    loop();
  }

})();
