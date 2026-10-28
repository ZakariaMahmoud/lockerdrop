<p align="center">
  <img src="public/favicon.svg" alt="Lockerdrop logo" width="96">
</p>

<h1 align="center">Lockerdrop</h1>

<p align="center">
  Drop files into a locker. Open it with a code.<br>
  Simple file sharing for your local network, or the internet through a Cloudflare tunnel.
</p>

<p align="center">
  <img alt="Node.js 20+" src="https://img.shields.io/badge/node-%E2%89%A520-339933?logo=node.js&logoColor=white">
  <img alt="Zero dependencies" src="https://img.shields.io/badge/dependencies-0-ff6a1a">
  <img alt="MIT license" src="https://img.shields.io/badge/license-MIT-1b1a17">
</p>

---

## Features

- **Share with a code:** every workspace has a 4–8 character code like `Wk3demo`.
- **Anyone can share:** people on your network create their own workspaces, no accounts.
- **Download all:** get every file as one `.zip`, streamed instantly, any size.
- **Live progress:** upload and download bars with speed and time left.
- **Admin control:** manage every workspace, set storage limits, edit share links.
- **Safe by default:** admin and uploads are local-network only, and the tunnel is read-only.
- **Zero dependencies:** just Node.js. Nothing to install, nothing to update.

## Quick start

```bash
git clone https://github.com/ZakariaMahmoud/lockerdrop.git
cd lockerdrop
npm start
```

The terminal shows the addresses to open and your **admin key**:

```
  Lockerdrop is running

  Receiver  http://localhost:8080/
  Receiver  http://192.168.1.20:8080/
  Admin     http://localhost:8080/admin   (local network only)
  Admin     http://192.168.1.20:8080/admin   (local network only)

  Admin key: ••••••••••••••••••••••••
  Data dir:  /home/you/lockerdrop/data
```

The key is created on first run and saved in `data/admin.key`.

## How it works

| Who | Where | Can do |
|-----|-------|--------|
| **Participant** | `/` on the local network | Open a code and download · create workspaces, upload, remove, restore, delete their own |
| **Visitor** | `/` through the tunnel | Open a code and download, nothing else |
| **Admin** | `/admin` on the local network | Everything, for every workspace · permanent delete · settings |

### Share files

1. Open Lockerdrop and click **+ New workspace**.
2. Type a code or press **Random code**, then drop your files in.
3. Give people the code, or copy the ready-made link.

Your browser remembers the workspaces it created under **Your workspaces**.
Clearing your browser data removes that access; the admin can still manage them.

### Receive files

Type the code, then download files one by one or press **Download all**.

### Admin

Open `/admin` and paste the admin key once. The browser remembers it.

- **All workspaces:** open any workspace, including participants' ones.
- **Share links & storage:** choose the address used in copied links (pick a
  detected IP or type your own), add a tunnel URL, and set the storage limit.

## Share over the internet

```bash
npm start        # terminal 1
npm run tunnel   # terminal 2, prints https://<random>.trycloudflare.com
```

Requires [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/).
Paste the tunnel URL into **Admin → Share links & storage** to add it to copied links.

Tunnel visitors can only open a code and download. The admin page, workspace
creation and every change are refused for anything that arrives through a
proxy, uses a public domain, or comes from outside your network.

## Good to know

**Codes:** digits `1–9` and letters `a–z A–Z` (no `0`), case-sensitive.
Random codes skip the look-alikes `I`, `l` and `O`. Use 6–8 characters for
anything shared through the tunnel.

**Storage:** each workspace holds up to **10 GB** by default. Change it in the
admin settings. Uploads that don't fit are refused before they finish.

**Remove vs. delete**

| Action | Who | Effect |
|--------|-----|--------|
| Remove | owner, admin | Hidden from receivers, kept on disk, can be restored |
| Delete forever | admin | Erases a removed file and frees its space |
| Delete workspace | owner, admin | Erases the workspace and all its files (type the code to confirm) |

Removed files still count toward storage until they are deleted forever.

## Configuration

All optional, set as environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8080` | HTTP port |
| `HOST` | `0.0.0.0` | Address to listen on |
| `DATA_DIR` | `./data` | Where workspaces and files are stored |
| `ADMIN_KEY` | generated | Your own admin key (12+ characters) |
| `MAX_UPLOAD_MB` | `4096` | Largest single file |
| `MAX_WORKSPACE_MB` | `10240` | Default storage per workspace (`0` = unlimited) |
| `PUBLIC_URL` | none | Default tunnel URL for share links |

```bash
PORT=9000 ADMIN_KEY='choose-a-long-key' npm start
```

## Security

- Plain HTTP on the local network: anyone there who knows a code can download
  that workspace. The tunnel uses HTTPS.
- Wrong codes are rate limited (15 per 5 minutes per device), and a wrong code
  looks exactly like a wrong file, so codes can't be guessed or probed.
- Admin keys and owner tokens are compared in constant time and rate limited;
  owner tokens are stored only as hashes.
- Downloads are always sent as attachments, so uploaded HTML can't run in a
  receiver's browser. A strict Content Security Policy is set on every page.
- File names are cleaned of path characters and hidden direction-override
  characters, so a program can't disguise itself as a document.
- Other websites can't trigger actions through a visitor's browser.

<details>
<summary><strong>API reference</strong></summary>

<br>

Responses use `{ success, data, error }`. Owners send `X-Owner-Token`, the
admin sends `X-Admin-Key`. Management routes work on the local network only.

| Method | Path | Access | Description |
|--------|------|--------|-------------|
| GET | `/api/config` | anyone | What this visitor can do, upload limit, share links |
| GET | `/api/w/:code` | anyone | Workspace and its visible files |
| GET | `/api/w/:code/files/:id` | anyone | Download one file (`?t=<id>` to track progress) |
| GET | `/api/w/:code/zip` | anyone | Download all visible files as one ZIP |
| GET | `/api/downloads/:id` | anyone | Progress of a tracked download |
| POST | `/api/workspaces` | local | Create `{ name, code? }` → `{ workspace, ownerToken }` |
| GET | `/api/workspaces/:code` | owner, admin | Workspace with removed files and storage use |
| PUT | `/api/workspaces/:code/files` | owner, admin | Upload (raw body, `X-File-Name` header) |
| PATCH | `/api/workspaces/:code/files/:id` | owner, admin | Remove or restore `{ removed }` |
| DELETE | `/api/workspaces/:code` | owner, admin | Delete the workspace and its files |
| GET | `/api/admin/session` | admin | Settings and detected addresses |
| GET, POST | `/api/admin/workspaces` | admin | List all, or create |
| DELETE | `/api/admin/workspaces/:code/files/:id` | admin | Delete one removed file forever |
| DELETE | `/api/admin/workspaces/:code/removed` | admin | Delete all removed files forever |
| PUT | `/api/admin/settings` | admin | `{ lanUrl, publicUrl, workspaceLimitMb }` |

</details>

## Development

```bash
npm test                # run the test suite
npm run test:coverage   # with coverage report
```

```
src/
  index.js        start-up and configuration
  app.js          routing and static files
  routes/         receiver · manage · admin endpoints
  store.js        workspaces and files on disk
  zip.js          streaming ZIP writer
public/           the web pages (no build step)
test/             node:test suites
```

## License

[MIT](LICENSE)

## Credits

* 🇲🇦 Mahmoud Zakaria
* 🌐 [www.mahmoud.ma](https://www.mahmoud.ma)
