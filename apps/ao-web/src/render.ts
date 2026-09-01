import type {
  OperatorJobDetail,
  OperatorJobSummary,
  OperatorProjectOption,
  OperatorRuntimeStatus,
  OperatorTaskInput,
  OperatorTaskPreview,
  OrchestratorConversationState,
  RuntimeStartResult,
  ProjectOnboardingResult,
} from '../../../packages/agent-operations-application/src/index.js';

export function renderOrchestrator(
  conversation: OrchestratorConversationState,
  projects: readonly OperatorProjectOption[],
  relatedJobs: readonly OperatorJobSummary[],
  options: { readonly error?: string } = {},
): string {
  const jobs = new Map(relatedJobs.map(job => [job.job.id, job]));
  const transcript = conversation.turns.length
    ? conversation.turns.map(turn => `<article class="chat-turn">
      <div class="chat-message operator"><p class="eyebrow">You</p><p>${escapeHtml(turn.operatorMessage)}</p></div>
      <div class="chat-message orchestrator"><p class="eyebrow">AO Orchestrator</p>
        <p>${escapeHtml(turn.response ?? turn.error ?? (turn.status === 'pending' ? 'Working on this request.' : 'No response was recorded.'))}</p>
        ${turn.clarificationRequired ? '<span class="status needs">Clarification needed</span>' : ''}
        ${turn.relatedJobIds.map(jobId => {
          const job = jobs.get(jobId);
          return `<a class="chat-job" href="/jobs/${encodeURIComponent(jobId)}"><strong>${escapeHtml(job?.job.title ?? jobId)}</strong><span>${escapeHtml(job?.orchestrationState ?? 'Open Job')}</span></a>`;
        }).join('')}
      </div>
    </article>`).join('')
    : '<div class="empty"><h2>Start with the outcome</h2><p>Describe what you want. The Orchestrator will resolve the Project, ask for clarification when needed, and use the Agent Operations control plane.</p></div>';
  const projectOptions = projects.map(project => `<option value="${escapeAttr(project.project.id)}">${escapeHtml(project.project.name)}</option>`).join('');
  const statusLabel = conversation.runtimeState === 'ready' ? 'Ready' : conversation.runtimeState === 'busy' ? 'Busy' : 'Offline';
  return layout('Orchestrator', `<header class="page-head"><div><p class="eyebrow">Conversational intake</p><h1>Tell AO what you want.</h1><p>The persistent CortextOS Orchestrator manages intake. Agent Operations remains authoritative for every Job.</p></div><div class="runtime ${conversation.runtimeState === 'ready' ? 'ready' : conversation.runtimeState === 'busy' ? 'degraded' : 'offline'}"><span class="runtime-dot"></span><div><p class="eyebrow">Orchestrator</p><strong>${statusLabel}</strong>${conversation.runtimeReason ? `<small>${escapeHtml(conversation.runtimeReason)}</small>` : ''}</div></div></header>
    ${options.error ? `<div class="alert error">${escapeHtml(options.error)}</div>` : ''}
    <section class="chat-panel"><div class="chat-transcript">${transcript}</div>
      <form class="chat-compose" method="post" action="/orchestrator/turn" enctype="multipart/form-data">
        <label>Project hint<select name="projectId"><option value="">Let the Orchestrator resolve it</option>${projectOptions}</select></label>
        <label>Message<textarea name="message" rows="4" maxlength="16384" required placeholder="On Duck Face, inspect the Mirror X page and create a read only Job if the request is clear."></textarea></label>
        <label class="file-drop" id="orchestrator-file-drop">Attach a file<input id="orchestrator-attachment" name="attachment" type="file"><span>Choose a file or drop it here</span></label>
        <div class="input-chip" id="orchestrator-input-chip" hidden><span id="orchestrator-input-name"></span><button class="secondary" id="orchestrator-input-remove" type="button">Remove</button></div>
        <label>Or authorize a public URL<input name="inputUrl" type="url" placeholder="https://example.com/reference.pdf"></label>
        <p class="muted">Attachments become immutable AO Inputs outside source repositories. Only attached Input IDs are shared with this turn.</p>
        <p class="muted">Sending delegates one turn to the existing CortextOS session. It does not start the runtime automatically.</p>
        <button ${conversation.runtimeState === 'ready' ? '' : 'disabled'}>Send</button>
      </form>
    </section>
    <script>(()=>{const input=document.getElementById('orchestrator-attachment');const drop=document.getElementById('orchestrator-file-drop');const chip=document.getElementById('orchestrator-input-chip');const name=document.getElementById('orchestrator-input-name');const remove=document.getElementById('orchestrator-input-remove');const update=()=>{const file=input.files&&input.files[0];chip.hidden=!file;name.textContent=file?file.name:''};input.addEventListener('change',update);drop.addEventListener('dragover',event=>{event.preventDefault();drop.classList.add('dragging')});drop.addEventListener('dragleave',()=>drop.classList.remove('dragging'));drop.addEventListener('drop',event=>{event.preventDefault();drop.classList.remove('dragging');const file=event.dataTransfer&&event.dataTransfer.files[0];if(!file)return;const transfer=new DataTransfer();transfer.items.add(file);input.files=transfer.files;update()});remove.addEventListener('click',()=>{input.value='';update()})})();</script>`, 'orchestrator');
}

