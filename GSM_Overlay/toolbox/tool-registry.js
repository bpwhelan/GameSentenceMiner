/**
 * Tool Registry - Central registry and loader for toolbox tools
 * Manages tool manifests and dynamic loading of tool scripts/styles
 */

const TOOL_MANIFEST = {
  'clock': {
    id: 'clock',
    name: '24-Hour Clock',
    path: './toolbox/tools/clock/clock.js',
    cssPath: './toolbox/tools/clock/clock.css',
    hasSettings: false,
    enabled: false // Default state
  },
  'notepad': {
    id: 'notepad',
    name: 'Notepad',
    path: './toolbox/tools/notepad/notepad.js',
    cssPath: './toolbox/tools/notepad/notepad.css',
    hasSettings: false,
    enabled: false
  },
  'pomodoro': {
    id: 'pomodoro',
    name: 'Pomodoro Timer',
    path: './toolbox/tools/pomodoro/pomodoro.js',
    cssPath: './toolbox/tools/pomodoro/pomodoro.css',
    hasSettings: true,
    enabled: false
  },
  'goals': {
    id: 'goals',
    name: 'Daily Goals',
    path: './toolbox/tools/goals/goals.js',
    cssPath: './toolbox/tools/goals/goals.css',
    hasSettings: false,
    enabled: false
  }
};

const ToolRegistry = {
  // Track loaded scripts and styles for cleanup
  loadedScripts: new Map(),
  loadedStyles: new Map(),
  toolInstances: new Map(),

  /**
   * Returns array of all tool manifest entries
   * @returns {Array} Array of tool manifests
   */
  getAllTools() {
    return Object.values(TOOL_MANIFEST);
  },

  /**
   * Returns specific tool manifest or undefined
   * @param {string} id - Tool ID
   * @returns {Object|undefined} Tool manifest
   */
  getToolById(id) {
    return TOOL_MANIFEST[id];
  },

  /**
   * Dynamically loads tool script/css and creates instance
   * @param {string} id - Tool ID to load
   * @param {HTMLElement} container - Container element for the tool
   * @returns {Promise<Object>} Tool instance
   */
  async loadTool(id, container) {
    console.log(`ToolRegistry: Loading tool ${id}`);

    const manifest = this.getToolById(id);
    if (!manifest) {
      console.error(`ToolRegistry: Tool ${id} not found in manifest`);
      throw new Error(`Tool ${id} not found in manifest`);
    }

    try {
      // Load CSS first if it exists
      if (manifest.cssPath) {
        await this.loadCSS(id, manifest.cssPath);
      }

      // Load JavaScript
      await this.loadScript(id, manifest.path);

      // Create tool instance using factory function
      // Factory function naming convention: window.create${PascalCaseId}Tool
      const factoryName = `create${this.toPascalCase(id)}Tool`;
      const factory = window[factoryName];

      if (typeof factory !== 'function') {
        console.error(`ToolRegistry: Factory function ${factoryName} not found`);
        throw new Error(`Factory function ${factoryName} not found for tool ${id}`);
      }

      // Create and store tool instance
      const toolInstance = factory(container);
      this.toolInstances.set(id, toolInstance);

      console.log(`ToolRegistry: Tool ${id} loaded successfully`);
      return toolInstance;

    } catch (error) {
      console.error(`ToolRegistry: Failed to load tool ${id}:`, error);
      throw error;
    }
  },

  /**
   * Load a JavaScript file dynamically
   * @param {string} id - Tool ID
   * @param {string} path - Path to script file
   * @returns {Promise<void>}
   */
  loadScript(id, path) {
    return new Promise((resolve, reject) => {
      // Check if already loaded
      if (this.loadedScripts.has(id)) {
        console.log(`ToolRegistry: Script for ${id} already loaded`);
        resolve();
        return;
      }

      const script = document.createElement('script');
      script.src = path;
      script.type = 'text/javascript';

      script.onload = () => {
        console.log(`ToolRegistry: Script loaded for ${id}`);
        this.loadedScripts.set(id, script);
        resolve();
      };

      script.onerror = () => {
        const error = new Error(`Failed to load script: ${path}`);
        console.error(`ToolRegistry: ${error.message}`);
        reject(error);
      };

      document.head.appendChild(script);
    });
  },

  /**
   * Load a CSS file dynamically
   * @param {string} id - Tool ID
   * @param {string} path - Path to CSS file
   * @returns {Promise<void>}
   */
  loadCSS(id, path) {
    return new Promise((resolve, reject) => {
      // Check if already loaded
      if (this.loadedStyles.has(id)) {
        console.log(`ToolRegistry: CSS for ${id} already loaded`);
        resolve();
        return;
      }

      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = path;

      link.onload = () => {
        console.log(`ToolRegistry: CSS loaded for ${id}`);
        this.loadedStyles.set(id, link);
        resolve();
      };

      link.onerror = () => {
        const error = new Error(`Failed to load CSS: ${path}`);
        console.error(`ToolRegistry: ${error.message}`);
        reject(error);
      };

      document.head.appendChild(link);
    });
  },

  /**
   * Cleanup for a specific tool
   * @param {string} id - Tool ID to unload
   */
  unloadTool(id) {
    console.log(`ToolRegistry: Unloading tool ${id}`);

    // Remove tool instance
    this.toolInstances.delete(id);

    // Note: We don't remove scripts/styles from DOM as they might be
    // needed again when tool is re-enabled. They're small and harmless.
    // If memory becomes a concern, we could remove them here.

    console.log(`ToolRegistry: Tool ${id} unloaded`);
  },

  /**
   * Convert kebab-case or snake_case to PascalCase
   * @param {string} str - String to convert
   * @returns {string} PascalCase string
   */
  toPascalCase(str) {
    return str
      .split(/[-_]/)
      .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join('');
  }
};

// Export to window for global access
window.ToolRegistry = ToolRegistry;
