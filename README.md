# RSR+ Outbound Trickle v2

**Author:** youryanh | **Version:** 2.19.0 | **Updated:** 2026-06-24

Tampermonkey userscript that automates the Amazon Sort Center outbound trickle workflow.
Reads SP00 containers from the Rodeo `ManifestPending` work pool, converts them to the
Trickle barcode format, and submits them to the Sort Center Containerization app —
no manual scanning required.

---

## Install

[![Install Script](https://img.shields.io/badge/%E2%AC%87%20Install-RSR%2B%20Trickle%20v2-brightgreen?style=for-the-badge)](https://raw.githubusercontent.com/youngryan521/RSR-Outbound-Trickle-Automation/main/rsr-trickle-v2.user.js)

**One-click:** Click the badge above in Firefox with Tampermonkey installed — it will prompt you to install.

**Or copy this URL and paste it into Firefox:**
```
https://raw.githubusercontent.com/youngryan521/RSR-Outbound-Trickle-Automation/main/rsr-trickle-v2.user.js
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
- [Configuration](#configuration)
- [SP00 Format Conversion](#sp00-format-conversion)
- [Tantei Lookup (spR Orders)](#tantei-lookup-spr-orders)
- [Flash Bar Reference](#flash-bar-reference)
- [Session State Schema](#session-state-schema)
- [Version History](#version-history)
- [Troubleshooting](#troubleshooting)
- [Security Analysis](#security-analysis)

---

## How It Works

The script runs on two browser tabs simultaneously and communicates through
Tampermonkey shared storage (`GM_setValue` / `GM_getValue`). Both tabs use one
combined script, so they share the same storage bucket.

```
RODEO TAB                              TRICKLE TAB
  |                                       |
  | fetch ManifestPending (per CPT)       |
  | sort by dwell time (oldest first)     |
  | convert SP00:                         |
  |   spP -> toTrickle() formula          |
  |   spR -> tantei GraphQL lookup        |
  | write state: action='pending'  -----> reads state
  |                                    reset to "Scan container to move"
  |                                    scan SP00 (step 1)
  |                                    600ms stabilize wait
  |                                    scan destId (step 2)
  |                                    write: action='done'|'error'|'step1_fail'
  | reads state <------------------------
  | update counters + pick next item      |
```

### State Machine

```
idle -> pending       (Rodeo assigns next item)
pending -> done        (both steps succeed)
pending -> error       (destId failed — container closed, 5-min cooldown applied)
pending -> step1_fail  (SP00 not recognized by Trickle — permanently skiplisted)

done       -> idle  (Rodeo increments ok counter, clears)
error      -> idle  (Rodeo increments err counter, sets 5-min cooldown on rawId, clears)
step1_fail -> idle  (Rodeo increments err counter, adds rawId to skipList, clears)
```

### Item Selection Logic (Rodeo)

CPTs are tried in priority order (14:30 first). Within each CPT, items are sorted by
dwell time (oldest first). The `recentlyProcessed` list (last 20 rawIds) prevents
the same items from cycling. When all available items have been recently processed,
the list resets and the full queue is eligible again.

Filters applied before picking:
1. `skipList` — permanently excluded (step-1 rejections or 3-strike items); persisted in GM storage, FIFO-capped at 100 entries, cleared at shift start
2. `cooldowns` — temporarily excluded until 5-min timer expires; lives in module-scope memory only, resets on page reload
3. `recentlyProcessed` — excluded for the current processing cycle (prevents oscillation); lives in module-scope memory only, resets on page reload

---

## Session Setup (Each Shift)

Open both tabs before starting:

1. **Rodeo tab:** `https://rodeo-iad.amazon.com/` — any ManifestPending view
2. **Trickle tab:** `https://sortcenter-menu-na.amazon.com/containerization/trickle`

In the Trickle tab, complete the manual setup each shift:

```
Job type → Station ID → Skip scale → Continue hazmat → "Scan container to move"
```

The script activates automatically once both pages finish loading. No button to press.

---

## Configuration

All configuration is at the top of the script:

```js
const FC_UTC_OFFSET_H = -5;    // Timezone offset: CDT = UTC-5. Change for other FCs.
const COOLDOWN_MS = 5 * 60000; // 5 min retry delay when containers are closed.

const CPTS = [
  { label: '14:30', h: 14, m: 30, destId: '1ccd5e27-2a40-59cf-37e1-3b880c243e57' },
  { label: '22:00', h: 22, m:  0, destId: 'f6cd5e27-2a42-e873-aa17-be5ebb0539d6' },
  { label: '02:00', h:  2, m:  0, destId: 'aacd5e27-2a4c-7d53-fc04-093007fe0f5c' },
];
```

**Finding a destId:** In Trickle, manually scan the physical cart barcode at "Scan
destination id". The UUID the app accepts is your destId. Each CPT slot has one cart.

**CPT order matters:** CPTs are tried in list order. Items in the first CPT that has
available items will always be processed before later CPTs.

---

## SP00 Format Conversion

Rodeo uses two SP00 prefixes for ManifestPending items:

| Prefix | Process path | Conversion method |
|---|---|---|
| `spP` | PPSingle | Direct formula: `'SP' + id.slice(3) + '_001_v'` |
| `spR` | PPMultiBldgWide | Tantei GraphQL lookup (see below) |

### spP conversion (confirmed formula)

```
spPkvHjT9pT  ->  SPkvHjT9pT_001_v
spPfmBQk9tT  ->  SPfmBQk9tT_001_v
spPvjrchzxT  ->  SPvjrchzxT_001_v

Rule: drop 'sp' + namespace letter (3 chars total), prefix 'SP', append '_001_v'
      id.slice(3) = 8 chars — all valid Trickle IDs have exactly 8 chars between SP and _001_v
```

All valid `spP` IDs end in `T` (type marker). The Trickle barcode inherits that `T`.

### spR conversion (tantei lookup)

`spR` IDs (`PPMultiBldgWide` orders, ~32% of a typical queue) have no derivable formula —
7+ formula variants were tested and all failed with "Wrong barcode". The Trickle ID is
an independent identifier accessible through the internal Tantei tool (see next section).

---

## Tantei Lookup (spR Orders)

`spR` orders are resolved automatically through the internal **Tantei** tool at
`https://trans-logistics.amazon.com/sortcenter/tantei`.

### Lookup flow

```
1. fetchItems() parses each Rodeo row's data-url attribute:
      data-url="/QIW9/ShipmentItem/mark?...&referenceId=45812345678901&scannableId=spRxxx..."
      -> sp00ToShipmentId['spRxxx'] = '45812345678901'

2. For each spR item picked:
      - If ShipmentId not found in map: 30s cooldown, retry after next fetchItems()
      - If found: POST GraphQL searchEntities to tantei with searchIdType: 'SHIPMENT_ID'

3. Walk the JSON response recursively for any string matching:
      /^SP[A-Za-z0-9]{7}T_001_v$/   <- the Trickle barcode format

4. Cache result per session (shipmentId -> trickleId)
      - No duplicate API calls per item
      - On tantei failure: 5-min cooldown (not permanent skip — transient errors are retried)
```

### Authentication

The tantei GraphQL endpoint requires a CSRF token (`anti-csrftoken-a2z`). The script
fetches it automatically from the tantei HTML page before the first spR lookup each
session. All requests use `GM_xmlhttpRequest` with `withCredentials: true` so your
existing Amazon session cookie authenticates the call — no extra login needed.

---

## Flash Bar Reference

A fixed status bar appears at the top of the Trickle tab during automation:

| Color | Message | Meaning |
|---|---|---|
| Dark grey | `SP00: SPxxxxxxx_001_v` | Scanning step 1 (container to move) |
| Dark blue | `DEST: aacd5e27-2a4c...` | Scanning step 2 (destination) |
| Orange | `CONTAINER NOT OPEN — retrying in 45s` | Waterspider needed to open container |
| Red | `SKIP: SPxxxxxxx_001_v` | SP00 unrecognized by Trickle (step 1 fail) |
| Dark red | `ALL DESTS FAILED SPxxxxxxx` | Container unavailable after 45s wait |
| Green | `SUCCESS SPxxxxxxx_001_v` | Item successfully moved |

---

## Session State Schema

Stored in Tampermonkey storage under key `rsr_v2` (JSON):

```json
{
  "sp00":   "SPkvHjT9pT_001_v",
  "rawId":  "spPkvHjT9pT",
  "destId": "1ccd5e27-2a40-59cf-37e1-3b880c243e57",
  "cpt":    "14:30",
  "action": "idle | pending | done | error | step1_fail",
  "pausedAt": null,
  "skipList":     ["spRRF64dZr9"],
  "lastActiveMs": 1750000000000,
  "ok14": 3, "err14": 0,
  "ok22": 0, "err22": 1,
  "ok02": 0, "err02": 0
}
```

To reset (clear skip list, counters): open Tampermonkey storage editor,
delete the `rsr_v2` key, then reload the Rodeo tab.

Note: `cooldowns`, `errorCount`, and `recentlyProcessed` are no longer persisted in GM
storage — they live in module-scope memory and reset automatically on page reload.

---

## Version History

### v2.19.0 — 2026-06-24
**Optimization: module-scope ephemeral state + shift-start skipList reset + FIFO cap**

**Root cause addressed:** `cooldowns`, `errorCount`, and `recentlyProcessed` were previously
written to GM storage on every loop tick. Over a busy shift (700–1800 packages) these objects
could accumulate ~80–100KB of data, all of which was parsed and re-serialized at 600ms intervals.
Stale entries from prior shifts were never pruned.

**Fix — module-scope variables (Rodeo side):**
`cooldowns`, `errorCount`, and `recentlyProcessed` now live as plain JavaScript variables
inside `runRodeo()`. They reset naturally on every page reload. GM storage is never written
for these fields, so they cannot accumulate across shifts.

**Fix — shift-start skipList reset:**
On page load, the script checks `Date.now() - lastActiveMs`. If the gap exceeds 8 hours
(new shift), the `skipList` is automatically cleared. Stale skip entries from the prior
shift do not carry over.

**Fix — skipList FIFO cap:**
`skipList` is now capped at 100 entries. When a new entry would exceed the cap, the oldest
entry is dropped (first-in, first-out). Prevents unbounded growth even within a single shift.

**New field:** `lastActiveMs` — timestamp of the most recent `save()` call. Stamped on every
GM write. Drives the 8-hour shift-start detection.

**Storage impact:**
- Before: up to ~80–100KB per busy shift, growing across sessions
- After: ~3KB permanently, regardless of shift volume or session count

**Removed from GM storage:** `cooldowns`, `errorCount`, `recentlyProcessed`
**Added to GM storage:** `lastActiveMs`

---

### v2.18.3 -- 2026-06-24
**Feature: CPT counter banner**

A small pill-shaped counter bar is now fixed at the bottom-center of the Trickle tab.
It shows the number of packages successfully moved to cart for each CPT window during
the current session.

```
 14:30: 3  |  22:00: 7  |  02:00: 1
```

- Counts are read from `ok14` / `ok22` / `ok02` in GM storage on every loop tick
- Banner appears immediately on page load with stored counts (persists across refreshes
  within the same TM storage key -- resets only when the `rsr_v2` key is cleared)
- Color-coded: 14:30 = green, 22:00 = blue, 02:00 = orange
- `pointerEvents: none` -- cannot be accidentally clicked or interfere with the page
- Updates within one Rodeo poll cycle (~2s) of each successful move

---

### v2.18.2 — 2026-06-21
**Fix: background tab support — runs while you work in other tabs**

Previously the script required the Trickle tab to stay focused. Switching to another
tab caused keyboard scan injection to fail silently, and background timer throttling
(Firefox clamps `setTimeout` to ~1s when hidden) caused lag on return.

**`waitVisible()`** — new helper. Resolves immediately if the tab is visible; if hidden,
waits silently until the tab is focused again before unblocking.

**`sleepOrVisible(ms)`** — replaces `sleep(MOVE_MS)` in the processing loop. Behaves
identically when the tab is visible. When the tab is hidden, resolves the moment you
switch back instead of waiting out the throttled timer — so the next item is picked up
immediately on return with no lag.

**`scanInject` → async** — two paths:
- `sd.receivedScanEvent` (primary): direct JS call, already works in background tabs
  with no changes. This path handles the vast majority of scans.
- Keyboard fallback: requires tab focus. Now checks `document.hidden` before dispatching
  events. If hidden, calls `waitVisible()` and holds the scan until the tab regains focus,
  then fires — no failures, no permission errors.

**Practical result:** Open the Trickle tab, leave it in the background, and work freely
in other tabs. Rodeo polling and scan injection continue uninterrupted. Return to the
Trickle tab at any time — processing resumes immediately.

---

### v2.18.1 — 2026-06-20
**Modernize: var → let/const, arrow functions, single-pass filter, optional chaining**

- All `var` declarations replaced with `let` / `const` throughout
- All anonymous functions converted to arrow functions (`const fn = () => {}`)
- `for...of` loop replaces indexed `for` in CPT iteration
- `addRecent(s, id)` helper extracted — deduplication logic centralized in one place
- Single-pass filter in `fetchItems()` — count skipped items and filter in one `.filter()` call (was two passes)
- Optional chaining: `getElementById('start_again')?.click()`, `sd?.receivedScanEvent`, `el?.textContent.trim() ?? ''`
- Template literals throughout: URL construction, error messages, log prefixes

---

### v2.18.0 — 2026-06-20
**Feature: spR order support via tantei GraphQL lookup**

- `spR` (PPMultiBldgWide) SP00s confirmed to have no derivable formula — 7+ variants tested and failed
- Root cause: `spR` Trickle IDs are independent identifiers managed by a separate system
- Solution: Sort Center Tantei GraphQL API (`searchEntities` with `searchIdType: 'SHIPMENT_ID'`)
- `sp00ToShipmentId` map populated during `fetchItems()` by parsing Rodeo `data-url` attributes for `referenceId` param
- `gmFetch()` — Promise wrapper around `GM_xmlhttpRequest` with `withCredentials: true`
- `lookupTrickleIdFromTantei(shipmentId)` — fetches `__token_` CSRF from tantei HTML then POSTs GraphQL query
- `findTrickleId(obj)` — recursive JSON walker matching `/^SP[A-Za-z0-9]{7}T_001_v$/`
- spR failures get 5-min cooldown (not permanent skip) — transient API errors are retried
- Results cached per session in `trickleIdCache` — no redundant API calls
- Added `@grant GM_xmlhttpRequest` and `@connect trans-logistics.amazon.com` to script header

---

### v2.17.3 — 2026-06-19
**Stability: debug logging, skip list improvements, log prefix standardization**

- Comprehensive `[RSR+][Rodeo]` / `[RSR+][Trickle]` log prefix system
- Idle tick counter — logs state every 50 ticks instead of flooding console
- Loop-level try-catch on both Rodeo and Trickle sides — auto-recovery within 2–3s on any exception
- Skip list entries logged at point of addition for easier debugging
- `errorCount` field initialized defensively in each loop iteration

---

### v2.16.0 — 2026-06-19
**Fix: single destId only — removed multi-destId fallback**

Previous versions tried all 3 CPT destIds in sequence when the primary container was closed.
This was found to cause silent incorrect moves: scanning a destId UUID while Trickle is at
start state (not dest step) causes it to treat the UUID as a *container to move*, not a
destination. The Trickle page then attempts to move the destId container itself.

- Removed fallback destId loop — only the item's assigned CPT destId is tried
- After a closed-container 45s wait, the item fails back to Rodeo for cooldown
- Rodeo then picks a different item from a different CPT if available
- Prevents the "For containers: This move cannot be done" error

---

### v2.15.0 — 2026-06-18
**Feature: flash status bar UI**

- Fixed `<div>` bar appended to top of Trickle page at `z-index: 99999`
- Color-coded flashes: dark grey (step 1), dark blue (step 2), orange (closed), red (skip), dark red (fail), green (success)
- Bar auto-hides after configurable duration per state
- `flash(msg, bg, ms)` helper function — all state transitions call it

---

### v2.14.0 — 2026-06-18
**Fix: BEEP != success + 3-strike permanent skip**

**BEEP detection:**
After a destId scan, the Trickle page emits a BEEP and resets to start state on certain
error paths. The old code treated "page left dest step" as success. This caused items to
be marked `done` even when the move failed — items would stay in ManifestPending and cycle forever.

Fix: use SP00 presence in `#infodisplay` as the **positive** success signal.
On a real move, Trickle appends `"Moved container SP... To CART..."` to infodisplay.
On a stray BEEP, infodisplay is unchanged (shows previous text, not the current SP00).
`allSeen.includes(sp00)` is reliable — the full SP00 ID will not appear in a prior item's text.

**3-strike rule:**
After 3 consecutive `error` outcomes on the same rawId, the item is permanently skiplisted.
Prevents infinite loops on items that repeatedly fail at the dest step (wrong route, system error, etc.).

---

### v2.13.0 — 2026-06-18
**Fix: 600ms dest-step stabilization after SP00 scan**

After scanning SP00 and reaching dest step, `sd.receivedScanEvent` has a stray-scan fallback
path that fires when the scanner is not yet fully registered at dest step. A destId arriving
too early goes through that fallback, gets a silent BEEP, and infodisplay stays empty —
causing a false success with no actual move.

Fix: wait 600ms after SP00 scan before scanning destId. Only proceed if `atDestStep()` is
still true after the wait. If dest step is no longer active, treat as `step1_fail`.

---

### v2.12.0 — 2026-06-18
**Fix: 2-item oscillation + persistent infodisplay observer**

**Root cause of oscillation (proven by simulation):**
```
items sorted by dwell: [A=500, B=400, C=300, D=200, E=100]
pick A (excluded: none)  -> rawId=A
pick B (excluded: A)     -> rawId=B
pick A (excluded: B)     -> rawId=A  <- C/D/E never reached
pick B (excluded: A)     -> rawId=B  <- infinite oscillation
```
`items.find(x => x.id !== s.rawId)` only blocked the single last-processed ID.
The two highest-dwell items trapped the selector forever.

**Fix (Rodeo):** `recentlyProcessed[]` (last 20 IDs). Every outcome
(done/error/step1_fail) appends the item's rawId. Next pick excludes all of them.
When all available items appear in the list, it resets and the full cycle restarts.

**Fix (Trickle):** The v2.11.0 `capturedErr` approach missed error text that
appeared and cleared before the MutationObserver predicate ran. Fixed with a
dedicated `infoObs` observer attached to `#infodisplay` BEFORE the scan.
All text values seen are collected into a `Set`. The full history is checked
after `waitFor` + 150ms grace period.

---

### v2.11.0 — 2026-06-18
**Fix: false success detection + always-reset before step 1**

**Root cause:** After a BEEP, the Trickle page auto-resets to "Scan container
to move". Old code checked `if (!atDestStep()) return destId` — this fired TRUE
on the error reset and declared success. Items were never actually moved but were
marked `done`, stayed in ManifestPending, and cycled forever.

**Fix:** `tryScanDestId()` function extracted. Returns `'success'` / `'closed'` / `'reject'`
instead of `true`/`false`. Error text is captured before the page clears it.

**Fix:** `submit()` now always clicks `start_again` and waits for `atStart()`
before scanning step 1. Removed the "already at dest step, skip step 1" shortcut
that caused stale-state false successes at session start and after failures.

---

### v2.10.0 — 2026-06-18
**Fix: CDT timezone sign bug + cooldown system for closed containers**

**Timezone bug:** `nowCDT_h = ((utcH - FC_UTC_OFFSET_H) + 24) % 24` used the
wrong sign. At 11:32 PM CDT (UTC hour = 4), this computed hour 9 instead of 23.
Fixed: `(utcH + FC_UTC_OFFSET_H + 24) % 24`.
This broke next-day detection for the 02:00 CPT and caused the script to always
target the 14:30 CPT even when working the 22:00 window.

**Cooldown:** When a container is closed, `action='error'` now sets
`cooldowns[rawId] = now + 5min`. Rodeo skips cooled-down items and picks from other
CPTs. Without this, a closed container caused infinite re-assignment of the same item.

---

### v2.9.0 — 2026-06-18
**Fix: skip list + already-scanned success + fast step-1 rejection**

- Added `skipList: []` to state. When step 1 fails (`step1_fail`), rawId is
  permanently added. `fetchItems` filters skip-listed items on all future polls.
- If `#infodisplay` shows "already scanned to Container" after destId scan,
  treat as success. Item was moved by a prior attempt.
- `waitFor` in `submit()` exits immediately on "wrong barcode / Scan correct SC"
  in `#infodisplay` — no longer waits the full 6-second timeout per rejection.

---

### v2.8.0 — 2026-06-17
**Fix: confirmed SP00 conversion formula + container-not-open detection**

- `toTrickle()` formula confirmed: `'SP' + id.slice(3) + '_001_v'`
  (skips `sp` + one namespace letter = 3 chars total)
- Detects "Container not open / See Waterspider" in `#infodisplay`.
  On this error: waits 45 seconds, then reports failure to Rodeo for cooldown.

---

### v2.7.0 — 2026-06-17
**Critical fix: page state detection**

`#sd_title` is always empty in the containerizationManager app. All state detection
was broken because the code read from `#sd_title` instead of `#sd_message`.

- `atStart()` now reads: `/scan container to move/i.test(sdMsg())`
- `atDestStep()` now reads: `/scan destination/i.test(sdMsg())`

Without this fix, the script could not detect any step transitions and processed
zero items.

---

### v2.6.0 and earlier
Initial architecture. Basic SP00 relay from Rodeo to Trickle. `spP`-only conversion.
Page state reading from `#sd_title` (broken). No skip list, no cooldowns.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Script does nothing | Trickle not set up for shift | Complete job type → station ID → hazmat setup first |
| Orange bar for a long time | Waterspider hasn't opened container | Normal — retries after 45s automatically |
| Red `SKIP:` flash | SP00 not recognized by Trickle | Normal — skiplisted, won't retry |
| Dark red `ALL DESTS FAILED` | Container unavailable after 45s wait | 5-min cooldown applied; other items run first |
| spR items always on cooldown | Rodeo HTML has no `data-url` on those rows | Check console: `[RSR+][Rodeo] No ShipmentId for spR:` |
| spR items fail with tantei error | Amazon session expired | Reload Rodeo tab — session cookie refreshes |
| Only 2 items cycling | Running pre-v2.12.0 | Update script |
| Always picks 14:30 CPT | Running pre-v2.10.0 | Update script (CDT timezone fix) |
| Items fail but no flash bar | Trickle tab not open or wrong URL | Open `sortcenter-menu-na.amazon.com/containerization/trickle` |

---

## Security Analysis

### External Scan Results

**Tool:** Hybrid Analysis (MetaDefender Multi-Scan + Falcon Sandbox)  
**Sample hash:** `f8d121380564f3984eda04b9647f90e330c4b846bf752156cac63fcf9eba6747`  
**Scan date:** 2026-06-18  
**AV verdict:** **Clean** (0 detections across all engines)

#### MITRE ATT&CK Techniques Flagged

| ID | Technique | Malicious | Suspicious | Informative |
|---|---|---|---|---|
| T1140 | Deobfuscate/Decode Files | 0 | **1** | 0 |
| T1059.007 | JavaScript | 0 | 0 | 1 |
| T1082 | System Information Discovery | 0 | 0 | 8 |
| T1083 | File and Directory Discovery | 0 | 0 | 4 |
| T1129 | Shared Modules | 0 | 0 | 4 |
| T1012 | Query Registry | 0 | 0 | 4 |
| T1106 | Native API | 0 | 0 | 3 |
| T1027 | Obfuscated Files or Information | 0 | 0 | 3 |
| T1057 | Process Discovery | 0 | 0 | 3 |
| T1573 | Encrypted Channel | 0 | 0 | 1 |
| T1113 | Screen Capture | 0 | 0 | 1 |
| T1546.015 | COM Hijacking | 0 | 0 | 1 |
| T1112 | Modify Registry | 0 | 0 | 1 |
| T1558 | Kerberos Tickets | 0 | 0 | 1 |
| Others (19) | Various | 0 | 0 | 1 each |

**T1140 suspicious — false positive:** Tampermonkey's own sandbox wrapper contains a
`debugger` statement and a `window["__f__..."]` injection pattern. The heuristic fired on
Tampermonkey's code, not on this script. No base64, no XOR, no encoded strings in this script.

**All 55 informative hits — not from this script:** Generated by Firefox browser infrastructure
and sandbox monitoring tools running inside the scan environment, not by userscript code.

---

### Static Code Analysis

| Category | Result |
|---|---|
| `eval()` / `new Function()` | NOT FOUND |
| `innerHTML` assignment | NOT FOUND — only `textContent` used |
| `document.write()` | NOT FOUND |
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
| `GM_xmlhttpRequest` | Tantei API requests for spR lookup | Low — Amazon-internal only |
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
