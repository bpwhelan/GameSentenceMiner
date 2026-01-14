/**
 * Goals Tool - Display today's daily goals and progress
 *
 * Fetches and displays goals that are currently active:
 * - Static daily targets (hours_static, characters_static, cards_static)
 * - Time-bounded goals where today falls within the goal's date range
 *
 * Excludes:
 * - Custom checkbox goals (not suitable for overlay)
 * - Goals that haven't started yet or have already ended
 */

class GoalsTool {
  constructor(container, settings = {}) {
    this.container = container;
    this.goalsElement = null;
    this.isLoading = false;
    this.apiPort = settings.apiPort || 55000; // Default GSM API port
  }

  async init() {
    // Create main container
    this.goalsElement = document.createElement('div');
    this.goalsElement.className = 'goals-display';
    this.container.appendChild(this.goalsElement);

    // Initial fetch
    await this.fetchGoals();
  }

  async fetchGoals() {
    if (this.isLoading) return;

    try {
      this.isLoading = true;
      this.showLoading();

      // Get user timezone for accurate date calculation
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

      // Create AbortController for timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout

      // Step 1: Fetch all goals (following the web page pattern)
      const goalsResponse = await fetch(`http://localhost:${this.apiPort}/api/goals/current`, {
        method: 'GET',
        headers: {
          'X-Timezone': timezone,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        signal: controller.signal
      });

      if (!goalsResponse.ok) {
        throw new Error(`HTTP ${goalsResponse.status}: ${goalsResponse.statusText}`);
      }

      const goalsData = await goalsResponse.json();
      const allGoals = goalsData.current_goals || [];
      const goalsSettings = goalsData.goals_settings || {};

      // Filter for goals that are active today (exclude custom checkbox goals)
      const today = new Date().toISOString().split('T')[0];
      const activeGoals = allGoals.filter(goal => {
        // Exclude custom checkbox goals (not suitable for overlay)
        if (goal.metricType === 'custom') {
          return false;
        }

        // Include static daily goals (always active)
        if (['hours_static', 'characters_static', 'cards_static'].includes(goal.metricType)) {
          return true;
        }

        // Include regular time-bounded goals that are currently in progress
        // (today is within the goal's date range)
        return goal.startDate <= today && goal.endDate >= today;
      });

      // Step 2: Fetch today's progress for each goal
      const todayGoals = [];
      for (const goal of activeGoals) {
        try {
          // Fetch progress from API for static goals
          const progressResponse = await fetch(`http://localhost:${this.apiPort}/api/goals/today-progress`, {
            method: 'POST',
            headers: {
              'X-Timezone': timezone,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              goal_id: goal.id,
              metric_type: goal.metricType,
              target_value: goal.targetValue,
              start_date: goal.startDate,
              end_date: goal.endDate,
              media_type: goal.mediaType || 'ALL',
              goals_settings: goalsSettings
            }),
            signal: controller.signal
          });

          if (!progressResponse.ok) {
            console.warn(`Failed to fetch progress for goal ${goal.id}`);
            continue;
          }

          const progressData = await progressResponse.json();

          // Only include goals with positive requirements
          if (progressData.has_target && !progressData.expired && !progressData.not_started && progressData.required > 0) {
            todayGoals.push({
              goal_name: goal.name,
              progress_today: progressData.progress,
              progress_needed: progressData.required,
              metric_type: goal.metricType,
              goal_icon: goal.icon || '🎯'
            });
          }
        } catch (error) {
          console.warn(`Error fetching progress for goal ${goal.id}:`, error);
          // Continue with other goals
        }
      }

      clearTimeout(timeoutId);

      // Render with the same data structure as the old endpoint
      this.render({ date: today, goals: todayGoals });
    } catch (error) {
      console.error('Goals Tool: Failed to fetch goals:', error);

      // Provide more specific error messages
      if (error.name === 'AbortError') {
        this.showError('Request timed out. Is GSM running?');
      } else if (error.message.includes('Failed to fetch') || error.message.includes('ERR_')) {
        this.showError('Cannot connect to GSM. Is it running?');
      } else {
        this.showError(error.message || 'Failed to load goals');
      }
    } finally {
      this.isLoading = false;
    }
  }

