/**
 * Clock Tool for GSM Overlay Toolbox
 * Displays current time in 24-hour format, updating every second
 */
class ClockTool {
  constructor(container) {
    this.container = container;
    this.timeElement = null;
    this.intervalId = null;
  }
  
  /**
   * Initialize the clock tool
   * Creates the DOM element and starts the interval
   */
  async init() {
    console.log('Clock tool initializing...');
    
    // Create time display element
    this.timeElement = document.createElement('div');
    this.timeElement.className = 'clock-display';
    this.container.appendChild(this.timeElement);
    
    // Initial time update
    this.updateTime();
    
    // Start interval for updates
    this.intervalId = setInterval(() => this.updateTime(), 1000);
    
    console.log('Clock tool initialized');
  }
  
  /**
   * Update the time display
   */
  updateTime() {
    const now = new Date();
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');
    this.timeElement.textContent = `${hours}:${minutes}:${seconds}`;
  }
  
  /**
   * Called when toolbox becomes visible
   */
  onShow() {
    // Resume interval if it was stopped
    if (!this.intervalId && this.timeElement) {
      this.updateTime();
      this.intervalId = setInterval(() => this.updateTime(), 1000);
    }
  }
  
  /**
   * Called when toolbox becomes hidden
   */
  onHide() {
    // Optionally pause interval to save resources
    // Uncomment to enable pause on hide:
    // if (this.intervalId) {
    //   clearInterval(this.intervalId);
    //   this.intervalId = null;
    // }
  }
  
  /**
   * Update tool settings (not used for clock, but required by interface)
   */
  updateSettings(settings) {
    // Clock has no configurable settings yet
  }
  
  /**
   * Clean up the tool - remove DOM elements and clear interval
   */
  destroy() {
    console.log('Clock tool destroying...');
    
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    
    if (this.timeElement && this.timeElement.parentNode) {
      this.timeElement.remove();
    }
    this.timeElement = null;
    
    console.log('Clock tool destroyed');
  }
}

// Factory function for the tool registry
// The factory function name must be createClockTool (create + PascalCase(toolId) + Tool)
window.createClockTool = (container, settings) => new ClockTool(container);
