# RSR+ Outbound Trickle v2

**Author:** youryanh  
**Current Version:** 2.12.0  
**Last Updated:** 2026-06-18

Tampermonkey userscript that automates the Amazon Sort Center outbound trickle workflow.
It reads SP00 containers from the Rodeo `ManifestPending` work pool, converts them to the
Trickle barcode format, and submits them to the Sort Center Containerization app — all
without manual scanning.

---

## How It Works

The script runs on two browser tabs simultaneously and communicates through Tampermonkey's
shared `GM_setValue` / `GM_getValue` storage (single-script, so they share a bucket).

```
RODEO TAB                              TRICKLE TAB
  |                                       |
  | fetch ManifestPending (per CPT)       |
  | sort by dwell time (oldest first)     |
  | convert SP00: spPxxxxxx -> SPxxxxxx_001_v
  | write state: action='pending'         |
  |                                    reads state
  |                                    reset to "Scan container to move"
  |                                    scan SP00 (step 1)
  |                                    scan destId (step 2)
  |                                    write state: action='done' | 'error' | 'step1_fail'
  | reads state                           |
  | update counters                       |
  | clear action='idle'                   |
  | pick next item                        |
```

### State Machine

```
idle -> pending (Rodeo assigns item)
pending -> done        (Trickle: step 1 + step 2 both succeed)
pending -> error       (Trickle: all destIds failed -- container closed)
pending -> step1_fail  (Trickle: SP00 not recognized by Trickle system)

done       -> idle (Rodeo clears, increments ok counter)
error      -> idle (Rodeo clears, sets 5-min cooldown on rawId, increments err counter)
step1_fail -> idle (Rodeo clears, adds rawId to permanent skipList, increments err counter)
```

---

## Installation

