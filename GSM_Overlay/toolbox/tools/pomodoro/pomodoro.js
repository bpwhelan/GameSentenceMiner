class PomodoroTool {
    constructor(container) {
        this.container = container;

        // DOM elements
        this.displayElement = null;
        this.timeDisplay = null;
        this.clockDisplay = null;
        this.phaseDisplay = null;
        this.controlsContainer = null;
        this.startPauseBtn = null;
        this.resetBtn = null;
        this.notificationElement = null;

        // Timer state
        this.intervalId = null;
        this.clockIntervalId = null;
        this.isRunning = false;
        this.isPaused = false;
        this.currentPhase = 'work'; // 'work', 'shortBreak', 'longBreak'
        this.timeRemaining = 0; // in seconds
        this.completedSessions = 0;

        // Settings (defaults)
        this.workDuration = 25 * 60; // 25 minutes
        this.shortBreakDuration = 5 * 60; // 5 minutes
        this.longBreakDuration = 15 * 60; // 15 minutes
        this.sessionsBeforeLongBreak = 4;
    }

    async init() {
        // Create main container
        this.displayElement = document.createElement('div');
        this.displayElement.className = 'pomodoro-container';

        // Create clock display
        this.clockDisplay = document.createElement('div');
        this.clockDisplay.className = 'pomodoro-clock';
        this.updateClock();
        this.displayElement.appendChild(this.clockDisplay);

        // Create timer display
        this.timeDisplay = document.createElement('div');
        this.timeDisplay.className = 'pomodoro-timer';
        this.timeRemaining = this.workDuration;
        this.timeDisplay.textContent = this.formatTime(this.timeRemaining);
        this.displayElement.appendChild(this.timeDisplay);

        // Create phase display
        this.phaseDisplay = document.createElement('div');
        this.phaseDisplay.className = 'pomodoro-phase work';
        this.phaseDisplay.textContent = 'WORK SESSION';
        this.displayElement.appendChild(this.phaseDisplay);

        // Create controls container
        this.controlsContainer = document.createElement('div');
        this.controlsContainer.className = 'pomodoro-controls';

        // Create start/pause button
        this.startPauseBtn = document.createElement('button');
        this.startPauseBtn.className = 'pomodoro-btn';
        this.startPauseBtn.textContent = 'Start';
        this.startPauseBtn.addEventListener('click', () => {
            if (!this.isRunning) {
                this.startTimer();
            } else {
                this.pauseTimer();
            }
        });
        this.controlsContainer.appendChild(this.startPauseBtn);

        // Create reset button
        this.resetBtn = document.createElement('button');
        this.resetBtn.className = 'pomodoro-btn';
        this.resetBtn.textContent = 'Reset';
        this.resetBtn.addEventListener('click', () => this.resetTimer());
        this.controlsContainer.appendChild(this.resetBtn);

        this.displayElement.appendChild(this.controlsContainer);

        // Create notification element
        this.notificationElement = document.createElement('div');
        this.notificationElement.className = 'pomodoro-notification';
        this.displayElement.appendChild(this.notificationElement);

        // Append to container
        this.container.appendChild(this.displayElement);

        // Start clock update interval
        this.clockIntervalId = setInterval(() => this.updateClock(), 1000);
    }

    destroy() {
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }
        if (this.clockIntervalId) {
            clearInterval(this.clockIntervalId);
            this.clockIntervalId = null;
        }
        if (this.displayElement) {
            this.displayElement.remove();
        }
    }

    onShow() {
        // Timer continues in background, nothing special needed
    }

    onHide() {
        // Timer continues in background, do NOT clear interval
    }

    updateSettings(settings) {
        if (settings.workDuration !== undefined) {
            this.workDuration = settings.workDuration * 60;
        }
        if (settings.shortBreakDuration !== undefined) {
            this.shortBreakDuration = settings.shortBreakDuration * 60;
        }
        if (settings.longBreakDuration !== undefined) {
            this.longBreakDuration = settings.longBreakDuration * 60;
        }
        if (settings.sessionsBeforeLongBreak !== undefined) {
            this.sessionsBeforeLongBreak = settings.sessionsBeforeLongBreak;
        }

        // If not running, update the display with new work duration
        if (!this.isRunning && this.currentPhase === 'work') {
            this.timeRemaining = this.workDuration;
            this.updateDisplay();
        }
    }

    startTimer() {
        if (!this.isRunning) {
            this.isRunning = true;
            this.isPaused = false;
            this.startPauseBtn.textContent = 'Pause';

            this.intervalId = setInterval(() => this.tick(), 1000);
        }
    }

    pauseTimer() {
        if (this.isRunning) {
            this.isRunning = false;
            this.isPaused = true;
            this.startPauseBtn.textContent = 'Resume';

            if (this.intervalId) {
                clearInterval(this.intervalId);
                this.intervalId = null;
            }
        }
    }

    resetTimer() {
        // Stop timer
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }

        // Reset state
        this.isRunning = false;
        this.isPaused = false;
        this.currentPhase = 'work';
        this.timeRemaining = this.workDuration;
        this.completedSessions = 0;

        // Update UI
        this.startPauseBtn.textContent = 'Start';
        this.phaseDisplay.className = 'pomodoro-phase work';
        this.phaseDisplay.textContent = 'WORK SESSION';
        this.updateDisplay();
    }

    tick() {
        if (this.timeRemaining > 0) {
            this.timeRemaining--;
            this.updateDisplay();
        } else {
            this.completePhase();
        }
    }

    completePhase() {
        // Stop the current timer
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }

        // Determine message and next phase
        let message = '';
        let nextPhase = '';

        if (this.currentPhase === 'work') {
            this.completedSessions++;

            // Determine break type
            if (this.completedSessions % this.sessionsBeforeLongBreak === 0) {
                nextPhase = 'longBreak';
                message = 'Work session complete! Time for a long break.';
            } else {
                nextPhase = 'shortBreak';
                message = 'Work session complete! Time for a short break.';
            }
        } else {
            nextPhase = 'work';
            message = 'Break complete! Time to work.';
        }

        // Show notification
        this.showNotification(message);

        // Switch to next phase
        this.switchPhase(nextPhase);

        // Auto-start next phase
        this.startTimer();
    }

    switchPhase(phase) {
        this.currentPhase = phase;

        if (phase === 'work') {
            this.timeRemaining = this.workDuration;
            this.phaseDisplay.className = 'pomodoro-phase work';
            this.phaseDisplay.textContent = 'WORK SESSION';
        } else if (phase === 'shortBreak') {
            this.timeRemaining = this.shortBreakDuration;
            this.phaseDisplay.className = 'pomodoro-phase short-break';
            this.phaseDisplay.textContent = 'SHORT BREAK';
        } else if (phase === 'longBreak') {
            this.timeRemaining = this.longBreakDuration;
            this.phaseDisplay.className = 'pomodoro-phase long-break';
            this.phaseDisplay.textContent = 'LONG BREAK';
        }

        this.updateDisplay();
    }

    updateDisplay() {
        if (this.timeDisplay) {
            this.timeDisplay.textContent = this.formatTime(this.timeRemaining);
        }
    }

    updateClock() {
        if (this.clockDisplay) {
            const now = new Date();
            const hours = String(now.getHours()).padStart(2, '0');
            const minutes = String(now.getMinutes()).padStart(2, '0');
            this.clockDisplay.textContent = `🕐 ${hours}:${minutes}`;
        }
    }

    formatTime(seconds) {
        const mins = Math.floor(seconds / 60);
        const secs = seconds % 60;
        return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    }

    showNotification(message) {
        if (this.notificationElement) {
            this.notificationElement.textContent = message;
            this.notificationElement.classList.add('show');

            // Auto-dismiss after 5 seconds
            setTimeout(() => {
                this.notificationElement.classList.remove('show');
            }, 5000);
        }
    }
}

// Export the tool creator function
window.createPomodoroTool = (container, settings) => {
    const tool = new PomodoroTool(container);
    if (settings) {
        tool.updateSettings(settings);
    }
    return tool;
};
