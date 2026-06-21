# RSR+ Outbound Trickle v2

**Author:** youryanh  
**Current Version:** 2.12.0  
**Last Updated:** 2026-06-18  
**Script file:** `rsr-trickle-v2.user.js`

Tampermonkey userscript that automates the Amazon Sort Center outbound trickle workflow.
Reads SP00 containers from the Rodeo `ManifestPending` work pool, converts them to the
Trickle barcode format, and submits them to the Sort Center Containerization app --
no manual scanning required.

---

## Table of Contents

- [How It Works](#how-it-works)
- [Installation](#installation)
- [Configuration](#configuration)
- [SP00 Format Conversion](#sp00-format-conversion)
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
  | convert SP00: spPxxxxxx -> SPxxxxxx_001_v
  | write state: action='pending'  -----> reads state
  |                                    reset to "Scan container to move"
  |                                    scan SP00 (step 1)
  |                                    scan destId (step 2)
  |                                    write: action='done'|'error'|'step1_fail'
  | reads state <------------------------
  | update counters + pick next item      |
```

### State Machine

```
idle -> pending       (Rodeo assigns next item)
pending -> done        (both steps succeed)
pending -> error       (all destIds failed -- container closed, 5-min cooldown applied)
pending -> step1_fail  (SP00 not recognized by Trickle -- permanently skiplisted)

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
1. `skipList` -- permanently excluded (step-1 rejections)
2. `cooldowns` -- temporarily excluded until 5-min timer expires (container-closed errors)
3. `recentlyProcessed` -- excluded for the current processing cycle (prevents oscillation)

---

## Installation

1. Install [Tampermonkey](https://www.tampermonkey.net/) in Firefox (no admin required).
2. Open Tampermonkey dashboard -> New Script.
3. Paste the full contents of `rsr-trickle-v2.user.js`.
4. Open both tabs:
   - `https://rodeo-iad.amazon.com/` (any ManifestPending view)
   - `https://sortcenter-menu-na.amazon.com/containerization/trickle`
5. In the Trickle tab, complete manual session setup each shift:
   job type -> station ID -> skip scale -> continue hazmat -> "Scan container to move"
6. Script activates automatically once both pages load.

### Auto-update

The `@updateURL` and `@downloadURL` point to the GitHub repo. Tampermonkey will
offer updates automatically when new versions are pushed.

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

**CPT order matters:** CPTs are tried in list order. Items in the first CPT that have
items available will always be processed before later CPTs.

---

## SP00 Format Conversion

| Rodeo Format | Trickle Format | Rule |
|---|---|---|
| `spPkvHjT9pT` | `SPkvHjT9pT_001_v` | `'SP' + id.slice(3) + '_001_v'` |
| `spPfmBQk9tT` | `SPfmBQk9tT_001_v` | drop `sp` + namespace letter, prefix `SP` |
| `spPvjrchzxT` | `SPvjrchzxT_001_v` | all valid Trickle IDs have 8 chars after `SP` |

Items with prefixes other than `spP` (e.g. `spR`) are tried once and auto-added to the
permanent skip list on rejection. They are not retried.

---

## Flash Bar Reference

A fixed status bar appears at the top of the Trickle tab during automation:

| Color | Message | Meaning |
|---|---|---|
| Dark grey | `SP00: SPxxxxxxx_001_v` | Scanning step 1 (container to move) |
| Dark blue | `DEST: aacd5e27-2a4c...` | Scanning step 2 (destination) |
| Orange | `CONTAINER NOT OPEN -- retrying in 45s` | Waterspider needed to open container |
| Red | `SKIP: SPxxxxxxx_001_v` | SP00 unrecognized by Trickle (step 1 fail) |
| Dark red | `ALL DESTS FAILED SPxxxxxxx` | All 3 CPT containers unavailable |
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
  "skipList":  ["spRRF64dZr9"],
  "cooldowns": { "spPxxxxxxx": 1750000000000 },
  "recentlyProcessed": ["spPaaa", "spPbbb"],
  "ok14": 3, "err14": 0,
  "ok22": 0, "err22": 1,
  "ok02": 0, "err02": 0
}
```

To reset (clear skip list, cooldowns, counters): open Tampermonkey storage editor,
delete the `rsr_v2` key, then reload the Rodeo tab.

---

## Version History

### v2.12.0 -- 2026-06-18
**Fix: 2-item oscillation + persistent infodisplay observer**

**Root cause of loop (proven by simulation):**
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
All text values seen are collected into a `Set`. The complete history is checked
after `waitFor` + 150ms grace period.

Console now logs: `[RSR+] infodisplay history: ...` after every destId scan.

---

### v2.11.0 -- 2026-06-18
**Fix: false success detection + always-reset before step 1**

**Root cause:** After a BEEP, the Trickle page auto-resets to "Scan container
to move". Old code checked `if (!atDestStep()) return destId` -- this fired TRUE
on the error reset and declared success. Items were never actually moved but were
marked `done`, stayed in ManifestPending, and cycled forever.

**Fix:** `tryScanDestId()` function extracted. Uses `waitFor()` with a predicate
that captures error text into `capturedErr` before the page can clear it.
Returns `'success'` / `'closed'` / `'reject'` instead of `true`/`false`.

**Fix:** `submit()` now always clicks `start_again` and waits for `atStart()`
before scanning step 1. Removed the "already at dest step, skip step 1" shortcut
that caused stale-state false successes at session start and after failures.

---

### v2.10.0 -- 2026-06-18
**Fix: CDT timezone sign bug + cooldown system for closed containers**

**Timezone bug:** `nowCDT_h = ((utcH - FC_UTC_OFFSET_H) + 24) % 24` used the
wrong sign. At 11:32 PM CDT (UTC hour = 4), this computed hour 9 instead of 23.
Fixed: `(utcH + FC_UTC_OFFSET_H + 24) % 24`.
This broke next-day detection for the 02:00 CPT and caused the script to always
target the 14:30 CPT even when working the 22:00 window.

**Cooldown:** When all destIds fail (containers closed), `action='error'` now sets
`cooldowns[rawId] = now + 5min`. Rodeo skips cooled-down items and picks from other
CPTs. Without this, a closed container caused infinite re-assignment of the same item.

---

### v2.9.0 -- 2026-06-18
**Fix: skip list + already-scanned treated as success + fast step-1 rejection**

- Added `skipList: []` to state. When step 1 fails (`step1_fail`), rawId is
  permanently added. `fetchItems` filters skip-listed items on all future polls.
- After scanning destId, if `#infodisplay` shows "already scanned to Container",
  treat as success (not error). Item was already moved by a prior attempt.
- `waitFor` in `submit()` now exits immediately on "wrong barcode / Scan correct SC"
  text in `#infodisplay` -- no longer waits the full 6-second timeout per rejection.

---

### v2.8.0 -- 2026-06-17
**Fix: generalized SP00 conversion + container-not-open detection**

- `toTrickle()` generalized from `spP`-only to all `spX` prefixes:
  `'SP' + id.slice(3) + '_001_v'` (skips `sp` + one namespace letter).
- `tryAllDestIds()` detects "Container not open / See Waterspider" in `#infodisplay`.
  On this error: waits 45 seconds, retries the same destId once.

---

### v2.7.0 -- 2026-06-17
**Critical root fix: page state detection**

`#sd_title` is always empty in the containerMovementManager app. All state detection
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
| Script does nothing | Trickle not set up for shift | Complete job type -> station ID -> hazmat setup |
| Orange bar for a long time | Waterspider hasn't opened container | Normal -- retries after 45s automatically |
| Red `SKIP:` flash | SP00 not recognized by Trickle | Normal -- skiplisted, won't retry |
| Dark red `ALL DESTS FAILED` | All 3 CPT containers closed | 5-min cooldown; tries other items first |
| Only 2 items cycling | Running pre-v2.12.0 | Update to v2.12.0 |
| Always picks 14:30 CPT | Running pre-v2.10.0 | Update to v2.10.0 (CDT fix) |
| Items fail but no flash bar | Trickle tab not open / not on containerization URL | Open both required tabs |

---

## Security Analysis

### External Scan Results

**Tool:** Hybrid Analysis (MetaDefender Multi-Scan + Falcon Sandbox)  
**Sample hash:** `f8d121380564f3984eda04b9647f90e330c4b846bf752156cac63fcf9eba6747`  
**Scan date:** 2026-06-18  
**AV verdict:** **Clean** (0 detections across all engines)  
**Community score:** 0

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
| T1558 | Steal/Forge Kerberos Tickets | 0 | 0 | 1 |
| Others (19) | Various | 0 | 0 | 1 each |

**T1140 (1 suspicious) -- False Positive:**
Tampermonkey wraps userscripts in a sandboxing function containing a `debugger`
statement and runtime injection pattern (`window["__f__..."] = function(){...}`).
The deobfuscation heuristic fired on Tampermonkey's own wrapper code, not on our
script. The script itself has no base64, no encoded strings, no XOR loops, and no
character-code obfuscation of any kind.

**All informative indicators (55 total) -- Not from this script:**
These are generated by the Firefox browser and Tampermonkey extension infrastructure
running inside the sandbox environment:

| Technique | Actual source |
|---|---|
| T1082 System Info (8x) | Firefox browser reads OS/screen info at startup |
| T1083 File Discovery (4x) | Browser reads profile/cache paths |
| T1012 Query Registry (4x) | Browser reads registry for settings |
| T1129 Shared Modules (4x) | Tampermonkey's extension module loader |
| T1057 Process Discovery (3x) | Sandbox monitoring tools watching the session |
| T1027 Obfuscated Files (3x) | Sandbox's own compressed-file detection |
| T1106 Native API (3x) | Browser system calls |
| T1113 Screen Capture (1x) | Sandbox takes screenshots to generate the report |
| T1573 Encrypted Channel (1x) | HTTPS connections made by the browser itself |
| T1558 Kerberos Tickets (1x) | Windows Kerberos subsystem active by default |
| T1546.015 COM Hijacking (1x) | Browser extension COM registration |
| T1059.007 JavaScript (1x) | File is JavaScript -- expected for any .js |

---

### Static Code Analysis

**Tool:** Custom Python regex scanner  
**Date:** 2026-06-18  
**Result: HIGH: 0 | MEDIUM: 0 | INFO: 10 (all expected)**

#### Code Injection

| Pattern | Result |
|---|---|
| `eval()` | NOT FOUND -- PASS |
| `new Function()` | NOT FOUND -- PASS |
| `setTimeout(string, ...)` | NOT FOUND -- PASS |
| `setInterval(string, ...)` | NOT FOUND -- PASS |
| `document.write()` | NOT FOUND -- PASS |
| `innerHTML =` assignment | NOT FOUND -- PASS |

All dynamic content written to the page uses `textContent` (e.g. `bar.textContent = msg`).
Text content cannot be interpreted as HTML -- XSS is not possible.

#### Network

| Check | Result |
|---|---|
| Outbound fetch destinations | `rodeo-iad.amazon.com` only -- matches `@match` domain |
| External data exfiltration | None -- no data leaves Amazon's network |
| Credentials in fetch | `credentials: 'include'` on intra-Amazon fetch (authenticated session cookie) |
| `@updateURL` / `@downloadURL` | Own GitHub repo only -- no third-party CDN |

```js
// Only outbound fetch in the script:
fetch('https://rodeo-iad.amazon.com/QIW9/ItemList?...', { credentials: 'include' })
```

No `XMLHttpRequest`, no WebSocket, no `navigator.sendBeacon`. Zero external connections.

#### Storage

| Check | Result |
|---|---|
| `GM_setValue` / `GM_getValue` | Cross-tab state sync only (key: `rsr_v2`) |
| Data stored | SP00 IDs and counters -- no credentials, no PII |
| `localStorage` | NOT USED |
| `sessionStorage` | NOT USED (removed in v2.11.0) |

#### DOM Manipulation

| Check | Result |
|---|---|
| Elements inserted | 1 `<div>` (flash bar) appended to `document.body` |
| innerHTML | None -- only `textContent` used |
| `unsafeWindow` access | `unsafeWindow.sd.receivedScanEvent` -- page's native scan handler |

`unsafeWindow.sd` is the Trickle app's own scan event dispatcher. The script calls it
with values it already owns (the SP00 or destId string). No user input is involved.

#### Regex Safety (ReDoS)

17 complex patterns scanned. No catastrophic backtracking constructs found:

```js
/\bsp[A-Z][A-Za-z0-9]{6,18}\b/  // SP00 extraction -- fixed-length class, no nesting
/scan container to move/i        // Literal string -- O(n) only
/not open|no active|waterspider/i // Short alternation, non-overlapping
```

**ReDoS risk: NONE.**

#### Tampermonkey Permissions

| Grant | Purpose | Risk |
|---|---|---|
| `GM_setValue` | Write shared state to TM storage | Low -- internal only |
| `GM_getValue` | Read shared state from TM storage | Low -- internal only |
| `unsafeWindow` | Access `sd.receivedScanEvent` on page | Low -- single read-only call |

No `GM_xmlhttpRequest`, no `GM_openInTab`, no `GM_download`, no `GM_cookie`.
Minimal permission surface.

#### Performance & Lifecycle

| Check | Result |
|---|---|
| `while(true)` loops | 2 -- Rodeo (polls every 2s) and Trickle (polls every 600ms) |
| MutationObservers | 3 total -- `waitFor` observer, `infoObs` in `tryScanDestId` |
| Observer cleanup | All observers call `disconnect()` -- no leaks |
| Timer accumulation | `setTimeout` used only inside `sleep()` and `flash()` -- no stacking |

MutationObserver lifecycle:
- `waitFor()` observer: disconnected on predicate match OR timeout
- `infoObs`: disconnected at end of every `tryScanDestId()` call
- No dangling observers between items

---

### Overall Security Assessment

| Category | Rating | Detail |
|---|---|---|
| Code Injection | None | No eval, no innerHTML, no dynamic code |
| Data Exfiltration | None | No external network calls |
| Credential Exposure | None | Nothing stored or transmitted except SP00 IDs |
| XSS | None | textContent only, never innerHTML |
| ReDoS | None | No catastrophic backtracking patterns |
| Privilege Escalation | None | unsafeWindow used for one read-only native call |
| Persistence | None | State in TM storage is session-like and user-clearable |
| **Overall** | **LOW RISK** | Operates entirely within matched Amazon internal domains |

**Recommendations for future versions:**
1. Add `@noframes` to prevent accidental execution inside iframes.
2. The `recentlyProcessed` list could include timestamps to auto-expire entries in
   very long sessions rather than relying on the 20-item window.
3. `destId` UUIDs are hardcoded -- consider adding a startup validation ping to
   confirm each destId is recognized before the shift begins.

