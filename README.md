# RSR+ Outbound Dropzone v2

A Tampermonkey userscript that automates the **Sort Center Rodeo → Move (Dropzone)** workflow at Amazon FCs. The script reads the ManifestPending queue from Rodeo, converts each SP00 to a Sort Center container ID, and automatically scans it into the designated Dropzone destination on the Move page — no manual barcode scanning required.

---

## One-Click Install

> Requires [Tampermonkey](https://www.tampermonkey.net/) installed in Firefox (no admin access needed).

**[⬇ Install RSR+ Outbound Dropzone v2](https://raw.githubusercontent.com/youngryan521/RSR-Outbound-Trickle-Automation/RSR-DROPZONE-AUTOMATION/rsr-dropzone-v2.user.js)**

Click the link above in Firefox with Tampermonkey installed — it will intercept the `.user.js` file and show an install prompt. Click **Install**.

### Manual Install (if the prompt does not appear)

1. Open the raw link above in Firefox
2. Select all (`Ctrl+A`) → Copy (`Ctrl+C`)
3. Tampermonkey → Dashboard → `+` (New Script)
4. Select all placeholder text → Paste (`Ctrl+V`) → `File → Save`

### Keeping Up to Date

Tampermonkey checks for updates automatically once per day. To trigger a manual check: TM Dashboard → script row → Check for updates icon. Updates are pushed to the `RSR-DROPZONE-AUTOMATION` branch of this repo.

---

## How It Works

```
Rodeo (rodeo-iad.amazon.com)          GM Storage             Move Page (containermovement/)
-----------------------------          ----------             ------------------------------
fetchItems() polls                     action: idle     <--  loop() polls every 600ms
ManifestPending queue
for each CPT window                    action: pending  -->  submit():
                                       sp00 + destId         1. scan SP00 (container to move)
Assigned: spXxx -> SPXxx_001_v   -->                         2. wait 600ms (stabilize)
CPT: 02:00                                                   3. scan Dropzone destId
                                       action: done    <--   success: page leaves dest step
Rodeo increments ok count,
picks next item
```

**Two tabs must be open simultaneously:**
- One on any `rodeo-iad.amazon.com` page (Rodeo side runs here)
- One on `sortcenter-menu-na.amazon.com/containermovement/` (Move side runs here)

The script auto-detects which page it is on and runs the correct side.

---

## SP00 Conversion

Rodeo uses lowercase IDs (`spXxxxxxxxx`). Sort Center Move expects a different format:

```
Rodeo ID:   spPkvHjT9pT
Move ID:    SPPkvHjT9pT_001_v

Rule: 'SP' + id.slice(2) + '_001_v'
      (drop lowercase 'sp', prefix uppercase 'SP', append '_001_v')
```

---

## CPT Windows & Dropzone Destination

All three CPT windows route to the same Dropzone destination ID:

| CPT | Dropzone Destination ID |
|---|---|
| 14:30 CDT | `4ccd5e2a-9e00-3f03-1880-768b589f8210` |
| 22:00 CDT | `4ccd5e2a-9e00-3f03-1880-768b589f8210` |
| 02:00 CDT | `4ccd5e2a-9e00-3f03-1880-768b589f8210` |

CPT windows are fetched with a 1-minute ExSD range centered on each cutoff. The script always picks the next upcoming CPT (never a past window). Priority order: 14:30 → 22:00 → 02:00.

---

## Reading the Console

Open DevTools (`F12`) on either tab to see live status.

### Rodeo tab

| Log | Meaning |
|---|---|
| `[DZ+][Rodeo] Loop started` | Rodeo side is alive |
| `[DZ+][Rodeo] CPT 02:00 -- rows found: 5 \| available: 5` | 5 items found, none filtered |
| `[DZ+][Rodeo] Assigned: spXxx -> SPXxx_001_v \| CPT: 02:00` | Item dispatched to Move side |
| `[DZ+][Rodeo] CPT 02:00 -- rows found: 0` | Queue empty for this window |
| `[DZ+][Rodeo] Cooldown for spXxx (error #1)` | Item failed, retrying in 5 min |
| `[DZ+][Rodeo] Permanent skip after 3 errors: spXxx` | Item rejected 3x, skipped forever |

### Move tab

| Log | Meaning |
|---|---|
| `[DZ+][Move] Loop started` | Move side is alive |
| `[DZ+][Move] Idle -- waiting for Rodeo. action: idle` | No pending items (normal) |
| `[DZ+][Move] Step 1: scanning SP00: SPXxx_001_v` | Scanning the container to move |
| `[DZ+][Move] Scanning destId: 4ccd5e2a...` | Scanning the Dropzone destination |
| `[DZ+][Move] Move accepted` | Success — container moved |
| `[DZ+] SUCCESS: SPXxx_001_v` | Confirmed, Rodeo notified |
| `[DZ+] Step 1 rejected` | SP00 unrecognized — added to skip list |
| `[DZ+] FAILED: SPXxx_001_v` | destId scan failed — 5-min cooldown applied |

---

## Error Handling

| Situation | Script response |
|---|---|
| SP00 not recognized by Move (step 1 fail) | Permanent skip — never retried |
| Destination not open / container closed | Wait 45 s, then fail back to Rodeo for 5-min cooldown |
| Any other rejection at dest step | Rodeo applies 5-min cooldown |
| 3 consecutive errors on same item | Permanent skip |
| Items oscillating (A→B→A→B loop) | `recentlyProcessed[]` list (last 20 IDs) prevents re-picking |
| Script crashes / unexpected exception | Loop try-catch recovers automatically within 2 s |

---

## Do Not Run Both Scripts Simultaneously

This script shares the same Rodeo queue (`ManifestPending`) with **RSR+ Outbound Trickle v2**. Running both at once will cause them to race over the same items. Keep only one enabled at a time in Tampermonkey.

| Script | Destination | TM Storage Key |
|---|---|---|
| RSR+ Outbound Trickle v2 | Sort Center Trickle (CART) | `rsr_v2` |
| RSR+ Outbound Dropzone v2 | Sort Center Move (Dropzone) | `rsr_dropzone_v2` |

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

### MITRE ATT&CK Analysis

All 33 MITRE ATT&CK techniques in the report show **0 malicious** and **0 suspicious** hits. The informative hits are generated by the Windows + Firefox runtime environment the sandbox runs inside, not by the userscript itself.

| Technique | Why it appears | From this script? |
|---|---|---|
| T1059.007 — JavaScript | File is JavaScript | Expected for any `.js` |
| T1082 — System Info Discovery (8x) | Browser reads OS/screen info at startup | No |
| T1083 — File/Directory Discovery (4x) | Browser reads profile/cache paths | No |
| T1012 — Query Registry (4x) | Browser reads registry for its own settings | No |
| T1129 — Shared Modules (4x) | Browser loads system DLLs | No |
| T1057 — Process Discovery (3x) | Sandbox monitoring tools | No |
| T1027 — Obfuscated Files (3x) | Sandbox's own compression detection | No |
| T1106 — Native API (3x) | Browser system calls | No |
| T1113 — Screen Capture | Sandbox takes screenshots of session | No |
| T1573 — Encrypted Channel | HTTPS connections made by the browser itself | No |
| T1071 — Application Layer Protocol | Browser network stack | No |
| T1558 — Kerberos Tickets | Windows Kerberos subsystem always present | No |
| T1003 — Credential Dumping | LSASS present in Windows process list | No |

### Complete External Interaction Audit

**Network**
- One outbound request type: `fetch()` to `rodeo-iad.amazon.com/QIW9/ItemList` (internal Amazon URL, authenticated via browser session cookies)
- No external URLs, no third-party calls, no data transmitted off-network

**GM Storage**
- Writes to one key: `rsr_dropzone_v2`
- Stores: `{ sp00, rawId, destId, cpt, action, skipList, cooldowns }` — routing identifiers only
- No personal data, no credentials, no Amazon account information

**DOM**
- Reads `#sd_message` and `#infodisplay` text to detect page state
- Writes to `#sd_input` and dispatches scan events via `sd.receivedScanEvent()` — the same API the physical barcode scanner uses
- No `innerHTML` assignments, no script injection

**URL scope**
- Restricted to `rodeo-iad.amazon.com/*` and `sortcenter-menu-na.amazon.com/containermovement/*`
- Does not run on any other page or domain

---

## Version History

| Version | Change |
|---|---|
| 1.0.0 | Initial release — fork of RSR+ Trickle v2.17.3 targeting Move page |
| 1.0.1 | Updated `@match` and entry point to `containermovement` URL |

---

## Related

- **[RSR+ Outbound Trickle v2](https://github.com/youngryan521/RSR-Outbound-Trickle-Automation/tree/main)** — routes ManifestPending items to Sort Center Trickle (CART) instead of Dropzone