export function renderProjects(projects: readonly ProjectOnboardingResult[]): string {
  const cards = projects.length ? projects.map(project => `<article class="card" id="${escapeAttr(project.project.id)}">
    <div class="card-head"><div><p class="eyebrow">${escapeHtml(project.repositoryReadiness.length ? 'Git repository detected' : project.localFolders.length ? 'Local folder' : 'No resource attached')}</p><h2>${escapeHtml(project.project.name)}</h2><p>${escapeHtml(project.project.description ?? 'No description')}</p></div><span class="status ${project.profile.capabilities.repositoryReadOnlyJobs === 'available' ? 'done' : 'neutral'}">${project.profile.capabilities.repositoryReadOnlyJobs === 'available' ? 'Repository ready' : 'Context ready'}</span></div>
    ${renderProjectResource(project)}
    <dl class="facts"><div><dt>Stack</dt><dd>${escapeHtml(project.profile.detectedStack.join(', ') || 'Not detected')}</dd></div><div><dt>Package manager</dt><dd>${escapeHtml(project.profile.packageManager ?? 'Not detected')}</dd></div></dl>
    ${project.profile.warnings.length ? `<div class="alert error">${project.profile.warnings.map(escapeHtml).join('<br>')}</div>` : ''}
  </article>`).join('') : '<div class="empty"><h2>No Projects yet</h2><p>Add a local folder or start without files.</p></div>';
  return layout('Projects', `<header class="page-head"><div><p class="eyebrow">Project context</p><h1>Projects</h1><p>Provider neutral readiness profiles for work managed by Agent Operations.</p></div><a class="refresh" href="/projects/new">Add Project</a></header><section class="stack">${cards}</section>`, 'projects');
}

export function renderNewProject(error?: string): string {
  return layout('Add Project', `<a class="back" href="/projects">Back to Projects</a><header class="page-head"><div><p class="eyebrow">Project onboarding</p><h1>Add a Project</h1><p>Choose the folder for this Project. AO will detect Git and available capabilities automatically.</p></div></header>
    <form method="post" action="/projects" class="task-form">
      ${error ? `<div class="alert error">${escapeHtml(error)}</div>` : ''}
      <label>Name<input name="name" maxlength="200" required></label>
      <label>Description<input name="description" maxlength="2000"></label>
      <label>Project files<select id="project-resource-type" name="resourceType" required><option value="local-folder">Add Local Folder</option><option value="none">Start Without Files</option></select></label>
      <label id="project-folder-path">Local folder path<input name="path" placeholder="/absolute/path/to/project" required></label>
      <p class="muted">AO performs bounded read only inspection. It does not install dependencies, execute discovered commands, or create a worktree during onboarding.</p>
      <div class="actions"><button>Add Project</button></div>
    </form>
    <script>(()=>{const type=document.getElementById('project-resource-type');const label=document.getElementById('project-folder-path');const input=label.querySelector('input');const update=()=>{const files=type.value==='local-folder';label.hidden=!files;input.required=files};type.addEventListener('change',update);update()})();</script>`, 'projects');
}

function renderProjectResource(project: ProjectOnboardingResult): string {
  if (project.repositoryReadiness.length) {
    const repositoryRead = project.profile.capabilities.repositoryReadOnlyJobs === 'available' ? 'Available' : 'Unavailable';
    const isolatedChanges = project.profile.capabilities.isolatedCodeChangeJobs === 'available' ? 'Available' : 'Unavailable';
    return project.repositoryReadiness.map(repository => `<dl class="facts">
      <div><dt>Detected resource</dt><dd>Git repository</dd></div>
      <div><dt>Folder</dt><dd>${escapeHtml(repository.canonicalPath)}</dd></div>
      <div><dt>Remote</dt><dd>${escapeHtml(repository.canonicalRemote ?? 'No remote configured')}</dd></div>
      <div><dt>Branch</dt><dd>${escapeHtml(repository.detachedHead ? 'Detached HEAD' : repository.branch ?? 'Not detected')}</dd></div>
      <div><dt>HEAD</dt><dd>${escapeHtml(repository.headCommit?.slice(0, 12) ?? 'Not detected')}</dd></div>
      <div><dt>Working tree</dt><dd>${escapeHtml(repository.workingTree)}</dd></div>
      <div><dt>Repository read</dt><dd>${repositoryRead}</dd></div>
      <div><dt>Isolated code changes</dt><dd>${isolatedChanges}</dd></div>
    </dl>`).join('');
  }
  if (project.localFolders.length) {
    return `<dl class="facts">
      <div><dt>Detected resource</dt><dd>Local folder</dd></div>
      <div><dt>Folder</dt><dd>${escapeHtml(project.localFolders.map(value => value.canonicalPath).join(', '))}</dd></div>
      <div><dt>Git repository</dt><dd>Not detected</dd></div>
      <div><dt>File and context access</dt><dd>Available</dd></div>
      <div><dt>Repository code change Jobs</dt><dd>Unavailable</dd></div>
    </dl>`;
  }
  return '<dl class="facts"><div><dt>Files</dt><dd>No folder attached</dd></div><div><dt>Conversation and Inputs</dt><dd>Available</dd></div></dl>';
}

