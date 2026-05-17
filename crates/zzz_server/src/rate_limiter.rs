//! In-memory sliding-window rate limiter.
//!
//! Mirrors `fuz_app`'s `rate_limiter.ts` (the TS source of truth) — tracks
//! attempt timestamps per key under a sliding window. `check` returns
//! whether the key is below the cap; `record` appends an attempt; `reset`
//! clears the entry on successful auth so well-behaved callers never see a
//! 429.
//!
//! ## Scope
//!
//! Used by the REST `/login` and `/password` handlers under the
//! `ZZZ_LOGIN_RATE_LIMIT_ENABLED` env var gate. Default off — production
//! deployments flip it on, but existing integration tests don't regress
//! on the rate-limit boundary. `fuz_app`'s defaults: 5 attempts / 15 min
//! per-IP, 10 attempts / 30 min per-account.
//!
//! ## Backing store
//!
//! Plain `RwLock<HashMap<String, Vec<u64>>>`. No LRU cap today —
//! `fuz_app` uses `LruMap` to bound memory under key-enumeration; the
//! Rust port leaves that to a future iteration since the env-var gate
//! keeps the limiter off the production path until a deployment that
//! needs the cap exists.

use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

use tokio::sync::RwLock;

/// Configuration for a [`RateLimiter`] instance.
#[derive(Debug, Clone, Copy)]
pub struct RateLimiterOptions {
    /// Maximum allowed attempts within the window.
    pub max_attempts: u32,
    /// Sliding window duration in milliseconds.
    pub window_ms: u64,
}

/// Default per-IP login rate limit (5 attempts / 15 min). Mirrors
/// `fuz_app`'s `default_login_ip_rate_limit`.
pub const DEFAULT_LOGIN_IP_RATE_LIMIT: RateLimiterOptions = RateLimiterOptions {
    max_attempts: 5,
    window_ms: 15 * 60_000,
};

/// Default per-account login rate limit (10 attempts / 30 min). Mirrors
/// `fuz_app`'s `default_login_account_rate_limit`.
pub const DEFAULT_LOGIN_ACCOUNT_RATE_LIMIT: RateLimiterOptions = RateLimiterOptions {
    max_attempts: 10,
    window_ms: 30 * 60_000,
};

/// Result of a [`RateLimiter::check`] or [`RateLimiter::record`] call.
#[derive(Debug, Clone, Copy)]
pub struct RateLimitResult {
    /// Whether the request is allowed.
    pub allowed: bool,
    /// Seconds until the oldest active attempt expires (0 when allowed).
    pub retry_after: u64,
}

/// Sliding-window rate limiter.
pub struct RateLimiter {
    options: RateLimiterOptions,
    attempts: RwLock<HashMap<String, Vec<u64>>>,
}

impl RateLimiter {
    pub fn new(options: RateLimiterOptions) -> Self {
        Self {
            options,
            attempts: RwLock::new(HashMap::new()),
        }
    }

    /// Check whether `key` is currently below the cap. Prunes expired
    /// timestamps as a side effect (so the backing map stays bounded even
    /// under read-only traffic).
    pub async fn check(&self, key: &str) -> RateLimitResult {
        let now = now_ms();
        let cutoff = now.saturating_sub(self.options.window_ms);
        let max_attempts = self.options.max_attempts as usize;

        let mut attempts = self.attempts.write().await;
        let active = match attempts.get_mut(key) {
            Some(timestamps) => {
                timestamps.retain(|t| *t > cutoff);
                if timestamps.is_empty() {
                    attempts.remove(key);
                    return RateLimitResult {
                        allowed: true,
                        retry_after: 0,
                    };
                }
                timestamps.clone()
            }
            None => {
                return RateLimitResult {
                    allowed: true,
                    retry_after: 0,
                };
            }
        };
        drop(attempts);

        if active.len() < max_attempts {
            RateLimitResult {
                allowed: true,
                retry_after: 0,
            }
        } else {
            // Oldest timestamp + window − now, rounded up to seconds.
            let oldest = active[0];
            let retry_after_ms = oldest
                .saturating_add(self.options.window_ms)
                .saturating_sub(now);
            RateLimitResult {
                allowed: false,
                retry_after: retry_after_ms.div_ceil(1_000),
            }
        }
    }

    /// Record a failed attempt for `key`. Prunes expired entries first.
    pub async fn record(&self, key: &str) {
        let now = now_ms();
        let cutoff = now.saturating_sub(self.options.window_ms);

        let mut attempts = self.attempts.write().await;
        let entry = attempts.entry(key.to_owned()).or_default();
        entry.retain(|t| *t > cutoff);
        entry.push(now);
    }

    /// Clear all attempts for `key` (called after successful auth).
    pub async fn reset(&self, key: &str) {
        let mut attempts = self.attempts.write().await;
        attempts.remove(key);
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| {
            u64::try_from(d.as_millis()).unwrap_or(u64::MAX)
        })
        .unwrap_or(0)
}
