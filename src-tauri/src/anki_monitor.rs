//! The mining backend waits for work while the desktop owns the Anki clock.
use super::{Mode, Notes};
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::Duration;
use tokio::{
    sync::{watch, Mutex},
    time::{sleep_until, Instant},
};
use uuid::Uuid;

#[derive(Default)]
pub struct Monitor {
    control: watch::Sender<Option<(u64, u64)>>,
    driver: Mutex<Driver>,
}

#[derive(Clone, Copy, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
enum Activity {
    Hold,
    Probe,
    Poll,
}

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "camelCase", deny_unknown_fields)]
pub enum Command {
    Probe {
        url: reqwest::Url,
        timeout: f64,
    },
    Wake {
        revision: u64,
    },
    Next {
        revision: u64,
        #[serde(flatten)]
        settings: Settings,
    },
}

#[derive(Deserialize)]
pub struct Settings {
    session: Uuid,
    url: String,
    activity: Activity,
    rate: f64,
    resume_after: Option<f64>,
    connected: Option<bool>,
    replay_revision: u64,
    remember: Vec<u64>,
    forget: Vec<u64>,
}

#[derive(Default)]
struct Driver {
    session: Option<Uuid>,
    url: String,
    activity: Option<Activity>,
    rate: Duration,
    seeded: bool,
    replay_revision: u64,
    deadline: Option<Instant>,
    failures: u32,
    notices: u8,
    last_notice: Option<Instant>,
}

impl Driver {
    fn configure(&mut self, settings: &Settings, rate: Duration) {
        if self.session != Some(settings.session) || self.url != settings.url {
            *self = Self {
                session: Some(settings.session),
                url: settings.url.clone(),
                ..Self::default()
            };
        }
        let replay_changed = self.replay_revision != settings.replay_revision;
        if self.activity != Some(settings.activity) || self.rate != rate || replay_changed {
            self.activity = Some(settings.activity);
            self.rate = rate;
            self.deadline = None;
            self.failures = 0;
            self.notices = 0;
            self.last_notice = None;
        }
        if settings.activity == Activity::Probe || replay_changed {
            self.seeded = false;
            self.replay_revision = settings.replay_revision;
        }
    }

    fn schedule(&mut self, success: bool) -> Result<(), String> {
        if success {
            self.failures = 0;
            self.notices = 0;
            self.last_notice = None;
        } else {
            self.failures = self.failures.saturating_add(1);
        }
        let delay = if self.seeded && self.activity == Some(Activity::Poll) && self.failures >= 5 {
            self.rate
                .saturating_mul(1 << (self.failures - 4).min(6))
                .min(Duration::from_secs(5))
        } else {
            self.rate
        };
        self.deadline = Some(deadline(delay)?);
        Ok(())
    }

    fn report_failure(&mut self) -> bool {
        let limit = if self.seeded { 6 } else { 5 };
        if self.notices >= limit
            || (self.seeded
                && self
                    .last_notice
                    .is_some_and(|t| t.elapsed() < Duration::from_secs(10)))
        {
            return false;
        }
        self.notices += 1;
        self.last_notice = Some(Instant::now());
        true
    }
}

fn deadline(delay: Duration) -> Result<Instant, String> {
    Instant::now()
        .checked_add(delay)
        .ok_or_else(|| "Invalid Anki polling interval".into())
}

async fn probe(
    client: &reqwest::Client,
    url: &reqwest::Url,
    timeout: Duration,
) -> Result<(), String> {
    let response: Value = client
        .post(url.clone())
        .json(&json!({"action":"version","version":6,"params":{}}))
        .timeout(timeout)
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .map_err(|e| e.without_url().to_string())?
        .json()
        .await
        .map_err(|e| e.without_url().to_string())?;
    if !response.is_object() || !response["error"].is_null() || response["result"].is_null() {
        return Err("AnkiConnect version probe failed".into());
    }
    Ok(())
}

impl Monitor {
    pub fn connection(&self, epoch: Option<u64>) {
        self.control.send_replace(epoch.map(|id| (id, 0)));
    }