export function renderDashboard(
  projects: readonly OperatorProjectOption[],
  jobs: readonly OperatorJobSummary[],
  runtime: OperatorRuntimeStatus,
  options: {
    readonly error?: string;
    readonly preview?: OperatorTaskPreview;
    readonly input?: Partial<OperatorTaskInput>;
    readonly telegramConfigured?: boolean;
    readonly runtimeStart?: RuntimeStartResult;
  } = {},
): string {
  const runnable = projects.filter(project => project.runnable);
  const selectedProject = options.input?.projectId ?? runnable[0]?.project.id ?? '';
  const selectedRepository = options.input?.repositoryId
    ?? runnable.find(project => project.project.id === selectedProject)?.repositories[0]?.id
    ?? '';
  const selectedMode = options.input?.executionMode ?? 'repository-read-only';
  const running = jobs.filter(job => job.operatorRun?.status === 'pending' || job.operatorRun?.status === 'running').length;
  const needsMe = jobs.filter(job => job.needsHuman).length;
  const today = new Date().toISOString().slice(0, 10);
  const doneToday = jobs.filter(job => job.job.status === 'completed' && job.job.updatedAt.startsWith(today)).length;
  const form = `
    <section class="mission-summary">
      <div class="runtime ${runtime.state}"><span class="runtime-dot"></span><div><p class="eyebrow">Runtime</p><strong>${escapeHtml(runtime.label)}</strong>${runtime.reason ? `<small>${escapeHtml(runtime.reason)}</small>` : ''}${runtime.state !== 'ready' ? '<form method="post" action="/runtime/start"><button>Start Runtime</button></form>' : ''}</div></div>
      <div><p class="eyebrow">Notifications</p><strong>Telegram: ${options.telegramConfigured ? 'Configured' : 'Not configured'}</strong></div>
      <div><span>${running}</span><small>Running</small></div><div><span>${needsMe}</span><small>Needs Me</small></div><div><span>${doneToday}</span><small>Done Today</small></div>
    </section>
    ${options.runtimeStart ? renderRuntimeStart(options.runtimeStart) : ''}
    <section class="hero">
      <div><p class="eyebrow">New repository job</p><h1>What should Agent Operations do?</h1>
      <p class="lede">One bounded Worker, one independent Reviewer, and at most one revision. Read-only by default.</p></div>
      <form method="post" action="/jobs" class="task-form">
        ${options.error ? `<div class="alert error">${escapeHtml(options.error)}</div>` : ''}
        ${options.preview ? renderPreview(options.preview) : ''}
        <label>Project
          <select name="selection" required>${projects.flatMap(project => project.repositories.length
            ? project.repositories.map(repository => `
            <option value="${escapeAttr(JSON.stringify({ projectId: project.project.id, repositoryId: repository.id }))}" ${project.project.id === selectedProject && repository.id === selectedRepository ? 'selected' : ''} ${project.runnable ? '' : 'disabled'}>
              ${escapeHtml(project.project.name)}${project.repositories.length > 1 ? ` / ${escapeHtml(repository.name)}` : ''}${project.unavailableReason ? ` — ${escapeHtml(project.unavailableReason)}` : ''}
            </option>`)
            : [`<option value="" disabled>${escapeHtml(project.project.name)} — ${escapeHtml(project.unavailableReason ?? 'No repository is configured')}</option>`]).join('')}
          </select>
        </label>
        <label>Task
          <textarea name="task" rows="5" required placeholder="Find where the RuntimeExecutionPolicy contract is defined and summarize it.">${escapeHtml(options.input?.task ?? '')}</textarea>
        </label>
        <label>Execution mode
          <select name="executionMode" required>
            <option value="repository-read-only" ${selectedMode === 'repository-read-only' ? 'selected' : ''}>Read repository only</option>
            <option value="repository-write-isolated" ${selectedMode === 'repository-write-isolated' ? 'selected' : ''}>Write in isolated AO workspace</option>
          </select>
        </label>
        <label>Acceptance criteria
          <textarea name="acceptanceCriteria" rows="3" required placeholder="Identify the authoritative contract file and its three dimensions.">${escapeHtml(options.input?.acceptanceCriteria ?? '')}</textarea>
        </label>
        <div class="defaults"><span>Repository <strong>${selectedMode === 'repository-write-isolated' ? 'isolated workspace' : 'read only'}</strong></span><span>Network <strong>deny</strong></span><span>Environment <strong>empty</strong></span><span>Worker executions <strong>max 2</strong></span><span>Reviewer <strong>on</strong></span><span>Result <strong>${selectedMode === 'repository-write-isolated' ? 'approval required after PASS' : 'complete after PASS'}</strong></span></div>
        <div class="actions"><button class="secondary" name="intent" value="preview">Preview</button><button name="intent" value="run" ${runnable.length ? '' : 'disabled'}>Run Job</button></div>
      </form>
    </section>
    ${renderJobTable(jobs, 'Recent Jobs')}`;
  return layout('Jobs', form, 'jobs');
}

