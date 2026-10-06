//! Jobs: long-running work the daemon does on a caller's behalf, which
//! outlives the request that started it.
//!
//! A job is a run of local tools over a file — a transcription — that can
//! take minutes, so it can't be tied to one request, tab, or socket. [`JobManager`] holds every job in memory, like terminals: they
//! vanish on restart.
//!
//! - **One at a time.** Jobs run in the order they were submitted; the rest
//!   wait as `queued`. A tool run saturates the machine, so running two just
//!   makes both slower.
//! - **Owned by an account.** A job belongs to the account that created it:
//!   only that account's sockets get its `job_changed` notifications, and to
//!   any other account the job doesn't exist ([`JobNotFound`]).
//! - **Cancellable.** Cancelling a queued job removes it from the queue;
//!   cancelling the running one drops its future, which kills its tool
//!   process ([`crate::tool`] runs with `kill_on_drop`).
//! - **Bounded.** Finished jobs are kept as history up to
//!   [`MAX_FINISHED_JOBS`], oldest dropped first.
//!
//! The work itself is a future the submitter builds from a [`JobHandle`],
//! which reports progress and the command lines run; a failure carries the
//! tool's stderr ([`JobFailure`]).

use std::collections::{HashMap, VecDeque};
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use parking_lot::Mutex;
use serde::Serialize;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::handlers::App;

/// How many finished jobs are kept as history; the oldest are dropped first.
pub const MAX_FINISHED_JOBS: usize = 100;

/// Upper bound on [`JobManager::cancel_all`], so shutdown never hangs on a job.
const CANCEL_ALL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// What a job does.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum JobKind {
    Transcription,
}

/// Where a job is in its life. The last three are final.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum JobStatus {
    Queued,
    Running,
    Succeeded,
    Failed,
    Cancelled,
}

impl JobStatus {
    /// Whether the job is over.
    #[must_use]
    pub const fn is_finished(self) -> bool {
        matches!(self, Self::Succeeded | Self::Failed | Self::Cancelled)
    }
}

/// A job as clients see it — twin of the TS `JobJson`'s job fields, and the
/// payload of `job_changed`.
#[derive(Debug, Clone, Serialize)]
pub struct JobSnapshot {
    pub job_id: String,
    pub kind: JobKind,
    pub status: JobStatus,
    /// How far along a running job is, `0.0..=1.0` — `None` when unknown.
    pub progress: Option<f64>,
    /// The file the job works on.
    pub input_path: String,
    /// The file the job wrote, once it succeeded.
    pub output_path: Option<String>,
    /// The command lines run so far, in order, for display.
    pub commands: Vec<String>,
    /// Milliseconds since the epoch.
    pub queued_at: u64,
    pub started_at: Option<u64>,
    pub ended_at: Option<u64>,
    /// Why a failed job failed.
    pub error: Option<String>,
    /// The tail of the failing tool's stderr — text derived from the input
    /// file, so clients render it as text.
    pub stderr: String,
}

/// Why a job's work failed.
#[derive(Debug, Clone)]
pub struct JobFailure {
    pub message: String,
    /// The tail of the failing tool's stderr, when a tool failed.
    pub stderr: String,
}

impl JobFailure {
    /// A failure with no tool output behind it.
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            stderr: String::new(),
        }
    }
}

/// The job id is unknown, or the job belongs to another account — the two are
/// indistinguishable to a caller.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("job not found")]
pub struct JobNotFound;

/// A job's work: resolves to the path of the file it wrote.
pub type JobFuture = Pin<Box<dyn Future<Output = Result<String, JobFailure>> + Send>>;

/// Builds a job's work from its handle, when the job's turn comes.
pub type JobWork = Box<dyn FnOnce(JobHandle) -> JobFuture + Send>;

struct JobEntry {
    owner: Uuid,
    snapshot: JobSnapshot,
    cancel: CancellationToken,
    /// Taken when the job starts.
    work: Option<JobWork>,
}

