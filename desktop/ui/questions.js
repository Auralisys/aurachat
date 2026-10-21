const questionRequests = new Map();

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
}

async function refreshQuestions(conversationId) {
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
  const customLabel = document.createElement('label');customLabel.className = 'question-custom';
  const customTitle = document.createElement('span');customTitle.textContent = t('questions.custom');
  const custom = document.createElement('textarea');custom.name = 'custom';custom.rows = 1;custom.maxLength = 16000;
  custom.placeholder = t('questions.custom_placeholder');custom.value = draft.custom;
  fieldset.oninput = () => {
    draft.action = 'answer';
    draft.selected = [...fieldset.querySelectorAll('input:checked')].map(input => input.value);
    draft.custom = custom.value;
    submit.disabled = !draft.selected.length && !draft.custom.trim();
  };
  customLabel.append(customTitle, custom);fieldset.append(customLabel);
  const error = document.createElement('p');error.className = 'question-error';error.setAttribute('role', 'alert');error.hidden = true;
  const actions = document.createElement('div');actions.className = 'approval-card__actions';
  const discuss = document.createElement('button');discuss.type = 'button';discuss.className = 'approval-deny';discuss.textContent = t('questions.discuss');
  const skip = document.createElement('button');skip.type = 'button';skip.className = 'approval-deny';skip.textContent = t('questions.skip');
  const back = document.createElement('button');back.type = 'button';back.className = 'approval-deny';back.textContent = t('questions.back');back.hidden = index===0;
  const submit = document.createElement('button');submit.type = 'submit';submit.className = 'approval-allow';submit.textContent = t(index<questions.length-1 ? 'questions.next' : 'questions.submit');
  submit.disabled = !draft.selected.length && !draft.custom.trim();
  const replaceCard = () => {form.replaceWith(questionCard(item));$('#question-requests legend')?.focus({preventScroll:true});};
  back.onclick = () => {item.draft.index--;replaceCard();};
  const respond = async action => {
    const selected = action === 'answer' ? [...fieldset.querySelectorAll('input:checked')].map(input => input.value) : [];
    if (action === 'answer' && !selected.length && !custom.value.trim()) {
      error.textContent = t('questions.required');error.hidden = false;return;
    }
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
      await invoke('answer_question', {conversation_id:item.conversation_id,id:item.id,answer});
      retainQuestion({...item,status:'answered'});renderQuestions();renderSidebar();
    } catch (failure) {
      error.textContent = localizeError(failure);error.hidden = false;
      fieldset.disabled = false;form.querySelectorAll('button').forEach(button=>button.disabled=false);
      submit.disabled = !draft.selected.length && !draft.custom.trim();
    }
  };
  form.onsubmit = event => {event.preventDefault();respond('answer');};
  discuss.onclick = () => respond('discuss');
  skip.onclick = () => respond('skip');close.onclick = () => respond('cancel');
  legend.tabIndex = -1;
  const content = document.createElement('div');content.className = 'question-content';content.append(fieldset);
  actions.append(back, discuss, skip, submit);form.append(content, error, actions);
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
  for (const card of existing.values()) card.remove();
  tray.hidden = !items.length;
  if (focused && !tray.contains(document.activeElement)) $('#composer-input').focus({preventScroll:true});
}

async function setupQuestions() {
  await appWindow.listen('question-activity', ({payload:item}) => {
    if (!item?.conversation_id || typeof item.id !== 'string' || !['pending','answered','cancelled'].includes(item.status)) return;
    retainQuestion(item);renderQuestions();renderSidebar();
  });
  if (state.activeConversationId) await refreshQuestions(state.activeConversationId);
}