function renderRuntimeStart(result: RuntimeStartResult): string {
  const inventory = `${result.inventory.configuredAgents.length} configured agent(s), ${result.inventory.configuredCronCount} cron(s), ${result.inventory.configuredIntegrationCount} integration credential file(s)`;
  return `<div class="alert ${result.status === 'failed' ? 'error' : 'preview'}"><strong>${escapeHtml(result.message)}</strong><br>${escapeHtml(inventory)}${result.diagnostic ? `<br><small>${escapeHtml(result.diagnostic)}</small>` : ''}</div>`;
}

export function renderJobList(
  title: string,
  description: string,
  jobs: readonly OperatorJobSummary[],
  active: 'jobs' | 'running' | 'needs-me' | 'done',
): string {
  return layout(title, `<header class="page-head"><div><p class="eyebrow">Mission control</p><h1>${escapeHtml(title)}</h1><p>${escapeHtml(description)}</p></div><a class="refresh" href="/${active === 'jobs' ? '' : active}">Refresh</a></header>${renderJobTable(jobs, title)}`, active, active === 'running' ? 10 : undefined);
}

export function renderNeedsMe(jobs: readonly OperatorJobDetail[]): string {
  const cards = jobs.length ? jobs.flatMap(detail => detail.escalations
    .filter(escalation => !escalation.resolvedAt)
    .map(escalation => `<article class="card needs-card">
      <div class="card-head"><div><span class="status needs">Needs Me</span><h2><a href="/jobs/${encodeURIComponent(detail.summary.job.id)}">${escapeHtml(detail.summary.job.title)}</a></h2></div><time>${formatTime(escalation.createdAt)}</time></div>
      <dl class="facts"><div><dt>What happened</dt><dd>${escapeHtml(escalation.summary)}</dd></div><div><dt>Why AO stopped</dt><dd>${escapeHtml(humanize(escalation.reason))}</dd></div>
      <div><dt>Latest Worker result</dt><dd>${escapeHtml(detail.finalWorkerResult ?? 'No bounded Worker result was available before AO stopped.')}</dd></div>
      <div><dt>Reviewer feedback</dt><dd>${escapeHtml(detail.finalReview?.feedback ?? detail.finalReview?.summary ?? 'No Reviewer decision was recorded.')}</dd></div>
      <div><dt>What I need from you</dt><dd>${detail.escalationActions[escalation.id]?.includes('reconcile-execution') ? 'Check the existing accepted execution again. This does not resend the task.' : detail.escalationActions[escalation.id]?.includes('provide-guidance') ? 'Provide bounded guidance for a fresh Worker Attempt, or cancel this Job.' : detail.escalationActions[escalation.id]?.includes('cancel-job') ? 'Cancel this Job, or repair the blocking condition outside Agent Operations.' : 'Repair or reconcile the blocking condition outside Agent Operations. AO will not retry uncertain work.'}</dd></div></dl>
      ${renderEscalationActions(detail, escalation.id)}
    </article>`)) : ['<div class="empty"><h2>Nothing needs you</h2><p>Unresolved durable escalations will appear here.</p></div>'];
  return layout('Needs Me', `<header class="page-head"><div><p class="eyebrow">Human boundary</p><h1>Needs Me</h1><p>Work Agent Operations stopped rather than guessing or exceeding its budget.</p></div><a class="refresh" href="/needs-me">Refresh</a></header><section class="stack">${cards.join('')}</section>`, 'needs-me');
}

export function renderDone(jobs: readonly OperatorJobDetail[]): string {
  const content = jobs.length ? jobs.map(detail => `<article class="card done-card">
    <div class="card-head"><div><span class="status done">Done</span><h2><a href="/jobs/${encodeURIComponent(detail.summary.job.id)}">${escapeHtml(detail.summary.job.title)}</a></h2><p>${escapeHtml(detail.summary.projectName)} · ${escapeHtml(detail.summary.repositoryName)}</p></div><time>${formatTime(detail.completedAt ?? detail.summary.job.updatedAt)}</time></div>
    <div class="done-grid"><div><p class="eyebrow">Final Worker result</p><div class="result">${escapeHtml(detail.finalWorkerResult ?? 'No bounded final result is available.')}</div></div><div><p class="eyebrow">Reviewer PASS</p><p>${escapeHtml(detail.finalReview?.summary ?? 'No final review summary is available.')}</p><p class="muted">${detail.summary.workerExecutionCount} Worker ${detail.summary.workerExecutionCount === 1 ? 'execution' : 'executions'} · ${detail.summary.workerAttemptCount} historical ${detail.summary.workerAttemptCount === 1 ? 'Attempt' : 'Attempts'}${detail.summary.durationMs !== undefined ? ` · ${formatDuration(detail.summary.durationMs)}` : ''}</p></div></div>
  </article>`).join('') : '<div class="empty"><h2>No completed Jobs</h2><p>Reviewed read-only results will appear here.</p></div>';
  return layout('Done', `<header class="page-head"><div><p class="eyebrow">Reviewed results</p><h1>Done</h1><p>Jobs completed only after an independent Reviewer PASS.</p></div><a class="refresh" href="/done">Refresh</a></header><section class="stack">${content}</section>`, 'done');
}