#[derive(Default)]
struct JobTable {
    jobs: HashMap<Uuid, JobEntry>,
    /// Every job, oldest first.
    order: Vec<Uuid>,
    queue: VecDeque<Uuid>,
    /// Whether a task is draining the queue.
    draining: bool,
}

impl JobTable {
    /// Drop the oldest finished jobs past [`MAX_FINISHED_JOBS`].
    fn prune(&mut self) {
        let finished = self
            .order
            .iter()
            .filter(|id| {
                self.jobs
                    .get(id)
                    .is_some_and(|job| job.snapshot.status.is_finished())
            })
            .count();
        let mut excess = finished.saturating_sub(MAX_FINISHED_JOBS);
        if excess == 0 {
            return;
        }
        let jobs = &mut self.jobs;
        self.order.retain(|id| {
            if excess > 0
                && jobs
                    .get(id)
                    .is_some_and(|job| job.snapshot.status.is_finished())
            {
                jobs.remove(id);
                excess -= 1;
                false
            } else {
                true
            }
        });
    }
}

/// The daemon's jobs. See the module doc.
#[derive(Clone, Default)]
pub struct JobManager {
    table: Arc<Mutex<JobTable>>,
}

impl std::fmt::Debug for JobManager {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("JobManager").finish_non_exhaustive()
    }
}

/// What a job's work uses to report on itself. Every update is sent to the
/// owner as a `job_changed` notification.
#[derive(Clone)]
pub struct JobHandle {
    pub job_id: Uuid,
    pub owner: Uuid,
    pub app: Arc<App>,
    manager: JobManager,
}

impl std::fmt::Debug for JobHandle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("JobHandle")
            .field("job_id", &self.job_id)
            .finish_non_exhaustive()
    }
}

impl JobHandle {
    /// Report progress, clamped to `0.0..=1.0`.
    pub fn set_progress(&self, progress: f64) {
        let progress = progress.clamp(0.0, 1.0);
        self.manager
            .update(&self.app, self.job_id, |job| job.progress = Some(progress));
    }

    /// Record a command line about to run, for display.
    pub fn add_command(&self, command: String) {
        self.manager
            .update(&self.app, self.job_id, |job| job.commands.push(command));
    }
}

impl JobManager {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Queue a job for `owner` and return it as queued. It starts when the
    /// jobs ahead of it are done.
    pub fn submit(
        &self,
        app: &Arc<App>,
        owner: Uuid,
        kind: JobKind,
        input_path: String,
        work: JobWork,
    ) -> JobSnapshot {
        let job_id = Uuid::new_v4();
        let snapshot = JobSnapshot {
            job_id: job_id.to_string(),
            kind,
            status: JobStatus::Queued,
            progress: None,
            input_path,
            output_path: None,
            commands: Vec::new(),
            queued_at: now_ms(),
            started_at: None,
            ended_at: None,
            error: None,
            stderr: String::new(),
        };
        let start_draining = {
            let mut table = self.table.lock();
            table.jobs.insert(
                job_id,
                JobEntry {
                    owner,
                    snapshot: snapshot.clone(),
                    cancel: CancellationToken::new(),
                    work: Some(work),
                },
            );
            table.order.push(job_id);
            table.queue.push_back(job_id);
            !std::mem::replace(&mut table.draining, true)
        };
        notify(app, owner, &snapshot);
        if start_draining {
            let manager = self.clone();
            let app = Arc::clone(app);
            tokio::spawn(async move { manager.drain(app).await });
        }
        snapshot
    }

    /// `owner`'s jobs, oldest first.
    #[must_use]
    pub fn jobs_for_account(&self, owner: Uuid) -> Vec<JobSnapshot> {
        let table = self.table.lock();
        table
            .order
            .iter()
            .filter_map(|id| table.jobs.get(id))
            .filter(|job| job.owner == owner)
            .map(|job| job.snapshot.clone())
            .collect()
    }

