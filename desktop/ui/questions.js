const questionRequests = new Map();
const QUESTION_CUSTOM_LIMIT = 16000;

function questionRecord(conversationId) {
  const key = JSON.stringify([state.config.firebase_email, conversationId]);
  if (!questionRequests.has(key)) questionRequests.set(key, new Map());
  return questionRequests.get(key);
}

function pendingQuestions(conversationId) {
  return [...questionRecord(conversationId).values()].filter(item => item.status === 'pending');
}

function retainQuestion(item) {
  const record = questionRecord(item.conversation_id), previous = record.get(item.id);
  if (previous && previous.status !== 'pending' && item.status === 'pending') return;
  record.set(item.id, {...item, draft:previous?.draft || {index:0, answers:(item.questions || [item]).map(() => ({action:'answer',selected:[],custom:''}))}});
  if (item.status !== 'pending') cancelQuestionDictation(item.id);
}

// ===== Dictation in custom answers =====
// The pipeline is voice.js's field dictation. A target pins one step of one request: a transcript is
// inserted only while that request is still pending, into the draft even when its card is not on screen.
const questionVoiceMatcher = (id, index) => target => target.requestId === id && (index === undefined || target.index === index);
const questionDictationPhase = id => fieldVoicePhase(questionVoiceMatcher(id));
let questionWaveFrame = null;

function cancelQuestionDictation(id) {
  if (questionDictationPhase(id)) cancelFieldVoice(questionVoiceMatcher(id));
}

// A recording belongs to the card on screen; text that is already being transcribed still lands in the draft.
function dropQuestionRecording(id) {
  if (['preparing', 'recording'].includes(questionDictationPhase(id))) cancelFieldVoice(questionVoiceMatcher(id));
}

function questionCardFor(id) {
  return document.querySelector(`#question-requests [data-request-id="${CSS.escape(id)}"]`);
}

function questionVoiceTarget(item, index) {
  const live = () => questionRecord(item.conversation_id).get(item.id)?.status === 'pending';
  const field = () => {
    const form = questionCardFor(item.id);
    return form && Number(form.dataset.index) === index ? form.querySelector('textarea[name="custom"]') : null;
  };
  return fieldDictationTarget({
    requestId:item.id, index, valid:live,
    status(message) {
      const form = live() && questionCardFor(item.id), error = form && Number(form.dataset.index) === index && form.querySelector('.question-error');
      if (error) {error.textContent = message;error.hidden = !message;}
    }
  }, field, () => item.draft.answers[index].custom,
  text => {item.draft.answers[index].action = 'answer';item.draft.answers[index].custom = text;},
  QUESTION_CUSTOM_LIMIT, 'questions.dictation_limit');
}

function paintQuestionWave() {
  const canvas = $('#question-requests .annotator__voice.is-recording canvas');
  if (!canvas) {questionWaveFrame = null;return;}
  paintWave(canvas);
  questionWaveFrame = requestAnimationFrame(paintQuestionWave);
}

// Mirrors the shared dictation state onto the cards on screen; called by voiceUi() on every change.
function syncQuestionVoice() {
  const tray = $('#question-requests');
  if (!tray) return;
  const active = document.activeElement, blocker = fieldVoiceBlocker();
  const busy = blocker === 'loading' ? t('voice.loading_model') : t('questions.dictate_busy');
  let recording = false;
  for (const form of tray.querySelectorAll('.question-card')) {
    const mic = form.querySelector('.question-custom__mic'), strip = form.querySelector('.annotator__voice');
    const phase = fieldVoicePhase(questionVoiceMatcher(form.dataset.requestId, Number(form.dataset.index)));
    const was = form._voicePhase || null, ownsFocus = !!active && (mic.contains(active) || strip.contains(active));
    mic.hidden = !!phase;mic.disabled = !!blocker;
    mic.setAttribute('aria-label', blocker ? `${t('questions.dictate')}. ${busy}` : t('questions.dictate'));mic.title = blocker ? busy : t('questions.dictate');
    strip.hidden = !phase;
    strip.classList.toggle('is-recording', phase === 'recording');strip.classList.toggle('is-busy', !!phase && phase !== 'recording');
    const status = strip.querySelector('.annotator__voice-status');
    status.textContent = {preparing:voice.field?.message || t('voice.preparing'), recording:t('voice.recording'), transcribing:t('voice.transcribing'), queued:t('voice.queued')}[phase] || '';
    status.classList.toggle('sr-only', phase === 'recording');
    strip.querySelector('canvas').hidden = phase !== 'recording';
    strip.querySelector('.annotator__voice-stop').hidden = phase !== 'recording';
    // The control that had focus may have just been hidden: hand focus to what comes next.
    if (ownsFocus && phase !== was) {
      const next = phase === 'recording' ? strip.querySelector('.annotator__voice-stop')
        : phase === 'preparing' || (phase && was !== 'recording') ? strip.querySelector('.annotator__voice-cancel') : form.querySelector('textarea[name="custom"]');
      next.focus();
    }
    form._voicePhase = phase;form._updateSubmit?.();
    recording ||= phase === 'recording';
  }
  if (recording && !questionWaveFrame) paintQuestionWave();
  if (!recording) {cancelAnimationFrame(questionWaveFrame);questionWaveFrame = null;}
}

