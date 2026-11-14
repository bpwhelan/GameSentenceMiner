# Notification sounds

Open **Settings → Notifications & sounds** to select a delivery method and sound
for four groups. Changes save immediately. GSM synthesizes thirteen built-in
sounds locally, plus a paired falling and rising sound for pause and resume.

The four groups are **Confirmations**, **Card errors**, **Pause / resume**, and
**App alerts**. Confirmations include card updates, saved audio/screenshots, and
GSM readiness. Pause/resume covers OCR and stats collection. These groups default to **Sound only** at **15%**
volume. Card errors and app alerts default to silent banners. Each group can use **Off**,
**Sound only**, **Silent banner**, or **Banner + sound**. The volume slider applies
to every group that plays a sound. Selecting a sound immediately previews it at
the current volume, without waiting for the setting to save. **Preview** repeats it.
Sound choices take effect immediately and do not require restarting GSM.
The default **Falling / rising** choice plays falling tones when OCR or stats are
paused and rising tones when they resume. Its preview plays the pair in that order.
**Use quiet defaults** restores the default delivery methods, tones, and volume.
Existing per-event choices are migrated to these groups, retaining the primary
card-update, card-error, pause/resume, and general-error choices.

An unvoiced line is expected and does not produce a card-error notification.
Its card can still complete normally without audio. Real generation failures,
missing files that were expected to exist, and Anki upload failures still use the
separate **Card errors** setting and **Card error** notification title.

**Settings → Notifications & sounds** is the only notification configuration UI.
It applies to every game and profile. Python settings no longer contain notification
switches, and Python forwards events without applying retired profile switches.

On the first launch, the desktop reads the old switches from the saved active
profile before Python loads it. If an event was disabled, its desktop group starts
off. Existing sounds and volume are preserved. The old pending-review startup
switch migrates into **App alerts**, which also controls pending-review reminders.
A migration version is saved with desktop settings, so later desktop changes and
profile switches are never overridden by old Python values.
Python reports events through `GameSentenceMiner/util/communication/desktop_events.py`.
It has no operating-system popup or sound delivery, including in OCR helpers.
The former Python notification module, native notification dependencies, and
their triggering tests have been removed. Communication failures are logged;
there is no native Python fallback.

Tauri plays sounds through Rodio on the system's audio output. Playback also
works while the main window is hidden in the system tray.
Selected banners suppress the operating system's own sound, avoiding two sounds
for one event. Pending-review banners retain their review action. Restart warnings,
crash recovery, and administrator warnings retain their dedicated notification behavior.

`electron-src/shared/notifications.ts` owns event defaults, preference validation,
and tone definitions. `electron-src/main/notifications.ts` selects delivery.
`src-tauri/src/notification_audio.rs` synthesizes the tones and plays them through
the native mixer. Linux builds require ALSA development headers (`libasound2-dev`
on Debian and Ubuntu). Desktop-settings backups include notification preferences.
