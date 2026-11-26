use std::{fs::{self, File, OpenOptions}, io::{Read, Write}, path::PathBuf, sync::{Mutex, atomic::{AtomicBool, Ordering}}, time::Duration};
use serde::Serialize;
use sha2::{Digest, Sha256};
use transcribe_rs::whisper_cpp::{WhisperEngine, WhisperInferenceParams};

// Whisper Large v3 (GGML, f16) from the whisper.cpp model repository, pinned by revision and hash.
const REVISION: &str = "5359861c739e955e79d9a303bcbc70fb988958b1";
const MODEL: &str = "ggml-large-v3.bin";
const FILES: &[(&str, u64, &str)] = &[
    (MODEL, 3095033483, "64d182b440b98d5203c4f9bd541544d84c605196c4f7b845dfa11fb23594d1e2"),
];
const LEGACY_DIR: &str = "models/cohere-int4-2c870f89";

#[derive(Clone, Serialize)]
pub struct ModelStatus { pub ready: bool, pub busy: bool, pub loading: bool, pub loaded: bool, pub downloaded: u64, pub total: u64 }

#[derive(Debug, Serialize)]
pub struct Preview { pub text: String, pub committed: String, pub advance: usize }

pub struct Speech {
    root: PathBuf,
    busy: AtomicBool,
    cancel: AtomicBool,
    loading: AtomicBool,
    loaded: AtomicBool,
    model: Mutex<Option<WhisperEngine>>,
}
struct Operation<'a>(&'a AtomicBool);
impl Drop for Operation<'_> { fn drop(&mut self) { self.0.store(false, Ordering::SeqCst); } }
// Publishes "weights are being verified and loaded into memory" for the whole loading window.
struct Loading<'a>(&'a AtomicBool);
impl<'a> Loading<'a> { fn new(flag: &'a AtomicBool) -> Self { flag.store(true, Ordering::SeqCst); Self(flag) } }
impl Drop for Loading<'_> { fn drop(&mut self) { self.0.store(false, Ordering::SeqCst); } }

impl Speech {
    pub fn new(config_dir: &std::path::Path) -> Self {
        // Cohere Transcribe was replaced by Whisper: reclaim its ~2 GB in the background.
        let legacy = config_dir.join(LEGACY_DIR);
        if legacy.exists() { std::thread::spawn(move || { let _ = fs::remove_dir_all(legacy); }); }
        Self { root: config_dir.join("models/whisper-large-v3-5359861c"), busy: AtomicBool::new(false), cancel: AtomicBool::new(false), loading: AtomicBool::new(false), loaded: AtomicBool::new(false), model: Mutex::new(None) }
    }
    fn operation(&self) -> Result<Operation<'_>, String> {
        self.busy.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).map_err(|_| "speech_busy")?;
        Ok(Operation(&self.busy))
    }
    pub fn status(&self) -> ModelStatus {
        let complete = FILES.iter().all(|(name, size, _)| fs::metadata(self.root.join(name)).is_ok_and(|m| m.len() == *size));
        let downloaded = FILES.iter().map(|(name, size, _)| {
            let final_size = fs::metadata(self.root.join(name)).map_or(0, |m| m.len());
            if final_size == *size { *size } else { fs::metadata(self.root.join(format!("{name}.part"))).map_or(0, |m| m.len().min(*size)) }
        }).sum();
        ModelStatus { ready: complete && fs::read_to_string(self.root.join("verified")).is_ok_and(|s| s == REVISION), busy: self.busy.load(Ordering::SeqCst), loading: self.loading.load(Ordering::SeqCst), loaded: self.loaded.load(Ordering::SeqCst), downloaded, total: FILES.iter().map(|f| f.1).sum() }
    }
    pub fn cancel(&self) { self.cancel.store(true, Ordering::SeqCst); }
    fn check_cancel(&self) -> Result<(), String> { if self.cancel.load(Ordering::SeqCst) { Err("speech_cancelled".into()) } else { Ok(()) } }