    /// Cancel `owner`'s job: a queued one never starts, the running one is
    /// stopped (its tool process killed). A job that's already over is left
    /// as it is.
    ///
    /// # Errors
    ///
    /// [`JobNotFound`] for an unknown id or another account's job.
    pub fn cancel(&self, app: &Arc<App>, owner: Uuid, job_id: Uuid) -> Result<(), JobNotFound> {
        let cancelled_while_queued = {
            let mut table = self.table.lock();
            let Some(job) = table.jobs.get_mut(&job_id).filter(|job| job.owner == owner) else {
                return Err(JobNotFound);
            };
            match job.snapshot.status {
                JobStatus::Queued => {
                    job.snapshot.status = JobStatus::Cancelled;
                    job.snapshot.ended_at = Some(now_ms());
                    job.work = None;
                    let snapshot = job.snapshot.clone();
                    table.queue.retain(|id| *id != job_id);
                    table.prune();
                    Some(snapshot)
                }
                JobStatus::Running => {
                    // the draining task sees this and records the outcome
                    job.cancel.cancel();
                    None
                }
                JobStatus::Succeeded | JobStatus::Failed | JobStatus::Cancelled => None,
            }
        };
        if let Some(snapshot) = cancelled_while_queued {
            notify(app, owner, &snapshot);
        }
        Ok(())
    }

    /// Cancel every unfinished job of `owner`'s. Returns how many.
    pub fn cancel_all_for_account(&self, app: &Arc<App>, owner: Uuid) -> usize {
        let unfinished: Vec<Uuid> = {
            let table = self.table.lock();
            table
                .jobs
                .iter()
                .filter(|(_, job)| job.owner == owner && !job.snapshot.status.is_finished())
                .map(|(id, _)| *id)
                .collect()
        };
        for job_id in &unfinished {
            let _ = self.cancel(app, owner, *job_id);
        }
        unfinished.len()
    }

    /// Cancel every job and forget them all, waiting (briefly) for the
    /// running one to stop — for shutdown and `_testing_reset`. Queued jobs
    /// are dropped without a notification.
    pub async fn cancel_all(&self) {
        {
            let mut table = self.table.lock();
            table.queue.clear();
            for job in table.jobs.values_mut() {
                job.work = None;
                job.cancel.cancel();
            }
        }
        let stopped = async {
            while self.table.lock().draining {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        };
        if tokio::time::timeout(CANCEL_ALL_TIMEOUT, stopped)
            .await
            .is_err()
        {
            tracing::warn!("a job was still stopping after {CANCEL_ALL_TIMEOUT:?}");
        }
        let mut table = self.table.lock();
        table.jobs.clear();
        table.order.clear();
    }

    /// Run queued jobs, one at a time, until the queue is empty.
    async fn drain(self, app: Arc<App>) {
        loop {
            let next = {
                let mut table = self.table.lock();
                let next = loop {
                    let Some(job_id) = table.queue.pop_front() else {
                        break None;
                    };
                    let Some(job) = table.jobs.get_mut(&job_id) else {
                        continue;
                    };
                    let Some(work) = job.work.take() else {
                        continue;
                    };
                    job.snapshot.status = JobStatus::Running;
                    job.snapshot.started_at = Some(now_ms());
                    break Some((
                        job_id,
                        job.owner,
                        job.cancel.clone(),
                        work,
                        job.snapshot.clone(),
                    ));
                };
                if next.is_none() {
                    table.draining = false;
                }
                next
            };
            let Some((job_id, owner, cancel, work, snapshot)) = next else {
                return;
            };
            notify(&app, owner, &snapshot);

            let handle = JobHandle {
                job_id,
                owner,
                app: Arc::clone(&app),
                manager: self.clone(),
            };
            // dropping the work's future on cancel is what kills its tool
            let outcome = tokio::select! {
                biased;
                () = cancel.cancelled() => None,
                result = work(handle) => Some(result),
            };

            let finished = {
                let mut table = self.table.lock();
                let snapshot = table.jobs.get_mut(&job_id).map(|job| {
                    let snapshot = &mut job.snapshot;
                    snapshot.ended_at = Some(now_ms());
                    match outcome {
                        Some(Ok(output_path)) => {
                            snapshot.status = JobStatus::Succeeded;
                            snapshot.progress = Some(1.0);
                            snapshot.output_path = Some(output_path);
                        }
                        Some(Err(failure)) => {
                            snapshot.status = JobStatus::Failed;
                            snapshot.error = Some(failure.message);
                            snapshot.stderr = failure.stderr;
                        }
                        None => snapshot.status = JobStatus::Cancelled,
                    }
                    snapshot.clone()
                });
                table.prune();
                snapshot
            };
            // `None` after `cancel_all` forgot the job
            if let Some(snapshot) = finished {
                tracing::info!(job_id = %snapshot.job_id, status = ?snapshot.status, "job finished");
                notify(&app, owner, &snapshot);
            }
        }
    }

    /// Change a running job's snapshot and tell its owner.
    fn update(&self, app: &Arc<App>, job_id: Uuid, change: impl FnOnce(&mut JobSnapshot)) {
        let updated = {
            let mut table = self.table.lock();
            table.jobs.get_mut(&job_id).map(|job| {
                change(&mut job.snapshot);
                (job.owner, job.snapshot.clone())
            })
        };
        if let Some((owner, snapshot)) = updated {
            notify(app, owner, &snapshot);
        }
    }
}

#[derive(Serialize)]
struct JobChangedParams<'a> {
    job: &'a JobSnapshot,
}

