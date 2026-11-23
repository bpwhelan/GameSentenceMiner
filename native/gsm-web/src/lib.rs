//! Read-only HTTP report contracts. Database work and serialization run on the
//! gateway's blocking pool. Other routes continue through the compatibility server.
pub mod pages;
mod anki;
pub use anki::KanjiLookup;
mod goal_edit;
pub mod goal_progress;
mod stats_export;
pub mod tadoku;
pub mod kechimochi;
pub use stats_export::{ExportFile, ExportWork, export_formats};
mod archives;
pub use archives::ArchiveDownload;
mod library;
pub use library::{game_action_id, game_cover_route, game_edit_route, game_removal_route, Cover, GameEdit, GameRemoval, SceneOperation};
mod maintenance;
pub use maintenance::Maintenance;
mod maintenance_jobs;
pub use maintenance_jobs::{MaintenanceJob, ReservedMaintenance};
mod stats_settings;
mod reading_import;
mod mokuro;
mod kizuna;
mod exstatic;
pub use exstatic::ExStaticImport;
pub use reading_import::ReadingEdit;
pub mod yomitan_frequency;
mod yomitan_characters;
use chrono::{Local, NaiveDate, TimeZone, Timelike};
use gsm_history::{reports::*, History, ReportCleaner, Request, Result};
use percent_encoding::percent_decode_str;
use serde_json::{json, Value};
use std::{
    borrow::Cow,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::SystemTime,
};

#[derive(Debug, PartialEq)]
pub enum Route {
    StatsSettings,
    TadokuPreview,
    KechimochiPreview,
    KechimochiSettings,
    KechimochiStatus,
    GoalsDashboard,
    ActiveGoals,
    TodaysGoals,
    AchievedGoals,
    CharacterIndex,
    Dashboard,
    Overview,
    GoalsProjection,
    LatestGoals,
    CurrentGoals,
    GoalStreak,
    GoalReadingPace,
    CompleteDailies,
    DatabaseBackup,
    KanjiGrid,
    Milestones,
    MiningHeatmap,
    Today,
    AnkiEarliest,
    AnkiGames,
    AnkiRetention,
    AnkiHeatmap,
    AnkiSyncStatus,
    AnkiReadingImpact,
    AnkiCoverage,
    AnkiCombined,
    DailyActivity,
    KanjiFrequency,
    GameStats(String),
    GameKanji(String),
    GamesList,
    OrphanedGames,
    GamesManagement,
    DatabaseStatus,
    ImportedStats,
    ImportedStatsSummary,
    ArchivePreview(String),
    ArchiveFiles,
    Search,
    TokenStatus,
    Words,
    Kanji,
    WordSearch,
    WordDetail(String),
    CardData,
    WordsByGame,
    Maturity,
    MissingWords,
    ExportMissingWords,
}

/// Retired and standalone-only routes must stay unavailable through the
/// desktop gateway even when it forwards other requests to an older backend.
pub fn omitted_desktop_route(path: &str) -> bool {
    let decoded = percent_decode_str(path).decode_utf8_lossy();
    let path = decoded.trim_end_matches('/');
    matches!(
        path,
        "/clear_history" | "/api/debug-db" | "/api/docs" | "/apispec.json" | "/apidocs/index.html"
            | "/oauth2-redirect.html" | "/flasgger_static"
    ) || path.starts_with("/flasgger_static/")
}

