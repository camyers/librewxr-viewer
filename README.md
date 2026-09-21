# librewxr-viewer

A static radar viewer served by nginx and run as a Dockge stack on Unraid. There is no image to build or publish. The stack uses the stock `nginx:alpine` image and bind-mounts the `html/` folder from this repo, so cloning the repo into Dockge's stacks directory is the whole deployment.

## Repo layout

```
librewxr-viewer/
  compose.yaml   # the Dockge stack definition
  README.md      # this file
  html/          # the viewer files that nginx serves
```

## compose.yaml

```yaml
services:
  viewer:
    image: nginx:alpine
    ports:
      - 8089:80
    volumes:
      - ./html:/usr/share/nginx/html:ro
    restart: unless-stopped
```

The viewer is then available at `http://<unraid-ip>:8089`. The `:ro` mount means nginx cannot write to the folder, so edit files in the repo, not through the container.

## Installing in Dockge

Dockge does not pull from git. It manages plain folders: every subfolder of its stacks directory that contains a `compose.yaml` shows up as a stack. So the install is a clone into that directory.

1. Find the stacks directory. It is `/opt/stacks` by default. If you changed it, check the `DOCKGE_STACKS_DIR` value in the Dockge compose file, and use the path as it exists on the Unraid host.

2. Clone the repo into it:

   ```
   cd /mnt/user/appdata/dockge/stacks
   git clone https://github.com/camyers/librewxr-viewer.git
   ```

   The folder name becomes the stack name in Dockge, so keep it as `librewxr-viewer`.

3. Open Dockge, refresh the stack list if the new stack is not showing, open `librewxr-viewer`, and click Start.

4. Browse to `http://<unraid-ip>:8089` to confirm it loads.

Dockge resolves `./html` on the host, so the stacks path must be the same inside the Dockge container and on the host. This is the "CORRECT vs WRONG" note in Dockge's own compose file. If the viewer starts but nginx shows the default page or a 403, check this first.

## Updating

```
cd /mnt/user/appdata/dockge/stacks/librewxr-viewer
git pull
```

Changes under `html/` are served immediately, since nginx reads the files from disk. No restart is needed. If `compose.yaml` changed, open the stack in Dockge and click Update (or Restart) so the new definition is applied.

## Rebuilding from scratch

If the stack is lost or the server is rebuilt, repeat the install steps above. Nothing else needs to be backed up, since the repo is the source of truth and the container holds no state.

## Optional: friendly hostname

To put this behind Nginx Proxy Manager, add a proxy host pointing at the Unraid IP on port 8089 (websockets are not needed), then add a matching DNS rewrite in AdGuard Home so the hostname resolves to NPM.

## Troubleshooting

- The stack does not appear in Dockge: confirm the folder is directly inside the stacks directory and that the file is named `compose.yaml` (or `compose.yml`, `docker-compose.yaml`, `docker-compose.yml`).
- Port already in use: change the left side of `8089:80` in `compose.yaml`.
- 403 or nginx welcome page: `html/` is missing or empty, or the stacks path mismatch described above applies. Check that `html/index.html` exists on the host.
