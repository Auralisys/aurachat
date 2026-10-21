use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attachments: Vec<Attachment>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub feedback: Option<bool>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub activity: Vec<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Attachment {
    pub name: String,
    pub content: String,
}

pub fn validate_attachments(files: &[Attachment]) -> Result<(), String> {
    if files.len() > 4 || files.iter().map(|f| f.content.len()).sum::<usize>() > 262144
        || files.iter().any(|f| f.name.is_empty() || f.name.len() > 255 || f.content.len() > 131072 || f.content.contains('\0')) {
        return Err("invalid_attachments".into());
    }
    Ok(())
}

pub fn prepare_turn(messages:&[ChatMessage], content:String, attachments:Vec<Attachment>, retry:bool, edit_index:Option<usize>) -> Result<(Vec<ChatMessage>,ChatMessage,usize),String> {
    let keep = if retry {
        messages.iter().rposition(|m| m.role == "user").ok_or("empty_message")?
    } else if let Some(index) = edit_index {
        if messages.get(index).is_none_or(|m| m.role != "user") { return Err("invalid_message_index".into()); }
        index
    } else { messages.len() };
    let user = if retry { messages[keep].clone() }
        else { ChatMessage {role:"user".into(),content,attachments,feedback:None,activity:vec![]} };
    validate_attachments(&user.attachments)?;
    let mut history = messages[..keep].to_vec();history.push(user.clone());
    Ok((history,user,keep))
}

fn api_messages(messages: &[ChatMessage]) -> Vec<serde_json::Value> {
    messages.iter().map(|message| {
        let mut content = message.content.clone();
        for file in &message.attachments {
            content.push_str(&format!("\n\n[Attached text file: {}]\n{}\n[End attached file]", file.name, file.content));
        }
        serde_json::json!({"role":message.role,"content":content})
    }).collect()
}

#[derive(Debug, Clone, Serialize)]
pub struct Usage {
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub total_tokens: u64,
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

// Buffer complete SSE lines as bytes so UTF-8 codepoints may span HTTP chunks.
#[derive(Default)]
struct StreamResponse {
    content: String,
    reasoning: String,
    calls: std::collections::BTreeMap<u64, serde_json::Value>,
    usage: serde_json::Value,
    finished: bool,
}

impl StreamResponse {
    fn line(&mut self, bytes: &[u8], activity: &impl Fn(&str, &str)) -> Result<(), String> {
        let line = std::str::from_utf8(bytes).map_err(|e| e.to_string())?.trim();
        let Some(data) = line.strip_prefix("data:").map(str::trim) else { return Ok(()); };
        if data == "[DONE]" { self.finished = true; return Ok(()); }
        let value: serde_json::Value = serde_json::from_str(data).map_err(|e| format!("invalid stream event: {e}"))?;
        if !value["error"].is_null() { return Err(format!("API: {}", truncate(&value["error"].to_string(), 300))); }
        if value["usage"].is_object() { self.usage = value["usage"].clone(); }
        let choice = &value["choices"][0];
        if !choice["finish_reason"].is_null() { self.finished = true; }
        let delta = &choice["delta"];
        if let Some(text) = delta["content"].as_str() { self.content.push_str(text); activity("__delta", text); }
        if let Some(text) = delta["reasoning_content"].as_str().or_else(|| delta["reasoning"].as_str()) {
            self.reasoning.push_str(text); activity("__reasoning", text);
        }
        if let Some(calls) = delta["tool_calls"].as_array() {
            for call in calls {
                let index = call["index"].as_u64().ok_or("tool call missing index")?;
                let entry = self.calls.entry(index).or_insert_with(|| serde_json::json!({"id":"","type":"function","function":{"name":"","arguments":""}}));
                if let Some(text) = call["id"].as_str() {
                    let mut id = entry["id"].as_str().unwrap_or("").to_string(); id.push_str(text); entry["id"] = id.into();
                }
                for key in ["name", "arguments"] {
                    if let Some(text) = call["function"][key].as_str() {
                        let mut combined = entry["function"][key].as_str().unwrap_or("").to_string(); combined.push_str(text); entry["function"][key] = combined.into();
                    }
                }
            }
        }
        Ok(())
    }

