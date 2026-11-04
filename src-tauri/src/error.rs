use std::fmt;
use std::path::PathBuf;

/// Error type shared by all backend modules. It serializes to a plain
/// `{ kind, message }` object so the frontend can show meaningful errors.
#[derive(Debug)]
pub enum AppError {
    Io {
        path: PathBuf,
        source: std::io::Error,
    },
    Json {
        path: PathBuf,
        source: serde_json::Error,
    },
    Database(rusqlite::Error),
    /// A file was unreadable/corrupt and no valid backup could replace it.
    Corrupt {
        path: PathBuf,
        detail: String,
    },
    /// A target already exists and the operation must never overwrite it.
    AlreadyExists(PathBuf),
    /// The data changed on disk since the caller last read it.
    Conflict(String),
    Invalid(String),
}

impl AppError {
    pub fn io(path: impl Into<PathBuf>, source: std::io::Error) -> Self {
        AppError::Io {
            path: path.into(),
            source,
        }
    }

    fn kind(&self) -> &'static str {
        match self {
            AppError::Io { .. } => "io",
            AppError::Json { .. } => "json",
            AppError::Database(_) => "database",
            AppError::Corrupt { .. } => "corrupt",
            AppError::AlreadyExists(_) => "already_exists",
            AppError::Conflict(_) => "conflict",
            AppError::Invalid(_) => "invalid",
        }
    }
}

impl fmt::Display for AppError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            AppError::Io { path, source } => write!(f, "I/O error at {}: {source}", path.display()),
            AppError::Json { path, source } => {
                write!(f, "Invalid JSON in {}: {source}", path.display())
            }
            AppError::Database(e) => write!(f, "Database error: {e}"),
            AppError::Corrupt { path, detail } => {
                write!(
                    f,
                    "{} is corrupt and could not be recovered: {detail}",
                    path.display()
                )
            }
            AppError::AlreadyExists(p) => write!(f, "{} already exists", p.display()),
            AppError::Conflict(msg) | AppError::Invalid(msg) => write!(f, "{msg}"),
        }
    }
}

impl std::error::Error for AppError {}

impl From<rusqlite::Error> for AppError {
    fn from(e: rusqlite::Error) -> Self {
        AppError::Database(e)
    }
}

impl serde::Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut st = s.serialize_struct("AppError", 2)?;
        st.serialize_field("kind", self.kind())?;
        st.serialize_field("message", &self.to_string())?;
        st.end()
    }
}

pub type AppResult<T> = Result<T, AppError>;
