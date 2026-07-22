# Anki Field Grouping: Implementation and Nagare Porting Notes

This document describes the field-grouping behavior implemented in
GameSentenceMiner (GSM), the compatibility contract expected by the Kiku note
type, and a concrete plan for adding the same feature to
[bpwhelan/Nagare](https://github.com/bpwhelan/Nagare).

The feature solves this workflow:

1. A miner creates a new Anki note for a word that already exists.
2. The user selects which existing note should survive.
3. Context fields from the new note are added to the selected original as a
   coordinated group.
4. The new duplicate is optionally deleted, but only after the original has
   been updated successfully.

The match field (the word/expression) is an identity field. It is used to find
duplicates and is **not** itself grouped.

## Kiku's grouping contract

Kiku's [field-grouping documentation](https://kiku.youyoumu.my.id/field-grouping.html)
uses a `data-group-id` HTML attribute to associate values belonging to the same
context. Text-like fields use a wrapper element, while pictures place the
attribute directly on the image:

```html
<span data-group-id="1712345678901">この文は新しい文脈です。</span>
```

```html
<img data-group-id="1712345678901" src="screenshot.webp">
```

The same group ID must be used for the sentence, sentence audio, screenshot,
translation, furigana, and any other values belonging to one context. Different
contexts must use different positive integer IDs.

Kiku orders groups by ID in descending order. A larger ID appears first. This
means the implementation cannot express front/back order by merely changing the
HTML concatenation order; it must allocate a group ID that sorts on the desired
side.

Kiku may render IDs that look like Unix timestamps between 2000 and 2100 as
dates. Anki note IDs are useful group IDs because they are normally unique and
roughly chronological, but code should treat them as opaque positive integers
rather than relying on the date rendering.

## User-visible behavior

Recommended settings and defaults:

| Setting | Default | Meaning |
| --- | --- | --- |
| Enable field grouping | `false` | Opt-in so existing mining behavior is unchanged. |
| Match field | Existing word field | Field used for duplicate detection. |
| New context order | `front` | Allocate the new group above existing groups. |
| Delete duplicate | `true` | Delete the newly created note after a successful merge. |
| Additional grouped fields | `SentenceTranslation`, `MiscInfo`, `Tag` | Text-like fields beyond the application's mapped media/context fields. |

When one or more exact duplicates are found, the confirmation UI should show:

- every eligible target note, including note ID and enough sentence/tag context
  to distinguish it;
- a front/back selector initialized from configuration;
- a delete-duplicate checkbox initialized from configuration;
- an explicit “keep as separate note” action.

The choice belongs to this merge operation. Changing it in the dialog should
not silently overwrite the saved defaults.

## Duplicate discovery

### Two-phase matching

Anki search is a candidate generator, not the final equality check.

1. Query `findNotes` with both the source note type and match field.
2. Exclude the new source note.
3. Fetch candidate data with `notesInfo`.
4. Verify note type and normalized match-field equality in application code.

GSM currently accepts only note IDs smaller than the source note ID. This keeps
the direction unambiguous: the freshly created note is the source and an older
note is the merge target. It also prevents another concurrently created note
from accidentally becoming the “original.” If imported notes or custom note IDs
are common, replace this heuristic with an explicit source-note identity or
creation-time policy.

### Normalization

GSM normalizes the match value by:

1. removing HTML and cloze markup;
2. decoding HTML entities;
3. removing whitespace;
4. applying Unicode-aware case folding.

The exact normalization policy is a product decision. Removing punctuation,
kana variation, or diacritics would create more matches but also increases the
risk of merging different words. Keep the first implementation conservative.

### Query escaping

Escape at least quotes and backslashes when placing note type, field name, or
field value into an Anki search query. A representative query is:

```text
note:"Kiku" "Expression:食べる"
```

Do not interpolate untrusted field content into the query without escaping.
Even with correct escaping, always perform the exact application-side check;
Anki's search semantics can return broader results than intended.

### Candidate snapshot versus final target state

Candidate data is only for display. Re-fetch the chosen target with `notesInfo`
immediately before constructing the merged fields. Otherwise another edit or
merge made while the dialog was open can be overwritten.

## Group-ID allocation

Existing `data-group-id` values must be preserved. Only ungrouped content should
receive a new ID.

For each merge, first collect group IDs from every participating target and
source field. Then use this policy:

### Original target context

If the target contains ungrouped content, assign it the target note ID. Existing
grouped fragments retain their IDs.

### New context at the front

Choose an ID larger than every existing group:

```text
source_group_id = max(source_note_id, largest_existing_group_id + 1)
```

Using the source note ID when possible makes the operation easier to recognize
and debug. The `max + 1` fallback handles pre-existing custom IDs larger than
the source note ID.

### New context at the back

Choose an ID smaller than every existing group:

```text
source_group_id = smallest_existing_group_id - 1
```

Group IDs must stay positive. If the smallest ID is already `1`, shift all
existing IDs upward by one and use `1` for the new back group. Apply the same
replacement map across every field so context alignment is not broken.

### Field-independent content, operation-wide IDs

A field may already be grouped while another field on the same note is still
ungrouped. Transform each field independently, but use the same target and
source group IDs everywhere.

## Safely transforming field HTML

### Text-like fields

Do not wrap an entire field if it already contains grouped fragments. That
would nest one group inside another and can make Kiku treat unrelated contexts
as a single context.

Instead, tokenize the HTML fragment and preserve any element that already has a
`data-group-id`. Wrap only ungrouped runs that contain visible text:

```html
Before:
old prefix
<span data-group-id="20">already grouped</span>
old suffix

After (target group 10):
<span data-group-id="10">old prefix</span>
<span data-group-id="20">already grouped</span>
<span data-group-id="10">old suffix</span>
```

Whitespace-only runs should not receive empty wrappers. Preserve other markup
inside the wrapper, including `<b>`, `<ruby>`, and `[sound:...]` text.

A real HTML-fragment parser is preferable in a new implementation. If using a
small tokenizer, tests must cover nested tags, void elements, quoted `>`
characters, malformed fragments, and existing single- and double-quoted group
attributes. Avoid a single regex that attempts to parse arbitrary HTML.

### Picture fields

Add `data-group-id` directly to each ungrouped `<img>` element. Leave grouped
images unchanged. Do not wrap `<img>` in a span, because Kiku's picture grouping
expects the attribute on the image.

### Missing and custom fields

Build the update from the intersection of configured grouped fields and fields
that exist on the selected target note type. Skip empty source values. Sending
an unknown field to `updateNoteFields` can fail the entire update.

The logical `Tag` field and Anki note tags are different things. `Tag` can be a
grouped field; note tags must be copied with `addTags`.

## Merge sequencing and recovery

AnkiConnect does not provide a transaction spanning media storage, field
updates, tags, and deletion. The sequence must therefore make partial failure
safe and recoverable.

Recommended order:

1. Finish generating and storing media.
2. Update the new source note with its final sentence/audio/picture fields.
3. Re-fetch the selected target note.
4. Build the grouped target patch from the fresh target and final source data.
5. Call `updateNoteFields` on the target.
6. Copy ordinary tags to the target.
7. Run target-side post-update bookkeeping.
8. Delete the source note, if requested.
9. Save local history/database state using the surviving target note and card
   IDs.

Deleting must be the final destructive Anki step. If target update fails, the
source remains a complete usable note. If source deletion fails, the user has a
correct merged target plus a recoverable duplicate rather than lost context.

When copying note tags, exclude Anki-managed or stateful tags such as `leech`,
`marked`, and `potential_leech`. Deduplicate tags case-insensitively before
calling `addTags`.

### Idempotency is not optional

The most dangerous retry window is after the target update succeeds but before
the source is deleted or local history is saved. Re-running a naive merge can
append the source context twice.

Use a stable operation identity and make the target update idempotent. Possible
strategies are:

- use the source note ID as the source group ID and detect that ID on the target
  before appending;
- persist `{source_note_id, target_note_id, source_group_id, phase}` locally and
  resume from the last successful phase;
- attach a separate stable merge-operation marker if group-ID allocation needed
  `largest + 1` instead of the source note ID.

If the target already contains the operation's source group, skip field
appending and resume at tag copying/deletion. Do not infer completion from one
arbitrary field alone; check all non-empty source fields or the persisted phase.

GSM currently does not persist a merge phase or operation marker. A process
failure in this narrow target-updated/source-not-deleted window is therefore a
known hardening opportunity in GSM as well as an important requirement for a
fresh Nagare implementation.

## GSM implementation map

The current GSM implementation is split by responsibility:

- [`GameSentenceMiner/anki.py`](../GameSentenceMiner/anki.py) performs candidate
  discovery, exact filtering, group transformation, target updates, tag copying,
  deletion, and surviving-note bookkeeping.
- [`GameSentenceMiner/ui/anki_field_grouping_qt.py`](../GameSentenceMiner/ui/anki_field_grouping_qt.py)
  provides the per-duplicate decision dialog, including selection among multiple
  existing notes.
- [`GameSentenceMiner/ui/config/tabs/anki.py`](../GameSentenceMiner/ui/config/tabs/anki.py)
  builds the dedicated Field Grouping configuration tab.
- [`GameSentenceMiner/util/config/configuration.py`](../GameSentenceMiner/util/config/configuration.py)
  defines opt-in defaults and normalizes order/additional-field settings.
- [`tests/test_anki.py`](../tests/test_anki.py) covers matching, ordering, merge
  sequencing, deletion, and the disabled path.
- [`tests/ui/test_anki_field_grouping_qt.py`](../tests/ui/test_anki_field_grouping_qt.py)
  covers target selection and dialog defaults.

GSM first updates the new note normally, then merges its completed fields into
the chosen original. Subsequent notifications and local database links use the
surviving target note ID. If the user elects to retain the duplicate, both note
IDs are included in the incremental cache sync.

## Nagare porting plan

The links below describe Nagare's `main` branch as inspected in July 2026. Check
for drift before implementing.

### 1. Configuration model

Add a nested field-grouping config to
[`src/config.rs`](https://github.com/bpwhelan/Nagare/blob/main/src/config.rs):

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FieldGroupingConfig {
    #[serde(default)]
    pub enabled: bool,

    // Required when enabled. Examples: "Expression" or "Word".
    #[serde(default)]
    pub match_field: String,

    #[serde(default)]
    pub order: FieldGroupingOrder,

    #[serde(default = "default_true")]
    pub delete_duplicate: bool,

    #[serde(default = "default_grouped_fields")]
    pub additional_fields: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FieldGroupingOrder {
    #[default]
    Front,
    Back,
}
```

Add `#[serde(default)] pub field_grouping: FieldGroupingConfig` to `AnkiConfig`
and populate it in `Default for AnkiConfig`. Nagare persists configuration as
JSON in SQLite, so serde defaults are required for existing installations.

Nagare's current `AnkiFieldMapping` has sentence, sentence audio, picture,
optional source name, and optional sentence translation mappings, but no
word/expression mapping. Do not guess a universal field name. Either add a
dedicated `match_field` as shown above or add an explicit word mapping and make
the enabled-state validation reject an empty value.

The standard grouped field set can be assembled from Nagare's mapped sentence,
sentence-audio, picture, source, and translation fields plus the configured
additional field names. The match field must be removed from that set even if a
user adds it accidentally.

### 2. AnkiConnect client

[`src/anki.rs`](https://github.com/bpwhelan/Nagare/blob/main/src/anki.rs)
already exposes `find_notes`, `notes_info`, `update_note_fields`, `add_tags`, and
`find_cards_for_note`. Add a small deletion wrapper:

```rust
pub async fn delete_notes(&self, note_ids: &[i64]) -> Result<()> {
    self.invoke(
        "deleteNotes",
        serde_json::json!({ "notes": note_ids }),
    )
    .await?;
    Ok(())
}
```

Keep candidate search and merge assembly in a higher-level service rather than
growing the transport client into a workflow object. Useful new domain types:

```rust
pub struct FieldGroupingCandidate {
    pub note_id: i64,
    pub sentence: String,
    pub model_name: String,
    pub tags: Vec<String>,
}

pub struct FieldGroupingDecision {
    pub target_note_id: i64,
    pub order: FieldGroupingOrder,
    pub delete_duplicate: bool,
}
```

### 3. Candidate loading without slowing card detection

Nagare deliberately queues its enrichment dialog before backfilling card IDs so
an AnkiConnect lookup does not block the notification path. Preserve that
property.

Two reasonable designs are:

1. add a lazy endpoint such as
   `GET /api/anki/field-grouping/candidates/{note_id}` and load the candidates
   when the enrichment dialog opens; or
2. add `field_grouping_candidates` to `EnrichmentDialogState`, initially empty,
   then populate it in an out-of-band task similar to the current card-ID
   backfill.

The lazy endpoint is simpler to retry and gives the UI an explicit loading/error
state. The backend should fetch the source with `notesInfo` rather than trusting
field HTML sent back by the browser.

AnkiBeacon's push payload can avoid a source-note lookup when it includes full
note data, but duplicate discovery still requires AnkiConnect. Polling and push
events should share the same backend candidate-search function.

### 4. Enrichment dialog and request payload

Add the selection UI to
[`frontend/src/lib/EnrichDialog.svelte`](https://github.com/bpwhelan/Nagare/blob/main/frontend/src/lib/EnrichDialog.svelte).
Nagare's dialog already assembles a payload in `handleConfirm` and closes before
the serialized background job runs. Add nullable fields to that payload:

```js
{
  mergeTargetNoteId: selectedCandidate?.note_id ?? null,
  groupingOrder,
  deleteDuplicate,
}
```

Then pass them through
[`frontend/src/lib/api.js`](https://github.com/bpwhelan/Nagare/blob/main/frontend/src/lib/api.js)
as snake_case JSON fields on `/api/enrich`.

Add corresponding optional fields to `EnrichRequest` in
[`src/api.rs`](https://github.com/bpwhelan/Nagare/blob/main/src/api.rs). Treat a
missing target as “keep separate.” Validate on the backend that the selected ID
is still in the freshly computed eligible candidate set; a browser-provided
note ID is not authorization to overwrite an arbitrary note.

Auto-approve needs a policy. The safest initial behavior is to suppress
auto-approval when duplicates exist, because choosing among multiple originals
requires user intent. If only one candidate exists, an optional future setting
could auto-merge using configured defaults.

### 5. Settings UI

Add controls to
[`frontend/src/lib/ConfigPage.svelte`](https://github.com/bpwhelan/Nagare/blob/main/frontend/src/lib/ConfigPage.svelte).
Nagare currently groups settings under broad tabs, so a “Field Grouping” section
inside “Anki & Media” fits its existing organization; a separate top-level tab
is also reasonable if more controls are added.

Update `normalizeConfig()` as well as the rendered controls. Without frontend
defaults, an older saved config can produce undefined bindings even though Rust
deserializes it correctly.

Recommended validation:

- grouping cannot be enabled with an empty match field;
- order is only `front` or `back`;
- trim, remove empties, and deduplicate additional fields;
- warn when the match field is also in additional fields;
- defaults remain `front` and delete enabled.

### 6. Backend enrichment sequence

The integration point is `perform_enrichment` in `src/api.rs`, after Nagare has
generated/stored media and constructed the final field map.

After updating the source, either re-fetch it with `notesInfo` or combine the
final field patch with a fresh source snapshot. Re-fetching is simplest and
ensures custom additional fields are included alongside the newly generated
media fields.

Suggested structure:

```rust
let source_note_id = req.note_id;

// Existing behavior: make the new note complete first.
anki.update_note_fields(source_note_id, source_fields, None, None).await?;

let surviving_note_id = if let Some(decision) = validated_decision {
    let fresh_target = exactly_one(anki.notes_info(&[decision.target_note_id]).await?)?;
    let patch = build_grouped_patch(&source, &fresh_target, &decision, &config)?;
    anki.update_note_fields(decision.target_note_id, patch, None, None).await?;
    copy_safe_tags(&anki, &source, decision.target_note_id).await?;

    if decision.delete_duplicate {
        anki.delete_notes(&[source_note_id]).await?;
    }
    decision.target_note_id
} else {
    source_note_id
};
```

Keep this work in Nagare's existing serialized enrichment queue. Splitting one
merge across independent frontend requests introduces races and makes recovery
more difficult.

Decide whether a tag-copy failure is fatal before deletion. Treating it as fatal
is safer: retain the source and let the whole merge be retried. Nagare currently
logs some tag failures and continues; field grouping may need stricter behavior
because deletion follows.

### 7. Mining history and card IDs

[`src/mining.rs`](https://github.com/bpwhelan/Nagare/blob/main/src/mining.rs)
stores `note_id`, `card_ids`, and a copy of the original `NewCardEvent`. If the
source is deleted, saving those original identifiers creates broken “open in
Anki” behavior.

After a merge:

1. set history `note_id` to the surviving target ID;
2. fetch the target's card IDs with `find_cards_for_note`;
3. update the stored event's `note_id` or add explicit `source_note_id` and
   `target_note_id` fields;
4. make history re-enrichment target the surviving note without duplicating the
   previously merged group.

Keeping `source_note_id` separately is useful for audit/debugging, but it must
not be used for navigation once the source has been deleted.

### 8. Skip-filter interaction

Nagare can skip notes when audio or picture already exists. Duplicate detection
must happen before that decision, or field grouping must override the
media-complete skip. Otherwise a newly added duplicate that already contains
Yomitan-generated media may never reach the merge UI.

Ignore/require tag filters and note-type filters should still apply. A disabled
grouping feature must preserve the current fast path exactly.

## Error-handling expectations

| Failure | Expected result |
| --- | --- |
| `findNotes` or `notesInfo` fails during discovery | Show non-fatal search error; allow normal separate-note enrichment. |
| Candidate disappears before confirmation | Reject the merge and keep the completed source note. |
| Source media/update fails | Do not touch the target. |
| Target field update fails | Keep the completed source; do not delete it. |
| Tag copy fails | Prefer keeping the source and reporting a retryable failure. |
| Source deletion fails | Keep merged target and source; report cleanup needed. |
| Local history save fails after deletion | Reconstruct from target; persisted merge phase should make this recoverable. |
| Same merge is retried | Detect prior source group and do not append a second copy. |

Media copied to Anki before a later failure may be left orphaned. That is
usually safer than attempting automatic media deletion, because the file may be
referenced by another note.

## Test matrix

### Candidate discovery

- disabled feature makes no extra AnkiConnect calls;
- empty/missing match field produces no candidates;
- query escapes quotes and backslashes;
- source note is excluded;
- different note type is excluded;
- approximate Anki result is rejected by exact normalized comparison;
- one and multiple exact candidates are returned with display context;
- candidate deleted while dialog is open is handled safely.

### HTML transformation

- ungrouped sentence, audio, translation, furigana, and custom fields;
- one and multiple ungrouped images;
- already grouped source and target fragments remain unchanged;
- mixed grouped and ungrouped HTML avoids nested groups;
- nested/void/malformed HTML is preserved as safely as possible;
- empty and whitespace-only fields are skipped;
- configured field absent from target is skipped;
- match field is never grouped.

### Ordering

- front allocation with plain target;
- front allocation when an existing custom ID exceeds the source note ID;
- back allocation with ordinary IDs;
- back allocation when the smallest ID is `1`;
- remapped IDs stay aligned across every field;
- all generated IDs are positive integers.

### Workflow and recovery

- user keeps note separate;
- user chooses each target among multiple candidates;
- default order/delete settings initialize the dialog;
- target is re-fetched immediately before update;
- target update occurs before source deletion;
- target failure retains source;
- deletion is skipped when requested;
- safe tags copied and Anki-managed tags excluded;
- retry after target update is idempotent;
- history, notifications, and card links use the surviving target ID;
- auto-approve does not bypass a required multiple-target choice.

## Practical implementation checklist

- [ ] Feature is opt-in and backward-compatible with stored config.
- [ ] Match field is explicit and validated.
- [ ] `findNotes` results receive exact application-side verification.
- [ ] Multiple targets are presented to the user.
- [ ] Target selection is validated again on the backend.
- [ ] Existing group IDs are preserved.
- [ ] Text and picture fields use the correct markup form.
- [ ] Front/back is implemented through sortable IDs, not only DOM order.
- [ ] Target is re-fetched just before merge construction.
- [ ] Source is complete before target is changed.
- [ ] Source deletion is last and optional.
- [ ] Merge retry is idempotent.
- [ ] Local history points to the surviving note/card IDs.
- [ ] Media-complete skip logic does not hide merge candidates.
- [ ] Unit, UI, integration, and failure-path tests cover the matrix above.
