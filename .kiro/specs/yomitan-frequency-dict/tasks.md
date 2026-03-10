# Implementation Plan: Yomitan Frequency Dictionary

## Overview

Build a Yomitan-compatible frequency dictionary feature for GSM. Implementation proceeds bottom-up: builder class → API endpoints → UI → revision fix for existing character dict.

## Tasks

- [x] 1. Create FrequencyDictBuilder class
  - [x] 1.1 Create `GameSentenceMiner/util/yomitan_dict/freq_dict_builder.py` with `FrequencyDictBuilder` class
    - Implement `__init__` with `download_url` parameter, UNIX timestamp revision via `int(time.time())`
    - Implement `_create_index()` returning dict with title, revision, format 3, frequencyMode "occurrence-based", author, description, downloadUrl, indexUrl, isUpdatable
    - Implement `_build_entry(word, reading, count)` returning `[word, "freq", {"frequency": count, "reading": reading}]` when reading is non-empty, or `[word, "freq", count]` when reading is empty
    - Implement `build_from_db()` that queries `words` JOIN `word_occurrences` grouped by word_id, populates `self.entries`
    - Implement `export_bytes()` creating ZIP with `index.json` and `term_meta_bank_N.json` files (max 10,000 entries per file)
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 5.1, 5.2, 5.3, 6.1, 6.2, 6.3_

  - [x] 1.2 Export `FrequencyDictBuilder` from `GameSentenceMiner/util/yomitan_dict/__init__.py`
    - _Requirements: 1.1_

  - [x]* 1.3 Write property tests for FrequencyDictBuilder
    - Create `tests/util/yomitan_dict/test_freq_dict_builder_properties.py`
    - **Property 1: Round-trip serialization**
    - **Validates: Requirements 6.4**
    - **Property 2: Index metadata completeness**
    - **Validates: Requirements 1.3, 1.4, 1.5, 6.3**
    - **Property 3: Entry format correctness**
    - **Validates: Requirements 1.2, 5.2**
    - **Property 5: UNIX timestamp revision (frequency dictionary)**
    - **Validates: Requirements 3.1**
    - **Property 7: Entry chunking**
    - **Validates: Requirements 6.2**

  - [x]* 1.4 Write unit tests for FrequencyDictBuilder
    - Create `tests/util/yomitan_dict/test_freq_dict_builder.py`
    - Test `_build_entry` with empty reading produces simplified format
    - Test `build_from_db` excludes orphaned words with zero occurrences
    - Test `export_bytes` produces valid ZIP with correct file names
    - _Requirements: 1.2, 5.3, 6.1_

- [x] 2. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 3. Add frequency dictionary API endpoints
  - [x] 3.1 Add `/api/yomitan-freq-dict` and `/api/yomitan-freq-index` routes to `GameSentenceMiner/web/yomitan_api.py`
    - Import `is_tokenisation_enabled` from `GameSentenceMiner.util.config.feature_flags`
    - Import `FrequencyDictBuilder` from `GameSentenceMiner.util.yomitan_dict`
    - `/api/yomitan-freq-dict`: guard with tokenisation check, guard with empty data check, build dict, return ZIP with CORS headers
    - `/api/yomitan-freq-index`: guard with tokenisation check, return index JSON with CORS headers
    - _Requirements: 2.1, 2.2, 2.3, 2.4_

  - [x]* 3.2 Write unit tests for frequency API endpoints
    - Create `tests/web/test_yomitan_freq_api.py`
    - Test 404 when tokenisation disabled
    - Test 404 when no word data
    - Test successful ZIP download with correct Content-Type
    - Test index endpoint returns JSON with CORS headers
    - _Requirements: 2.1, 2.2, 2.3, 2.4_

- [x] 4. Update character dictionary to use UNIX timestamp revision
  - [x] 4.1 Modify `GameSentenceMiner/util/yomitan_dict/dict_builder.py`
    - Change `self.revision = revision or str(random.randint(100000000000, 999999999999))` to `self.revision = revision or str(int(time.time()))`
    - Add `import time` to imports
    - Remove unused `import random` if no other usages remain
    - _Requirements: 3.2_

  - [x]* 4.2 Write property test for character dictionary UNIX timestamp revision
    - Add to existing test file or create `tests/util/yomitan_dict/test_dict_builder_revision.py`
    - **Property 6: UNIX timestamp revision (character dictionary)**
    - **Validates: Requirements 3.2**

- [x] 5. Add frequency dictionary UI card to database.html
  - [x] 5.1 Add frequency dictionary card to `GameSentenceMiner/web/templates/database.html`
    - Add a new card in the `management-grid` div after the existing Yomitan character dictionary card
    - Include download button targeting `/api/yomitan-freq-dict`
    - Include a conditional message when tokenisation is not enabled (check via `/api/tokenisation/status` endpoint)
    - Add JS handler for download button with error handling (show alert on failure)
    - _Requirements: 4.1, 4.2, 4.3, 4.4_

- [x] 6. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Property tests use `hypothesis` library for Python property-based testing
- The `FrequencyDictBuilder` is intentionally a separate class from `YomitanDictBuilder` due to fundamentally different output formats