impl Route {
    pub fn parse(path: &str) -> Option<Self> {
        use Route::*;
        Some(match path {
            "/api/settings" => StatsSettings,
            "/api/tadoku/preview" => TadokuPreview,
            "/api/kechimochi/preview" => KechimochiPreview,
            "/api/kechimochi/settings" => KechimochiSettings,
            "/api/kechimochi/status" => KechimochiStatus,
            "/api/goals/dashboard" => GoalsDashboard,
            "/api/goals/active" => ActiveGoals,
            "/api/goals/today" => TodaysGoals,
            "/api/goals/achieved" => AchievedGoals,
            "/api/stats" => Dashboard,
            "/api/stats/all-lines-data" => Overview,
            "/api/goals-projection" => GoalsProjection,
            "/api/goals/latest_goals" => LatestGoals,
            "/api/yomitan-index" => CharacterIndex,
            "/api/goals/current" => CurrentGoals,
            "/api/goals/current_streak" => GoalStreak,
            "/api/goals/reading-pace" => GoalReadingPace,
            "/api/stats/kanji-grid" => KanjiGrid,
            "/api/stats/game-milestones" => Milestones,
            "/api/today-stats" => Today,
            "/api/anki_earliest_date" => AnkiEarliest,
            "/api/anki_game_stats" => AnkiGames,
            "/api/anki_nsfw_sfw_retention" => AnkiRetention,
            "/api/anki_mining_heatmap" => AnkiHeatmap,
            "/api/anki_sync_status" => AnkiSyncStatus,
            "/api/anki-reading-impact" => AnkiReadingImpact,
            "/api/anki_kanji_stats" => AnkiCoverage,
            "/api/anki_stats_combined" => AnkiCombined,
            "/api/mining_heatmap" => MiningHeatmap,
            "/api/daily-activity" => DailyActivity,
            "/api/kanji-frequency" => KanjiFrequency,
            "/api/games-list" => GamesList,
            "/api/orphaned-games" => OrphanedGames,
            "/api/games-management" => GamesManagement,
            "/api/database/maintenance" => DatabaseStatus,
            "/api/database/archive-files" => ArchiveFiles,
            "/api/third-party-stats" => ImportedStats,
            "/api/third-party-stats/summary" => ImportedStatsSummary,
            "/api/search-sentences" => Search,
            "/api/tokenization/status" => TokenStatus,
            "/api/tokenization/words" => Words,
            "/api/tokenization/kanji" => Kanji,
            "/api/tokenization/search" => WordSearch,
            "/api/tokenization/words/card-data" => CardData,
            "/api/tokenization/words/by-game" => WordsByGame,
            "/api/tokenization/maturity-history" => Maturity,
            "/api/tokenization/words/not-in-anki" => MissingWords,
            "/api/tokenization/words/not-in-anki/export" => ExportMissingWords,
            _ => {
                if let Some(rest) = path.strip_prefix("/api/game/") {
                    let (id, action) = rest.split_once('/')?;
                    let id = percent_decode_str(id).decode_utf8().ok()?;
                    if id.is_empty() || id.contains('/') {
                        return None;
                    }
                    match action {
                        "stats" => GameStats(id.into_owned()),
                        "kanji-grid" => GameKanji(id.into_owned()),
                        _ => return None,
                    }
                } else if let Some(id) = path
                    .strip_prefix("/api/games/")
                    .and_then(|s| s.strip_suffix("/archive"))
                {
                    let id = percent_decode_str(id).decode_utf8().ok()?;
                    if id.is_empty() || id.contains('/') {
                        return None;
                    }
                    ArchivePreview(id.into_owned())
                } else {
                    let word = path.strip_prefix("/api/tokenization/word/")?;
                    if word.is_empty() || word.starts_with('/') {
                        return None;
                    }
                    WordDetail(percent_decode_str(word).decode_utf8().ok()?.into_owned())
                }
            }
        })
    }
}

fn goal_zone(timezone: Option<&str>) -> jiff::tz::TimeZone {
    timezone
        .and_then(|name| jiff::tz::TimeZone::get(name).ok())
        .unwrap_or(jiff::tz::TimeZone::UTC)
}

fn goal_date(timezone: Option<&str>) -> Result<NaiveDate> {
    let date = jiff::Timestamp::now().to_zoned(goal_zone(timezone)).date();
    Ok(
        NaiveDate::from_ymd_opt(date.year().into(), date.month() as u32, date.day() as u32)
            .ok_or("Invalid calendar day")?,
    )
}

struct Preferences {
    stats_settings: Value,
    anki_url: String,
    port: u16,
    anki_parent: String,
    note_type: String,
    word_field: String,
    rollover_hour: u32,
    gap: f64,
    streak_hours: f64,
    hours_target: i64,
    chars_target: i64,
    games_target: i64,
    hours_date: String,
    chars_date: String,
    games_date: String,
    cleaner: Option<ReportCleaner>,
    tokenization: bool,
    language: String,
    dictionary: &'static str,
}

