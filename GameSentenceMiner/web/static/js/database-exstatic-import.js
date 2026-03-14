(function () {
    'use strict';

    document.addEventListener('DOMContentLoaded', function () {
        const fileInput = document.getElementById('toolsExstaticFile');
        const importButton = document.getElementById('toolsImportExstaticBtn');
        const progress = document.getElementById('toolsExstaticProgress');
        const progressBar = document.getElementById('toolsExstaticProgressBar');
        const progressText = document.getElementById('toolsExstaticProgressText');
        const status = document.getElementById('toolsExstaticStatus');

        if (!fileInput || !importButton) {
            return;
        }

        fileInput.addEventListener('change', function () {
            importButton.disabled = !(fileInput.files && fileInput.files.length > 0);
            showStatus('', 'info', false);
        });

        importButton.addEventListener('click', function () {
            const file = fileInput.files && fileInput.files[0];
            if (!file) {
                showStatus('Please select an ExStatic CSV file first.', 'error', true);
                return;
            }

            importExstatic(file);
        });

        function showStatus(message, type, show) {
            if (!status) return;

            if (!show || !message) {
                status.style.display = 'none';
                return;
            }

            status.textContent = message;
            status.style.display = 'block';

            if (type === 'error') {
                status.style.background = 'var(--danger-color)';
                status.style.color = 'white';
                return;
            }

            if (type === 'success') {
                status.style.background = 'var(--success-color)';
                status.style.color = 'white';
                return;
            }

            status.style.background = 'var(--primary-color)';
            status.style.color = 'white';
        }

        function showProgress(show, percentage) {
            if (!progress || !progressBar || !progressText) {
                return;
            }

            if (!show) {
                progress.style.display = 'none';
                return;
            }

            progress.style.display = 'block';
            progressBar.style.width = percentage + '%';
            progressText.textContent = Math.round(percentage) + '%';
        }

        async function importExstatic(file) {
            let restoreButtonState = true;

            try {
                importButton.disabled = true;
                showProgress(true, 0);
                showStatus('Preparing import...', 'info', true);

                const formData = new FormData();
                formData.append('file', file);

                showProgress(true, 25);
                showStatus('Uploading ExStatic CSV...', 'info', true);

                const response = await fetch('/api/import-exstatic', {
                    method: 'POST',
                    body: formData,
                });

                showProgress(true, 75);
                showStatus('Processing imported lines...', 'info', true);

                const result = await response.json();
                showProgress(true, 100);

                if (!response.ok) {
                    showStatus(result.error || 'Import failed. Please try again.', 'error', true);
                    showProgress(false, 0);
                    return;
                }

                const warningSuffix = result.warning_count
                    ? ' Warnings: ' + result.warning_count + '.'
                    : '';
                showStatus(
                    'Imported ' +
                        (result.imported_count || 0) +
                        ' lines from ' +
                        (result.games_count || 0) +
                        ' games.' +
                        warningSuffix +
                        ' Refresh the page to see updated totals.',
                    'success',
                    true
                );
                fileInput.value = '';
                importButton.disabled = true;
                showProgress(false, 0);
                restoreButtonState = false;
            } catch (error) {
                console.error('ExStatic import failed:', error);
                showStatus(
                    'Import failed due to a network or server error. Please try again.',
                    'error',
                    true
                );
                showProgress(false, 0);
            } finally {
                if (restoreButtonState) {
                    importButton.disabled = !(fileInput.files && fileInput.files.length > 0);
                }
            }
        }
    });
})();