/// Send `job_changed` to the owning account's sockets.
fn notify(app: &App, owner: Uuid, job: &JobSnapshot) {
    let notification = fuz_http::notification("job_changed", &JobChangedParams { job });
    app.realtime.send_to_account(owner, &notification);
}

/// Now, in milliseconds since the epoch.
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| {
            u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX)
        })
}

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "tests panic on assertion failure by design"
)]
mod tests {
    use std::time::Duration;

    use tokio::sync::oneshot;

    use super::*;

    /// An `App` with inert handles: a pool that never connects and a
    /// registry with no sockets, so notifications go nowhere.
    fn test_app() -> Arc<App> {
        let pool = fuz_db::create_pool("postgres://localhost:1/jobs_unused")
            .expect("a lazy pool builds without connecting");
        Arc::new(App::new(
            pool,
            crate::scoped_fs::ScopedFs::new(vec![]),
            String::new(),
            vec![],
            crate::provider::ProviderManager::new(),
            false,
            Arc::new(fuz_realtime::ConnectionRegistry::new()),
        ))
    }

    /// Work that waits for `release`, then succeeds with `output` — or fails
    /// when `release` carries an error.
    fn gated(output: &'static str) -> (JobWork, oneshot::Sender<Result<(), JobFailure>>) {
        let (release, released) = oneshot::channel::<Result<(), JobFailure>>();
        let work: JobWork = Box::new(move |_handle| {
            Box::pin(async move {
                match released.await {
                    Ok(Ok(())) => Ok(output.to_owned()),
                    Ok(Err(failure)) => Err(failure),
                    Err(_) => Err(JobFailure::new("released without a result")),
                }
            })
        });
        (work, release)
    }

    fn submit(app: &Arc<App>, owner: Uuid, work: JobWork) -> Uuid {
        let snapshot = app.job_manager.submit(
            app,
            owner,
            JobKind::Transcription,
            "/w/a.webm".to_owned(),
            work,
        );
        assert_eq!(snapshot.status, JobStatus::Queued);
        snapshot.job_id.parse().unwrap()
    }

    fn status_of(app: &Arc<App>, owner: Uuid, job_id: Uuid) -> JobSnapshot {
        app.job_manager
            .jobs_for_account(owner)
            .into_iter()
            .find(|job| job.job_id == job_id.to_string())
            .expect("the job is listed")
    }

