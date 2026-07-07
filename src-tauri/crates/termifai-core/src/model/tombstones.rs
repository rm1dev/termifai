use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash, Debug)]
#[serde(rename_all = "lowercase")]
pub enum EntityKind {
    Host,
    Group,
    Snippet,
    PortForward,
    SshKey,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Tombstone {
    pub entity: EntityKind,
    pub id: String,
    pub deleted_at: String,
}

fn default_version() -> u32 {
    1
}

#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TombstonesVault {
    #[serde(default = "default_version")]
    pub version: u32,
    #[serde(default)]
    pub tombstones: Vec<Tombstone>,
}

pub fn migrate_tombstones_vault(value: &mut serde_json::Value) {
    if value.get("version").is_none() {
        if let Some(obj) = value.as_object_mut() {
            obj.insert("version".to_string(), serde_json::Value::from(1u32));
        }
    }
}

/// Drop tombstones older than `max_age_days` — they can no longer affect a
/// merge against any plausibly-still-offline device.
pub fn prune_older_than(tombstones: &mut Vec<Tombstone>, cutoff_rfc3339: &str) {
    tombstones.retain(|t| t.deleted_at.as_str() >= cutoff_rfc3339);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prune_removes_entries_older_than_cutoff() {
        let mut tombstones = vec![
            Tombstone { entity: EntityKind::Host, id: "a".into(), deleted_at: "2025-01-01T00:00:00Z".into() },
            Tombstone { entity: EntityKind::Host, id: "b".into(), deleted_at: "2026-06-01T00:00:00Z".into() },
        ];
        prune_older_than(&mut tombstones, "2026-01-01T00:00:00Z");
        assert_eq!(tombstones.len(), 1);
        assert_eq!(tombstones[0].id, "b");
    }
}
