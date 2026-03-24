---
name: Deployment workflow
description: How code changes are deployed to the production server
type: project
---

The production server is a Windows machine (AWS EC2, US East 2) accessed via RDP. Deployments are done via git — push to GitHub from local Mac, then git pull on the Windows server followed by pm2 restart. Do NOT suggest running npm install or other package manager commands as part of troubleshooting steps on the remote server without noting this workflow.

**Why:** User clarified this when I was debugging a pass generation issue.
**How to apply:** When suggesting fixes, always frame them as: edit locally → git push → git pull on server → pm2 restart. Never suggest installing packages on the remote server directly.
