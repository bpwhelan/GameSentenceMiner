// Database Cron Tasks Module
// Dependencies: shared.js (escapeHtml), database-popups.js, database-helpers.js

let cronTasks = [];
let activeCronTaskRun = null;

function initializeCronTasks() {
    const tasksList = document.getElementById('tasksList');
    if (!tasksList || tasksList.dataset.initialized === 'true') {
        return;
    }

    const refreshButton = document.querySelector('[data-action="refreshCronTasks"]');

    tasksList.addEventListener('click', async (event) => {
        const rerunButton = event.target.closest('[data-action="rerunCronTask"]');
        if (!rerunButton) {
            return;
        }

        const taskName = rerunButton.dataset.taskName;
        if (!taskName) {
            return;
        }

        await rerunCronTask(taskName);
    });

    if (refreshButton) {
        refreshButton.addEventListener('click', () => {
            void loadCronTasks();
        });
    }

    tasksList.dataset.initialized = 'true';
    void loadCronTasks();
}

async function loadCronTasks() {
    const loadingIndicator = document.getElementById('tasksLoadingIndicator');
    const tasksContent = document.getElementById('tasksContent');
    const emptyState = document.getElementById('tasksEmptyState');

    if (!loadingIndicator || !tasksContent || !emptyState) {
        return;
    }

    loadingIndicator.style.display = 'flex';
    tasksContent.style.display = 'none';
    emptyState.style.display = 'none';

    try {
        const response = await fetch('/api/cron/tasks');
        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.error || 'Failed to load tasks');
        }

        cronTasks = Array.isArray(data.tasks) ? data.tasks : [];
        renderCronTasks();

        if (cronTasks.length === 0) {
            emptyState.style.display = 'flex';
        } else {
            tasksContent.style.display = 'block';
        }
    } catch (error) {
        console.error('Error loading cron tasks:', error);
        showDatabaseErrorPopup(`Failed to load tasks: ${error.message}`);
        emptyState.style.display = 'flex';
    } finally {
        loadingIndicator.style.display = 'none';
    }
}

function renderCronTasks() {
    const tasksList = document.getElementById('tasksList');
    if (!tasksList) {
        return;
    }

    tasksList.innerHTML = cronTasks.map((task) => {
        const isRunning = activeCronTaskRun === task.name;
        const buttonLabel = isRunning ? 'Running...' : 'Rerun';
        const buttonDisabled = isRunning || !task.can_rerun;
        const enabledLabel = task.enabled ? 'Enabled' : 'Disabled';
        const enabledClass = task.enabled ? 'enabled' : 'disabled';
        const displayName = escapeHtml(task.display_name || task.name);
        const description = escapeHtml(task.description || 'No description available.');
        const schedule = escapeHtml(formatCronSchedule(task.schedule));
        const lastRun = escapeHtml(formatUnixTimestamp(task.last_run, 'Never'));
        const nextRun = escapeHtml(formatUnixTimestamp(task.next_run, 'Not scheduled'));

        return `
            <div class="cron-task-card">
                <div class="cron-task-card-header">
                    <div>
                        <h4 class="cron-task-card-title">${displayName}</h4>
                        <p class="cron-task-card-description">${description}</p>
                    </div>
                    <div class="cron-task-badges">
                        <span class="cron-task-badge ${enabledClass}">${enabledLabel}</span>
                        <span class="cron-task-badge schedule">${schedule}</span>
                    </div>
                </div>
                <div class="cron-task-meta">
                    <div class="cron-task-meta-item">
                        <span class="cron-task-meta-label">Last Run</span>
                        <span class="cron-task-meta-value">${lastRun}</span>
                    </div>
                    <div class="cron-task-meta-item">
                        <span class="cron-task-meta-label">Next Run</span>
                        <span class="cron-task-meta-value">${nextRun}</span>
                    </div>
                    <div class="cron-task-meta-item">
                        <span class="cron-task-meta-label">Task Key</span>
                        <span class="cron-task-meta-value">${escapeHtml(task.name)}</span>
                    </div>
                </div>
                <div class="cron-task-actions">
                    <button
                        class="action-btn primary"
                        data-action="rerunCronTask"
                        data-task-name="${escapeHtml(task.name)}"
                        ${buttonDisabled ? 'disabled' : ''}
                    >
                        ${buttonLabel}
                    </button>
                </div>
            </div>
        `;
    }).join('');
}

async function rerunCronTask(taskName) {
    activeCronTaskRun = taskName;
    renderCronTasks();

    try {
        const response = await fetch(`/api/cron/tasks/${encodeURIComponent(taskName)}/run`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });
        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.error || 'Failed to rerun task');
        }

        if (data.task) {
            cronTasks = cronTasks.map((task) => task.name === data.task.name ? data.task : task);
        }

        showDatabaseSuccessPopup(buildCronTaskSuccessMessage(data));
        await loadCronTasks();
    } catch (error) {
        console.error(`Error rerunning cron task ${taskName}:`, error);
        showDatabaseErrorPopup(`Failed to rerun task: ${error.message}`);
    } finally {
        activeCronTaskRun = null;
        renderCronTasks();
    }
}

function formatCronSchedule(schedule) {
    if (!schedule) {
        return 'Unknown';
    }

    return schedule
        .replace(/_/g, ' ')
        .replace(/\b\w/g, (char) => char.toUpperCase());
}

function buildCronTaskSuccessMessage(data) {
    const task = data.task || {};
    const execution = data.execution || {};
    const result = execution.result || {};
    const taskLabel = task.display_name || task.name || execution.task_name || execution.name || 'Task';

    if (result.skipped) {
        return `${taskLabel} skipped: ${result.reason || 'no work to do'}.`;
    }

    if (Object.prototype.hasOwnProperty.call(result, 'upgraded_to_jiten')) {
        return `${taskLabel} finished. Upgraded ${result.upgraded_to_jiten || 0} games.`;
    }

    if (Object.prototype.hasOwnProperty.call(result, 'processed')) {
        return `${taskLabel} finished. Processed ${result.processed || 0} items.`;
    }

    if (Object.prototype.hasOwnProperty.call(result, 'created')) {
        return `${taskLabel} finished. Created ${result.created || 0} games.`;
    }

    if (Object.prototype.hasOwnProperty.call(result, 'action')) {
        return `${taskLabel} finished with action: ${result.action}.`;
    }

    return `${taskLabel} finished successfully.`;
}
