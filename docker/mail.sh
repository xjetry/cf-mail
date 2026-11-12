#!/usr/bin/env bash
# 向本地 docker 部署的 cf-mail 发一封模拟邮件
# 用法: docker/mail.sh <收件地址> [主题]
set -euo pipefail

to="${1:?usage: mail.sh <to-address> [subject]}"
subject="${2:-Test from cf-mail}"
id="docker-$RANDOM-$(date +%s)@localhost"

curl --request POST 'http://localhost:8787/cdn-cgi/local/email' \
  --url-query "from=sender@example.com" \
  --url-query "to=${to}" \
  --data-raw "From: sender@example.com
To: ${to}
Subject: ${subject}
Message-ID: <${id}>

This is a test email sent via docker/mail.sh"
