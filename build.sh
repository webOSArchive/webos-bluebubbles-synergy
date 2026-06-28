#!/bin/bash
rm *.ipk
echo Build started
date
palm-package app service package accounts
read -p "Press enter to install and follow the app..."
echo "To follow the service, use novaterm with: tail -f /var/log/messages"
palm-install com.wosa.bluebubbles*.ipk && palm-log -f com.wosa.bluebubbles