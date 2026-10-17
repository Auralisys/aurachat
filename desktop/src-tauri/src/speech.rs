use std::{fs::{self, File, OpenOptions}, io::{Read, Write}, path::PathBuf, sync::{Mutex, atomic::{AtomicBool, Ordering}}, time::Duration};
use serde::Serialize;
use sha2::{Digest, Sha256};
use transcribe_rs::onnx::{cohere::{CohereModel, CohereParams}, Quantization};

const REVISION: &str = "2c870f89692c61348481884eb6e1222ec3ba25c9";
const FILES: &[(&str, u64, &str)] = &[
    ("cohere-decoder.int4.onnx", 371849, "f176a71e8b743d32bb8e4b8ec19bf70f367c5c3c93b08857826d8f5b60b6ad1e"),
    ("cohere-decoder.int4.onnx.data", 143245312, "ed9461dd2233c44cd86f56c0a4d17c089de317bdbdcf18dc92e44a8a0cf525b3"),
    ("cohere-encoder.int4.onnx", 6153388, "1bd619df7113a27d75b136ddc9f35d6b65131baeec15a7680ddda0c18c0b20a5"),
    ("cohere-encoder.int4.onnx.data", 1844879360, "f5bffddbf657edff4b14e650926cdb39b62a8644feb9f6ee4e3287df38e7f900"),
    ("tokens.txt", 207437, "013ede043ae2480e3a9205cc34550d9686100cc682bacc90f702facdfbb93035"),
];

#[derive(Clone, Serialize)]
pub struct ModelStatus { pub ready: bool, pub busy: bool, pub downloaded: u64, pub total: u64 }

pub struct Speech {
    root: PathBuf,
    busy: AtomicBool,
    cancel: AtomicBool,
    model: Mutex<Option<CohereModel>>,
}
struct Operation<'a>(&'a AtomicBool);
impl Drop for Operation<'_> { fn drop(&mut self) { self.0.store(false, Ordering::SeqCst); } }

impl Speech {
    pub fn new(config_dir: &std::path::Path) -> Self {
        Self { root: config_dir.join("models/cohere-int4-2c870f89"), busy: AtomicBool::new(false), cancel: AtomicBool::new(false), model: Mutex::new(None) }
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
        ModelStatus { ready: complete && fs::read_to_string(self.root.join("verified")).is_ok_and(|s| s == REVISION), busy: self.busy.load(Ordering::SeqCst), downloaded, total: FILES.iter().map(|f| f.1).sum() }
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
                let url = format!("https://huggingface.co/cstr/cohere-transcribe-onnx-int4/resolve/{REVISION}/{name}");
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
        fs::write(self.root.join("LICENSE.txt"), include_str!("../../ui/vendor/speech-APACHE-2.0.txt")).map_err(|e| e.to_string())?;
        fs::write(self.root.join("verified"), REVISION).map_err(|e| e.to_string())?;
        drop(guard);
        let status = self.status(); progress(status.clone()); Ok(status)
    }

