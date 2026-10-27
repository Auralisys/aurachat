use std::{collections::HashMap, sync::{Arc, Mutex}, task::{Poll, Waker}};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{Emitter, Manager};

#[derive(Clone, Deserialize, Serialize)]
pub struct Step {
    pub current: u32,
    pub total: u32,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct Question {
    #[serde(default)]
    pub question: String,
    #[serde(default)]
    pub choices: Vec<String>,
    #[serde(default)]
    pub multi_select: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub step: Option<Step>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub questions: Vec<Question>,
}

fn plain_dashes(text: &str) -> String {text.replace(['\u{2014}','\u{2013}','\u{2015}'], "-")}

/// Reverses the UTF-8 -> Latin-1 double-encoding the model occasionally emits in
/// tool-call arguments (e.g. "giÃ " for "già", "â‚¬" for "€"). It runs before the
/// form is shown and before the mobile relay, so desktop and companion both get
/// the intended text.
fn repair_mojibake(text: &str) -> String {
    let mut bytes = Vec::with_capacity(text.len());
    for ch in text.chars() {
        if (ch as u32) > 0xFF { return text.to_string(); }
        bytes.push(ch as u8);
    }
    match String::from_utf8(bytes) {
        Ok(fixed) if fixed != text => fixed,
        _ => text.to_string(),
    }
}

impl Question {
    // Long dashes read poorly in the form and the answer summary; use a plain hyphen.
    fn normalize(&mut self) {
        self.question = plain_dashes(&repair_mojibake(&self.question));
        for choice in &mut self.choices {*choice = plain_dashes(&repair_mojibake(choice));}
        for question in &mut self.questions {question.normalize();}
    }

    fn validate(&self) -> Result<(), String> {
        if !self.questions.is_empty() {
            if self.questions.len() > 12 || !self.question.is_empty() || !self.choices.is_empty() || self.multi_select || self.step.is_some() ||
                self.questions.iter().any(|q|!q.questions.is_empty()) {
                return Err("Provide either one question or a flat batch of up to twelve questions, not both.".into());
            }
            for question in &self.questions {question.validate()?;}
            return Ok(());
        }
        if self.question.trim().is_empty() || self.question.len() > 4000 || self.choices.len() > 8 ||
            self.choices.iter().enumerate().any(|(i, choice)| choice.trim().is_empty() || choice.len() > 500 || self.choices[..i].contains(choice)) {
            return Err("Provide a question and up to eight distinct, nonempty choices.".into());
        }
        if self.step.as_ref().is_some_and(|step| step.current == 0 || step.total == 0 || step.current > step.total) {
            return Err("Question step must satisfy 1 <= current <= total. Omit step for a standalone question or when the total is unknown.".into());
        }
        Ok(())
    }
}

#[derive(Clone, Deserialize, Serialize)]
pub struct Answer {
    pub action: String,
    #[serde(default)]
    pub selected: Vec<String>,
    #[serde(default)]
    pub custom: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub answers: Vec<Answer>,
}

impl Answer {
    fn validate(&self, question: &Question) -> Result<(), String> {
        if !question.questions.is_empty() {
            if !matches!(self.action.as_str(),"answer"|"discuss"|"cancel") || !self.selected.is_empty() || !self.custom.is_empty() ||
                self.answers.len() > question.questions.len() || (self.action=="answer" && self.answers.len()!=question.questions.len()) ||
                (self.action=="discuss" && self.answers.last().is_none_or(|a|a.action!="discuss")) {
                return Err("invalid_question_answer".into());
            }
            for (index, answer) in self.answers.iter().enumerate() {
                if matches!(answer.action.as_str(),"discuss"|"cancel") && (index+1!=self.answers.len() || answer.action!=self.action) {return Err("invalid_question_answer".into());}
                answer.validate(&question.questions[index])?;
            }
            return Ok(());
        }
        if !self.answers.is_empty() || !matches!(self.action.as_str(), "answer" | "discuss" | "skip" | "cancel") || self.custom.len() > 16000 ||
            self.selected.iter().enumerate().any(|(i, choice)| !question.choices.contains(choice) || self.selected[..i].contains(choice)) ||
            (!question.multi_select && self.selected.len() > 1) ||
            (self.action != "answer" && !self.selected.is_empty()) ||
            (matches!(self.action.as_str(),"skip"|"cancel") && !self.custom.is_empty()) ||
            (self.action == "answer" && self.selected.is_empty() && self.custom.trim().is_empty()) {
            return Err("invalid_question_answer".into());
        }
        Ok(())
    }
}

#[derive(Clone, Serialize)]
pub struct Snapshot {
    pub id: String,
    pub conversation_id: String,
    pub agent_id: Option<String>,
    pub created_at: u64,
    #[serde(flatten)]
    pub question: Question,
    pub status: String,
}

#[derive(Default)]
struct Response { answer: Option<Answer>, waker: Option<Waker> }
struct Entry { owner: String, snapshot: Snapshot, response: Arc<Mutex<Response>> }
#[derive(Default)]
pub struct Questions(Mutex<HashMap<String, Entry>>);

impl Questions {
    fn begin(&self, owner: &str, conversation: &str, agent_id: Option<String>, mut question: Question) -> Result<(Snapshot, Arc<Mutex<Response>>), String> {
        question.normalize();
        question.validate()?;
        static SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let snapshot = Snapshot {
            id: format!("question-{}", SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed)),
            conversation_id: conversation.into(), agent_id, created_at: crate::data::now_millis(), question, status: "pending".into(),
        };
        let response = Arc::new(Mutex::new(Response::default()));
        self.0.lock().unwrap().insert(snapshot.id.clone(), Entry {owner:owner.into(),snapshot:snapshot.clone(),response:response.clone()});
        Ok((snapshot, response))
    }

