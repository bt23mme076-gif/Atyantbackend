#!/bin/bash
# Run this ONCE on the VPS to set up recordings directory and cleanup cron

# Create recordings directory
mkdir -p /tmp/recordings
chmod 777 /tmp/recordings

# Disk-safety cron — deletes .ogg recordings older than 2 DAYS.
# ⚠️ Was 60 minutes, which defeated the "never delete recordings" pipeline fix:
# a failed pipeline run could not be retried via /api/sessions/:id/reprocess
# because the source audio was already gone (July 6: three sessions lost
# permanently). 48h leaves a real window to notice a failure and reprocess,
# while still bounding disk usage (~16 MB per 90-min session at 24 kbps).
CRON_JOB="0 * * * * find /tmp/recordings -name '*.ogg' -mmin +2880 -delete"
(crontab -l 2>/dev/null | grep -v 'recordings'; echo "$CRON_JOB") | crontab -

echo "✅ /tmp/recordings created"
echo "✅ Cleanup cron installed (48h retention)"
crontab -l
