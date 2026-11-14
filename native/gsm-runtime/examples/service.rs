//! Test-only pipe adapter for exercising real native transport from TS tests.
use serde_json::{json, Value};
use std::{
    io::{BufRead, Write},
    sync::{Arc, Mutex},
};
fn main() {
    let output = Arc::new(Mutex::new(std::io::stdout()));
    let sink = output.clone();
    let runtime = Arc::new(
        gsm_runtime::Runtime::start(json!({}), move |event, data| {
            let _ = writeln!(
                sink.lock().unwrap(),
                "{}",
                json!({"event":event,"data":data})
            );
        })
        .unwrap(),
    );
    writeln!(
        output.lock().unwrap(),
        "{}",
        json!({"ready":runtime.info()})
    )
    .unwrap();
    let executor = tokio::runtime::Runtime::new().unwrap();
    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        let Ok(message) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if message["action"] == "bus.stop" {
            runtime.shutdown();
            writeln!(
                output.lock().unwrap(),
                "{}",
                json!({"id":message["id"],"result":null})
            )
            .unwrap();
            break;
        }
        let runtime = runtime.clone();
        let output = output.clone();
        executor.spawn(async move {
            let response = match runtime
                .call(
                    message["action"].as_str().unwrap_or(""),
                    message["params"].clone(),
                )
                .await
            {
                Ok(result) => json!({"id":message["id"],"result":result}),
                Err(error) => json!({"id":message["id"],"error":error}),
            };
            let _ = writeln!(output.lock().unwrap(), "{response}");
        });
    }
}