export function renderJobDetail(detail: OperatorJobDetail): string {
  const { summary } = detail;
  const story = detail.workerAttempts.map((worker, index) => {
    const review = worker.review;
    return `<article class="story-step">
      <div class="step-number">${index + 1}</div><div class="step-body">
        <p class="eyebrow">Historical Worker Attempt ${worker.attempt.roleSequence}</p>
        <h2>${escapeHtml(worker.attempt.status)}</h2>
        <div class="result">${escapeHtml(worker.resultText ?? worker.attempt.failureReason ?? 'No bounded result recorded yet.')}</div>
        ${review ? `<section class="review ${review.decision.toLowerCase()}"><p class="eyebrow">Independent review</p><h3>${escapeHtml(review.decision)}</h3><p>${escapeHtml(review.summary)}</p>${review.feedback ? `<p><strong>Feedback:</strong> ${escapeHtml(review.feedback)}</p>` : ''}</section>` : '<p class="muted">Reviewer decision pending or unavailable.</p>'}
        <details><summary>Runtime details</summary><dl class="compact"><dt>Runtime</dt><dd>${escapeHtml(worker.attempt.runtimeAgentId ?? 'unassigned')}</dd><dt>Attempt</dt><dd>${escapeHtml(worker.attempt.id)}</dd><dt>Plan</dt><dd>${escapeHtml(worker.executionPlanId ?? 'not created')}</dd><dt>Dispatch</dt><dd>${escapeHtml(worker.dispatchId ?? 'not created')}</dd><dt>Exact turn</dt><dd>${escapeHtml(worker.externalReference ?? 'not observed')}</dd></dl></details>
      </div>
    </article>`;
  }).join('');
  const escalations = detail.escalations.map(escalation => `<div class="alert ${escalation.resolvedAt ? 'preview' : 'error'}"><strong>${escapeHtml(humanize(escalation.reason))}</strong><br>${escapeHtml(escalation.summary)}${escalation.resolvedAt ? `<br><small>Resolved ${formatTime(escalation.resolvedAt)}${escalation.resolutionSummary ? ` — ${escapeHtml(escalation.resolutionSummary)}` : ''}</small>` : ''}${!escalation.resolvedAt ? renderEscalationActions(detail, escalation.id) : ''}</div>`).join('');
  const guidance = detail.guidance.map(item => `<article class="story-step"><div class="step-number">H</div><div class="step-body"><p class="eyebrow">Human guidance</p><div class="result">${escapeHtml(item.instruction)}</div><p class="muted">Applied only to the next fresh Worker Attempt · ${formatTime(item.createdAt)}</p></div></article>`).join('');
  const content = `<a class="back" href="/">← All Jobs</a><header class="detail-head"><div><span class="status ${statusClass(summary)}">${escapeHtml(summary.orchestrationState)}</span><h1>${escapeHtml(summary.job.title)}</h1><p>${escapeHtml(summary.projectName)} · ${escapeHtml(summary.repositoryName)}</p></div><time>Created ${formatTime(summary.job.createdAt)}</time></header>
    <section class="criteria"><p class="eyebrow">Execution mode</p><p><strong>${summary.job.executionMode === 'repository-write-isolated' ? 'Isolated repository write' : 'Repository read only'}</strong>${detail.repositoryWorkspace ? ` · branch ${escapeHtml(detail.repositoryWorkspace.branchName)} · base ${escapeHtml(detail.repositoryWorkspace.baseRevision.slice(0, 12))} · workspace ${escapeHtml(detail.repositoryWorkspace.canonicalPath)} · state ${escapeHtml(detail.repositoryWorkspace.state)}` : ''}</p>${detail.repositoryWorkspace?.evidence ? `<p>${detail.repositoryWorkspace.evidence.changedFiles.length} changed file(s), ${detail.repositoryWorkspace.evidence.binaryFiles?.length ?? 0} binary. Diff ${detail.repositoryWorkspace.evidence.diffTruncated ? 'was truncated to its audit bound' : 'captured in full'}. ${detail.repositoryWorkspace.evidence.testResults.length} test result(s) recorded.</p><details><summary>Bounded diff evidence</summary><pre>${escapeHtml(detail.repositoryWorkspace.evidence.diffStat)}\n\n${escapeHtml(detail.repositoryWorkspace.evidence.diffText)}</pre></details>` : ''}</section>
    <section class="criteria"><p class="eyebrow">Worker execution budget</p><p><strong>${summary.workerExecutionCount} of 2 consumed</strong> · ${summary.workerAttemptCount} historical Worker ${summary.workerAttemptCount === 1 ? 'Attempt' : 'Attempts'} retained for audit.</p></section>
    <section class="criteria"><p class="eyebrow">Acceptance criteria</p><p>${escapeHtml(detail.acceptanceCriteria)}</p></section>
    ${detail.inputs?.length ? `<section class="criteria"><p class="eyebrow">Attached Inputs</p>${detail.inputs.map(input => `<p><strong>${escapeHtml(input.displayName)}</strong> · ${escapeHtml(input.mimeType)} · ${input.byteSize} bytes · SHA256 ${escapeHtml(input.sha256)}</p>`).join('')}</section>` : ''}
    ${escalations}<section class="story">${story || '<div class="empty"><h2>Accepted</h2><p>Agent Operations will prepare the first Worker Attempt.</p></div>'}${guidance}</section>
    <section class="final"><p class="eyebrow">Final state</p><h2>${escapeHtml(summary.orchestrationState)}</h2>
      ${detail.finalWorkerResult ? `<h3>Worker result</h3><div class="result">${escapeHtml(detail.finalWorkerResult)}</div>` : ''}
      ${detail.finalReview ? `<h3>Reviewer ${escapeHtml(detail.finalReview.decision)}</h3><p>${escapeHtml(detail.finalReview.summary)}</p>` : ''}
    </section>`;
  return layout(summary.job.title, content, summary.needsHuman ? 'needs-me' : summary.job.status === 'completed' ? 'done' : 'running', summary.operatorRun?.status === 'pending' || summary.operatorRun?.status === 'running' ? 10 : undefined);
}