    pub async fn request(
        &self,
        epoch: u64,
        cmd: Command,
        notes: &Notes,
        client: &reqwest::Client,
    ) -> Result<Value, String> {
        let revision = match &cmd {
            Command::Probe { url, timeout } => {
                if self.control.borrow().map(|(id, _)| id) != Some(epoch) {
                    return Err("Anki monitor connection expired".into());
                }
                let timeout = Duration::try_from_secs_f64(*timeout).map_err(|e| e.to_string())?;
                return Ok(json!(probe(client, url, timeout).await.is_ok()));
            }
            Command::Wake { revision } | Command::Next { revision, .. } => *revision,
        };
        self.control.send_if_modified(|state| {
            if let Some((active, current)) = state {
                if *active == epoch && revision > *current {
                    *current = revision;
                    return true;
                }
            }
            false
        });
        let Command::Next { settings, .. } = cmd else {
            return Ok(Value::Null);
        };
        let mut wake = self.control.subscribe();
        if *wake.borrow_and_update() != Some((epoch, revision)) {
            return Ok(Value::Null);
        }
        let mut driver = tokio::select! {
            biased;
            _ = wake.changed() => return Ok(Value::Null),
            driver = self.driver.lock() => driver,
        };
        let rate = Duration::try_from_secs_f64(settings.rate)
            .map_err(|e| e.to_string())?
            .max(Duration::from_millis(100));
        driver.configure(&settings, rate);
        let known = notes.known(settings.session)?;
        if !settings.remember.is_empty() || !settings.forget.is_empty() {
            Notes::apply(
                known.clone(),
                Vec::new(),
                Mode::Extend,
                settings.remember,
                settings.forget,
            )
            .await?;
            return Ok(json!({"acknowledged":true,"notes":[]}));
        }
        if settings.activity == Activity::Hold {
            match settings.resume_after {
                Some(seconds) => {
                    let at =
                        deadline(Duration::try_from_secs_f64(seconds).map_err(|e| e.to_string())?)?;
                    tokio::select! { _ = wake.changed() => (), _ = sleep_until(at) => () }
                }
                None => {
                    let _ = wake.changed().await;
                }
            }
            return Ok(Value::Null);
        }
        let url = reqwest::Url::parse(&settings.url).map_err(|e| e.to_string());
        loop {
            if let Some(at) = driver.deadline {
                tokio::select! { biased; _ = wake.changed() => return Ok(Value::Null), _ = sleep_until(at) => () }
            }
            let fetched = tokio::select! {
                biased;
                _ = wake.changed() => return Ok(Value::Null),
                result = async {
                    let url = url.as_ref().map_err(Clone::clone)?;
                    if settings.activity == Activity::Probe { probe(client, url, Duration::from_secs(1)).await.map(|()| Vec::new()) }
                    else { Notes::recent(client, url).await }
                } => result,
            };
            let connected = fetched.is_ok();
            driver.schedule(connected)?;
            let mut seeded = false;
            let mut ids = Vec::new();
            let mut warning = None;
            if settings.activity == Activity::Poll {
                match fetched {
                    Ok(fetched) => {
                        seeded = !driver.seeded;
                        ids = Notes::apply(
                            known.clone(),
                            fetched,
                            if seeded {
                                Mode::Replace
                            } else {
                                Mode::Difference
                            },
                            Vec::new(),
                            Vec::new(),
                        )
                        .await?;
                        driver.seeded = true;
                    }
                    Err(error) if driver.report_failure() => {
                        warning = Some(error);
                    }
                    _ => (),
                }
            }
            if seeded
                || Some(connected) != settings.connected
                || !ids.is_empty()
                || warning.is_some()
            {
                return Ok(
                    json!({"connected":connected,"notes":ids,"warning":warning,"seeding":!driver.seeded,"notice":driver.notices}),
                );
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn command(revision: u64, activity: &str) -> Command {
        serde_json::from_value(json!({
            "action":"next","revision":revision,"activity":activity,"rate":0.1,"replay_revision":1,
            "session":"d4e6ffcb-62f6-46a0-ba15-e499f93873c9","url":"http://127.0.0.1:1/",
            "connected":false,"resume_after":null,"remember":[],"forget":[]
        }))
        .unwrap()
    }

    #[tokio::test]
    async fn wake_before_wait_disconnect_and_old_commands_cannot_strand_a_monitor() {
        let service = Monitor::default();
        let client = reqwest::Client::new();
        let notes = Notes::default();
        service.connection(Some(7));
        service
            .request(7, Command::Wake { revision: 3 }, &notes, &client)
            .await
            .unwrap();
        assert!(service
            .request(7, command(2, "hold"), &notes, &client)
            .await
            .unwrap()
            .is_null());
        let wait = service.request(7, command(3, "hold"), &notes, &client);
        tokio::pin!(wait);
        assert!(tokio::time::timeout(Duration::from_millis(10), &mut wait)
            .await
            .is_err());
        service.connection(None);
        assert!(wait.await.unwrap().is_null());
        service.connection(Some(8));
        service
            .request(7, Command::Wake { revision: 99 }, &notes, &client)
            .await
            .unwrap();
        assert_eq!(*service.control.borrow(), Some((8, 0)));
    }

    #[test]
    fn replay_transitions_seed_again_and_only_poll_failures_back_off() {
        let mut state = Driver::default();
        let Command::Next { mut settings, .. } = command(0, "poll") else {
            unreachable!()
        };
        let base = Duration::from_millis(100);
        state.configure(&settings, base);
        state.seeded = true;
        for _ in 0..5 {
            state.schedule(false).unwrap();
        }
        assert!(
            state.deadline.unwrap().duration_since(Instant::now()) > Duration::from_millis(150)
        );
        // A rapid stop and start may reach the driver as one revision.
        settings.replay_revision += 2;
        state.configure(&settings, base);
        assert!(state.deadline.is_none());
        assert!(!state.seeded);
        assert_eq!(state.failures, 0);
        state.seeded = true;
        state.schedule(true).unwrap();
        assert_eq!(state.failures, 0);
        settings.activity = Activity::Hold;
        state.configure(&settings, base);
        assert!(state.seeded);
        settings.replay_revision += 1;
        settings.activity = Activity::Poll;
        state.configure(&settings, base);
        assert!(!state.seeded);
    }
}
