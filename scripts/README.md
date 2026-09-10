# ViPER Container Monitoring Scripts

This directory contains scripts used for monitoring ViPER container instances.

## Scripts Overview

### `viper-monitor.sh`
The main monitoring script that runs inside each ViPER container. This script:
- Captures screenshots every 60 seconds
- Monitors user activity (mouse/keyboard events) 
- Tracks system resources (CPU, memory)
- Sends reports to the parent application every 30 seconds
- Includes debug logging when DEBUG=1

**Template Variables:**
- `{{INSTANCE_UUID}}` - Unique identifier for the container instance
- `{{SERVICE_URL}}` - Base URL of the parent application
- `{{DOMAIN_NAME}}` - Domain name for the service

### `viper-monitor.desktop`
XDG autostart entry that starts the monitoring script with the desktop session.
Written to `/config/.config/autostart/` in the instance, which is the `abc` user's
home, and honoured by MATE. A systemd unit was written alongside this until 2.0.0
and has been removed: init in the LinuxServer images is s6-svscan, so it never ran.

### `debug-monitoring.sh`
Debug script to test monitoring functionality and troubleshoot issues.

**Usage:**
```bash
./debug-monitoring.sh [instance-uuid] [service-url] [debug-mode]
```

**Example:**
```bash
./debug-monitoring.sh test-123 https://cloudviper.org 1
```

## How It Works

1. **Container Creation**: When a new ViPER instance is created, the monitoring scripts are deployed to the container
2. **Template Processing**: Variables in the scripts are replaced with actual values (instance UUID, service URLs)
3. **Installation**: Scripts are copied to appropriate locations in the container
4. **Auto-start**: Multiple methods ensure the monitoring script starts with the desktop session:
   - SystemD user service
   - XFCE autostart entry
5. **Monitoring Loop**: The script continuously monitors and reports activity
6. **Data Collection**: Screenshots and activity data are sent to the parent application

## Debugging

### Common Issues

1. **Scripts not starting**: Check if DISPLAY environment variable is set
2. **No screenshots**: Verify `scrot` is installed and X11 is running
3. **No activity detection**: Check if `xdotool` is available
4. **Network errors**: Verify service URLs and network connectivity

### Debug Mode

Enable debug mode by setting `DEBUG=1` in the monitoring script. This will:
- Create detailed logs at `/tmp/viper-monitor.log`
- Log all major operations and tool availability
- Help identify where the monitoring is failing

### Log Files

- Container logs: `/tmp/viper-monitor.log` (when debug mode enabled)
- Parent application logs: Check the main application logs for screenshot/activity reception

### Manual Testing

1. Run the debug script to test all components:
   ```bash
   ./debug-monitoring.sh your-instance-uuid https://your-domain.com 1
   ```

2. Test individual components:
   ```bash
   # Test screenshot capture
   scrot -z /tmp/test.png && ls -la /tmp/test.png
   
   # Test mouse detection
   xdotool getmouselocation
   
   # Test network connectivity
   curl -f https://your-domain.com/service/health
   ```

## API Endpoints

The monitoring script communicates with these endpoints:

### POST `/service/screenshot/:instanceUUID`
Receives base64-encoded screenshots from containers.

**Payload:**
```json
{
  "screenshot": "base64-encoded-image-data",
  "timestamp": "2025-07-30T12:00:00.000Z"
}
```

### POST `/service/activity/:instanceUUID`
Receives activity reports from containers.

**Payload:**
```json
{
  "mouseEvents": 5,
  "keyboardEvents": 3,
  "windowActive": true,
  "cpuUsage": 25.5,
  "memoryUsage": 60.2,
  "timestamp": "2025-07-30T12:00:00.000Z"
}
```

## Dependencies

The monitoring script requires these tools in the container:
- `scrot` - For screenshot capture
- `xdotool` - For mouse/window detection
- `curl` - For HTTP requests
- `bc` - For floating-point calculations
- `base64` - For image encoding

These are automatically installed during container setup.

## Security Notes

- Monitoring scripts run as the `abc` user (non-root)
- Sudo access is removed during container setup for security
- Screenshots are base64-encoded before transmission
- Activity data includes no personally identifiable information
- All network requests include timeouts to prevent hanging

## Development

To modify the monitoring behavior:

1. Edit the script files in this directory
2. Update the `scriptManager.ts` utility if needed
3. Test changes using the debug script
4. Deploy by creating new container instances

The template variable system allows for dynamic configuration without hardcoding values in the scripts.
