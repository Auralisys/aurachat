use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::Duration,
};

const REVISION: &str = "c3cd6b5649c6125a6c37bebf3131bb5f35c983b3";
const FILES: &[(&str, u64, &str)] = &[
    (
        "0.onnx",
        325_532_387,
        "7d5df8ecf7d4b1878015a32686053fd0eebe2bc377234608764cc0ef3636a6c5",
    ),
    (
        "0.bin",
        28_214_398,
        "bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d",
    ),
];
const SAMPLE_RATE: u32 = 24_000;
const MAX_TEXT_CHARS: usize = 8_000;
const VOICES: &[&str] = &["if_sara", "im_nicola"];

#[derive(Clone, Serialize)]
pub struct ModelStatus {
    pub ready: bool,
    pub busy: bool,
    pub loading: bool,
    pub loaded: bool,
    pub downloaded: u64,
    pub total: u64,
}

#[derive(Serialize)]
pub struct Audio {
    pub sample_rate: u32,
    pub samples: Vec<f32>,
}

pub struct Tts {
    root: PathBuf,
    busy: AtomicBool,
    cancel: AtomicBool,
    loading: AtomicBool,
    loaded: AtomicBool,
    model: Mutex<Option<kokoro_micro::TtsEngine>>,
}

struct Operation<'a>(&'a AtomicBool);
impl Drop for Operation<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

struct Loading<'a>(&'a AtomicBool);
impl<'a> Loading<'a> {
    fn new(flag: &'a AtomicBool) -> Self {
        flag.store(true, Ordering::SeqCst);
        Self(flag)
    }
}
impl Drop for Loading<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

impl Tts {
    pub fn new(config_dir: &Path) -> Self {
        Self {
            root: config_dir.join("models/kokoro-82m-c3cd6b56"),
            busy: AtomicBool::new(false),
            cancel: AtomicBool::new(false),
            loading: AtomicBool::new(false),
            loaded: AtomicBool::new(false),
            model: Mutex::new(None),
        }
    }

