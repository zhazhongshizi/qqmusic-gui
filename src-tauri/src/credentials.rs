use std::fmt;
#[cfg(test)]
use std::sync::Mutex;

use zeroize::Zeroizing;

const SECRET_MAGIC: &[u8; 4] = b"QMG\0";
pub const SECRET_BLOB_VERSION: u16 = 1;
const MAX_CREDENTIAL_BLOB_BYTES: usize = 5 * 512;
const SECRET_HEADER_BYTES: usize = SECRET_MAGIC.len() + std::mem::size_of::<u16>();
const DEFAULT_CREDENTIAL_TARGET: &str = "QQMusicGUI/Auth/v1";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CredentialError {
    Unavailable,
    InvalidSecret,
    UnsupportedVersion,
    TooLarge,
}

pub struct SecretBlob {
    bytes: Zeroizing<Vec<u8>>,
}

impl SecretBlob {
    pub fn new(payload: Vec<u8>) -> Result<Self, CredentialError> {
        let payload = Zeroizing::new(payload);
        if payload.is_empty() {
            return Err(CredentialError::InvalidSecret);
        }
        if payload.len() > MAX_CREDENTIAL_BLOB_BYTES - SECRET_HEADER_BYTES {
            return Err(CredentialError::TooLarge);
        }

        let mut bytes = Zeroizing::new(Vec::with_capacity(SECRET_HEADER_BYTES + payload.len()));
        bytes.extend_from_slice(SECRET_MAGIC);
        bytes.extend_from_slice(&SECRET_BLOB_VERSION.to_be_bytes());
        bytes.extend_from_slice(&payload);
        Ok(Self { bytes })
    }

    fn from_stored(bytes: Vec<u8>) -> Result<Self, CredentialError> {
        let bytes = Zeroizing::new(bytes);
        if bytes.len() <= SECRET_HEADER_BYTES || bytes.len() > MAX_CREDENTIAL_BLOB_BYTES {
            return Err(CredentialError::InvalidSecret);
        }
        if &bytes[..SECRET_MAGIC.len()] != SECRET_MAGIC {
            return Err(CredentialError::InvalidSecret);
        }
        let version =
            u16::from_be_bytes([bytes[SECRET_MAGIC.len()], bytes[SECRET_MAGIC.len() + 1]]);
        if version != SECRET_BLOB_VERSION {
            return Err(CredentialError::UnsupportedVersion);
        }
        Ok(Self { bytes })
    }

    pub fn payload(&self) -> &[u8] {
        &self.bytes[SECRET_HEADER_BYTES..]
    }

    fn stored_bytes(&self) -> &[u8] {
        &self.bytes
    }
}

impl Clone for SecretBlob {
    fn clone(&self) -> Self {
        Self {
            bytes: Zeroizing::new(self.bytes.to_vec()),
        }
    }
}

impl fmt::Debug for SecretBlob {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("SecretBlob([REDACTED])")
    }
}

pub trait CredentialStore: Send + Sync {
    fn read(&self) -> Result<Option<SecretBlob>, CredentialError>;
    fn replace(&self, secret: &SecretBlob) -> Result<(), CredentialError>;
    fn delete(&self) -> Result<(), CredentialError>;
}

#[cfg(test)]
#[derive(Default)]
pub struct MemoryCredentialStore {
    secret: Mutex<Option<SecretBlob>>,
}

#[cfg(test)]
impl CredentialStore for MemoryCredentialStore {
    fn read(&self) -> Result<Option<SecretBlob>, CredentialError> {
        self.secret
            .lock()
            .map(|secret| secret.clone())
            .map_err(|_| CredentialError::Unavailable)
    }

    fn replace(&self, secret: &SecretBlob) -> Result<(), CredentialError> {
        let mut current = self
            .secret
            .lock()
            .map_err(|_| CredentialError::Unavailable)?;
        *current = Some(secret.clone());
        Ok(())
    }

    fn delete(&self) -> Result<(), CredentialError> {
        let mut current = self
            .secret
            .lock()
            .map_err(|_| CredentialError::Unavailable)?;
        *current = None;
        Ok(())
    }
}

#[cfg(windows)]
pub struct WindowsCredentialStore {
    target: Vec<u16>,
}

#[cfg(windows)]
impl WindowsCredentialStore {
    pub fn new() -> Self {
        Self::with_target(DEFAULT_CREDENTIAL_TARGET)
    }

    fn with_target(target: &str) -> Self {
        Self {
            target: target.encode_utf16().chain(std::iter::once(0)).collect(),
        }
    }
}

