use gsm_history::History;
use gsm_web::{Reports, Route};
use std::sync::Arc;
use gsm_web::yomitan_frequency::Response;
use serde_json::{json, Value};

#[test]
fn character_update_index_matches_installed_dictionaries() {
    let dir = tempfile::tempdir().unwrap();
    let db = gsm_db::open_profile(&dir.path().join("gsm.db"), "ja").unwrap();
    db.execute_batch(r#"INSERT INTO games(id,title_original,title_romaji,vndb_character_data) VALUES
        ('g','','図書','{"nested":[1e-7,1e17],"characters":{"side":[{"name":"灯"}]}}'),
        ('empty','No characters',NULL,'{"characters":{"main":[]}}'),
        ('bad','Invalid',NULL,'invalid');
        INSERT INTO game_lines(id,game_id,timestamp) VALUES('1','bad',3),('2','empty',2),('3','g',1);"#).unwrap();
    let reports = Reports::new(dir.path(), Arc::new(History::default()));
    let read = |query| {
        reports
            .read(Route::parse("/api/yomitan-index").unwrap(), query)
            .unwrap()
            .unwrap()
            .body
    };
    let index = read("game_count=1&spoiler_level=2");
    assert_eq!(index["revision"], "d9647c8df48f7910");
    assert_eq!(
        index["description"],
        "Character names from your 1 most recently played game: 図書"
    );
    assert_eq!(
        index["downloadUrl"],
        "http://127.0.0.1:7275/api/yomitan-dict?game_count=1&spoiler_level=2"
    );
    assert_eq!(read("game_count=1000&spoiler_level=bad"), read(""));
}

#[test]
fn archive_restores_portraits_and_preserves_spoiler_and_name_settings() {
    use std::io::{BufRead, BufReader, Cursor, Read, Write};
    use std::net::TcpListener;
    let dir = tempfile::tempdir().unwrap();
    let db = gsm_db::open_profile(&dir.path().join("gsm.db"), "ja").unwrap();
    let reports = Reports::new(dir.path(), Arc::new(History::default()));
    for (q,status) in [("",404),("spoiler_level=3",400),("game_count=0",400)] {
        let Response::Json(reply) = reports.character_dictionary(q).unwrap() else {panic!("expected error")};
        assert_eq!(reply.status,status);
    }
    let server = TcpListener::bind(("127.0.0.1",0)).unwrap();
    let url = format!("http://{}/original",server.local_addr().unwrap());
    let mut png=Cursor::new(Vec::new());
    image::RgbaImage::new(84,104).write_to(&mut png,image::ImageFormat::Png).unwrap();
    let png=png.into_inner();
    let body=png.clone();
    let download=std::thread::spawn(move || {
        let (mut socket,_) = server.accept().unwrap();
        let mut request=String::new();
        let mut reader=BufReader::new(&socket);
        while reader.read_line(&mut request).unwrap()>0 && !request.ends_with("\r\n\r\n") {}
        write!(socket,"HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",body.len()).unwrap();
        socket.write_all(&body).unwrap();
    });
    let data=json!({"characters":{"primary":[{"id":12,"name":"Katou Umi","name_original":"加藤 うみ",
        "image_url":url,"aliases":["海"],"role":"primary","description":"Visible [spoiler]secret[/spoiler]"}]}});
    db.execute("INSERT INTO games(id,title_original,vndb_character_data) VALUES('g','VN',?1)",[data.to_string()]).unwrap();
    for level in [1,2,0] {
        let Response::Archive(bytes)=reports.character_dictionary(&format!("spoiler_level={level}")).unwrap() else {panic!("expected ZIP")};
        let mut archive=zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
        let rows:Vec<Value>=serde_json::from_reader(archive.by_name("term_bank_1.json").unwrap()).unwrap();
        assert_eq!(rows[0][0],"加藤 うみ");
        assert_eq!(rows[0][1],"かとううみ");
        let definition=rows[0][5].to_string();
        assert_eq!(definition.contains("Visible"),level>0);
        assert_eq!(definition.contains("secret"),level==2);
        assert!(rows.iter().any(|r|r[0]=="海様" && r[1]=="かとううみさま"));
        let mut portrait=Vec::new();
        archive.by_name("img/c12.png").unwrap().read_to_end(&mut portrait).unwrap();
        assert_eq!(portrait,png);
    }
    download.join().unwrap();
}
