# Goals Migration Guide: localStorage to Database

## Overview

This document describes the migration of the goals system from localStorage to database storage. This change improves data persistence, reliability, and enables better data management.

## What Changed

### Before (localStorage)
- Goals were stored entirely in browser localStorage
- Settings (easy days, AnkiConnect) were stored in localStorage
- Checkbox states for custom goals were stored in localStorage
- Data was lost when browser data was cleared
- No data synchronization between devices/browsers

### After (Database)
- All goals data is stored in the database
- Settings are stored in the database
- Checkbox states are stored in the database
- Data persists across browser sessions and devices
- Real-time data synchronization

## Technical Changes

### API Endpoints Added/Modified

1. **`/api/goals/save`** - Save goals and settings to database
2. **`/api/goals/latest_goals`** - Retrieve latest goals and settings
3. **`/api/goals/save-checkbox-states`** - Save checkbox states for custom goals
4. **`/api/goals/current_streak`** - Get current streak information
5. **`/api/goals/complete_todays_dailies`** - Complete today's dailies

### JavaScript Modules Updated

1. **CustomGoalsManager** - Now uses database instead of localStorage
2. **EasyDaysManager** - Now uses database instead of localStorage
3. **AnkiConnectManager** - Now uses database instead of localStorage
4. **CustomGoalCheckboxManager** - Now uses database instead of localStorage

### Database Schema

The goals table now stores:
- `current_goals` - JSON array of goal objects
- `goals_settings` - JSON object containing:
  - `easyDays` - Easy days settings
  - `ankiConnect` - AnkiConnect settings
  - `checkboxStates` - Custom goal checkbox states

## Benefits

### Data Persistence
- Goals and settings are no longer lost when browser data is cleared
- Data survives browser updates and reinstalls
- Users can export/import their database for backup

### Cross-Device Synchronization
- Goals and settings are available on any device with the same database
- Multiple users can share the same goals configuration
- Centralized data management

### Improved Reliability
- No more localStorage quota issues
- Better error handling and recovery
- Data integrity checks

### Performance
- Reduced localStorage overhead
- Efficient database queries
- Caching mechanisms for frequently accessed data

## Migration Process

### Automatic Migration
The system automatically migrates data from localStorage to the database:
1. On first load, checks for existing localStorage data
2. If found, migrates data to database
3. Clears localStorage after successful migration
4. Uses database exclusively going forward

### Manual Migration (if needed)
If automatic migration fails, users can manually export/import their goals:

1. **Export from localStorage** (before migration):
   ```javascript
   // In browser console
   const goals = JSON.parse(localStorage.getItem('gsm_custom_goals') || '[]');
   const easyDays = JSON.parse(localStorage.getItem('gsm_easy_days_settings') || '{}');
   const ankiConnect = JSON.parse(localStorage.getItem('gsm_anki_connect_settings') || '{}');
   const checkboxStates = JSON.parse(localStorage.getItem('gsm_custom_goal_checkboxes') || '{}');
   
   console.log('Goals:', goals);
   console.log('Easy Days:', easyDays);
   console.log('AnkiConnect:', ankiConnect);
   console.log('Checkbox States:', checkboxStates);
   ```

2. **Import to database** (after migration):
   ```javascript
   // Use the API endpoints to restore data
   fetch('/api/goals/save', {
     method: 'POST',
     headers: { 'Content-Type': 'application/json' },
     body: JSON.stringify({
       current_goals: goals,
       goals_settings: {
         easyDays: easyDays,
         ankiConnect: ankiConnect,
         checkboxStates: checkboxStates
       }
     })
   });
   ```

## Testing

### Automated Testing
Run the test script to verify the migration:
```bash
cd GameSentenceMiner/web
python test_goals_migration.py
```

### Manual Testing Checklist
- [ ] Create a new goal and verify it saves
- [ ] Edit an existing goal and verify changes persist
- [ ] Delete a goal and verify it's removed
- [ ] Test custom goal checkboxes
- [ ] Verify streak functionality works
- [ ] Check that settings are preserved across page refreshes
- [ ] Test easy days settings
- [ ] Test AnkiConnect settings
- [ ] Verify progress calculations work correctly

## Troubleshooting

### Common Issues

1. **Goals not saving**
   - Check browser console for errors
   - Verify database connection
   - Check API endpoint responses

2. **Settings not persisting**
   - Clear browser cache and reload
   - Check network requests in browser dev tools
   - Verify database schema is up to date

3. **Checkbox states lost**
   - Check if checkbox states are being saved to database
   - Verify the `/api/goals/save-checkbox-states` endpoint works
   - Check for JavaScript errors in console

### Debug Information

Enable debug logging by checking the browser console for:
- API request/response logs
- Database operation logs
- Error messages and stack traces

## Backward Compatibility

The migration is designed to be backward compatible:
- Existing localStorage data is automatically migrated
- No manual intervention required from users
- System gracefully handles missing or corrupted data

## Future Enhancements

Potential future improvements:
- User authentication for multi-user support
- Goal templates and presets
- Advanced analytics and reporting
- Goal sharing and collaboration features
- Mobile app synchronization

## Support

If you encounter issues with the migration:
1. Check the browser console for error messages
2. Run the automated test script
3. Report issues with detailed error information
4. Include browser version and operating system details