    pub fn list(&self, owner: &str, conversation: &str) -> Vec<Snapshot> {
        let mut items: Vec<_> = self.0.lock().unwrap().values().filter(|entry| entry.owner == owner && entry.snapshot.conversation_id == conversation).map(|entry|entry.snapshot.clone()).collect();
        items.sort_by(|a,b|a.id.cmp(&b.id));items
    }

    pub fn resolve(&self, owner: &str, conversation: &str, id: &str, answer: Answer) -> Result<Snapshot, String> {
        let mut entries = self.0.lock().unwrap();
        let entry = entries.get(id).filter(|entry| entry.owner == owner && entry.snapshot.conversation_id == conversation).ok_or("question_not_found")?;
        answer.validate(&entry.snapshot.question)?;
        let entry = entries.remove(id).unwrap();
        let mut response = entry.response.lock().unwrap();
        response.answer = Some(answer);
        if let Some(waker) = response.waker.take() {waker.wake();}
        Ok(Snapshot {status:"answered".into(),..entry.snapshot})
    }

    fn cancel(&self, id: &str) -> Option<Snapshot> {
        self.0.lock().unwrap().remove(id).map(|entry|Snapshot {status:"cancelled".into(),..entry.snapshot})
    }
}

// Dropping a stopped/failed turn also retracts its unanswered form.
struct Pending { app: tauri::AppHandle, id: String }
impl Drop for Pending {
    fn drop(&mut self) {
        if let Some(snapshot) = self.app.state::<Questions>().cancel(&self.id) {
            let _ = self.app.emit("question-activity", snapshot);
        }
    }
}

