use crate::config::{FirestoreAuth, UserConfig};
use crate::data::{ChatData, Conversation, valid_id};
use std::collections::HashMap;
use std::path::Path;
use crate::window_state::WindowGeometry;
use serde_json::{json, Value};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

/// Massima dimensione in byte del JSON di un singolo messaggio salvato come
/// documento unico; oltre questa soglia il messaggio viene spezzato in parti.
const MAX_MESSAGE_BYTES: usize = 900_000;
/// Ogni parte di un messaggio grande resta sotto il limite di Firestore.
const MESSAGE_CHUNK_BYTES: usize = 700_000;

/// Spezza una stringa in blocchi che non superano `max` byte, senza troncare
/// mai un carattere UTF-8 a metà.
fn chunk_string(s: &str, max: usize) -> Vec<String> {
    let mut chunks = Vec::new();
    let mut start = 0usize;
    let bytes = s.as_bytes();
    while start < bytes.len() {
        let mut end = start;
        for (i, ch) in s[start..].char_indices() {
            let next = start + i + ch.len_utf8();
            if next - start > max { break; }
            end = next;
        }
        if end == start { end = start + s[start..].chars().next().expect("non empty").len_utf8(); }
        chunks.push(s[start..end].to_string());
        start = end;
    }
    chunks
}

fn part_path(path: &str, index: usize, part: usize) -> String { format!("{}/parts/p{part:06}", message_path(path, index)) }
fn part_delete(part: &Value) -> Result<Value, String> { Ok(json!({"delete":part["name"].clone(),"currentDocument":{"updateTime":version(part)?}})) }

/// Client minimale per Firestore via REST API + login email/password.
/// Nessuna dipendenza aggiuntiva: solo `reqwest`.
pub struct Firestore {
    http: reqwest::Client,
    token: Mutex<Option<TokenCache>>,
    trees: Mutex<HashMap<String, ChatData>>,
}

struct TokenCache {
    uid: String,
    id_token: String,
    refresh_token: String,
    expires_at: i64,
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn truncate(s: &str, max: usize) -> String {
    let s = s.trim();
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let mut t: String = s.chars().take(max).collect();
        t.push('…');
        t
    }
}

impl Firestore {
    pub async fn companion_isolated(&self, auth: &FirestoreAuth) -> Result<bool, String> {
        let token=self.id_token(auth).await?;
        let response=self.http.get(doc_url(&auth.project_id,"users/aurachat-isolation-probe"))
            .bearer_auth(token).send().await.map_err(|e|e.to_string())?;
        // A missing foreign document must still be forbidden, never readable.
        Ok(response.status().as_u16()==403)
    }
    pub async fn relay_put(&self, auth: &FirestoreAuth, path: &str, value: &Value, revision: Option<&str>) -> Result<(), String> {
        let write = if let Some(revision) = revision { update_write(auth, path, value, Some(revision))? }
            else { new_write(auth, path, value)? };
        self.commit(auth, vec![write]).await.map(|_| ())
    }

    /// Deletes a transient relay document. A missing document is already clean.
    pub async fn relay_delete(&self, auth: &FirestoreAuth, path: &str) -> Result<(), String> {
        let token = self.id_token(auth).await?;
        let response = self.http.delete(doc_url(&auth.project_id, path)).bearer_auth(token).send().await.map_err(|e| e.to_string())?;
        match response.status().as_u16() {
            200 | 404 => Ok(()),
            code => Err(format!("Firestore {code}: {}", truncate(&response.text().await.unwrap_or_default(), 300))),
        }
    }

    pub async fn relay_upsert(&self, auth: &FirestoreAuth, path: &str, value: &Value) -> Result<(), String> {
        let token = self.id_token(auth).await?;
        let fields = encode_value(value)?["mapValue"]["fields"].clone();
        let response = self.http.patch(doc_url(&auth.project_id, path)).bearer_auth(token)
            .json(&json!({"fields": fields})).send().await.map_err(|e| e.to_string())?;
        response_json(response).await.map(|_| ())
    }

    pub async fn relay_revisioned(&self,auth:&FirestoreAuth,path:&str,value:&Value)->Result<(),String>{
        for _ in 0..3 {
            let current=self.get_document(auth,path,None).await?;
            if let Some(doc)=&current {
                if document_fields(doc)?.get("revision").and_then(Value::as_u64).unwrap_or(0)>=value["revision"].as_u64().ok_or("missing_snapshot_revision")? {return Ok(());}
            }
            let revision=current.as_ref().map(version).transpose()?;
            match self.relay_put(auth,path,value,revision).await {
                Ok(())=>return Ok(()),
                Err(e) if e.contains("FAILED_PRECONDITION") || e.contains("ALREADY_EXISTS") || e.contains("ABORTED")=>continue,
                Err(e)=>return Err(e),
            }
        }
        Err("snapshot_conflict".into())
    }

    pub async fn relay_requests(&self, auth: &FirestoreAuth, path: &str, status: &str) -> Result<Vec<(String, String, Value)>, String> {
        let token = self.id_token(auth).await?;
        let url = format!("{}:runQuery", doc_url(&auth.project_id, path));
        let response = self.http.post(url).bearer_auth(token).json(&json!({"structuredQuery": {
            "from":[{"collectionId":"requests"}], "where":{"fieldFilter":{"field":{"fieldPath":"status"},"op":"EQUAL","value":{"stringValue":status}}},"limit":10
        }})).send().await.map_err(|e|e.to_string())?;
        let result = response_json(response).await?;
        result.as_array().ok_or("invalid_relay_response")?.iter().filter_map(|row|row.get("document")).map(|doc| {
            let name=doc["name"].as_str().ok_or("invalid_relay_name")?.split("/documents/").nth(1).ok_or("invalid_relay_path")?.to_string();
            Ok((name,version(doc)?.to_string(),Value::Object(document_fields(doc)?)))
        }).collect()
    }

    pub fn logout(&self) {
        *self.token.lock().unwrap() = None;
        self.trees.lock().unwrap().clear();
    }
    pub fn new() -> Self {
        Self {
            http: reqwest::Client::builder().timeout(std::time::Duration::from_secs(20)).build().expect("HTTP client"),
            token: Mutex::new(None),
            trees: Mutex::new(HashMap::new()),
        }
    }

    fn cached_id(&self) -> Option<String> {
        if let Some(t) = self.token.lock().unwrap().as_ref() {
            if t.expires_at > now_secs() + 60 {
                return Some(t.id_token.clone());
            }
        }
        None
    }

    fn cached_refresh(&self) -> Option<String> {
        self.token
            .lock()
            .unwrap()
            .as_ref()
            .map(|t| t.refresh_token.clone())
    }

    fn store_token(&self, uid: String, id: String, refresh: String, expires_at: i64) {
        *self.token.lock().unwrap() = Some(TokenCache {
            uid,
            id_token: id,
            refresh_token: refresh,
            expires_at,
        });
    }

    pub fn uid(&self) -> Option<String> {
        self.token.lock().unwrap().as_ref().map(|t| t.uid.clone())
    }