impl Preferences {
    fn from_config(root: &Value) -> Self {
        let stats = &root["stats"];
        let exp = &root["experimental"];
        let profile = gsm_settings::gsm_config::active_profile(root);
        let advanced = profile
            .and_then(|p| p.get("advanced"))
            .unwrap_or(&Value::Null);
        let anki = profile.and_then(|p| p.get("anki")).unwrap_or(&Value::Null);
        Self {
            stats_settings: stats_settings::public_view(stats),
            port: gsm_settings::gsm_config::resolve_single_port_from_config_data(root),
            anki_url: anki["url"].as_str().unwrap_or("http://127.0.0.1:8765").into(),
            word_field: anki["word"]["name"]
                .as_str()
                .or_else(|| anki["word"].as_str())
                .or_else(|| anki["word_field"].as_str())
                .unwrap_or("Expression")
                .trim()
                .into(),
            anki_parent: anki["parent_tag"]
                .as_str()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or("Game")
                .into(),
            note_type: anki["note_type"].as_str().unwrap_or("").into(),
            rollover_hour: stats["day_rollover_hour"]
                .as_i64()
                .unwrap_or(4)
                .clamp(0, 23) as u32,
            streak_hours: advanced["streak_requirement_hours"].as_f64().unwrap_or(1.0),
            hours_target: stats["reading_hours_target"].as_i64().unwrap_or(1500),
            chars_target: stats["character_count_target"]
                .as_i64()
                .unwrap_or(25_000_000),
            games_target: stats["games_target"].as_i64().unwrap_or(100),
            hours_date: stats["reading_hours_target_date"]
                .as_str()
                .unwrap_or("")
                .into(),
            chars_date: stats["character_count_target_date"]
                .as_str()
                .unwrap_or("")
                .into(),
            games_date: stats["games_target_date"].as_str().unwrap_or("").into(),
            gap: stats["session_gap_seconds"].as_f64().unwrap_or(1800.0),
            cleaner: Some(ReportCleaner::from_saved(
                stats["extra_punctuation_regex"].as_str().unwrap_or(""),
                stats["regex_out_repetitions"] == true,
            )),
            tokenization: exp["enable_experimental_features"] == true
                && exp["enable_tokenization"] == true,
            language: gsm_settings::gsm_config::target_language_from_config(root),
            dictionary: gsm_settings::gsm_config::dictionary_edition(root),
        }
    }
}

type CachedPreferences = ((SystemTime, u64), Arc<Preferences>);

pub struct Reports {
    history: Arc<History>,
    database: PathBuf,
    config: PathBuf,
    preferences: Mutex<Option<CachedPreferences>>,
}

