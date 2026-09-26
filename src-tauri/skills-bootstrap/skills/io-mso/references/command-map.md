# m365 Command Map

Product family x operation -> the exact CLI for Microsoft 365 command and the
delegated scope it needs. Consult this before guessing a command name: the MCP
server's fuzzy `m365_search_commands` is weak (the query "list mail folders
outlook" returns 0 results), and several obvious-looking names do not exist.

**Verified against CLI for Microsoft 365 v11.6.0.** Scope SSOT is
`m365 <command> --help permissions`; when it prints nothing, Microsoft Graph
documentation for the API the command calls.

Scope state:

- **verified** — printed by `m365 <command> --help permissions` on v11.6.0.
- **inferred** — the command prints no PERMISSIONS block (`file *`, `spo *`,
  `todo *`, `teams` listing commands, `onedrive *` all do this). The scope comes
  from the Graph API the command calls and must be validated before it goes to a
  tenant admin.

`request` rows are Graph passthrough: the scope is the Graph endpoint's, not the
CLI's. Placeholders to replace: `<upn>`, `<siteUrl>`, `<folderUrl>`, `<chatId>`,
`<teamId>`, `<planId>`, `<listId>`.

## Outlook mail

| Operation | Command | Delegated scope | State |
|---|---|---|---|
| List messages (fast) | `m365 request --url 'https://graph.microsoft.com/v1.0/me/mailFolders/Inbox/messages?$top=25'` | `Mail.ReadBasic` | verified |
| List messages (native) | `m365 outlook message list --folderName Inbox` | `Mail.ReadBasic` | verified |
| Read one message | `m365 outlook message get --id <id>` | `Mail.ReadBasic` | verified |
| Move a message | `m365 outlook message move --id <id> --targetFolderName Archive` | `Mail.ReadWrite` | verified |
| Send mail | `m365 outlook mail send --to <upn> --subject "..." --bodyContents "..."` | `Mail.Send` | verified |
| Create a search folder | `m365 outlook mail searchfolder add ...` | `Mail.ReadWrite` | verified |
| Read mailbox settings | `m365 outlook mailbox settings get` | `MailboxSettings.Read` | verified |
| Write mailbox settings | `m365 outlook mailbox settings set ...` | `MailboxSettings.ReadWrite` | verified |

`outlook message list` has no paging flag, so it walks the whole folder and can
take 120 s+. Use the `request --url` form with `$top` for listing.

**Single-quote every OData URL.** A shell expands `$top` / `$filter` / `$select`
inside double quotes, so `"...?$top=25"` reaches `m365` as `...?=25` — the request
either fails or silently loses its limit.

## Outlook calendar

**There is no calendar event command.** `m365 outlook calendargroup list` lists
calendar *groups* only; `outlook room` / `outlook roomlist` cover resource
mailboxes. Events go through Graph passthrough.

| Operation | Command | Delegated scope | State |
|---|---|---|---|
| List calendar groups | `m365 outlook calendargroup list` | `Calendars.Read` | inferred |
| List events | `m365 request --url 'https://graph.microsoft.com/v1.0/me/events?$top=25'` | `Calendars.Read` | inferred |
| Create an event | `m365 request --method post --url 'https://graph.microsoft.com/v1.0/me/events' --body '{...}'` | `Calendars.ReadWrite` | inferred |

## OneDrive (personal files)

`m365 onedrive list` returns **tenant OneDrive sites (an admin view)**, not the
signed-in user's files. There is no `m365 onedrive file list`. Personal files go
through Graph passthrough, and site-hosted files through `file *` / `spo *`.

| Operation | Command | Delegated scope | State |
|---|---|---|---|
| List my files | `m365 request --url 'https://graph.microsoft.com/v1.0/me/drive/root/children'` | `Files.Read` | inferred |
| Download a file | `m365 request --url 'https://graph.microsoft.com/v1.0/me/drive/items/<id>/content'` | `Files.Read` | inferred |
| Upload / replace | `m365 request --method put --url '.../me/drive/root:/<path>:/content' ...` | `Files.ReadWrite` | inferred |
| List tenant OneDrive sites (admin) | `m365 onedrive list` | `Sites.Read.All` | inferred |

## SharePoint / site files