    pub async fn id_token(&self, auth: &FirestoreAuth) -> Result<String, String> {
        if let Some(id) = self.cached_id() {
            return Ok(id);
        }
        if let Some(rt) = self.cached_refresh().or_else(|| {
            if auth.refresh_token.is_empty() { None } else { Some(auth.refresh_token.clone()) }
        }) {
            let refreshed = refresh_id_token(&self.http, &auth.api_key, &rt).await;
            if let Err(ref e) = refreshed {
                if !e.starts_with("auth refresh 400:") && !e.starts_with("auth refresh 401:") { return Err(e.clone()); }
            }
            if let Ok((id, rt2, exp)) = refreshed {
                let uid = self.uid().unwrap_or_else(|| auth.uid.clone());
                self.store_token(uid, id.clone(), rt2, exp);
                return Ok(id);
            }
        }
        if auth.password.is_empty() { return Err("session_expired".into()); }
        let (uid, id, rt, exp) =
            sign_in_with_password(&self.http, &auth.api_key, &auth.email, &auth.password).await?;
        self.store_token(uid, id.clone(), rt, exp);
        Ok(id)
    }

    pub fn session(&self) -> Option<(String, String)> {
        self.token.lock().unwrap().as_ref().map(|t| (t.uid.clone(), t.refresh_token.clone()))
    }

    pub async fn login(&self, auth: &FirestoreAuth) -> Result<(), String> {
        let (uid, id, rt, exp) = sign_in_with_password(&self.http, &auth.api_key, &auth.email, &auth.password).await?;
        self.store_token(uid, id, rt, exp);
        Ok(())
    }

    async fn get_field(
        &self,
        auth: &FirestoreAuth,
        path: &str,
        field: &str,
    ) -> Result<Option<Value>, String> {
        let token = self.id_token(auth).await?;
        let url = doc_url(&auth.project_id, path);
        let resp = self
            .http
            .get(&url)
            .query(&[("mask.fieldPaths", field)])
            .bearer_auth(token)
            .send()
            .await
            .map_err(|e| format!("Firestore GET: {e}"))?;
        let status = resp.status();
        if status.as_u16() == 404 {
            return Ok(None);
        }
        let text = resp.text().await.map_err(|e| e.to_string())?;
        if !status.is_success() {
            return Err(format!("Firestore {}: {}", status.as_u16(), truncate(&text, 300)));
        }
        let v: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
        match v.get("fields").and_then(|fields| fields.get(field)) {
            Some(value) => decode_field(value).map(Some),
            None => Ok(None),
        }
    }

