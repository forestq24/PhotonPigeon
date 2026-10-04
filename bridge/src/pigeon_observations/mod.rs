//! Bounded in-memory replay for independent observers. No disk writes or network calls.
use std::collections::VecDeque;
use serde_json::{json, Value};

pub struct Journal {
    pub epoch: String,
    latest: u64,
    capacity: usize,
    events: VecDeque<Value>,
}

impl Journal {
    pub fn new(epoch: String, capacity: usize) -> Self {
        Self { epoch, latest: 0, capacity, events: VecDeque::new() }
    }

    pub fn ready(&self) -> Value {
        json!({ "epoch": self.epoch, "latest": self.latest })
    }

    pub fn record(&mut self, mut event: Value) -> String {
        self.latest += 1;
        event["stream_epoch"] = json!(self.epoch);
        event["stream_seq"] = json!(self.latest);
        self.events.push_back(event.clone());
        while self.events.len() > self.capacity { self.events.pop_front(); }
        event.to_string()
    }

    pub fn replay(&self, epoch: &str, after: u64) -> Value {
        let oldest = self.events.front().and_then(|e| e["stream_seq"].as_u64()).unwrap_or(self.latest + 1);
        let complete = epoch == self.epoch && after <= self.latest && after.saturating_add(1) >= oldest;
        let events: Vec<&Value> = self.events.iter().filter(|e| e["stream_seq"].as_u64().unwrap_or(0) > after || epoch != self.epoch).collect();
        json!({ "epoch": self.epoch, "latest": self.latest, "oldest": oldest, "complete": complete, "events": events })
    }
}

/// Only constructed after send_balloon succeeds. Accepted is not delivered/read.
pub fn sent_card(request: &Value, id: &str, timestamp_ms: u64) -> Value {
    let mut balloon = json!({});
    for key in ["bundle_id", "app_name", "adam_id", "url", "session", "caption", "subcaption", "ld_text", "live", "icon_b64"] {
        if let Some(value) = request.get(key) { balloon[key] = value.clone(); }
    }
    json!({ "type": "sent_card", "id": id, "chat": request["chat"], "from_me": true,
        "is_group": false, "timestamp_ms": timestamp_ms, "source": "transport_send",
        "accepted": true, "balloon": balloon })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn replay_detects_overflow_restart_and_future_cursors() {
        let mut j = Journal::new("boot-a".into(), 2);
        j.record(json!({"type":"message", "id":"1"}));
        j.record(json!({"type":"message", "id":"2"}));
        assert_eq!(j.replay("boot-a", 0)["complete"], true);
        j.record(json!({"type":"message", "id":"3"}));
        assert_eq!(j.replay("boot-a", 0)["complete"], false);
        assert_eq!(j.replay("boot-a", 1)["complete"], true);
        assert_eq!(j.replay("other", 3)["complete"], false);
        assert_eq!(j.replay("boot-a", 99)["complete"], false);
    }
    #[test]
    fn preserves_exact_card_and_request() {
        let req = json!({"chat":"tel:synthetic", "url":"data:exact", "session":"s", "reply_to":"previous", "bundle_id":"game"});
        let before = req.clone();
        let event = sent_card(&req, "ack", 123);
        assert_eq!(req, before);
        assert_eq!(event["balloon"]["url"], req["url"]);
        assert_eq!(event["id"], "ack");
        assert_eq!(event["accepted"], true);
    }
}