pub async fn ask(runtime: &crate::agent_runs::Runtime, agent_id: Option<String>, arguments: &str) -> Result<Value, String> {
    let question: Question = serde_json::from_str(arguments).map_err(|_|"invalid question arguments")?;
    let registry = runtime.app.state::<Questions>();
    let (snapshot, response) = registry.begin(&runtime.owner, &runtime.conversation, agent_id, question)?;
    let _pending = Pending {app:runtime.app.clone(),id:snapshot.id.clone()};
    runtime.app.emit("question-activity", &snapshot).map_err(|error|error.to_string())?;
    let answer = std::future::poll_fn(|cx| {
        let mut response = response.lock().unwrap();
        if let Some(answer) = response.answer.take() {Poll::Ready(answer)}
        else {response.waker = Some(cx.waker().clone());Poll::Pending}
    }).await;
    let questions = if snapshot.question.questions.is_empty() {vec![snapshot.question.clone()]} else {snapshot.question.questions.clone()};
    let answers = if snapshot.question.questions.is_empty() {vec![answer.clone()]} else {answer.answers.clone()};
    let responses: Vec<_> = questions.iter().zip(&answers).map(|(question,answer)|json!({"question":question.question,"answer":answer})).collect();
    Ok(json!({"answer":answer,"responses":responses,"step":snapshot.question.step,"instruction":if answer.action == "discuss" {
        "The user chose to discuss, not to authorize a choice. Pause the planned action, discuss the alternatives, and ask again only after clarifying. Keep the same step when re-asking; discussion does not complete a step."
    } else if answer.action == "cancel" {
        "The user closed the questionnaire. Stop this sequence. Only the listed responses were supplied; unanswered questions are not approved."
    } else {"Use this explicit user response. It grants no additional filesystem or command permissions."}}))
}

pub fn definition() -> Value {
    let fields=json!({"question":{"type":"string"},"choices":{"type":"array","items":{"type":"string"},"maxItems":8},"multi_select":{"type":"boolean"}});
    let mut properties=fields.clone();
    properties["questions"]=json!({"type":"array","minItems":1,"maxItems":12,"items":{"type":"object","properties":fields,"required":["question"],"additionalProperties":false}});
    properties["step"]=json!({"type":"object","properties":{"current":{"type":"integer","minimum":1},"total":{"type":"integer","minimum":1}},"required":["current","total"],"additionalProperties":false});
    json!({"type":"function","function":{"name":"ask_user","description":"Ask interactive questions. For multiple questions already known, send ONE call with questions:[{question,choices,multi_select},...], up to twelve. The UI moves between questions locally, supports Back/Next, and returns one batch of question/answer pairs only on final submission (or partial answers on Discuss/close). Do not call the model between independent questions. For a genuinely dependent question whose options require the previous answer, use a separate single question and optional step:{current,total}. Use either questions or question, never both. UI supplies custom answers, Skip, Discuss and close; do not duplicate these in choices. Skips and missing answers are not approval.","parameters":{"type":"object","properties":properties,"additionalProperties":false}}})
}

pub fn summary(result: &Value) -> Option<String> {
    let responses=result["responses"].as_array()?;
    let entries:Vec<_>=responses.iter().map(|response| {
        let answer=&response["answer"];
        let mut text:Vec<_>=answer["selected"].as_array().into_iter().flatten().filter_map(|value|value.as_str()).collect();
        if let Some(custom)=answer["custom"].as_str().filter(|s|!s.trim().is_empty()) {text.push(custom);}
        let value=if text.is_empty() {format!("[{}]",answer["action"].as_str().unwrap_or("skip"))} else {text.join("\n")};
        format!("{}\n{}",response["question"].as_str().unwrap_or(""),value)
    }).collect();
    if entries.is_empty() {Some(format!("[{}]",result["answer"]["action"].as_str().unwrap_or("cancel")))}
    else {Some(entries.join("\n\n"))}
}