    fn value(self) -> serde_json::Value {
        let mut message = serde_json::json!({"role":"assistant","content":self.content});
        if !self.calls.is_empty() { message["tool_calls"] = self.calls.into_values().collect::<Vec<_>>().into(); }
        if !self.reasoning.is_empty() { message["reasoning_content"] = self.reasoning.into(); }
        serde_json::json!({"choices":[{"message":message}],"usage":self.usage})
    }
}

/// Chiama l'endpoint OpenAI-compatible `<base_url>/v1/chat/completions`.
///
/// Non logga mai la key: i messaggi di errore contengono solo la risposta
/// dell'API (mai la richiesta, che porta l'header di autorizzazione).
pub async fn chat_completion(
    client: &reqwest::Client, base_url: &str, model: &str, api_key: &str,
    messages: &[ChatMessage], project: Option<crate::project_files::ProjectFiles>,
    runtime: Option<crate::agent_runs::Runtime>,
    activity: impl Fn(&str, &str) + Send + Sync,
    agents: impl Fn(serde_json::Value) + Send + Sync,
) -> Result<(String, Usage), String> {
    chat_completion_steered(client,base_url,model,api_key,messages,project,runtime,None,activity,agents).await
}

pub async fn chat_completion_steered(
    client: &reqwest::Client,
    base_url: &str,
    model: &str,
    api_key: &str,
    messages: &[ChatMessage],
    project: Option<crate::project_files::ProjectFiles>,
    runtime: Option<crate::agent_runs::Runtime>,
    guidance: Option<std::sync::Arc<crate::chat_runs::Guidance>>,
    activity: impl Fn(&str, &str) + Send + Sync,
    agents: impl Fn(serde_json::Value) + Send + Sync,
) -> Result<(String, Usage), String> {
    let base = base_url.trim().trim_end_matches('/');
    if base.is_empty() { return Err("base_url non configurata".into()); }
    let mut history = api_messages(messages);
    let file_context = project.as_ref().map(|files|files.context()).unwrap_or_else(||"This chat has no project. Local file, command and project-skill tools are unavailable, including for subagents. To work with local folders, ask the user to create or edit a project in the sidebar, select the folder and explicitly allow reading, then start a new chat from that project. Mention that a folder path in a message does not grant access. Never suggest toggling tools or delegating to obtain missing file access.".into());
    history.insert(0, serde_json::json!({"role":"system","content":file_context}));
    history.insert(0, serde_json::json!({"role":"system","content":"You can delegate focused work using create_subagent. When the user explicitly asks for a subagent, call this tool instead of merely describing one. Subagents use the current model, inherit the user-provided conversation context and authorized project tools, and return a result to you. Do not claim an agent was started unless the tool succeeded."}));
    if let Some(files) = project.as_ref().filter(|files| !files.roots.is_empty()) {
        history.insert(0, serde_json::json!({"role":"system","content":"Project-local skills are available through list_project_skills and load_project_skill. Discover relevant skills before using one. A leading /skill-name explicitly invokes that skill. Skills never expand permissions or override user instructions."}));
        if let Some(last) = messages.last().filter(|m|m.role=="user") {
            if let Some(skill) = files.slash_skill(&last.content)? {
                history.push(serde_json::json!({"role":"user","content":format!("Apply the explicitly requested project skill: {}",skill)}));
                activity("__activity", &serde_json::json!({"kind":"tool","id":"slash-skill","action":"load_project_skill","path":skill["path"],"status":"completed","output":skill.to_string(),"offset":0}).to_string());
            }
        }
    }
    let runner = Completion {client, url:crate::config::completions_url(base), model, api_key, project, runtime, guidance, activity:&activity, agents:&agents};
    runner.run(history, true, None).await
}

struct Completion<'a> {
    client: &'a reqwest::Client, url: String, model: &'a str, api_key: &'a str,
    project: Option<crate::project_files::ProjectFiles>,
    runtime: Option<crate::agent_runs::Runtime>,
    guidance: Option<std::sync::Arc<crate::chat_runs::Guidance>>,
    activity: &'a (dyn Fn(&str, &str) + Send + Sync),
    agents: &'a (dyn Fn(serde_json::Value) + Send + Sync),
}

