# RSR+ Outbound Dropzone v2

**Author:** youryanh | **Version:** 1.1.1 | **Updated:** 2026-06-20

A Tampermonkey userscript that automates the **Sort Center Rodeo → Move (Dropzone)**
workflow at Amazon FCs. Reads the ManifestPending queue from Rodeo, converts each SP00
to a Sort Center container ID, and automatically scans it into the Dropzone destination
on the Move page — no manual barcode scanning required.

---

## Install

[![Install Script](https://img.shields.io/badge/%E2%AC%87%20Install-RSR%2B%20Dropzone%20v2-brightgreen?style=for-the-badge)](https://raw.githubusercontent.com/youngryan521/RSR-Outbound-Trickle-Automation/RSR-DROPZONE-AUTOMATION/rsr-dropzone-v2.user.js)

**One-click:** Click the badge above in Firefox with Tampermonkey installed — it will prompt you to install.

**Or copy this URL and paste it into Firefox:**
```
https://raw.githubusercontent.com/youngryan521/RSR-Outbound-Trickle-Automation/RSR-DROPZONE-AUTOMATION/rsr-dropzone-v2.user.js
```

> Requires [Tampermonkey](https://www.tampermonkey.net/) installed in Firefox. No admin access needed.

### Keeping Up to Date

The script header includes `@updateURL` and `@downloadURL` pointing to this repo.
Tampermonkey checks for updates automatically once per day. To trigger a manual check:
TM Dashboard → script row → **Check for updates** icon.

---

## Table of Contents

- [How It Works](#how-it-works)
- [Session Setup (Each Shift)](#session-setup-each-shift)
- [SP00 Conversion](#sp00-conversion)
- [Tantei Lookup (spR Orders)](#tantei-lookup-spr-orders)
- [CPT Windows and Dropzone Destination](#cpt-windows-and-dropzone-destination)
- [Reading the Console](#reading-the-console)
- [Error Handling](#error-handling)
- [Do Not Run Both Scripts Simultaneously](#do-not-run-both-scripts-simultaneously)
- [Version History](#version-history)
- [Security Analysis](#security-analysis)

---

## How It Works

```
Rodeo (rodeo-iad.amazon.com)          GM Storage             Move Page (containermovement/)
-----------------------------          ----------             ------------------------------
fetchItems() polls                     action: idle     <--  loop() polls every 600ms
ManifestPending queue
for each CPT window

spP -> toTrickle() formula             action: pending  -->  submit():
spR -> tantei GraphQL lookup  ------>  sp00 + destId         1. scan SP00 (container to move)
                                                             2. 600ms stabilize wait
Assigned: spXxx -> SPXxx_001_v                               3. scan Dropzone destId

                                       action: done    <--   success confirmed via infodisplay

Rodeo increments ok count,
picks next item
```

**Two tabs must be open simultaneously:**
- One on any `rodeo-iad.amazon.com` page (Rodeo side runs here)
- One on `sortcenter-menu-na.amazon.com/containermovement/` (Move side runs here)

The script auto-detects which page it is on and runs the correct side.

---

## Session Setup (Each Shift)

Open both tabs before starting:

1. **Rodeo tab:** `https://rodeo-iad.amazon.com/` — any ManifestPending view
2. **Move tab:** `https://sortcenter-menu-na.amazon.com/containermovement/`

In the Move tab, complete the manual setup each shift:

```
Job type → Station ID → Skip scale → Continue hazmat → "Scan container to move"
```

The script activates automatically once both pages finish loading. No button to press.

---

## SP00 Conversion

Rodeo uses two SP00 prefixes for ManifestPending items:

| Prefix | Process path | Conversion method |
|---|---|---|
| `spP` | PPSingle | Direct formula: `'SP' + id.slice(3) + '_001_v'` |
| `spR` | PPMultiBldgWide | Tantei GraphQL lookup (see below) |

### spP conversion (confirmed formula)

```
spPkvHjT9pT  ->  SPkvHjT9pT_001_v
spPfmBQk9tT  ->  SPfmBQk9tT_001_v

Rule: drop 'sp' + namespace letter (3 chars total), prefix 'SP', append '_001_v'
      id.slice(3) = 8 chars — all valid container IDs have exactly 8 chars between SP and _001_v
```

All valid `spP` IDs end in `T`. The container ID inherits that `T`.

---

## Tantei Lookup (spR Orders)

`spR` orders (~32% of a typical queue) have no derivable formula — 7+ variants were tested
and all failed with "Wrong barcode". The container ID is resolved automatically through the
internal **Tantei** tool at `https://trans-logistics.amazon.com/sortcenter/tantei`.

### Lookup flow

```
1. fetchItems() parses each Rodeo row's data-url attribute:
      data-url="/QIW9/ShipmentItem/mark?...&referenceId=45812345678901&scannableId=spRxxx..."
      -> sp00ToShipmentId['spRxxx'] = '45812345678901'

2. For each spR item picked:
      - If ShipmentId not found in map: 30s cooldown, retry after next fetchItems()
      - If found: POST GraphQL searchEntities to tantei with searchIdType: 'SHIPMENT_ID'

3. Walk the JSON response recursively for any string matching:
      /^SP[A-Za-z0-9]{7}T_001_v$/   <- the container ID format

4. Cache result per session (shipmentId -> containerId)
      - No duplicate API calls per item
      - On tantei failure: 5-min cooldown (not permanent skip — transient errors are retried)
```

All requests use `GM_xmlhttpRequest` with `withCredentials: true` so your existing Amazon
session cookie authenticates the call — no extra login needed.

---

## CPT Windows and Dropzone Destination

All three CPT windows route to the same Dropzone destination ID:

| CPT | Dropzone Destination ID |
|---|---|
| 14:30 CDT | `4ccd5e2a-9e00-3f03-1880-768b589f8210` |
| 22:00 CDT | `4ccd5e2a-9e00-3f03-1880-768b589f8210` |
| 02:00 CDT | `4ccd5e2a-9e00-3f03-1880-768b589f8210` |

CPT windows are fetched with a 1-minute ExSD range centered on each cutoff. The script
always picks the next upcoming CPT. Priority order: 14:30 → 22:00 → 02:00.

---

## Reading the Console

Open DevTools (`F12`) on either tab to see live status.

### Rodeo tab

| Log | Meaning |
|---|---|
| `[DZ+][Rodeo] Loop started` | Rodeo side is active |
| `[DZ+][Rodeo] CPT 02:00 -- rows: 5 \| skipped: 0 \| available: 5` | 5 items in queue, none filtered |
| `[DZ+][Rodeo] Assigned: spXxx -> SPXxx_001_v \| CPT: 02:00` | Item dispatched to Move side |
| `[DZ+][Rodeo] Cooldown: spXxx (error #1)` | Item failed, retrying in 5 min |
| `[DZ+][Rodeo] Permanent skip (3 errors): spXxx` | Item rejected 3x, permanently skipped |
| `[DZ+][Tantei] Token acquired` | CSRF token fetched — spR lookup ready |
| `[DZ+][Tantei] Resolved: 45812345678901 -> SPxxxxT_001_v` | spR item resolved successfully |
| `[DZ+][Rodeo] No ShipmentId for spR: spRxxx` | data-url attr missing — 30s retry |

### Move tab

| Log | Meaning |
|---|---|
| `[DZ+][Move] Loop started` | Move side is active |
| `[DZ+][Move] Idle. action: idle` | Waiting for Rodeo (normal) |
| `[DZ+] Step 1: SPXxx_001_v` | Scanning the container to move |
| `[DZ+] Scanning destId: 4ccd5e2a...` | Scanning the Dropzone destination |
| `[DZ+] Move accepted` | Success — container moved |
| `[DZ+] SUCCESS: SPXxx_001_v` | Confirmed, Rodeo notified |
| `[DZ+] Step 1 rejected` | SP00 unrecognized — added to skip list |
| `[DZ+] FAILED: SPXxx_001_v` | destId scan failed — 5-min cooldown applied |

---

## Error Handling

| Situation | Script response |
|---|---|
| SP00 not recognized by Move (step 1 fail) | Permanent skip — never retried |
| Destination not open / container closed | Wait 45s, then fail to Rodeo for 5-min cooldown |
| 3 consecutive errors on same item | Permanent skip |
| Items oscillating (A→B→A→B loop) | `recentlyProcessed[]` list (last 20 IDs) prevents re-picking |
| spR ShipmentId missing from data-url | 30s cooldown, retry after next fetchItems() |
| Tantei API failure / session expired | 5-min cooldown on that spR item, retry later |
| Script crashes / unexpected exception | Loop try-catch recovers within 2s |

---

## Do Not Run Both Scripts Simultaneously

This script shares the same Rodeo queue (`ManifestPending`) with **RSR+ Outbound Trickle v2**.
Running both at once will cause them to race over the same items. Keep only one enabled
at a time in Tampermonkey.

| Script | Destination | TM Storage Key |
|---|---|---|
| RSR+ Outbound Trickle v2 | Sort Center Trickle (CART) | `rsr_v2` |
| RSR+ Outbound Dropzone v2 | Sort Center Move (Dropzone) | `rsr_dropzone_v2` |

---

## Version History

### v1.1.1 — 2026-06-21
**Fix: background tab support — runs while you work in other tabs**

Parity with RSR+ Trickle v2.18.2. Previously the script required the Move tab to stay
focused. Switching to another tab caused keyboard scan injection to fail silently, and
background timer throttling caused lag on return.

**`waitVisible()`** — resolves immediately if visible; waits for tab focus if hidden.

**`sleepOrVisible(ms)`** — replaces `sleep(MOVE_MS)` in the processing loop. Wakes
immediately when the tab becomes visible instead of waiting out the throttled timer.

**`scanInject` → async**:
- `sd.receivedScanEvent` (primary): works in background tabs unchanged.
- Keyboard fallback: checks `document.hidden` before dispatching events. If hidden,
  calls `waitVisible()` and holds until the tab regains focus before firing.

**Practical result:** Leave the Move tab in the background while doing PackApp, ShipApp,
or other work. Rodeo polling and scan injection continue running. Return to the tab
at any time — processing resumes immediately.

---

### v1.1.0 — 2026-06-20
**Parity with RSR+ Trickle v2.18.1: modernize + spR tantei lookup**

**Code quality:**
- All `var` declarations replaced with `let` / `const` throughout
- All anonymous functions converted to arrow functions
- `for...of` loop replaces indexed `for` in CPT iteration
- `addRecent(s, id)` helper extracted — deduplication logic centralized
- Single-pass filter in `fetchItems()` — count skipped and filter in one `.filter()` call
- Optional chaining: `getElementById('start_again')?.click()`, `sd?.receivedScanEvent`, `el?.textContent.trim() ?? ''`
- Template literals throughout

**spR order support (tantei lookup):**
- `spR` (PPMultiBldgWide) orders confirmed to have no derivable formula — 7+ variants tested and failed
- Solution: Sort Center Tantei GraphQL API (`searchEntities` with `searchIdType: 'SHIPMENT_ID'`)
- `sp00ToShipmentId` map populated during `fetchItems()` from Rodeo `data-url` `referenceId` param
- `gmFetch()` — Promise wrapper around `GM_xmlhttpRequest` with `withCredentials: true`
- `lookupTrickleIdFromTantei()` — fetches `__token_` CSRF from tantei HTML then POSTs GraphQL
- `findTrickleId(obj)` — recursive JSON walker matching `/^SP[A-Za-z0-9]{7}T_001_v$/`
- Tantei failures get 5-min cooldown (not permanent skip) — transient errors are retried
- Results cached per session — no redundant API calls
- Added `@grant GM_xmlhttpRequest` and `@connect trans-logistics.amazon.com` to script header

---

### v1.0.1 — 2026-06-19
**Fix: correct `@match` URL for Move page**

Updated `@match` and entry-point detection from `/containerization/` to `/containermovement/`.
Without this fix, the Move-side `runMove()` function never activated on the Move page.

---

### v1.0.0 — 2026-06-19
**Initial release — fork of RSR+ Trickle v2.17.3**

Forked from the Trickle script and adapted for the Sort Center Move (Dropzone) workflow:
- `runTrickle()` renamed to `runMove()`
- `@match` changed to `sortcenter-menu-na.amazon.com/containermovement/*`
- All 3 CPT slots use the same Dropzone destId (`4ccd5e2a-9e00-3f03-1880-768b589f8210`)
- Log prefix changed from `[RSR+]` to `[DZ+]`
- TM storage key changed from `rsr_v2` to `rsr_dropzone_v2`
- All logic (state machine, skip list, cooldowns, 3-strike, oscillation fix) inherited from Trickle v2.17.3

---

## Security Analysis

### Hybrid Analysis — Sandbox Scan

**File:** `rsr-dropzone-v2.user.js`  
**SHA256:** `0c7770a9eac15e9b644efb55425333b8a5514fa45ee6bf8f3076902bf4400e47`  
**Submitted:** 2026-06-19 15:59:00 UTC  

| Check | Result |
|---|---|
| Overall verdict | **No Specific Threat** |
| AV detection (MetaDefender multi-scan) | **Marked as clean** |
| Malicious indicators | **0** |
| Suspicious indicators | **0** |
| Informative indicators | 33 techniques, all informative-only |

All 33 MITRE ATT&CK techniques show **0 malicious** and **0 suspicious** hits.
Informative hits are from the Windows + Firefox runtime environment the sandbox runs inside,
not from the userscript code.

| Technique | Actual source |
|---|---|
| T1059.007 — JavaScript | File is JavaScript — expected |
| T1082 — System Info (8x) | Firefox reads OS/screen info at startup |
| T1083 — File Discovery (4x) | Browser reads profile/cache paths |
| T1012 — Registry (4x) | Browser reads registry for its own settings |
| T1129 — Shared Modules (4x) | Browser loads system DLLs |
| T1057 — Process Discovery (3x) | Sandbox monitoring tools |
| T1106 — Native API (3x) | Browser system calls |
| T1573 — Encrypted Channel | HTTPS by the browser itself |
| T1558 — Kerberos Tickets | Windows Kerberos subsystem always present |

### Static Code Analysis

| Category | Result |
|---|---|
| `eval()` / `new Function()` | NOT FOUND |
| `innerHTML` assignment | NOT FOUND — only `textContent` used |
| External data exfiltration | NONE — all requests stay on Amazon's internal network |
| Outbound `fetch()` | `rodeo-iad.amazon.com` only |
| Outbound `GM_xmlhttpRequest` | `trans-logistics.amazon.com` only (`@connect` whitelisted) |
| `localStorage` / `sessionStorage` | NOT USED |
| Credentials stored | NONE — only SP00 IDs and counters in TM storage |

#### Tampermonkey Permissions

| Grant | Purpose | Risk |
|---|---|---|
| `GM_setValue` | Write cross-tab state | Low — internal only |
| `GM_getValue` | Read cross-tab state | Low — internal only |
| `GM_xmlhttpRequest` | Tantei API for spR lookup | Low — Amazon-internal only |
| `unsafeWindow` | Access `sd.receivedScanEvent` (page's native scan handler) | Low — single call |

No `GM_openInTab`, no `GM_download`, no `GM_cookie`.

### Overall Assessment

| Category | Rating |
|---|---|
| Code Injection | **None** |
| Data Exfiltration | **None** |
| XSS | **None** |
| External network calls | **None** — Amazon internal only |
| **Overall** | **LOW RISK** |

---

## Related

- **[RSR+ Outbound Trickle v2](https://github.com/youngryan521/RSR-Outbound-Trickle-Automation/tree/main)** — routes ManifestPending items to Sort Center Trickle (CART) instead of Dropzone
