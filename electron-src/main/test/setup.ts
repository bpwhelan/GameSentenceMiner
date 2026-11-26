process.env.GSM_ENABLE_CHAOS = '1';

// jsdom exposes HTMLDialogElement but does not implement its modal lifecycle.
if (typeof HTMLDialogElement !== 'undefined' && !HTMLDialogElement.prototype.showModal) {
    HTMLDialogElement.prototype.showModal = function () { this.open = true; };
    HTMLDialogElement.prototype.close = function () { this.open = false; };
}
