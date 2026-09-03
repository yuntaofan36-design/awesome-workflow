use std::collections::HashSet;

use chrono::{TimeZone, Utc};
use chrono_tz::Tz;
use croner::Cron;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{
    authorization::authorization_intent_hash, AgentError, AgentResult, AuthorizationLease,
    AuthorizationTaskKind,
};

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScheduleRecord {
    pub schedule_id: String,
    pub revision: u64,
    pub application_id: String,
    pub release_id: String,
    pub app_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    pub cron_expression: String,
    pub timezone: String,
    pub next_run_at_ms: u64,
    #[serde(default)]
    pub args: Vec<String>,
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub authorization_lease: Option<AuthorizationLease>,
}

impl ScheduleRecord {
    pub(crate) fn validate(&self) -> AgentResult<()> {
        if Uuid::parse_str(&self.schedule_id).is_err() {
            return invalid_schedule(&self.schedule_id, "scheduleId must be a UUID");
        }
        if self.revision == 0 || self.revision > MAX_SAFE_INTEGER {
            return invalid_schedule(
                &self.schedule_id,
                "revision must be a positive safe integer",
            );
        }
        if Uuid::parse_str(&self.application_id).is_err()
            || Uuid::parse_str(&self.release_id).is_err()
        {
            return invalid_schedule(
                &self.schedule_id,
                "applicationId and releaseId must be UUIDs",
            );
        }
        if !is_application_slug(&self.app_id) {
            return invalid_schedule(&self.schedule_id, "appId must be a lowercase slug");
        }
        if self
            .version
            .as_deref()
            .is_some_and(|value| !is_contract_semver(value))
        {
            return invalid_schedule(&self.schedule_id, "version must be semantic");
        }
        if self.cron_expression.is_empty() || self.cron_expression.len() > 160 {
            return invalid_schedule(&self.schedule_id, "cronExpression has an invalid length");
        }
        if self.timezone.is_empty() || self.timezone.len() > 120 {
            return invalid_schedule(&self.schedule_id, "timezone has an invalid length");
        }
        if self.next_run_at_ms > MAX_SAFE_INTEGER {
            return invalid_schedule(
                &self.schedule_id,
                "nextRunAtMs exceeds the JSON safe-integer range",
            );
        }
        if self.args.len() > 256 || self.args.iter().any(|argument| argument.len() > 8_192) {
            return invalid_schedule(&self.schedule_id, "args exceed the execution limits");
        }
        if let Some(lease) = &self.authorization_lease {
            lease.validate()?;
            if lease.claims.task.kind != AuthorizationTaskKind::Schedule
                || lease.claims.task.id != self.schedule_id
                || lease.claims.revision != self.revision
                || lease.claims.application_id != self.application_id
                || lease.claims.release_id != self.release_id
                || lease.claims.app_id != self.app_id
                || self
                    .version
                    .as_deref()
                    .is_some_and(|version| version != lease.claims.version)
                || lease.claims.intent_hash != self.authorization_intent_hash()?
            {
                return invalid_schedule(
                    &self.schedule_id,
                    "authorization lease scope does not match the schedule",
                );
            }
        }
        Ok(())
    }

    pub(crate) fn authorization_intent_hash(&self) -> AgentResult<String> {
        let mut intent = serde_json::to_value(self)?;
        intent
            .as_object_mut()
            .ok_or_else(|| AgentError::State("schedule intent is not an object".into()))?
            .remove("authorizationLease");
        authorization_intent_hash(&intent)
    }

    pub(crate) fn validate_recurrence(&self) -> AgentResult<()> {
        self.parsed_cron_and_timezone().map(|_| ())
    }

    pub(crate) fn next_occurrence_after(&self, after_ms: u64) -> AgentResult<u64> {
        self.validate()?;
        let (cron, timezone) = self.parsed_cron_and_timezone()?;
        let timestamp: i64 = after_ms.try_into().map_err(|_| {
            AgentError::State(format!(
                "invalid schedule {}: timestamp is out of range",
                self.schedule_id
            ))
        })?;
        let start = Utc
            .timestamp_millis_opt(timestamp)
            .single()
            .ok_or_else(|| {
                AgentError::State(format!(
                    "invalid schedule {}: timestamp is out of range",
                    self.schedule_id
                ))
            })?
            .with_timezone(&timezone);
        let next = cron.find_next_occurrence(&start, false).map_err(|_| {
            AgentError::State(format!(
                "invalid schedule {}: no next cron occurrence",
                self.schedule_id
            ))
        })?;
        let next_ms: u64 = next.timestamp_millis().try_into().map_err(|_| {
            AgentError::State(format!(
                "invalid schedule {}: next occurrence is out of range",
                self.schedule_id
            ))
        })?;
        if next_ms <= after_ms || next_ms > MAX_SAFE_INTEGER {
            return invalid_schedule(
                &self.schedule_id,
                "next cron occurrence is not a safe future timestamp",
            );
        }
        Ok(next_ms)
    }