  showLoading() {
    this.goalsElement.innerHTML = `
      <div class="goals-loading">
        <div class="goals-spinner"></div>
        <span>Loading goals...</span>
      </div>
    `;
  }

  showError(message = 'Error loading goals') {
    this.goalsElement.innerHTML = `
      <div class="goals-error">
        <span>${this.escapeHtml(message)}</span>
        <button class="goals-retry-btn" onclick="this.closest('.goals-display').__goalsTool.fetchGoals()">
          Retry
        </button>
      </div>
    `;
    // Store reference for retry button
    this.goalsElement.__goalsTool = this;
  }

  render(data) {
    if (!data.goals || data.goals.length === 0) {
      this.goalsElement.innerHTML = `
        <div class="goals-empty">
          <span>No daily goals set</span>
          <small style="display: block; margin-top: 8px; opacity: 0.7;">Add static or custom goals in GSM</small>
        </div>
      `;
      return;
    }

    let html = '<div class="goals-list">';

    for (const goal of data.goals) {
      const progress = goal.progress_today || 0;
      const needed = goal.progress_needed || 0;

      // Handle static daily goals (hours_static, characters_static, cards_static)
      // Calculate percentage (can exceed 100%)
      const percentage = needed > 0 ? (progress / needed) * 100 : (progress > 0 ? 100 : 0);
      const percentageDisplay = Math.round(percentage);

      // Cap bar width at 100%
      const barWidth = Math.min(100, percentage);

      // Determine bar color based on completion
      const isComplete = percentage >= 100;
      const barClass = isComplete ? 'goals-bar-complete' : 'goals-bar-progress';

      // Format progress and target values
      const formattedProgress = this.formatProgress(progress, goal.metric_type);
      const formattedNeeded = this.formatProgress(needed, goal.metric_type);

      html += `
        <div class="goals-item">
          <div class="goals-item-header">
            <span class="goals-item-icon">${goal.goal_icon || '🎯'}</span>
            <span class="goals-item-name">${this.escapeHtml(goal.goal_name)}</span>
            <span class="goals-item-percent ${isComplete ? 'complete' : ''}">${percentageDisplay}%</span>
          </div>
          <div class="goals-bar-container">
            <div class="goals-bar ${barClass}" style="width: ${barWidth}%"></div>
          </div>
          <div class="goals-item-value">${formattedProgress} / ${formattedNeeded}</div>
        </div>
      `;
    }

    html += '</div>';
    this.goalsElement.innerHTML = html;
  }

  formatProgress(value, metricType) {
    // Remove _static suffix for formatting
    const baseMetricType = metricType.replace('_static', '');

    if (baseMetricType === 'hours') {
      // Format hours as Xh Ym or just Xh
      const hours = Math.floor(value);
      const minutes = Math.round((value - hours) * 60);
      if (hours > 0 && minutes > 0) {
        return `${hours}h ${minutes}m`;
      } else if (hours > 0) {
        return `${hours}h`;
      } else {
        return `${minutes}m`;
      }
    } else if (baseMetricType === 'characters') {
      // Format large numbers with K/M suffix
      if (value >= 1000000) {
        return `${(value / 1000000).toFixed(1)}M`;
      } else if (value >= 1000) {
        return `${(value / 1000).toFixed(1)}K`;
      } else {
        return Math.round(value).toString();
      }
    } else if (baseMetricType === 'cards') {
      // Format cards with simple number display
      return Math.round(value).toLocaleString();
    } else {
      // Default: just show the number
      return Math.round(value).toString();
    }
  }

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  onShow() {
    // Refresh goals when toolbox becomes visible
    this.fetchGoals();
  }

  onHide() {
    // No action needed - we don't have auto-refresh
  }

  updateSettings(settings) {
    if (settings && settings.apiPort !== undefined) {
      this.apiPort = settings.apiPort;
    }
  }

  destroy() {
    if (this.goalsElement) {
      this.goalsElement.remove();
      this.goalsElement = null;
    }
  }
}

// Factory function
window.createGoalsTool = (container, settings) => {
  const tool = new GoalsTool(container);
  if (settings) {
    tool.updateSettings(settings);
  }
  return tool;
};
