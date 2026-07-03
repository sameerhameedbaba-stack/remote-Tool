//! Signed-update readiness (interface only — not implemented).
//!
//! Contract (`docs/ARCHITECTURE.md` §6, `docs/SECURITY_MODEL.md` req 7): the
//! agent carries an `app_version` and a defined update flow so signing can be
//! added later without rearchitecting. This module is **interface only**: no
//! network calls, `unimplemented!()` bodies, explicit TODOs.
//!
//! Flow (each step must succeed before the next):
//!   1. fetch the update manifest from the update server,
//!   2. verify the manifest signature against a **pinned public key**,
//!   3. download the artifact named by the (verified) manifest,
//!   4. verify the artifact hash/signature,
//!   5. atomically swap the binary and restart.
//!
//! This module is intentionally interface-only, so its items are unused by the
//! MVP wiring today.
#![allow(dead_code)]

use anyhow::Result;

/// A parsed, not-yet-trusted update manifest.
#[derive(Debug, Clone)]
pub struct UpdateManifest {
    pub version: String,
    pub artifact_url: String,
    /// Hex SHA-256 of the artifact, covered by the manifest signature.
    pub artifact_sha256: String,
    /// Detached signature over the manifest bytes (base64).
    pub signature: String,
}

/// The pinned public key against which manifest signatures are verified.
/// TODO: embed the real Ed25519 public key at build time; never trust a key
/// fetched from the network.
pub const PINNED_UPDATE_PUBKEY: &str = "TODO-PINNED-ED25519-PUBLIC-KEY";

/// The update checker interface. Implementations perform the signed-update flow.
pub trait UpdateChecker {
    /// Step 1: fetch the manifest (no verification yet).
    fn fetch_manifest(&self) -> Result<UpdateManifest>;

    /// Step 2: verify `manifest`'s signature against [`PINNED_UPDATE_PUBKEY`].
    /// Returns `Ok(())` only for a valid signature.
    fn verify_manifest(&self, manifest: &UpdateManifest) -> Result<()>;

    /// Steps 3–4: download the artifact and verify its hash/signature.
    /// Returns the path to the verified artifact on disk.
    fn download_and_verify(&self, manifest: &UpdateManifest) -> Result<std::path::PathBuf>;

    /// Step 5: atomically swap in the verified artifact and arrange a restart.
    fn apply(&self, verified_artifact: &std::path::Path) -> Result<()>;
}

/// The concrete (unimplemented) checker. Present so wiring can reference a type.
pub struct SignedUpdateChecker {
    pub current_version: String,
    pub manifest_url: String,
}

impl UpdateChecker for SignedUpdateChecker {
    fn fetch_manifest(&self) -> Result<UpdateManifest> {
        // TODO: HTTP GET self.manifest_url, parse JSON. No network calls yet.
        unimplemented!("signed-update manifest fetch not implemented (MVP: manual updates)")
    }

    fn verify_manifest(&self, _manifest: &UpdateManifest) -> Result<()> {
        // TODO: Ed25519 verify manifest bytes against PINNED_UPDATE_PUBKEY.
        unimplemented!("signed-update signature verification not implemented")
    }

    fn download_and_verify(&self, _manifest: &UpdateManifest) -> Result<std::path::PathBuf> {
        // TODO: download artifact_url, check SHA-256 == manifest.artifact_sha256.
        unimplemented!("signed-update download/verify not implemented")
    }

    fn apply(&self, _verified_artifact: &std::path::Path) -> Result<()> {
        // TODO: atomic rename swap + service restart.
        unimplemented!("signed-update apply/swap not implemented")
    }
}