    async fn set_field(
        &self,
        auth: &FirestoreAuth,
        path: &str,
        field: &str,
        value: &Value,
    ) -> Result<(), String> {
        let token = self.id_token(auth).await?;
        let url = doc_url(&auth.project_id, path);
        let body = json!({ "fields": { field: encode_value(value)? } });
        let resp = self
            .http
            .patch(&url)
            .query(&[("updateMask.fieldPaths", field)])
            .bearer_auth(token)
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("Firestore PATCH: {e}"))?;
        let status = resp.status();
        if !status.is_success() {
            let text = resp.text().await.unwrap_or_default();
            return Err(format!("Firestore {}: {}", status.as_u16(), truncate(&text, 300)));
        }
        Ok(())
    }

    pub async fn load_tree(&self, uid: &str, auth: &FirestoreAuth) -> Result<ChatData, String> {
        if !auth.configured() {
            return Err("firebase_not_configured".to_string());
        }
        valid_id(uid)?;
        let value = self.get_field(auth, &format!("users/{uid}"), "tree").await?;
        if value.as_ref().is_some_and(|v| v.get("schema_version").and_then(Value::as_u64) != Some(2)) {
            return Err("history_migration_required".into());
        }
        let tree = match value {Some(v) => ChatData::from_storage(v)?,None => ChatData::default()};
        self.trees.lock().unwrap().insert(uid.into(),tree.clone());
        Ok(tree)
    }

    pub async fn save_tree(&self, uid: &str, auth: &FirestoreAuth, tree: &ChatData) -> Result<(), String> {
        if !auth.configured() {
            return Err("firebase_not_configured".to_string());
        }
        valid_id(uid)?;
        let baseline = self.trees.lock().unwrap().get(uid).cloned().ok_or("history_not_loaded")?;
        let user_path = format!("users/{uid}");
        let parent = self.get_document(auth,&user_path,Some("tree")).await?.ok_or("user_not_found")?;
        let remote = document_fields(&parent)?.get("tree").cloned().unwrap_or(ChatData::default().storage_tree()?);
        let merged = merge_changes(&baseline.storage_tree()?,&tree.storage_tree()?,&remote)?;
        let mut writes = vec![field_write(auth,&user_path,"tree",&merged,version(&parent)?)?];
        let mut revisions = Vec::new();
        for conversation in tree.conversations_all() {
            let old = baseline.find_conversation(&conversation.id);
            let path = format!("{user_path}/conversations/{}",conversation.id);
            if old.is_none() {
                if !conversation.messages.is_empty() { return Err("use_save_conversation".into()); }
                revisions.push((conversation.id.clone(),writes.len()));
                writes.push(new_write(auth,&path,&conversation_metadata(conversation,0))?);
            } else if conversation.messages_loaded && old.unwrap().messages_loaded {
                let old = old.unwrap();
                if old.messages.len() != conversation.messages.len() { return Err("use_save_conversation".into()); }
                let mut changed = false;
                for (index,(before,after)) in old.messages.iter().zip(&conversation.messages).enumerate() {
                    let mut before = serde_json::to_value(before).map_err(|e|e.to_string())?;
                    let mut after = serde_json::to_value(after).map_err(|e|e.to_string())?;
                    let old_feedback = before.as_object_mut().unwrap().remove("feedback");
                    let feedback = after.as_object_mut().unwrap().remove("feedback");
                    if before != after { return Err("use_save_conversation".into()); }
                    if old_feedback != feedback {
                        writes.append(&mut self.replace_message_writes(auth,&path,index,&conversation.messages[index]).await?);
                        changed = true;
                    }
                }
                if changed {
                    let revision = conversation.revision.as_deref().ok_or("conversation_not_loaded")?;
                    revisions.push((conversation.id.clone(),writes.len()));
                    writes.push(conversation_write(auth,&path,&conversation_metadata(conversation,conversation.messages.len()),Some(revision))?);
                }
            }
        }
        for old in baseline.conversations_all().filter(|c|tree.find_conversation(&c.id).is_none()) {
            let path = format!("{user_path}/conversations/{}",old.id);
            if let Some(doc) = self.get_document(auth,&path,None).await? {
                for message in self.list_messages(auth,&path).await? {
                    writes.push(json!({"delete":message["name"],"currentDocument":{"updateTime":version(&message)?}}));
                }
                writes.push(json!({"delete":document_name(auth,&path),"currentDocument":{"updateTime":version(&doc)?}}));
            }
        }
        let result=self.commit(auth,writes).await?;
        let mut cached = ChatData::from_storage(merged)?;
        for c in tree.conversations_all().filter(|c|c.messages_loaded) {
            if let Some(target) = cached.find_conversation_mut(&c.id) {
                target.messages=c.messages.clone();target.messages_loaded=true;target.revision=c.revision.clone();
            }
        }
        for (id,index) in revisions {if let Some(c)=cached.find_conversation_mut(&id){c.revision=Some(result["writeResults"][index]["updateTime"].as_str().ok_or("missing_commit_version")?.into());}}
        self.trees.lock().unwrap().insert(uid.into(),cached);
        Ok(())
    }

    pub fn cached_tree(&self,uid:&str)->Option<ChatData>{self.trees.lock().unwrap().get(uid).cloned()}

    pub async fn refresh_tree_preserving_history(&self,uid:&str,auth:&FirestoreAuth,local:&ChatData)->Result<ChatData,String>{
        let mut tree=self.load_tree(uid,auth).await?;
        for source in local.conversations_all().filter(|c|c.messages_loaded) {
            if let Some(target)=tree.find_conversation_mut(&source.id) {
                target.messages=source.messages.clone();target.messages_loaded=true;target.revision=source.revision.clone();
            }
        }
        self.trees.lock().unwrap().insert(uid.into(),tree.clone());
        Ok(tree)
    }

    /// Reads a relay document as a plain JSON object, for companion actions
    /// that also need to receive data written by the phone.
    pub async fn relay_get(&self,auth:&FirestoreAuth,path:&str) -> Result<Option<Value>,String> {
        self.get_document(auth,path,None).await?.map(|doc|Ok(Value::Object(document_fields(&doc)?))).transpose()
    }

    async fn get_document(&self,auth:&FirestoreAuth,path:&str,mask:Option<&str>) -> Result<Option<Value>,String> {
        let token = self.id_token(auth).await?;
        let mut request = self.http.get(doc_url(&auth.project_id,path)).bearer_auth(token);
        if let Some(mask) = mask {request=request.query(&[("mask.fieldPaths",mask)]);}
        let response = request.send().await.map_err(|e|e.to_string())?;
        if response.status().as_u16()==404 {return Ok(None);}
        response_json(response).await.map(Some)
    }

    async fn list_documents(&self,auth:&FirestoreAuth,collection_url:&str) -> Result<Vec<Value>,String> {
        let mut documents = Vec::new();let mut page = String::new();
        loop {
            let token=self.id_token(auth).await?;
            let response=self.http.get(collection_url)
                .bearer_auth(token).query(&[("pageSize","1000"),("pageToken",page.as_str()),("orderBy","__name__")])
                .send().await.map_err(|e|e.to_string())?;
            let value=response_json(response).await?;
            if let Some(docs)=value["documents"].as_array(){documents.extend(docs.iter().cloned());}
            page=value["nextPageToken"].as_str().unwrap_or("").into();
            if page.is_empty(){break;}
        }
        Ok(documents)
    }

    async fn list_messages(&self,auth:&FirestoreAuth,path:&str) -> Result<Vec<Value>,String> {
        self.list_documents(auth,&format!("{}/messages",doc_url(&auth.project_id,path))).await
    }

    async fn list_parts(&self,auth:&FirestoreAuth,path:&str,index:usize) -> Result<Vec<Value>,String> {
        self.list_documents(auth,&format!("{}/parts",doc_url(&auth.project_id,&message_path(path,index)))).await
    }

    /// Write necessarie per sostituire il messaggio all'indice `index`,
    /// spezzandolo in più documenti `parts/` quando supera il limite.
    async fn replace_message_writes(&self,auth:&FirestoreAuth,path:&str,index:usize,message:&crate::llm::ChatMessage) -> Result<Vec<Value>,String> {
        let value=message_value(index,message)?;
        let serialized=serde_json::to_vec(&value).map_err(|e|e.to_string())?;
        let header_path=message_path(path,index);
        let mut writes=Vec::new();
        if serialized.len()<=MAX_MESSAGE_BYTES {
            writes.push(update_write(auth,&header_path,&value,None)?);
            for part in self.list_parts(auth,path,index).await? {writes.push(part_delete(&part)?);}
            return Ok(writes);
        }
        let text=std::str::from_utf8(&serialized).map_err(|e|e.to_string())?;
        let chunks=chunk_string(text,MESSAGE_CHUNK_BYTES);
        writes.push(update_write(auth,&header_path,&json!({"sequence":index,"chunked":true,"part_count":chunks.len()}),None)?);
        let old_parts=self.list_parts(auth,path,index).await?;
        for (part_index,part) in old_parts.iter().enumerate() {
            if part_index>=chunks.len(){writes.push(part_delete(part)?);}
        }
        for (part_index,chunk) in chunks.iter().enumerate() {
            let part_value=json!({"data":chunk});
            let write=if part_index<old_parts.len(){update_write(auth,&part_path(path,index,part_index),&part_value,None)?}
                else{new_write(auth,&part_path(path,index,part_index),&part_value)?};
            writes.push(write);
        }
        Ok(writes)
    }

    async fn commit(&self,auth:&FirestoreAuth,writes:Vec<Value>) -> Result<Value,String> {
        if writes.len()>450 {return Err("history_operation_too_large".into());}
        let body=json!({"writes":writes});
        if serde_json::to_vec(&body).map_err(|e|e.to_string())?.len()>9*1024*1024{return Err("history_operation_too_large".into());}
        let token=self.id_token(auth).await?;
        let response=self.http.post(format!("{}:commit",doc_url(&auth.project_id,"" ).trim_end_matches('/')))
            .bearer_auth(token).json(&body).send().await.map_err(|e|e.to_string())?;
        response_json(response).await
    }

    pub async fn load_conversation(&self,uid:&str,auth:&FirestoreAuth,id:&str) -> Result<Conversation,String> {
        valid_id(uid)?;valid_id(id)?;
        let path=format!("users/{uid}/conversations/{id}");
        let doc=self.get_document(auth,&path,None).await?.ok_or("conversation_not_found")?;
        let mut metadata=document_fields(&doc)?;
        let count=metadata.get("message_count").and_then(Value::as_u64).ok_or("invalid_message_count")? as usize;
        metadata.remove("message_count");
        let documents=self.list_messages(auth,&path).await?;
        let checked=self.get_document(auth,&path,Some("message_count")).await?.ok_or("conversation_not_found")?;
        if version(&checked)?!=version(&doc)?{return Err("conversation_conflict".into());}
        if documents.len()!=count{return Err("incomplete_conversation".into());}
        let mut messages=Vec::new();
        for (index,doc) in documents.iter().enumerate(){
            let mut fields=document_fields(doc)?;
            if fields.remove("sequence").and_then(|v|v.as_u64())!=Some(index as u64){return Err("invalid_message_sequence".into());}
            if fields.remove("chunked").and_then(|v|v.as_bool()).unwrap_or(false) {
                let part_count=fields.remove("part_count").and_then(|v|v.as_u64()).ok_or("invalid_message_parts")? as usize;
                let parts=self.list_parts(auth,&path,index).await?;
                if parts.len()!=part_count{return Err("incomplete_conversation".into());}
                let mut joined=String::new();
                for part in &parts {
                    let mut part_fields=document_fields(part)?;
                    let data=part_fields.remove("data").ok_or("invalid_message_part")?;
                    joined.push_str(data.as_str().ok_or("invalid_message_part")?);
                }
                let mut value:Value=serde_json::from_str(&joined).map_err(|e|format!("invalid_chunked_message: {e}"))?;
                if value.get("sequence").and_then(Value::as_u64)!=Some(index as u64){return Err("invalid_message_sequence".into());}
                value.as_object_mut().ok_or("invalid_chunked_message")?.remove("sequence");
                messages.push(value);
            } else {
                messages.push(Value::Object(fields));
            }
        }
        metadata.insert("id".into(),json!(id));metadata.insert("messages".into(),json!(messages));
        metadata.insert("messages_loaded".into(),json!(true));metadata.insert("revision".into(),json!(version(&doc)?));
        let mut conversation:Conversation=serde_json::from_value(Value::Object(metadata)).map_err(|e|e.to_string())?;
        if let Some(tree)=self.trees.lock().unwrap().get_mut(uid) {
            if let Some(summary)=tree.find_conversation_mut(id) {
                conversation.title=summary.title.clone();*summary=conversation.clone();
            }
        }
        Ok(conversation)
    }

    pub async fn save_conversation(&self,uid:&str,auth:&FirestoreAuth,conversation:&Conversation,tree:&ChatData) -> Result<Conversation,String> {
        valid_id(uid)?;valid_id(&conversation.id)?;
        if !conversation.messages_loaded{return Err("conversation_not_loaded".into());}
        let path=format!("users/{uid}/conversations/{}",conversation.id);
        let parent_path=format!("users/{uid}");
        let parent=self.get_document(auth,&parent_path,Some("tree")).await?.ok_or("user_not_found")?;
        let remote=document_fields(&parent)?.get("tree").cloned().ok_or("history_not_loaded")?;
        let baseline=self.trees.lock().unwrap().get(uid).cloned().ok_or("history_not_loaded")?;
        let merged=merge_changes(&baseline.storage_tree()?,&tree.storage_tree()?,&remote)?;
        let existing=self.get_document(auth,&path,None).await?;
        let old_count=existing.as_ref().map(document_fields).transpose()?.and_then(|m|m.get("message_count").and_then(Value::as_u64)).unwrap_or(0) as usize;
        if existing.as_ref().map(version).transpose()? != conversation.revision.as_deref() {return Err("conversation_conflict".into());}
        let mut writes=vec![field_write(auth,&parent_path,"tree",&merged,version(&parent)?)?];
        writes.push(if conversation.revision.is_some(){conversation_write(auth,&path,&conversation_metadata(conversation,conversation.messages.len()),conversation.revision.as_deref())?}
            else{new_write(auth,&path,&conversation_metadata(conversation,conversation.messages.len()))?});
        let old=baseline.find_conversation(&conversation.id).filter(|c|c.messages_loaded);
        for (index,message) in conversation.messages.iter().enumerate(){
            if old.and_then(|c|c.messages.get(index)).is_some_and(|before|serde_json::to_value(before).ok()==serde_json::to_value(message).ok()){continue;}
            writes.append(&mut self.replace_message_writes(auth,&path,index,message).await?);
        }
        for index in conversation.messages.len()..old_count {
            writes.push(json!({"delete":document_name(auth,&message_path(&path,index))}));
            for part in self.list_parts(auth,&path,index).await? {writes.push(part_delete(&part)?);}
        }
        let result=self.commit(auth,writes).await?;
        let mut saved=conversation.clone();saved.revision=Some(result["writeResults"][1]["updateTime"].as_str().ok_or("missing_commit_version")?.into());
        let mut cached=ChatData::from_storage(merged)?;
        for c in baseline.conversations_all().filter(|c|c.messages_loaded){if let Some(target)=cached.find_conversation_mut(&c.id){target.messages=c.messages.clone();target.messages_loaded=true;target.revision=c.revision.clone();}}
        *cached.find_conversation_mut(&saved.id).ok_or("conversation_not_found")?=saved.clone();
        self.trees.lock().unwrap().insert(uid.into(),cached);
        Ok(saved)
    }

    /// Explicit migration only; callers select a private application-data backup directory.
    pub async fn migrate_user_tree(&self,uid:&str,auth:&FirestoreAuth,backup_dir:&Path)->Result<bool,String>{
        valid_id(uid)?;
        let path=format!("users/{uid}");
        let parent=self.get_document(auth,&path,None).await?.ok_or("user_not_found")?;
        let value=document_fields(&parent)?.get("tree").cloned().unwrap_or(json!({"projects":[]}));
        if value["schema_version"]==2 {ChatData::from_storage(value)?;return Ok(false);}
        let tree=ChatData::from_storage(value)?;let compact=tree.storage_tree()?;
        std::fs::create_dir_all(backup_dir).map_err(|e|e.to_string())?;
        let backup=backup_dir.join(format!("history-v2-{uid}-{}.json",crate::data::now_millis()));
        let mut file=std::fs::OpenOptions::new().write(true).create_new(true).open(backup).map_err(|e|e.to_string())?;
        use std::io::Write;
        file.write_all(&serde_json::to_vec_pretty(&parent).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;file.sync_all().map_err(|e|e.to_string())?;
        for conversation in tree.conversations_all(){
            let chat_path=format!("{path}/conversations/{}",conversation.id);
            let mut records=vec![(chat_path.clone(),conversation_metadata(conversation,conversation.messages.len()))];
            for (index,message) in conversation.messages.iter().enumerate(){records.push((message_path(&chat_path,index),message_value(index,message)?));}
            for (record,value) in records {
                if let Some(existing)=self.get_document(auth,&record,None).await? {
                    if Value::Object(document_fields(&existing)?)!=value{return Err("migration_destination_conflict".into());}
                } else {self.commit(auth,vec![new_write(auth,&record,&value)?]).await?;}
                let checked=self.get_document(auth,&record,None).await?.ok_or("migration_verification_failed")?;
                if Value::Object(document_fields(&checked)?)!=value{return Err("migration_verification_failed".into());}
            }
        }
        self.commit(auth,vec![field_write(auth,&path,"tree",&compact,version(&parent)?)?]).await?;
        let verified=self.get_field(auth,&path,"tree").await?.ok_or("migration_verification_failed")?;
        if verified!=compact{return Err("migration_verification_failed".into());}
        self.trees.lock().unwrap().remove(uid);
        Ok(true)
    }

    pub async fn load_user(&self, uid: &str, auth: &FirestoreAuth) -> Result<UserConfig, String> {
        if !auth.configured() {
            return Err("firebase_not_configured".to_string());
        }
        let path = format!("users/{}", uid);
        match self.get_field(auth, &path, "config").await? {
            Some(value) => serde_json::from_value(value).map_err(|e| format!("parse user: {e}")),
            None => Ok(UserConfig::default()),
        }
    }

    pub async fn load_window(&self, uid: &str, auth: &FirestoreAuth) -> Result<Option<WindowGeometry>, String> {
        match self.get_field(auth, &format!("users/{uid}"), "window").await? {
            Some(value) => {
                let geometry: WindowGeometry = serde_json::from_value(value).map_err(|e| format!("parse window: {e}"))?;
                if !geometry.valid() { return Err("Firestore: invalid window dimensions".into()); }
                Ok(Some(geometry))
            }
            None => Ok(None),
        }
    }

    pub async fn save_window(&self, uid: &str, auth: &FirestoreAuth, geometry: &WindowGeometry) -> Result<(), String> {
        if !geometry.valid() { return Err("invalid window dimensions".into()); }
        let value = serde_json::to_value(geometry).map_err(|e| e.to_string())?;
        self.set_field(auth, &format!("users/{uid}"), "window", &value).await
    }

    pub async fn save_user(
        &self,
        uid: &str,
        auth: &FirestoreAuth,
        user: &UserConfig,
    ) -> Result<(), String> {
        if !auth.configured() {
            return Err("firebase_not_configured".to_string());
        }
        let value = serde_json::to_value(user).map_err(|e| e.to_string())?;
        let path = format!("users/{}", uid);
        self.set_field(auth, &path, "config", &value).await
    }
}