async function refreshQuestions(conversationId) {
  if (remoteTarget(conversationId)) return;
  const owner = state.config.firebase_email;
  try {
    const items = await invoke('list_questions', {conversation_id:conversationId});
    if (owner !== state.config.firebase_email || !Array.isArray(items)) return;
    for (const item of items) retainQuestion(item);
    if (state.activeConversationId === conversationId) renderQuestions();
  } catch (error) {
    if (owner === state.config.firebase_email && state.activeConversationId === conversationId) composerStatus(localizeError(error));
  }
}

function questionCard(item) {
  const form = document.createElement('form');form.className = 'approval-card question-card';form.dataset.requestId = item.id;
  const batch = Array.isArray(item.questions) && item.questions.length > 0;
  const questions = batch ? item.questions : [item];
  const index = item.draft.index, question = questions[index], draft = item.draft.answers[index];
  const header = document.createElement('div');header.className = 'question-header';
  const title = document.createElement('span');title.textContent = t('questions.title');
  const close = document.createElement('button');close.type = 'button';close.className = 'icon-button';close.setAttribute('aria-label',t('questions.close'));close.append(icon('close'));
  header.append(title, close);form.append(header);
  const step = batch ? {current:index+1,total:questions.length} : item.step;
  if (step) {
    const label = t('questions.step').replace('{current}', step.current).replace('{total}', step.total);
    const heading = document.createElement('div');heading.className = 'question-step';
    const text = document.createElement('span');text.textContent = label;
    const progress = document.createElement('progress');progress.max = step.total;progress.value = step.current;
    progress.setAttribute('aria-label', label);
    heading.append(text, progress);header.insertBefore(heading, close);
  }
  const fieldset = document.createElement('fieldset');
  const legend = document.createElement('legend');legend.textContent = question.question;
  const hint = document.createElement('p');hint.className = 'question-hint';hint.id = `${item.id}-hint`;
  hint.textContent = t(question.multi_select ? 'questions.multiple' : 'questions.single');
  fieldset.setAttribute('aria-describedby', hint.id);fieldset.append(legend, hint);
  for (const [choiceIndex, choice] of (question.choices || []).entries()) {
    const label = document.createElement('label');label.className = 'question-choice';
    const input = document.createElement('input');input.type = question.multi_select ? 'checkbox' : 'radio';input.name = 'choice';input.value = choice;
    const number = document.createElement('span');number.className = 'question-choice__number';number.textContent = String(choiceIndex+1);number.setAttribute('aria-hidden','true');
    const text = document.createElement('span');text.textContent = choice;
    input.checked = draft.selected.includes(choice);
    label.append(input, number, text);fieldset.append(label);
  }
  form.dataset.index = index;
  const customBox = document.createElement('div');customBox.className = 'question-custom';
  const customTitle = document.createElement('label');customTitle.textContent = t('questions.custom');customTitle.htmlFor = `${item.id}-custom-${index}`;
  const mic = document.createElement('button');mic.type = 'button';mic.className = 'icon-button question-custom__mic';mic.append(icon('mic'));
  mic.onclick = () => startFieldVoice(questionVoiceTarget(item, index));
  const customHead = document.createElement('div');customHead.className = 'question-custom__head';customHead.append(customTitle, mic);
  const custom = document.createElement('textarea');custom.id = customTitle.htmlFor;custom.name = 'custom';custom.rows = 1;custom.maxLength = QUESTION_CUSTOM_LIMIT;
  custom.placeholder = t('questions.custom_placeholder');custom.value = draft.custom;
  // Answering would drop a transcript that is still on its way: it has to finish or be cancelled first.
  const updateSubmit = () => {submit.disabled = (!draft.selected.length && !draft.custom.trim()) || !!questionDictationPhase(item.id);};
  form._updateSubmit = updateSubmit;
  fieldset.oninput = () => {
    draft.action = 'answer';
    draft.selected = [...fieldset.querySelectorAll('input:checked')].map(input => input.value);
    draft.custom = custom.value;
    updateSubmit();
  };
  customBox.append(customHead, custom, fieldVoiceStrip(() => cancelFieldVoice(questionVoiceMatcher(item.id, index))));fieldset.append(customBox);
  const error = document.createElement('p');error.className = 'question-error';error.setAttribute('role', 'alert');error.hidden = true;
  const actions = document.createElement('div');actions.className = 'approval-card__actions';
  const discuss = document.createElement('button');discuss.type = 'button';discuss.className = 'question-discuss';discuss.textContent = t('questions.discuss');
  const skip = document.createElement('button');skip.type = 'button';skip.className = 'approval-deny';skip.textContent = t('questions.skip');
  const back = document.createElement('button');back.type = 'button';back.className = 'approval-deny';back.textContent = t('questions.back');back.hidden = index===0;
  const submit = document.createElement('button');submit.type = 'submit';submit.className = 'approval-allow';submit.textContent = t(index<questions.length-1 ? 'questions.next' : 'questions.submit');
  updateSubmit();
  const replaceCard = () => {
    form.replaceWith(questionCard(item));syncQuestionVoice();$('#question-requests legend')?.focus({preventScroll:true});
    chatScroll.sync();
  };
  back.onclick = () => {dropQuestionRecording(item.id);item.draft.index--;replaceCard();};
  const respond = async action => {
    const selected = action === 'answer' ? [...fieldset.querySelectorAll('input:checked')].map(input => input.value) : [];
    if (action === 'answer' && questionDictationPhase(item.id)) {
      error.textContent = t('questions.dictation_wait');error.hidden = false;return;
    }
    if (action === 'answer' && !selected.length && !custom.value.trim()) {
      error.textContent = t('questions.required');error.hidden = false;return;
    }
    // Whatever is still being dictated would land in an answer that no longer exists or was just discarded.
    if (action !== 'answer') cancelFieldVoice(questionVoiceMatcher(item.id, action === 'skip' ? index : undefined));
    if (action!=='cancel') {
      Object.assign(draft,{action,selected,custom:action==='skip'?'':custom.value});
      if (batch && index<questions.length-1 && action!=='discuss') {
        item.draft.index++;replaceCard();return;
      }
    }
    const answer = batch ? {
      action:action==='discuss'?'discuss':action==='cancel'?'cancel':'answer',
      answers:item.draft.answers.slice(0,action==='cancel'?index:index+1).map(answer => ({...answer})),
    } : {action,selected,custom:action==='skip'||action==='cancel'?'':custom.value};
    error.hidden = true;fieldset.disabled = true;form.querySelectorAll('button').forEach(button=>button.disabled=true);
    try {
      await conversationCommand('answer_question', {conversation_id:item.conversation_id,id:item.id,answer});
      retainQuestion({...item,status:'answered'});renderQuestions();renderSidebar();
    } catch (failure) {
      error.textContent = localizeError(failure);error.hidden = false;
      fieldset.disabled = false;form.querySelectorAll('button').forEach(button=>button.disabled=false);
      syncQuestionVoice();
    }
  };
  form.onsubmit = event => {event.preventDefault();respond('answer');};
  form.onkeydown = event => {
    if (event.key === 'Escape' && ['preparing', 'recording'].includes(form._voicePhase)) {
      event.preventDefault();event.stopPropagation();cancelFieldVoice(questionVoiceMatcher(item.id, index));
    }
  };
  discuss.onclick = () => respond('discuss');
  skip.onclick = () => respond('skip');close.onclick = () => respond('cancel');
  legend.tabIndex = -1;
  const content = document.createElement('div');content.className = 'question-content';content.append(fieldset);
  actions.append(discuss, back, skip, submit);form.append(content, error, actions);
  return form;
}

function renderQuestions() {
  let tray = $('#question-requests');
  if (!tray) {
    tray = document.createElement('section');tray.id = 'question-requests';tray.setAttribute('aria-label', t('questions.waiting'));tray.setAttribute('aria-live','polite');$('.composer').prepend(tray);
  }
  const items = pendingQuestions(state.activeConversationId);
  const focused = tray.contains(document.activeElement);
  const existing = new Map([...tray.children].map(card => [card.dataset.requestId, card]));
  for (const item of items) {
    if (!existing.has(item.id)) tray.append(questionCard(item));
    existing.delete(item.id);
  }
  for (const [id, card] of existing) {dropQuestionRecording(id);card.remove();}
  tray.hidden = !items.length;
  syncQuestionVoice();
  chatScroll.sync();
  if (focused && !tray.contains(document.activeElement)) $('#composer-input').focus({preventScroll:true});
}

async function setupQuestions() {
  await appWindow.listen('question-activity', ({payload:item}) => {
    if (!item?.conversation_id || typeof item.id !== 'string' || !['pending','answered','cancelled'].includes(item.status)) return;
    retainQuestion(item);renderQuestions();renderSidebar();
  });
  if (state.activeConversationId) await refreshQuestions(state.activeConversationId);
}