    fn operation(&self) -> Result<Operation<'_>, String> {
        self.busy
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .map_err(|_| "tts_busy".to_string())?;
        Ok(Operation(&self.busy))
    }

    pub fn status(&self) -> ModelStatus {
        let complete = FILES
            .iter()
            .all(|(name, size, _)| fs::metadata(self.root.join(name)).is_ok_and(|m| m.len() == *size));
        let downloaded = FILES
            .iter()
            .map(|(name, size, _)| {
                let final_size = fs::metadata(self.root.join(name)).map_or(0, |m| m.len());
                if final_size == *size {
                    *size
                } else {
                    fs::metadata(self.root.join(format!("{name}.part")))
                        .map_or(0, |m| m.len().min(*size))
                }
            })
            .sum();
        ModelStatus {
            ready: complete
                && fs::read_to_string(self.root.join("verified"))
                    .is_ok_and(|revision| revision == REVISION),
            busy: self.busy.load(Ordering::SeqCst),
            loading: self.loading.load(Ordering::SeqCst),
            loaded: self.loaded.load(Ordering::SeqCst),
            downloaded,
            total: FILES.iter().map(|file| file.1).sum(),
        }
    }

    pub fn cancel(&self) {
        self.cancel.store(true, Ordering::SeqCst);
    }

    fn check_cancel(&self) -> Result<(), String> {
        if self.cancel.load(Ordering::SeqCst) {
            Err("tts_cancelled".into())
        } else {
            Ok(())
        }
    }

    fn verify(&self, path: &Path, expected: &str) -> Result<(), String> {
        let mut file = File::open(path).map_err(|error| error.to_string())?;
        let mut hash = Sha256::new();
        let mut buffer = [0u8; 256 * 1024];
        loop {
            self.check_cancel()?;
            let count = file.read(&mut buffer).map_err(|error| error.to_string())?;
            if count == 0 {
                break;
            }
            hash.update(&buffer[..count]);
        }
        if format!("{:x}", hash.finalize()) != expected {
            return Err("tts_checksum".into());
        }
        Ok(())
    }

    pub async fn download(&self, progress: impl Fn(ModelStatus)) -> Result<ModelStatus, String> {
        let guard = self.operation()?;
        self.cancel.store(false, Ordering::SeqCst);
        fs::create_dir_all(&self.root).map_err(|error| error.to_string())?;
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(20))
            .read_timeout(Duration::from_secs(30))
            .build()
            .map_err(|error| error.to_string())?;

        for &(name, size, checksum) in FILES {
            self.check_cancel()?;
            let target = self.root.join(name);
            if fs::metadata(&target).is_ok_and(|metadata| metadata.len() == size) {
                if self.verify(&target, checksum).is_ok() {
                    continue;
                }
                fs::remove_file(&target).map_err(|error| error.to_string())?;
            }

            let partial = self.root.join(format!("{name}.part"));
            let mut offset = fs::metadata(&partial).map_or(0, |metadata| metadata.len());
            if offset > size {
                fs::remove_file(&partial).map_err(|error| error.to_string())?;
                offset = 0;
            }
            if offset < size {
                let url = format!(
                    "https://media.githubusercontent.com/media/8b-is/kokoro-tiny/{REVISION}/models/{name}"
                );
                let mut request = client.get(url);
                if offset > 0 {
                    request = request.header(reqwest::header::RANGE, format!("bytes={offset}-"));
                }
                let mut response = request
                    .send()
                    .await
                    .map_err(|error| error.to_string())?
                    .error_for_status()
                    .map_err(|error| error.to_string())?;
                self.check_cancel()?;
                if response.status() == reqwest::StatusCode::PARTIAL_CONTENT {
                    let expected = format!("bytes {offset}-");
                    if !response
                        .headers()
                        .get(reqwest::header::CONTENT_RANGE)
                        .and_then(|header| header.to_str().ok())
                        .is_some_and(|range| range.starts_with(&expected))
                    {
                        return Err("tts_download_range".into());
                    }
                } else {
                    offset = 0;
                }
                let mut file = OpenOptions::new()
                    .create(true)
                    .write(true)
                    .append(offset > 0)
                    .truncate(offset == 0)
                    .open(&partial)
                    .map_err(|error| error.to_string())?;
                let mut last_emit = std::time::Instant::now();
                while let Some(chunk) = response.chunk().await.map_err(|error| error.to_string())? {
                    self.check_cancel()?;
                    if offset + chunk.len() as u64 > size {
                        return Err("tts_download_size".into());
                    }
                    file.write_all(&chunk).map_err(|error| error.to_string())?;
                    offset += chunk.len() as u64;
                    if last_emit.elapsed() > Duration::from_millis(200) {
                        progress(self.status());
                        last_emit = std::time::Instant::now();
                    }
                }
                file.sync_all().map_err(|error| error.to_string())?;
            }
            if offset != size {
                return Err("tts_download_size".into());
            }
            if let Err(error) = self.verify(&partial, checksum) {
                if error == "tts_checksum" {
                    let _ = fs::remove_file(&partial);
                }
                return Err(error);
            }
            if target.exists() {
                fs::remove_file(&target).map_err(|error| error.to_string())?;
            }
            fs::rename(&partial, &target).map_err(|error| error.to_string())?;
            progress(self.status());
        }

        fs::write(
            self.root.join("LICENSE.txt"),
            include_str!("../../ui/vendor/speech-APACHE-2.0.txt"),
        )
        .map_err(|error| error.to_string())?;
        fs::write(self.root.join("NOTICE.txt"), MODEL_NOTICE)
            .map_err(|error| error.to_string())?;
        fs::write(self.root.join("verified"), REVISION)
            .map_err(|error| error.to_string())?;
        drop(guard);
        let status = self.status();
        progress(status.clone());
        Ok(status)
    }

    pub fn remove(&self) -> Result<ModelStatus, String> {
        let guard = self.operation()?;
        *self.model.lock().map_err(|_| "tts_engine")? = None;
        self.loaded.store(false, Ordering::SeqCst);
        for &(name, _, _) in FILES {
            for path in [self.root.join(name), self.root.join(format!("{name}.part"))] {
                if path.exists() {
                    fs::remove_file(path).map_err(|error| error.to_string())?;
                }
            }
        }
        for name in ["LICENSE.txt", "NOTICE.txt", "verified"] {
            let path = self.root.join(name);
            if path.exists() {
                fs::remove_file(path).map_err(|error| error.to_string())?;
            }
        }
        drop(guard);
        Ok(self.status())
    }

    fn load_model(
        &self,
        model: &mut Option<kokoro_micro::TtsEngine>,
        progress: &impl Fn(ModelStatus),
    ) -> Result<(), String> {
        if model.is_none() {
            let _loading = Loading::new(&self.loading);
            progress(self.status());
            for &(name, _, checksum) in FILES {
                self.verify(&self.root.join(name), checksum)?;
            }
            self.check_cancel()?;
            let model_path = self.root.join("0.onnx");
            let voices_path = self.root.join("0.bin");
            let model_path = model_path.to_str().ok_or("tts_model_path")?;
            let voices_path = voices_path.to_str().ok_or("tts_model_path")?;
            let loaded = tauri::async_runtime::block_on(kokoro_micro::TtsEngine::with_paths(
                model_path,
                voices_path,
            ))
            .map_err(|error| format!("tts_engine: {error}"))?;
            if VOICES.iter().any(|voice| !loaded.voices().iter().any(|item| item == voice)) {
                return Err("tts_voice_missing".into());
            }
            *model = Some(loaded);
            self.loaded.store(true, Ordering::SeqCst);
        }
        Ok(())
    }

    pub fn prepare_with_progress(
        &self,
        progress: impl Fn(ModelStatus),
    ) -> Result<(), String> {
        if self.loaded.load(Ordering::SeqCst) {
            return Ok(());
        }
        let _guard = self.operation()?;
        if !self.status().ready {
            return Err("tts_model_missing".into());
        }
        self.cancel.store(false, Ordering::SeqCst);
        let mut model = self.model.lock().map_err(|_| "tts_engine")?;
        progress(self.status());
        self.load_model(&mut model, &progress)
    }

    pub fn synthesize_with_progress(
        &self,
        text: String,
        voice: String,
        progress: impl Fn(ModelStatus),
    ) -> Result<Audio, String> {
        validate_request(&text, &voice)?;
        let _guard = self.operation()?;
        if !self.status().ready {
            return Err("tts_model_missing".into());
        }
        self.cancel.store(false, Ordering::SeqCst);
        let mut model = self.model.lock().map_err(|_| "tts_engine")?;
        progress(self.status());
        self.load_model(&mut model, &progress)?;
        self.check_cancel()?;
        let audio = model
            .as_ref()
            .ok_or("tts_engine")?
            .synthesize_with_options(&text, Some(&voice), 1.0, 1.0, None)
            .map_err(|error| format!("tts_engine: {error}"))?;
        if audio.is_empty() || audio.iter().any(|sample| !sample.is_finite()) {
            return Err("tts_audio_invalid".into());
        }
        Ok(Audio {
            sample_rate: SAMPLE_RATE,
            samples: audio,
        })
    }
}