export function renderError(message: string, status = 500): string {
  return layout(`Error ${status}`, `<div class="empty"><p class="eyebrow">Operator error</p><h1>${escapeHtml(message)}</h1><p><a href="/">Return to Jobs</a></p></div>`, 'jobs');
}

function renderPreview(preview: OperatorTaskPreview): string {
  const write = preview.executionMode === 'repository-write-isolated';
  return `<div class="alert preview"><strong>Safe preview, no Job or Dispatch created.</strong> No workspace created.<br>${escapeHtml(preview.project.name)} / ${escapeHtml(preview.repository.name)} · ${escapeHtml(preview.runtimeAgentId)} · ${write ? 'workspace write in isolated AO worktree' : 'read only'} / deny / empty · 2 Worker executions · Reviewer enabled · ${write ? 'human approval required after PASS' : 'automatic completion after PASS'}</div>`;
}

function renderJobTable(jobs: readonly OperatorJobSummary[], title: string): string {
  if (!jobs.length) return `<section class="panel"><h2>${escapeHtml(title)}</h2><div class="empty"><p>No matching Jobs.</p></div></section>`;
  return `<section class="panel"><div class="panel-title"><h2>${escapeHtml(title)}</h2><span>${jobs.length}</span></div><div class="job-list">${jobs.map(job => `<a class="job-row" href="/jobs/${encodeURIComponent(job.job.id)}">
    <div><span class="status ${statusClass(job)}">${escapeHtml(job.orchestrationState)}</span><h3>${escapeHtml(job.job.title)}</h3><p>${escapeHtml(job.projectName)} · ${escapeHtml(job.repositoryName)}</p></div>
    <div class="job-meta"><span>${job.currentRole ? humanize(job.currentRole) : '—'}</span><span>${job.latestAttempt ? `Worker execution ${job.workerExecutionCount} of 2` : 'Preparing'}</span><span>${escapeHtml(job.currentStage)}</span><time>${formatTime(job.startedAt ?? job.job.createdAt)}</time></div>
  </a>`).join('')}</div></section>`;
}

