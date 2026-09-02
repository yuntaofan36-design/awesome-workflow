use std::{collections::HashSet, path::Path, sync::Mutex};

use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};

use crate::{
    control_plane::{InstallationStatusReport, ReportRunStatus, RunClaim, RunControl, RunReport},
    scheduler::{ScheduleDelta, ScheduleRecord, ScheduleSnapshot, SyncState},
    AgentError, AgentResult, AppletManifest, Capability, InstalledApplet, TaskRecord,
};

pub(crate) struct Database {
    connection: Mutex<Connection>,
}

pub(crate) struct LeaseRecord {
    pub app_id: String,
    pub task_id: String,
    pub capabilities: Vec<Capability>,
    pub expires_at: u64,
}

impl Database {
    pub fn open(path: &Path) -> AgentResult<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut connection = Connection::open(path)?;
        connection.pragma_update(None, "journal_mode", "WAL")?;
        connection.pragma_update(None, "foreign_keys", "ON")?;
        connection.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS installed_apps (
              app_id TEXT NOT NULL, version TEXT NOT NULL, manifest_json TEXT NOT NULL,
              install_path TEXT NOT NULL, installed_at INTEGER NOT NULL,
              active INTEGER NOT NULL DEFAULT 0, managed INTEGER NOT NULL DEFAULT 1,
              PRIMARY KEY (app_id, version)
            );
            CREATE UNIQUE INDEX IF NOT EXISTS one_active_version
              ON installed_apps(app_id) WHERE active = 1;
            CREATE TABLE IF NOT EXISTS tasks (
              task_id TEXT PRIMARY KEY, app_id TEXT NOT NULL, version TEXT NOT NULL,
              status TEXT NOT NULL, pid INTEGER, log_path TEXT NOT NULL,
              started_at INTEGER NOT NULL, finished_at INTEGER
            );
            CREATE TABLE IF NOT EXISTS leases (
              lease_hash TEXT PRIMARY KEY, app_id TEXT NOT NULL, task_id TEXT NOT NULL,
              capabilities_json TEXT NOT NULL, expires_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS schedules (
              schedule_id TEXT PRIMARY KEY, app_id TEXT NOT NULL, version TEXT,
              cron_expression TEXT NOT NULL, timezone TEXT NOT NULL,
              next_run_at_ms INTEGER NOT NULL, args_json TEXT NOT NULL, enabled INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS sync_state (
              singleton INTEGER PRIMARY KEY CHECK(singleton = 1), revision INTEGER NOT NULL,
              offline INTEGER NOT NULL, last_sync_at INTEGER
            );
            INSERT OR IGNORE INTO sync_state(singleton, revision, offline, last_sync_at)
              VALUES (1, 0, 1, NULL);
            CREATE TABLE IF NOT EXISTS remote_runs (
              run_id TEXT PRIMARY KEY, attempt INTEGER NOT NULL,
              app_id TEXT NOT NULL, version TEXT NOT NULL, args_json TEXT NOT NULL,
              requires_elevation INTEGER NOT NULL, task_id TEXT,
              state TEXT NOT NULL, claimed_at_ms INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS run_report_outbox (
              outbox_id INTEGER PRIMARY KEY AUTOINCREMENT,
              run_id TEXT NOT NULL, attempt INTEGER NOT NULL, status TEXT NOT NULL,
              report_json TEXT NOT NULL, next_attempt_at_ms INTEGER NOT NULL,
              delivery_attempts INTEGER NOT NULL DEFAULT 0,
              UNIQUE(run_id, attempt, status)
            );
            CREATE TABLE IF NOT EXISTS installation_sync_state (
              singleton INTEGER PRIMARY KEY CHECK(singleton = 1), revision INTEGER NOT NULL
            );
            INSERT OR IGNORE INTO installation_sync_state(singleton, revision) VALUES (1, 0);
            CREATE TABLE IF NOT EXISTS installation_report_outbox (
              outbox_id INTEGER PRIMARY KEY AUTOINCREMENT,
              installation_id TEXT NOT NULL, status TEXT NOT NULL,
              report_json TEXT NOT NULL, next_attempt_at_ms INTEGER NOT NULL,
              delivery_attempts INTEGER NOT NULL DEFAULT 0,
              UNIQUE(installation_id, status)
            );
            "#,
        )?;
        migrate_legacy_schedule_schema(&mut connection)?;
        Ok(Self {
            connection: Mutex::new(connection),
        })
    }

    pub fn activate_install(
        &self,
        manifest: &AppletManifest,
        install_path: &Path,
        installed_at: u64,
        managed: bool,
    ) -> AgentResult<()> {
        let mut connection = self.lock()?;
        let transaction = connection.transaction()?;
        transaction.execute(
            "UPDATE installed_apps SET active = 0 WHERE app_id = ?1",
            params![manifest.app_id],
        )?;
        transaction.execute(
            r#"INSERT INTO installed_apps(
                 app_id, version, manifest_json, install_path, installed_at, active, managed
               ) VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6)
               ON CONFLICT(app_id, version) DO UPDATE SET
                 manifest_json = excluded.manifest_json, install_path = excluded.install_path,
                 installed_at = excluded.installed_at, active = 1, managed = excluded.managed"#,
            params![
                manifest.app_id,
                manifest.version.to_string(),
                serde_json::to_string(manifest)?,
                install_path.to_string_lossy(),
                installed_at as i64,
                managed,
            ],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn installed(&self) -> AgentResult<Vec<InstalledApplet>> {
        let connection = self.lock()?;
        let mut statement = connection.prepare(
            "SELECT manifest_json, install_path, installed_at, active, managed FROM installed_apps ORDER BY app_id, version",
        )?;
        let values = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, bool>(3)?,
                    row.get::<_, bool>(4)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        values
            .into_iter()
            .map(|record| {
                Ok(InstalledApplet {
                    manifest: serde_json::from_str(&record.0)?,
                    install_path: record.1.into(),
                    installed_at: record.2 as u64,
                    active: record.3,
                    managed: record.4,
                })
            })
            .collect()
    }

    pub fn active_install(
        &self,
        app_id: &str,
        version: Option<&str>,
    ) -> AgentResult<InstalledApplet> {
        let connection = self.lock()?;
        let mapper = |row: &rusqlite::Row<'_>| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, bool>(3)?,
                row.get::<_, bool>(4)?,
            ))
        };
        let record = match version {
            Some(version) => connection.query_row(
                "SELECT manifest_json, install_path, installed_at, active, managed FROM installed_apps WHERE app_id = ?1 AND version = ?2",
                params![app_id, version], mapper,
            ).optional()?,
            None => connection.query_row(
                "SELECT manifest_json, install_path, installed_at, active, managed FROM installed_apps WHERE app_id = ?1 AND active = 1",
                params![app_id], mapper,
            ).optional()?,
        }.ok_or_else(|| AgentError::NotInstalled(app_id.into(), version.unwrap_or("active").into()))?;
        Ok(InstalledApplet {
            manifest: serde_json::from_str(&record.0)?,
            install_path: record.1.into(),
            installed_at: record.2 as u64,
            active: record.3,
            managed: record.4,
        })
    }

    pub fn remove_install(&self, app_id: &str, version: &str) -> AgentResult<InstalledApplet> {
        let installed = self.active_install(app_id, Some(version))?;
        self.lock()?.execute(
            "DELETE FROM installed_apps WHERE app_id = ?1 AND version = ?2",
            params![app_id, version],
        )?;
        Ok(installed)
    }

    pub fn insert_task(&self, task: &TaskRecord) -> AgentResult<()> {
        self.lock()?.execute(
            "INSERT INTO tasks(task_id, app_id, version, status, pid, log_path, started_at, finished_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![task.task_id, task.app_id, task.version, task.status, task.pid,
                task.log_path.to_string_lossy(), task.started_at as i64, task.finished_at.map(|value| value as i64)],
        )?;
        Ok(())
    }

    pub fn update_task(
        &self,
        task_id: &str,
        status: &str,
        finished_at: Option<u64>,
    ) -> AgentResult<()> {
        self.lock()?.execute(
            "UPDATE tasks SET status = ?2, finished_at = ?3 WHERE task_id = ?1",
            params![task_id, status, finished_at.map(|value| value as i64)],
        )?;
        Ok(())
    }

    pub fn tasks(&self) -> AgentResult<Vec<TaskRecord>> {
        let connection = self.lock()?;
        let mut statement = connection.prepare(
            "SELECT task_id, app_id, version, status, pid, log_path, started_at, finished_at FROM tasks ORDER BY started_at DESC",
        )?;
        let rows = statement
            .query_map([], task_from_row)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn task(&self, task_id: &str) -> AgentResult<TaskRecord> {
        self.lock()?.query_row(
            "SELECT task_id, app_id, version, status, pid, log_path, started_at, finished_at FROM tasks WHERE task_id = ?1",
            params![task_id], task_from_row,
        ).optional()?.ok_or_else(|| AgentError::TaskNotFound(task_id.into()))
    }

    pub fn insert_lease(
        &self,
        lease_hash: &str,
        app_id: &str,
        task_id: &str,
        capabilities: &[Capability],
        expires_at: u64,
    ) -> AgentResult<()> {
        self.lock()?.execute(
            "INSERT INTO leases(lease_hash, app_id, task_id, capabilities_json, expires_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![lease_hash, app_id, task_id, serde_json::to_string(capabilities)?, expires_at as i64],
        )?;
        Ok(())
    }

    pub fn lease(&self, lease_hash: &str) -> AgentResult<Option<LeaseRecord>> {
        let record = self.lock()?.query_row(
            "SELECT app_id, task_id, capabilities_json, expires_at FROM leases WHERE lease_hash = ?1",
            params![lease_hash], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, i64>(3)?)),
        ).optional()?;
        record
            .map(|record| {
                Ok(LeaseRecord {
                    app_id: record.0,
                    task_id: record.1,
                    capabilities: serde_json::from_str(&record.2)?,
                    expires_at: record.3 as u64,
                })
            })
            .transpose()
    }

    pub fn revoke_task_leases(&self, task_id: &str) -> AgentResult<()> {
        self.lock()?
            .execute("DELETE FROM leases WHERE task_id = ?1", params![task_id])?;
        Ok(())
    }

    pub fn sync_state(&self) -> AgentResult<SyncState> {
        self.lock()?
            .query_row(
                "SELECT revision, offline, last_sync_at FROM sync_state WHERE singleton = 1",
                [],
                |row| {
                    Ok(SyncState {
                        revision: row.get::<_, i64>(0)? as u64,
                        offline: row.get(1)?,
                        last_sync_at: row.get::<_, Option<i64>>(2)?.map(|value| value as u64),
                    })
                },
            )
            .map_err(Into::into)
    }

    pub fn apply_schedule_snapshot(
        &self,
        snapshot: &ScheduleSnapshot,
        now_ms: u64,
    ) -> AgentResult<bool> {
        snapshot.validate()?;
        let mut connection = self.lock()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current = transaction.query_row(
            "SELECT revision FROM sync_state WHERE singleton = 1",
            [],
            |row| row.get::<_, i64>(0),
        )? as u64;
        if snapshot.revision < current {
            return Ok(false);
        }
        if snapshot.revision == current {
            mark_sync_success(&transaction, current, now_ms)?;
            transaction.commit()?;
            return Ok(false);
        }
        transaction.execute("DELETE FROM schedules", [])?;
        for schedule in &snapshot.schedules {
            let normalized = normalize_synced_schedule(schedule, now_ms);
            insert_schedule(&transaction, &normalized)?;
        }
        mark_sync_success(&transaction, snapshot.revision, now_ms)?;
        transaction.commit()?;
        Ok(true)
    }

    pub fn apply_schedule_delta(&self, delta: &ScheduleDelta, now_ms: u64) -> AgentResult<bool> {
        delta.validate()?;
        let mut connection = self.lock()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current = transaction.query_row(
            "SELECT revision FROM sync_state WHERE singleton = 1",
            [],
            |row| row.get::<_, i64>(0),
        )? as u64;
        if delta.from_revision != current {
            return Err(AgentError::State(format!(
                "schedule delta starts at revision {}, but local state is revision {current}",
                delta.from_revision
            )));
        }
        if delta.to_revision == current {
            mark_sync_success(&transaction, current, now_ms)?;
            transaction.commit()?;
            return Ok(false);
        }
        for schedule_id in &delta.removed_schedule_ids {
            transaction.execute(
                "DELETE FROM schedules WHERE schedule_id = ?1",
                params![schedule_id],
            )?;
        }
        for schedule in &delta.upserts {
            let normalized = normalize_synced_schedule(schedule, now_ms);
            insert_schedule(&transaction, &normalized)?;
        }
        mark_sync_success(&transaction, delta.to_revision, now_ms)?;
        transaction.commit()?;
        Ok(true)
    }

    pub fn mark_offline(&self) -> AgentResult<()> {
        self.lock()?
            .execute("UPDATE sync_state SET offline = 1 WHERE singleton = 1", [])?;
        Ok(())
    }

    pub fn installation_sync_revision(&self) -> AgentResult<u64> {
        let revision = self.lock()?.query_row(
            "SELECT revision FROM installation_sync_state WHERE singleton = 1",
            [],
            |row| row.get::<_, i64>(0),
        )?;
        revision
            .try_into()
            .map_err(|_| AgentError::State("stored installation sync revision is invalid".into()))
    }

    pub fn commit_installation_sync_revision(&self, revision: u64) -> AgentResult<bool> {
        let revision = sql_integer(revision, "installation sync revision")?;
        let mut connection = self.lock()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current = transaction.query_row(
            "SELECT revision FROM installation_sync_state WHERE singleton = 1",
            [],
            |row| row.get::<_, i64>(0),
        )?;
        if revision < current {
            return Err(AgentError::State(
                "installation snapshot is older than the committed local revision".into(),
            ));
        }
        if revision == current {
            transaction.commit()?;
            return Ok(false);
        }
        transaction.execute(
            "UPDATE installation_sync_state SET revision = ?1 WHERE singleton = 1",
            params![revision],
        )?;
        transaction.commit()?;
        Ok(true)
    }

    pub fn enqueue_installation_report(
        &self,
        installation_id: &str,
        report: &InstallationStatusReport,
        now_ms: u64,
    ) -> AgentResult<()> {
        if uuid::Uuid::parse_str(installation_id).is_err() {
            return Err(AgentError::State(
                "installation report ID is invalid".into(),
            ));
        }
        report.validate()?;
        self.lock()?.execute(
            "INSERT OR IGNORE INTO installation_report_outbox(installation_id, status, report_json, next_attempt_at_ms, delivery_attempts) VALUES (?1, ?2, ?3, ?4, 0)",
            params![
                installation_id,
                report.status.as_str(),
                serde_json::to_string(report)?,
                sql_integer(now_ms, "installation outbox time")?,
            ],
        )?;
        Ok(())
    }

    pub fn due_installation_reports(
        &self,
        now_ms: u64,
    ) -> AgentResult<Vec<InstallationReportOutboxEntry>> {
        let connection = self.lock()?;
        let mut statement = connection.prepare(
            "SELECT outbox_id, installation_id, report_json, delivery_attempts FROM installation_report_outbox WHERE next_attempt_at_ms <= ?1 ORDER BY outbox_id",
        )?;
        let rows = statement
            .query_map(
                params![sql_integer(now_ms, "installation outbox clock")?],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, i64>(3)?,
                    ))
                },
            )?
            .collect::<Result<Vec<_>, _>>()?;
        rows.into_iter()
            .map(|row| {
                Ok(InstallationReportOutboxEntry {
                    outbox_id: row.0,
                    installation_id: row.1,
                    report: serde_json::from_str(&row.2)?,
                    delivery_attempts: row.3.max(0) as u32,
                })
            })
            .collect()
    }

    pub fn acknowledge_installation_report(&self, outbox_id: i64) -> AgentResult<()> {
        self.lock()?.execute(
            "DELETE FROM installation_report_outbox WHERE outbox_id = ?1",
            params![outbox_id],
        )?;
        Ok(())
    }

    pub fn retry_installation_report(
        &self,
        outbox_id: i64,
        next_attempt_at_ms: u64,
    ) -> AgentResult<()> {
        self.lock()?.execute(
            "UPDATE installation_report_outbox SET delivery_attempts = delivery_attempts + 1, next_attempt_at_ms = ?2 WHERE outbox_id = ?1",
            params![
                outbox_id,
                sql_integer(next_attempt_at_ms, "installation outbox retry time")?
            ],
        )?;
        Ok(())
    }

    pub fn due_schedules(&self, now_ms: u64) -> AgentResult<Vec<ScheduleRecord>> {
        let now_ms = sql_integer(now_ms, "schedule clock")?;
        let connection = self.lock()?;
        let mut statement = connection.prepare(
            "SELECT schedule_id, app_id, version, cron_expression, timezone, next_run_at_ms, args_json, enabled FROM schedules WHERE enabled = 1 AND next_run_at_ms <= ?1 ORDER BY next_run_at_ms, schedule_id",
        )?;
        let rows = statement
            .query_map(params![now_ms], schedule_row_from_db)?
            .collect::<Result<Vec<_>, _>>()?;
        rows.into_iter().map(ScheduleRow::into_record).collect()
    }

    pub fn claim_due_schedules(&self, now_ms: u64) -> AgentResult<Vec<ScheduleRecord>> {
        let now_sql = sql_integer(now_ms, "schedule clock")?;
        let mut connection = self.lock()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let rows = {
            let mut statement = transaction.prepare(
                "SELECT schedule_id, app_id, version, cron_expression, timezone, next_run_at_ms, args_json, enabled FROM schedules WHERE enabled = 1 AND next_run_at_ms <= ?1 ORDER BY next_run_at_ms, schedule_id",
            )?;
            let rows = statement
                .query_map(params![now_sql], schedule_row_from_db)?
                .collect::<Result<Vec<_>, _>>()?;
            rows
        };
        let mut claimed = Vec::new();
        for row in rows {
            let schedule_id = row.schedule_id.clone();
            let due_at_ms = row.next_run_at_ms;
            let Ok(schedule) = row.into_record() else {
                disable_schedule(&transaction, &schedule_id, due_at_ms)?;
                continue;
            };
            match schedule.next_occurrence_after(now_ms) {
                Ok(next_run_at_ms) => {
                    let changed = transaction.execute(
                        "UPDATE schedules SET next_run_at_ms = ?1 WHERE schedule_id = ?2 AND enabled = 1 AND next_run_at_ms = ?3",
                        params![sql_integer(next_run_at_ms, "next schedule occurrence")?, schedule.schedule_id, sql_integer(due_at_ms, "due schedule occurrence")?],
                    )?;
                    if changed == 1 {
                        claimed.push(schedule);
                    }
                }
                Err(_) => disable_schedule(&transaction, &schedule.schedule_id, due_at_ms)?,
            }
        }
        transaction.commit()?;
        Ok(claimed)
    }

    pub fn record_remote_claim(&self, claim: &RunClaim, now_ms: u64) -> AgentResult<bool> {
        claim.validate()?;
        let changed = self.lock()?.execute(
            r#"INSERT INTO remote_runs(
                 run_id, attempt, app_id, version, args_json, requires_elevation,
                 task_id, state, claimed_at_ms
               ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, 'claimed', ?7)
               ON CONFLICT(run_id) DO UPDATE SET
                 attempt = excluded.attempt,
                 app_id = excluded.app_id,
                 version = excluded.version,
                 args_json = excluded.args_json,
                 requires_elevation = excluded.requires_elevation,
                 task_id = NULL,
                 state = 'claimed',
                 claimed_at_ms = excluded.claimed_at_ms
               WHERE excluded.attempt > remote_runs.attempt"#,
            params![
                claim.run_id,
                sql_integer(claim.attempt, "run attempt")?,
                claim.app_id,
                claim.version,
                serde_json::to_string(&claim.args)?,
                claim.requires_elevation,
                sql_integer(now_ms, "claim time")?,
            ],
        )?;
        Ok(changed == 1)
    }

    pub fn pending_remote_runs(&self) -> AgentResult<Vec<RemoteRunRecord>> {
        let connection = self.lock()?;
        let mut statement = connection.prepare(
            "SELECT run_id, attempt, app_id, version, args_json, requires_elevation, task_id, state FROM remote_runs WHERE state = 'claimed' ORDER BY claimed_at_ms, run_id",
        )?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, bool>(5)?,
                    row.get::<_, Option<String>>(6)?,
                    row.get::<_, String>(7)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        rows.into_iter()
            .map(|row| {
                Ok(RemoteRunRecord {
                    run_id: row.0,
                    attempt: row
                        .1
                        .try_into()
                        .map_err(|_| AgentError::State("stored run attempt is invalid".into()))?,
                    app_id: row.2,
                    version: row.3,
                    args: serde_json::from_str(&row.4)?,
                    requires_elevation: row.5,
                    task_id: row.6,
                    state: row.7,
                })
            })
            .collect()
    }

    pub fn remote_run_for_control(
        &self,
        control: &RunControl,
    ) -> AgentResult<Option<RemoteRunRecord>> {
        control.validate()?;
        let record = self
            .lock()?
            .query_row(
                "SELECT run_id, attempt, app_id, version, args_json, requires_elevation, task_id, state FROM remote_runs WHERE run_id = ?1 AND attempt = ?2",
                params![
                    control.run_id,
                    sql_integer(control.attempt, "run attempt")?
                ],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, bool>(5)?,
                        row.get::<_, Option<String>>(6)?,
                        row.get::<_, String>(7)?,
                    ))
                },
            )
            .optional()?;
        record
            .map(|row| {
                Ok(RemoteRunRecord {
                    run_id: row.0,
                    attempt: row
                        .1
                        .try_into()
                        .map_err(|_| AgentError::State("stored run attempt is invalid".into()))?,
                    app_id: row.2,
                    version: row.3,
                    args: serde_json::from_str(&row.4)?,
                    requires_elevation: row.5,
                    task_id: row.6,
                    state: row.7,
                })
            })
            .transpose()
    }

    pub fn bind_remote_task_and_enqueue_running(
        &self,
        run_id: &str,
        attempt: u64,
        task_id: &str,
        now_ms: u64,
    ) -> AgentResult<()> {
        let report = RunReport {
            attempt,
            status: ReportRunStatus::Running,
            result: None,
            error_code: None,
        };
        report.validate()?;
        let mut connection = self.lock()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let changed = transaction.execute(
            "UPDATE remote_runs SET task_id = ?3, state = 'running' WHERE run_id = ?1 AND attempt = ?2 AND state = 'claimed'",
            params![run_id, sql_integer(attempt, "run attempt")?, task_id],
        )?;
        if changed != 1 {
            return Err(AgentError::State(
                "remote run changed before its local task was bound".into(),
            ));
        }
        transaction.execute(
            "INSERT OR IGNORE INTO run_report_outbox(run_id, attempt, status, report_json, next_attempt_at_ms, delivery_attempts) VALUES (?1, ?2, 'running', ?3, ?4, 0)",
            params![
                run_id,
                sql_integer(attempt, "run attempt")?,
                serde_json::to_string(&report)?,
                sql_integer(now_ms, "outbox time")?
            ],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn enqueue_run_report(
        &self,
        run_id: &str,
        report: &RunReport,
        now_ms: u64,
    ) -> AgentResult<()> {
        report.validate()?;
        let status = report.status.as_str();
        let state = match report.status {
            ReportRunStatus::Running => "running",
            ReportRunStatus::NeedsUserApproval => "needs_user_approval",
            ReportRunStatus::Succeeded | ReportRunStatus::Failed | ReportRunStatus::Cancelled => {
                "terminal"
            }
        };
        let mut connection = self.lock()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let changed = transaction.execute(
            "UPDATE remote_runs SET state = ?3 WHERE run_id = ?1 AND attempt = ?2",
            params![run_id, sql_integer(report.attempt, "run attempt")?, state],
        )?;
        if changed != 1 {
            return Err(AgentError::State(
                "cannot report an unknown remote run attempt".into(),
            ));
        }
        transaction.execute(
            "INSERT OR IGNORE INTO run_report_outbox(run_id, attempt, status, report_json, next_attempt_at_ms, delivery_attempts) VALUES (?1, ?2, ?3, ?4, ?5, 0)",
            params![run_id, sql_integer(report.attempt, "run attempt")?, status, serde_json::to_string(report)?, sql_integer(now_ms, "outbox time")?],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn completed_remote_runs(&self) -> AgentResult<Vec<RemoteRunCompletion>> {
        let connection = self.lock()?;
        let mut statement = connection.prepare(
            r#"SELECT remote_runs.run_id, remote_runs.attempt, tasks.status
               FROM remote_runs
               JOIN tasks ON tasks.task_id = remote_runs.task_id
               WHERE remote_runs.state = 'running'
                 AND tasks.status IN ('succeeded', 'failed', 'stopped')
               ORDER BY tasks.finished_at, remote_runs.run_id"#,
        )?;
        let rows = statement
            .query_map([], |row| {
                Ok(RemoteRunCompletion {
                    run_id: row.get(0)?,
                    attempt: row.get::<_, i64>(1)? as u64,
                    task_status: row.get(2)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()
            .map_err(AgentError::from)?;
        Ok(rows)
    }

    pub fn due_run_reports(&self, now_ms: u64) -> AgentResult<Vec<RunReportOutboxEntry>> {
        let connection = self.lock()?;
        let mut statement = connection.prepare(
            "SELECT outbox_id, run_id, report_json, delivery_attempts FROM run_report_outbox WHERE next_attempt_at_ms <= ?1 ORDER BY outbox_id",
        )?;
        let rows = statement
            .query_map(params![sql_integer(now_ms, "outbox clock")?], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        rows.into_iter()
            .map(|row| {
                Ok(RunReportOutboxEntry {
                    outbox_id: row.0,
                    run_id: row.1,
                    report: serde_json::from_str(&row.2)?,
                    delivery_attempts: row.3.max(0) as u32,
                })
            })
            .collect()
    }

    pub fn acknowledge_run_report(&self, outbox_id: i64) -> AgentResult<()> {
        self.lock()?.execute(
            "DELETE FROM run_report_outbox WHERE outbox_id = ?1",
            params![outbox_id],
        )?;
        Ok(())
    }

    pub fn retry_run_report(&self, outbox_id: i64, next_attempt_at_ms: u64) -> AgentResult<()> {
        self.lock()?.execute(
            "UPDATE run_report_outbox SET delivery_attempts = delivery_attempts + 1, next_attempt_at_ms = ?2 WHERE outbox_id = ?1",
            params![outbox_id, sql_integer(next_attempt_at_ms, "outbox retry time")?],
        )?;
        Ok(())
    }

    pub fn fail_interrupted_tasks(&self, finished_at: u64) -> AgentResult<()> {
        let mut connection = self.lock()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        transaction.execute(
            "DELETE FROM leases WHERE task_id IN (SELECT task_id FROM tasks WHERE status IN ('starting', 'running'))",
            [],
        )?;
        transaction.execute(
            "UPDATE tasks SET status = 'failed', finished_at = ?1 WHERE status IN ('starting', 'running')",
            params![sql_integer(finished_at, "task finish time")?],
        )?;
        transaction.commit()?;
        Ok(())
    }

    fn lock(&self) -> AgentResult<std::sync::MutexGuard<'_, Connection>> {
        self.connection
            .lock()
            .map_err(|_| AgentError::State("database lock was poisoned".into()))
    }
}

#[derive(Debug, Clone)]
pub(crate) struct RemoteRunRecord {
    pub run_id: String,
    pub attempt: u64,
    pub app_id: String,
    pub version: String,
    pub args: Vec<String>,
    pub requires_elevation: bool,
    pub task_id: Option<String>,
    pub state: String,
}

#[derive(Debug, Clone)]
pub(crate) struct RemoteRunCompletion {
    pub run_id: String,
    pub attempt: u64,
    pub task_status: String,
}

#[derive(Debug, Clone)]
pub(crate) struct RunReportOutboxEntry {
    pub outbox_id: i64,
    pub run_id: String,
    pub report: RunReport,
    pub delivery_attempts: u32,
}

#[derive(Debug, Clone)]
pub(crate) struct InstallationReportOutboxEntry {
    pub outbox_id: i64,
    pub installation_id: String,
    pub report: InstallationStatusReport,
    pub delivery_attempts: u32,
}

fn task_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<TaskRecord> {
    Ok(TaskRecord {
        task_id: row.get(0)?,
        app_id: row.get(1)?,
        version: row.get(2)?,
        status: row.get(3)?,
        pid: row.get(4)?,
        log_path: row.get::<_, String>(5)?.into(),
        started_at: row.get::<_, i64>(6)? as u64,
        finished_at: row.get::<_, Option<i64>>(7)?.map(|value| value as u64),
    })
}

struct ScheduleRow {
    schedule_id: String,
    app_id: String,
    version: Option<String>,
    cron_expression: String,
    timezone: String,
    next_run_at_ms: u64,
    args_json: String,
    enabled: bool,
}

impl ScheduleRow {
    fn into_record(self) -> AgentResult<ScheduleRecord> {
        Ok(ScheduleRecord {
            schedule_id: self.schedule_id,
            app_id: self.app_id,
            version: self.version,
            cron_expression: self.cron_expression,
            timezone: self.timezone,
            next_run_at_ms: self.next_run_at_ms,
            args: serde_json::from_str(&self.args_json)?,
            enabled: self.enabled,
        })
    }
}

fn schedule_row_from_db(row: &rusqlite::Row<'_>) -> rusqlite::Result<ScheduleRow> {
    Ok(ScheduleRow {
        schedule_id: row.get(0)?,
        app_id: row.get(1)?,
        version: row.get(2)?,
        cron_expression: row.get(3)?,
        timezone: row.get(4)?,
        next_run_at_ms: row.get::<_, i64>(5)?.try_into().map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                5,
                rusqlite::types::Type::Integer,
                Box::new(error),
            )
        })?,
        args_json: row.get(6)?,
        enabled: row.get(7)?,
    })
}

fn normalize_synced_schedule(schedule: &ScheduleRecord, now_ms: u64) -> ScheduleRecord {
    let mut normalized = schedule.clone();
    if !normalized.enabled {
        return normalized;
    }
    if normalized.validate_recurrence().is_err() {
        normalized.enabled = false;
        return normalized;
    }
    if normalized.next_run_at_ms <= now_ms {
        match normalized.next_occurrence_after(now_ms) {
            Ok(next_run_at_ms) => normalized.next_run_at_ms = next_run_at_ms,
            Err(_) => normalized.enabled = false,
        }
    }
    normalized
}

fn insert_schedule(transaction: &Transaction<'_>, schedule: &ScheduleRecord) -> AgentResult<()> {
    transaction.execute(
        r#"INSERT INTO schedules(
             schedule_id, app_id, version, cron_expression, timezone,
             next_run_at_ms, args_json, enabled
           ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
           ON CONFLICT(schedule_id) DO UPDATE SET
             app_id = excluded.app_id,
             version = excluded.version,
             cron_expression = excluded.cron_expression,
             timezone = excluded.timezone,
             next_run_at_ms = excluded.next_run_at_ms,
             args_json = excluded.args_json,
             enabled = excluded.enabled"#,
        params![
            schedule.schedule_id,
            schedule.app_id,
            schedule.version,
            schedule.cron_expression,
            schedule.timezone,
            sql_integer(schedule.next_run_at_ms, "nextRunAtMs")?,
            serde_json::to_string(&schedule.args)?,
            schedule.enabled,
        ],
    )?;
    Ok(())
}

fn disable_schedule(
    transaction: &Transaction<'_>,
    schedule_id: &str,
    due_at_ms: u64,
) -> AgentResult<()> {
    transaction.execute(
        "UPDATE schedules SET enabled = 0 WHERE schedule_id = ?1 AND next_run_at_ms = ?2",
        params![
            schedule_id,
            sql_integer(due_at_ms, "due schedule occurrence")?
        ],
    )?;
    Ok(())
}

fn mark_sync_success(transaction: &Transaction<'_>, revision: u64, now_ms: u64) -> AgentResult<()> {
    transaction.execute(
        "UPDATE sync_state SET revision = ?1, offline = 0, last_sync_at = ?2 WHERE singleton = 1",
        params![
            sql_integer(revision, "schedule revision")?,
            sql_integer(now_ms / 1_000, "last sync time")?
        ],
    )?;
    Ok(())
}

fn sql_integer(value: u64, field: &str) -> AgentResult<i64> {
    value
        .try_into()
        .map_err(|_| AgentError::State(format!("{field} exceeds SQLite integer range")))
}

fn migrate_legacy_schedule_schema(connection: &mut Connection) -> AgentResult<()> {
    let columns = {
        let mut statement = connection.prepare("PRAGMA table_info(schedules)")?;
        let columns = statement
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<Result<HashSet<_>, _>>()?;
        columns
    };
    if columns.contains("next_run_at_ms") {
        return Ok(());
    }
    if !columns.contains("next_run_at") {
        return Err(AgentError::State(
            "schedule database schema is incomplete".into(),
        ));
    }

    // The old projection did not contain cron or timezone, so it cannot be
    // migrated without inventing execution semantics. Discard only that cache,
    // reset its revision and force a full server snapshot on the next sync.
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    transaction.execute("ALTER TABLE schedules RENAME TO schedules_legacy_v1", [])?;
    transaction.execute_batch(
        r#"
        CREATE TABLE schedules (
          schedule_id TEXT PRIMARY KEY, app_id TEXT NOT NULL, version TEXT,
          cron_expression TEXT NOT NULL, timezone TEXT NOT NULL,
          next_run_at_ms INTEGER NOT NULL, args_json TEXT NOT NULL, enabled INTEGER NOT NULL
        );
        DROP TABLE schedules_legacy_v1;
        UPDATE sync_state SET revision = 0, offline = 1, last_sync_at = NULL WHERE singleton = 1;
        "#,
    )?;
    transaction.commit()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::{
        sync::{Arc, Barrier},
        thread,
    };

    use chrono::DateTime;
    use tempfile::tempdir;

    use super::*;

    const FIRST_ID: &str = "3cf60eb1-9355-48d0-8d2f-97b3c307f0cf";

    fn epoch_ms(value: &str) -> u64 {
        DateTime::parse_from_rfc3339(value)
            .unwrap()
            .timestamp_millis()
            .try_into()
            .unwrap()
    }

    fn schedule(next_run_at_ms: u64) -> ScheduleRecord {
        ScheduleRecord {
            schedule_id: FIRST_ID.into(),
            app_id: "demo-app".into(),
            version: Some("1.2.3".into()),
            cron_expression: "* * * * *".into(),
            timezone: "UTC".into(),
            next_run_at_ms,
            args: vec!["--scheduled".into()],
            enabled: true,
        }
    }

    fn all_schedules(database: &Database) -> Vec<ScheduleRecord> {
        database.due_schedules(9_007_199_254_740_991).unwrap()
    }

    #[test]
    fn expired_snapshot_skips_backlog_and_invalid_recurrence_is_disabled() {
        let directory = tempdir().unwrap();
        let database = Database::open(&directory.path().join("agent.db")).unwrap();
        let now = epoch_ms("2025-01-01T12:00:00Z");
        database
            .apply_schedule_snapshot(
                &ScheduleSnapshot {
                    revision: 1,
                    schedules: vec![schedule(now - 10 * 60_000)],
                },
                now,
            )
            .unwrap();
        assert!(database.due_schedules(now).unwrap().is_empty());
        assert!(all_schedules(&database)[0].next_run_at_ms > now);

        let mut invalid = schedule(now + 60_000);
        invalid.cron_expression = "not a cron expression".into();
        database
            .apply_schedule_delta(
                &ScheduleDelta {
                    from_revision: 1,
                    to_revision: 2,
                    upserts: vec![invalid],
                    removed_schedule_ids: vec![],
                },
                now,
            )
            .unwrap();
        assert!(all_schedules(&database).is_empty());
        let enabled: bool = database
            .lock()
            .unwrap()
            .query_row(
                "SELECT enabled FROM schedules WHERE schedule_id = ?1",
                params![FIRST_ID],
                |row| row.get(0),
            )
            .unwrap();
        assert!(!enabled);
    }

    #[test]
    fn missed_periods_claim_once_and_advance_atomically_across_threads() {
        let directory = tempdir().unwrap();
        let database = Arc::new(Database::open(&directory.path().join("agent.db")).unwrap());
        let start = epoch_ms("2025-01-01T12:00:00Z");
        database
            .apply_schedule_snapshot(
                &ScheduleSnapshot {
                    revision: 1,
                    schedules: vec![schedule(start + 60_000)],
                },
                start,
            )
            .unwrap();
        let claim_at = start + 10 * 60_000;
        let barrier = Arc::new(Barrier::new(3));
        let handles = (0..2)
            .map(|_| {
                let database = database.clone();
                let barrier = barrier.clone();
                thread::spawn(move || {
                    barrier.wait();
                    database.claim_due_schedules(claim_at).unwrap().len()
                })
            })
            .collect::<Vec<_>>();
        barrier.wait();
        let total = handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .sum::<usize>();
        assert_eq!(total, 1);
        let persisted = all_schedules(&database);
        assert_eq!(persisted.len(), 1);
        assert!(persisted[0].enabled);
        assert!(persisted[0].next_run_at_ms > claim_at);
        assert!(database.claim_due_schedules(claim_at).unwrap().is_empty());
    }

    #[test]
    fn restart_preserves_local_advance_until_a_new_revision_resets_it() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("agent.db");
        let start = epoch_ms("2025-01-01T12:00:00Z");
        let advanced = {
            let database = Database::open(&path).unwrap();
            database
                .apply_schedule_snapshot(
                    &ScheduleSnapshot {
                        revision: 1,
                        schedules: vec![schedule(start + 60_000)],
                    },
                    start,
                )
                .unwrap();
            assert_eq!(
                database.claim_due_schedules(start + 60_000).unwrap().len(),
                1
            );
            all_schedules(&database)[0].next_run_at_ms
        };

        let database = Database::open(&path).unwrap();
        assert_eq!(all_schedules(&database)[0].next_run_at_ms, advanced);
        assert!(!database
            .apply_schedule_delta(
                &ScheduleDelta {
                    from_revision: 1,
                    to_revision: 1,
                    upserts: vec![],
                    removed_schedule_ids: vec![],
                },
                start + 70_000,
            )
            .unwrap());
        assert_eq!(all_schedules(&database)[0].next_run_at_ms, advanced);

        let reset_at = start + 24 * 60 * 60_000;
        let mut reset = schedule(reset_at);
        reset.args = vec!["--new-revision".into()];
        assert!(database
            .apply_schedule_delta(
                &ScheduleDelta {
                    from_revision: 1,
                    to_revision: 2,
                    upserts: vec![reset],
                    removed_schedule_ids: vec![],
                },
                start + 80_000,
            )
            .unwrap());
        let stored = all_schedules(&database);
        assert_eq!(stored[0].next_run_at_ms, reset_at);
        assert_eq!(stored[0].args, ["--new-revision"]);
    }

    #[test]
    fn legacy_one_shot_cache_is_invalidated_instead_of_guessing_recurrence() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("agent.db");
        let connection = Connection::open(&path).unwrap();
        connection
            .execute_batch(
                r#"
                CREATE TABLE schedules (
                  schedule_id TEXT PRIMARY KEY, app_id TEXT NOT NULL, version TEXT,
                  next_run_at INTEGER NOT NULL, args_json TEXT NOT NULL, enabled INTEGER NOT NULL
                );
                CREATE TABLE sync_state (
                  singleton INTEGER PRIMARY KEY CHECK(singleton = 1), revision INTEGER NOT NULL,
                  offline INTEGER NOT NULL, last_sync_at INTEGER
                );
                INSERT INTO sync_state VALUES (1, 9, 0, 100);
                INSERT INTO schedules VALUES (
                  '3cf60eb1-9355-48d0-8d2f-97b3c307f0cf', 'demo-app', '1.2.3', 100, '[]', 1
                );
                "#,
            )
            .unwrap();
        drop(connection);

        let database = Database::open(&path).unwrap();
        assert!(all_schedules(&database).is_empty());
        assert_eq!(database.sync_state().unwrap().revision, 0);
        assert!(database.sync_state().unwrap().offline);
        let columns = database
            .lock()
            .unwrap()
            .prepare("PRAGMA table_info(schedules)")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(1))
            .unwrap()
            .collect::<Result<HashSet<_>, _>>()
            .unwrap();
        assert!(columns.contains("next_run_at_ms"));
        assert!(!columns.contains("next_run_at"));
    }
}
