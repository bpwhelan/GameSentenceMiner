/**
 * ToolboxManager - Core manager for the GSM Overlay toolbox system
 * Handles tool lifecycle, layout management, and visibility toggling
 */
class ToolboxManager {
  constructor() {
    this.container = null;
    this.tools = new Map();
    this.visible = false;
    this.enabled = false;
    this.enabledTools = [];
    this.toggleDebounce = null;
    this.ipcRenderer = window.require ? window.require('electron').ipcRenderer : null;
  }

  /**
   * Initialize toolbox container in DOM and set up references
   */
  init() {
    console.log('Toolbox initializing...');
    
    // Create or get existing container
    this.container = document.getElementById('toolbox-overlay');
    if (!this.container) {
      this.container = document.createElement('div');
      this.container.id = 'toolbox-overlay';
      document.body.appendChild(this.container);
      console.log('Toolbox container created');
    }

    console.log('Toolbox initialized');
  }

  /**
   * Show/hide toolbox with 100ms debounce to prevent rapid toggling
   */
  toggle() {
    // Clear any pending toggle
    if (this.toggleDebounce) {
      clearTimeout(this.toggleDebounce);
    }

    // Debounce the toggle operation
    this.toggleDebounce = setTimeout(() => {
      if (!this.enabled) {
        console.log('Toolbox is disabled, cannot toggle');
        return;
      }

      this.visible = !this.visible;

      if (this.visible) {
        this.container.classList.add('visible');
        console.log('Toolbox shown');
        // Notify tools they are now visible
        for (const [toolId, toolInstance] of this.tools.entries()) {
          if (typeof toolInstance.onShow === 'function') {
            try {
              toolInstance.onShow();
            } catch (error) {
              console.error(`Tool ${toolId} onShow error:`, error);
            }
          }
        }
      } else {
        this.container.classList.remove('visible');
        console.log('Toolbox hidden');
        // Notify tools they are now hidden
        for (const [toolId, toolInstance] of this.tools.entries()) {
          if (typeof toolInstance.onHide === 'function') {
            try {
              toolInstance.onHide();
            } catch (error) {
              console.error(`Tool ${toolId} onHide error:`, error);
            }
          }
        }
      }

      // Notify main process to update mouse event handling
      if (this.ipcRenderer) {
        this.ipcRenderer.send('toolbox-visibility-changed', this.visible);
      }

      this.toggleDebounce = null;
    }, 100);
  }

  /**
   * Load enabled tools from registry
   * @param {string[]} enabledToolIds - Array of tool IDs to load
   */
  async loadTools(enabledToolIds) {
    console.log('Loading tools:', enabledToolIds);

    // Clear existing tools
    this.container.innerHTML = '';
    this.tools.clear();

    if (!enabledToolIds || enabledToolIds.length === 0) {
      console.log('No tools to load');
      return;
    }

    // Load each enabled tool
    for (const toolId of enabledToolIds) {
      try {
        console.log(`Loading tool: ${toolId}`);
        
        // Create column for this tool
        const column = document.createElement('div');
        column.className = 'toolbox-column';
        column.dataset.toolId = toolId;
        this.container.appendChild(column);

        // Load tool from registry
        const toolInstance = await window.ToolRegistry.loadTool(toolId, column);
        
        if (toolInstance) {
          // Initialize tool if it has an init method
          if (typeof toolInstance.init === 'function') {
            try {
              await toolInstance.init();
              console.log(`Tool ${toolId} initialized successfully`);
            } catch (error) {
              console.error(`Failed to initialize tool ${toolId}:`, error);
            }
          }
          
          this.tools.set(toolId, toolInstance);
        }
      } catch (error) {
        console.error(`Failed to load tool ${toolId}:`, error);
      }
    }

    // Update layout after loading tools
    this.updateLayout();
    console.log(`Loaded ${this.tools.size} tools`);
  }

  /**
   * Recalculate column widths (100/N %)
   */
  updateLayout() {
    const columns = this.container.querySelectorAll('.toolbox-column');
    const columnCount = columns.length;

    if (columnCount === 0) {
      console.log('No columns to layout');
      return;
    }

    const columnWidth = `${100 / columnCount}%`;
    console.log(`Setting ${columnCount} columns to ${columnWidth} width`);

    columns.forEach(column => {
      column.style.width = columnWidth;
    });
  }

  /**
   * Apply settings changes
   * @param {Object} settings - Settings object {enabled, enabledTools}
   */
  async updateSettings(settings) {
    console.log('Updating toolbox settings:', settings);

    if (settings.enabled !== undefined) {
      this.enabled = settings.enabled;
      
      // If disabled, hide the toolbox
      if (!this.enabled && this.visible) {
        this.visible = false;
        this.container.classList.remove('visible');
        console.log('Toolbox disabled and hidden');
      }
    }

    if (settings.enabledTools !== undefined) {
      this.enabledTools = settings.enabledTools;
      
      // Reload tools if enabled
      if (this.enabled) {
        await this.loadTools(this.enabledTools);
      }
    }
  }

  /**
   * Cleanup all tool instances and event listeners
   */
  destroy() {
    console.log('Destroying toolbox...');

    // Destroy all tool instances
    for (const [toolId, toolInstance] of this.tools.entries()) {
      try {
        if (typeof toolInstance.destroy === 'function') {
          toolInstance.destroy();
          console.log(`Tool ${toolId} destroyed`);
        }
        
        // Unload from registry
        window.ToolRegistry.unloadTool(toolId);
      } catch (error) {
        console.error(`Failed to destroy tool ${toolId}:`, error);
      }
    }

    this.tools.clear();
    
    // Clear container
    if (this.container) {
      this.container.innerHTML = '';
      this.container.classList.remove('visible');
    }

    // Reset state
    this.visible = false;
    this.enabledTools = [];
    
    // Clear any pending debounce
    if (this.toggleDebounce) {
      clearTimeout(this.toggleDebounce);
      this.toggleDebounce = null;
    }

    console.log('Toolbox destroyed');
  }
}

// Export to window for global access
window.ToolboxManager = ToolboxManager;