async fn response_json(response:reqwest::Response)->Result<Value,String>{
    let status=response.status();let text=response.text().await.map_err(|e|e.to_string())?;
    if !status.is_success(){
        let error_status=serde_json::from_str::<Value>(&text).ok().and_then(|v|v["error"]["status"].as_str().map(str::to_owned));
        if status.as_u16()==409 || status.as_u16()==412 || matches!(error_status.as_deref(),Some("FAILED_PRECONDITION"|"ABORTED")) {return Err("conversation_conflict".into());}
        return Err(format!("Firestore {}: {}",status.as_u16(),truncate(&text,300)));
    }
    serde_json::from_str(&text).map_err(|e|e.to_string())
}

fn version(doc:&Value)->Result<&str,String>{doc["updateTime"].as_str().ok_or_else(||"missing_document_version".into())}
fn document_name(auth:&FirestoreAuth,path:&str)->String{format!("projects/{}/databases/(default)/documents/{path}",auth.project_id)}
fn document_fields(doc:&Value)->Result<serde_json::Map<String,Value>,String>{
    doc["fields"].as_object().ok_or("invalid_document_fields")?.iter()
        .map(|(name,value)|Ok((name.clone(),if name=="tree" || name=="config" || name=="window" {decode_field(value)?}else{decode_value(value)?}))).collect()
}
fn update_write(auth:&FirestoreAuth,path:&str,value:&Value,revision:Option<&str>)->Result<Value,String>{
    let fields=value.as_object().ok_or("invalid_document")?.iter().map(|(key,value)|Ok((key.clone(),encode_value(value)?)))
        .collect::<Result<serde_json::Map<_,_>,String>>()?;
    let mut write=json!({"update":{"name":document_name(auth,path),"fields":fields}});
    if let Some(revision)=revision {write["currentDocument"]=json!({"updateTime":revision});}
    Ok(write)
}
fn new_write(auth:&FirestoreAuth,path:&str,value:&Value)->Result<Value,String>{
    let mut write=update_write(auth,path,value,None)?;write["currentDocument"]=json!({"exists":false});Ok(write)
}
fn conversation_write(auth:&FirestoreAuth,path:&str,value:&Value,revision:Option<&str>)->Result<Value,String>{
    let mut write=update_write(auth,path,value,revision)?;
    // Feedback can leave metadata identical; an atomic increment must still advance updateTime.
    write["updateMask"]=json!({"fieldPaths":value.as_object().ok_or("invalid_document")?.keys().collect::<Vec<_>>()});
    write["updateTransforms"]=json!([{"fieldPath":"_write_revision","increment":{"integerValue":"1"}}]);
    Ok(write)
}
fn field_write(auth:&FirestoreAuth,path:&str,field:&str,value:&Value,revision:&str)->Result<Value,String>{
    let mut write=update_write(auth,path,&json!({field:value}),Some(revision))?;
    write["updateMask"]=json!({"fieldPaths":[field]});Ok(write)
}
fn conversation_metadata(conversation:&Conversation,count:usize)->Value{
    let mut metadata=json!({"title":conversation.title,"created_at":conversation.created_at,"updated_at":conversation.updated_at,
        "context_tokens":conversation.context_tokens,"message_count":count});
    if let Some(model)=&conversation.model { metadata["model"]=json!(model); }
    metadata
}
fn message_path(path:&str,index:usize)->String{format!("{path}/messages/m{index:012}")}
fn message_value(index:usize,message:&crate::llm::ChatMessage)->Result<Value,String>{
    let mut value=serde_json::to_value(message).map_err(|e|e.to_string())?;
    value["sequence"]=json!(index);Ok(value)
}

