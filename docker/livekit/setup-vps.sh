#!/bin/bash
# Run this ONCE on the VPS to set up recordings directory and cleanup cron

# Create recordings directory
mkdir -p /tmp/recordings
chmod 777 /tmp/recordings

# Add cleanup cron — deletes .ogg files older than 1 hour (failed pipeline safety net)
CRON_JOB="0 * * * * find /tmp/recordings -name '*.ogg' -mmin +60 -delete"
(crontab -l 2>/dev/null | grep -v 'recordings'; echo "$CRON_JOB") | crontab -

echo "✅ /tmp/recordings created"
echo "✅ Cleanup cron installed"
crontab -l