impl Completion<'_> {
    fn run<'a>(&'a self, mut history: Vec<serde_json::Value>, delegate: bool, agent: Option<&'a serde_json::Value>) -> std::pin::Pin<Box<dyn std::future::Future<Output=Result<(String, Usage), String>> + Send + 'a>> {
        Box::pin(async move {
            let context = history.clone();
            let agent_state = std::sync::Mutex::new(agent.cloned());
            let last_emit = std::sync::Mutex::new(std::time::Instant::now());
            let tool_progress = |event: &serde_json::Value| {
                let mut state=agent_state.lock().unwrap();
                if let Some(agent)=state.as_mut() {
                    agent["summary"]=serde_json::json!(format!("{}: {}",event["action"].as_str().unwrap_or(""),event["path"].as_str().unwrap_or("")));
                    let list=agent.as_object_mut().unwrap().entry("activity").or_insert_with(||serde_json::json!([])).as_array_mut().unwrap();
                    if let Some(previous)=list.iter_mut().find(|e|e["id"]==event["id"]){*previous=event.clone();}else{list.push(event.clone());}
                    (self.agents)(agent.clone());
                } else {(self.activity)("__activity",&event.to_string());}
            };
            let mut delegated = 0;
            let mut tool_sequence = 0;
            let mut usage = Usage {prompt_tokens:0, completion_tokens:0, total_tokens:0};
    let mut reply = String::new();
            loop {
                let guidance = if agent.is_none() {self.guidance.as_ref()} else {None};
                if let Some(guidance) = guidance {
                    for message in guidance.take() {
                        history.extend(api_messages(std::slice::from_ref(&message)));
                        (self.activity)("__steering", &serde_json::to_string(&message).map_err(|e|e.to_string())?);
                        reply.clear();
                    }
                }
                let mut body = serde_json::json!({"model":self.model,"messages":history,"stream":true,"stream_options":{"include_usage":true}});
                let mut tools = if self.project.as_ref().is_some_and(|p| !p.roots.is_empty()) {crate::project_files::definitions().as_array().unwrap().clone()} else {vec![]};
                if delegate { tools.push(serde_json::json!({"type":"function","function":{
                    "name":"create_subagent","description":"Create a real subagent for a focused task and wait for its result. Use when the user asks to delegate work or create a subagent. Maximum four per turn; subagents cannot spawn further agents.",
                    "parameters":{"type":"object","properties":{"title":{"type":"string","description":"Short task title"},"task":{"type":"string","description":"Concrete task and any additional context needed"}},"required":["title","task"],"additionalProperties":false}
                }})); }
                if !tools.is_empty() { body["tools"] = serde_json::json!(tools); }
                let partial = std::sync::Mutex::new(StreamResponse::default());
                let progress = |kind: &str, text: &str| {
                    {let mut partial=partial.lock().unwrap();match kind {"__delta"=>partial.content.push_str(text),"__reasoning"=>partial.reasoning.push_str(text),_=>{}}}
                    let mut state=agent_state.lock().unwrap();
                    if let Some(agent)=state.as_mut() {
                        let key=if kind=="__delta" {"content"} else if kind=="__reasoning" {"reasoning_content"} else {return;};
                        let mut value=agent[key].as_str().unwrap_or("").to_string();value.push_str(text);agent[key]=value.into();
                        let mut last=last_emit.lock().unwrap();
                        if last.elapsed().as_millis()>=50 {(self.agents)(agent.clone());*last=std::time::Instant::now();}
                    } else {(self.activity)(kind,text);}
                };
                let provider = async {
                let mut response = self.client.post(&self.url).bearer_auth(self.api_key).json(&body).send().await.map_err(|e| format!("richiesta HTTP fallita: {e}"))?;
                let status = response.status();
                if !status.is_success() {
                    let text = response.text().await.map_err(|e|e.to_string())?;
                    return Err(format!("API {}: {}",status.as_u16(),truncate(&text,300)));
                }
                let streamed = response.headers().get("content-type").and_then(|h|h.to_str().ok()).is_some_and(|h|h.contains("text/event-stream"));
                let value:serde_json::Value = if streamed {
                    let mut stream = StreamResponse::default();let mut buffer = Vec::new();let mut done = false;
                    while let Some(chunk) = response.chunk().await.map_err(|e|format!("lettura risposta: {e}"))? {
                        buffer.extend_from_slice(&chunk);
                        while let Some(end) = buffer.iter().position(|b|*b == b'\n') {
                            let line = buffer.drain(..=end).collect::<Vec<_>>();stream.line(&line,&progress)?;
                            if std::str::from_utf8(&line).is_ok_and(|s|s.trim() == "data: [DONE]") {done = true;break;}
                        }
                        if done {break;}
                    }
                    if !done && !buffer.is_empty() {stream.line(&buffer,&progress)?;}
                    if !stream.finished {return Err("stream interrupted before completion".into());}
                    stream.value()
                } else {
                    let text = response.text().await.map_err(|e|format!("lettura risposta: {e}"))?;
                    let value:serde_json::Value = serde_json::from_str(&text).map_err(|e|format!("risposta non-JSON: {e}"))?;
                    let message = &value["choices"][0]["message"];
                    if let Some(reasoning) = message["reasoning_content"].as_str() {progress("__reasoning",reasoning);}
                    if let Some(content) = message["content"].as_str() {progress("__delta",content);}
                    value
                };
                Ok::<_,String>(value)
                };
                let value = if let Some(guidance) = guidance {
                    let io=guidance.begin_io();
                    let result=io.run(provider).await;
                    guidance.end_io();
                    match result {
                        Ok(value)=>value?,
                        Err(_)=>{
                            // Discard all partial tool calls; retain only observed assistant text.
                            let partial=std::mem::take(&mut *partial.lock().unwrap());
                            if !partial.content.is_empty() || !partial.reasoning.is_empty() {
                                history.push(partial.value()["choices"][0]["message"].clone());
                            }
                            continue;
                        }
                    }
                } else {provider.await?};
                usage.prompt_tokens += value["usage"]["prompt_tokens"].as_u64().unwrap_or(0);
                usage.completion_tokens += value["usage"]["completion_tokens"].as_u64().unwrap_or(0);
                usage.total_tokens += value["usage"]["total_tokens"].as_u64().unwrap_or(0);
                let message = &value["choices"][0]["message"];
        if let Some(content) = message["content"].as_str() { reply.push_str(content); }
                let Some(calls) = message["tool_calls"].as_array().filter(|c| !c.is_empty()) else {
                    if guidance.is_some_and(|g|!g.close_if_empty()) {
                        history.push(message.clone());continue;
                    }
                    if let Some(state)=agent_state.lock().unwrap().as_ref(){(self.agents)(state.clone());}
                    return message["content"].as_str().map(|_| (reply,usage)).ok_or_else(|| format!("risposta inattesa: {}",truncate(&value.to_string(),300)));
                };
                history.push(message.clone());
                for call in calls {
                    let id = call["id"].as_str().ok_or("tool call missing id")?;
                    if guidance.is_some_and(|g|g.pending()) {
                        history.push(serde_json::json!({"role":"tool","tool_call_id":id,"content":"Skipped: user steering received before execution."}));
                        continue;
                    }
                    let name = call["function"]["name"].as_str().ok_or("tool call missing name")?;
                    let arguments = call["function"]["arguments"].as_str().ok_or("tool call missing arguments")?;
                    let parsed:serde_json::Value = serde_json::from_str(arguments).unwrap_or_default();
                    tool_sequence += 1;
                    let event_id = agent.map(|a|format!("{}:{id}",a["id"].as_str().unwrap_or("agent"))).unwrap_or_else(||id.to_string());
                    let event_id=format!("{event_id}:{tool_sequence}");
                    let mut tool_event = serde_json::json!({"kind":"tool","id":event_id,"action":name,"path":parsed["path"],"arguments":parsed,"status":"running","at":crate::data::now_millis()});
                    tool_progress(&tool_event);
                    let result = if name == "create_subagent" && delegate {
                        let title = parsed["title"].as_str().unwrap_or("").trim();
                        let task = parsed["task"].as_str().unwrap_or("").trim();
                        if delegated >= 4 || title.is_empty() || title.len() > 240 || task.is_empty() || task.len() > 32768 {
                            serde_json::json!({"error":"Provide a short title and a concrete task; maximum four subagents per turn."})
                        } else {
                            delegated += 1;
                            static SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
                            let agent_id = format!("agent-{}-{}",crate::data::now_millis(),SEQUENCE.fetch_add(1,std::sync::atomic::Ordering::Relaxed));
                            let mut running = serde_json::json!({"id":agent_id,"title":title,"task":task,"summary":truncate(task,160),"status":"running","model":self.model,"started_at":crate::data::now_millis()});
                            let cancellation=self.runtime.as_ref().map(|r|r.start(&agent_id));
                            (self.agents)(running.clone());
                            let mut child_history = context.clone();
                            child_history.push(serde_json::json!({"role":"system","content":"You are the delegated subagent. Complete the assigned task directly. You may use the authorized project tools. Further delegation is unavailable. Return your findings to the parent."}));
                            child_history.push(serde_json::json!({"role":"user","content":task}));
                            let child_result=if let Some(cancellation)=cancellation {
                                cancellation.run(self.run(child_history,false,Some(&running))).await.and_then(|r|r)
                            } else {self.run(child_history,false,Some(&running)).await};
                            if let Some(runtime)=&self.runtime {runtime.finish(&agent_id);}
                            match child_result {
                                Ok((result, child_usage)) => {
                                    usage.prompt_tokens += child_usage.prompt_tokens;usage.completion_tokens += child_usage.completion_tokens;usage.total_tokens += child_usage.total_tokens;
                                    running["status"] = serde_json::json!("completed");running["summary"] = serde_json::json!(truncate(&result,180));running["content"] = serde_json::json!(result);
                                    running["finished_at"] = serde_json::json!(crate::data::now_millis());
                                    (self.agents)(running);
                                    serde_json::json!({"agent_id":agent_id,"result":result})
                                }
                                Err(error) => {
                                    running["status"] = serde_json::json!(if error=="agent_cancelled" {"cancelled"} else {"failed"});running["summary"] = serde_json::json!(error);if error!="agent_cancelled" {running["content"] = serde_json::json!(error);}
                                    running["finished_at"] = serde_json::json!(crate::data::now_millis());
                                    (self.agents)(running);serde_json::json!({"agent_id":agent_id,"error":error})
                                }
                            }
                        }
                    } else if let Some(files) = self.project.as_ref().filter(|_| matches!(name,"list_project_skills"|"load_project_skill"|"read_project_file"|"list_project_files"|"write_project_file"|"edit_project_file"|"execute_project_command"|"inspect_project_command")) {
                        let path = parsed["path"].as_str().unwrap_or(".");(self.activity)(name,path);
                        let mut files = files.clone();
                        if let (Some(agent),Some(execution))=(agent,files.execution.as_mut()) {execution.agent_id=agent["id"].as_str().map(String::from);execution.cancellation=execution.agent_id.as_ref().and_then(|id|{use tauri::Manager;execution.app.state::<crate::agent_runs::AgentRuns>().token(id)});}
                        let action = name.to_string();let arguments = arguments.to_string();
                        tauri::async_runtime::spawn_blocking(move || files.execute(&action,&arguments)).await.map_err(|e|e.to_string())?
                    } else {serde_json::json!({"error":"Tool unavailable for this task"})};
                    finish_tool_event(&mut tool_event, &result);tool_progress(&tool_event);
                    history.push(serde_json::json!({"role":"tool","tool_call_id":id,"content":result.to_string()}));
                }
            }
        })
    }
}