#[cfg(windows)]
impl Default for WindowsCredentialStore {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(windows)]
impl CredentialStore for WindowsCredentialStore {
    fn read(&self) -> Result<Option<SecretBlob>, CredentialError> {
        use std::ptr;
        use windows::core::{HRESULT, PCWSTR};
        use windows::Win32::Foundation::ERROR_NOT_FOUND;
        use windows::Win32::Security::Credentials::{
            CredFree, CredReadW, CREDENTIALW, CRED_TYPE_GENERIC,
        };

        let mut raw_credential: *mut CREDENTIALW = ptr::null_mut();
        let result = unsafe {
            CredReadW(
                PCWSTR(self.target.as_ptr()),
                CRED_TYPE_GENERIC,
                None,
                &mut raw_credential,
            )
        };
        if let Err(error) = result {
            if error.code() == HRESULT::from_win32(ERROR_NOT_FOUND.0) {
                return Ok(None);
            }
            return Err(CredentialError::Unavailable);
        }
        if raw_credential.is_null() {
            return Err(CredentialError::Unavailable);
        }

        let result = unsafe {
            let credential = &*raw_credential;
            let size = credential.CredentialBlobSize as usize;
            if size == 0 || size > MAX_CREDENTIAL_BLOB_BYTES || credential.CredentialBlob.is_null()
            {
                Err(CredentialError::InvalidSecret)
            } else {
                let bytes = std::slice::from_raw_parts(credential.CredentialBlob, size).to_vec();
                SecretBlob::from_stored(bytes).map(Some)
            }
        };
        unsafe { CredFree(raw_credential.cast()) };
        result
    }

    fn replace(&self, secret: &SecretBlob) -> Result<(), CredentialError> {
        use windows::core::{PCWSTR, PWSTR};
        use windows::Win32::Security::Credentials::{
            CredWriteW, CREDENTIALW, CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC,
        };

        let mut credential = CREDENTIALW {
            Type: CRED_TYPE_GENERIC,
            TargetName: PWSTR(self.target.as_ptr().cast_mut()),
            CredentialBlobSize: secret.stored_bytes().len() as u32,
            CredentialBlob: secret.stored_bytes().as_ptr().cast_mut(),
            Persist: CRED_PERSIST_LOCAL_MACHINE,
            ..Default::default()
        };
        credential.UserName = PWSTR::null();
        credential.Comment = PWSTR::null();
        credential.TargetAlias = PWSTR::null();
        let _keep_target_alive = PCWSTR(self.target.as_ptr());
        unsafe { CredWriteW(&credential, 0) }.map_err(|_| CredentialError::Unavailable)
    }

    fn delete(&self) -> Result<(), CredentialError> {
        use windows::core::{HRESULT, PCWSTR};
        use windows::Win32::Foundation::ERROR_NOT_FOUND;
        use windows::Win32::Security::Credentials::{CredDeleteW, CRED_TYPE_GENERIC};

        match unsafe { CredDeleteW(PCWSTR(self.target.as_ptr()), CRED_TYPE_GENERIC, None) } {
            Ok(()) => Ok(()),
            Err(error) if error.code() == HRESULT::from_win32(ERROR_NOT_FOUND.0) => Ok(()),
            Err(_) => Err(CredentialError::Unavailable),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secret_blob_is_versioned_bounded_and_redacted() {
        let blob = SecretBlob::new(b"uin=SENTINEL_UIN;qqmusic_key=SENTINEL_KEY".to_vec())
            .expect("valid secret");
        assert_eq!(blob.payload(), b"uin=SENTINEL_UIN;qqmusic_key=SENTINEL_KEY");
        assert_eq!(format!("{blob:?}"), "SecretBlob([REDACTED])");
        assert!(!format!("{blob:?}").contains("SENTINEL"));

        assert!(matches!(
            SecretBlob::new(Vec::new()),
            Err(CredentialError::InvalidSecret)
        ));
        assert!(matches!(
            SecretBlob::new(vec![0; MAX_CREDENTIAL_BLOB_BYTES]),
            Err(CredentialError::TooLarge)
        ));
    }

    #[test]
    fn memory_store_replaces_and_deletes_as_one_blob() {
        let store = MemoryCredentialStore::default();
        let old = SecretBlob::new(b"old-secret".to_vec()).expect("old secret");
        let new = SecretBlob::new(b"new-secret".to_vec()).expect("new secret");

        assert!(store.read().expect("empty store").is_none());
        store.replace(&old).expect("store old secret");
        store.replace(&new).expect("replace secret");
        assert_eq!(
            store
                .read()
                .expect("read new secret")
                .expect("secret")
                .payload(),
            b"new-secret"
        );
        store.delete().expect("delete secret");
        assert!(store.read().expect("deleted store").is_none());
    }

    #[test]
    fn stored_blob_rejects_unknown_versions() {
        let blob = SecretBlob::new(b"fixture".to_vec()).expect("valid blob");
        let mut bytes = blob.stored_bytes().to_vec();
        bytes[SECRET_MAGIC.len() + 1] = 2;
        assert!(matches!(
            SecretBlob::from_stored(bytes),
            Err(CredentialError::UnsupportedVersion)
        ));
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "writes one unique temporary item to Windows Credential Manager"]
    fn windows_credential_manager_round_trip_uses_unique_target() {
        use uuid::Uuid;

        let target = format!("QQMusicGUI/Test/{}", Uuid::new_v4());
        let store = WindowsCredentialStore::with_target(&target);
        let secret = SecretBlob::new(b"credential-manager-smoke".to_vec()).expect("secret");
        let result = (|| {
            store.replace(&secret)?;
            let restored = store.read()?.ok_or(CredentialError::Unavailable)?;
            if restored.payload() != secret.payload() {
                return Err(CredentialError::InvalidSecret);
            }
            Ok(())
        })();
        let cleanup = store.delete();
        result.expect("credential manager round trip");
        cleanup.expect("remove temporary credential");
        assert!(store.read().expect("verify cleanup").is_none());
    }
}
