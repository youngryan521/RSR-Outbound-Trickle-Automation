// ==UserScript==
// @name         RSR+ Outbound Trickle v2
// @namespace    https://github.com/youngryan521
// @version      2.18.1
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

  const KEY             = 'rsr_v2';
  const RODEO_MS        = 2000;
  const MOVE_MS         = 600;
  const FC_UTC_OFFSET_H = -5;        // QIW9 = CDT (UTC-5)
  const COOLDOWN_MS     = 5 * 60000; // 5 min

  const CPTS = [
    { label: '14:30', h: 14, m: 30, destId: '1ccd5e27-2a40-59cf-37e1-3b880c243e57' },
    { label: '22:00', h: 22, m:  0, destId: 'f6cd5e27-2a42-e873-aa17-be5ebb0539d6' },
    { label: '02:00', h:  2, m:  0, destId: 'aacd5e27-2a4c-7d53-fc04-093007fe0f5c' },
  ];

  // -- STATE ------------------------------------------------------------------

  const blank = () => ({
    sp00: null, rawId: null, destId: null, cpt: null, action: 'idle',
    pausedAt: null,
    skipList:          [],
    cooldowns:         {},
    recentlyProcessed: [],
    errorCount:        {},
    ok14: 0, err14: 0, ok22: 0, err22: 0, ok02: 0, err02: 0,
  });

  const load = () => { try { return JSON.parse(GM_getValue(KEY, 'null')) || blank(); } catch { return blank(); } };
  const save = s  => GM_setValue(KEY, JSON.stringify(s));

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
        console.log('[RSR+][Tantei] Fetching CSRF token...');
        const html = await gmFetch('GET', 'https://trans-logistics.amazon.com/sortcenter/tantei?nodeId=QIW9');
        const m = html.match(/name=['"]__token_['"]\s+value=['"]([^'"]+)['"]/);
        if (m) { tanteiToken = m[1]; console.log('[RSR+][Tantei] Token acquired'); }
        else   { console.log('[RSR+][Tantei] __token_ not found'); return null; }
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
        console.log('[RSR+][Tantei] Resolved:', shipmentId, '->', trickleId);
        return trickleId;
      }
      console.log('[RSR+][Tantei] No Trickle ID found for', shipmentId, '| preview:', responseText.slice(0, 300));
      return null;

    } catch (e) {
      console.log('[RSR+][Tantei] Error:', e.message);
      tanteiToken = null;
      return null;
    }
  };

  // -- RODEO PAGE FETCH -------------------------------------------------------

  const fetchItems = async (cpt, skipList, cooldowns) => {
    try {
      const url = cptUrl(cpt);
      console.log('[RSR+][Rodeo] Fetching CPT', cpt.label, ':', url);
      const res = await fetch(url, { credentials: 'include' });
      if (!res.ok) { console.log('[RSR+][Rodeo] HTTP', res.status, 'CPT', cpt.label); return []; }

      const html = await res.text();
      console.log('[RSR+][Rodeo] Preview CPT', cpt.label, ':', html.slice(0, 400).replace(/\s+/g, ' '));
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

      // Single-pass filter + count (avoids iterating out twice)
      let skipped = 0;
      const filtered = out
        .filter(x => {
          const blocked = (skipList || []).includes(x.id) || Date.now() < ((cooldowns || {})[x.id] || 0);
          if (blocked) { skipped++; return false; }
          return true;
        })
        .sort((a, b) => b.dwell - a.dwell);

      console.log('[RSR+][Rodeo] CPT', cpt.label, '-- rows:', out.length, '| skipped:', skipped, '| available:', filtered.length);
      return filtered;
    } catch (e) {
      console.log('[RSR+][Rodeo] fetchItems error CPT', cpt.label, ':', e.message);
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

  if      (location.href.includes('rodeo-iad.amazon.com'))                           runRodeo();
  else if (location.href.includes('sortcenter-menu-na.amazon.com/containerization')) runTrickle();

  // ==========================================================================
  //  RODEO
  // ==========================================================================
  function runRodeo() {
    const okKey  = { '14:30': 'ok14',  '22:00': 'ok22',  '02:00': 'ok02'  };
    const errKey = { '14:30': 'err14', '22:00': 'err22', '02:00': 'err02' };

    const addRecent = (s, id) => { s.recentlyProcessed = [id, ...s.recentlyProcessed].slice(0, 20); };

    async function loop() {
      console.log('[RSR+][Rodeo] Loop started | skipList:', load().skipList.length, '| action:', load().action);
      while (true) {
        try {
          await sleep(RODEO_MS);
          const s = load();
          s.skipList          = s.skipList          || [];
          s.cooldowns         = s.cooldowns         || {};
          s.recentlyProcessed = s.recentlyProcessed || [];
          s.errorCount        = s.errorCount        || {};

          // Handle outcome reported by the Move side
          if (s.action === 'done') {
            s[okKey[s.cpt]]++;
            addRecent(s, s.rawId);
            s.errorCount[s.rawId] = 0;
            s.action = 'idle'; save(s);

          } else if (s.action === 'step1_fail') {
            s[errKey[s.cpt]]++;
            if (s.rawId && !s.skipList.includes(s.rawId)) {
              s.skipList.push(s.rawId);
              console.log('[RSR+][Rodeo] Permanent skip (step1):', s.rawId);
            }
            addRecent(s, s.rawId);
            s.action = 'idle'; save(s);

          } else if (s.action === 'error') {
            s[errKey[s.cpt]]++;
            if (s.rawId) {
              s.errorCount[s.rawId] = (s.errorCount[s.rawId] || 0) + 1;
              if (s.errorCount[s.rawId] >= 3 && !s.skipList.includes(s.rawId)) {
                s.skipList.push(s.rawId);
                console.log('[RSR+][Rodeo] Permanent skip (3 errors):', s.rawId);
              } else {
                s.cooldowns[s.rawId] = Date.now() + COOLDOWN_MS;
                console.log('[RSR+][Rodeo] Cooldown:', s.rawId, '(error #' + s.errorCount[s.rawId] + ')');
              }
            }
            addRecent(s, s.rawId);
            s.action = 'idle'; save(s);
          }

          if (s.action === 'pending') continue;

          // Pick highest-dwell item not recently processed
          let pick = null, pickCPT = null, anyAvailable = false;
          for (const cpt of CPTS) {
            const items = await fetchItems(cpt, s.skipList, s.cooldowns);
            if (items.length) anyAvailable = true;
            const c = items.find(x => !s.recentlyProcessed.includes(x.id));
            if (c) { pick = c; pickCPT = cpt; break; }
          }

          if (!pick) {
            if (anyAvailable) { s.recentlyProcessed = []; save(s); console.log('[RSR+][Rodeo] All recently processed -- resetting'); }
            continue;
          }

          // Resolve Trickle ID:
          //   spP -> toTrickle() -- direct slice formula, confirmed
          //   spR -> ShipmentId (from Rodeo data-url) -> tantei GraphQL -> containerLabel
          let trickleId;
          if (pick.id.startsWith('spR')) {
            const shipId = sp00ToShipmentId[pick.id];
            if (!shipId) {
              console.log('[RSR+][Rodeo] No ShipmentId for spR:', pick.id, '-- 30s retry');
              s.cooldowns[pick.id] = Date.now() + 30000;
              addRecent(s, pick.id); save(s); continue;
            }
            trickleId = await lookupTrickleIdFromTantei(shipId);
            if (!trickleId) {
              console.log('[RSR+][Rodeo] Tantei failed for', pick.id, '-- 5m cooldown');
              s.cooldowns[pick.id] = Date.now() + COOLDOWN_MS;
              addRecent(s, pick.id); save(s); continue;
            }
          } else {
            trickleId = toTrickle(pick.id);
          }

          s.sp00 = trickleId; s.rawId = pick.id;
          s.destId = pickCPT.destId; s.cpt = pickCPT.label;
          s.action = 'pending'; save(s);
          console.log('[RSR+][Rodeo] Assigned:', pick.id, '->', s.sp00, '| CPT:', s.cpt);

        } catch (err) {
          console.log('[RSR+][Rodeo] Loop error:', err.message || err);
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

    const sdMsg      = () => document.getElementById('sd_message')?.textContent.trim() ?? '';
    const atStart    = () => /scan container to move/i.test(sdMsg());
    const atDestStep = () => /scan destination/i.test(sdMsg());
    const infoText   = () => document.getElementById('infodisplay')?.textContent.trim() ?? '';

    const scanInject = value => {
      const el = document.getElementById('sd_input');
      if (el) el.value = value;
      let sd = null;
      try { sd = (typeof unsafeWindow !== 'undefined') ? unsafeWindow.sd : null; } catch {}
      if (sd?.receivedScanEvent) { sd.receivedScanEvent(value, '', ''); return true; }
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
      console.log('[RSR+] Scanning destId:', destId);
      scanInject(destId);
      await waitFor(() => !atDestStep(), 2500);
      await sleep(150);
      if (atDestStep()) { console.log('[RSR+] destId timed out'); return 'reject'; }
      const info = infoText();
      console.log('[RSR+] infodisplay:', info || '(empty)');
      if (/not open|no active|waterspider/i.test(info))                                                return 'closed';
      if (/wrong barcode|scan correct|cannot move|does not have|package not found|invalid/i.test(info)) return 'reject';
      console.log('[RSR+] Move accepted');
      return 'success';
    };

    const tryDestId = async destId => {
      await sleep(200);
      const result = await tryScanDestId(destId);
      if (result === 'success') return true;
      if (result === 'closed') { console.log('[RSR+] Container not open -- 45s wait'); await sleep(45000); }
      return false;
    };

    const submit = async s => {
      if (!atStart()) {
        document.getElementById('start_again')?.click();
        if (!await waitFor(atStart, 3000)) { console.log('[RSR+] Cannot reach start. sdMsg:', sdMsg()); return false; }
      }
      console.log('[RSR+] Step 1:', s.sp00);
      scanInject(s.sp00);
      const resolved = await waitFor(
        () => atDestStep() || /wrong barcode|scan correct sc|unrecognized/i.test(infoText()),
        6000
      );
      if (!resolved)     { console.log('[RSR+] Step 1 timeout'); return 'step1_fail'; }
      if (!atDestStep()) { console.log('[RSR+] Step 1 rejected:', infoText()); return 'step1_fail'; }
      await sleep(600);
      if (!atDestStep()) { console.log('[RSR+] Dest step unstable'); return 'step1_fail'; }
      const worked = await tryDestId(s.destId);
      if (!worked) console.log('[RSR+] destId failed.');
      return worked;
    };

    async function loop() {
      await sleep(2000);
      console.log('[RSR+][Trickle] Loop started');
      let idleTicks = 0;
      while (true) {
        try {
          await sleep(MOVE_MS);
          const s = load();
          if (s.action !== 'pending') {
            if (++idleTicks % 50 === 0) console.log('[RSR+][Trickle] Idle. action:', s.action);
            continue;
          }
          idleTicks = 0;
          const result = await submit(s);
          const s2 = load();
          if (s2.sp00 !== s.sp00) continue;
          if      (result === 'step1_fail') { s2.action = 'step1_fail'; save(s2); await sleep(1000); }
          else if (result === true)         { s2.action = 'done';       save(s2); console.log('[RSR+] SUCCESS:', s.sp00); }
          else                              { s2.action = 'error';      save(s2); console.log('[RSR+] FAILED:',  s.sp00); }
        } catch (err) {
          console.log('[RSR+][Trickle] Loop error:', err.message || err);
          await sleep(2000);
        }
      }
    }
    loop();
  }

})();