function layout(title: string, content: string, active: 'orchestrator' | 'projects' | 'jobs' | 'running' | 'needs-me' | 'done', refreshSeconds?: number): string {
  const nav = [['orchestrator', '/orchestrator', 'Orchestrator'], ['projects', '/projects', 'Projects'], ['jobs', '/', 'Jobs'], ['running', '/running', 'Running'], ['needs-me', '/needs-me', 'Needs Me'], ['done', '/done', 'Done']]
    .map(([key, href, label]) => `<a href="${href}" ${active === key ? 'aria-current="page"' : ''}>${label}</a>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${refreshSeconds ? `<meta http-equiv="refresh" content="${refreshSeconds}">` : ''}<title>${escapeHtml(title)} · Agent Operations</title><style>${styles}</style></head><body><header class="topbar"><a class="brand" href="/"><span>AO</span><strong>Agent Operations</strong></a><nav>${nav}</nav><span class="local">Local only</span></header><main>${content}</main><footer>Agent Operations mission control · controlled repository work</footer></body></html>`;
}

function statusClass(job: OperatorJobSummary): string {
  if (job.needsHuman) return 'needs';
  if (job.job.status === 'completed') return 'done';
  if (job.operatorRun?.status === 'pending' || job.operatorRun?.status === 'running') return 'running';
  return 'neutral';
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? escapeHtml(value) : new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function humanize(value: string): string {
  return value.replaceAll('_', ' ').replace(/\b\w/g, character => character.toUpperCase());
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

function renderEscalationActions(detail: OperatorJobDetail, escalationId: string): string {
  const actions = detail.escalationActions[escalationId] ?? [];
  if (!actions.length) return '';
  return `<div class="resolution-actions">${actions.includes('provide-guidance') ? `<form method="post" action="/escalations/${encodeURIComponent(escalationId)}/guidance"><label>Guidance for a fresh Worker Attempt<textarea name="instruction" rows="3" maxlength="4096" required></textarea></label><button>Provide Guidance + Continue</button></form>` : ''}${actions.includes('reconcile-execution') ? `<form method="post" action="/escalations/${encodeURIComponent(escalationId)}/reconcile"><p><strong>Execution may have finished after AO stopped observing.</strong><br>This checks the existing accepted turn. It does not resend the task.</p><button>Check Execution Again</button></form>` : ''}${actions.includes('cancel-job') ? `<form method="post" action="/escalations/${encodeURIComponent(escalationId)}/cancel"><button class="danger">Cancel Job</button></form>` : ''}</div>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}

function escapeAttr(value: string): string {
  return escapeHtml(value);
}

const styles = `
:root{color-scheme:light;--ink:#18221f;--muted:#66736f;--line:#dfe6e2;--paper:#f5f7f5;--card:#fff;--green:#206b4f;--lime:#dff4e8;--amber:#9a5b00;--amber-bg:#fff2d7;--blue:#255f85;--blue-bg:#e2f2fb;--red:#9d3030;--red-bg:#fde8e8;--shadow:0 16px 50px rgba(34,55,47,.08)}
input{width:100%;border:1px solid #cbd5d0;border-radius:10px;padding:11px 12px;background:#fff;color:var(--ink);font:inherit}input:focus{outline:3px solid #ccecdf;border-color:var(--green)}.file-drop{border:1px dashed #91b5a5;border-radius:12px;padding:14px;background:#f7fbf9}.file-drop.dragging{border-color:var(--green);background:var(--lime)}.file-drop input{border:0;padding:0;background:transparent}.file-drop span{color:var(--muted);font-weight:500}.input-chip{display:flex;align-items:center;justify-content:space-between;gap:12px;border:1px solid #bdd9cc;border-radius:10px;padding:9px 11px;background:#f4faf7}.input-chip[hidden]{display:none}.input-chip span{overflow-wrap:anywhere}.input-chip button{padding:6px 10px}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;line-height:1.5}.topbar{height:68px;display:flex;align-items:center;gap:32px;padding:0 max(24px,calc((100vw - 1180px)/2));background:#102b24;color:#fff}.brand{display:flex;align-items:center;gap:10px;color:#fff;text-decoration:none}.brand span{display:grid;place-items:center;width:34px;height:34px;border-radius:10px;background:#61d09b;color:#102b24;font-weight:900}.topbar nav{display:flex;gap:4px;flex:1}.topbar nav a{color:#bad0c8;text-decoration:none;padding:8px 13px;border-radius:8px;font-weight:650}.topbar nav a:hover,.topbar nav a[aria-current=page]{background:#25473d;color:#fff}.local{font-size:12px;text-transform:uppercase;letter-spacing:.1em;color:#9bb6ad}main{width:min(1180px,calc(100% - 40px));margin:42px auto 80px}h1,h2,h3,p{margin-top:0}h1{font-size:clamp(30px,4vw,52px);line-height:1.05;letter-spacing:-.035em}h2{letter-spacing:-.02em}.eyebrow{text-transform:uppercase;letter-spacing:.13em;font-size:12px;font-weight:800;color:var(--green);margin-bottom:10px}.lede{font-size:18px;color:var(--muted);max-width:620px}.mission-summary{display:grid;grid-template-columns:2fr repeat(3,1fr);gap:12px;margin-bottom:28px}.mission-summary>div{background:#fff;border:1px solid var(--line);border-radius:14px;padding:16px 18px;display:grid;gap:3px}.mission-summary>div:not(.runtime){text-align:center}.mission-summary span{font-size:26px;font-weight:850}.mission-summary small{color:var(--muted)}.runtime{grid-template-columns:auto 1fr;align-items:center}.runtime .eyebrow{margin:0}.runtime-dot{width:12px;height:12px;border-radius:50%;background:var(--red)}.runtime.ready .runtime-dot{background:#34a26f}.runtime.degraded .runtime-dot{background:#d78a1f}.runtime small{display:block}.hero{display:grid;grid-template-columns:.85fr 1.15fr;gap:50px;align-items:start;margin-bottom:36px}.task-form,.panel,.card,.criteria,.final{background:var(--card);border:1px solid var(--line);border-radius:18px;box-shadow:var(--shadow)}.task-form{padding:26px;display:grid;grid-template-columns:1fr 1fr;gap:18px}.task-form label{display:grid;gap:7px;font-weight:700;font-size:14px}.task-form label:nth-of-type(n+2),.task-form .defaults,.task-form .actions,.task-form .alert{grid-column:1/-1}textarea,select{width:100%;border:1px solid #cbd5d0;border-radius:10px;padding:11px 12px;background:#fff;color:var(--ink);font:inherit}textarea:focus,select:focus{outline:3px solid #ccecdf;border-color:var(--green)}.defaults{display:flex;flex-wrap:wrap;gap:8px;color:var(--muted);font-size:12px}.defaults span{border:1px solid var(--line);border-radius:999px;padding:5px 9px}.actions,.resolution-actions{display:flex;justify-content:flex-end;gap:10px}.resolution-actions{align-items:end;margin-top:16px;flex-wrap:wrap}.resolution-actions form:first-child{display:grid;gap:8px;flex:1;min-width:280px}.resolution-actions label{display:grid;gap:6px;font-weight:700}.resolution-actions textarea{background:#fff}.danger{background:var(--red)}button,.refresh{border:0;border-radius:10px;background:var(--green);color:#fff;padding:11px 18px;font:inherit;font-weight:750;cursor:pointer;text-decoration:none}button.secondary{background:#e9efec;color:var(--ink)}button:disabled{opacity:.45;cursor:not-allowed}.panel{overflow:hidden}.panel-title{display:flex;justify-content:space-between;align-items:center;padding:22px 24px;border-bottom:1px solid var(--line)}.panel-title h2{margin:0}.panel-title span{background:#edf2ef;padding:3px 9px;border-radius:99px}.job-list{display:grid}.job-row{display:grid;grid-template-columns:1fr auto;gap:24px;padding:20px 24px;color:inherit;text-decoration:none;border-bottom:1px solid var(--line)}.job-row:last-child{border:0}.job-row:hover{background:#f8fbf9}.job-row h3{margin:8px 0 3px;font-size:18px}.job-row p,.page-head p,.detail-head p{color:var(--muted);margin:0}.job-meta{display:grid;grid-template-columns:repeat(4,auto);gap:16px;align-items:center;color:var(--muted);font-size:12px}.status{display:inline-flex;border-radius:999px;padding:4px 9px;font-size:11px;text-transform:uppercase;letter-spacing:.08em;font-weight:850}.status.running{background:var(--blue-bg);color:var(--blue)}.status.done{background:var(--lime);color:var(--green)}.status.needs{background:var(--amber-bg);color:var(--amber)}.status.neutral{background:#edf0ef;color:#58635f}.page-head,.detail-head{display:flex;justify-content:space-between;gap:30px;align-items:start;margin-bottom:28px}.page-head h1,.detail-head h1{margin-bottom:8px}.refresh{background:#e4ece8;color:var(--ink)}.stack,.story{display:grid;gap:18px}.card{padding:24px}.card-head{display:flex;justify-content:space-between;gap:20px}.card-head h2{margin:9px 0}.card-head a{color:inherit}.facts{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin:20px 0 0}.facts div{background:#f8faf9;border-radius:10px;padding:14px}.facts dt,.compact dt{font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:.08em;color:var(--muted)}.facts dd,.compact dd{margin:4px 0 0;white-space:pre-wrap}.done-grid{display:grid;grid-template-columns:2fr 1fr;gap:24px;margin-top:22px}.back{display:inline-block;margin-bottom:22px;color:var(--green);font-weight:750}.detail-head time{color:var(--muted)}.criteria,.final{padding:22px 24px;margin:20px 0}.criteria p:last-child{white-space:pre-wrap;margin:0}.story-step{display:grid;grid-template-columns:42px 1fr;gap:14px}.step-number{width:38px;height:38px;border-radius:50%;display:grid;place-items:center;background:#153a30;color:#fff;font-weight:850}.step-body{background:#fff;border:1px solid var(--line);border-radius:16px;padding:24px}.result{white-space:pre-wrap;background:#f3f6f4;border-radius:10px;padding:16px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px}.review{border-left:4px solid var(--green);margin-top:18px;padding:15px 18px;background:#f4faf7;border-radius:8px}.review.revision_required,.review.escalate{border-color:var(--amber);background:#fff8ea}.review h3{margin:0 0 6px}.review p:last-child{margin-bottom:0}details{margin-top:18px;color:var(--muted)}summary{cursor:pointer;font-weight:700}.compact{display:grid;grid-template-columns:auto 1fr;gap:7px 14px;font-size:12px}.alert{padding:13px 15px;border-radius:10px}.alert.error{background:var(--red-bg);color:var(--red)}.alert.preview{background:var(--blue-bg);color:var(--blue)}.empty{text-align:center;padding:55px 24px;color:var(--muted)}.muted{color:var(--muted)}.chat-panel{display:grid;grid-template-columns:1.45fr .75fr;gap:20px}.chat-transcript,.chat-compose{background:#fff;border:1px solid var(--line);border-radius:18px;box-shadow:var(--shadow)}.chat-transcript{padding:24px;min-height:440px;display:grid;gap:20px;align-content:start}.chat-turn{display:grid;gap:10px}.chat-message{max-width:88%;padding:15px 17px;border-radius:16px}.chat-message p:last-child{margin-bottom:0;white-space:pre-wrap}.chat-message.operator{justify-self:end;background:#153a30;color:#fff}.chat-message.operator .eyebrow{color:#9de0c0}.chat-message.orchestrator{background:#f0f5f2}.chat-job{display:flex;justify-content:space-between;gap:15px;margin-top:12px;padding:11px 13px;border:1px solid #bdd9cc;border-radius:10px;color:var(--green);text-decoration:none;background:#fff}.chat-compose{padding:22px;display:grid;gap:16px;align-content:start}.chat-compose label{display:grid;gap:7px;font-weight:700}.chat-compose button{justify-self:end}footer{text-align:center;color:#84908c;font-size:12px;padding:25px}@media(max-width:800px){.topbar{height:auto;flex-wrap:wrap;padding:14px 20px;gap:12px}.topbar nav{order:3;width:100%;overflow:auto}.local{margin-left:auto}.mission-summary{grid-template-columns:1fr 1fr}.mission-summary .runtime{grid-column:1/-1}.hero{grid-template-columns:1fr;gap:20px}.task-form{grid-template-columns:1fr}.task-form label{grid-column:1/-1}.job-row{grid-template-columns:1fr}.job-meta{grid-template-columns:1fr}.facts,.done-grid{grid-template-columns:1fr}.page-head,.detail-head{display:block}.refresh{display:inline-block;margin-top:15px}.chat-panel{grid-template-columns:1fr}.chat-message{max-width:96%}}
`;
