//! Desktop and HTTP clients read the same snapshot of the running services.
use crate::{app_lifecycle, mining::MiningService, obs::Obs, text_intake::Intake};
use serde_json::{json, Value};
use std::sync::Arc;
use tauri::{AppHandle, Manager};

pub fn snapshot(app: &AppHandle) -> Value {
    let mining = app.state::<Arc<MiningService>>().status_snapshot();
    let intake = app.state::<Intake>().health();
    let serving = mining["gateway_port"].is_u64();
    let running = intake["healthy"] == true;
    let ready = running && serving && app_lifecycle::initialized(app);
    json!({
        "ready":ready,
        "status":if ready {"Ready"} else {"Initializing"},
        // The legacy status counts newly created notes. Mining enriches existing notes.
        "cards_created":0,
        "websockets_connected":intake["sources"]["websockets"],
        "clipboard_enabled":intake["sources"]["clipboard"],
        "last_line_received":intake["last_line_received"],
        "obs_connected":app.state::<Obs>().state()["connected"],
        "anki_connected":mining["anki_connected"],
        "anki_beacon_connected":mining["anki_beacon_connected"],
        "words_being_processed":mining["words_being_processed"],
        "text_runtime":{
            "state":if running {"running"} else {"connecting"}, "healthy":running,
            "owner":"desktop", "projected":intake["cursor"], "accepted_lines":intake["accepted_lines"],
            "receipt_log_owner":"desktop", "error":intake["error"],
        },
        "transport_runtime":{
            "transport":{"owner":"desktop","state":if serving {"running"} else {"created"},
                "thread_alive":serving,"pending_tasks":intake["queue_depth"],"failure":null},
            "servers":if serving {vec!["texthooker","overlay"]} else {vec![]},
            "ingress_depth":intake["queue_depth"], "ingress_capacity":intake["queue_capacity"],
        }
    })
}