/// Three-way merge applies only this client's edits, rejecting conflicting edits.
pub(crate) fn merge_changes(base:&Value,desired:&Value,remote:&Value)->Result<Value,String>{
    if base==desired{return Ok(remote.clone());}
    if base==remote || desired==remote{return Ok(desired.clone());}
    if let (Some(base),Some(desired),Some(remote))=(base.as_object(),desired.as_object(),remote.as_object()){
        let keys:std::collections::BTreeSet<_>=base.keys().chain(desired.keys()).chain(remote.keys()).collect();
        let mut merged=serde_json::Map::new();
        for key in keys{
            let before=base.get(key);let after=desired.get(key);let current=remote.get(key);
            let value=if before==after{current.cloned()}else if before==current || after==current{after.cloned()}
                else {match (before,after,current){(Some(b),Some(d),Some(r))=>Some(merge_changes(b,d,r)?),_=>return Err("conversation_conflict".into())}};
            if let Some(value)=value {merged.insert(key.clone(),value);}
        }
        Ok(Value::Object(merged))
    }else{Err("conversation_conflict".into())}
}

// La compatibilità con JSON stringificato riguarda solo il campo utente letto.
fn decode_field(value: &Value) -> Result<Value, String> {
    if let Some(legacy) = value.get("stringValue").and_then(Value::as_str) {
        return serde_json::from_str(legacy).map_err(|e| format!("parse legacy field: {e}"));
    }
    decode_value(value)
}

fn encode_value(value: &Value) -> Result<Value, String> {
    Ok(match value {
        Value::Null => json!({"nullValue": null}),
        Value::Bool(v) => json!({"booleanValue": v}),
        Value::String(v) => json!({"stringValue": v}),
        Value::Number(v) if v.is_i64() || v.is_u64() => {
            let n = v.as_i64().ok_or("Firestore: integer outside int64 range")?;
            json!({"integerValue": n.to_string()})
        }
        Value::Number(v) => json!({"doubleValue": v}),
        Value::Array(values) => json!({"arrayValue": {"values": values.iter()
            .map(encode_value).collect::<Result<Vec<_>, _>>()?}}),
        Value::Object(fields) => json!({"mapValue": {"fields": fields.iter()
            .map(|(key, value)| Ok((key.clone(), encode_value(value)?)))
            .collect::<Result<serde_json::Map<_, _>, String>>()?}}),
    })
}

