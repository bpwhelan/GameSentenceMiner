/**
 * Notepad Tool for GSM Overlay Toolbox
 * Simple global note-taking with automatic persistence
 */
class NotepadTool {
  constructor(container) {
    this.container = container;
    this.saveIndicatorElement = null;
    this.textareaElement = null;
    this.saveTimeout = null;
    this.ipcRenderer = window.require ? window.require('electron').ipcRenderer : null;
  }

  /**
   * Initialize the notepad tool
   */
  async init() {
    console.log('Notepad tool initializing...');

    // Create save indicator (positioned in corner)
    this.saveIndicatorElement = document.createElement('div');
    this.saveIndicatorElement.className = 'notepad-save-indicator';
    this.saveIndicatorElement.textContent = '';
    this.container.appendChild(this.saveIndicatorElement);

    // Create textarea
    this.textareaElement = document.createElement('textarea');
    this.textareaElement.className = 'notepad-textarea';
    this.textareaElement.placeholder = 'Notes';
    this.textareaElement.spellcheck = false;
    this.container.appendChild(this.textareaElement);

    // Ensure textarea is interactive
    this.textareaElement.style.pointerEvents = 'auto';
    this.container.style.pointerEvents = 'auto';

    // Listen for input changes
    this.textareaElement.addEventListener('input', () => this.onInput());

    // Load saved notes
    await this.loadNotes();

    console.log('Notepad tool initialized');
  }

  /**
   * Load notes from storage
   */
  async loadNotes() {
    if (!this.ipcRenderer) return;

    try {
      const data = await this.ipcRenderer.invoke('toolbox-data-read', {
        toolId: 'notepad',
        gameKey: 'global'
      });

      if (data && data.notes !== undefined) {
        this.textareaElement.value = data.notes;
        this.saveIndicatorElement.textContent = 'saved';
        this.saveIndicatorElement.className = 'notepad-save-indicator saved';
      }
    } catch (error) {
      console.error('Failed to load notes:', error);
      this.saveIndicatorElement.textContent = 'error';
      this.saveIndicatorElement.className = 'notepad-save-indicator error';
    }
  }

  /**
   * Save notes to storage
   */
  async saveNotes() {
    if (!this.ipcRenderer) return;

    try {
      this.saveIndicatorElement.textContent = 'saving...';
      this.saveIndicatorElement.className = 'notepad-save-indicator saving';

      const success = await this.ipcRenderer.invoke('toolbox-data-write', {
        toolId: 'notepad',
        gameKey: 'global',
        value: {
          notes: this.textareaElement.value
        }
      });

      if (success) {
        this.saveIndicatorElement.textContent = 'saved';
        this.saveIndicatorElement.className = 'notepad-save-indicator saved';
      } else {
        this.saveIndicatorElement.textContent = 'error';
        this.saveIndicatorElement.className = 'notepad-save-indicator error';
      }
    } catch (error) {
      console.error('Failed to save notes:', error);
      this.saveIndicatorElement.textContent = 'error';
      this.saveIndicatorElement.className = 'notepad-save-indicator error';
    }
  }

  /**
   * Handle input with debounced auto-save
   */
  onInput() {
    // Show typing indicator
    this.saveIndicatorElement.textContent = 'typing...';
    this.saveIndicatorElement.className = 'notepad-save-indicator typing';

    // Clear existing timeout
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
    }

    // Schedule save after 1 second of no typing
    this.saveTimeout = setTimeout(() => {
      this.saveNotes();
    }, 1000);
  }

  /**
   * Called when toolbox becomes visible
   */
  onShow() {
    this.loadNotes();
  }

  /**
   * Called when toolbox becomes hidden
   */
  async onHide() {
    // Save immediately when hiding
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
      this.saveTimeout = null;
    }

    if (this.textareaElement.value.trim()) {
      await this.saveNotes();
    }
  }

  /**
   * Update tool settings
   */
  updateSettings(settings) {
    // No configurable settings
  }

  /**
   * Clean up the tool
   */
  async destroy() {
    console.log('Notepad tool destroying...');

    // Clear timeout
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
      this.saveTimeout = null;
    }

    // Save before destroying
    if (this.textareaElement && this.textareaElement.value.trim()) {
      await this.saveNotes();
    }

    // Remove DOM elements
    if (this.saveIndicatorElement && this.saveIndicatorElement.parentNode) {
      this.saveIndicatorElement.remove();
    }
    if (this.textareaElement && this.textareaElement.parentNode) {
      this.textareaElement.remove();
    }

    this.saveIndicatorElement = null;
    this.textareaElement = null;

    console.log('Notepad tool destroyed');
  }
}

// Factory function for the tool registry
window.createNotepadTool = (container, settings) => new NotepadTool(container);
