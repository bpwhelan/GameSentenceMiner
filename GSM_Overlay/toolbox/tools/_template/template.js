/**
 * Template Tool for GSM Overlay Toolbox
 * 
 * This is a template for creating new toolbox tools.
 * Copy this directory to create a new tool:
 * 
 * 1. Copy the _template folder and rename it to your tool name (e.g., "timer")
 * 2. Rename template.js to your-tool.js (e.g., "timer.js")
 * 3. Rename template.css to your-tool.css (e.g., "timer.css")
 * 4. Update the class name and factory function
 * 5. Register your tool in tool-registry.js
 * 6. Add a checkbox in settings.html
 * 
 * Tool Requirements:
 * - Must implement init(), destroy() methods
 * - Must export a factory function: window.create{ToolName}Tool
 * - Should be self-contained (no external dependencies)
 * - Should clean up resources in destroy()
 * - Should use transparent background by default
 */
class TemplateTool {
  /**
   * Constructor - receives the container element for this tool
   * @param {HTMLElement} container - The column container for this tool
   */
  constructor(container) {
    this.container = container;
    this.element = null;
    // Add any tool-specific properties here
    // this.intervalId = null;
    // this.data = {};
  }
  
  /**
   * Initialize the tool
   * Called when the tool is loaded
   * Create DOM elements and set up event listeners here
   * @returns {Promise<void>}
   */
  async init() {
    console.log('Template tool initializing...');
    
    // Create your main element
    this.element = document.createElement('div');
    this.element.className = 'template-tool-display';
    this.element.textContent = 'Template Tool';
    
    // Add to container
    this.container.appendChild(this.element);
    
    // Set up any event listeners
    // this.element.addEventListener('click', this.handleClick.bind(this));
    
    // Set up any intervals or timers
    // this.intervalId = setInterval(() => this.update(), 1000);
    
    console.log('Template tool initialized');
  }
  
  /**
   * Called when toolbox becomes visible
   * Use to resume operations (e.g., restart timers)
   */
  onShow() {
    // Resume any paused operations
    console.log('Template tool shown');
  }
  
  /**
   * Called when toolbox becomes hidden
   * Use to pause operations (e.g., stop timers to save resources)
   */
  onHide() {
    // Pause any ongoing operations
    console.log('Template tool hidden');
  }
  
  /**
   * Update tool settings
   * Called when settings change
   * @param {Object} settings - The new settings object
   */
  updateSettings(settings) {
    // Apply new settings
    // if (settings.someOption !== undefined) {
    //   this.someOption = settings.someOption;
    //   this.render();
    // }
    console.log('Template tool settings updated', settings);
  }
  
  /**
   * Clean up the tool
   * IMPORTANT: Always implement proper cleanup!
   * - Remove event listeners
   * - Clear intervals/timeouts
   * - Remove DOM elements
   */
  destroy() {
    console.log('Template tool destroying...');
    
    // Clear any intervals
    // if (this.intervalId) {
    //   clearInterval(this.intervalId);
    //   this.intervalId = null;
    // }
    
    // Remove event listeners
    // this.element.removeEventListener('click', this.handleClick);
    
    // Remove DOM elements
    if (this.element && this.element.parentNode) {
      this.element.remove();
    }
    this.element = null;
    
    console.log('Template tool destroyed');
  }
  
  // Add your custom methods below
  // handleClick(event) { ... }
  // update() { ... }
  // render() { ... }
}

/**
 * Factory function for the tool registry
 * 
 * IMPORTANT: The function name must follow this pattern:
 * window.create{PascalCaseToolId}Tool
 * 
 * Examples:
 * - Tool ID "clock" → window.createClockTool
 * - Tool ID "my-timer" → window.createMyTimerTool
 * - Tool ID "word_counter" → window.createWordCounterTool
 * 
 * @param {HTMLElement} container - The container element for this tool
 * @param {Object} settings - Initial settings for the tool
 * @returns {TemplateTool} The tool instance
 */
window.createTemplateTool = (container, settings) => new TemplateTool(container);

// Note: This template is NOT registered in tool-registry.js
// It's only meant to be copied as a starting point for new tools