struct Query<'a>(Vec<(Cow<'a, str>, Cow<'a, str>)>);
impl<'a> Query<'a> {
    fn missing_words(
        &self,
        prefs: &Preferences,
        today: NaiveDate,
        export_csv: bool,
    ) -> Result<WordsNotInAnkiQuery> {
        let flag = |name| {
            matches!(
                self.get(name)
                    .unwrap_or("")
                    .trim()
                    .to_ascii_lowercase()
                    .as_str(),
                "1" | "true" | "yes" | "on"
            )
        };
        let text = |name| {
            self.get(name)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
        };
        let range = |min, max, positive: bool| {
            let number = |key| {
                self.get(key)
                    .and_then(|s| s.trim().parse::<i64>().ok())
                    .filter(|n| !positive || *n > 0)
            };
            let pair = (number(min), number(max));
            match pair {
                (Some(a), Some(b)) if a > b => (Some(b), Some(a)),
                _ => pair,
            }
        };
        let (global_rank_min, global_rank_max) = range("global_rank_min", "global_rank_max", true);
        let (frequency_min, frequency_max) = range("frequency_min", "frequency_max", true);
        let (start_timestamp, end_timestamp) = range("start_timestamp", "end_timestamp", false);
        let (game_ids, has_game_scope) = self.game_scope();
        let (limit, offset) = if export_csv {
            (None, 0)
        } else {
            (
                Some(self.int("limit")?.unwrap_or(100).clamp(0, 1000) as usize),
                self.int("offset")?.unwrap_or(0).max(0) as usize,
            )
        };
        let script = self
            .get("script_filter")
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        let script_filter = match script.as_str() {
            "all" | "cjk" | "non_cjk" => script,
            _ if flag("cjk_only") => "cjk".into(),
            _ => "all".into(),
        };
        Ok(WordsNotInAnkiQuery {
            limit,
            offset,
            search: text("search"),
            sort_col: self.get("sort").unwrap_or("frequency").into(),
            sort_order: self.get("order").unwrap_or("desc").into(),
            global_rank_min,
            global_rank_max,
            pos_filter: text("pos"),
            exclude_pos: text("exclude_pos"),
            vocab_only: flag("vocab_only"),
            script_filter,
            game_ids,
            has_game_scope,
            start_timestamp,
            end_timestamp,
            frequency_min,
            frequency_max,
            has_missing_anki_kanji: flag("has_missing_anki_kanji"),
            parent_tag: prefs.anki_parent.clone(),
            word_field: prefs.word_field.clone(),
            today,
            export_csv,
        })
    }
    fn get(&self, k: &str) -> Option<&str> {
        self.0
            .iter()
            .find(|(key, _)| key == k)
            .map(|(_, v)| v.as_ref())
    }
    fn text(&self, k: &str) -> Option<String> {
        self.get(k).filter(|s| !s.is_empty()).map(str::to_owned)
    }
    fn float(&self, k: &str) -> Result<Option<f64>> {
        self.get(k)
            .filter(|s| !s.is_empty())
            .map(|s| s.trim().parse::<f64>().map_err(Into::into))
            .transpose()
    }
    fn int(&self, k: &str) -> Result<Option<i64>> {
        self.get(k)
            .map(|s| s.trim().parse::<i64>().map_err(Into::into))
            .transpose()
    }
    fn is_true(&self, k: &str) -> bool {
        self.get(k).is_some_and(|s| s.eq_ignore_ascii_case("true"))
    }
    fn game_scope(&self) -> (Vec<String>, bool) {
        let mut ids = Vec::new();
        for (_, v) in self.0.iter().filter(|(k, _)| k == "game_id") {
            let id = v.trim();
            if !id.is_empty() && !ids.iter().any(|s| s == id) {
                ids.push(id.to_owned());
            }
        }
        let selected = !ids.is_empty()
            || self
                .get("game_scope")
                .is_some_and(|s| s.trim().eq_ignore_ascii_case("selected"));
        (ids, selected)
    }
}

fn day_boundary(date: NaiveDate, end: bool) -> Result<f64> {
    let t = if end {
        date.and_hms_micro_opt(23, 59, 59, 999999)
    } else {
        date.and_hms_opt(0, 0, 0)
    };
    let t = Local
        .from_local_datetime(&t.ok_or("invalid time")?)
        .earliest()
        .ok_or("invalid local day boundary")?;
    Ok(t.timestamp_micros() as f64 / 1e6)
}

#[derive(Debug)]
pub struct Reply {
    pub status: u16,
    pub body: Value,
}
impl Reply {
    fn error(status: u16, message: &str) -> Self {
        Self {
            status,
            body: json!({"error":message}),
        }
    }
}

impl Reports {
    pub fn begin_file_import(&self) -> std::result::Result<u64,Reply> {
        if std::env::var("GSM_DB_READ_ONLY").as_deref() == Ok("1") {
            return Err(Reply::error(403, "Database is read-only"));
        }
        self.history.generation().map_err(|e| Reply::error(500, &e.to_string()))
    }

