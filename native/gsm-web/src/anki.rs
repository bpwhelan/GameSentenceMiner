use super::*;

const SECTIONS: [&str; 6] = [
    "earliest_date",
    "kanji_stats",
    "game_stats",
    "nsfw_sfw_retention",
    "mining_heatmap",
    "reading_impact",
];

fn sections(raw: Option<&str>) -> std::result::Result<Vec<&'static str>, String> {
    let Some(raw) = raw.filter(|s| !s.is_empty()) else {
        return Ok(SECTIONS.to_vec());
    };
    let mut selected = Vec::new();
    let mut invalid = Vec::new();
    for part in raw.split(',').map(str::trim).filter(|s| !s.is_empty()) {
        if let Some(section) = SECTIONS.iter().copied().find(|&s| s == part) {
            if !selected.contains(&section) {
                selected.push(section);
            }
        } else {
            invalid.push(part);
        }
    }
    if !invalid.is_empty() {
        invalid.sort_unstable();
        return Err(format!(
            "Unsupported Anki stats sections: {}",
            invalid.join(", ")
        ));
    }
    if selected.is_empty() {
        return Err("At least one Anki stats section must be selected.".into());
    }
    Ok(selected)
}

pub struct KanjiLookup {
    pub url: String,
    pub query: String,
    parent_prefix: String,
    word_field: String,
    start: Option<i64>,
    end: Option<i64>,
}

impl KanjiLookup {
    pub fn includes(&self, id: i64) -> bool {
        self.start.is_none_or(|s| id >= s) && self.end.is_none_or(|e| id <= e)
    }
    pub fn characters<'a>(&self, note: &'a Value) -> Option<impl Iterator<Item = char> + 'a> {
        if !note["tags"].as_array()?.iter().any(|tag| {
            tag.as_str()
                .is_some_and(|s| s.starts_with(&self.parent_prefix))
        }) {
            return None;
        }
        Some(
            note["fields"].get(&self.word_field)?["value"]
                .as_str()?
                .chars()
                .filter(is_kanji),
        )
    }
}

#[derive(Clone, Copy)]
struct Bounds {
    start: Option<i64>,
    end: Option<i64>,
    lag: i64,
}
impl Bounds {
    fn parse(q: &Query<'_>) -> Result<Self> {
        let int = |key| {
            q.get(key)
                .filter(|s| !s.is_empty())
                .map(|s| s.trim().parse::<i64>())
                .transpose()
        };
        Ok(Self {
            start: int("start_timestamp")?,
            end: int("end_timestamp")?,
            lag: int("lag_weeks")?.unwrap_or(3),
        })
    }
}

impl Reports {
    pub fn kanji_lookup(&self, combined: bool, query: &str) -> Result<Option<KanjiLookup>> {
        let q = Query(form_urlencoded::parse(query.as_bytes()).collect());
        if combined && !sections(q.get("sections")).is_ok_and(|s| s.contains(&"kanji_stats")) {
            return Ok(None);
        }
        let bounds = Bounds::parse(&q)?;
        if self.history.anki_has_notes(&self.database)? {
            return Ok(None);
        }
        let p = self.preferences()?;
        Ok(
            gsm_history::anki_sync::collection_query(&p.word_field, &p.note_type).map(|query| {
                KanjiLookup {
                    url: p.anki_url.clone(),
                    query,
                    parent_prefix: format!("{}::", p.anki_parent),
                    word_field: p.word_field.clone(),
                    start: bounds.start,
                    end: bounds.end,
                }
            }),
        )
    }

    fn chart_section(
        &self,
        section: &str,
        query: &str,
        bounds: Bounds,
        details: bool,
        live: &str,
    ) -> Result<Option<Value>> {
        let route = match section {
            "earliest_date" => Route::AnkiEarliest,
            "game_stats" => Route::AnkiGames,
            "nsfw_sfw_retention" => Route::AnkiRetention,
            "mining_heatmap" => Route::AnkiHeatmap,
            "kanji_stats" | "reading_impact" => {
                let p = self.preferences()?;
                let Some(cleaner) = &p.cleaner else {
                    return Ok(None);
                };
                let today = Local::now().date_naive();
                let request = if section == "kanji_stats" {
                    Request::AnkiCoverage(AnkiCoverageQuery {
                        today,
                        start: bounds.start,
                        end: bounds.end,
                        word_field: p.word_field.clone(),
                        parent_tag: p.anki_parent.clone(),
                        live_kanji: live.into(),
                    })
                } else {
                    Request::AnkiReadingImpact(AnkiImpactQuery {
                        today,
                        start: bounds.start,
                        end: bounds.end,
                        lag_weeks: bounds.lag,
                        parent_tag: p.anki_parent.clone(),
                        word_field: p.word_field.clone(),
                        session_gap: p.gap,
                        tokenization: p.tokenization,
                        details,
                    })
                };
                return self
                    .history
                    .run_with_cleaner(&self.database, request, cleaner)
                    .map(Some);
            }
            _ => unreachable!("validated section"),
        };
        Ok(self.read(route, query)?.map(|r| r.body))
    }

    pub fn anki_chart(&self, route: Route, query: &str, live: &str) -> Result<Option<Reply>> {
        let q = Query(form_urlencoded::parse(query.as_bytes()).collect());
        let bounds = Bounds::parse(&q)?;
        if route != Route::AnkiCombined {
            let section = match route {
                Route::AnkiCoverage => "kanji_stats",
                Route::AnkiReadingImpact => "reading_impact",
                _ => return Err("Invalid Anki chart".into()),
            };
            return Ok(self
                .chart_section(section, query, bounds, true, live)?
                .map(|body| Reply { body, status: 200 }));
        }
        let requested = match sections(q.get("sections")) {
            Ok(s) => s,
            Err(e) => return Ok(Some(Reply::error(400, &e))),
        };
        let mut body = serde_json::Map::with_capacity(requested.len());
        for section in requested {
            let value = match self.chart_section(section, query, bounds, false, live) {
                Ok(Some(mut value)) if section == "earliest_date" => value
                    .get_mut(section)
                    .map(Value::take)
                    .unwrap_or_else(|| json!(0)),
                Ok(Some(value)) => value,
                Ok(None) => return Ok(None),
                Err(_) => match section {
                    "earliest_date" => json!(0),
                    "game_stats" => json!([]),
                    _ => json!({}),
                },
            };
            body.insert(section.into(), value);
        }
        Ok(Some(Reply {
            status: 200,
            body: Value::Object(body),
        }))
    }
}
