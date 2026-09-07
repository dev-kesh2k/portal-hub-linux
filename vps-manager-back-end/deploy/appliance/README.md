# Central Apps Hub — Appliance Linux

Objetivo: **instalar Ubuntu Server no pendrive e ja sair com o portal Hub**; em todo boot o Hub sobe sozinho.

## O que acontece na maquina nova

1. Boot pelo pendrive → Ubuntu Server instala sozinho (autoinstall)
2. Reinicia → **primeiro boot** instala Docker + portal Hub (5–15 min)
3. Boots seguintes → `hub.service` sobe a API automaticamente

| Acesso | Onde |
|--------|------|
| Portal | `http://IP:8081/central-apps-hub/` |
| Login do portal | `/opt/central-apps-hub/FIRST_LOGIN.txt` |
| SSH/console Linux | `hubadmin` / `ChangemeHub2026!` |
| Status | `sudo hubctl status` |

## Preparar a midia (no seu PC)

```bash
# WSL ou Linux, a partir do repo backend:
bash deploy/appliance/autoinstall/prepare-usb-media.sh
# → dist-appliance/usb-media/
```

### Gerar ISO completa (recomendado)

1. Baixe [Ubuntu Server 24.04 ISO](https://ubuntu.com/download/server)
2. No WSL:

```bash
sudo apt-get install -y xorriso
bash deploy/appliance/autoinstall/build-iso.sh /caminho/ubuntu-24.04-live-server-amd64.iso
# → dist-appliance/central-apps-hub-ubuntu-24.04.iso
```

3. Grave a ISO no pendrive com **Rufus (modo DD)** ou Balena Etcher  
4. Boot na maquina nova (UEFI) e espere a instalacao + 1o reboot  

Se o `build-iso.sh` falhar no hybrid UEFI, use [Cubic](https://github.com/PJ-Singh-001/Cubic): copie `usb-media/nocloud` e `usb-media/hub-payload` para a ISO e acrescente no kernel:

`autoinstall ds=nocloud;s=/cdrom/nocloud/`

## So o tarball (sem autoinstall)

Se a maquina ja tem Ubuntu:

```bash
bash deploy/appliance/pack-usb.sh
tar -xzf dist-appliance/central-apps-hub-appliance-*.tar.gz
cd central-apps-hub-appliance-*
sudo bash INSTALAR.sh
```

## Servicos systemd

| Unidade | Funcao |
|---------|--------|
| `hub-bootstrap.service` | Roda **uma vez** no 1o boot e se desliga |
| `hub.service` | Sobe o portal em **todo** boot (`enable` permanente) |

## Layout

```
/opt/central-apps-hub/     # backend + frontend + FIRST_LOGIN.txt
/opt/hub-installer/        # pacote usado no 1o boot (pode apagar depois)
/hub-apps/                 # apps publicados
/etc/systemd/system/hub.service
/usr/local/bin/hubctl
```

## Cloudflare (opcional)

Depois do Hub no ar, edite `/opt/central-apps-hub/backend/.env` (`CF_*`) e `sudo hubctl restart`.
