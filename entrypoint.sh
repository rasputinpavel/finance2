#!/bin/bash
echo "Container is starting up..."
echo "Running the script once on startup for testing..."
. /etc/environment
cd /usr/src/app && bun run src/index.ts >>/proc/1/fd/1 2>>/proc/1/fd/2
echo "Configuring cron job..."
printenv | grep -v "no_proxy" >>/etc/environment
echo "30 7 * * * . /etc/environment; cd /usr/src/app && bun run src/index.ts >> /proc/1/fd/1 2>> /proc/1/fd/2" >/etc/cron.d/finance-cron
chmod 0644 /etc/cron.d/finance-cron
crontab /etc/cron.d/finance-cron
echo "Cron job configured for 7:30 AM. Starting cron daemon."
cron -f
