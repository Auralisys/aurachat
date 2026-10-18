use std::{collections::HashMap, sync::{Arc,Mutex,atomic::{AtomicBool,Ordering}}, task::{Poll,Waker}, future::Future};
use tauri::Manager;

#[derive(Default)]
pub struct Cancellation { cancelled:AtomicBool, waker:Mutex<Option<Waker>> }
impl Cancellation {
    pub fn cancel(&self) {self.cancelled.store(true,Ordering::SeqCst);if let Some(waker)=self.waker.lock().unwrap().take(){waker.wake();}}
    pub fn is_cancelled(&self)->bool {self.cancelled.load(Ordering::SeqCst)}
    pub async fn run<T>(&self, future:impl Future<Output=T>)->Result<T,String> {
        let mut future=std::pin::pin!(future);
        std::future::poll_fn(|cx|{
            *self.waker.lock().unwrap()=Some(cx.waker().clone());
            if self.is_cancelled(){Poll::Ready(Err("agent_cancelled".into()))}else{future.as_mut().poll(cx).map(Ok)}
        }).await
    }
}
struct Entry {owner:String,conversation:String,cancellation:Arc<Cancellation>}
#[derive(Default)]
pub struct AgentRuns(Mutex<HashMap<String,Entry>>);
impl AgentRuns {
    pub fn start(&self,owner:&str,conversation:&str,id:&str)->Arc<Cancellation>{
        let cancellation=Arc::new(Cancellation::default());
        self.0.lock().unwrap().insert(id.into(),Entry{owner:owner.into(),conversation:conversation.into(),cancellation:cancellation.clone()});cancellation
    }
    pub fn stop(&self,owner:&str,conversation:&str,id:&str)->Result<(),String>{
        let entries=self.0.lock().unwrap();let entry=entries.get(id).filter(|e|e.owner==owner&&e.conversation==conversation).ok_or("agent_not_found")?;entry.cancellation.cancel();Ok(())
    }
    pub fn cancelled(&self,id:&str)->bool {self.0.lock().unwrap().get(id).is_some_and(|e|e.cancellation.is_cancelled())}
    pub fn finish(&self,id:&str){self.0.lock().unwrap().remove(id);}
    pub fn token(&self,id:&str)->Option<Arc<Cancellation>>{self.0.lock().unwrap().get(id).map(|e|e.cancellation.clone())}
    pub fn cancel_conversation(&self,owner:&str,conversation:&str){
        self.0.lock().unwrap().retain(|_,entry|{
            if entry.owner==owner && entry.conversation==conversation {entry.cancellation.cancel();false}else{true}
        });
    }
}
#[derive(Clone)]
pub struct Runtime {pub app:tauri::AppHandle,pub owner:String,pub conversation:String}
impl Runtime {
    pub fn start(&self,id:&str)->Arc<Cancellation>{self.app.state::<AgentRuns>().start(&self.owner,&self.conversation,id)}
    pub fn finish(&self,id:&str){self.app.state::<AgentRuns>().finish(id);}
}
#[cfg(test)] mod tests {
    use super::*;
    #[test] fn parent_stop_cancels_only_its_own_children(){
        let runs=AgentRuns::default();let child=runs.start("u","c","a");let other=runs.start("u","other","b");
        runs.cancel_conversation("wrong","c");assert!(!child.is_cancelled());
        runs.cancel_conversation("u","c");assert!(child.is_cancelled());assert!(!other.is_cancelled());assert!(runs.token("a").is_none());
    }
    #[test] fn only_the_owner_can_stop_and_pending_io_is_cancellable(){
        let runs=AgentRuns::default();let cancellation=runs.start("u","c","a");
        assert!(runs.stop("other","c","a").is_err());assert!(runs.stop("u","other","a").is_err());
        let (ready,started)=std::sync::mpsc::channel();let token=cancellation.clone();
        let worker=std::thread::spawn(move ||{let mut ready=Some(ready);tauri::async_runtime::block_on(token.run(std::future::poll_fn(move |_|{if let Some(ready)=ready.take(){ready.send(()).unwrap();}Poll::<()>::Pending})))});
        started.recv_timeout(std::time::Duration::from_secs(2)).unwrap();
        runs.stop("u","c","a").unwrap();assert!(cancellation.is_cancelled());
        assert!(worker.join().unwrap().is_err());runs.finish("a");assert!(cancellation.is_cancelled());assert!(runs.stop("u","c","a").is_err());
    }
}
