// ==UserScript==
// @name         RSR+ Outbound Dropzone v2
// @namespace    https://github.com/youngryan521
// @version      1.0.1
// @description  Incremental SP00 relay -- Rodeo ManifestPending -> Sort Center Move (Dropzone), priority by CPT
// @author       youryanh
// @match        https://rodeo-iad.amazon.com/*
// @match        https://sortcenter-menu-na.amazon.com/containermovement/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        unsafeWindow
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/youngryan521/Projects/main/rsr-dropzone-v2.user.js
// @downloadURL  https://raw.githubusercontent.com/youngryan521/Projects/main/rsr-dropzone-v2.user.js
// ==/UserScript==

(function () {
  'use strict';

  const KEY         = 'rsr_dropzone_v2';
  const RODEO_MS    = 2000;
  const TRICKLE_MS  = 600;
  const FC_UTC_OFFSET_H = -5;   // QIW9 = CDT (UTC-5)
  const COOLDOWN_MS = 5 * 60000; // 5 min cooldown after container-closed / reject

  const CPTS = [
    { label: '14:30', h: 14, m: 30, destId: '4ccd5e2a-9e00-3f03-1880-768b589f8210' },
    { label: '22:00', h: 22, m:  0, destId: '4ccd5e2a-9e00-3f03-1880-768b589f8210' },
    { label: '02:00', h:  2, m:  0, destId: '4ccd5e2a-9e00-3f03-1880-768b589f8210' },
  ];

  // -- STATE ------------------------------------------------------------------

  function blank() {
    return {
      sp00: null, rawId: null, destId: null, cpt: null, action: 'idle',
      pausedAt: null,
      skipList:          [],  // permanent: step-1 rejections
      cooldowns:         {},  // rawId -> expiry ms (container closed / all destIds failed)
      recentlyProcessed: [],  // last 20 processed IDs -- prevents 2-item oscillation
      errorCount:        {},  // rawId -> consecutive error count (3-strike permanent skip)
      ok14: 0, err14: 0, ok22: 0, err22: 0, ok02: 0, err02: 0,
    };
  }
  function load()  { try { return JSON.parse(GM_getValue(KEY, 'null')) || blank(); } catch { return blank(); } }
  function save(s) { GM_setValue(KEY, JSON.stringify(s)); }

  // -- SP00 / CPT UTILS -------------------------------------------------------

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
    // If the calculated CPT time is already in the past, shift to next occurrence (+1 day).
    // Simple past-check replaces the old heuristic (h<6 && nowCDT>=12) which broke
    // after UTC midnight -- utcMid already rolled over, so the heuristic added an
    // extra day and the window landed one day too far in the future.
    return ms <= now.getTime() ? ms + 86400000 : ms;
  }

  function cptUrl(cpt) {
    const ms = cptMs(cpt);
    return 'https://rodeo-iad.amazon.com/QIW9/ItemList?WorkPool=ManifestPending' +
           `&ExSDRange.RangeEndMillis=${ms+60000}&Fracs=NON_FRACS` +
           '&ProcessPath=PPSingle%2cPPMultiBldgWide' +
           `&ExSDRange.RangeStartMillis=${ms-1}&shipmentType=CUSTOMER_SHIPMENTS`;
  }

  async function fetchItems(cpt, skipList, cooldowns) {
    try {
      const url = cptUrl(cpt);
      console.log('[DZ+][Rodeo] Fetching CPT', cpt.label, ':', url);
      const res = await fetch(url, { credentials: 'include' });
      if (!res.ok) {
        console.log('[DZ+][Rodeo] fetchItems HTTP', res.status, 'for CPT', cpt.label);
        return [];
      }
      const html = await res.text();
      // Log first 400 chars -- lets us see if it's a login page, empty table, or real data
      console.log('[DZ+][Rodeo] Response preview CPT', cpt.label, ':', html.slice(0, 400).replace(/\s+/g, ' '));
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const out = [];
      doc.querySelectorAll('tr, [role="row"]').forEach(row => {
        const txt = row.textContent;
        const sp  = txt.match(/\bsp[A-Z][A-Za-z0-9]{6,18}\b/);
        if (sp) out.push({ id: sp[0], dwell: dwellMins(txt) });
      });
      const skipped = out.filter(x =>
        (skipList || []).includes(x.id) || Date.now() < ((cooldowns || {})[x.id] || 0)
      ).length;
      const filtered = out.filter(x => {
        if ((skipList  || []).includes(x.id))             return false;
        if (Date.now() < ((cooldowns || {})[x.id] || 0)) return false;
        return true;
      }).sort((a, b) => b.dwell - a.dwell);
      console.log('[DZ+][Rodeo] CPT', cpt.label, '-- rows found:', out.length, '| skipped/cooldown:', skipped, '| available:', filtered.length);
      return filtered;
    } catch (e) {
      console.log('[DZ+][Rodeo] fetchItems error for CPT', cpt.label, ':', e.message);
      return [];
    }
  }

  // -- SHARED UTILS -----------------------------------------------------------

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  function waitFor(pred, ms = 5000) {
    return new Promise(resolve => {
      if (pred()) return resolve(true);
      const ob = new MutationObserver(() => { if (pred()) { ob.disconnect(); clearTimeout(t); resolve(true); } });
      ob.observe(document.body, { childList: true, subtree: true, characterData: true });
      const t = setTimeout(() => { ob.disconnect(); resolve(false); }, ms);
    });
  }

  // -- ENTRY ------------------------------------------------------------------

  if      (location.href.includes('rodeo-iad.amazon.com'))                           runRodeo();
  else if (location.href.includes('sortcenter-menu-na.amazon.com/containermovement')) runTrickle();

  // ==========================================================================
  //  RODEO
  // ==========================================================================
  function runRodeo() {
    const okKey  = { '14:30':'ok14', '22:00':'ok22', '02:00':'ok02'  };
    const errKey = { '14:30':'err14','22:00':'err22','02:00':'err02' };

    async function loop() {
      const s0 = load();
      console.log('[DZ+][Rodeo] Loop started | skipList:', s0.skipList.length, '| cooldowns:', Object.keys(s0.cooldowns||{}).length, '| action:', s0.action);
      while (true) {
        try {
          await sleep(RODEO_MS);
          let s = load();
          s.skipList          = s.skipList          || [];
          s.cooldowns         = s.cooldowns         || {};
          s.recentlyProcessed = s.recentlyProcessed || [];
          s.errorCount        = s.errorCount        || {};

          // Handle outcome from Trickle
          if (s.action === 'done') {
            s[okKey[s.cpt]]++;
            s.recentlyProcessed = [s.rawId, ...s.recentlyProcessed].slice(0, 20);
            s.errorCount[s.rawId] = 0; // reset strike count on success
            s.action = 'idle'; save(s);

          } else if (s.action === 'step1_fail') {
            s[errKey[s.cpt]]++;
            if (s.rawId && !s.skipList.includes(s.rawId)) {
              s.skipList.push(s.rawId);
              console.log('[DZ+][Rodeo] Permanent skip (step1):', s.rawId);
            }
            s.recentlyProcessed = [s.rawId, ...s.recentlyProcessed].slice(0, 20);
            s.action = 'idle'; save(s);

          } else if (s.action === 'error') {
            s[errKey[s.cpt]]++;
            if (s.rawId) {
              s.errorCount[s.rawId] = (s.errorCount[s.rawId] || 0) + 1;
              if (s.errorCount[s.rawId] >= 3 && !s.skipList.includes(s.rawId)) {
                s.skipList.push(s.rawId);
                console.log('[DZ+][Rodeo] Permanent skip after 3 errors:', s.rawId);
              } else {
                s.cooldowns[s.rawId] = Date.now() + COOLDOWN_MS;
                console.log('[DZ+][Rodeo] Cooldown for', s.rawId, '(error #' + s.errorCount[s.rawId] + ')');
              }
            }
            s.recentlyProcessed = [s.rawId, ...s.recentlyProcessed].slice(0, 20);
            s.action = 'idle'; save(s);
          }

          if (s.action === 'pending') continue;

          // Pick highest-dwell item not recently processed
          let pick = null, pickCPT = null, anyAvailable = false;
          for (const cpt of CPTS) {
            const items = await fetchItems(cpt, s.skipList, s.cooldowns);
            if (items.length > 0) anyAvailable = true;
            const c = items.find(x => !s.recentlyProcessed.includes(x.id));
            if (c) { pick = c; pickCPT = cpt; break; }
          }

          if (!pick) {
            if (anyAvailable) {
              console.log('[DZ+][Rodeo] All items recently processed -- resetting cycle');
              s.recentlyProcessed = [];
              save(s);
            }
            continue;
          }

          s.sp00   = toTrickle(pick.id); s.rawId  = pick.id;
          s.destId = pickCPT.destId;     s.cpt    = pickCPT.label;
          s.action = 'pending'; save(s);
          console.log('[DZ+][Rodeo] Assigned:', pick.id, '->', s.sp00, '| CPT:', s.cpt);

        } catch (err) {
          console.log('[DZ+][Rodeo] Loop error (recovering):', err.message || err);
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
    console.log('[DZ+][Move] runMove() called');

    // -- Page state -----------------------------------------------------------
    function sdMsg()      { const el = document.getElementById('sd_message'); return el ? el.textContent.trim() : ''; }
    function atStart()    { return /scan container to move/i.test(sdMsg()); }
    function atDestStep() { return /scan destination/i.test(sdMsg()); }

    function infodisplayText() {
      const el = document.getElementById('infodisplay');
      return el ? el.textContent.trim() : '';
    }

    // -- Scanner injection ----------------------------------------------------
    function scanInject(value) {
      const el = document.getElementById('sd_input');
      if (el) el.value = value;
      // Guard: unsafeWindow injection can silently fail on some page loads
      let sd = null;
      try { sd = (typeof unsafeWindow !== 'undefined') ? unsafeWindow.sd : null; } catch (e) {}
      if (sd && typeof sd.receivedScanEvent === 'function') {
        sd.receivedScanEvent(value, '', '');
        return true;
      }
      // Fallback: keyboard event injection
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
    }

    // -- Dest scan (v2.13.0 model: !atDestStep() = success) -------------------
    async function tryScanDestId(destId) {
      console.log('[DZ+] Scanning destId:', destId);
      console.log('[DZ+] sdMsg before dest scan:', sdMsg());
      scanInject(destId);

      // Wait for page to leave dest step (success or BEEP rejection)
      await waitFor(() => !atDestStep(), 2500);
      await sleep(150); // brief settle

      if (atDestStep()) {
        // Still at dest step -- scan timed out / not recognized
        console.log('[DZ+] destId timed out (still at dest step)');
        return 'reject';
      }

      // Page left dest step -- check infodisplay for explicit error text
      const info = infodisplayText();
      console.log('[DZ+] infodisplay after dest scan:', info || '(empty)');

      if (/not open|no active|waterspider/i.test(info))                                            return 'closed';
      if (/wrong barcode|scan correct|cannot move|does not have|package not found|invalid/i.test(info)) return 'reject';

      // Page moved on with no error text = success
      console.log('[DZ+] Move accepted');
      return 'success';
    }

    async function tryDestId(primaryDestId) {
      await sleep(200);
      const result = await tryScanDestId(primaryDestId);
      if (result === 'success') return true;
      if (result === 'closed') {
        console.log('[DZ+] Container not open -- waiting 45s before failing back to Rodeo');
        await sleep(45000);
      }
      return false;
    }

    // -- Submit ---------------------------------------------------------------
    async function submit(s) {
      // Always return to start state first (stale dest-step guard)
      if (!atStart()) {
        const btn = document.getElementById('start_again');
        if (btn) btn.click();
        const ok = await waitFor(atStart, 3000);
        if (!ok) {
          console.log('[DZ+] Cannot reach start state. sdMsg:', sdMsg());
          return false;
        }
      }

      // Step 1: scan SP00
      console.log('[DZ+] Step 1: scanning SP00:', s.sp00);
      scanInject(s.sp00);

      const resolved = await waitFor(
        () => atDestStep() || /wrong barcode|scan correct sc|unrecognized/i.test(infodisplayText()),
        6000
      );

      if (!resolved) {
        console.log('[DZ+] Step 1 timeout. sdMsg:', sdMsg());
        return 'step1_fail';
      }
      if (!atDestStep()) {
        console.log('[DZ+] Step 1 rejected. infodisplay:', infodisplayText());
        return 'step1_fail';
      }

      // 600ms stabilization -- ensure scanner is fully in dest-step mode before injecting destId
      await sleep(600);
      if (!atDestStep()) {
        console.log('[DZ+] Dest step not stable after SP00 accept. sdMsg:', sdMsg());
        return 'step1_fail';
      }

      // Step 2: scan destId
      const worked = await tryDestId(s.destId);
      if (!worked) console.log('[DZ+] destId failed.');
      return worked;
    }

    // -- Process loop ---------------------------------------------------------
    async function loop() {
      console.log('[DZ+][Move] loop() called');
      await sleep(2000);
      console.log('[DZ+][Move] Loop started');

      let idleTicks = 0;
      while (true) {
        try {
          await sleep(TRICKLE_MS);
          const s = load();
          if (s.action !== 'pending') {
            if (++idleTicks % 50 === 0)
              console.log('[DZ+][Move] Idle -- waiting for Rodeo. action:', s.action);
            continue;
          }
          idleTicks = 0;

          const result = await submit(s);

          const s2 = load();
          if (s2.sp00 !== s.sp00) continue; // Rodeo moved on while we were working

          if (result === 'step1_fail') {
            s2.action = 'step1_fail'; save(s2);
            await sleep(1000);
          } else if (result === true) {
            s2.action = 'done'; save(s2);
            console.log('[DZ+] SUCCESS:', s.sp00);
          } else {
            s2.action = 'error'; save(s2);
            console.log('[DZ+] FAILED:', s.sp00);
          }

        } catch (err) {
          console.log('[DZ+][Move] Loop error (recovering):', err.message || err);
          await sleep(2000);
        }
      }
    }

    loop();
  }

})();
