//! Persistence of the device token issued at enrollment.
//!
//! Security model (see `docs/SECURITY_MODEL.md` §2): the device token is
//! `"<device_id>.<device_secret>"` and is returned exactly once. It must be
//! protected at rest.
//!
//! * **Windows:** protected with DPAPI (`CryptProtectData`) bound to the current
//!   user (or machine scope for the service), then written to disk. Only the
//!   same principal on the same machine can unprotect it.
//! * **Non-Windows (dev/CI):** DPAPI does not exist. We fall back to a plain
//!   file with `0600` permissions and log a **loud INSECURE warning**. This path
//!   is for development on the Linux CI host only and must never ship to
//!   end users.

use anyhow::{Context, Result};
use std::path::Path;

/// Persist the device token, protected as strongly as the platform allows.
pub fn store_token(token_path: &Path, token: &str) -> Result<()> {
    if let Some(parent) = token_path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("creating token dir {}", parent.display()))?;
    }
    let protected = protect(token.as_bytes())?;
    write_file(token_path, &protected)?;
    Ok(())
}

/// Load and unprotect the device token, if one has been persisted.
pub fn load_token(token_path: &Path) -> Result<Option<String>> {
    if !token_path.exists() {
        return Ok(None);
    }
    let protected = std::fs::read(token_path)
        .with_context(|| format!("reading token file {}", token_path.display()))?;
    let plain = unprotect(&protected)?;
    let s = String::from_utf8(plain).context("device token is not valid UTF-8")?;
    Ok(Some(s))
}

// ---------------------------------------------------------------------------
// Windows: DPAPI
// ---------------------------------------------------------------------------
#[cfg(windows)]
fn protect(plain: &[u8]) -> Result<Vec<u8>> {
    dpapi::crypt_protect(plain)
}

#[cfg(windows)]
fn unprotect(protected: &[u8]) -> Result<Vec<u8>> {
    dpapi::crypt_unprotect(protected)
}

#[cfg(windows)]
fn write_file(path: &Path, bytes: &[u8]) -> Result<()> {
    // DPAPI blob is already user-bound; file ACLs inherit from LOCALAPPDATA.
    std::fs::write(path, bytes).with_context(|| format!("writing {}", path.display()))?;
    Ok(())
}

#[cfg(windows)]
//
// NOTE: this module is only compiled on Windows and therefore is NOT exercised
// by the Linux CI `cargo check`. It is written against the `windows` 0.58 API
// and is intended to be verified on a Windows build. The rest of the crate is
// fully Linux-verified.
mod dpapi {
    use anyhow::{bail, Result};
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::HLOCAL;
    use windows::Win32::Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPTPROTECT_FLAGS, CRYPT_INTEGER_BLOB,
    };
    use windows::Win32::System::Memory::LocalFree;

    fn to_blob(data: &[u8]) -> CRYPT_INTEGER_BLOB {
        CRYPT_INTEGER_BLOB {
            cbData: data.len() as u32,
            pbData: data.as_ptr() as *mut u8,
        }
    }

    /// Wrap plaintext with DPAPI (current-user scope).
    pub fn crypt_protect(plain: &[u8]) -> Result<Vec<u8>> {
        unsafe {
            let in_blob = to_blob(plain);
            let mut out_blob = CRYPT_INTEGER_BLOB::default();
            CryptProtectData(
                &in_blob,
                PCWSTR::null(),
                None,
                None,
                None,
                CRYPTPROTECT_FLAGS(0),
                &mut out_blob,
            )?;
            let slice =
                std::slice::from_raw_parts(out_blob.pbData, out_blob.cbData as usize).to_vec();
            let _ = LocalFree(HLOCAL(out_blob.pbData as *mut _));
            Ok(slice)
        }
    }

    /// Unwrap a DPAPI blob back to plaintext.
    pub fn crypt_unprotect(protected: &[u8]) -> Result<Vec<u8>> {
        unsafe {
            let in_blob = to_blob(protected);
            let mut out_blob = CRYPT_INTEGER_BLOB::default();
            if CryptUnprotectData(
                &in_blob,
                None,
                None,
                None,
                None,
                CRYPTPROTECT_FLAGS(0),
                &mut out_blob,
            )
            .is_err()
            {
                bail!("CryptUnprotectData failed (token unreadable; re-enrollment required)");
            }
            let slice =
                std::slice::from_raw_parts(out_blob.pbData, out_blob.cbData as usize).to_vec();
            let _ = LocalFree(HLOCAL(out_blob.pbData as *mut _));
            Ok(slice)
        }
    }
}

// ---------------------------------------------------------------------------
// Non-Windows: INSECURE dev fallback (plain file, 0600)
// ---------------------------------------------------------------------------
#[cfg(not(windows))]
fn protect(plain: &[u8]) -> Result<Vec<u8>> {
    tracing::warn!(
        "INSECURE dev fallback: device token stored WITHOUT DPAPI protection. \
         This build is for development/CI only and must not be shipped to end users."
    );
    Ok(plain.to_vec())
}

#[cfg(not(windows))]
fn unprotect(protected: &[u8]) -> Result<Vec<u8>> {
    Ok(protected.to_vec())
}

#[cfg(not(windows))]
fn write_file(path: &Path, bytes: &[u8]) -> Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;

    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)
        .with_context(|| format!("writing {}", path.display()))?;
    f.write_all(bytes)?;
    // Re-assert 0600 in case the file pre-existed with looser perms.
    let mut perms = f.metadata()?.permissions();
    #[allow(clippy::permissions_set_readonly_false)]
    {
        use std::os::unix::fs::PermissionsExt;
        perms.set_mode(0o600);
    }
    std::fs::set_permissions(path, perms)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_token() {
        let dir = std::env::temp_dir().join(format!("remote-agent-test-{}", uuid::Uuid::new_v4()));
        let path = dir.join("device_token.bin");
        let token = "device-123.secret-abcdef";
        store_token(&path, token).unwrap();
        let loaded = load_token(&path).unwrap();
        assert_eq!(loaded.as_deref(), Some(token));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn load_missing_returns_none() {
        let path = std::env::temp_dir().join("remote-agent-does-not-exist-xyz.bin");
        let _ = std::fs::remove_file(&path);
        assert!(load_token(&path).unwrap().is_none());
    }
}
