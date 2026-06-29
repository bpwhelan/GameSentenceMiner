# SonarQube (SonarCloud) — agent guide

How to read GSM's SonarCloud analysis and turn it into fixes. Written for future agents.

## What's set up

- **Backend:** SonarQube Cloud (`https://sonarcloud.io`)
- **Org:** `beangate`
- **Project key:** `bpwhelan_GameSentenceMiner`
- **Analysis source:** SonarCloud Automatic Analysis (no scanner step in CI). Pushing to a branch /
  opening a PR refreshes analysis automatically. Scope is configured in `.sonarcloud.properties` at
  the repo root — **Automatic Analysis reads `.sonarcloud.properties`, NOT `sonar-project.properties`**
  (the latter is only for CI-based scanner runs).

## Two ways in

### 1. MCP server (preferred when it loads)

The SonarSource MCP server runs in Docker and is registered with Claude Code as `sonarqube`.
Config lives in `~/.claude.json` under this project's `mcpServers` (added with `claude mcp add`).
It runs:

```
docker run --init --pull=always -i --rm -e SONARQUBE_TOKEN -e SONARQUBE_ORG mcp/sonarqube
```

Recommended hardening (set these in the MCP `env`):
- `SONARQUBE_READ_ONLY=true` — agents read reports but can't change issue/hotspot status.
- `SONARQUBE_PROJECT_KEY=bpwhelan_GameSentenceMiner` — default project for the tools.

**Gotchas:**
- The token is a SonarCloud *user* token (My Account → Security). Treat it as a secret — never
  paste it into chat, commits, or this doc. If it leaks, revoke + regenerate.
- MCP tools register at **session start**. If `mcp__sonarqube__*` tools aren't available, fully
  restart the IDE/extension (a conversation reset is not enough). Verify the server with
  `claude mcp list` — it should print `sonarqube … ✓ Connected`.

**Useful tools** (server exposes ~25; these are the ones you'll reach for):
- `search_my_sonarqube_projects` — find the project key.
- `get_project_quality_gate_status` — pass/fail + which conditions failed.
- `get_component_measures` — bugs / vulnerabilities / code_smells / security_hotspots / coverage /
  duplicated_lines_density / ratings.
- `search_sonar_issues_in_projects` — the workhorse; filter by `severities`, `types`,
  `languages`, `rules`, `files`. Use facets to summarize before pulling individual issues.
- `search_security_hotspots`, `show_security_hotspot` — hotspot review.
- `show_rule` — what a rule (e.g. `python:S930`) means and how to fix it.

### 2. REST API fallback (when MCP tools aren't loaded in-session)

Same data, no session restart needed. Token via env var — **do not inline it**.

```bash
TOK="$SONAR_TOKEN:"   # trailing colon = empty password (token-as-username basic auth)
BASE="https://sonarcloud.io/api"
PROJ="bpwhelan_GameSentenceMiner"

# Overview
curl -s -u "$TOK" "$BASE/measures/component?component=$PROJ&metricKeys=bugs,vulnerabilities,code_smells,security_hotspots,duplicated_lines_density,reliability_rating,security_rating,alert_status"

# Issue facets (counts by severity / type / language / rule / file)
curl -s -u "$TOK" "$BASE/issues/search?componentKeys=$PROJ&resolved=false&ps=1&facets=severities,types,languages,rules"

# Drill into one rule with file:line
curl -s -u "$TOK" "$BASE/issues/search?componentKeys=$PROJ&resolved=false&rules=python:S930&ps=50"

# Security hotspots
curl -s -u "$TOK" "$BASE/hotspots/search?projectKey=$PROJ&ps=50"
```

## Triage workflow

1. **Measures + quality gate** for the headline state.
2. **Facet by `rules`** (not raw issues) within a `severities`/`types`/`languages` filter — one rule
   usually maps to one mechanical fix repeated N times.
3. **Filter to first-party code.** Most js/ts/web/css issues live in **vendored / generated** trees;
   fixing them causes upstream drift and is usually wasted effort. Deprioritize:
   - `GameSentenceMiner/owocr/**` (vendored OwOCR fork; `*_upstream.py` especially)
   - `GameSentenceMiner/mecab/**`
   - `GSM_Overlay/yomitan/**` (built output — edit `yomitan-gsm` source instead)
   - `texthooker/**` (vendored Svelte), `node_modules/**`, `.venv/**`, `dist/**`
4. **Confirm before fixing.** Open the file:line and verify the finding is real — Sonar flags real
   bugs but also false positives. The fixes below were each read and confirmed.
5. **Verify the fix.** Run the relevant tests (`.\.venv\Scripts\python.exe -m pytest …`), then push
   the branch / open the PR so Automatic Analysis re-scans; recheck the quality gate.

## High-leverage recommendation: narrow the analysis scope

~60% of issues are in vendored/generated code and inflate the counts (js 1421, ts 873, web 272 are
mostly yomitan + texthooker + owocr). This is handled by `.sonarcloud.properties` (`sonar.exclusions`
for the vendored trees above), which makes the dashboard reflect *GSM's own* code. Re-scan after the
next push to a branch to see the reduced counts.