fn validate_request(text: &str, voice: &str) -> Result<(), String> {
    if text.trim().is_empty() || text.contains('\0') {
        return Err("tts_invalid_text".into());
    }
    if text.chars().count() > MAX_TEXT_CHARS {
        return Err("tts_text_too_long".into());
    }
    if !VOICES.contains(&voice) {
        return Err("tts_voice".into());
    }
    Ok(())
}

const MODEL_NOTICE: &str = "Kokoro-82M model and voice assets: Apache-2.0. Model files are served from 8b-is/kokoro-tiny, pinned to revision c3cd6b5649c6125a6c37bebf3131bb5f35c983b3. The Rust inference and Italian phonemization library is kokoro-micro (Apache-2.0). See https://github.com/hexgrad/Kokoro-82M, https://github.com/8b-is/kokoro-tiny, and https://github.com/DavidValin/kokoro-micro.\n";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_voice_and_text_limits() {
        assert!(validate_request("Ciao, mondo.", "if_sara").is_ok());
        assert!(validate_request("Ciao, mondo.", "im_nicola").is_ok());
        assert_eq!(validate_request("", "if_sara").unwrap_err(), "tts_invalid_text");
        assert_eq!(validate_request("Ciao", "unknown").unwrap_err(), "tts_voice");
        assert_eq!(
            validate_request(&"a".repeat(MAX_TEXT_CHARS + 1), "if_sara").unwrap_err(),
            "tts_text_too_long"
        );
    }

    #[test]
    fn rejects_tampered_files_and_counts_resumable_downloads() {
        let root = std::env::temp_dir().join(format!("aurachat-tts-test-{}", std::process::id()));
        let service = Tts::new(&root);
        fs::create_dir_all(&service.root).unwrap();
        fs::write(service.root.join("0.onnx.part"), b"partial").unwrap();
        assert!(!service.status().ready);
        assert_eq!(service.status().downloaded, 7);
        assert_eq!(
            service.verify(&service.root.join("0.onnx.part"), "wrong").unwrap_err(),
            "tts_checksum"
        );
        service.remove().unwrap();
        fs::remove_dir(&service.root).unwrap();
        fs::remove_dir(root.join("models")).unwrap();
        fs::remove_dir(root).unwrap();
    }

    #[test]
    #[ignore = "downloads 354 MB into a temporary folder and runs real CPU synthesis"]
    fn real_download_and_synthesis() {
        let root = std::env::temp_dir().join("aurachat-tts-smoke");
        let service = Tts::new(&root);
        tauri::async_runtime::block_on(
            service.download(|s| eprintln!("Model {} / {}", s.downloaded, s.total)),
        )
        .unwrap();
        assert!(service.status().ready);
        let text = "Buongiorno, questa è una prova della voce italiana di AuraChat.";
        for voice in VOICES {
            for attempt in 1..=2 {
                let started = std::time::Instant::now();
                let audio = service
                    .synthesize_with_progress(text.into(), (*voice).into(), |_| {})
                    .unwrap();
                let seconds = audio.samples.len() as f32 / audio.sample_rate as f32;
                let rms = (audio.samples.iter().map(|s| s * s).sum::<f32>()
                    / audio.samples.len() as f32)
                    .sqrt();
                eprintln!(
                    "{voice} #{attempt}: {seconds:.1}s of audio in {:?}, rms {rms:.3}",
                    started.elapsed()
                );
                assert_eq!(audio.sample_rate, SAMPLE_RATE);
                assert!((2.5..15.0).contains(&seconds));
                assert!(rms > 0.01);
            }
        }
        fs::remove_dir_all(root).unwrap();
    }
}
