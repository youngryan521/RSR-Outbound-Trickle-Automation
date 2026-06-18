// ==UserScript==
// @name         RSR+ Outbound Trickle v2
// @namespace    https://github.com/youngryan521
// @version      2.13.0
// @description  Incremental SP00 relay -- Rodeo ManifestPending -> Sort Center Trickle, priority by CPT
// @author       youryanh
// @match        https://rodeo-iad.amazon.com/*
// @match        https://sortcenter-menu-na.amazon.com/containerization/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        unsafeWindow
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/youngryan521/Projects/main/rsr-trickle-v2.user.js
// @downloadURL  https://raw.githubusercontent.com/youngryan521/Projects/main/rsr-trickle-v2.user.js
// ==/UserScript==

(function () {
  'use strict';

  const KEY        = 'rsr_v2';
  const RODEO_MS   = 2000;
  const TRICKLE_MS = 600;
  const FC_UTC_OFFSET_H = -5; // QIW9 = CDT (UTC-5)
  const COOLDOWN_MS = 5 * 60000; // 5 min before retrying a container-closed item

  const CPTS = [
    { label: '14:30', h: 14, m: 30, destId: '1ccd5e27-2a40-59cf-37e1-3b880c243e57' },
    { label: '22:00', h: 22, m:  0, destId: 'f6cd5e27-2a42-e873-aa17-be5ebb0539d6' },
    { label: '02:00', h:  2, m:  0, destId: 'aacd5e27-2a4c-7d53-fc04-093007fe0f5c' },
  ];

  // ── STATE ────────────────────────────────────────────────────────────────────

  function blank() {
    return { sp00: null, rawId: null, destId: null, cpt: null, action: 'idle',
             pausedAt: null,
             skipList:         [],  // permanent: step-1 rejections (SP00 unrecognized)
             cooldowns:        {},  // rawId -> ms when cooldown expires (all destIds closed)
             recentlyProcessed: [], // last 20 rawIds processed -- prevents same-item oscillation
             ok14: 0, err14: 0, ok22: 0, err22: 0, ok02: 0, err02: 0 };
  }
  function load()  { try { return JSON.parse(GM_getValue(KEY, 'null')) || blank(); } catch { return blank(); } }
  function save(s) { GM_setValue(KEY, JSON.stringify(s)); }

  // ── SP00 / CPT UTILS ─────────────────────────────────────────────────────────

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
    const now = new Date();
    const utcMid = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    let utcH = cpt.h - FC_UTC_OFFSET_H, dayOffset = 0;
    if (utcH >= 24) { utcH -= 24; dayOffset = 1; }
    const ms = utcMid + dayOffset * 86400000 + utcH * 3600000 + cpt.m * 60000;
    const nowCDT_h = ((now.getUTCHours() + FC_UTC_OFFSET_H) + 24) % 24;
    if (cpt.h < 6 && nowCDT_h >= 12) return ms + 86400000;
    return ms;
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
      const res = await fetch(cptUrl(cpt), { credentials: 'include' });
      if (!res.ok) return [];
      const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
      const out = [];
      doc.querySelectorAll('tr, [role="row"]').forEach(row => {
        const txt = row.textContent;
        const sp  = txt.match(/\bsp[A-Z][A-Za-z0-9]{6,18}\b/);
        if (sp) out.push({ id: sp[0], dwell: dwellMins(txt) });
      });
      return out
        .filter(x => {
          if ((skipList  || []).includes(x.id))              return false;
          if (Date.now() < ((cooldowns || {})[x.id] || 0))  return false;
          return true;
        })
        .sort((a, b) => b.dwell - a.dwell);
    } catch { return []; }
  }

  // ── SHARED UTILS ─────────────────────────────────────────────────────────────

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  function waitFor(pred, ms = 5000) {
    return new Promise(resolve => {
      if (pred()) return resolve(true);
      const ob = new MutationObserver(() => { if (pred()) { ob.disconnect(); clearTimeout(t); resolve(true); } });
      ob.observe(document.body, { childList: true, subtree: true, characterData: true });
      const t = setTimeout(() => { ob.disconnect(); resolve(false); }, ms);
    });
  }

  // ── ENTRY ────────────────────────────────────────────────────────────────────

  if      (location.href.includes('rodeo-iad.amazon.com'))                           runRodeo();
  else if (location.href.includes('sortcenter-menu-na.amazon.com/containerization')) runTrickle();

  // ============================================================================
  //  RODEO
  // ============================================================================
  function runRodeo() {
    const okKey  = { '14:30':'ok14', '22:00':'ok22', '02:00':'ok02'  };
    const errKey = { '14:30':'err14','22:00':'err22','02:00':'err02' };

    async function loop() {
      while (true) {
        await sleep(RODEO_MS);
        let s = load();
        s.skipList          = s.skipList          || [];
        s.cooldowns         = s.cooldowns         || {};
        s.recentlyProcessed = s.recentlyProcessed || [];

        // ── Handle completed action from Trickle ──────────────────────────────
        if (s.action === 'done') {
          s[okKey[s.cpt]]++;
          // Add to recentlyProcessed so we don't immediately re-pick this item
          s.recentlyProcessed = [s.rawId, ...s.recentlyProcessed].slice(0, 20);
          s.action = 'idle'; save(s);

        } else if (s.action === 'step1_fail') {
          s[errKey[s.cpt]]++;
          if (s.rawId && !s.skipList.includes(s.rawId)) {
            s.skipList.push(s.rawId);
            console.log('[RSR+][Rodeo] Permanent skip:', s.rawId);
          }
          s.recentlyProcessed = [s.rawId, ...s.recentlyProcessed].slice(0, 20);
          s.action = 'idle'; save(s);

        } else if (s.action === 'error') {
          s[errKey[s.cpt]]++;
          if (s.rawId) {
            s.cooldowns[s.rawId] = Date.now() + COOLDOWN_MS;
            console.log('[RSR+][Rodeo] 5min cooldown for', s.rawId);
          }
          s.recentlyProcessed = [s.rawId, ...s.recentlyProcessed].slice(0, 20);
          s.action = 'idle'; save(s);
        }

        if (s.action === 'pending') continue;

        // ── Pick next item ─────────────────────────────────────────────────────
        // FIX: was `x.id !== s.rawId` which only excluded the LAST processed item,
        // causing the highest-dwell items A and B to oscillate forever (A->B->A->B).
        // recentlyProcessed tracks the last 20 processed IDs; when the queue is
        // exhausted (all items recently processed), reset and start the cycle again.
        let pick = null, pickCPT = null, anyAvailable = false;
        for (const cpt of CPTS) {
          const items = await fetchItems(cpt, s.skipList, s.cooldowns);
          if (items.length > 0) anyAvailable = true;
          const c = items.find(x => !s.recentlyProcessed.includes(x.id));
          if (c) { pick = c; pickCPT = cpt; break; }
        }

        if (!pick) {
          // All available items were recently processed -- clear and retry next poll
          if (anyAvailable) {
            console.log('[RSR+][Rodeo] All items recently processed -- resetting cycle');
            s.recentlyProcessed = [];
            save(s);
          }
          continue;
        }

        const prevIdx = CPTS.findIndex(c => c.label === s.cpt);
        const nextIdx = CPTS.findIndex(c => c.label === pickCPT.label);
        if      (prevIdx > nextIdx && s.rawId)                     s.pausedAt = { cpt: s.cpt, rawId: s.rawId };
        else if (s.pausedAt && pickCPT.label === s.pausedAt.cpt)   s.pausedAt = null;
        else if (nextIdx >= prevIdx && prevIdx !== -1)              s.pausedAt = null;

        s.sp00  = toTrickle(pick.id); s.rawId = pick.id;
        s.destId = pickCPT.destId;    s.cpt   = pickCPT.label;
        s.action = 'pending'; save(s);
        console.log('[RSR+][Rodeo] Assigned:', pick.id, '->', s.sp00, '| CPT:', s.cpt);
      }
    }
    loop();
  }

  // ============================================================================
  //  TRICKLE
  // ============================================================================
  function runTrickle() {

    // ── Flash bar ─────────────────────────────────────────────────────────────
    const bar = document.createElement('div');
    Object.assign(bar.style, {
      position:'fixed', top:'0', left:'0', right:'0', padding:'5px 10px',
      fontSize:'13px', fontWeight:'bold', fontFamily:'Courier New,monospace',
      zIndex:'99999', textAlign:'center', display:'none',
    });
    document.body.appendChild(bar);

    function flash(msg, bg, ms = 1200) {
      bar.textContent = msg; bar.style.background = bg;
      bar.style.color = '#fff'; bar.style.display = 'block';
      clearTimeout(bar._t);
      bar._t = setTimeout(() => { bar.style.display = 'none'; }, ms);
    }

    // ── Page state ────────────────────────────────────────────────────────────
    function sdMsg() {
      const el = document.getElementById('sd_message');
      return el ? el.textContent.trim() : '';
    }
    function atStart()    { return /scan container to move/i.test(sdMsg()); }
    function atDestStep() { return /scan destination/i.test(sdMsg()); }

    // ── Scanner injection ─────────────────────────────────────────────────────
    function scanInject(value) {
      const el = document.getElementById('sd_input');
      if (el) el.value = value;
      const sd = unsafeWindow.sd;
      if (sd && typeof sd.receivedScanEvent === 'function') {
        sd.receivedScanEvent(value, '', '');
        return true;
      }
      if (!el) return false;
      el.focus(); el.value = '';
      for (const ch of value) {
        const o = { key:ch, charCode:ch.charCodeAt(0), keyCode:ch.charCodeAt(0), bubbles:true };
        el.dispatchEvent(new KeyboardEvent('keydown',  o));
        el.dispatchEvent(new KeyboardEvent('keypress', o));
        el.value += ch;
        el.dispatchEvent(new KeyboardEvent('keyup', o));
      }
      el.dispatchEvent(new KeyboardEvent('keydown', { key:'Enter', keyCode:13, bubbles:true }));
      el.dispatchEvent(new KeyboardEvent('keyup',   { key:'Enter', keyCode:13, bubbles:true }));
      return true;
    }

    function infodisplayText() {
      const el = document.getElementById('infodisplay');
      return el ? el.textContent.trim() : '';
    }

    // ── Dest scan with persistent observer ────────────────────────────────────
    // FIX: old `!atDestStep()` false-positive -- after BEEP the page resets to
    // "Scan container to move", which looks like success. New approach: attach a
    // dedicated MutationObserver to #infodisplay BEFORE the scan so it records
    // ALL text that appears (even if it clears in <50ms). Then decide on that history.
    async function tryScanDestId(destId) {
      console.log('[RSR+] Trying destId:', destId);
      flash(`DEST: ${destId.slice(0,22)}...`, '#1a237e', 900);

      // Start recording infodisplay text changes before injecting
      const infoEl = document.getElementById('infodisplay');
      const seen   = new Set();
      const infoObs = new MutationObserver(() => {
        const t = infoEl ? infoEl.textContent.trim() : '';
        if (t) seen.add(t);
      });
      if (infoEl) infoObs.observe(infoEl, { childList: true, subtree: true, characterData: true });

      console.log('[RSR+] sdMsg before destId scan:', sdMsg());
      scanInject(destId);

      // Wait for page to leave dest step, or 2.5s timeout
      await waitFor(() => {
        // Also capture current infodisplay text inside the waitFor predicate
        const t = infodisplayText();
        if (t) seen.add(t);
        return !atDestStep();
      }, 2500);

      // Extra 150ms to catch any trailing text update
      await sleep(150);
      const trailing = infodisplayText();
      if (trailing) seen.add(trailing);

      infoObs.disconnect();

      const allSeen = [...seen].join(' ');
      console.log('[RSR+] infodisplay history:', allSeen || '(empty)');

      if (/already scanned|move_to_sameparent/i.test(allSeen)) {
        console.log('[RSR+] Already in container -- success');
        return 'success';
      }
      if (/not open|no active|waterspider/i.test(allSeen)) return 'closed';
      if (/wrong barcode|scan correct|cannot move|does not have|not in the right|package not found|invalid/i.test(allSeen)) {
        console.log('[RSR+] destId hard reject. Seen:', allSeen);
        return 'reject';
      }

      // No error seen in any recorded text
      if (!atDestStep()) {
        console.log('[RSR+] destId accepted (no error captured):', destId);
        return 'success';
      }

      console.log('[RSR+] destId timed out at dest step:', destId);
      return 'reject';
    }

    async function tryAllDestIds(primaryDestId) {
      const others  = CPTS.filter(c => c.destId !== primaryDestId).map(c => c.destId);
      const destIds = [primaryDestId, ...others];
      for (const destId of destIds) {
        await sleep(200);
        const result = await tryScanDestId(destId);

        if (result === 'success') return destId;

        if (result === 'closed') {
          flash('CONTAINER NOT OPEN -- retrying in 45s', '#e65100', 45000);
          console.log('[RSR+] Container not open. Waiting 45s...');
          await sleep(45000);
          const r2 = await tryScanDestId(destId);
          if (r2 === 'success') return destId;
          console.log('[RSR+] Still closed after retry. Next destId.');
        }
        // 'reject' or still-closed: try next destId
      }
      return null;
    }

    // ── Submit ────────────────────────────────────────────────────────────────
    async function submit(s) {
      // Always reset to start before step 1 (prevents stale dest-step state)
      if (!atStart()) {
        const btn = document.getElementById('start_again');
        if (btn) btn.click();
        const ok = await waitFor(atStart, 3000);
        if (!ok) {
          console.log('[RSR+] Cannot reach start state. sdMsg:', sdMsg());
          return false;
        }
      }

      // Step 1: scan SP00
      console.log('[RSR+] Step 1: scanning SP00:', s.sp00);
      flash(`SP00: ${s.sp00}`, '#37474f', 800);
      scanInject(s.sp00);

      const resolved = await waitFor(
        () => atDestStep() || /wrong barcode|scan correct sc|unrecognized/i.test(infodisplayText()),
        6000
      );

      if (!resolved) {
        console.log('[RSR+] Step 1 timeout. sdMsg:', sdMsg());
        return 'step1_fail';
      }
      if (!atDestStep()) {
        console.log('[RSR+] Step 1 rejected. infodisplay:', infodisplayText());
        flash(`SKIP: ${s.sp00}`, '#b71c1c', 3000);
        return 'step1_fail';
      }

      // FIX v2.13.0: wait 600ms for Trickle scanner to fully enter dest-step mode.
      // sd.receivedScanEvent uses a stray-scan fallback when the scanner isn't ready.
      // A destId arriving too early goes through that path, gets a silent BEEP,
      // and infodisplay stays empty -- causing a false success. Stabilize first.
      await sleep(600);
      if (!atDestStep()) {
        console.log('[RSR+] Dest step not stable after SP00. sdMsg:', sdMsg());
        return 'step1_fail';
      }

      // Step 2: scan destIds
      const worked = await tryAllDestIds(s.destId);
      if (!worked) console.log('[RSR+] All destIds failed.');
      return worked !== null;
    }

    // ── Process loop ─────────────────────────────────────────────────────────
    async function loop() {
      await sleep(2000);

      while (true) {
        await sleep(TRICKLE_MS);
        const s = load();
        if (s.action !== 'pending') continue;

        const result = await submit(s);

        const s2 = load();
        if (s2.sp00 !== s.sp00) continue; // Rodeo moved on

        if (result === 'step1_fail') {
          s2.action = 'step1_fail';
          save(s2);
          await sleep(1000);
        } else if (result === true) {
          s2.action = 'done';
          save(s2);
          flash(`SUCCESS  ${s.sp00}`, '#1b5e20', 1500);
        } else {
          s2.action = 'error';
          save(s2);
          flash(`ALL DESTS FAILED  ${s.sp00}`, '#7f0000', 3000);
        }
      }
    }

    loop();
  }

})();
