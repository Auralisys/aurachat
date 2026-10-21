use std::sync::Mutex;

trait PausedMedia: Send {
    fn resume(&self) -> Result<(),String>;
}

#[derive(Default)]
pub struct Media {
    paused: Mutex<Option<(String, Option<Box<dyn PausedMedia>>)>>,
}

impl Media {
    pub fn pause(&self, id: String) -> Result<(),String> {
        self.pause_with(id, pause_playing)
    }

    fn pause_with(&self, id: String, pause: impl FnOnce()->Result<Option<Box<dyn PausedMedia>>,String>) -> Result<(),String> {
        if id.is_empty() || id.len()>128 {return Err("Invalid recording ID.".into());}
        let mut state=self.paused.lock().map_err(|_|"Media state lock failed")?;
        if let Some((active,_))=&*state {
            return if active==&id {Ok(())}else{Err("Another recording owns the paused media.".into())};
        }
        *state=Some((id,pause()?));
        Ok(())
    }

    pub fn resume(&self, id: &str) -> Result<(),String> {
        let mut state=self.paused.lock().map_err(|_|"Media state lock failed")?;
        if !state.as_ref().is_some_and(|(active,_)|active==id) {return Ok(());}
        let (_,session)=state.take().ok_or("Media ownership changed")?;
        if let Some(session)=session {session.resume()?;}
        Ok(())
    }

    pub fn restore(&self) {
        match self.paused.lock() {
            Ok(mut state)=>if let Some((_,Some(session)))=state.take() {
                if let Err(error)=session.resume() {eprintln!("Dictation media restore failed: {error}");}
            },
            Err(error)=>eprintln!("Dictation media state failed: {error}"),
        }
    }
}

#[cfg(windows)]
struct Apartment;
#[cfg(windows)]
impl Apartment {
    fn new()->Result<Self,String> {
        unsafe {windows::Win32::System::WinRT::RoInitialize(windows::Win32::System::WinRT::RO_INIT_MULTITHREADED)}.map_err(|e|e.to_string())?;
        Ok(Self)
    }
}
#[cfg(windows)]
impl Drop for Apartment {fn drop(&mut self){unsafe {windows::Win32::System::WinRT::RoUninitialize();}}}

#[cfg(windows)]
struct WindowsPaused {
    manager: windows::Media::Control::GlobalSystemMediaTransportControlsSessionManager,
    session: windows::Media::Control::GlobalSystemMediaTransportControlsSession,
    title: windows::core::HSTRING,
}

#[cfg(windows)]
impl PausedMedia for WindowsPaused {
    fn resume(&self)->Result<(),String> {
        use windows::Media::Control::GlobalSystemMediaTransportControlsSessionPlaybackStatus as Status;
        let _apartment=Apartment::new()?;
        let result=(||->windows::core::Result<()> {
            let sessions=self.manager.GetSessions()?;
            let present=(0..sessions.Size()?).any(|i|sessions.GetAt(i).is_ok_and(|s|s==self.session));
            // Never target a newly opened player, a different track or playback the user already resumed/stopped.
            if !present || self.session.GetPlaybackInfo()?.PlaybackStatus()?!=Status::Paused {return Ok(());}
            if self.session.TryGetMediaPropertiesAsync()?.join()?.Title()?!=self.title {return Ok(());}
            if !self.session.TryPlayAsync()?.join()? {return Err(windows::core::Error::new(windows::core::HRESULT(0x80004005u32 as i32),"Player rejected resume."));}
            Ok(())
        })();
        result.map_err(|e|e.to_string())
    }
}

#[cfg(windows)]
struct PausedPlayers(Vec<WindowsPaused>);
#[cfg(windows)]
impl PausedMedia for PausedPlayers {
    fn resume(&self)->Result<(),String> {
        let errors:Vec<_>=self.0.iter().filter_map(|session|session.resume().err()).collect();
        if errors.is_empty() {Ok(())}else{Err(errors.join("; "))}
    }
}

#[cfg(windows)]
fn pause_playing()->Result<Option<Box<dyn PausedMedia>>,String> {
    use windows::Media::Control::{GlobalSystemMediaTransportControlsSessionManager as Manager, GlobalSystemMediaTransportControlsSessionPlaybackStatus as Status};
    let _apartment=Apartment::new()?;
    let mut paused=PausedPlayers(Vec::new());
    let result=(||->windows::core::Result<()> {
        let manager=Manager::RequestAsync()?.join()?;
        // Enumerate rather than guessing from a global play/pause key (which could start idle Spotify).
        let sessions=manager.GetSessions()?;
        for i in 0..sessions.Size()? {
            let session=sessions.GetAt(i)?;
            let info=session.GetPlaybackInfo()?;
            if info.PlaybackStatus()?!=Status::Playing || !info.Controls()?.IsPauseEnabled()? {continue;}
            let title=session.TryGetMediaPropertiesAsync()?.join()?.Title()?;
            if !session.TryPauseAsync()?.join()? {return Err(windows::core::Error::new(windows::core::HRESULT(0x80004005u32 as i32),"Player rejected pause."));}
            paused.0.push(WindowsPaused {manager:manager.clone(),session,title});
        }
        Ok(())
    })();
    if let Err(error)=result {
        if let Err(restore)=paused.resume() {eprintln!("Dictation media rollback failed: {restore}");}
        return Err(error.to_string());
    }
    if paused.0.is_empty() {Ok(None)}else{Ok(Some(Box::new(paused)))}
}

#[cfg(not(windows))]
fn pause_playing()->Result<Option<Box<dyn PausedMedia>>,String>{Ok(None)}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc,atomic::{AtomicUsize,Ordering}};
    struct Fake(Arc<AtomicUsize>);
    impl PausedMedia for Fake {fn resume(&self)->Result<(),String>{self.0.fetch_add(1,Ordering::SeqCst);Ok(())}}
    #[cfg(windows)]
    #[test]
    fn windows_media_sessions_can_be_queried_without_changing_playback() {
        let _apartment=Apartment::new().unwrap();
        let manager=windows::Media::Control::GlobalSystemMediaTransportControlsSessionManager::RequestAsync().unwrap().join().unwrap();
        let sessions=manager.GetSessions().unwrap();
        for i in 0..sessions.Size().unwrap() {
            let session=sessions.GetAt(i).unwrap();
            session.GetPlaybackInfo().unwrap().PlaybackStatus().unwrap();
        }
    }
    #[test]
    fn only_owned_playback_resumes_once_and_idle_media_never_starts() {
        let state=Media::default();let plays=Arc::new(AtomicUsize::new(0));
        state.pause_with("idle".into(),||Ok(None)).unwrap();state.resume("idle").unwrap();
        assert_eq!(plays.load(Ordering::SeqCst),0);
        state.pause_with("recording".into(),||Ok(Some(Box::new(Fake(plays.clone()))))).unwrap();
        state.pause_with("recording".into(),||panic!("Duplicate pause")).unwrap();
        assert!(state.pause_with("other".into(),||panic!("Overlap")).is_err());
        state.resume("other").unwrap();assert_eq!(plays.load(Ordering::SeqCst),0);
        state.resume("recording").unwrap();state.resume("recording").unwrap();
        assert_eq!(plays.load(Ordering::SeqCst),1);
        state.pause_with("exit".into(),||Ok(Some(Box::new(Fake(plays.clone()))))).unwrap();
        state.restore();state.restore();assert_eq!(plays.load(Ordering::SeqCst),2);
    }
}