fn finish_tool_event(event: &mut serde_json::Value, result: &serde_json::Value) {
    let status = if result.get("error").is_some() {"failed"} else {
        match result["status"].as_str() {
            Some(status @ ("running" | "stopping" | "failed" | "cancelled")) => status,
            _ => "completed",
        }
    };
    event["status"] = serde_json::json!(status);
    if matches!(event["action"].as_str(), Some("execute_project_command" | "inspect_project_command")) && result["id"].is_string() {
        event["shell_id"] = result["id"].clone();
    }
    event["output"] = serde_json::json!(result.to_string());
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn missing_project_or_folder_consent_never_advertises_file_tools() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            for project in [false, true] {
                let (mut socket, _) = listener.accept().unwrap();
                socket.set_read_timeout(Some(std::time::Duration::from_secs(10))).unwrap();
                let mut bytes = Vec::new();
                let mut buffer = [0; 4096];
                let body = loop {
                    let count = socket.read(&mut buffer).unwrap();assert!(count > 0);
                    bytes.extend_from_slice(&buffer[..count]);
                    if let Some(end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                        let headers = String::from_utf8_lossy(&bytes[..end]).to_lowercase();
                        let length: usize = headers.lines().find_map(|line| line.strip_prefix("content-length:")).unwrap().trim().parse().unwrap();
                        if bytes.len() >= end + 4 + length {
                            break serde_json::from_slice::<serde_json::Value>(&bytes[end+4..end+4+length]).unwrap();
                        }
                    }
                };
                let tools = body["tools"].as_array().unwrap();
                assert_eq!(tools.len(), 1);assert_eq!(tools[0]["function"]["name"], "create_subagent");
                let history = body["messages"].to_string();
                assert!(history.contains(if project { "Modifica progetto" } else { "This chat has no project" }));
                assert!(!history.contains("Project-local skills are available"));
                let response = serde_json::json!({"choices":[{"message":{"role":"assistant","content":"Authorize the folder first."}}]}).to_string();
                write!(socket, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{response}", response.len()).unwrap();
            }
        });
        let messages: Vec<ChatMessage> = serde_json::from_value(serde_json::json!([{"role":"user","content":"Read my vault."}])).unwrap();
        for project in [None, Some(crate::project_files::ProjectFiles {name:"Vault".into(),roots:vec![],unavailable:vec!["C:\\Notes".into()],execution:None})] {
            let result = tauri::async_runtime::block_on(chat_completion(&reqwest::Client::new(), &format!("http://{address}"), "test", "test", &messages, project, None, |_, _| {}, |_| {})).unwrap();
            assert_eq!(result.0, "Authorize the folder first.");
        }
        server.join().unwrap();
    }

    #[test]
    fn command_activity_preserves_process_status_and_shell_identity() {
        for action in ["execute_project_command", "inspect_project_command"] {
            for status in ["running", "stopping", "completed", "failed", "cancelled"] {
                let mut event = serde_json::json!({"action":action,"status":"running"});
                let result = serde_json::json!({"id":"shell-test","status":status});
                finish_tool_event(&mut event, &result);
                assert_eq!(event["status"], status);assert_eq!(event["shell_id"], "shell-test");
                assert_eq!(event["output"], result.to_string());
            }
        }
        let mut event = serde_json::json!({"action":"read_project_file"});
        finish_tool_event(&mut event, &serde_json::json!({"content":"text"}));assert_eq!(event["status"], "completed");
        finish_tool_event(&mut event, &serde_json::json!({"error":"denied","status":"running"}));assert_eq!(event["status"], "failed");
        assert!(event.get("shell_id").is_none());
    }
    #[test]
    fn delegated_agent_reads_real_files_and_preserves_reasoning_across_tool_rounds() {
        use std::io::{Read,Write};
        let root=std::env::temp_dir().join(format!("aurachat-agent-{}",crate::data::now_millis()));std::fs::create_dir(&root).unwrap();std::fs::write(root.join("note.txt"),"AGENT_FIXTURE").unwrap();
        let listener=std::net::TcpListener::bind("127.0.0.1:0").unwrap();let address=listener.local_addr().unwrap();
        let server=std::thread::spawn(move || {
            for round in 0..4 {
                let (mut socket,_)=listener.accept().unwrap();socket.set_read_timeout(Some(std::time::Duration::from_secs(10))).unwrap();
                let mut bytes=Vec::new();let mut buffer=[0;4096];
                let body=loop {
                    let count=socket.read(&mut buffer).unwrap();assert!(count>0);bytes.extend_from_slice(&buffer[..count]);
                    if let Some(end)=bytes.windows(4).position(|w|w==b"\r\n\r\n"){
                        let headers=String::from_utf8_lossy(&bytes[..end]).to_lowercase();let length:usize=headers.lines().find_map(|l|l.strip_prefix("content-length:")).unwrap().trim().parse().unwrap();
                        if bytes.len()>=end+4+length {break serde_json::from_slice::<serde_json::Value>(&bytes[end+4..end+4+length]).unwrap();}
                    }
                };
                for name in ["read_project_file", "list_project_files", "write_project_file", "edit_project_file", "execute_project_command"] {
                    assert!(body["tools"].as_array().unwrap().iter().any(|tool|tool["function"]["name"]==name));
                }
                if round==1 || round==2 {assert!(!body["tools"].as_array().unwrap().iter().any(|t|t["function"]["name"]=="create_subagent"));}
                let message=match round {
                    0=>serde_json::json!({"role":"assistant","content":null,"tool_calls":[{"id":"delegate","type":"function","function":{"name":"create_subagent","arguments":serde_json::json!({"title":"Inspect fixture","task":"Read note.txt and report its token."}).to_string()}}]}),
                    1=>serde_json::json!({"role":"assistant","content":"Checking. ","reasoning_content":"First reasoning. ","tool_calls":[{"id":"read","type":"function","function":{"name":"read_project_file","arguments":"{\"root\":0,\"path\":\"note.txt\"}"}}]}),
                    2=>{assert!(body["messages"].as_array().unwrap().last().unwrap()["content"].as_str().unwrap().contains("AGENT_FIXTURE"));serde_json::json!({"role":"assistant","reasoning_content":"Second reasoning.","content":"AGENT_FIXTURE verified"})},
                    _=>{assert!(body["messages"].as_array().unwrap().last().unwrap()["content"].as_str().unwrap().contains("AGENT_FIXTURE verified"));serde_json::json!({"role":"assistant","content":"Delegation completed"})}
                };
                let response=serde_json::json!({"choices":[{"message":message}],"usage":{"total_tokens":1}}).to_string();
                write!(socket,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{response}",response.len()).unwrap();
            }
        });
        let events=std::sync::Mutex::new(Vec::new());let tools=std::sync::Mutex::new(Vec::new());
        let messages:Vec<ChatMessage>=serde_json::from_value(serde_json::json!([{"role":"user","content":"Create a subagent to read the fixture."}])).unwrap();
        let result=tauri::async_runtime::block_on(chat_completion(&reqwest::Client::new(),&format!("http://{address}"),"test","test",&messages,Some(crate::project_files::ProjectFiles{name:"Test".into(),roots:vec![root.clone()],unavailable:vec![],execution:None}),None,
            |kind,text|{if kind=="__activity"{tools.lock().unwrap().push(serde_json::from_str::<serde_json::Value>(text).unwrap());}},|event|events.lock().unwrap().push(event))).unwrap();
        server.join().unwrap();assert_eq!(result.0,"Delegation completed");assert_eq!(result.1.total_tokens,4);
        let events=events.into_inner().unwrap();assert_eq!(events.last().unwrap()["status"],"completed");
        let complete=events.iter().rev().find(|e|e["reasoning_content"]=="First reasoning. Second reasoning.").unwrap();assert_eq!(complete["content"],"Checking. AGENT_FIXTURE verified");
        assert_eq!(complete["activity"][0]["status"],"completed");assert!(tools.into_inner().unwrap().iter().all(|e|e["action"]=="create_subagent"));
        std::fs::remove_file(root.join("note.txt")).unwrap();std::fs::remove_dir(root).unwrap();
    }
    #[test]
    fn http_stream_handles_fragmented_unicode_and_tool_rounds() {
        use std::io::{Read, Write};
        let root = std::env::temp_dir().join(format!("aurachat-stream-{}", crate::data::now_millis()));
        std::fs::create_dir(&root).unwrap();std::fs::write(root.join("notes.md"), "Verified").unwrap();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            for turn in 0..2 {
                let (mut connection, _) = listener.accept().unwrap();
                connection.set_read_timeout(Some(std::time::Duration::from_secs(10))).unwrap();
                let mut request = Vec::new();let mut buffer = [0;4096];
                loop {
                    let count = connection.read(&mut buffer).unwrap();assert!(count > 0);request.extend_from_slice(&buffer[..count]);
                    if let Some(end) = request.windows(4).position(|part| part == b"\r\n\r\n") {
                        let headers = String::from_utf8_lossy(&request[..end]).to_lowercase();
                        let length:usize = headers.lines().find_map(|line|line.strip_prefix("content-length:")).unwrap().trim().parse().unwrap();
                        if request.len() >= end+4+length {
                            let body:serde_json::Value = serde_json::from_slice(&request[end+4..]).unwrap();assert_eq!(body["stream"],true);
                            if turn == 1 {assert!(body["messages"].as_array().unwrap().iter().any(|m|m["role"] == "tool" && m["content"].as_str().unwrap().contains("Verified")));}
                            break;
                        }
                    }
                }
                let events = if turn == 0 { vec![
                    serde_json::json!({"choices":[{"delta":{"reasoning_content":"Verifico il file."}}]}),
                    serde_json::json!({"choices":[{"delta":{"content":"Controllo 🦀. "}}]}),
                    serde_json::json!({"choices":[{"delta":{"tool_calls":[{"index":0,"id":"one","type":"function","function":{"name":"read_project_file","arguments":"{\"root\":0,"}}]}}]}),
                    serde_json::json!({"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"path\":\"notes.md\"}"}}]},"finish_reason":"tool_calls"}]}),
                ] } else { vec![serde_json::json!({"choices":[{"delta":{"content":"Fatto."},"finish_reason":"stop"}],"usage":{"total_tokens":42}})] };
                let payload = events.iter().map(|event|format!("data: {event}\r\n\r\n")).collect::<String>() + "data: [DONE]\r\n\r\n";
                write!(connection,"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",payload.len()).unwrap();
                for part in payload.as_bytes().chunks(3) {connection.write_all(part).unwrap();connection.flush().unwrap();}
            }
        });
        let events = std::sync::Mutex::new(Vec::new());
        let messages:Vec<ChatMessage> = serde_json::from_str(r#"[{"role":"user","content":"Read notes"}]"#).unwrap();
        let (reply,usage) = tauri::async_runtime::block_on(chat_completion(&reqwest::Client::new(),&format!("http://{address}"),"test","test",&messages,
            Some(crate::project_files::ProjectFiles{name:"Test".into(),roots:vec![root.clone()],unavailable:vec![],execution:None}),None,
            |kind,text|events.lock().unwrap().push((kind.to_string(),text.to_string())), |_|{})).unwrap();
        server.join().unwrap();assert_eq!(reply,"Controllo 🦀. Fatto.");assert_eq!(usage.total_tokens,42);
        let events = events.into_inner().unwrap();
        assert_eq!(events.iter().filter(|e|e.0 == "__delta").map(|e|e.1.as_str()).collect::<String>(),reply);
        let tool_events = events.iter().filter(|e|e.0 == "__activity").map(|e|serde_json::from_str::<serde_json::Value>(&e.1).unwrap()).collect::<Vec<_>>();
        assert_eq!(tool_events.len(),2);assert_eq!(tool_events[0]["status"],"running");assert_eq!(tool_events[1]["status"],"completed");
        std::fs::remove_file(root.join("notes.md")).unwrap();std::fs::remove_dir(root).unwrap();
    }

    #[test]
    fn stream_reassembles_reasoning_tool_arguments_usage_and_errors() {
        let events = std::sync::Mutex::new(Vec::new());
        let callback = |kind: &str, text: &str| events.lock().unwrap().push((kind.to_string(), text.to_string()));
        let mut response = StreamResponse::default();
        for value in [
            serde_json::json!({"choices":[{"delta":{"reasoning_content":"Controllo il file…"}}]}),
            serde_json::json!({"choices":[{"delta":{"content":"Leggo 🦀. "}}]}),
            serde_json::json!({"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read_project_file","arguments":"{\"root\":0,"}}]}}]}),
            serde_json::json!({"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"path\":\"notes.md\"}"}}]},"finish_reason":"tool_calls"}]}),
            serde_json::json!({"choices":[],"usage":{"total_tokens":42}}),
        ] {
            response.line(format!("data: {value}\r\n").as_bytes(), &callback).unwrap();
        }
        assert!(response.finished);
        let value = response.value();
        let message = &value["choices"][0]["message"];
        assert_eq!(message["content"], "Leggo 🦀. ");
        assert_eq!(message["reasoning_content"], "Controllo il file…");
        assert_eq!(message["tool_calls"][0]["function"]["arguments"], r#"{"root":0,"path":"notes.md"}"#);
        assert_eq!(value["usage"]["total_tokens"], 42);
        assert_eq!(events.lock().unwrap().len(), 2);
        let mut bad = StreamResponse::default();
        assert!(bad.line(b"data: {\"error\":{\"message\":\"failed\"}}\n", &callback).is_err());
        assert!(bad.line(b"data: invalid\n", &callback).is_err());
        assert!(!bad.finished);
    }

    #[test]
    fn activity_survives_storage_without_entering_provider_history() {
        let message: ChatMessage = serde_json::from_value(serde_json::json!({"role":"assistant","content":"Done","activity":[
            {"kind":"reasoning","text":"Checking files","offset":0},
            {"kind":"tool","id":"call_1","action":"read_project_file","status":"completed","output":"file content","offset":0}
        ]})).unwrap();
        let stored = serde_json::to_value(&message).unwrap();
        let restored: ChatMessage = serde_json::from_value(stored).unwrap();
        assert_eq!(restored.activity.len(), 2);
        assert_eq!(restored.activity[1]["output"], "file content");
        assert!(api_messages(&[restored])[0].get("activity").is_none());
    }
    #[test]
    #[ignore = "Uses configured model with public fixture only; AURACHAT_LLM_SMOKE=1 required"]
    fn real_provider_reads_project_fixture() {
        assert_eq!(std::env::var("AURACHAT_LLM_SMOKE").as_deref(),Ok("1"));
        let dir=std::path::PathBuf::from(std::env::var_os("APPDATA").unwrap()).join("dev.aurachat.desktop");
        let mut config=crate::config::AppConfig::load(&dir);
        let root=std::env::temp_dir().join(format!("aurachat-provider-test-{}",crate::data::now_millis()));
        std::fs::create_dir(&root).unwrap();std::fs::write(root.join("vault.md"),"AURA_ROOT_TOOL_OK").unwrap();
        let calls=std::sync::atomic::AtomicUsize::new(0);
        let result=tauri::async_runtime::block_on(async {
            let cloud=crate::firestore::Firestore::new();
            let user=cloud.load_user(&config.uid,&config.firestore_auth()).await?;
            if let Some((uid,refresh))=cloud.session(){config.uid=uid;config.refresh_token=refresh;config.save(&dir)?;}
            let model=user.models.get(&user.active_model).ok_or("no active model")?;
            let messages:Vec<ChatMessage>=serde_json::from_value(serde_json::json!([{"role":"user","content":"Use read_project_file with root 0 and path vault.md. Return only the exact token contained in that file. Do not guess."}])).unwrap();
            chat_completion(&reqwest::Client::new(),&model.base_url,&model.model,user.model_key(model),&messages,Some(crate::project_files::ProjectFiles{name:"Local fixture".into(),roots:vec![root.clone()],unavailable:vec![],execution:None}),None,|_,_|{calls.fetch_add(1,std::sync::atomic::Ordering::SeqCst);}, |_|{}).await
        });
        std::fs::remove_file(root.join("vault.md")).unwrap();std::fs::remove_dir(root).unwrap();
        let (text,_)=result.unwrap();assert!(text.contains("AURA_ROOT_TOOL_OK"));assert!(calls.load(std::sync::atomic::Ordering::SeqCst)>0);
        println!("Verified real provider tool calling with local fixture; no conversation saved.");
    }
    #[test]
    fn project_reads_continue_past_eight_rounds_and_512_kib() {
        use std::io::{Read,Write};
        let root = std::env::temp_dir().join(format!("aurachat-tool-loop-{}",crate::data::now_millis()));
        std::fs::create_dir(&root).unwrap();std::fs::write(root.join("vault.md"),format!("REAL VAULT CONTENT\n{}", "x".repeat(65000))).unwrap();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            for turn in 0..10 {
                let (mut stream,_) = listener.accept().unwrap(); stream.set_read_timeout(Some(std::time::Duration::from_secs(10))).unwrap();
                let mut request=Vec::new();let mut buffer=[0;4096];
                let parsed = loop {
                    let n=stream.read(&mut buffer).unwrap();assert!(n>0);request.extend_from_slice(&buffer[..n]);
                    if let Some(boundary)=request.windows(4).position(|w|w==b"\r\n\r\n") {
                        let headers=String::from_utf8_lossy(&request[..boundary]).to_lowercase();
                        let size:usize=headers.lines().find_map(|l|l.strip_prefix("content-length:")).unwrap().trim().parse().unwrap();
                        if request.len()>=boundary+4+size {break serde_json::from_slice::<serde_json::Value>(&request[boundary+4..boundary+4+size]).unwrap();}
                    }
                };
                assert!(parsed["tools"].as_array().unwrap().iter().any(|t|t["function"]["name"]=="list_project_files"));
                let message=if turn<9 {serde_json::json!({"role":"assistant","content":null,"tool_calls":[{"id":"call1","type":"function","function":{"name":"read_project_file","arguments":"{\"root\":0,\"path\":\"vault.md\"}"}}]})}
                    else {assert!(parsed["messages"].as_array().unwrap().last().unwrap()["content"].as_str().unwrap().contains("REAL VAULT CONTENT"));serde_json::json!({"role":"assistant","content":"I read vault.md"})};
                let response=serde_json::json!({"choices":[{"message":message}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}).to_string();
                write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{}",response.len(),response).unwrap();
            }
        });
        let messages:Vec<ChatMessage>=serde_json::from_str(r#"[{"role":"user","content":"Read the vault"}]"#).unwrap();
        let result=tauri::async_runtime::block_on(chat_completion(&reqwest::Client::new(),&format!("http://{address}"),"test","test",&messages,Some(crate::project_files::ProjectFiles{name:"Test".into(),roots:vec![root.clone()],unavailable:vec![],execution:None}),None,|_,_|{}, |_|{})).unwrap();
        assert_eq!(result.0,"I read vault.md");assert_eq!(result.1.total_tokens,150);server.join().unwrap();
        std::fs::remove_file(root.join("vault.md")).unwrap();std::fs::remove_dir(root).unwrap();
    }
    #[test]
    fn edit_and_retry_prepare_history_without_mutating_saved_messages() {
        let saved:Vec<ChatMessage> = serde_json::from_str(r#"[{"role":"user","content":"original"},{"role":"assistant","content":"answer"},{"role":"user","content":"follow up"},{"role":"assistant","content":"latest"}]"#).unwrap();
        let (history,user,keep)=prepare_turn(&saved,String::new(),vec![],true,None).unwrap();
        assert_eq!(keep,2);assert_eq!(history.len(),3);assert_eq!(user.content,"follow up");
        let (edited,user,keep)=prepare_turn(&saved,"edited".into(),vec![],false,Some(0)).unwrap();
        assert_eq!(keep,0);assert_eq!(edited.len(),1);assert_eq!(user.content,"edited");
        assert_eq!(saved.len(),4);assert_eq!(saved[0].content,"original");
        assert!(prepare_turn(&saved,"x".into(),vec![],false,Some(1)).is_err());
        assert!(prepare_turn(&saved,"x".into(),vec![],false,Some(40)).is_err());
        assert!(prepare_turn(&[],String::new(),vec![],true,None).is_err());
    }

    #[test]
    fn attachment_limits_and_provider_payload() {
        let files = vec![Attachment { name:"notes.md".into(), content:"kept".into() }];
        assert!(validate_attachments(&files).is_ok());
        assert!(validate_attachments(&vec![files[0].clone();5]).is_err());
        assert!(validate_attachments(&[Attachment {name:"large.txt".into(),content:"x".repeat(131073)}]).is_err());
        let messages = [ChatMessage {role:"user".into(),content:"Summarize".into(),attachments:files,feedback:Some(true),activity:vec![]}];
        let payload = api_messages(&messages);
        assert_eq!(payload[0].as_object().unwrap().len(),2);
        assert!(payload[0]["content"].as_str().unwrap().contains("notes.md"));
        let legacy:ChatMessage = serde_json::from_str(r#"{"role":"assistant","content":"old"}"#).unwrap();
        assert!(legacy.attachments.is_empty());assert!(legacy.feedback.is_none());
    }
}
