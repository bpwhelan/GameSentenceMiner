# Jiten Upgrader VNDB Lookup Bug Fix

## Issue Summary

The Jiten Upgrader is failing to find games that exist on Jiten.moe when looking up by VNDB ID. All games report "Not found on Jiten" even though they exist.

**Root Cause:** The code incorrectly strips the 'v' prefix from VNDB IDs before making API calls, but the Jiten API requires the prefix.

## Bug Location

**File:** [`GameSentenceMiner/util/jiten_api_client.py`](../GameSentenceMiner/util/jiten_api_client.py:326)

**Lines 326-328:**
```python
clean_id = external_id
if link_type == JitenLinkType.VNDB and external_id.startswith('v'):
    clean_id = external_id[1:]  # Remove 'v' prefix  <-- BUG!
```

## Evidence

### API Testing Results

| VNDB ID | API URL | Response |
|---------|---------|----------|
| STEINS;GATE | `/by-link-id/2/v2002` | `[283]` ✅ Found |
| STEINS;GATE | `/by-link-id/2/2002` | `[]` ❌ Empty |

The Jiten API **requires** the 'v' prefix for VNDB IDs.

### Documentation Shows Correct Format

From [`plans/link_type_reference.md`](../plans/link_type_reference.md:46):
```
VNDB: `by-link-id/2/v17` (Steins;Gate)
```

The documentation correctly shows the 'v' prefix should be included.

## Fix Required

### Remove the 'v' prefix stripping logic

**Before:**
```python
@classmethod
def get_deck_by_link_id(cls, link_type: int, external_id: str) -> List[int]:
    try:
        # Clean the external_id - some IDs may have prefixes like 'v' for VNDB
        # The API expects just the numeric part for most services
        clean_id = external_id
        if link_type == JitenLinkType.VNDB and external_id.startswith('v'):
            clean_id = external_id[1:]  # Remove 'v' prefix
        
        url = f"{cls.BASE_URL}/by-link-id/{link_type}/{clean_id}"
```

**After:**
```python
@classmethod
def get_deck_by_link_id(cls, link_type: int, external_id: str) -> List[int]:
    try:
        # Use the external_id as-is
        # For VNDB, the 'v' prefix must be preserved (e.g., "v2002")
        url = f"{cls.BASE_URL}/by-link-id/{link_type}/{external_id}"
```

## Implementation Steps

1. **Edit [`jiten_api_client.py`](../GameSentenceMiner/util/jiten_api_client.py:326)**
   - Remove lines 326-328 that strip the 'v' prefix
   - Update the comment to clarify the 'v' prefix requirement

2. **Update documentation comment**
   - Fix the misleading comment that says "The API expects just the numeric part"

3. **Test the fix**
   - Run `python -m GameSentenceMiner.util.cron.jiten_upgrader`
   - Verify STEINS;GATE and other VNDB games are now found

## Impact

- **Affected:** All VNDB-based game lookups in the Jiten Upgrader
- **Severity:** High - feature completely broken for VNDB games
- **AniList lookups:** Not affected - they use numeric IDs without prefixes

## Testing

After the fix, running the Jiten Upgrader should show:

```
[1/5] Checking: STEINS;GATE
  ✅ Upgraded to Jiten deck_id=283
```

Instead of the current:

```
[1/5] Checking: STEINS;GATE
  ⏭️ Not found on Jiten
```