    async fn wait_for_status(
        app: &Arc<App>,
        owner: Uuid,
        job_id: Uuid,
        status: JobStatus,
    ) -> JobSnapshot {
        for _ in 0..500 {
            let job = status_of(app, owner, job_id);
            if job.status == status {
                return job;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        panic!(
            "job never became {status:?}: {:?}",
            status_of(app, owner, job_id)
        );
    }

    #[tokio::test]
    async fn jobs_run_one_at_a_time_in_order() {
        let app = test_app();
        let owner = Uuid::new_v4();
        let (first_work, first_release) = gated("/w/first");
        let (second_work, second_release) = gated("/w/second");
        let first = submit(&app, owner, first_work);
        let second = submit(&app, owner, second_work);

        wait_for_status(&app, owner, first, JobStatus::Running).await;
        // the second waits its turn
        tokio::time::sleep(Duration::from_millis(30)).await;
        assert_eq!(status_of(&app, owner, second).status, JobStatus::Queued);

        first_release.send(Ok(())).unwrap();
        let done = wait_for_status(&app, owner, first, JobStatus::Succeeded).await;
        assert_eq!(done.output_path.as_deref(), Some("/w/first"));
        assert_eq!(done.progress, Some(1.0));
        assert!(done.started_at.is_some() && done.ended_at.is_some());

        wait_for_status(&app, owner, second, JobStatus::Running).await;
        second_release.send(Ok(())).unwrap();
        wait_for_status(&app, owner, second, JobStatus::Succeeded).await;

        // a job submitted after the queue emptied starts a new drain
        let (third_work, third_release) = gated("/w/third");
        let third = submit(&app, owner, third_work);
        third_release.send(Ok(())).unwrap();
        wait_for_status(&app, owner, third, JobStatus::Succeeded).await;
    }

    #[tokio::test]
    async fn a_failure_is_recorded_with_its_stderr() {
        let app = test_app();
        let owner = Uuid::new_v4();
        let (work, release) = gated("/w/out");
        let job = submit(&app, owner, work);
        release
            .send(Err(JobFailure {
                message: "the tool failed".to_owned(),
                stderr: "bad input".to_owned(),
            }))
            .unwrap();
        let failed = wait_for_status(&app, owner, job, JobStatus::Failed).await;
        assert_eq!(failed.error.as_deref(), Some("the tool failed"));
        assert_eq!(failed.stderr, "bad input");
        assert_eq!(failed.output_path, None);
    }

    #[tokio::test]
    async fn the_handle_reports_progress_and_commands() {
        let app = test_app();
        let owner = Uuid::new_v4();
        let (report, reported) = oneshot::channel::<()>();
        let (release, released) = oneshot::channel::<()>();
        let work: JobWork = Box::new(move |handle| {
            Box::pin(async move {
                handle.add_command("ffmpeg -i fd:".to_owned());
                handle.set_progress(0.25);
                handle.set_progress(7.0);
                let _ = report.send(());
                let _ = released.await;
                Ok("/w/out".to_owned())
            })
        });
        let job = submit(&app, owner, work);
        reported.await.unwrap();
        let running = status_of(&app, owner, job);
        assert_eq!(running.status, JobStatus::Running);
        assert_eq!(running.commands, vec!["ffmpeg -i fd:".to_owned()]);
        assert_eq!(running.progress, Some(1.0), "clamped");
        release.send(()).unwrap();
        wait_for_status(&app, owner, job, JobStatus::Succeeded).await;
    }

    /// Signals when it's dropped — with the work's future that holds it.
    struct OnDrop(Option<oneshot::Sender<()>>);

    impl Drop for OnDrop {
        fn drop(&mut self) {
            if let Some(sender) = self.0.take() {
                let _ = sender.send(());
            }
        }
    }

    #[tokio::test]
    async fn cancelling_the_running_job_drops_its_work() {
        let app = test_app();
        let owner = Uuid::new_v4();
        let (dropped_tx, dropped) = oneshot::channel::<()>();
        let work: JobWork = Box::new(move |_handle| {
            let guard = OnDrop(Some(dropped_tx));
            Box::pin(async move {
                let _guard = guard;
                std::future::pending::<()>().await;
                Ok(String::new())
            })
        });
        let job = submit(&app, owner, work);
        wait_for_status(&app, owner, job, JobStatus::Running).await;

        app.job_manager.cancel(&app, owner, job).unwrap();
        dropped.await.unwrap();
        let cancelled = wait_for_status(&app, owner, job, JobStatus::Cancelled).await;
        assert!(cancelled.ended_at.is_some());
        assert_eq!(cancelled.error, None);

        // the queue carries on
        let (next_work, next_release) = gated("/w/next");
        let next = submit(&app, owner, next_work);
        next_release.send(Ok(())).unwrap();
        wait_for_status(&app, owner, next, JobStatus::Succeeded).await;
    }

    #[tokio::test]
    async fn cancelling_a_queued_job_keeps_it_from_starting() {
        let app = test_app();
        let owner = Uuid::new_v4();
        let (first_work, first_release) = gated("/w/first");
        let (second_work, _second_release) = gated("/w/second");
        let first = submit(&app, owner, first_work);
        let second = submit(&app, owner, second_work);
        wait_for_status(&app, owner, first, JobStatus::Running).await;

        app.job_manager.cancel(&app, owner, second).unwrap();
        let cancelled = status_of(&app, owner, second);
        assert_eq!(cancelled.status, JobStatus::Cancelled);
        assert_eq!(cancelled.started_at, None);

        first_release.send(Ok(())).unwrap();
        wait_for_status(&app, owner, first, JobStatus::Succeeded).await;
        tokio::time::sleep(Duration::from_millis(30)).await;
        assert_eq!(status_of(&app, owner, second).status, JobStatus::Cancelled);

        // cancelling a job that's over changes nothing
        app.job_manager.cancel(&app, owner, first).unwrap();
        assert_eq!(status_of(&app, owner, first).status, JobStatus::Succeeded);
    }

    #[tokio::test]
    async fn another_accounts_job_does_not_exist() {
        let app = test_app();
        let owner = Uuid::new_v4();
        let other = Uuid::new_v4();
        let (work, release) = gated("/w/out");
        let job = submit(&app, owner, work);
        wait_for_status(&app, owner, job, JobStatus::Running).await;

        assert!(app.job_manager.jobs_for_account(other).is_empty());
        assert_eq!(app.job_manager.cancel(&app, other, job), Err(JobNotFound));
        assert_eq!(
            app.job_manager.cancel(&app, owner, Uuid::new_v4()),
            Err(JobNotFound)
        );
        assert_eq!(app.job_manager.cancel_all_for_account(&app, other), 0);
        assert_eq!(status_of(&app, owner, job).status, JobStatus::Running);

        assert_eq!(app.job_manager.cancel_all_for_account(&app, owner), 1);
        wait_for_status(&app, owner, job, JobStatus::Cancelled).await;
        drop(release);
    }

    #[tokio::test]
    async fn cancel_all_stops_and_forgets_everything() {
        let app = test_app();
        let owner = Uuid::new_v4();
        let (first_work, _first_release) = gated("/w/first");
        let (second_work, _second_release) = gated("/w/second");
        let first = submit(&app, owner, first_work);
        submit(&app, owner, second_work);
        wait_for_status(&app, owner, first, JobStatus::Running).await;

        app.job_manager.cancel_all().await;
        assert!(app.job_manager.jobs_for_account(owner).is_empty());

        // still usable afterward
        let (work, release) = gated("/w/again");
        let again = submit(&app, owner, work);
        release.send(Ok(())).unwrap();
        wait_for_status(&app, owner, again, JobStatus::Succeeded).await;
    }

    #[tokio::test]
    async fn finished_jobs_are_kept_up_to_a_bound() {
        let app = test_app();
        let owner = Uuid::new_v4();
        let mut last = None;
        for _ in 0..MAX_FINISHED_JOBS + 5 {
            let work: JobWork = Box::new(|_handle| Box::pin(async { Ok("/w/out".to_owned()) }));
            last = Some(submit(&app, owner, work));
        }
        wait_for_status(&app, owner, last.unwrap(), JobStatus::Succeeded).await;
        let jobs = app.job_manager.jobs_for_account(owner);
        assert_eq!(jobs.len(), MAX_FINISHED_JOBS);
        // the newest survive
        assert_eq!(jobs.last().unwrap().job_id, last.unwrap().to_string());
    }
}
