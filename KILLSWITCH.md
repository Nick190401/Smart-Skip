# 🛑 Smart Skip Killswitch System

## Overview

The Killswitch System allows you to remotely disable Smart Skip extensions worldwide. This is useful for:

- **Monetization**: Disable free versions when launching a paid version
- **Emergency shutdown**: Quickly disable extensions if issues are discovered
- **Version control**: Disable specific problematic versions
- **Gradual migration**: Move users from free to paid versions

## How It Works

1. **Extension checks status**: Every 24 hours, extensions check remote endpoints
2. **Grace period**: 7-day grace period if endpoints are unreachable  
3. **Multiple endpoints**: Fallback URLs ensure reliability
4. **User notification**: Optional messages when disabling extensions

## Setup Instructions

### 1. Configure Endpoints

Update the endpoints in `src/shared/killswitch.js`:

```javascript
this.endpoints = [
  'https://smartskip.kernelminds.de/killswitch.json', // Primary endpoint
  'https://smartskip.kernelminds.de/status',          // Backup endpoint  
  'https://github.com/YourUsername/YourRepo/raw/main/killswitch.json' // GitHub fallback
];
```

### 2. Deploy Killswitch File

Upload `killswitch.json` to your server(s) at the configured endpoints.

**Example killswitch.json (ACTIVE):**
```json
{
  "active": true,
  "version": "1.1.0", 
  "timestamp": "2025-08-18T00:00:00Z",
  "message": null,
  "disabledVersions": [],
  "upgradeUrl": null,
  "gracePeriod": 604800000
}
```

**Example killswitch.json (DISABLED):**
```json
{
  "active": false,
  "version": "1.1.0",
  "timestamp": "2025-08-18T00:00:00Z", 
  "message": "Smart Skip is now a premium extension. Upgrade to Smart Skip Pro for continued access!",
  "disabledVersions": ["1.0.0", "1.0.1", "1.0.2"],
  "upgradeUrl": "https://your-store.com/smart-skip-pro",
  "gracePeriod": 604800000
}
```

### 3. Use Admin Interface

Open `killswitch-admin.html` in your browser to:
- ✅ Enable/disable extensions
- 📝 Set user messages  
- 🔗 Configure upgrade URLs
- 🚫 Disable specific versions
- 📥 Generate and download JSON files

## Emergency Procedures

### Immediate Shutdown
1. Open `killswitch-admin.html`
2. Click "🛑 DISABLE ALL EXTENSIONS"
3. Upload generated JSON to all endpoints
4. Extensions will be disabled within 24 hours

### Gradual Migration 
1. Set specific versions to disable in `disabledVersions`
2. Provide upgrade URL and message
3. Users on old versions see upgrade prompt
4. New versions continue working

### Re-enable Extensions
1. Set `"active": true` in killswitch.json
2. Clear `disabledVersions` array
3. Upload updated JSON
4. Extensions re-activate on next check

## Technical Details

### Check Frequency
- **Startup**: Immediate check when extension loads
- **Periodic**: Every 24 hours during operation  
- **Runtime**: Every 5 minutes while actively running
- **Grace period**: 7 days if all endpoints fail

### Fallback Behavior
- If killswitch fails to load → Extension remains active
- If network is down → Extension works for 7 days  
- If JSON is invalid → Extension remains active
- Multiple endpoints → Tries each until one succeeds

### User Experience
- **Transparent**: Silent checks, no user interruption
- **Graceful**: Shows notification when disabled
- **Informative**: Upgrade links and messages
- **Reliable**: Works offline for grace period

## Security Considerations

- ✅ Uses HTTPS endpoints only
- ✅ Validates JSON structure
- ✅ Graceful degradation on errors
- ✅ No sensitive data transmitted
- ✅ User-controlled grace period

## Testing

### Test Killswitch Locally
```javascript
// In browser console:
window.__autoSkipper.getKillswitchStatus()

// Force killswitch check:
await window.killswitchManager.checkStatus()
```

### Simulate Disable
1. Create test killswitch.json with `"active": false`
2. Update endpoints to point to test file
3. Reload extension
4. Verify it stops working

## Files Overview

- `src/shared/killswitch.js` - Core killswitch logic
- `killswitch.json` - Status configuration file  
- `killswitch-admin.html` - Admin management interface
- `KILLSWITCH.md` - This documentation

## Legal Notes

⚠️ **Important**: Only use this system ethically and in compliance with:
- Extension store policies
- User agreements  
- Local laws and regulations
- User privacy rights

The killswitch should be used responsibly for legitimate business needs, not to harm users or violate platform policies.