fn decode_value(value: &Value) -> Result<Value, String> {
    if value.get("nullValue").is_some() { return Ok(Value::Null); }
    if let Some(v) = value.get("booleanValue").and_then(Value::as_bool) { return Ok(json!(v)); }
    if let Some(v) = value.get("stringValue").and_then(Value::as_str) { return Ok(json!(v)); }
    if let Some(v) = value.get("integerValue").and_then(Value::as_str) {
        return v.parse::<i64>().map(|n| json!(n)).map_err(|e| format!("Firestore integer: {e}"));
    }
    if let Some(v) = value.get("doubleValue").and_then(Value::as_f64) { return Ok(json!(v)); }
    if let Some(map) = value.get("mapValue").and_then(Value::as_object) {
        let mut fields = serde_json::Map::new();
        if let Some(raw) = map.get("fields") {
            for (key, v) in raw.as_object().ok_or("Firestore: invalid map fields")? {
                fields.insert(key.clone(), decode_value(v)?);
            }
        }
        return Ok(Value::Object(fields));
    }
    if let Some(array) = value.get("arrayValue").and_then(Value::as_object) {
        let mut values = Vec::new();
        if let Some(raw) = array.get("values") {
            for v in raw.as_array().ok_or("Firestore: invalid array values")? {
                values.push(decode_value(v)?);
            }
        }
        return Ok(Value::Array(values));
    }
    Err("Firestore: unsupported or invalid field value".into())
}

fn doc_url(project_id: &str, path: &str) -> String {
    let mut url=reqwest::Url::parse("https://firestore.googleapis.com/").expect("constant URL");
    {
        let mut segments=url.path_segments_mut().expect("hierarchical URL");
        segments.extend(["v1","projects",project_id,"databases","(default)","documents"]);
        segments.extend(path.split('/').filter(|part|!part.is_empty()));
    }
    url.into()
}

async fn sign_in_with_password(
    http: &reqwest::Client,
    api_key: &str,
    email: &str,
    password: &str,
) -> Result<(String, String, String, i64), String> {
    let url = format!(
        "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key={}",
        api_key
    );
    let resp = http
        .post(&url)
        .json(&json!({
            "email": email,
            "password": password,
            "returnSecureToken": true
        }))
        .send()
        .await
        .map_err(|e| format!("auth: {e}"))?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!(
            "auth signIn {}: {}",
            status.as_u16(),
            truncate(&text, 300)
        ));
    }
    let v: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    let uid = v["localId"]
        .as_str()
        .ok_or("auth: localId mancante")?
        .to_string();
    let id = v["idToken"]
        .as_str()
        .ok_or("auth: idToken mancante")?
        .to_string();
    let rt = v["refreshToken"]
        .as_str()
        .ok_or("auth: refreshToken mancante")?
        .to_string();
    let exp = v["expiresIn"]
        .as_str()
        .and_then(|s| s.parse::<i64>().ok())
        .unwrap_or(3600);
    Ok((uid, id, rt, now_secs() + exp))
}

