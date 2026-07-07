use serde::de::DeserializeOwned;
use serde::Serialize;
use std::fs::{self, File};
use std::io::{self, Write};
use std::path::PathBuf;
use std::sync::Mutex;

#[derive(Debug)]
pub enum StoreError {
    Io(io::Error),
    Json(serde_json::Error),
    Other(String),
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StoreError::Io(e) => write!(f, "IO error: {}", e),
            StoreError::Json(e) => write!(f, "JSON error: {}", e),
            StoreError::Other(s) => write!(f, "Store error: {}", s),
        }
    }
}

impl std::error::Error for StoreError {}

impl From<io::Error> for StoreError {
    fn from(e: io::Error) -> Self {
        StoreError::Io(e)
    }
}

impl From<serde_json::Error> for StoreError {
    fn from(e: serde_json::Error) -> Self {
        StoreError::Json(e)
    }
}

impl From<StoreError> for String {
    fn from(e: StoreError) -> String {
        e.to_string()
    }
}

pub struct JsonStore<T> {
    path: PathBuf,
    lock: Mutex<()>,
    _marker: std::marker::PhantomData<T>,
}

impl<T: Serialize + DeserializeOwned + Default> JsonStore<T> {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            lock: Mutex::new(()),
            _marker: std::marker::PhantomData,
        }
    }


    pub fn load(&self) -> Result<T, StoreError> {
        self.load_with_migration(|_| {})
    }

    pub fn load_with_migration<F>(&self, migrate: F) -> Result<T, StoreError>
    where
        F: FnOnce(&mut serde_json::Value),
    {
        let _lock = self.lock.lock().unwrap();
        if !self.path.exists() {
            return Ok(T::default());
        }
        let contents = fs::read_to_string(&self.path)?;
        let mut value_json: serde_json::Value = serde_json::from_str(&contents)?;
        migrate(&mut value_json);
        let value = serde_json::from_value(value_json)?;
        Ok(value)
    }

    pub fn save(&self, value: &T) -> Result<(), StoreError> {
        let _lock = self.lock.lock().unwrap();
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)?;
        }

        let tmp_path = self.path.with_extension("json.tmp");
        
        {
            let mut file = File::create(&tmp_path)?;
            let json = serde_json::to_string_pretty(value)?;
            file.write_all(json.as_bytes())?;
            file.sync_all()?;
        }

        fs::rename(&tmp_path, &self.path)?;
        Ok(())
    }

    pub fn update<F>(&self, f: F) -> Result<T, StoreError>
    where
        F: FnOnce(&mut T),
    {
        self.update_with_migration(|_| {}, f)
    }

    pub fn update_with_migration<M, F>(&self, migrate: M, f: F) -> Result<T, StoreError>
    where
        M: FnOnce(&mut serde_json::Value),
        F: FnOnce(&mut T),
    {
        let _lock = self.lock.lock().unwrap();
        
        let mut value = if !self.path.exists() {
            T::default()
        } else {
            let contents = fs::read_to_string(&self.path)?;
            let mut value_json: serde_json::Value = serde_json::from_str(&contents)?;
            migrate(&mut value_json);
            serde_json::from_value(value_json)?
        };

        f(&mut value);

        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)?;
        }

        let tmp_path = self.path.with_extension("json.tmp");
        
        {
            let mut file = File::create(&tmp_path)?;
            let json = serde_json::to_string_pretty(&value)?;
            file.write_all(json.as_bytes())?;
            file.sync_all()?;
        }

        fs::rename(&tmp_path, &self.path)?;
        Ok(value)
    }
}
