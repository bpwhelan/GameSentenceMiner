/*
 * Copyright (C) 2023-2025  Yomitan Authors
 * Copyright (C) 2020-2022  Yomichan Authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

import {Application} from '../application.js';
import {promiseTimeout} from '../core/utilities.js';
import {DocumentFocusController} from '../dom/document-focus-controller.js';
import {querySelectorNotNull} from '../dom/query-selector.js';
import {ExtensionContentController} from './common/extension-content-controller.js';
import {ModalController} from './settings/modal-controller.js';
import {PermissionsOriginController} from './settings/permissions-origin-controller.js';
import {PermissionsToggleController} from './settings/permissions-toggle-controller.js';
import {PersistentStorageController} from './settings/persistent-storage-controller.js';
import {SettingsController} from './settings/settings-controller.js';
import {SettingsDisplayController} from './settings/settings-display-controller.js';

/**
 * @param {import('../comm/api.js').API} api
 */
async function setupEnvironmentInfo(api) {
    const {manifest_version: manifestVersion} = chrome.runtime.getManifest();
    const {browser, platform} = await api.getEnvironmentInfo();
    document.documentElement.dataset.browser = browser;
    document.documentElement.dataset.os = platform.os;
    document.documentElement.dataset.manifestVersion = `${manifestVersion}`;
}

/**
 * @returns {Promise<boolean>}
 */
async function isAllowedIncognitoAccess() {
    return await new Promise((resolve) => { chrome.extension.isAllowedIncognitoAccess(resolve); });
}

/**
 * @returns {Promise<boolean>}
 */
async function isAllowedFileSchemeAccess() {
    return await new Promise((resolve) => { chrome.extension.isAllowedFileSchemeAccess(resolve); });
}

/**
 * @returns {void}
 */
function setupPermissionsToggles() {
    const manifest = chrome.runtime.getManifest();
    const optionalPermissions = manifest.optional_permissions;
    /** @type {Set<string>} */
    const optionalPermissionsSet = new Set(optionalPermissions);
    if (Array.isArray(optionalPermissions)) {
        for (const permission of optionalPermissions) {
            optionalPermissionsSet.add(permission);
        }
    }

    /**
     * @param {Set<string>} set
     * @param {string[]} values
     * @returns {boolean}
     */
    const hasAllPermisions = (set, values) => {
        for (const value of values) {
            if (!set.has(value)) { return false; }
        }
        return true;
    };

    for (const toggle of /** @type {NodeListOf<HTMLInputElement>} */ (document.querySelectorAll('.permissions-toggle'))) {
        const permissions = toggle.dataset.requiredPermissions;
        const permissionsArray = (typeof permissions === 'string' && permissions.length > 0 ? permissions.split(' ') : []);
        toggle.disabled = !hasAllPermisions(optionalPermissionsSet, permissionsArray);
    }
}

await Application.main(true, async (application) => {
    const modalController = new ModalController([]);
    await modalController.prepare();

    const settingsController = new SettingsController(application);
    await settingsController.prepare();

    const settingsDisplayController = new SettingsDisplayController(settingsController, modalController);
    await settingsDisplayController.prepare();

    document.body.hidden = false;

    const documentFocusController = new DocumentFocusController();
    documentFocusController.prepare();

    const extensionContentController = new ExtensionContentController();
    extensionContentController.prepare();

    setupPermissionsToggles();

    void setupEnvironmentInfo(application.api);

    /** @type {HTMLInputElement} */
    const permissionCheckbox1 = querySelectorNotNull(document, '#permission-checkbox-allow-in-private-windows');
    /** @type {HTMLInputElement} */
    const permissionCheckbox2 = querySelectorNotNull(document, '#permission-checkbox-allow-file-url-access');
    /** @type {HTMLInputElement[]} */
    const permissionsCheckboxes = [permissionCheckbox1, permissionCheckbox2];

    const permissions = await Promise.all([
        isAllowedIncognitoAccess(),
        isAllowedFileSchemeAccess(),
    ]);

    for (let i = 0, ii = permissions.length; i < ii; ++i) {
        permissionsCheckboxes[i].checked = permissions[i];
    }

    const permissionsToggleController = new PermissionsToggleController(settingsController);
    void permissionsToggleController.prepare();

    const permissionsOriginController = new PermissionsOriginController(settingsController);
    void permissionsOriginController.prepare();

    const persistentStorageController = new PersistentStorageController(application);
    void persistentStorageController.prepare();

    await promiseTimeout(100);

    document.documentElement.dataset.loaded = 'true';
});