1. Install [Tampermonkey](https://www.tampermonkey.net/) in Firefox.
2. Open Tampermonkey dashboard -> New Script.
3. Paste the contents of `rsr-trickle-v2.user.js` (or install from the @updateURL).
4. Open both tabs:
   - `https://rodeo-iad.amazon.com/QIW9/ItemList?...`
   - `https://sortcenter-menu-na.amazon.com/containerization/trickle`
5. In the Trickle tab, complete the manual session setup:
   job type -> station ID -> skip scale -> continue hazmat -> "Scan container to move"
6. The script starts automatically once both pages load.

---

## Configuration

All configuration is at the top of the script:

```js
const FC_UTC_OFFSET_H = -5;   // Timezone: CDT = UTC-5. Change for other FCs.
const COOLDOWN_MS = 5 * 60000; // 5 min retry delay when all containers are closed

const CPTS = [
  { label: '14:30', h: 14, m: 30, destId: '1ccd5e27-2a40-59cf-37e1-3b880c243e57' },
  { label: '22:00', h: 22, m:  0, destId: 'f6cd5e27-2a42-e873-aa17-be5ebb0539d6' },
  { label: '02:00', h:  2, m:  0, destId: 'aacd5e27-2a4c-7d53-fc04-093007fe0f5c' },
];
```

**To find a destId:** Go to the Trickle app, manually scan the physical cart barcode at
the "Scan destination id" step, then check the browser console. The UUID-format barcode
that the app accepts is your destId.

**CPT priority:** CPTs are tried in the order listed. Items are sorted by dwell time
(oldest first) within each CPT bucket.

---

## SP00 Format Conversion

| Rodeo Format | Trickle Format |
|---|---|
| `spPkvHjT9pT` | `SPkvHjT9pT_001_v` |
| `spPfmBQk9tT` | `SPfmBQk9tT_001_v` |
| `spPvjrchzxT` | `SPvjrchzxT_001_v` |

Rule: `'SP' + rawId.slice(3) + '_001_v'`

Items with prefixes other than `spP` (e.g. `spR`) are auto-detected as invalid after one
rejection and added to the permanent skip list.

---

## Session State Schema

Stored in Tampermonkey storage under key `rsr_v2`:

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

To reset session state (clear skip list, cooldowns, counters):
Open Tampermonkey storage editor and delete the `rsr_v2` key, or reload the Rodeo tab.

---

## Flash Bar (Trickle Tab)

A fixed status bar appears at the top of the Trickle tab:

| Color | Message | Meaning |
|---|---|---|
| Dark grey | `SP00: SPxxxxxxx_001_v` | Scanning step 1 |
| Dark blue | `DEST: aacd5e27-2a4c...` | Scanning step 2 |
| Orange | `CONTAINER NOT OPEN -- retrying in 45s` | Waterspider needed |
| Red | `SKIP: SPxxxxxxx_001_v` | SP00 not recognized (step 1 fail) |
| Dark red | `ALL DESTS FAILED SPxxxxxxx` | All 3 CPT containers unavailable |
| Green | `SUCCESS SPxxxxxxx_001_v` | Item moved |

---

## Version History

### v2.12.0 — 2026-06-18
**2-item oscillation fix + persistent infodisplay observer**

- **Fix (Rodeo):** `items.find(x => x.id !== s.rawId)` only excluded the single
  last-processed item, causing the two highest-dwell items (A, B) to oscillate
  forever (A→B→A→B). Items with lower dwell time were never reached.
  Fixed with `recentlyProcessed[]` (last 20 IDs). Every processed item (any outcome)
  is added. When all items in the queue have been recently processed, the list resets
  and the cycle restarts.
- **Fix (Trickle):** `capturedErr` approach in v2.11.0 missed brief error text that
  appeared and cleared before the MutationObserver predicate ran. Fixed with a
  dedicated `infoObs` MutationObserver attached to `#infodisplay` BEFORE the scan.
  All text values seen during the wait are collected into a `Set`. The full history
  is checked for error patterns after `waitFor` + 150ms grace period.
- **Log:** `[RSR+] infodisplay history: ...` now printed after every destId scan.

### v2.11.0 — 2026-06-18
**False success detection fix + always-reset before step 1**

- **Fix (Trickle):** After a BEEP, the Trickle page auto-resets to "Scan container
  to move". Old `if (!atDestStep()) return destId` fired TRUE on this reset and
  declared success. Items were never actually moved but marked `done`, staying in
  ManifestPending indefinitely.
  Fixed with `capturedErr` pattern: `waitFor()` predicate captures error text the
  moment it appears before the page can clear it.
- **Fix (Trickle):** `submit()` now always clicks `start_again` and waits for
  `atStart()` before scanning step 1. Removed the old "already at dest step, skip
  step 1" shortcut that caused stale-state false successes.
- **Refactor:** `tryScanDestId()` extracted as a named function returning
  `'success' | 'closed' | 'reject'` for cleaner logic flow.

### v2.10.0 — 2026-06-18
**CDT timezone bug fix + cooldown system**

- **Fix:** `nowCDT_h` was calculated as `utcH - FC_UTC_OFFSET_H` (wrong sign).
  At 11:32 PM CDT, this computed hour 9 instead of 23, breaking the next-day
  detection for the 02:00 CPT. Fixed: `utcH + FC_UTC_OFFSET_H`.
- **Fix:** After all destIds fail (containers closed), `action='error'` now sets a
  5-minute cooldown on the item's `rawId`. Rodeo skips cooled-down items and picks
  from other CPTs. Previously: infinite loop (error → Rodeo re-assigns same item
  immediately → error → ...).
- **New:** `cooldowns: {}` added to state. `fetchItems` filters out items with
  active cooldowns.

### v2.9.0 — 2026-06-18
**Skip list + already-scanned success + fast step-1 fail detection**

- **Fix (Rodeo):** Added `skipList: []` to state. When Trickle reports `step1_fail`,
  the item's `rawId` is permanently added to `skipList`. `fetchItems` filters out
  skip-listed items on all future polls. Prevents looping on SP00s that the Trickle
  system doesn't recognize (e.g. `spR` prefix items).
- **Fix (Trickle):** After scanning destId, if `#infodisplay` says "already scanned
  to Container", treat as success (not error). These items were already moved by a
  previous attempt that Trickle didn't confirm.
- **Fix (Trickle):** `waitFor` in `submit()` now resolves as soon as
  "wrong barcode / Scan correct SC" appears in `#infodisplay`, without waiting the
  full 6-second timeout.

### v2.8.0 — 2026-06-17
**Generalized SP00 conversion + container-not-open detection**

- **Fix:** `toTrickle()` generalized from `spP`-only pattern to all `spX` prefixes:
  `'SP' + id.slice(3) + '_001_v'` (skips `sp` + one namespace letter).
- **Fix:** `tryAllDestIds()` now detects "Container not open / See Waterspider" error
  in `#infodisplay`. On this error: wait 45 seconds, retry the SAME destId once.
  If still not open, fall through to the next CPT's destId.

### v2.7.0 — 2026-06-17
**Critical: page state detection fix**

- **Root fix:** `#sd_title` is always empty in the containerMovementManager app.
  All state detection was broken because the code read from `#sd_title`.
  Fixed: use `#sd_message` for all step heading checks.
  - `atStart()`: `/scan container to move/i.test(sdMsg())`
  - `atDestStep()`: `/scan destination/i.test(sdMsg())`
- Without this fix, the script never detected step transitions and no items were
  processed at all.

### v2.6.0 and earlier
- Initial architecture: single-tab cross-domain polling via GM storage
- Basic SP00 relay from Rodeo to Trickle
- `spP`-only SP00 conversion
- Hardcoded `#sd_title` for page state (broken)

---

## Troubleshooting

| Symptom | Likely Cause | Fix |
|---|---|---|
| Script does nothing | Trickle tab not set up manually | Complete job type → station ID → hazmat flow first |
| Orange bar stays on | Waterspider hasn't opened the container | Wait; the script retries automatically after 45s |
| Red `SKIP:` flash | SP00 not recognized by Trickle | Normal — item added to skip list, will be skipped |
| Dark red `ALL DESTS FAILED` | All CPT containers closed | Script sets 5-min cooldown; tries other items first |
| Script cycles through same 2 items | Old version (pre-v2.12.0) | Update to v2.12.0 |
| Wrong CPT assigned | Old version (pre-v2.10.0) | Update to v2.10.0 |

---

## Permissions

| Permission | Required For |
|---|---|
| `GM_setValue` / `GM_getValue` | Cross-tab state sync between Rodeo and Trickle |
| `unsafeWindow` | Access to `unsafeWindow.sd.receivedScanEvent` (Trickle's native scan handler) |

No external domains are accessed. All network requests go to `rodeo-iad.amazon.com`
(ManifestPending feed, credentials included via `fetch credentials: 'include'`).