#[cfg(test)]
mod tests {
    use super::*;
    fn question(multi_select: bool) -> Question {Question {question:"Choose".into(),choices:vec!["A".into(),"B".into()],multi_select,step:None,questions:vec![]}}
    fn answer(selected: &[&str]) -> Answer {Answer {action:"answer".into(),selected:selected.iter().map(|s|s.to_string()).collect(),custom:String::new(),answers:vec![]}}
    #[test]
    fn validates_choices_custom_answers_and_discussion() {
        assert!(answer(&["A","B"]).validate(&question(false)).is_err());
        assert!(answer(&["A","B"]).validate(&question(true)).is_ok());
        for choices in [vec![],vec!["unknown"],vec!["A","A"]] {assert!(answer(&choices).validate(&question(true)).is_err());}
        assert!(Answer {custom:"My choice".into(),..answer(&[])}.validate(&question(false)).is_ok());
        assert!(Answer {action:"discuss".into(),..answer(&[])}.validate(&question(false)).is_ok());
        assert!(Answer {action:"discuss".into(),..answer(&["A"])}.validate(&question(false)).is_err());
        assert!(Question {choices:vec!["A".into(),"A".into()],..question(false)}.validate().is_err());
        assert!(Question {question:" ".into(),..question(false)}.validate().is_err());
    }
    #[test]
    fn answers_are_scoped_one_shot_and_wake_the_waiter() {
        let registry = Questions::default();
        let (snapshot, response) = registry.begin("u","c",None,question(true)).unwrap();
        assert!(registry.list("wrong","c").is_empty());
        assert!(registry.resolve("wrong","c",&snapshot.id,answer(&["A"])).is_err());
        assert!(registry.resolve("u","wrong",&snapshot.id,answer(&["A"])).is_err());
        assert!(registry.resolve("u","c",&snapshot.id,answer(&["unknown"])).is_err());
        assert_eq!(registry.list("u","c").len(),1);
        let (started, ready) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || tauri::async_runtime::block_on(std::future::poll_fn(|cx| {
            let mut state = response.lock().unwrap();
            if let Some(answer) = state.answer.take() {Poll::Ready(answer)} else {
                state.waker = Some(cx.waker().clone());let _ = started.send(());Poll::Pending
            }
        })));
        ready.recv_timeout(std::time::Duration::from_secs(2)).unwrap();
        registry.resolve("u","c",&snapshot.id,answer(&["A","B"])).unwrap();
        assert_eq!(worker.join().unwrap().selected,vec!["A","B"]);
        assert!(registry.list("u","c").is_empty());
        assert!(registry.resolve("u","c",&snapshot.id,answer(&["A"])).is_err());
    }
    #[test]
    fn long_dashes_become_plain_hyphens() {
        let registry = Questions::default();
        let batch:Question=serde_json::from_value(json!({"questions":[{"question":"Q4 \u{2014} Redo","choices":["A \u{2013} B"]}]})).unwrap();
        let (snapshot,_)=registry.begin("u","c",None,batch).unwrap();
        assert_eq!(snapshot.question.questions[0].question,"Q4 - Redo");
        assert_eq!(snapshot.question.questions[0].choices,vec!["A - B"]);
    }
    #[test]
    fn latin1_mojibake_in_questions_is_repaired() {
        assert_eq!(repair_mojibake("però"),"però");
        assert_eq!(repair_mojibake("café"),"café");
        assert_eq!(repair_mojibake("gi\u{00c3}\u{00a0} pagato?"),"già pagato?");
        assert_eq!(repair_mojibake("\u{00e2}\u{0082}\u{00ac}0"),"€0");
        let registry = Questions::default();
        let batch:Question=serde_json::from_value(json!({"question":"gi\u{00c3}\u{00a0} pagato?","choices":["\u{00e2}\u{0082}\u{00ac}0"]})).unwrap();
        let (snapshot,_)=registry.begin("u","c",None,batch).unwrap();
        assert_eq!(snapshot.question.question,"già pagato?");
        assert_eq!(snapshot.question.choices,vec!["€0"]);
    }
    #[test]
    fn cancelling_one_request_retracts_only_its_form() {
        let registry = Questions::default();
        let (first, _) = registry.begin("u","c",None,question(false)).unwrap();
        let (other, _) = registry.begin("u","other",Some("agent".into()),question(false)).unwrap();
        assert_eq!(registry.cancel(&first.id).unwrap().status,"cancelled");
        assert!(registry.list("u","c").is_empty());
        assert_eq!(registry.list("u","other")[0].id,other.id);
        assert!(registry.resolve("u","c",&first.id,answer(&["A"])).is_err());
        assert!(registry.cancel(&first.id).is_none());
    }
    #[test]
    fn steps_are_optional_validated_and_preserved_on_answers_and_discussion() {
        let legacy: Question = serde_json::from_value(json!({"question":"Standalone"})).unwrap();
        assert!(legacy.validate().is_ok());assert!(legacy.step.is_none());
        for (current,total) in [(0,3),(1,0),(4,3)] {
            let question = Question {step:Some(Step {current,total}),..question(false)};
            assert!(question.validate().is_err());
        }
        assert!(serde_json::from_value::<Question>(json!({"question":"Q","step":{"current":1}})).is_err());
        let registry = Questions::default();
        for current in 1..=3 {
            let (snapshot, _) = registry.begin("u","c",None,Question {step:Some(Step {current,total:3}),..question(false)}).unwrap();
            assert_eq!(serde_json::to_value(&registry.list("u","c")[0]).unwrap()["step"],json!({"current":current,"total":3}));
            let resolved = registry.resolve("u","c",&snapshot.id,answer(&["A"])).unwrap();
            assert_eq!(resolved.question.step.unwrap().current,current);
        }
        for _ in 0..2 {
            let (snapshot, _) = registry.begin("u","c",None,Question {step:Some(Step {current:2,total:3}),..question(false)}).unwrap();
            let resolved = registry.resolve("u","c",&snapshot.id,Answer {action:"discuss".into(),..answer(&[])}).unwrap();
            assert_eq!(resolved.question.step.unwrap().current,2);
        }
    }
        #[test]
        fn batches_require_complete_ordered_answers_but_allow_explicit_partial_exit() {
            let batch:Question=serde_json::from_value(json!({"questions":[{"question":"First","choices":["A"]},{"question":"Second","choices":["B"]}]})).unwrap();
            assert!(batch.validate().is_ok());
            let complete=Answer {answers:vec![answer(&["A"]),answer(&["B"])],..answer(&[])};
            assert!(complete.validate(&batch).is_ok());
            assert!(Answer {answers:vec![answer(&["B"]),answer(&["A"])],..answer(&[])}.validate(&batch).is_err());
            assert!(Answer {answers:vec![answer(&["A"])],..answer(&[])}.validate(&batch).is_err());
            assert!(Answer {action:"cancel".into(),answers:vec![answer(&["A"])],..answer(&[])}.validate(&batch).is_ok());
            assert!(Answer {action:"discuss".into(),answers:vec![answer(&["A"]),Answer {action:"discuss".into(),..answer(&[])}],..answer(&[])}.validate(&batch).is_ok());
            assert!(Answer {answers:vec![answer(&["A"]),Answer {action:"skip".into(),..answer(&[])}],..answer(&[])}.validate(&batch).is_ok());
            assert!(Question {question:"Ambiguous".into(),..batch.clone()}.validate().is_err());
            assert!(Question {questions:vec![batch],..question(false)}.validate().is_err());
            assert_eq!(summary(&json!({"responses":[{"question":"T1","answer":{"selected":["A"],"custom":"","action":"answer"}}]})).unwrap(),"T1\nA");
            assert!(summary(&json!({"error":"invalid"})).is_none());
        }
    #[test]
    fn batch_registry_stays_pending_until_one_valid_final_response() {
        let batch:Question=serde_json::from_value(json!({"questions":[{"question":"First","choices":["A"]},{"question":"Second"}]})).unwrap();
        let registry=Questions::default();
        let (snapshot,response)=registry.begin("owner","chat",None,batch).unwrap();
        assert!(registry.resolve("owner","chat",&snapshot.id,Answer {answers:vec![answer(&["A"])],..answer(&[])}).is_err());
        assert_eq!(registry.list("owner","chat").len(),1);
        assert!(response.lock().unwrap().answer.is_none());
        let custom="  CUSTOM-TEST-42 àèì 🐕  ";
        registry.resolve("owner","chat",&snapshot.id,Answer {answers:vec![answer(&["A"]),Answer {custom:custom.into(),..answer(&[])}],..answer(&[])}).unwrap();
        assert_eq!(response.lock().unwrap().answer.as_ref().unwrap().answers[1].custom,custom);
        assert!(registry.resolve("owner","chat",&snapshot.id,Answer {action:"cancel".into(),..answer(&[])}).is_err());
    }
}
