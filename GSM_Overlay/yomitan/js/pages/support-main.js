/*
 * Copyright (C) 2024-2025  Yomitan Authors
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

import {ThemeController} from '../app/theme-controller.js';
import {Application} from '../application.js';
import {SettingsController} from './settings/settings-controller.js';

await Application.main(true, async (application) => {
    const settingsController = new SettingsController(application);
    await settingsController.prepare();

    /** @type {ThemeController} */
    const themeController = new ThemeController(document.documentElement);
    themeController.prepare();
    const optionsFull = await application.api.optionsGetFull();
    const {profiles, profileCurrent} = optionsFull;
    const defaultProfile = (profileCurrent >= 0 && profileCurrent < profiles.length) ? profiles[profileCurrent] : null;
    if (defaultProfile !== null) {
        themeController.theme = defaultProfile.options.general.popupTheme;
        themeController.siteOverride = true;
        themeController.updateTheme();
    }

    document.body.hidden = false;

    document.documentElement.dataset.loaded = 'true';
});