    fn verify(&self, path: &std::path::Path, expected: &str) -> Result<(), String> {
        let mut file = File::open(path).map_err(|e| e.to_string())?;
        let mut hash = Sha256::new();
        let mut buffer = [0u8; 1024 * 256];
        loop {
            self.check_cancel()?;
            let n = file.read(&mut buffer).map_err(|e| e.to_string())?;
            if n == 0 { break; }
            hash.update(&buffer[..n]);
        }
        if format!("{:x}", hash.finalize()) != expected { return Err("speech_checksum".into()); }
        Ok(())
    }

    pub async fn download(&self, progress: impl Fn(ModelStatus)) -> Result<ModelStatus, String> {
        let guard = self.operation()?;
        self.cancel.store(false, Ordering::SeqCst);
        fs::create_dir_all(&self.root).map_err(|e| e.to_string())?;
        let client = reqwest::Client::builder().connect_timeout(Duration::from_secs(20)).read_timeout(Duration::from_secs(30)).build().map_err(|e| e.to_string())?;
        for &(name, size, checksum) in FILES {
            self.check_cancel()?;
            let target = self.root.join(name);
            if fs::metadata(&target).is_ok_and(|m| m.len() == size) && self.verify(&target, checksum).is_ok() { continue; }
            let partial = self.root.join(format!("{name}.part"));
            let mut offset = fs::metadata(&partial).map_or(0, |m| m.len());
            if offset > size { fs::remove_file(&partial).map_err(|e| e.to_string())?; offset = 0; }
            if offset < size {
                let url = format!("https://huggingface.co/ggerganov/whisper.cpp/resolve/{REVISION}/{name}");
                let mut request = client.get(url);
                if offset > 0 { request = request.header(reqwest::header::RANGE, format!("bytes={offset}-")); }
                let mut response = request.send().await.map_err(|e| e.to_string())?.error_for_status().map_err(|e| e.to_string())?;
                self.check_cancel()?;
                if response.status() == reqwest::StatusCode::PARTIAL_CONTENT {
                    let expected = format!("bytes {offset}-");
                    if !response.headers().get(reqwest::header::CONTENT_RANGE).and_then(|h| h.to_str().ok()).is_some_and(|s| s.starts_with(&expected)) { return Err("speech_download_range".into()); }
                } else { offset = 0; }
                let mut file = OpenOptions::new().create(true).write(true).append(offset > 0).truncate(offset == 0).open(&partial).map_err(|e| e.to_string())?;
                let mut last_emit = std::time::Instant::now();
                while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
                    self.check_cancel()?;
                    if offset + chunk.len() as u64 > size { return Err("speech_download_size".into()); }
                    file.write_all(&chunk).map_err(|e| e.to_string())?;
                    offset += chunk.len() as u64;
                    if last_emit.elapsed() > Duration::from_millis(200) { progress(self.status()); last_emit = std::time::Instant::now(); }
                }
                file.sync_all().map_err(|e| e.to_string())?;
            }
            if offset != size { return Err("speech_download_size".into()); }
            if let Err(e) = self.verify(&partial, checksum) {
                if e == "speech_checksum" { let _ = fs::remove_file(&partial); }
                return Err(e);
            }
            if target.exists() { fs::remove_file(&target).map_err(|e| e.to_string())?; }
            fs::rename(&partial, &target).map_err(|e| e.to_string())?;
            progress(self.status());
        }
        fs::write(self.root.join("LICENSE.txt"), include_str!("../../ui/vendor/whisper-MIT.txt")).map_err(|e| e.to_string())?;
        fs::write(self.root.join("verified"), REVISION).map_err(|e| e.to_string())?;
        drop(guard);
        let status = self.status(); progress(status.clone()); Ok(status)
    }

    pub fn remove(&self) -> Result<ModelStatus, String> {
        let guard = self.operation()?;
        *self.model.lock().map_err(|_| "speech_engine")? = None;
        self.loaded.store(false, Ordering::SeqCst);
        for &(name, _, _) in FILES {
            for path in [self.root.join(name), self.root.join(format!("{name}.part"))] {
                if path.exists() { fs::remove_file(path).map_err(|e| e.to_string())?; }
            }
        }
        let license=self.root.join("LICENSE.txt");
        if license.exists() { fs::remove_file(license).map_err(|e| e.to_string())?; }
        let marker = self.root.join("verified");
        if marker.exists() { fs::remove_file(marker).map_err(|e| e.to_string())?; }
        drop(guard); Ok(self.status())
    }

    fn load_model(&self, model: &mut Option<WhisperEngine>) -> Result<(), String> {
        if model.is_none() {
            let _loading = Loading::new(&self.loading);
            for &(name, _, hash) in FILES { self.verify(&self.root.join(name), hash)?; }
            self.check_cancel()?;
            *model = Some(WhisperEngine::load(&self.root.join(MODEL)).map_err(|e| format!("speech_engine: {e}"))?);
            self.loaded.store(true, Ordering::SeqCst);
        }
        Ok(())
    }

    pub fn prepare(&self) -> Result<(), String> {
        if self.loaded.load(Ordering::SeqCst) { return Ok(()); }
        let _guard = self.operation()?;
        if !self.status().ready { return Err("speech_model_missing".into()); }
        self.cancel.store(false, Ordering::SeqCst);
        let mut model = self.model.lock().map_err(|_| "speech_engine")?;
        self.load_model(&mut model)
    }

    pub fn transcribe(&self, samples: Vec<f32>, language: String) -> Result<String, String> {
        Ok(self.infer(&samples, &language)?.text.trim().to_string())
    }

    pub fn preview(&self, samples: Vec<f32>, language: String) -> Result<Preview, String> {
        validate_audio(&samples, &language)?;
        if samples.len() > 16000 * 30 { return Err("speech_invalid_audio".into()); }
        let result = self.infer(&samples, &language)?;
        Ok(Self::preview_result(result, samples.len()))
    }

    fn infer(&self, samples: &[f32], language: &str) -> Result<transcribe_rs::TranscriptionResult, String> {
        let _guard = self.operation()?;
        validate_audio(samples, language)?;
        if !self.status().ready { return Err("speech_model_missing".into()); }
        if samples.iter().map(|v| f64::from(*v).powi(2)).sum::<f64>() / (samples.len() as f64) < 0.000001 { return Err("speech_silence".into()); }
        self.cancel.store(false, Ordering::SeqCst);
        let mut model = self.model.lock().map_err(|_| "speech_engine")?;
        self.load_model(&mut model)?;
        let params = WhisperInferenceParams { language: Some(language.into()), ..Default::default() };
        // whisper.cpp slides its own 30 s window over the whole clip (at most 120 s).
        model.as_mut().unwrap().transcribe_with(samples, &params).map_err(|e| format!("speech_engine: {e}"))
    }

    fn preview_result(result: transcribe_rs::TranscriptionResult, samples: usize) -> Preview {
        let mut preview = Preview { text: result.text.trim().into(), committed: String::new(), advance: 0 };
        if samples < 16000 * 12 { return preview; }
        // Keep the unfinished tail; move only across Whisper's complete segment boundaries.
        for segment in result.segments.unwrap_or_default() {
            let end = (segment.end * 16000.0) as usize;
            if end <= preview.advance || end > samples.saturating_sub(16000) { break; }
            preview.committed.push_str(&segment.text);
            preview.advance = end;
        }
        // Continuous speech may fill a whole window without a usable timestamp.
        // Stop re-decodes the complete clip, including this provisional boundary.
        if preview.advance == 0 && samples == 16000 * 30 {
            preview.committed = preview.text.clone();
            preview.advance = samples;
        }
        preview.committed = preview.committed.trim().into();
        preview
    }

    /// Transcribes a WAV uploaded by a paired phone. The phone records 16 kHz,
    /// mono, 16-bit PCM; the transcriber validates those exact parameters.
    pub fn transcribe_wav(&self, bytes: Vec<u8>, language: &str) -> Result<String, String> {
        if bytes.len() > 4_000_000 { return Err("speech_invalid_audio".into()); }
        let path = std::env::temp_dir().join(format!(
            "aurachat-speech-{}-{}.wav", std::process::id(), crate::data::now_millis()
        ));
        fs::write(&path, &bytes).map_err(|_| "speech_invalid_audio".to_string())?;
        let samples = transcribe_rs::audio::read_wav_samples(&path)
            .map_err(|_| "speech_invalid_audio".to_string());
        let _ = fs::remove_file(&path);
        self.transcribe(samples?, language.to_string())
    }
}