| Operation | Command | Delegated scope | State |
|---|---|---|---|
| List files in a folder | `m365 file list --webUrl <siteUrl> --folderUrl <folderUrl> [--recursive]` | `Files.Read.All` + `Sites.Read.All` | inferred |
| Upload a file | `m365 file add --filePath <path> --folderUrl <folderUrl>` | `Files.ReadWrite.All` + `Sites.ReadWrite.All` | inferred |
| Copy / move a file | `m365 file copy ...` · `m365 file move ...` | `Files.ReadWrite.All` + `Sites.ReadWrite.All` | inferred |
| Convert a file to PDF | `m365 file convert pdf --sourceFile <url> --targetFile <path>` | `Files.Read.All` | inferred |
| Get a file (SPO API) | `m365 spo file get --webUrl <siteUrl> --url <serverRelativeUrl>` | `AllSites.Read` / `Sites.Read.All` | inferred |
| List lists on a site | `m365 spo list list --webUrl <siteUrl>` | `AllSites.Read` / `Sites.Read.All` | inferred |
| Search across M365 | `m365 search --queryText "..." --scopes driveItem [--pageSize 25]` | `Files.Read.All` | inferred |

`file list` is SharePoint-site oriented: `--webUrl` is required, not optional.
The tenant-admin portion of `spo` (376 commands) is out of scope for this skill.

## Teams (personal chat only)

Channel *message bodies* (`ChannelMessage.Read.All`) are deliberately excluded —
Microsoft classifies it as a protected API. Team and channel *listing* stay in.

| Operation | Command | Delegated scope | State |
|---|---|---|---|
| List my chats | `m365 teams chat list` | `Chat.Read` | inferred |
| Get one chat | `m365 teams chat get --id <chatId>` | `Chat.Read` | inferred |
| List chat members | `m365 teams chat member list --chatId <chatId>` | `ChatMember.Read` | inferred |
| List chat messages | `m365 teams chat message list --chatId <chatId>` | `ChatMessage.Read` | verified |
| Send a chat message | `m365 teams chat message send --chatId <chatId> --message "..."` | `Chat.Read` + `ChatMessage.Send` | verified |
| List teams | `m365 teams team list` | `Team.ReadBasic.All` | inferred |
| List channels | `m365 teams channel list --teamId <teamId>` | `Channel.ReadBasic.All` | inferred |

## OneNote

| Operation | Command | Delegated scope | State |
|---|---|---|---|
| List notebooks | `m365 onenote notebook list` | `Notes.Read.All` + `Sites.Read.All` + `User.ReadBasic.All` + `Group.Read.All` | verified |
| Create a notebook | `m365 onenote notebook add --name "..."` | `Notes.Create` + `Sites.Read.All` + `User.ReadBasic.All` + `Group.Read.All` | verified |
| List pages | `m365 onenote page list [--groupName "..." \| --webUrl <siteUrl>]` | `Notes.Read.All` + `Sites.Read.All` + `User.ReadBasic.All` + `Group.Read.All` | verified |

## Planner

| Operation | Command | Delegated scope | State |
|---|---|---|---|
| List plans | `m365 planner plan list --ownerGroupName "..."` | `Tasks.Read` + `GroupMember.Read.All` | verified |
| Create a plan | `m365 planner plan add --title "..." --ownerGroupName "..."` | `Tasks.ReadWrite` + `GroupMember.Read.All` | verified |
| List tasks | `m365 planner task list [--planId <planId>]` | `Tasks.Read` + `GroupMember.Read.All` | verified |
| Add / update a task | `m365 planner task add ...` · `m365 planner task set ...` | `Tasks.ReadWrite` + `GroupMember.Read.All` + `User.Read` | verified |

## To Do

`todo *` prints no PERMISSIONS block; To Do shares the `Tasks.*` scope family
with Planner but targets the personal task store.

| Operation | Command | Delegated scope | State |
|---|---|---|---|
| List task lists | `m365 todo list list` | `Tasks.Read` | inferred |
| List tasks | `m365 todo task list --listName "Tasks"` (or `--listId <listId>`) | `Tasks.Read` | inferred |
| Add / update a task | `m365 todo task add ...` · `m365 todo task set ...` | `Tasks.ReadWrite` | inferred |

## Excluded

`ChannelMessage.Read.All`, `Sites.FullControl.All`, `Group.ReadWrite.All`, and
the tenant-admin surface of `spo`. Do not request them; if an operation appears
to need one, report the gap instead of widening the ask.
