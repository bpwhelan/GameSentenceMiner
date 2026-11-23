use super::{get_json, jiten, search_results::anilist_description, Sources};
use gsm_history::library::CharacterSource;
use serde_json::{json, Value};

const ANILIST_MEDIA: &str = "query ($id:Int!,$type:MediaType) {
    Media(id:$id,type:$type) { id title { romaji english native } description(asHtml:false)
        coverImage { extraLarge large medium } format status averageScore siteUrl
        startDate { year month day } genres tags { name rank isMediaSpoiler }
    }
}";

impl Sources {
    pub(super) async fn deck_detail(&self, id: i64) -> Result<Value, &'static str> {
        let url = format!("{}/{id}/detail", self.jiten);
        let mut data = get_json(self.http.get(url).query(&[("offset", 0)]), 10)
            .await
            .ok_or("Failed to fetch Jiten deck detail")?;
        let row = data
            .pointer_mut("/data/mainDeck")
            .filter(|value| value.as_object().is_some_and(|obj| !obj.is_empty()))
            .ok_or("Invalid Jiten response - no mainDeck")?;
        Ok(jiten::normalize(row.take()))
    }

    pub(super) async fn detail(&self, source: &CharacterSource) -> Option<Value> {
        match source {
            CharacterSource::Vndb(id) => self.vndb_detail(id).await,
            CharacterSource::Anilist { id, manga } => self.anilist_detail(*id, *manga).await,
        }
    }

    async fn vndb_detail(&self, id: &str) -> Option<Value> {
        let id = id.trim().to_lowercase();
        let id = if id.starts_with('v') {
            id
        } else {
            format!("v{id}")
        };
        let request=self.http.post(format!("{}/vn",self.vndb)).json(&json!({
            "filters":["id","=",id],"results":1,
            "fields":"id, title, alttitle, released, rating, description, image.url, developers.name, length_minutes, tags.name, tags.category, tags.rating"
        }));
        let payload = get_json(request, 10).await?;
        let row = payload.pointer("/results/0")?;
        let names = |key: &str| {
            row[key]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|item| item["name"].as_str().filter(|s| !s.is_empty()))
                .collect::<Vec<_>>()
        };
        Some(
            json!({"vndb_id":id,"title_romaji":row["title"],"title_original":row["alttitle"],
            "description":row["description"],"release_date":row["released"],"rating":row["rating"],
            "length_minutes":row["length_minutes"],"cover_url":row["image"]["url"],"developers":names("developers"),
            "tags":names("tags"),"genres":[],"media_type":"Visual Novel","media_type_string":"Visual Novel"}),
        )
    }

    async fn anilist_detail(&self, id: i64, manga: bool) -> Option<Value> {
        let kind = if manga { "MANGA" } else { "ANIME" };
        let req = self
            .http
            .post(&self.anilist)
            .json(&json!({"query":ANILIST_MEDIA,"variables":{"id":id,"type":kind}}));
        let payload = get_json(req, 15).await?;
        if payload.get("errors").is_some() {
            return None;
        }
        let row = payload.pointer("/data/Media")?;
        if row.as_object()?.is_empty() {
            return None;
        }
        let date = &row["startDate"];
        let release = date["year"].as_i64().filter(|&y| y != 0).map(|y| {
            let part = |key: &str| date[key].as_i64().filter(|&v| v != 0).unwrap_or(1);
            format!("{y:04}-{:02}-{:02}", part("month"), part("day"))
        });
        let titles = &row["title"];
        let tags: Vec<_> = row["tags"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|v| v["isMediaSpoiler"] != true)
            .filter_map(|v| v["name"].as_str().filter(|s| !s.is_empty()))
            .collect();
        let cover = ["extraLarge", "large", "medium"]
            .iter()
            .find_map(|key| row["coverImage"][*key].as_str().filter(|s| !s.is_empty()));
        let label = if manga { "Manga" } else { "Anime" };
        Some(
            json!({"anilist_id":id,"title_romaji":titles["romaji"],"title_original":titles["native"],"title_english":titles["english"],
            "description":anilist_description(row["description"].as_str().unwrap_or("")),"release_date":release,
            "score":row["averageScore"],"status":row["status"],"format":row["format"],"cover_url":cover,"site_url":row["siteUrl"],
            "media_type":label,"media_type_string":label,"genres":row["genres"],"tags":tags}),
        )
    }
}