fn validate_audio(samples: &[f32], language: &str) -> Result<(), String> {
    if !(1600..=16000*120).contains(&samples.len()) || samples.iter().any(|v| !v.is_finite() || v.abs() > 1.0) { return Err("speech_invalid_audio".into()); }
    if !["ar","de","el","en","es","fr","it","ja","ko","nl","pl","pt","vi","zh"].contains(&language) { return Err("speech_language".into()); }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn preview_keeps_unfinished_tail_and_bounds_windows() {
        let result = || transcribe_rs::TranscriptionResult {
            text: "Prima frase. Seconda frase.".into(),
            segments: Some(vec![
                transcribe_rs::TranscriptionSegment { start: 0.0, end: 6.0, text: "Prima frase.".into() },
                transcribe_rs::TranscriptionSegment { start: 6.0, end: 12.0, text: " Seconda frase.".into() },
            ]),
        };
        assert_eq!(Speech::preview_result(result(), 16000 * 10).advance, 0);
        let preview = Speech::preview_result(result(), 16000 * 12);
        assert_eq!(preview.text, "Prima frase. Seconda frase.");
        assert_eq!(preview.committed, "Prima frase.");
        assert_eq!(preview.advance, 16000 * 6);
        let full = Speech::preview_result(transcribe_rs::TranscriptionResult {text:"Continuous speech".into(), segments:None}, 16000 * 30);
        assert_eq!(full.advance, 16000 * 30);
        assert_eq!(full.committed, full.text);
        let service = Speech::new(&std::env::temp_dir());
        assert_eq!(service.preview(vec![0.1; 16000 * 30 + 1], "it".into()).unwrap_err(), "speech_invalid_audio");
    }
    #[test] fn audio_boundary_validation() {
        assert!(validate_audio(&vec![0.1; 1600], "it").is_ok());
        assert!(validate_audio(&vec![f32::NAN; 1600], "it").is_err());
        assert!(validate_audio(&vec![0.1; 1600], "invalid").is_err());
        assert!(validate_audio(&vec![0.1; 16000*120+1], "it").is_err());
    }
    #[test] fn remote_audio_requires_a_valid_wav() {
        let service = Speech::new(&std::env::temp_dir());
        assert_eq!(service.transcribe_wav(vec![0; 100], "it").unwrap_err(), "speech_invalid_audio");
        assert_eq!(service.transcribe_wav(vec![0; 4_000_001], "it").unwrap_err(), "speech_invalid_audio");
    }
    #[test] fn partial_model_is_never_ready() {
        let root = std::env::temp_dir().join(format!("aurachat-speech-test-{}", std::process::id()));
        let service = Speech::new(&root);
        fs::create_dir_all(&service.root).unwrap();
        fs::write(service.root.join(format!("{MODEL}.part")), "partial").unwrap();
        assert!(!service.status().ready); assert_eq!(service.status().downloaded, 7);
        assert!(!service.status().loading && !service.status().loaded);
        assert_eq!(service.prepare().unwrap_err(), "speech_model_missing");
        assert!(service.verify(&service.root.join(format!("{MODEL}.part")), "wrong").is_err());
        let guard = service.operation().unwrap(); assert!(service.remove().is_err()); drop(guard);
        service.remove().unwrap(); fs::remove_dir(&service.root).unwrap(); fs::remove_dir(root.join("models")).unwrap(); fs::remove_dir(root).unwrap();
    }
    #[test] #[ignore = "downloads 3 GB and runs real Whisper inference; AURACHAT_TEST_WAV required"]
    fn real_download_and_transcription() {
        let config = std::env::var("APPDATA").unwrap();
        let service = Speech::new(&PathBuf::from(config).join("dev.aurachat.desktop"));
        if !service.status().ready {
            tauri::async_runtime::block_on(service.download(|s| eprintln!("Model {} / {}", s.downloaded, s.total))).unwrap();
        }
        let samples = transcribe_rs::audio::read_wav_samples(&PathBuf::from(std::env::var("AURACHAT_TEST_WAV").unwrap())).unwrap();
        let started = std::time::Instant::now();
        service.prepare().unwrap();
        eprintln!("Model preparation: {:?}", started.elapsed());
        let language = std::env::var("AURACHAT_TEST_LANG").unwrap_or_else(|_| "en".into());
        let expected = std::env::var("AURACHAT_TEST_EXPECT").unwrap_or_else(|_| "country".into());
        for attempt in 1..=2 {
            let started = std::time::Instant::now();
            let text = service.transcribe(samples.clone(), language.clone()).unwrap();
            eprintln!("Transcription {attempt} ({:?}): {text}", started.elapsed());
            assert!(text.to_lowercase().contains(&expected));
            assert!(service.status().ready && !service.status().busy);
        }
    }
    #[test] #[ignore = "uses installed Whisper and a local WAV; never downloads or changes app data"]
    fn real_live_transcription() {
        let config = PathBuf::from(std::env::var("APPDATA").unwrap()).join("dev.aurachat.desktop");
        let service = Speech::new(&config);
        assert!(service.status().ready);
        service.prepare().unwrap();
        let samples = transcribe_rs::audio::read_wav_samples(&PathBuf::from(std::env::var("AURACHAT_TEST_WAV").unwrap())).unwrap();
        let language = std::env::var("AURACHAT_TEST_LANG").unwrap_or_else(|_| "en".into());
        let expected = std::env::var("AURACHAT_TEST_EXPECT").unwrap_or_else(|_| "country".into());
        let mut from = 0;
        let mut committed = String::new();
        let mut saw_text = false;
        let mut saw_advance = false;
        for end in (16000 * 2..samples.len()).step_by(16000 * 2) {
            let end = end.min(from + 16000 * 30);
            let started = std::time::Instant::now();
            let preview = service.preview(samples[from..end].to_vec(), language.clone()).unwrap();
            let text = format!("{committed} {}", preview.text).trim().to_string();
            println!("LIVE {}", serde_json::json!({"seconds":end as f64/16000.0,"elapsed_ms":started.elapsed().as_millis(),"text":text,"advance":preview.advance}));
            saw_text |= !text.is_empty();
            if preview.advance > 0 {
                saw_advance = true;
                committed = format!("{committed} {}", preview.committed).trim().to_string();
                from += preview.advance;
            }
        }
        assert!(saw_text);
        if samples.len() > 16000 * 30 { assert!(saw_advance); }
        let text = service.transcribe(samples, language.clone()).unwrap();
        println!("FINAL {text}");
        assert!(text.to_lowercase().contains(&expected));
        let wav = fs::read(std::env::var("AURACHAT_TEST_WAV").unwrap()).unwrap();
        let mobile_text = service.transcribe_wav(wav, &language).unwrap();
        println!("MOBILE_FINAL {mobile_text}");
        assert_eq!(mobile_text, text, "Legacy mobile WAV must keep the complete batch result after live previews");
        assert!(!service.status().busy);
    }
}
