//! Source digest helper.

use sha2::{Digest, Sha256};

/// SHA-256 hex digest of a source string.
pub fn digest(source: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(source.as_bytes());
    hex::encode(hasher.finalize())
}