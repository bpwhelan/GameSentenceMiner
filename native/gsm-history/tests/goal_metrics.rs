use gsm_history::{
    goal_metrics::{ExactRange, Metric, Query, Scope},
    History, ReportCleaner,
};

#[test]
fn timed_goals_bound_half_open_intervals_and_count_imports_only_for_complete_days() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("gsm.db");
    let db = gsm_db::open_profile(&path, "ja").unwrap();
    db.execute_batch("INSERT INTO games(id,title_original,type) VALUES('g','空','Visual Novel'),('b','本','Manga');
        INSERT INTO game_lines(id,game_id,game_name,line_text,timestamp) VALUES('1','g','空','日本語。',10),('2','b','本','台詞',20),('3','g','空','雨',30);
        INSERT INTO third_party_stats(date,characters_read,time_read_seconds,label) VALUES('1970-01-01',17,60,'Book')").unwrap();
    let day = "1970-01-01".parse().unwrap();
    let ranges = [
        ExactRange {
            start: 10.,
            end: 30.,
            whole_days: None,
        },
        ExactRange {
            start: 0.,
            end: 86400.,
            whole_days: Some((day, day)),
        },
    ];
    let history = History::default();
    let cleaner = ReportCleaner::default();
    let mut query = Query {
        metric: Metric::Characters,
        scope: Scope::All,
        cleaner: &cleaner,
        session_gap: 1800.,
        deck: "",
    };
    assert_eq!(
        history.exact_goal_values(&path, &query, &ranges).unwrap(),
        [5., 23.]
    );
    query.scope = Scope::Game {
        id: "stale",
        name: "空",
    };
    assert_eq!(
        history.exact_goal_values(&path, &query, &ranges).unwrap(),
        [3., 4.]
    );
    query.scope = Scope::Media("Manga");
    assert_eq!(
        history.exact_goal_values(&path, &query, &ranges).unwrap(),
        [2., 2.]
    );
}