    fn parsed_cron_and_timezone(&self) -> AgentResult<(Cron, Tz)> {
        let cron = Cron::new(&self.cron_expression).parse().map_err(|_| {
            AgentError::State(format!(
                "invalid schedule {}: cronExpression is invalid",
                self.schedule_id
            ))
        })?;
        let timezone = self.timezone.parse::<Tz>().map_err(|_| {
            AgentError::State(format!(
                "invalid schedule {}: timezone is unknown",
                self.schedule_id
            ))
        })?;
        Ok((cron, timezone))
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScheduleSnapshot {
    pub revision: u64,
    pub schedules: Vec<ScheduleRecord>,
}

impl ScheduleSnapshot {
    pub(crate) fn validate(&self) -> AgentResult<()> {
        validate_revision(self.revision)?;
        let mut schedule_ids = HashSet::new();
        for schedule in &self.schedules {
            schedule.validate()?;
            if !schedule_ids.insert(schedule.schedule_id.as_str()) {
                return invalid_schedule(&schedule.schedule_id, "duplicate schedule in snapshot");
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScheduleDelta {
    pub from_revision: u64,
    pub to_revision: u64,
    pub upserts: Vec<ScheduleRecord>,
    pub removed_schedule_ids: Vec<String>,
}

impl ScheduleDelta {
    pub(crate) fn validate(&self) -> AgentResult<()> {
        validate_revision(self.from_revision)?;
        validate_revision(self.to_revision)?;
        if self.to_revision < self.from_revision {
            return Err(AgentError::State(
                "schedule delta toRevision precedes fromRevision".into(),
            ));
        }

        let mut upserted = HashSet::new();
        for schedule in &self.upserts {
            schedule.validate()?;
            if !upserted.insert(schedule.schedule_id.as_str()) {
                return invalid_schedule(&schedule.schedule_id, "duplicate schedule in delta");
            }
        }
        let mut removed = HashSet::new();
        for schedule_id in &self.removed_schedule_ids {
            if Uuid::parse_str(schedule_id).is_err() {
                return invalid_schedule(schedule_id, "removedScheduleId must be a UUID");
            }
            if !removed.insert(schedule_id.as_str()) {
                return invalid_schedule(schedule_id, "duplicate removal in delta");
            }
            if upserted.contains(schedule_id.as_str()) {
                return invalid_schedule(schedule_id, "schedule is both upserted and removed");
            }
        }
        if self.to_revision == self.from_revision
            && (!self.upserts.is_empty() || !self.removed_schedule_ids.is_empty())
        {
            return Err(AgentError::State(
                "schedule delta changes data without advancing revision".into(),
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncState {
    pub revision: u64,
    pub offline: bool,
    pub last_sync_at: Option<u64>,
}

fn validate_revision(revision: u64) -> AgentResult<()> {
    if revision > MAX_SAFE_INTEGER {
        return Err(AgentError::State(
            "schedule revision exceeds the JSON safe-integer range".into(),
        ));
    }
    Ok(())
}

fn invalid_schedule<T>(schedule_id: &str, reason: &str) -> AgentResult<T> {
    Err(AgentError::State(format!(
        "invalid schedule {schedule_id}: {reason}"
    )))
}

pub(crate) fn is_application_slug(value: &str) -> bool {
    if !(3..=64).contains(&value.len()) {
        return false;
    }
    let mut segments = value.split('-');
    let Some(first) = segments.next() else {
        return false;
    };
    let first_valid = first
        .bytes()
        .enumerate()
        .all(|(index, byte)| byte.is_ascii_lowercase() || (index > 0 && byte.is_ascii_digit()));
    first_valid
        && !first.is_empty()
        && segments.all(|segment| {
            !segment.is_empty()
                && segment
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        })
}

pub(crate) fn is_contract_semver(value: &str) -> bool {
    let (core, suffix) = value
        .split_once('-')
        .map_or((value, None), |(core, suffix)| (core, Some(suffix)));
    let mut parts = core.split('.');
    let valid_core = (0..3).all(|_| {
        parts
            .next()
            .is_some_and(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
    }) && parts.next().is_none();
    valid_core
        && suffix.is_none_or(|suffix| {
            !suffix.is_empty()
                && suffix
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-'))
        })
}

#[cfg(test)]
mod tests {
    use chrono::DateTime;
    use tempfile::tempdir;

    use crate::db::Database;

    use super::*;

    const SCHEDULE_ID: &str = "3cf60eb1-9355-48d0-8d2f-97b3c307f0cf";

    fn epoch_ms(value: &str) -> u64 {
        DateTime::parse_from_rfc3339(value)
            .unwrap()
            .timestamp_millis()
            .try_into()
            .unwrap()
    }

    fn schedule(cron_expression: &str, timezone: &str, next_run_at_ms: u64) -> ScheduleRecord {
        ScheduleRecord {
            schedule_id: SCHEDULE_ID.into(),
            revision: 1,
            application_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".into(),
            release_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb".into(),
            app_id: "demo-app".into(),
            version: Some("1.2.3".into()),
            cron_expression: cron_expression.into(),
            timezone: timezone.into(),
            next_run_at_ms,
            args: vec![],
            enabled: true,
            authorization_lease: None,
        }
    }

    fn authorized_schedule() -> ScheduleRecord {
        let mut record = schedule("0 * * * *", "UTC", 1_800_000_600_000);
        record.args = vec!["--safe".into()];
        let intent_hash = record.authorization_intent_hash().unwrap();
        record.authorization_lease = Some(AuthorizationLease {
            claims: crate::AuthorizationLeaseClaims {
                schema_version: 1,
                lease_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc".into(),
                revision: record.revision,
                device_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd".into(),
                application_id: record.application_id.clone(),
                release_id: record.release_id.clone(),
                app_id: record.app_id.clone(),
                version: record.version.clone().unwrap(),
                task: crate::AuthorizationLeaseTask {
                    kind: AuthorizationTaskKind::Schedule,
                    id: record.schedule_id.clone(),
                },
                capability_hash: "a".repeat(64),
                intent_hash,
                issued_at: 1_800_000_000_000,
                expires_at: 1_800_000_300_000,
            },
            signature: crate::AuthorizationLeaseSignature {
                algorithm: "ed25519".into(),
                key_id: "intent-test".into(),
                value: "A".repeat(88),
            },
        });
        record
    }

    #[test]
    fn schedule_authorization_rejects_every_mutated_execution_intent_field() {
        let record = authorized_schedule();
        record.validate().unwrap();

        let mut variants = Vec::new();
        let mut cron = record.clone();
        cron.cron_expression = "*/2 * * * *".into();
        variants.push(cron);
        let mut timezone = record.clone();
        timezone.timezone = "Asia/Shanghai".into();
        variants.push(timezone);
        let mut next_run = record.clone();
        next_run.next_run_at_ms += 1;
        variants.push(next_run);
        let mut args = record.clone();
        args.args = vec!["--unsafe".into()];
        variants.push(args);
        let mut enabled = record;
        enabled.enabled = false;
        variants.push(enabled);

        assert!(variants
            .into_iter()
            .all(|variant| variant.validate().is_err()));
    }

    #[test]
    fn stale_or_equal_revision_cannot_replace_locally_advanced_schedule_state() {
        let directory = tempdir().unwrap();
        let database = Database::open(&directory.path().join("state.db")).unwrap();
        let now = epoch_ms("2025-01-01T00:00:00Z");
        let first = ScheduleSnapshot {
            revision: 8,
            schedules: vec![schedule("* * * * *", "UTC", now + 60_000)],
        };
        assert!(database.apply_schedule_snapshot(&first, now).unwrap());
        let claimed = database.claim_due_schedules(now + 180_000).unwrap();
        assert_eq!(claimed.len(), 1);
        let locally_advanced = database.due_schedules(MAX_SAFE_INTEGER).unwrap()[0].next_run_at_ms;

        assert!(!database
            .apply_schedule_snapshot(&first, now + 181_000)
            .unwrap());
        assert_eq!(
            database.due_schedules(MAX_SAFE_INTEGER).unwrap()[0].next_run_at_ms,
            locally_advanced
        );
        assert!(!database
            .apply_schedule_snapshot(
                &ScheduleSnapshot {
                    revision: 7,
                    schedules: vec![]
                },
                now + 182_000,
            )
            .unwrap());
        assert_eq!(database.sync_state().unwrap().revision, 8);
        database.mark_offline().unwrap();
        assert!(database.sync_state().unwrap().offline);
    }

    #[test]
    fn spring_gap_and_fall_overlap_are_advanced_without_duplicate_wall_clock_runs() {
        let spring = schedule(
            "30 2 * * *",
            "America/New_York",
            epoch_ms("2025-03-09T06:59:00Z"),
        );
        assert_eq!(
            spring
                .next_occurrence_after(epoch_ms("2025-03-09T06:59:00Z"))
                .unwrap(),
            epoch_ms("2025-03-09T07:00:00Z")
        );

        let fall = schedule(
            "30 1 * * *",
            "America/New_York",
            epoch_ms("2025-11-02T05:30:00Z"),
        );
        assert_eq!(
            fall.next_occurrence_after(epoch_ms("2025-11-02T05:30:00Z"))
                .unwrap(),
            epoch_ms("2025-11-03T06:30:00Z")
        );
    }
}