    pub fn new(directory: &Path, history: Arc<History>) -> Self {
        Self {
            history,
            database: directory.join("gsm.db"),
            config: directory.join("config.json"),
            preferences: Mutex::default(),
        }
    }
    fn preferences(&self) -> Result<Arc<Preferences>> {
        let stat = match self.config.metadata() {
            Ok(stat) => stat,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Ok(Arc::new(Preferences::from_config(&Value::Null)))
            }
            Err(e) => return Err(e.into()),
        };
        let stamp = (stat.modified()?, stat.len());
        let mut saved = self
            .preferences
            .lock()
            .map_err(|_| "report preferences unavailable")?;
        if let Some((old, prefs)) = saved.as_ref() {
            if *old == stamp {
                return Ok(prefs.clone());
            }
        }
        let prefs = Arc::new(Preferences::from_config(&gsm_settings::read_object(&self.config)?));
        *saved = Some((stamp, prefs.clone()));
        Ok(prefs)
    }

    /// None lets a compatibility-only request (for example a custom Python
    /// cleaning expression) keep its existing HTTP implementation.
    pub fn read(&self, route: Route, query: &str) -> Result<Option<Reply>> {
        self.read_with_timezone(route, query, None)
    }

    pub fn complete_goals(&self, timezone: Option<&str>) -> Result<Reply> {
        if std::env::var_os("GSM_DB_READ_ONLY").is_some_and(|v| v == "1") {
            return Err("Database is read-only".into());
        }
        let body = self.history.run(
            &self.database,
            Request::CompleteGoals {
                today: goal_date(timezone)?,
            },
        )?;
        Ok(Reply {
            status: if body["success"] == true { 200 } else { 400 },
            body,
        })
    }

    pub fn anki_sync_status(&self) -> (gsm_history::anki_sync::SyncStatus, Option<String>) {
        match self.history.anki_sync_status(&self.database) {
            Ok(status) => {
                let probe = if status.cache_populated { None } else {
                    self.preferences().ok().map(|p| p.anki_url.clone())
                };
                (status, probe)
            }
            Err(_) => (Default::default(), None),
        }
    }

    pub fn backup(&self) -> Reply {
        match self.history.manual_backup(&self.database) {
            Ok((path, timestamp)) => Reply {
                status: 200,
                body: json!({"message":"Database backup successful", "backup_path":path, "timestamp":timestamp}),
            },
            Err(error) => Reply::error(500, &format!("Backup failed: {error}")),
        }
    }

    pub fn read_with_timezone(
        &self,
        route: Route,
        query: &str,
        timezone: Option<&str>,
    ) -> Result<Option<Reply>> {
        use Route::*;
        let q = Query(form_urlencoded::parse(query.as_bytes()).collect());
        let now = Local::now();
        let today = now.date_naive();
        let mut cleaner = ReportCleaner::default();
        let req = match &route {
            GoalsDashboard | ActiveGoals | TodaysGoals | AchievedGoals => return self.goals_page(&route,timezone),
            KechimochiPreview | KechimochiSettings | KechimochiStatus => return self.kechimochi_view(&route),
            TadokuPreview => {
                use gsm_history::tadoku::TitleSource;
                let prefs = self.preferences()?;
                let source = q.get("title_source").or_else(|| prefs.stats_settings["tadoku_title_source"].as_str()).unwrap_or("english");
                let Some(source) = TitleSource::parse(source) else {
                    return Ok(Some(Reply::error(400, "Tadoku title source must be english, original, or romaji")));
                };
                let Some(cleaner) = &prefs.cleaner else { return Ok(None) };
                let deduplicate = q.get("deduplicate").is_some_and(|s|matches!(s.to_ascii_lowercase().as_str(),"1"|"true"|"yes"|"on"));
                let preview = self.history.tadoku_preview(&self.database, self.history.generation()?,
                    now.timestamp_micros() as f64 / 1e6, source, deduplicate, cleaner)?;
                let mut body = serde_json::to_value(preview)?;
                body["configured"] = prefs.stats_settings["tadoku_configured"].clone();
                return Ok(Some(Reply{status:200,body}));
            }
            StatsSettings => return Ok(Some(Reply{status:200, body:self.preferences()?.stats_settings.clone()})),
            CharacterIndex => return self.character_index(&q).map(Some),
            AnkiSyncStatus => {
                let (status, probe) = self.anki_sync_status();
                // The HTTP gateway handles the asynchronous availability probe.
                return Ok(probe.is_none().then(|| Reply { status: 200, body: json!(status) }));
            }
            LatestGoals => Request::LatestGoals,
            CurrentGoals => {
                let read_only = std::env::var_os("GSM_DB_READ_ONLY").is_some_and(|v| v == "1");
                return Ok(self
                    .history
                    .current_goals(&self.database, read_only)?
                    .map(|body| Reply { status: 200, body }));
            }
            GoalStreak => Request::GoalStreak {
                today: goal_date(timezone)?,
            },
            GoalReadingPace => {
                let prefs = self.preferences()?;
                let Some(configured) = &prefs.cleaner else { return Ok(None) };
                cleaner = configured.clone();
                let zone = goal_zone(timezone);
                let day = jiff::Timestamp::now().to_zoned(zone.clone()).date();
                let timestamp = |time| -> Result<f64> {
                    Ok(zone.to_ambiguous_timestamp(time).later()?.as_microsecond() as f64 / 1e6)
                };
                Request::GoalReadingPace {
                    today: NaiveDate::from_ymd_opt(day.year().into(), day.month() as u32, day.day() as u32)
                        .ok_or("Invalid calendar day")?,
                    day_start: timestamp(day.at(0,0,0,0))?,
                    day_end: timestamp(day.at(23,59,59,999_999_000))?,
                    session_gap: prefs.gap,
                }
            }
            CompleteDailies => return Err("Daily goal completion requires POST".into()),
            DatabaseBackup => return Err("Database backup requires POST".into()),
            GoalsProjection => {
                let prefs = self.preferences()?;
                let Some(configured) = &prefs.cleaner else { return Ok(None); };
                cleaner = configured.clone();
                Request::GoalsProjection(Projection {
                    today,
                    day_start: day_boundary(today, false)?,
                    day_end: day_boundary(today, true)?,
                    session_gap: prefs.gap,
                    hours: Target {
                        date: prefs.hours_date.clone(),
                        value: prefs.hours_target,
                    },
                    characters: Target {
                        date: prefs.chars_date.clone(),
                        value: prefs.chars_target,
                    },
                    games: Target {
                        date: prefs.games_date.clone(),
                        value: prefs.games_target,
                    },
                })
            }
            Dashboard | Overview | KanjiGrid | GameStats(_) => {
                let prefs = self.preferences()?;
                let Some(configured) = &prefs.cleaner else { return Ok(None); };
                cleaner = configured.clone();
                if let GameStats(id) = &route {
                    Request::GameStats(GameStatsQuery {
                        game_id: id.clone(),
                        today,
                        session_gap: prefs.gap,
                        tokenization_enabled: prefs.tokenization,
                    })
                } else {
                    let (start, end) = (q.float("start")?, q.float("end")?);
                    if route == Dashboard {
                        Request::DashboardStats(DashboardStatsQuery {
                            today,
                            session_gap: prefs.gap,
                            filter_year: q.text("year"),
                            start_timestamp: start,
                            end_timestamp: end,
                            include_tokenization: !q.get("include_tokenization").is_some_and(|s| {
                                matches!(
                                    s.trim().to_ascii_lowercase().as_str(),
                                    "false" | "off" | "no" | "0"
                                )
                            }),
                            tokenization_enabled: prefs.tokenization,
                        })
                    } else {
                        let (start, end) = match (start, end) {
                            (Some(a), Some(b)) if a != 0.0 && b != 0.0 => {
                                (Some(local_date(a)?), Some(local_date(b)?))
                            }
                            _ => (None, None),
                        };
                        let (day_start, day_end) =
                            (day_boundary(today, false)?, day_boundary(today, true)?);
                        if route == KanjiGrid {
                            Request::KanjiGrid {
                                today,
                                start,
                                end,
                                day_start,
                                day_end,
                            }
                        } else {
                            Request::ReadingOverview(Range {
                                today,
                                start,
                                end,
                                day_start,
                                day_end,
                                session_gap: prefs.gap,
                            })
                        }
                    }
                }
            }
            Today => {
                let prefs = self.preferences()?;
                let Some(configured) = &prefs.cleaner else { return Ok(None); };
                cleaner = configured.clone();
                let rollover = |day: NaiveDate| -> Result<f64> {
                    let time = day
                        .and_hms_opt(prefs.rollover_hour, 0, 0)
                        .ok_or("invalid rollover hour")?;
                    Ok(Local
                        .from_local_datetime(&time)
                        .earliest()
                        .ok_or("invalid local hour")?
                        .timestamp() as f64)
                };
                let (start, end) = if now.hour() < prefs.rollover_hour {
                    (
                        rollover(today.pred_opt().ok_or("invalid calendar day")?)?,
                        rollover(today)?,
                    )
                } else {
                    (rollover(today)?, day_boundary(today, true)?)
                };
                let body = self
                    .history
                    .today_report(&self.database, start, end, prefs.gap, &cleaner)?;
                return Ok(Some(Reply { status: 200, body }));
            }
            Milestones => Request::GameMilestones,
            AnkiReadingImpact | AnkiCoverage | AnkiCombined => return self.anki_chart(route, query, ""),
            AnkiHeatmap | AnkiGames | AnkiRetention | AnkiEarliest => {
                let start = q.int("start_timestamp")?;
                let end = q.int("end_timestamp")?;
                if route == AnkiHeatmap {
                    let seconds = |ms: i64| ms.max(0) as f64 / 1000.;
                    Request::MiningHeatmap {
                        start: start.map(seconds),
                        end: end.map(seconds),
                        live_only: start.is_none() && end.is_none(),
                    }
                } else {
                    let parent_tag = self.preferences()?.anki_parent.clone();
                    match route {
                        AnkiEarliest => Request::AnkiEarliestNote { parent_tag },
                        AnkiGames => Request::AnkiGameStats(AnkiGameQuery {
                            parent_tag,
                            start,
                            end,
                        }),
                        _ => Request::AnkiContentRetention(AnkiGameQuery {
                            parent_tag,
                            start,
                            end,
                        }),
                    }
                }
            }
            GameKanji(id) => Request::GameKanji {
                game_id: id.clone(),
            },
            GamesList => Request::GamesList,
            OrphanedGames => Request::OrphanedGames,
            GamesManagement => return Ok(Some(Reply {
                status:200,body:self.history.games_management(&self.database,q.get("sort").unwrap_or("last_played"),std::env::var("GSM_DB_READ_ONLY").as_deref()==Ok("1"))?
            })),
            DatabaseStatus => Request::DatabaseStatus,
            ArchiveFiles => return Ok(Some(Reply{status:200,body:self.archive_files()?})),
            ImportedStats => Request::ImportedStats {
                source: q.text("source"),
            },
            ImportedStatsSummary => Request::ImportedStatsSummary,
            ArchivePreview(id) => Request::ArchivePreview {
                game_id: id.clone(),
            },
            MiningHeatmap => Request::MiningHeatmap {
                start: q.float("start")?,
                end: q.float("end")?,
                live_only: false,
            },
            KanjiFrequency => {
                let mut chars = q.get("kanji").unwrap_or("").chars();
                let kanji = match (chars.next(), chars.next()) {
                    (Some(c), None) => c,
                    _ => return Ok(Some(Reply::error(400, "Invalid kanji parameter"))),
                };
                Request::KanjiFrequency { kanji, today }
            }
            DailyActivity => {
                let (start, end) = if q.text("start").is_some() && q.text("end").is_some() {
                    (
                        q.float("start")?.map(local_date).transpose()?,
                        q.float("end")?.map(local_date).transpose()?,
                    )
                } else {
                    (None, None)
                };
                Request::DailyActivity {
                    today,
                    start,
                    end,
                    all_time: q.is_true("all_time"),
                }
            }
            Search => {
                let query = q.get("q").unwrap_or("").trim();
                let page = q.int("page")?.unwrap_or(1).max(1) as usize;
                let size = q.int("page_size")?.unwrap_or(20);
                if query.is_empty() {
                    return Ok(Some(Reply::error(400, "Search query is required")));
                }
                let date = |key, end| -> Result<Option<f64>> {
                    q.get(key)
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .map(|s| day_boundary(NaiveDate::parse_from_str(s, "%Y-%m-%d")?, end))
                        .transpose()
                };
                let Ok(start) = date("from_date", false) else {
                    return Ok(Some(Reply::error(
                        400,
                        "Invalid from_date format. Use YYYY-MM-DD",
                    )));
                };
                let Ok(end) = date("to_date", true) else {
                    return Ok(Some(Reply::error(
                        400,
                        "Invalid to_date format. Use YYYY-MM-DD",
                    )));
                };
                let sort = serde_json::from_value(json!(q.get("sort").unwrap_or("relevance")))?;
                Request::SearchSentences(SentenceQuery {
                    query: query.into(),
                    game: q.text("game"),
                    start,
                    end,
                    sort,
                    page,
                    page_size: if size < 1 {
                        20
                    } else {
                        size.min(100_000_000) as usize
                    },
                    use_regex: q.is_true("use_regex"),
                    use_tokenized: q.is_true("use_tokenized"),
                })
            }
            _ => {
                let prefs = self.preferences()?;
                if !prefs.tokenization {
                    return Ok(Some(if route == TokenStatus {
                        Reply {
                            status: 200,
                            body: json!({"enabled":false,"total_lines":0,"tokenized_lines":0,"untokenized_lines":0,"percent_complete":0,"total_words":0,"total_kanji":0}),
                        }
                    } else {
                        Reply::error(404, "Tokenization is not enabled")
                    }));
                }
                match &route {
                    Maturity => Request::MaturityHistory(MaturityQuery::daily(
                        prefs.word_field.clone(),
                        today,
                    )),
                    MissingWords | ExportMissingWords => Request::TokenizationWordsNotInAnki(
                        q.missing_words(&prefs, today, route == ExportMissingWords)?,
                    ),
                    TokenStatus => Request::TokenizationStatus,
                    Words | Kanji => {
                        let limit = q.int("limit")?.unwrap_or(100).min(500);
                        let offset = q.int("offset")?.unwrap_or(0);
                        let days = q.int("days")?;
                        let game_id = q.text("game_id");
                        if route == Words {
                            Request::TokenizationWords(WordsQuery {
                                limit,
                                offset,
                                days,
                                game_id,
                                pos: q.text("pos"),
                                exclude_pos: q.text("exclude_pos"),
                                search: q.text("search"),
                            })
                        } else {
                            Request::TokenizationKanji(KanjiQuery {
                                limit,
                                offset,
                                days,
                                game_id,
                            })
                        }
                    }
                    WordDetail(word) => {
                        let (game_ids, has_game_scope) = q.game_scope();
                        Request::TokenizationWordDetail(WordDetailQuery {
                            word: word.clone(),
                            game_ids,
                            has_game_scope,
                        })
                    }
                    CardData => {
                        let mut word_ids = Vec::new();
                        for id in q
                            .get("word_ids")
                            .unwrap_or("")
                            .split(',')
                            .filter_map(|s| s.trim().parse::<i64>().ok())
                            .filter(|n| *n > 0)
                        {
                            if !word_ids.contains(&id) {
                                word_ids.push(id);
                                if word_ids.len() == 100 {
                                    break;
                                }
                            }
                        }
                        Request::TokenizationWordCardData { word_ids }
                    }
                    WordsByGame => Request::TokenizationWordsByGame {
                        limit: q.int("limit")?.unwrap_or(20).min(100),
                    },
                    WordSearch => {
                        let term = q.get("q").unwrap_or("").trim();
                        if term.is_empty() {
                            return Ok(Some(Reply::error(400, "Search query is required")));
                        }
                        let (game_ids, has_game_scope) = q.game_scope();
                        Request::TokenizationSearch(TokenSearchQuery {
                            query: term.into(),
                            limit: q.int("limit")?.unwrap_or(50).min(200),
                            offset: q.int("offset")?.unwrap_or(0),
                            game_ids,
                            has_game_scope,
                        })
                    }
                    _ => unreachable!("handled above"),
                }
            }
        };
        let mut body = self.history.run_with_cleaner(&self.database, req, &cleaner)?;
        let may_be_empty = match route {
            AnkiEarliest => body["earliest_date"].as_f64() == Some(0.0),
            AnkiRetention => body["nsfw_reviews"] == 0 && body["sfw_reviews"] == 0,
            _ => false,
        };
        if may_be_empty && !self.history.anki_has_notes(&self.database)? {
            body["cache_empty"] = true.into();
            body["message"] = "Anki cache has not been synced yet. Data will be available after the first sync completes.".into();
        }
        if body.is_null() || body.get("fallback").is_some() {
            return Ok(None);
        }
        if route == Milestones && body.as_object().is_some_and(|v| v.is_empty()) {
            body = Value::Null;
        }
        if body["not_found"] == true {
            return Ok(Some(Reply::error(
                404,
                if matches!(route, WordDetail(_)) {
                    "Word not found"
                } else {
                    "Game not found"
                },
            )));
        }
        let status = if matches!(route, GameKanji(_)) && body.get("error").is_some() {
            404
        } else {
            200
        };
        Ok(Some(Reply { status, body }))
    }
}