async fn refresh_id_token(
    http: &reqwest::Client,
    api_key: &str,
    refresh: &str,
) -> Result<(String, String, i64), String> {
    let url = format!("https://securetoken.googleapis.com/v1/token?key={}", api_key);
    let resp = http
        .post(&url)
        .form(&[("grant_type", "refresh_token"), ("refresh_token", refresh)])
        .send()
        .await
        .map_err(|e| format!("auth refresh: {e}"))?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!(
            "auth refresh {}: {}",
            status.as_u16(),
            truncate(&text, 300)
        ));
    }
    let v: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    let id = v["id_token"]
        .as_str()
        .ok_or("auth: id_token mancante")?
        .to_string();
    let rt = v["refresh_token"]
        .as_str()
        .ok_or("auth: refresh_token mancante")?
        .to_string();
    let exp = v["expires_in"]
        .as_str()
        .and_then(|s| s.parse::<i64>().ok())
        .unwrap_or(3600);
    Ok((id, rt, now_secs() + exp))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merge_keeps_other_devices_changes_and_rejects_same_field_conflicts(){
        let base=json!({"projects":{"p":{"name":"before"}},"conversations":{"c":{"title":"old","updated_at":1}}});
        let mut desired=base.clone();desired["projects"]["p"]["name"]=json!("local");
        let mut remote=base.clone();remote["conversations"]["c"]["title"]=json!("remote");
        let merged=merge_changes(&base,&desired,&remote).unwrap();
        assert_eq!(merged["projects"]["p"]["name"],"local");assert_eq!(merged["conversations"]["c"]["title"],"remote");
        remote["projects"]["p"]["name"]=json!("conflicting");
        assert!(merge_changes(&base,&desired,&remote).is_err());
    }

    #[test]
    fn message_records_preserve_strings_and_private_attachment_metadata(){
        let message:crate::llm::ChatMessage=serde_json::from_value(json!({"role":"user","content":"not JSON","attachments":[{"name":"x.txt","content":"{example}"}],"feedback":false})).unwrap();
        let value=message_value(3,&message).unwrap();
        let auth=crate::config::AppConfig::default().firestore_auth();
        let write=update_write(&auth,"users/u/conversations/c/messages/m000000000003",&value,None).unwrap();
        assert_eq!(Value::Object(document_fields(&write["update"]).unwrap()),value);
        assert_eq!(message_path("users/u/conversations/c",3),"users/u/conversations/c/messages/m000000000003");
        let parent=json!({"fields":{"tree":{"stringValue":"{\"projects\":[]}"}}});
        assert_eq!(document_fields(&parent).unwrap()["tree"],json!({"projects":[]}));
        assert!(doc_url("project","users/u/conversations/chat#1?x").ends_with("chat%231%3Fx"));
        let versioned=conversation_write(&auth,"users/u/conversations/c",&json!({"message_count":2}),Some("version")).unwrap();
        assert_eq!(versioned["updateTransforms"][0]["fieldPath"],"_write_revision");
        assert_eq!(versioned["updateTransforms"][0]["increment"]["integerValue"],"1");
        assert_eq!(versioned["updateMask"]["fieldPaths"],json!(["message_count"]));
    }

    #[test]
    #[ignore = "Real authenticated relay CRUD; AURACHAT_REMOTE_SMOKE=1 required"]
    fn real_companion_claim() {
        assert_eq!(std::env::var("AURACHAT_REMOTE_SMOKE").as_deref(),Ok("1"));
        let dir=std::path::PathBuf::from(std::env::var_os("APPDATA").unwrap()).join("dev.aurachat.desktop");
        let config=crate::config::AppConfig::load(&dir);
        let auth=config.firestore_auth();let uid=config.uid.clone();assert!(!uid.is_empty());
        tauri::async_runtime::block_on(async {
            let client=Firestore::new();
            let collection=format!("users/{uid}/devices/transport-smoke-{}/requests",crate::data::now_millis());
            let parent=collection.strip_suffix("/requests").unwrap();
            let path=format!("{collection}/fixture");
            client.relay_put(&auth,&path,&json!({"status":"pending","content":"Transport fixture, never executed"}),None).await.unwrap();
            let result=async {
                let requests=client.relay_requests(&auth,parent,"pending").await?;
                if requests.len()!=1{return Err("pending_query_failed".to_string());}
                let (_,revision,mut request)=requests[0].clone();request["status"]=json!("running");
                client.relay_put(&auth,&path,&request,Some(&revision)).await?;
                if client.relay_put(&auth,&path,&request,Some(&revision)).await.is_ok(){return Err("duplicate_claim_allowed".into());}
                if !client.relay_requests(&auth,parent,"pending").await?.is_empty(){return Err("claimed_request_still_pending".into());}
                client.relay_revisioned(&auth,&path,&json!({"status":"approved","revision":2})).await?;
                client.relay_revisioned(&auth,&path,&json!({"status":"pending","revision":1})).await?;
                let latest=client.get_document(&auth,&path,None).await?.ok_or("missing_snapshot")?;
                if document_fields(&latest)?["status"]!="approved" {return Err("stale_approval_reactivated".into());}
                assert!(client.companion_isolated(&auth).await?, "Owner-only rules must reject a valid foreign document path with 403");
                println!("Authenticated relay verified: pending query, atomic claim, duplicate rejection, owner isolation.");
                Ok::<(),String>(())
            }.await;
            let cleanup=client.commit(&auth,vec![json!({"delete":document_name(&auth,&path)})]).await;
            cleanup.expect("Remove only temporary relay fixture");result.unwrap();
        });
    }

    #[test]
    #[ignore = "Explicit development database migration; AURACHAT_MIGRATE=1 required"]
    fn real_user_history_migration(){
        assert_eq!(std::env::var("AURACHAT_MIGRATE").as_deref(),Ok("1"));
        let dir=std::env::var_os("AURACHAT_CONFIG_DIR").map(std::path::PathBuf::from).unwrap_or_else(||
            std::path::PathBuf::from(std::env::var_os("APPDATA").expect("APPDATA")).join("dev.aurachat.desktop"));
        let mut config=crate::config::AppConfig::load(&dir);
        assert!(!config.uid.is_empty(),"Existing authenticated development session required");
        tauri::async_runtime::block_on(async {
            let client=Firestore::new();let auth=config.firestore_auth();let uid=config.uid.clone();
            let before=client.get_field(&auth,&format!("users/{uid}"),"tree").await.unwrap().unwrap_or(json!({"projects":[]}));
            let was_legacy=before["schema_version"]!=2;
            let original=ChatData::from_storage(before).unwrap();
            let migrated=client.migrate_user_tree(&uid,&auth,&dir.join("migration-backups")).await.unwrap();
            assert_eq!(migrated,was_legacy);
            let after=client.load_tree(&uid,&auth).await.unwrap();
            assert_eq!(original.storage_tree().unwrap(),after.storage_tree().unwrap());
            let mut total_messages=0;
            for summary in after.conversations_all(){
                let loaded=client.load_conversation(&uid,&auth,&summary.id).await.unwrap();
                if was_legacy {
                    let old=original.find_conversation(&summary.id).unwrap();
                    assert_eq!(serde_json::to_value(&old.messages).unwrap(),serde_json::to_value(&loaded.messages).unwrap());
                }
                total_messages+=loaded.messages.len();
            }
            assert!(!client.migrate_user_tree(&uid,&auth,&dir.join("migration-backups")).await.unwrap());
            if let Some((uid,refresh))=client.session(){config.uid=uid;config.refresh_token=refresh;config.save(&dir).unwrap();}
            println!("Verified history v2: migrated={migrated}, projects={}, conversations={}, messages={total_messages}",after.projects.len(),after.conversations_all().count());
        });
    }

    #[test]
    #[ignore = "Temporary real database CRUD verification; AURACHAT_MIGRATE=1 required"]
    fn real_user_history_crud(){
        assert_eq!(std::env::var("AURACHAT_MIGRATE").as_deref(),Ok("1"));
        let dir=std::env::var_os("AURACHAT_CONFIG_DIR").map(std::path::PathBuf::from).unwrap_or_else(||
            std::path::PathBuf::from(std::env::var_os("APPDATA").expect("APPDATA")).join("dev.aurachat.desktop"));
        let mut config=crate::config::AppConfig::load(&dir);
        assert!(!config.uid.is_empty(),"Existing authenticated development session required");
        fn check(condition:bool,stage:&str)->Result<(),String>{if condition{Ok(())}else{Err(format!("CRUD verification failed: {stage}"))}}
        tauri::async_runtime::block_on(async {
            let client=Firestore::new();let auth=config.firestore_auth();let uid=config.uid.clone();
            let path=format!("users/{uid}");
            let original=client.load_tree(&uid,&auth).await.expect("Load original tree");
            let original_projection=original.storage_tree().unwrap();
            let before=client.get_document(&auth,&path,None).await.unwrap().unwrap();
            let config_before=before["fields"]["config"].clone();let window_before=before["fields"]["window"].clone();
            let id=format!("aurachat-crud-test-{}-{}",crate::data::now_millis(),std::process::id());
            let chat_path=format!("{path}/conversations/{id}");
            let outcome:Result<(),String>=async {
                let mut draft=original.clone();
                draft.conversations.push(Conversation {id:id.clone(),title:"Temporary CRUD fixture".into(),model:None,messages:vec![],created_at:1,updated_at:1,context_tokens:0,messages_loaded:true,revision:None});
                client.save_tree(&uid,&auth,&draft).await?;
                let mut tree=client.cached_tree(&uid).ok_or("missing_draft_cache")?;
                check(tree.find_conversation(&id).and_then(|c|c.revision.as_ref()).is_some(),"draft revision")?;
                let conversation=tree.find_conversation_mut(&id).ok_or("missing_fixture")?;
                conversation.messages=serde_json::from_value(json!([
                    {"role":"user","content":"Fixture request","attachments":[{"name":"fixture.txt","content":"Temporary attachment contents"}]},
                    {"role":"assistant","content":"Fixture response"}
                ])).map_err(|e|e.to_string())?;
                conversation.updated_at=2;conversation.context_tokens=8;
                let expected_messages=serde_json::to_value(&conversation.messages).map_err(|e|e.to_string())?;
                let conversation=conversation.clone();
                let saved=client.save_conversation(&uid,&auth,&conversation,&tree).await?;
                check(saved.revision.is_some(),"saved revision")?;
                let summary_tree=client.load_tree(&uid,&auth).await?;
                let summary=summary_tree.find_conversation(&id).ok_or("missing_summary")?;
                check(!summary.messages_loaded && summary.messages.is_empty(),"lazy summary")?;
                let loaded=client.load_conversation(&uid,&auth,&id).await?;
                check(serde_json::to_value(&loaded.messages).map_err(|e|e.to_string())?==expected_messages,"messages and attachments")?;
                let local=client.cached_tree(&uid).ok_or("missing_history_cache")?;
                let refreshed=client.refresh_tree_preserving_history(&uid,&auth,&local).await?;
                let retained=refreshed.find_conversation(&id).ok_or("missing_refreshed_chat")?;
                check(retained.messages_loaded && serde_json::to_value(&retained.messages).map_err(|e|e.to_string())?==expected_messages,"companion refresh preserves loaded history")?;

                let stale=Firestore::new();let mut stale_tree=stale.load_tree(&uid,&auth).await?;
                let stale_conversation=stale.load_conversation(&uid,&auth,&id).await?;
                *stale_tree.find_conversation_mut(&id).ok_or("missing_stale_fixture")?=stale_conversation.clone();
                let mut feedback_tree=client.cached_tree(&uid).ok_or("missing_loaded_cache")?;
                feedback_tree.find_conversation_mut(&id).ok_or("missing_feedback_fixture")?.messages[1].feedback=Some(true);
                client.save_tree(&uid,&auth,&feedback_tree).await?;
                let feedback=client.load_conversation(&uid,&auth,&id).await?;
                check(feedback.messages[1].feedback==Some(true),"feedback persistence")?;
                let mut stale_edit=stale_conversation.clone();stale_edit.messages[0].content="Must never replace saved messages".into();
                check(stale.save_conversation(&uid,&auth,&stale_edit,&stale_tree).await.err().as_deref()==Some("conversation_conflict"),"stale conversation rejection")?;
                stale_tree.find_conversation_mut(&id).ok_or("missing_stale_fixture")?.messages[1].feedback=Some(false);
                check(stale.save_tree(&uid,&auth,&stale_tree).await.err().as_deref()==Some("conversation_conflict"),"stale feedback atomic rejection")?;
                let unchanged=client.load_conversation(&uid,&auth,&id).await?;
                check(unchanged.messages[0].content=="Fixture request" && unchanged.messages[1].feedback==Some(true),"stale writes leave messages unchanged")?;

                let mut edit_tree=client.cached_tree(&uid).ok_or("missing_edit_cache")?;
                let edit=edit_tree.find_conversation_mut(&id).ok_or("missing_edit_fixture")?;
                edit.messages.truncate(1);edit.messages[0].content="Edited fixture request".into();edit.updated_at=3;
                let edit=edit.clone();client.save_conversation(&uid,&auth,&edit,&edit_tree).await?;
                let edited=client.load_conversation(&uid,&auth,&id).await?;
                check(edited.messages.len()==1 && edited.messages[0].content=="Edited fixture request" && edited.messages[0].attachments.len()==1,"edit and truncate")?;
                check(client.list_messages(&auth,&chat_path).await?.len()==1,"truncated message physically deleted")?;

                let mut rename_tree=client.load_tree(&uid,&auth).await?;
                rename_tree.find_conversation_mut(&id).ok_or("missing_rename_fixture")?.title="Renamed temporary fixture".into();
                client.save_tree(&uid,&auth,&rename_tree).await?;
                let renamed=client.load_conversation(&uid,&auth,&id).await?;
                check(renamed.title=="Renamed temporary fixture" && renamed.messages.len()==1,"rename unloaded summary preserves messages")?;
                let mut removed=client.load_tree(&uid,&auth).await?;removed.conversations.retain(|c|c.id!=id);
                client.save_tree(&uid,&auth,&removed).await?;
                check(client.get_document(&auth,&chat_path,None).await?.is_none(),"conversation deletion")?;
                check(client.list_messages(&auth,&chat_path).await?.is_empty(),"message deletion")?;
                Ok(())
            }.await;
            // Always remove only this fixture, preserving any independent tree changes.
            let cleanup:Result<(),String>=async {
                let mut latest=client.load_tree(&uid,&auth).await?;
                if latest.find_conversation(&id).is_some(){latest.conversations.retain(|c|c.id!=id);client.save_tree(&uid,&auth,&latest).await?;}
                if let Some(doc)=client.get_document(&auth,&chat_path,None).await? {
                    let mut writes=Vec::new();
                    for message in client.list_messages(&auth,&chat_path).await? {writes.push(json!({"delete":message["name"],"currentDocument":{"updateTime":version(&message)?}}));}
                    writes.push(json!({"delete":document_name(&auth,&chat_path),"currentDocument":{"updateTime":version(&doc)?}}));
                    client.commit(&auth,writes).await?;
                }
                let after=client.get_document(&auth,&path,None).await?.ok_or("missing_user")?;
                check(after["fields"]["config"]==config_before,"config unchanged")?;
                check(after["fields"]["window"]==window_before,"window unchanged")?;
                let final_tree=client.load_tree(&uid,&auth).await?;
                check(final_tree.storage_tree()?==original_projection,"original tree preserved")?;
                Ok(())
            }.await;
            if let Some((uid,refresh))=client.session(){config.uid=uid;config.refresh_token=refresh;config.save(&dir).expect("Preserve refreshed session");}
            cleanup.expect("Fixture cleanup and preservation checks");
            outcome.expect("Real CRUD checks");
            println!("Verified real CRUD: draft, messages, attachment, feedback, stale conflicts, edit, rename and deletion; fixture removed; config/window/original tree unchanged");
        });
    }

    #[test]
    fn native_maps_preserve_nested_data_and_types() {
        let original = json!({"models": {"deepseek.v4": {"model": "chat"}},
            "projects": [{"folders": [{"conversations": [{"messages": [
                {"role": "user", "content": "{\"example\":true}"}], "created_at": 1792200000000i64}]}]}],
            "conversations": [], "empty": {}, "bool": true, "null": null,
            "negative": -5, "decimal": 1.5});
        let encoded = encode_value(&original).unwrap();
        assert!(encoded["mapValue"]["fields"]["models"]["mapValue"].is_object());
        assert_eq!(decode_field(&encoded).unwrap(), original);
        assert_eq!(decode_value(&json!({"mapValue": {}})).unwrap(), json!({}));
        assert_eq!(decode_value(&json!({"arrayValue": {}})).unwrap(), json!([]));
    }

    #[test]
    fn window_layout_round_trips_as_a_native_map() {
        let geometry = WindowGeometry { x: -1600, y: 80, width: 1000, height: 720, maximized: true };
        let value = serde_json::to_value(&geometry).unwrap();
        let encoded = encode_value(&value).unwrap();
        assert_eq!(encoded["mapValue"]["fields"]["x"]["integerValue"], "-1600");
        assert_eq!(encoded["mapValue"]["fields"]["maximized"]["booleanValue"], true);
        let restored: WindowGeometry = serde_json::from_value(decode_field(&encoded).unwrap()).unwrap();
        assert_eq!(restored, geometry);
        assert!(!WindowGeometry { width: 0, ..geometry }.valid());
    }

    #[test]
    fn user_config_supports_legacy_and_native_fields() {
        let config = serde_json::to_value(UserConfig::default()).unwrap();
        let legacy = json!({"stringValue": serde_json::to_string(&config).unwrap()});
        assert_eq!(decode_field(&legacy).unwrap(), config);
        let native = encode_value(&config).unwrap();
        let restored: UserConfig = serde_json::from_value(decode_field(&native).unwrap()).unwrap();
        assert_eq!(restored.active_model, UserConfig::default().active_model);
        assert!(decode_field(&json!({"stringValue": "broken"})).is_err());
        assert!(decode_value(&json!({"integerValue": "broken"})).is_err());
        assert!(encode_value(&json!(u64::MAX)).is_err());
    }
}