    pub fn remove(&self) -> Result<ModelStatus, String> {
        let guard = self.operation()?;
        *self.model.lock().map_err(|_| "speech_engine")? = None;
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

    fn load_model(&self, model: &mut Option<CohereModel>) -> Result<(), String> {
        if model.is_none() {
            for &(name, _, hash) in FILES { self.verify(&self.root.join(name), hash)?; }
            self.check_cancel()?;
            *model = Some(CohereModel::load(&self.root, &Quantization::Int4).map_err(|e| format!("speech_engine: {e}"))?);
        }
        Ok(())
    }

    pub fn prepare(&self) -> Result<(), String> {
        let _guard = self.operation()?;
        if !self.status().ready { return Err("speech_model_missing".into()); }
        self.cancel.store(false, Ordering::SeqCst);
        let mut model = self.model.lock().map_err(|_| "speech_engine")?;
        self.load_model(&mut model)
    }

    pub fn transcribe(&self, samples: Vec<f32>, language: String) -> Result<String, String> {
        let _guard = self.operation()?;
        validate_audio(&samples, &language)?;
        if !self.status().ready { return Err("speech_model_missing".into()); }
        if samples.iter().map(|v| f64::from(*v).powi(2)).sum::<f64>() / (samples.len() as f64) < 0.000001 { return Err("speech_silence".into()); }
        self.cancel.store(false, Ordering::SeqCst);
        let mut model = self.model.lock().map_err(|_| "speech_engine")?;
        self.load_model(&mut model)?;
        let params = CohereParams { language: Some(language), max_new_tokens: Some(512), ..Default::default() };
        let mut text = Vec::new();
        let mut offset = 0;
        while offset < samples.len() {
            self.check_cancel()?;
            let remaining = &samples[offset..];
            let end = chunk_end(remaining);
            let chunk = &remaining[..end];
            if chunk.iter().map(|v| f64::from(*v).powi(2)).sum::<f64>() / chunk.len() as f64 >= 0.000001 {
                text.push(model.as_mut().unwrap().transcribe_with(chunk, &params).map_err(|e| format!("speech_engine: {e}"))?.text.trim().to_string());
            }
            offset += end;
        }
        Ok(text.join(" ").trim().to_string())
    }
}

// Bound encoder memory and token count; prefer a quiet boundary within 25–30 seconds.
fn chunk_end(samples: &[f32]) -> usize {
    if samples.len() <= 16000 * 30 { return samples.len(); }
    (16000*25..16000*30).step_by(1600).min_by(|&a, &b| {
        let energy = |i| samples[i..i+1600].iter().map(|v| f64::from(*v).powi(2)).sum::<f64>();
        energy(a).total_cmp(&energy(b))
    }).unwrap() + 800
}

fn validate_audio(samples: &[f32], language: &str) -> Result<(), String> {
    if !(1600..=16000*120).contains(&samples.len()) || samples.iter().any(|v| !v.is_finite() || v.abs() > 1.0) { return Err("speech_invalid_audio".into()); }
    if !["ar","de","el","en","es","fr","it","ja","ko","nl","pl","pt","vi","zh"].contains(&language) { return Err("speech_language".into()); }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn audio_boundary_validation() {
        assert!(validate_audio(&vec![0.1; 1600], "it").is_ok());
        assert!(validate_audio(&vec![f32::NAN; 1600], "it").is_err());
        assert!(validate_audio(&vec![0.1; 1600], "invalid").is_err());
        assert!(validate_audio(&vec![0.1; 16000*120+1], "it").is_err());
        let mut audio = vec![0.1; 16000*60]; audio[16000*27..16000*27+1600].fill(0.0);
        assert_eq!(chunk_end(&audio), 16000*27+800);
    }
    #[test] fn partial_model_is_never_ready() {
        let root = std::env::temp_dir().join(format!("aurachat-speech-test-{}", std::process::id()));
        let service = Speech::new(&root);
        fs::create_dir_all(&service.root).unwrap();
        fs::write(service.root.join("tokens.txt.part"), "partial").unwrap();
        assert!(!service.status().ready); assert_eq!(service.status().downloaded, 7);
        assert_eq!(service.prepare().unwrap_err(), "speech_model_missing");
        assert!(service.verify(&service.root.join("tokens.txt.part"), "wrong").is_err());
        let guard = service.operation().unwrap(); assert!(service.remove().is_err()); drop(guard);
        service.remove().unwrap(); fs::remove_dir(&service.root).unwrap(); fs::remove_dir(root.join("models")).unwrap(); fs::remove_dir(root).unwrap();
    }
    #[test] #[ignore = "downloads 2 GB and runs real CPU inference; AURACHAT_TEST_WAV required"]
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
        for attempt in 1..=2 {
            let started = std::time::Instant::now();
            let text = service.transcribe(samples.clone(), "en".into()).unwrap();
            eprintln!("Transcription {attempt} ({:?}): {text}", started.elapsed());
            assert!(text.to_lowercase().contains("country"));
            assert!(service.status().ready && !service.status().busy);
        }
    }
}
