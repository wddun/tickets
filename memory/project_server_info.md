---
name: Production server details
description: Info about the production server environment
type: project
---

The ticketcheckin app runs on a Windows Server (AWS EC2, US East 2) via PM2. The app is accessed via RDP. PM2 shows harmless `wmic ENOENT` errors on Windows — these are noise from pidusage and can be ignored.

**Why:** Discovered while debugging Apple Wallet pass issues.
**How to apply:** Ignore wmic ENOENT errors in PM2 logs on this server. Focus on the ticketcheckin app log lines prefixed with `5|ticketcheckin`.
