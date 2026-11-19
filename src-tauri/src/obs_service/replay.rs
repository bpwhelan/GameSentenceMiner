use super::{json, ObsError, ResultValue, Value};

struct Save {
    connection: String,
    request: String,
    acknowledged: bool,
    file: Option<ResultValue>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn late_save_is_drained_before_another_request_can_claim_a_file() {
        let mut replay = Replay::default();
        replay.begin("connection", "card").unwrap();
        assert!(replay
            .reply("connection", "card", Ok(Value::Null))
            .is_none());
        assert!(replay.begin("connection", "next").is_err());
        let late = replay
            .event(
                "connection",
                "ReplayBufferSaved",
                &json!({"savedReplayPath":"late.mkv"}),
            )
            .unwrap();
        assert_eq!(late.0, "card");

        replay.begin("connection", "clip").unwrap();
        replay.disconnected("connection");
        assert!(replay.begin("new connection", "next").is_err());
        assert!(replay
            .event(
                "new connection",
                "ReplayBufferSaved",
                &json!({"savedReplayPath":"old.mkv"})
            )
            .is_none());
        replay.begin("new connection", "next").unwrap();
        let error = replay.reply(
            "new connection",
            "next",
            Err(ObsError::new("buffer offline")),
        );
        assert!(error.unwrap().is_err());
        replay.begin("new connection", "retry").unwrap();
    }
}

/// OBS acknowledges the request ID and reports the completed path separately.
/// Only one save can be on the wire. A caller timing out must not release its
/// slot for another caller while the old file could still arrive.
#[derive(Default)]
pub(super) struct Replay {
    save: Option<Save>,
    awaiting_orphan: bool,
}

impl Replay {
    pub(super) fn begin(&mut self, connection: &str, request: &str) -> Result<(), ObsError> {
        if self.awaiting_orphan || self.save.is_some() {
            return Err(ObsError::new("Still awaiting a previous OBS replay. If its completion was lost, restart the replay buffer."));
        }
        self.save = Some(Save {
            connection: connection.into(),
            request: request.into(),
            acknowledged: false,
            file: None,
        });
        Ok(())
    }

    pub(super) fn reply(
        &mut self,
        connection: &str,
        request: &str,
        result: ResultValue,
    ) -> Option<ResultValue> {
        let Some(save) = self
            .save
            .as_mut()
            .filter(|s| s.connection == connection && s.request == request)
        else {
            return Some(result);
        };
        if result.is_err() {
            self.save = None;
            return Some(result);
        }
        save.acknowledged = true;
        let file = save.file.take()?;
        self.save = None;
        Some(file)
    }

    pub(super) fn event(
        &mut self,
        connection: &str,
        name: &str,
        data: &Value,
    ) -> Option<(String, ResultValue)> {
        if self
            .save
            .as_ref()
            .is_some_and(|s| s.connection != connection)
        {
            return None;
        }
        if name == "ReplayBufferStateChanged" {
            if !matches!(
                data["outputState"].as_str(),
                Some("OBS_WEBSOCKET_OUTPUT_STOPPED" | "OBS_WEBSOCKET_OUTPUT_STARTED")
            ) {
                return None;
            }
            self.awaiting_orphan = false;
            return self.save.take().map(|s| {
                (
                    s.request,
                    Err(ObsError::new(
                        "OBS replay buffer restarted or stopped during save",
                    )),
                )
            });
        }
        self.awaiting_orphan = false;
        let save = self.save.as_mut()?;
        let file = match data["savedReplayPath"].as_str() {
            _ if save.file.is_some() => Err(ObsError::new(
                "Multiple OBS replay completions arrived before the save acknowledgement",
            )),
            Some(path) if !path.trim().is_empty() => Ok(json!({"savedReplayPath":path})),
            _ => Err(ObsError::new("OBS reported a replay without a file path")),
        };
        if save.acknowledged {
            let request = self.save.take()?.request;
            Some((request, file))
        } else {
            save.file = Some(file);
            None
        }
    }

    pub(super) fn disconnected(&mut self, connection: &str) {
        if self
            .save
            .as_ref()
            .is_some_and(|s| s.connection == connection)
        {
            self.awaiting_orphan = self.save.take().is_some_and(|s| s.file.is_none());
        }
    }
}
