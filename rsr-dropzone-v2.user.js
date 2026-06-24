// ==UserScript==
// @name         RSR+ Outbound Dropzone v2
// @namespace    https://github.com/youngryan521
// @version      1.2.0
// @description  Incremental SP00 relay -- Rodeo ManifestPending -> Sort Center Move (Dropzone), priority by CPT
// @author       youryanh
// @match        https://rodeo-iad.amazon.com/*
// @match        https://sortcenter-menu-na.amazon.com/containermovement/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      trans-logistics.amazon.com
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/youngryan521/RSR-Outbound-Trickle-Automation/RSR-DROPZONE-AUTOMATION/rsr-dropzone-v2.user.js
// @downloadURL  https://raw.githubusercontent.com/youngryan521/RSR-Outbound-Trickle-Automation/RSR-DROPZONE-AUTOMATION/rsr-dropzone-v2.user.js
// ==/UserScript==

(function () {
  'use strict';

  const KEY             = 'rsr_dropzone_v2';
  const RODEO_MS        = 2000;
  const MOVE_MS         = 600;
  const FC_UTC_OFFSET_H = -5;          // QIW9 = CDT (UTC-5)
  const COOLDOWN_MS     = 5 * 60000;   // 5 min per-item retry delay
  const SHIFT_GAP_MS    = 8 * 3600000; // 8h idle = new shift, clears skipList
  const SKIP_CAP        = 100;          // max skipList entries (FIFO)

  const CPTS = [
    { label: '14:30', h: 14, m: 30, destId: '4ccd5e2a-9e00-3f03-1880-768b589f8210' },
    { label: '22:00', h: 22, m:  0, destId: '4ccd5e2a-9e00-3f03-1880-768b589f8210' },
    { label: '02:00', h:  2, m:  0, destId: '4ccd5e2a-9e00-3f03-1880-768b589f8210' },
  ];

  // -- STATE ------------------------------------------------------------------
  // Only cross-tab coordination fields and persistent counters live in GM storage.
  // Ephemeral session data (cooldowns, errorCount, recentlyProcessed) live in
  // module-scope variables -- they reset naturally on page reload, never accumulate.

  const blank = () => ({
    sp00: null, rawId: null, destId: null, cpt: null, action: 'idle',
    pausedAt: null,
    skipList:     [],   // persisted -- hard-fail items; FIFO-capped at SKIP_CAP
    lastActiveMs: 0,    // persisted -- drives shift-start detection
    ok14: 0, err14: 0, ok22: 0, err22: 0, ok02: 0, err02: 0,
  });

  const load = () => { try { return JSON.parse(GM_getValue(KEY, 'null')) || blank(); } catch { return blank(); } };
  // Stamp lastActiveMs on every save so shift-start detection always has a fresh anchor
  const save = s => { s.lastActiveMs = Date.now(); GM_setValue(KEY, JSON.stringify(s)); };

  // -- SP00 / CPT UTILS -------------------------------------------------------

  // spP only -- direct character conversion (confirmed working)
  const toTrickle = id => `SP${id.slice(3)}_001_v`;

  const dwellMins = text => {
    let m = 0;
    const d  = text.match(/(\d+)\s*d/i);      if (d)  m += +d[1]  * 1440;
    const h  = text.match(/(\d+)\s*h/i);      if (h)  m += +h[1]  * 60;
    const mn = text.match(/(\d+)\s*m(?!s)/i); if (mn) m += +mn[1];
    if (!m) { const hms = text.match(/\b(\d{1,3}):(\d{2})(?::\d{2})?\b/); if (hms) m = +hms[1]*60 + +hms[2]; }
    return m;
  };

  const cptMs = cpt => {
    const now    = new Date();
    const utcMid = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    let utcH = cpt.h - FC_UTC_OFFSET_H, dayOff = 0;
    if (utcH >= 24) { utcH -= 24; dayOff = 1; }
    const ms = utcMid + dayOff * 86400000 + utcH * 3600000 + cpt.m * 60000;
    return ms <= now.getTime() ? ms + 86400000 : ms;
  };

  const cptUrl = cpt => {
    const ms = cptMs(cpt);
    return `https://rodeo-iad.amazon.com/QIW9/ItemList?WorkPool=ManifestPending` +
           `&ExSDRange.RangeEndMillis=${ms+60000}&Fracs=NON_FRACS` +
           `&ProcessPath=PPSingle%2cPPMultiBldgWide` +
           `&ExSDRange.RangeStartMillis=${ms-1}&shipmentType=CUSTOMER_SHIPMENTS`;
  };

  // -- TANTEI LOOKUP (spR orders) -----------------------------------------------
  // spR (PPMultiBldgWide) SP00s have no deterministic conversion formula.
  // Lookup flow:
  //   1. ShipmentId extracted from Rodeo data-url (referenceId param) during fetchItems()
  //   2. Tantei GraphQL queried with SHIPMENT_ID
  //   3. Response walked for any string matching /^SP[A-Za-z0-9]{7}T_001_v$/

  const sp00ToShipmentId = {}; // populated by fetchItems() from data-url attrs
  let   tanteiToken      = null;
  const trickleIdCache   = {}; // shipmentId -> trickleId, permanent per session

  // Promise wrapper around GM_xmlhttpRequest for authenticated cross-origin requests
  const gmFetch = (method, url, headers = {}, body = null) =>
    new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method, url, headers, data: body,
        withCredentials: true,
        onload:    r  => resolve(r.responseText),
        onerror:   () => reject(new Error(`gmFetch failed: ${url}`)),
        ontimeout: () => reject(new Error(`gmFetch timeout: ${url}`)),
      });
    });

  // Recursively search parsed JSON for a Trickle-format barcode
  const findTrickleId = obj => {
    if (!obj || typeof obj !== 'object') return null;
    for (const v of Object.values(obj)) {
      if (typeof v === 'string' && /^SP[A-Za-z0-9]{7}T_001_v$/.test(v)) return v;
      const f = findTrickleId(v);
      if (f) return f;
    }
    return null;
  };

  const lookupTrickleIdFromTantei = async shipmentId => {
    if (trickleIdCache[shipmentId]) return trickleIdCache[shipmentId];
    try {
      if (!tanteiToken) {
        console.log('[DZ+][Tantei] Fetching CSRF token...');
        const html = await gmFetch('GET', 'https://trans-logistics.amazon.com/sortcenter/tantei?nodeId=QIW9');
        const m = html.match(/name=['"]__token_['"]\s+value=['"]([^'"]+)['"]/);
        if (m) { tanteiToken = m[1]; console.log('[DZ+][Tantei] Token acquired'); }
        else   { console.log('[DZ+][Tantei] __token_ not found'); return null; }
      }

      const query = `
        query ($queryInput: [SearchTermInput!]!, $startIndex: String) {
          searchEntities(searchTerms: $queryInput) {
            searchTerm { nodeId searchId searchIdType resolvedIdType }
            contents(pageSize: 60, startIndex: $startIndex, forwardNavigate: true) {
              contents { containerId containerLabel containerType }
              endToken
            }
          }
        }`;

      const variables = {
        queryInput: [{ nodeId: 'QIW9', nodeTimezone: 'America/Chicago', searchId: shipmentId, searchIdType: 'SHIPMENT_ID' }],
      };

      const responseText = await gmFetch(
        'POST',
        'https://trans-logistics.amazon.com/sortcenter/tantei/graphql',
        { 'Content-Type': 'application/json', 'anti-csrftoken-a2z': tanteiToken },
        JSON.stringify({ query, variables })
      );

      const trickleId = findTrickleId(JSON.parse(responseText));
      if (trickleId) {
        trickleIdCache[shipmentId] = trickleId;
        console.log('[DZ+][Tantei] Resolved:', shipmentId, '->', trickleId);
        return trickleId;
      }
      console.log('[DZ+][Tantei] No Trickle ID found for', shipmentId, '| preview:', responseText.slice(0, 300));
      return null;

    } catch (e) {
      console.log('[DZ+][Tantei] Error:', e.message);
      tanteiToken = null;
      return null;
    }
  };

  // -- RODEO PAGE FETCH -------------------------------------------------------

  const fetchItems = async (cpt, skipList, cooldowns) => {
    try {
      const url = cptUrl(cpt);
      console.log('[DZ+][Rodeo] Fetching CPT', cpt.label, ':', url);
      const res = await fetch(url, { credentials: 'include' });
      if (!res.ok) { console.log('[DZ+][Rodeo] HTTP', res.status, 'CPT', cpt.label); return []; }

      const html = await res.text();
      console.log('[DZ+][Rodeo] Preview CPT', cpt.label, ':', html.slice(0, 400).replace(/\s+/g, ' '));
      const doc  = new DOMParser().parseFromString(html, 'text/html');

      // Build sp00 -> ShipmentId map from data-url attributes (used for spR tantei lookup).
      // data-url="/QIW9/ShipmentItem/mark?...&referenceId=458...&scannableId=spR...&..."
      doc.querySelectorAll('[data-url]').forEach(el => {
        const u   = el.getAttribute('data-url') || '';
        const sp  = u.match(/[?&]scannableId=([^&]+)/);
        const ref = u.match(/[?&]referenceId=(\d{10,})/);
        if (sp && ref) sp00ToShipmentId[sp[1]] = ref[1];
      });

      const out = [];
      doc.querySelectorAll('tr, [role="row"]').forEach(row => {
        const sp = row.textContent.match(/\bsp[A-Z][A-Za-z0-9]{6,18}\b/);
        if (sp) out.push({ id: sp[0], dwell: dwellMins(row.textContent) });
      });

      // Single-pass filter + count
      let skipped = 0;
      const filtered = out
        .filter(x => {
          const blocked = (skipList || []).includes(x.id) || Date.now() < ((cooldowns || {})[x.id] || 0);
          if (blocked) { skipped++; return false; }
          return true;
        })
        .sort((a, b) => b.dwell - a.dwell);

      console.log('[DZ+][Rodeo] CPT', cpt.label, '-- rows:', out.length, '| skipped:', skipped, '| available:', filtered.length);
      return filtered;
    } catch (e) {
      console.log('[DZ+][Rodeo] fetchItems error CPT', cpt.label, ':', e.message);
      return [];
    }
  };

  // -- SHARED UTILS -----------------------------------------------------------

  const sleep   = ms => new Promise(r => setTimeout(r, ms));

  const waitFor = (pred, ms = 5000) => new Promise(resolve => {
    if (pred()) return resolve(true);
    const ob = new MutationObserver(() => { if (pred()) { ob.disconnect(); clearTimeout(t); resolve(true); } });
    ob.observe(document.body, { childList: true, subtree: true, characterData: true });
    const t = setTimeout(() => { ob.disconnect(); resolve(false); }, ms);
  });

  // -- ENTRY ------------------------------------------------------------------

  if      (location.href.includes('rodeo-iad.amazon.com'))                            runRodeo();
  else if (location.href.includes('sortcenter-menu-na.amazon.com/containermovement')) runMove();

  // ==========================================================================
  //  RODEO
  // ==========================================================================
  function runRodeo() {
    const okKey  = { '14:30': 'ok14',  '22:00': 'ok22',  '02:00': 'ok02'  };
    const errKey = { '14:30': 'err14', '22:00': 'err22', '02:00': 'err02' };

    // Ephemeral session state -- lives in memory only, resets naturally on page reload.
    // Never written to GM storage, so they cannot accumulate across shifts.
    let cooldowns         = {};
    let errorCount        = {};
    let recentlyProcessed = [];

    const addRecent = id => { recentlyProcessed = [id, ...recentlyProcessed].slice(0, 20); };

    // Push to skipList with FIFO cap -- drops oldest entry when cap exceeded
    const addToSkipList = (s, id, reason) => {
      if (!id || s.skipList.includes(id)) return;
      s.skipList.push(id);
      if (s.skipList.length > SKIP_CAP) s.skipList = s.skipList.slice(-SKIP_CAP);
      console.log('[DZ+][Rodeo] Permanent skip (' + reason + '):', id);
    };

    // Shift-start check: runs once on page load.
    // If Rodeo has been idle for 8+ hours, wipe stale skipList entries from last shift.
    (function shiftStartCheck() {
      const s0 = load();
      const elapsed = Date.now() - (s0.lastActiveMs || 0);
      if (elapsed > SHIFT_GAP_MS) {
        const prev = (s0.skipList || []).length;
        console.log('[DZ+][Rodeo] New shift detected (' + Math.round(elapsed / 3600000) + 'h idle) -- clearing skipList (' + prev + ' entries)');
        s0.skipList = [];
      }
      save(s0); // stamps lastActiveMs for this session
    })();

    async function loop() {
      console.log('[DZ+][Rodeo] Loop started | skipList:', load().skipList.length, '| action:', load().action);
      while (true) {
        try {
          await sleep(RODEO_MS);
          const s = load();
          s.skipList = s.skipList || [];

          // Handle outcome reported by the Move side
          if (s.action === 'done') {
            s[okKey[s.cpt]]++;
            addRecent(s.rawId);
            errorCount[s.rawId] = 0; // reset in-memory strike count on success
            s.action = 'idle'; save(s);

          } else if (s.action === 'step1_fail') {
            s[errKey[s.cpt]]++;
            addToSkipList(s, s.rawId, 'step1');
            addRecent(s.rawId);
            s.action = 'idle'; save(s);

          } else if (s.action === 'error') {
            s[errKey[s.cpt]]++;
            if (s.rawId) {
              errorCount[s.rawId] = (errorCount[s.rawId] || 0) + 1;
              if (errorCount[s.rawId] >= 3) {
                addToSkipList(s, s.rawId, '3 errors');
              } else {
                cooldowns[s.rawId] = Date.now() + COOLDOWN_MS;
                console.log('[DZ+][Rodeo] Cooldown:', s.rawId, '(error #' + errorCount[s.rawId] + ')');
              }
            }
            addRecent(s.rawId);
            s.action = 'idle'; save(s);
          }

          if (s.action === 'pending') continue;

          // Pick highest-dwell item not recently processed
          let pick = null, pickCPT = null, anyAvailable = false;
          for (const cpt of CPTS) {
            const items = await fetchItems(cpt, s.skipList, cooldowns);
            if (items.length) anyAvailable = true;
            const c = items.find(x => !recentlyProcessed.includes(x.id));
            if (c) { pick = c; pickCPT = cpt; break; }
          }

          if (!pick) {
            if (anyAvailable) {
              recentlyProcessed = []; // module-scope reset -- no GM write needed
              console.log('[DZ+][Rodeo] All recently processed -- resetting');
            }
            continue;
          }

          // Resolve Trickle ID:
          //   spP -> toTrickle() -- direct slice formula, confirmed
          //   spR -> ShipmentId (from Rodeo data-url) -> tantei GraphQL -> containerLabel
          let trickleId;
          if (pick.id.startsWith('spR')) {
            const shipId = sp00ToShipmentId[pick.id];
            if (!shipId) {
              console.log('[DZ+][Rodeo] No ShipmentId for spR:', pick.id, '-- 30s retry');
              cooldowns[pick.id] = Date.now() + 30000; // module-scope, no GM write
              addRecent(pick.id); continue;
            }
            trickleId = await lookupTrickleIdFromTantei(shipId);
            if (!trickleId) {
              console.log('[DZ+][Rodeo] Tantei failed for', pick.id, '-- 5m cooldown');
              cooldowns[pick.id] = Date.now() + COOLDOWN_MS; // module-scope, no GM write
              addRecent(pick.id); continue;
            }
          } else {
            trickleId = toTrickle(pick.id);
          }

          s.sp00 = trickleId; s.rawId = pick.id;
          s.destId = pickCPT.destId; s.cpt = pickCPT.label;
          s.action = 'pending'; save(s);
          console.log('[DZ+][Rodeo] Assigned:', pick.id, '->', s.sp00, '| CPT:', s.cpt);

        } catch (err) {
          console.log('[DZ+][Rodeo] Loop error:', err.message || err);
          await sleep(3000);
        }
      }
    }
    loop();
  }

  // ==========================================================================
  //  MOVE (Dropzone)
  // ==========================================================================
  function runMove() {
    console.log('[DZ+][Move] runMove() called');

    const sdMsg      = () => document.getElementById('sd_message')?.textContent.trim() ?? '';
    const atStart    = () => /scan container to move/i.test(sdMsg());
    const atDestStep = () => /scan destination/i.test(sdMsg());
    const infoText   = () => document.getElementById('infodisplay')?.textContent.trim() ?? '';

    // -- COUNTER BANNER -------------------------------------------------------
    const banner = document.createElement('div');
    Object.assign(banner.style, {
      position: 'fixed', bottom: '12px', left: '50%', transform: 'translateX(-50%)',
      background: '#1a1a2e', padding: '7px 22px', borderRadius: '20px',
      fontSize: '13px', fontFamily: 'Courier New, monospace', fontWeight: 'bold',
      zIndex: '99997', display: 'flex', gap: '22px', alignItems: 'center',
      boxShadow: '0 2px 10px rgba(0,0,0,0.55)', border: '1px solid #333',
      whiteSpace: 'nowrap', pointerEvents: 'none',
    });
    document.body.appendChild(banner);

    const CPT_COLORS = { '14:30': '#4caf50', '22:00': '#42a5f5', '02:00': '#ffa726' };

    const updateBanner = s => {
      const counts = { '14:30': s.ok14 || 0, '22:00': s.ok22 || 0, '02:00': s.ok02 || 0 };
      banner.innerHTML = Object.entries(counts).map(([label, n], i) =>
        (i ? '<span style="color:#444;margin:0 2px">|</span>' : '') +
        `<span style="color:#888">${label}:</span>&nbsp;` +
        `<span style="color:${CPT_COLORS[label]};font-size:15px">${n}</span>`
      ).join('');
    };
    updateBanner(load()); // show counts immediately on page load

    // Resolves immediately if the tab is visible; waits for focus if hidden
    const waitVisible = () => new Promise(resolve => {
      if (!document.hidden) { resolve(); return; }
      const h = () => { if (!document.hidden) { document.removeEventListener('visibilitychange', h); resolve(); } };
      document.addEventListener('visibilitychange', h);
    });

    // Like sleep(), but wakes early when the tab becomes visible (avoids background-throttle lag)
    const sleepOrVisible = ms => new Promise(resolve => {
      const t = setTimeout(resolve, ms);
      if (!document.hidden) return;
      const h = () => { if (!document.hidden) { clearTimeout(t); document.removeEventListener('visibilitychange', h); resolve(); } };
      document.addEventListener('visibilitychange', h);
    });

    const scanInject = async value => {
      const el = document.getElementById('sd_input');
      if (el) el.value = value;
      let sd = null;
      try { sd = (typeof unsafeWindow !== 'undefined') ? unsafeWindow.sd : null; } catch {}
      // Primary path: direct JS call -- works in background tabs without any special handling
      if (sd?.receivedScanEvent) { sd.receivedScanEvent(value, '', ''); return true; }
      // Keyboard fallback requires tab focus -- pause here if the tab is currently hidden
      if (document.hidden) {
        console.log('[DZ+] Tab hidden -- waiting for visibility to inject scan');
        await waitVisible();
        await sleep(150); // brief settle after tab regains focus
      }
      if (!el) return false;
      el.focus(); el.value = '';
      for (const ch of value) {
        const o = { key: ch, charCode: ch.charCodeAt(0), keyCode: ch.charCodeAt(0), bubbles: true };
        el.dispatchEvent(new KeyboardEvent('keydown',  o));
        el.dispatchEvent(new KeyboardEvent('keypress', o));
        el.value += ch;
        el.dispatchEvent(new KeyboardEvent('keyup', o));
      }
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keyup',   { key: 'Enter', keyCode: 13, bubbles: true }));
      return true;
    };

    const tryScanDestId = async destId => {
      console.log('[DZ+] Scanning destId:', destId);
      await scanInject(destId);
      await waitFor(() => !atDestStep(), 2500);
      await sleep(150);
      if (atDestStep()) { console.log('[DZ+] destId timed out'); return 'reject'; }
      const info = infoText();
      console.log('[DZ+] infodisplay:', info || '(empty)');
      if (/not open|no active|waterspider/i.test(info))                                                return 'closed';
      if (/wrong barcode|scan correct|cannot move|does not have|package not found|invalid/i.test(info)) return 'reject';
      console.log('[DZ+] Move accepted');
      return 'success';
    };

    const tryDestId = async destId => {
      await sleep(200);
      const result = await tryScanDestId(destId);
      if (result === 'success') return true;
      if (result === 'closed') { console.log('[DZ+] Container not open -- 45s wait'); await sleep(45000); }
      return false;
    };

    const submit = async s => {
      if (!atStart()) {
        document.getElementById('start_again')?.click();
        if (!await waitFor(atStart, 3000)) { console.log('[DZ+] Cannot reach start. sdMsg:', sdMsg()); return false; }
      }
      console.log('[DZ+] Step 1:', s.sp00);
      await scanInject(s.sp00);
      const resolved = await waitFor(
        () => atDestStep() || /wrong barcode|scan correct sc|unrecognized/i.test(infoText()),
        6000
      );
      if (!resolved)     { console.log('[DZ+] Step 1 timeout'); return 'step1_fail'; }
      if (!atDestStep()) { console.log('[DZ+] Step 1 rejected:', infoText()); return 'step1_fail'; }
      await sleep(600);
      if (!atDestStep()) { console.log('[DZ+] Dest step unstable'); return 'step1_fail'; }
      const worked = await tryDestId(s.destId);
      if (!worked) console.log('[DZ+] destId failed.');
      return worked;
    };

    async function loop() {
      await sleep(2000);
      console.log('[DZ+][Move] Loop started');
      let idleTicks = 0;
      while (true) {
        try {
          await sleepOrVisible(MOVE_MS);
          const s = load();
          updateBanner(s);
          if (s.action !== 'pending') {
            if (++idleTicks % 50 === 0) console.log('[DZ+][Move] Idle. action:', s.action);
            continue;
          }
          idleTicks = 0;
          const result = await submit(s);
          const s2 = load();
          if (s2.sp00 !== s.sp00) continue;
          if      (result === 'step1_fail') { s2.action = 'step1_fail'; save(s2); await sleep(1000); }
          else if (result === true)         { s2.action = 'done';       save(s2); console.log('[DZ+] SUCCESS:', s.sp00); }
          else                              { s2.action = 'error';      save(s2); console.log('[DZ+] FAILED:',  s.sp00); }
        } catch (err) {
          console.log('[DZ+][Move] Loop error:', err.message || err);
          await sleep(2000);
        }
      }
    }
    loop();
  }

})();
